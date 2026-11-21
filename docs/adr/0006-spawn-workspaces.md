# ADR 6: Spawn and workspace setup isolate Hive from external tool drift

## Context

Runtime layouts, model defaults, session locking, repository formats, and jj or Git failure behavior vary outside Hive's control.

## Decision

Validate before side effects. Pin fresh-session defaults. Carry explicit identity, mode, model, and lineage. Attribute sessions by pickup prompt. Handle workspace fallbacks and partial failures explicitly. Trash jj workspace directories before forgetting their registration.

## Consequences

Launches stay reproducible and resumable. Nested lineage remains correct. Failed setup does not orphan worktrees or attach the wrong session.

## Sources

- `src/spawn.ts:34`, `src/spawn.ts:153`, `src/spawn.ts:158-161`, `src/spawn.ts:166-167`, `src/spawn.ts:174-175`, `src/spawn.ts:192`, `src/spawn.ts:213-215`, `src/spawn.ts:345`, `src/spawn.ts:499`, `src/spawn.ts:508`, `src/spawn.ts:516-518`, `src/spawn.ts:567`, `src/spawn.ts:569`, `src/spawn.ts:578`
- `test/spawn.test.ts:438`
