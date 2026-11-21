# ADR 5: Task transitions require current plans and explicit owner authorization

## Context

Old approvals and legacy ledgers must not authorize new work. Owners also need recovery paths when panes or dialogs disappear.

## Decision

Bind acceptance to the latest failure. Clear plan-derived state on rebrief. Route verdicts through guarded transitions. Use ledger-only recovery paths. Turn invalid plan approval into rework. Settle pending starts by age and pane liveness. Keep brief frontmatter at the top of the file.

## Consequences

New work needs fresh approval. Invalid plans return for rework. Legacy records remain readable. Dead panes cannot block owner decisions.

## Sources

- `src/state.ts:270`, `src/state.ts:325-327`
- `src/hub.ts:82`, `src/hub.ts:437-438`
- `src/taskgate.ts:28-29`, `src/taskgate.ts:107`, `src/taskgate.ts:161-162`, `src/taskgate.ts:656`, `src/taskgate.ts:659-660`
- `web/taskactions.ts:8`, `web/taskactions.ts:11-12`, `web/taskactions.ts:30-31`
- `test/hub.test.ts:485`
