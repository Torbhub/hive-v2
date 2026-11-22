# ADR 11: Repository gates use tracked hooks and conservative evidence

## Context

jj push semantics differ from Git hooks. Local check scripts cannot resolve every alias or prove success from exit codes alone.

## Decision

Install tracked hooks through the jj wrapper. Resolve shared Git directories explicitly. Run the working-tree gate without synthetic stdin SHAs. Reject unresolved append aliases. Require non-vacuous per-step evidence. Refuse tracked gate logs. Count only human-authored merge differences. Keep line counts compatible with `wc -l`. Remove known bytecode artifacts after the gate. Keep memory command handling outside the ratcheted dispatcher. Exclude the evaluator's own repository-read lock from scope evidence.

## Consequences

Every clone has one supported gated path. Interrupted or empty checks cannot produce GREEN. Repository-layout differences cannot bypass the gate.

## Sources

- `scripts/jj-push-gate.sh:2-11`, `scripts/jj-push-gate.sh:14-15`, `scripts/jj-push-gate.sh:31-32`, `scripts/jj-push-gate.sh:34`
- `scripts/install-git-hooks.sh:2-15`, `scripts/install-git-hooks.sh:19-21`
- `scripts/git-hooks/pre-push:2-9`, `scripts/git-hooks/pre-push:19`
- `scripts/discipline-gate.mjs:75`, `scripts/discipline-gate.mjs:213`
- `src/gate.ts:37`, `src/gate.ts:71`, `src/gate.ts:114-115`, `src/gate.ts:237`
- `src/memory-cli.ts:1-2`
- `src/scope.ts:320`
