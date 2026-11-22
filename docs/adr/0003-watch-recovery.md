# ADR 3: Recover wedges and deaths with bounded retries and preserved evidence

## Context

Still screens can hide active work. Wake attempts can race registration. Diagnostic probes can fail on an unhealthy host.

## Decision

Require corroborating wedge evidence. Capture diagnostics before restart. Retry with bounds and verify the registered identity after wake. Isolate probe failures. Exclude wire payloads. Stub every host tmux, process, dmesg, memory, and systemctl probe in death-diagnostic tests.

## Consequences

Active agents avoid false restarts. Real failures retain timing and stack evidence. Partial diagnostics and later recovery remain available. Death-diagnostic tests are hermetic and cannot inspect or mutate the host through a missed probe.

## Sources

- `src/watch.ts:366-370`, `src/watch.ts:400-401`, `src/watch.ts:430-432`, `src/watch.ts:469`, `src/watch.ts:513-515`, `src/watch.ts:543`
- `src/death-bundle.ts:9`, `src/death-bundle.ts:24`, `src/death-bundle.ts:91`, `src/death-bundle.ts:128`
- `src/doctor.ts:23`, `src/doctor.ts:100-101`, `src/doctor.ts:126`
- `infra/box/hive-v2-dmesg.sudoers:1-2`, `infra/box/hive-v2-pstack.sudoers:1`
- `tools/hermes-live/count-probe.mjs:32`, `tools/hermes-live/runner.ts:473`
- `test/doctor.test.ts:98`, `test/watch.test.ts:108-109`
