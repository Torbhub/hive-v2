# ADR 14: Usage accounting uses current attempt identity and wire metadata

## Context

Operators need usage per task attempt. Kimi wire logs contain duplicate turn-end records and payloads that must not leave the session store. Historical sessions cannot be inferred safely.

## Decision

Join independent admissions only to exact current team entries across task, agent, lease, plan digest, epochs, lineage, and attempt. Mark missing matches, incomplete task entries, and every retry as orphans. A retry can reuse its prior session, so its whole-file measurements stay unknown until a per-attempt cursor exists. Never guess a historical session. Require one real session candidate whose bounded state metadata names the exact entry worktree. Reject symlinks and duplicates. Read only the main wire log through a bounded stable snapshot. Deduplicate main top-level turn ends by turn ID. Count only main loop tool calls and main turn-scoped provider usage. Sum all input fields with safe-integer checks. Report missing, changed, oversized, or malformed measurements as unknown. Preserve valid counts around malformed lines. Keep cost unknown without pricing evidence. Return metadata only and never mutate state.

## Consequences

A replacement attempt cannot inherit another session's usage. Duplicate turn ends do not inflate counts. Large logs have bounded memory use. Missing evidence never becomes zero usage or zero cost.

## Sources

- `src/logview.ts`
- `src/death-bundle.ts`
- `src/usage.ts`
- `src/cli.ts`
- `test/logview.test.ts`
- `test/usage.test.ts`
