# Hermes T01 live runner

This directory contains disposable T01 tooling. It does not change the Hive production runtime.
The runner makes no live compatibility claim. The `gate:security` and `gate:real-money` gates remain uncleared.
No paid run is authorized by this change.

## Public interface

Use `runT01Matrix(options)` from `tools/hermes-live/runner.ts`.
It returns a `T01Report` containing structured, sanitized evidence.
Its default is preflight-only. A matrix needs `preflightOnly: false` and `paidAuthorization: true`.
The CLI also requires `--paid-admissions-authorized` and `HIVE_T01_AUTHORIZE_PAID_ADMISSIONS=yes`.
These controls do not replace the human gates.

```bash
node dist/tools/hermes-live/cli.js preflight --artifacts /operator/export --controls /operator/hive-controls.json
node dist/tools/hermes-live/cli.js run --artifacts /operator/export --controls /operator/hive-controls.json --paid-admissions-authorized
node dist/tools/hermes-live/cli.js review --manifest /operator/export/manifest.json --reviewer OPERATOR_ID
node dist/tools/hermes-live/cli.js cleanup --root /operator/export --workspace /operator/workspace
```

Runtime configuration comes from these entries:

- `HIVE_T01_SMOKE_CREDENTIAL`: the short-lived TeamKimi smoke credential. Never put it in arguments, files, prompts, or logs.
- `HIVE_T01_BROKER_URL`: the trusted TeamKimi base URL. HTTPS is required except for loopback.
- `HIVE_T01_MODEL`: optional. It must remain `kimi-code/k3.1-pro`.
- `--controls`: a bounded Hive evidence file containing strict isolation, egress, and credential-boundary attestations.
- `--hermes` and `--python`: optional installed executable paths. No installation is performed.

Never supply a Kimi API key. The smoke credential goes only to the Hive adapter.
Hermes receives a loopback adapter URL and the non-secret placeholder `hive-adapter-placeholder`.
The adapter overwrites that placeholder with the real smoke credential only on the direct TeamKimi connection.

## TeamKimi wire contract

The only model endpoint is `POST /v1/messages`.
The adapter sends `x-api-key` and the per-run `x-teamkimi-smoke-scenario` header.
The Anthropic body has this exact policy:

```json
{
  "model": "kimi-code/k3.1-pro",
  "max_tokens": 2000,
  "thinking": { "type": "enabled", "budget_tokens": 4000 },
  "messages": []
}
```

The adapter replaces the incoming model, output budget, and thinking configuration with this exact policy before forwarding.
It removes adaptive-only fields, including `output_config`, and hashes the canonical forwarded bytes plus the admission policy.
It streams successful responses back to Hermes.
TeamKimi calls `POST /v1/messages/count_tokens` once with its broker account before generation.
The reservation must have `inputVerified: true`. Its planned usage uses the counted input and declared output and reasoning budgets.
It returns sanitized provider errors and aborts upstream work when Hermes detaches or the runner cancels.
It never forwards Hermes credentials, authorization headers, or a caller-supplied scenario header.

The only other TeamKimi routes used are:

- `GET /teamkimi/smoke/status` for policy, credential, reservation, and exact usage evidence.
- `POST /teamkimi/smoke/revoke` for revocation proof.

TeamKimi has no Hive readiness, admission, session, or cancellation endpoints.
Hive aggregates its own controls with TeamKimi status before P01.
Hive owns session records, cancellation evidence, activity records, process identity, and reaping.

Status and receipt mapping covers `reasoningTokens` and `costMicros`.
Usage is valid only when every field is a safe nonnegative integer and total tokens equal input, output, and reasoning tokens.
Missing usage fields are invalid. They never become zero.

## Installation and policy preflight

The runner invokes `hermes --version` and `tools/hermes-live/hermes_preflight_probe.py` without a model request.
The probe uses the pinned Hermes `get_tool_definitions()` registry expansion.
It requires version `0.22.6`, commit `f0d94882e89ab8d4098b5bb2f166adfb9ee0a0ab`, a clean checkout, install-stamp `artifactSha256`, and `uv.lock`.

The disposable configuration defines `t01-read`, `t01-local`, and `t01-sleep`.
Their post-expansion tool sets must be exactly:

- P01 and P04: `read_file`.
- P06: `t01:echo` and `t01:sleep`, with exactly `t01_observer` and `t01_pre_tool` hooks.
- P08: `t01:sleep`, with exactly the `t01_observer` hook.
- Every other scenario: no tools or hooks.

Required tools and activities are part of the frozen policy hash.
Additional or missing registry entries, listeners, tools, or activities block admission or make the run unknown.
Delegation, A2A, messaging, external MCP, MCP resources, prompts, events, child sessions, and unapproved hooks must be absent.
The probe validates the actual six-field `runtime.describe` schema.
The complete authoritative `VALID_HOOKS` registry provides hook IDs across every event, including post-tool, transforms, LLM/API, auxiliary, gateway, subagent, approval, room, Kanban, and compaction events.
`query_identify` and `psutil` provide process and socket evidence on the gateway and every recursive child. Native SQLite rows provide child-session evidence.
Missing runtime, hook, process, socket, or child-session evidence blocks admission. Configuration assertions alone do not pass.

P01 writes only the admission sidecar. A read-only SQLite probe supplies the actual schema version, message count, `ended_at`, and child count.
P04 cannot be admitted until that native row is finalized and matches the sidecar admission, route, policy, and generation.
After resume, P04 must match the same row again with nondecreasing history. Missing, open, or conflicting native rows fence resume.

## Lifecycle and abort rules

Each paid invocation uses Hermes Anthropic transport with `hermes chat --query-file PATH --format stream-json`.
P04 adds `--resume SESSION --no-restore-cwd`. P03 requests a usage file.
The runner never uses `--run-budget`.

Terminal mappings are exact:

- `succeeded` requires `completed`, without cancellation.
- `failed` requires `failed`, regardless of cancellation.
- `cancelled` requires `interrupted` and an explicit cancellation request.
- Ambiguity maps to `interrupted` only for `client_detached` with an explicit cancellation request. Every other ambiguity is `conflicting`.

Every terminal receipt needs a receipt ID, expected model, exact usage, actual canonical-body hash, and matching admission policy hash.
Cleanup-pending, cancelling, missing, incomplete, conflicting, or mismatched evidence becomes `unknown` and aborts later admissions.
Only P11 and P12 start concurrently.

An external deadline triggers generation-fenced cancellation.
Signals require the recorded process-group ID and OS start time.
Reaping has a bounded grace period, kills surviving descendants, and requires an empty process group before reconciliation, revocation, or return.

The JSONL protocol has no native heartbeat, keepalive, reasoning, estimated-cost, or API-call event.
Timestamps and output offsets are observations only. Process existence never proves progress.

## Evidence, review, and retention

`exportEvidence()` writes a preflight file, one file per admitted scenario, and a manifest.
Files contain allowlisted event fields, hashes, byte ranges, offsets, exact usage, receipts, route and policy hashes, process evidence, and cancellation evidence.
They contain no raw payloads, unrestricted bytes, reasoning, headers, secrets, native databases, or full sessions.
Session IDs and unexpected model, tool, and activity names are hashed.
All retained and exported collections are capped. Files are mode `0600`, and the artifact directory is mode `0700`.

The manifest starts with `review.status = pending` and registers the workspace path and cleanup deadline.
Approval enumerates the export directory and requires exact manifest membership.
It also validates structure, mode, and every artifact hash before approving export.
Unlisted, raw, or modified files block approval.

The `cleanup` action overwrites and removes export artifacts after seven days.
`cleanupManifest()` discovers the registered workspace and removes its prompts, native sessions, usage files, and raw artifacts before deleting the export root.
`cleanupWorkspace()` unlinks symlinks without touching their targets.
Run `cleanup --manifest /operator/export/manifest.json` from the scheduled operator cleanup job for default or explicit workspaces.

## No-paid cross-repo wire test

`test/hermes-live-wire.test.ts` starts TeamKimi PR #15's real proxy and a synthetic loopback upstream.
Set `TEAMKIMI_SMOKE_SOURCE` to a read-only checkout of TeamKimi commit `efa7efee23b8e209c8f897a3306414bf308aff40`.
The test verifies that commit before starting the proxy and uses `test/fixtures/hermes-smoke-http.json` for count-token and message examples.
The test uses the real Hive adapter and checks canonicalization, request headers, Anthropic policy, count-before-generation order, `inputVerified`, exact usage, provider errors, malformed SSE, missing final usage, detachment, and revocation.
It makes no external or paid request. Without that source path, the wire suite is skipped.

`test/hermes-live-disposable.test.ts` invokes the real pinned Hermes process only when `HIVE_T01_DISPOSABLE_HERMES=1` and `HIVE_T01_HERMES_BIN` identify the reviewed disposable installation.
That test is skipped on the shared box. Live Hermes evidence is unrun until the disposable/CI environment executes it.

Live-only checks still include actual install provenance, runtime listener proof, native persistence, TeamKimi behavior, billed receipts, OS isolation, and credential revocation.
No live checks were run for this change.
