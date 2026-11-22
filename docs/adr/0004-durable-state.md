# ADR 4: Durable state uses atomic publication and explicit recovery ordering

## Context

Readers can race writes. Crashes can interrupt multi-step commits. Retries can duplicate externally visible actions.

## Decision

Publish JSON by rename. Persist episode keys. Append decisions permanently. Commit terminal question state before archive. Bound retained history. Serialize task id, brief, and ledger creation. Require durable audit before reporting message success.

## Consequences

Readers avoid partial documents. Restarts preserve deduplication and answers. Audit failures cannot reverse committed outcomes.

## Sources

- `src/state.ts:22`, `src/state.ts:38`, `src/state.ts:600`
- `src/watch-persist.ts:5-7`
- `src/hub.ts:78`
- `src/questions.ts:803-805`, `src/questions.ts:815-816`, `src/questions.ts:844-846`
- `src/message.ts:115`
- `tools/hermes-live/broker.ts:318`
