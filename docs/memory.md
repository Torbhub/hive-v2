# Agent Memory on the hive box

The box runs TencentDB Agent Memory. It gives lanes a shared long-term
memory: facts, decisions, and SOPs from past sessions, searchable before a
new lane spawns.

## What runs

Two docker containers, both loopback-only, both owned by systemd.

- `hive-memory-core` — the gateway. Memory read, write, and search.
  Listens on `127.0.0.1:8420`. Data lives in the docker volume
  `tdai-memory-core-data` (sqlite).
- `hive-memory-relay` — a loopback auth relay on `127.0.0.1:8421`. The
  core data plane wants the instance Bearer key plus a scoped user key.
  Lanes hold only the user key, so they call the relay; the relay swaps
  in the instance key from `memory.env` and forwards. Hive points here
  via `HIVE_MEMORY_URL=http://127.0.0.1:8421`.
- `hive-memory-llm-forward` — a loopback forwarder on
  `172.18.0.1:3466` so the containers can reach the teamkimi proxy
  (host loopback) for LLM extraction.
- `hive-memory-panel` — the admin panel plus the knowledge service.
  Panel on `127.0.0.1:8125`, knowledge API on `127.0.0.1:8424`. The panel
  page calls the knowledge API from the browser, so both ports publish.
  Data lives in the volume `tdai-panel-data`.

The images are `agentmemory/memory-core` and `agentmemory/memory-hub` from
Docker Hub, pinned to tag `1.0.3-beta.1` in the unit files under
`infra/box/`. The pin is deliberate. Never run `latest`.

To reach the panel, forward the port over SSH and open
`http://127.0.0.1:8125/`.

## Config and secrets

`/etc/hive-v2/memory.env` holds the config. Provision generates it once
with random keys and never overwrites it. It stays root-owned 0600. The
units read it through systemd `EnvironmentFile` and pass values into the
containers one by one.

The LLM lines point at the teamkimi proxy on this box. Containers cannot
reach teamkimi directly: it binds host loopback, and the memory containers
live on the `tdai-memory-stack` docker network. A small forwarder
(`llm-forward.py`, unit `hive-memory-llm-forward`) listens on the network
gateway `172.18.0.1:3466` and relays to `127.0.0.1:3466`. The subnet is
pinned in provision so the gateway address is stable. So:

- `MEMORY_LLM_BASE_URL=http://172.18.0.1:3466/v1` (and `LLM_BASE_URL` the
  same, mirrored for the panel)
- `MEMORY_LLM_API_KEY` / `LLM_API_KEY` — the teamkimi `proxy.apiKey`
- `MEMORY_LLM_MODEL` / `LLM_MODEL` — `kimi-k2`

After a change: `systemctl restart hive-memory-core hive-memory-panel`.

Provision renders `/etc/hive-v2/tdai-gateway.yaml` from `memory.env` on
every deploy. The core container mounts it read-only. Do not hand-edit the
rendered file. Edit `memory.env` and rerun provision through a deploy.

## Keys

Three keys, three scopes:

- `TDAI_GATEWAY_API_KEY` — the gateway Bearer key. Root-only, admin of the
  data plane. Never handed to a lane.
- `TDAI_MEMORY_SYSTEM_USER_ID` + `TDAI_MEMORY_SYSTEM_USER_KEY` — bootstrap
  for the v3 meta API. The core creates this system-admin user on startup.
  Used once, to mint the hive user key.
- `HIVE_MEMORY_KEY` — the hive user key (`sk-mem-...`). Scoped to the hive
  user. This is the one lanes see. Mint it once:

```
GW=$(grep '^TDAI_GATEWAY_API_KEY=' /etc/hive-v2/memory.env | cut -d= -f2)
SYS=$(grep '^TDAI_MEMORY_SYSTEM_USER_KEY=' /etc/hive-v2/memory.env | cut -d= -f2)
curl -X POST -H "Authorization: Bearer $GW" -H "x-tdai-service-id: default" \
  -H "x-tdai-user-key: $SYS" -H "Content-Type: application/json" \
  -d '{"username":"hive"}' http://127.0.0.1:8420/v3/meta/user/create
```

The response carries the user key. Put it in `/etc/hive-v2/web.env` as
`HIVE_MEMORY_KEY` and restart `hive-v2-web`.

On an install that predates the system-user lines: provision never
overwrites `memory.env`, so add `TDAI_MEMORY_SYSTEM_USER_ID` and
`TDAI_MEMORY_SYSTEM_USER_KEY` (any random values) by hand, then restart
`hive-memory-core` before minting.

Hive itself reads three env vars, set in the shell that runs `hive`:

- `HIVE_MEMORY_KEY` — the hive user key (`sk-mem-...`), scoped to the hive
  user. Without it memory is off and every call is a no-op.
- `HIVE_MEMORY_URL` — the relay base URL. The code default is the relay
  (`http://127.0.0.1:8421`), which is right on this box.
- `HIVE_MEMORY_SERVICE_ID` — the service id header. Default `default`.

## The write gate

Lanes never write shared memory directly. `hive memory propose <project>
<text>` writes a candidate into a private bucket (`agent_id` `candidates`
under `team_id` `hive-<project>`). The data plane creates atomic notes
only through the extraction pipeline, so a candidate is a conversation
entry; the pipeline distills it in place. Provenance rides as a trailing
line on the text: project, agent (env `HIVE_AGENT`), session (env
`HIVE_SESSION`).

`hive memory ls <project>` lists the candidates. The owner reviews them
and runs `hive memory promote <project> <id>`. Promote copies the
candidate into the team bucket (`agent_id` `team`) and deletes the
candidate.

Known gap: the v3 data plane has no per-memory visibility field, so
promote is copy across buckets, not one upstream visibility flip. A
promote that dies between the copy and the delete leaves the text in both
buckets. That is safe, and the next promote of the same id cleans it up.

## Recall flow

When hive spawns an agent on a task, it searches the team bucket with the
task brief as the query. Found memories land in a `## Memory` block at the
end of the agent's handoff (`.hive/handoffs/<agent>.md`), capped at 2000
chars. This covers worker spawns and orchestrator starts. The block is
rewritten on each spawn, so it stays current.

Recall searches distilled memory, so a promoted entry becomes recallable
only after the extraction pipeline distills it (pipeline intervals, not
instant). Candidates are never recalled: the pipeline distills them into
their own bucket, which recall does not search.

Recall never blocks a spawn. Every memory call has a 3s timeout and fails
open: memory down, slow, or unconfigured means no block, and the spawn
goes ahead without it.

## Upgrade

1. Pick the new tag on Docker Hub (`agentmemory/memory-core` and
   `agentmemory/memory-hub`).
2. Bump the pinned tag in `infra/box/hive-memory-core.service` and
   `infra/box/hive-memory-panel.service`.
3. Push. The deploy workflow pulls the new images and restarts the units.

Data survives upgrades. It lives in the named volumes, not the containers.
