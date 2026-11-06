# Hermes T01 no-model spike

[Citadel #2345](https://github.com/Torbhub/citadel/issues/2345) tracks the full Hermes validation task.

This spike covers only disposable parser and lifecycle fixtures. It makes no live Hermes, model, or paid runtime claim.
The fixtures under `tools/hermes-spike/` are not production adapters.

## Proposed pin

The proposed smoke pin is Hermes Agent `v0.22.6` at commit `f0d94882e89ab8d4098b5bb2f166adfb9ee0a0ab`.
The [release](https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.6) was published on 2026-11-02.
This pin is a release proposal, not an installed-version claim.

## Static facts

Source inspection at the proposed pin found these facts:

- `stream-json` emits JSON objects on stdout. Diagnostics and session ID lines use stderr.
- Native records include `system`, `text`, `tool_use`, `tool_result`, and `result`.
- A `result` contains the session ID, exit code, text, token counts, and duration.
- The emitter writes `result` before it returns the process exit code.
- The protocol has no heartbeat, keepalive, reasoning, estimated-cost, or API-call records.
- JSONL timestamps show the last observed output. They do not prove current progress.
- Ctrl-C can detach the CLI while accepted work continues at the gateway.
- Cancellation needs a terminal gateway receipt. Client detachment is not cancellation.
- Stream-json token totals are not a complete spend ledger.

No installed Hermes runtime appeared in the searched local paths. That search was not a full-filesystem proof.

## Unknowns

Live checks must still establish these facts:

- The installed version, artifact hash, invocation, and locked dependencies.
- Real event, result, stdout EOF, and process exit ordering.
- Native persistence and the authoritative receipt for each outcome.
- TeamKimi streaming, tool calls, model selection, reasoning fields, and billed usage.
- Session resume, unknown sessions, concurrent runs, cancellation, and timeout behavior.
- Runtime disablement of delegation, A2A, native messaging, MCP, and hooks.
- Native activity signals outside JSONL that Hive can use safely.

Process existence must never prove progress. Missing or conflicting terminal evidence must produce `unknown`.

## Draft lifecycle mapping

The fixture tests check this proposed mapping. The mapping is a design draft, not observed Hermes behavior.

| Fixture evidence | Required canonical result |
|---|---|
| Ordered init, text, tool activity, result `0`, EOF, exit `0` | `succeeded`, with final text and usage |
| Failed result, EOF, matching exit `1` | `failed` when effects are resolved |
| Malformed JSON between valid records | Parser error, `unknown`, and retained partial output |
| Truncated JSON at EOF | Parser error and `unknown`, including after exit `0` |
| Truncated multibyte UTF-8 | Retained raw bytes and no replacement text in final output |
| Text and EOF without a result | `unknown` |
| Result `0`, EOF, exit `1` | `unknown` because terminal evidence conflicts |
| Exit `0` without a result | `unknown` |
| Result `0` without EOF or exit | `cleanup-pending` |
| Text after a result | Late non-final text and no extra terminal transition |
| Duplicate identical result | No state change and one terminal transition |
| Conflicting duplicate result | `unknown` and a fenced generation |
| Tool result before tool start | Preserved order with no fabricated tool start |
| Ctrl-C result `130`, EOF, and exit `130` | `cleanup-pending` until a terminal cancellation receipt |
| Deadline and forced stop before a result | `cancelling`, then `unknown` |

Canonical success requires a consistent result, EOF, exit, and effect evidence. A result alone never completes a run.
Late records remain visible in the ordered trace. Conflicts fence finalization and require reconciliation.

## Proposed budget, not authorization

This budget is a proposal only. It does not authorize a paid run.
The only permitted route is TeamKimi with the `Kimi 3.1 Pro` model.

| Ceiling | Each paid invocation | Whole matrix |
|---|---:|---:|
| Input tokens | 16,000 | 96,000 |
| Output tokens | 2,000 | 12,000 |
| Reasoning tokens | 4,000 | 24,000 |
| Total tokens | 22,000 | 132,000 |
| API calls | One admission | 12 |
| Estimated cost | $0.50 | $5.00 |

The matrix has a hard maximum of 12 paid admissions.
Count every accepted, failed, timed-out, detached, or ambiguous request against the admission and spend ceilings.

Reserve budget atomically before each admission. Concurrent runs must use the same reservation ledger.
A failed reservation blocks admission. An unused reservation stays locked until terminal evidence reconciles the invocation.

The TeamKimi proxy or an equivalent trusted server must enforce model, output-token, and spend ceilings.
Client-reported usage is evidence only. It is not an enforcement boundary.
If server-side enforcement or credential scoping cannot be proven, the smoke must not run.

An external deadline must trigger a generation-fenced gateway cancellation and receipt reconciliation.
An unresolved cancellation, timeout, detachment, or ambiguous outcome blocks every later paid admission.

## Exact paid invocation matrix

The capability names in this table are smoke policy names. They are not verified Hermes identifiers.

| ID | Purpose | Allowed capabilities |
|---|---|---|
| P01 | Success and schema | Local file read only |
| P02 | Model and reasoning | None |
| P03 | Usage file | None |
| P04 | Resume | The same frozen local-file-read policy as P01 |
| P05 | Disablement behavior | None |
| P06 | MCP and fail-closed hooks | Local stdio MCP `echo` and bounded `sleep`, plus approved local observer and pre-tool hooks |
| P07 | Provider error | None |
| P08 | Native timeout | Local stdio MCP bounded `sleep` only, plus approved local observer hooks |
| P09 | Ctrl-C detach | None |
| P10 | Explicit cancellation | None |
| P11 | Concurrent run A | None |
| P12 | Concurrent run B | None |

Unknown-session checks and parser fixtures are no-spend. They have no paid invocation IDs.

## Credential and process boundary

Never request a Kimi API key. Use only a smoke-only, short-lived TeamKimi credential scoped to the approved model and budget.
Revoke the credential after the matrix or an abort. Record proof of revocation without recording the credential.

A trusted broker must keep the real credential outside model, tool, MCP, and hook contexts.
A separate broker UID with a sanitized child environment also satisfies this boundary.
If this boundary cannot be proven, the smoke must not receive a real credential.

Start the disposable process with an empty environment. Add only these non-secret entries:

- `HOME`
- `PATH`
- `HERMES_HOME`
- `TEAMKIMI_OPENAI_COMPATIBLE_URL`
- `TEAMKIMI_MODEL_ID`

Remove all ambient AWS, provider, proxy, and SSH-agent credentials.
This removal includes credential files, environment entries, agent sockets, and inherited configuration.

Mount fixtures read-only. Confine file access with OS controls to the disposable working directories.
Hermes file-write guards cover only `write_file` and `patch`. Terminal commands can overwrite denied paths.
These guards are not a sandbox. OS isolation, credential confinement, and egress denial remain necessary.

## Network and container confinement

Enforce default-deny egress outside Hermes for IPv4, IPv6, DNS, and redirects.
Allow only the approved TeamKimi destination and loopback inside the disposable network namespace.
Deny every redirect and every other destination. Deny instance-metadata and container credential endpoints.

Forbid privileged mode, host networking, the host PID namespace, container sockets, host credential mounts, and writable host paths.
Disable model discovery, fallback providers, outbound webhooks, and on-demand installs.

Before any paid admission, run negative checks for these destinations:

- A direct IP address
- An unapproved DNS name
- A redirect
- An IPv6 destination
- An alternate port
- Instance metadata

Run one positive connectivity check for the approved TeamKimi destination without submitting a model request.
Any failed negative check or failed positive check blocks the paid matrix.

## Sanitized evidence boundary

Persist only allowlisted, sanitized, structured evidence. Do not persist unrestricted raw payloads.
Keep parser input bytes only in bounded ephemeral memory. Do not export raw byte streams.

| Evidence source | Allowed persisted evidence |
|---|---|
| Stdout and stderr | Sequence, event type, timestamp, allowlisted fields, parser errors, sanitized byte ranges, hashes, and offset mappings |
| Session database | Session and admission identifiers, schema version, row counts, state, timestamps, route hash, and frozen-policy hash |
| Usage and provider receipts | Model, status, token fields, call counts, estimated cost, receipt identifiers, and request hashes |
| MCP and hooks | Approved identifiers, sequence, duration, status, sanitized error category, and bounded result metadata |
| Crash and process records | Exit code, signal, process identity, cancellation receipt, and sanitized error category |
| Ordered traces | Observation sequence, lifecycle state, evidence hashes, and sanitized offset mappings |

Native databases and receipts stay inside the disposable environment. Export only the allowlisted fields.
Disable request debugging, authentication debugging, and core dumps.

Redact secrets, encoded secrets, authorization headers, URL credentials, sensitive query text, and reasoning content.
Preserve only sanitized byte ranges, hashes, and offset mappings needed to interpret parser evidence.

Set artifact files to mode `0600`. Restrict artifact access to the smoke operator.
Review every export before it leaves the disposable environment. Destroy all artifacts securely after seven days.

## Capability policy

Exact native tool identifiers are not verified from the pinned source.
Before paid submission, verify every identifier from the post-expansion tool registry and record its policy mapping.
If any exact identifier or expanded membership remains unknown, the smoke stays blocked.

Deny these capabilities in every scenario unless the matrix explicitly allows one:

- Terminal and shell tools
- Delegation and child sessions
- A2A and native messaging
- Connection management and external delivery
- Network tools and plugins
- Unapproved hooks
- File writes and file reads outside the P01 and P04 fixture

Allow MCP only in P06 and P08 through the dedicated local stdio fixture.
P06 allows `echo` and bounded `sleep`. P08 allows only bounded `sleep`.
Disable MCP resources, prompts, events, and every external MCP transport.

Before admission, capture the sanitized post-expansion registry and listener state.
During reconciliation, verify the frozen registry, disabled listeners, absent child sessions, and denied network attempts.
P04 must retain the P01 model, route, workspace, and frozen capability policy. Reject every creation-flag change.
The P05 delegation prompt is supplemental behavior evidence only. Registry and listener evidence remains mandatory.

## Paid work remains unauthorized

Both human gates remain **UNCLEARED**: `gate:security` and `gate:real-money`.
No paid run is authorized. Every control above is a precondition, not evidence of a completed live check.

The gated smoke must use a fresh disposable environment outside the shared production worker and Nexus box.
No issue readiness or live compatibility claim follows from these no-model fixtures.
