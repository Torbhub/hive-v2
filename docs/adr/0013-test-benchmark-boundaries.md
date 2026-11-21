# ADR 13: Tests and benchmarks use explicit external boundaries and deterministic evidence

## Context

Tests must avoid host mutations and hidden cross-test state. Paid smoke tests and benchmark replays need deliberate scope and reproducibility.

## Decision

Model required TTY behavior. Reset Vitest implementations explicitly. Stub only model execution in the watch end-to-end test. Keep paid smoke outside CI. Seed benchmark sampling and filter stream content by the stable hook label. Reserve bench stdout for its machine-readable verdict.

## Consequences

Tests exercise real integration paths without inherited mocks or unintended API spend. Seeded samples and stable hook filters make benchmark reruns comparable. Diagnostics do not corrupt caller-facing output.

## Sources

- `test/live-smoke.mjs:36`, `test/live-smoke.sh:2-3`
- `test/buttons.test.tsx:11`
- `test/watch.test.ts:100`, `test/watch.test.ts:450-451`
- `test/web.test.ts:1029-1030`
- `test/hubapp.test.tsx:30`, `test/hubapp.test.tsx:41`
- `test/watch-e2e.test.ts:7-10`
- `tools/stretch-bench/rewrite.ts:24`, `tools/stretch-bench/rewrite.ts:36-37`
- `tools/stretch-bench/guide.ts:1-2`
- `bench/run.sh:16-17`
