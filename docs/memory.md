# Agent Memory on the hive box

The box runs TencentDB Agent Memory. It gives lanes a shared long-term
memory: facts, decisions, and SOPs from past sessions, searchable before a
new lane spawns.

## What runs

Two docker containers, both loopback-only, both owned by systemd.

- `hive-memory-core` — the gateway. Memory read, write, and search.
  Listens on `127.0.0.1:8420`. Data lives in the docker volume
  `tdai-memory-core-data` (sqlite).
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

The LLM lines ship empty. Memory extraction and wiki ingest idle until a
human fills `MEMORY_LLM_*` and the matching `LLM_*` lines, then runs:

```
systemctl restart hive-memory-core hive-memory-panel
```

Provision renders `/etc/hive-v2/tdai-gateway.yaml` from `memory.env` on
every deploy. The core container mounts it read-only. Do not hand-edit the
rendered file. Edit `memory.env` and rerun provision through a deploy.

Hive itself reads three env vars, set in the shell that runs `hive`:

- `HIVE_MEMORY_KEY` — the user key (`sk-mem-...`). Without it memory is
  off and every call is a no-op.
- `HIVE_MEMORY_URL` — the gateway base URL. Default
  `http://127.0.0.1:8420`, the loopback on this box.
- `HIVE_MEMORY_SERVICE_ID` — the service id header. Default `default`.

## The write gate

Lanes never write shared memory directly. `hive memory propose <project>
<text>` writes a candidate into a private bucket (`agent_id` `candidates`
under `team_id` `hive-<project>`) with the provenance in the background
field: project, agent (env `HIVE_AGENT`), session (env `HIVE_SESSION`).

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
