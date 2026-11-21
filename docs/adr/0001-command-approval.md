# ADR 1: Command approval fails closed and respects compute limits

## Context

Automatic approval can start expensive or unsafe work. Model output and concurrent cycles can also duplicate decisions or reuse a negative result for too long.

## Decision

Require a human for heavy compute. Accept only classifier output that starts with `APPROVE`. Cache positive verdicts by normalized command. Reconsider ASK and timeout outcomes.

## Consequences

Ambiguous and expensive commands reach a human. Repeated safe approvals stay cheap. Negative outcomes remain reviewable.

## Sources

- `src/watch.ts:40`, `src/watch.ts:115`, `src/watch.ts:130-131`
