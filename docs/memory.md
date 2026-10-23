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

## The write gate

Lanes never write memory directly. Write candidates land in a private
scope. A human reviews them in the panel and promotes the good ones to the
team scope. This keeps agent noise out of shared memory.

## Recall flow

Planned, not yet built: the hub searches memory before it writes a spawn
brief, and found memories go into the brief, so a new lane starts with
what earlier lanes learned. This section lands with the recall lane.

## Upgrade

1. Pick the new tag on Docker Hub (`agentmemory/memory-core` and
   `agentmemory/memory-hub`).
2. Bump the pinned tag in `infra/box/hive-memory-core.service` and
   `infra/box/hive-memory-panel.service`.
3. Push. The deploy workflow pulls the new images and restarts the units.

Data survives upgrades. It lives in the named volumes, not the containers.
