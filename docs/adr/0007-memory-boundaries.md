# ADR 7: Memory stays optional, bounded, promotable, and credential aware

## Context

Memory outages cannot block spawns. The upstream API lacks per-memory visibility and requires separate credentials and extraction writes. Live box secrets must survive provisioning.

## Decision

Fail open with time bounds. Separate candidate and team buckets. Cap recall. Copy before delete. Relay privileged credentials without claiming hard isolation. Generate `memory.env` once under a restrictive umask and never overwrite it. Render the gateway config because the stock image starts with skill and knowledge disabled. Use ordered YAML and `sed` escaping. Keep the Docker gateway address stable across network recreation. Pin memory images and pass secrets through root-read environment files. Keep generated memory as the final handoff section.

## Consequences

Outages degrade recall instead of stopping work. Promotion cannot lose the only copy. Provisioning preserves credentials and rendered values. Network or container boundaries remain explicit. Existing installations need deliberate migration when generated templates change.

## Sources

- `src/memory.ts:15-18`, `src/memory.ts:56-57`, `src/memory.ts:76-80`, `src/memory.ts:98-99`, `src/memory.ts:122-124`, `src/memory.ts:158-159`, `src/memory.ts:168`
- `src/spawn.ts:607`
- `infra/box/llm-forward.py:2-5`
- `infra/box/memory-relay.py:2-10`
- `infra/box/hive-memory-core.service:12-14`, `infra/box/hive-memory-core.service:29-30`
- `infra/box/hive-memory-panel.service:4`, `infra/box/hive-memory-panel.service:13-15`, `infra/box/hive-memory-panel.service:39-40`
- `infra/box/tdai-gateway.yaml:1-4`
- `infra/provision-box.sh:109-146`, `infra/provision-box.sh:173-200`, `infra/provision-box.sh:214-221`
