# Kimi Server 2.5.3 disposable spike

## Status

This spike provides disposable preflight tooling. It is not a production adapter.

The revised direct-binary no-generation preflight ran successfully. Every other live capability remains unverified.

The source reference is tag `@moonshot-ai/kimi-code@2.5.3` at commit `5af9942e9fb789b6a1530830575b3768499932e9`.

## Source-verified capabilities

The official [server API reference](https://github.com/MoonshotAI/kimi-code/blob/5af9942e9fb789b6a1530830575b3768499932e9/docs/en/reference/server-api.md) defines these behaviors.

- `kimi web` serves the API on loopback by default.
- `GET /openapi.json` returns the runtime schema. Bearer authentication protects this route.
- JSON envelopes carry the business result in `code`. HTTP success alone does not prove success.
- `POST /api/v1/sessions/{session_id}:fork` accepts a completed `turn_index`.
- A plain fork is not a child session.
- `POST /api/v1/sessions/{session_id}/children` creates a native child. This route has no `turn_index` parameter.
- `GET /api/v1/sessions/{session_id}/children` lists direct children.
- Message pages are newest first. They use `before_id`, `after_id`, and `page_size`.
- Message objects carry `id`, `session_id`, and optional `parent_message_id` fields.

The official source tests confirm that plain forks do not appear in child listings. These findings are reference only. The probe does not call session or message routes.

## Live-observed capabilities

The direct-binary focused run passed both test files and all 15 tests. The disposable test took about 3.5 seconds.

That run verified the installed `2.5.3` version, direct-binary scrubbed startup, internal temporary-home ownership, authenticated bounded OpenAPI retrieval, fixed evidence, and group-wide cleanup, including orphaned descendants.

No session, fork, prompt, compaction, or generation request ran. Every other live capability remains unverified.

The observed command was:

```sh
HIVE_KIMI_SERVER_DISPOSABLE=1 HIVE_KIMI_SERVER_BIN=/usr/local/bin/kimi-real /opt/node22/bin/npm test -- test/kimi-server-spike.test.ts test/kimi-server-disposable.test.ts
```

## Generation-dependent and unverified behavior

Historical forks and nonempty message ancestry remain generation-dependent and unverified.

Child creation, restart reconciliation, and plain-fork lineage remain live-unverified. The probe does not exercise them.

## Disposable boundaries

The runner requires `/usr/local/bin/kimi-real` and explicit opt-in. The TeamKimi wrapper is rejected before any process launch.

The runner creates and owns a private temporary directory. It validates the directory before process launches and before cleanup. It deletes the directory only after process cleanup succeeds.

These checks do not protect against a malicious process with the same user ID. A same-UID process can change files after a check.

The environment contains only `HOME`, `KIMI_CODE_HOME`, and `PATH`. Both home variables point to the owned directory.

On POSIX, version and server processes run in detached process groups. Cleanup signals the group with `SIGTERM`, then escalates to `SIGKILL`. Group-liveness waits have deadlines.

Non-POSIX cleanup terminates only the direct child. Process waits use the `exit` event. They do not wait for inherited stdout to close.

The server binds to `127.0.0.1` on an operating-system-selected port. The bearer token stays in process memory and never enters evidence.

The probe fetches only `/openapi.json`. Redirects are rejected. Response size and request time are bounded.

Evidence is a fixed literal with a loopback origin, schema version, and hash. No generic sanitizer remains. No session, filesystem, prompt, fork, or compaction client remains.
