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

## Credential boundary

TeamKimi is the only permitted model path. Never request a Kimi API key.

The operator must provision the disposable `HERMES_HOME/.env` with mode `0600`.
Secrets must stay out of argv, command traces, reports, fixture logs, full environment dumps, and resolved config dumps.

The disposable environment must exclude AWS credentials, host credential mounts, production mounts, and metadata-service access.
Network policy must allow only the approved TeamKimi endpoint and loopback fixtures.
Model discovery, fallback providers, native delegation, external messaging, outbound webhooks, and on-demand installs must stay disabled.

Hermes file-write guards cover only `write_file` and `patch`. Terminal commands can overwrite denied paths.
These guards are not a sandbox. OS or container isolation, credential confinement, and egress denial remain necessary.

## Deferred paid work

The paid TeamKimi matrix remains deferred. The human gates `gate:security` and `gate:real-money` remain open.

The gated smoke must use a fresh disposable environment outside the shared production worker and Nexus box.
It must record raw bytes, ordered observations, native receipts, persistence, and sanitized usage for each run.
No issue readiness or live compatibility claim follows from these no-model fixtures.
