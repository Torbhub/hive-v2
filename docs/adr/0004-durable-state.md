# ADR 4: Durable state uses atomic publication and explicit recovery ordering

## Context

Readers can race writes. Crashes can interrupt multi-step commits. Retries can duplicate externally visible actions.

## Decision

Publish JSON by rename. Persist episode keys. Append decisions permanently. Commit terminal question state before archive. Bound retained history. Serialize task id, brief, and ledger creation. Require durable audit before reporting message success. Record peer-message pending metadata before typing and keep message text out of delivery records. Fold repeated message IDs on read, keep 64 logical message records, and recover only pending records older than 10 minutes as unknown without writes.

Read JSONL with one policy. Only an absent file returns an empty log. Ignore a malformed final record only when the file does not end in a newline. Throw an error with the file path and line number for every other malformed record. Preserve blank lines and valid record order. Propagate read errors other than ENOENT. Daydream applies the same parser after its bounded-file read.

## Consequences

Readers avoid partial documents. Restarts preserve deduplication and answers. Audit failures cannot reverse committed outcomes. Malformed durable state stays visible. A crash during the final append does not hide earlier records.

## Sources

- `src/jsonl.ts`
- `src/state.ts`
- `src/daydream.ts`
- `src/watch-persist.ts`
- `src/hub.ts:78`
- `src/questions.ts:803-805`, `src/questions.ts:815-816`, `src/questions.ts:844-846`
- `src/message.ts`
- `tools/hermes-live/broker.ts:318`
