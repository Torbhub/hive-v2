# no-silent-red runbook

The tripwire (`.github/workflows/no-silent-red.yml`) watches the `deploy`
workflow on main. Policy: any failure is immediately fixed, never ignored.

## How it works

The tripwire runs on the workflow's `GITHUB_TOKEN` with explicit permissions.
No GitHub App, no extra secrets, no setup. That token's acts (branch push, PR
create, merge) fire no other workflows, so the tripwire does the loop by hand.

1. Revert the red tip on branch `auto-revert/<sha>`. Open the PR.
2. Dispatch `deploy` on the branch. The deploy leg is main-only on dispatch,
   so only the `gate` job runs.
3. Poll the `gate` check on the revert head. Ten minutes max.
4. Green: squash-merge the PR, then dispatch `deploy` on main so the revert
   ships. Not green: stop and alarm.

## What fires it

| Signal | Action |
|---|---|
| `gate` job red on main, failed SHA == main tip | Revert PR opened, gated on the branch, squash-merged, deploy dispatched. Alarm issue opened or updated. Comment on the offending PR. |
| `deploy` leg red, `gate` green | Alarm-only. The content passed the gate. This is infra. Investigate the run, fix, re-dispatch if needed. |
| Revert gate red or slow | No merge. The alarm says `revert-gate-red`. The PR stays open. A human resolves. |
| Red SHA no longer main tip | No-op. The tip's own checks govern. |
| A revert PR for the same SHA already exists (open, or closed unmerged) | No-op. Dedupe. |
| Tip is itself a revert | Alarm-only (loop guard). A human resolves. |
| Revert conflicts | No PR. The alarm says `conflict`. A human reverts by hand. |

## When it pages you

1. Open the rolling `no-silent-red` issue. It names the run, the SHA, and the
   outcome.
2. `revert-merged`: nothing to do. Watch the dispatched deploy go green.
3. `revert-gate-red`: the original break is not revert-clean. Investigate the
   revert PR.
4. `deploy-failed`: the tree is fine. Look at the deploy leg (SSM command,
   mutex, stack update). Fix and re-dispatch.
5. `conflict` / `loop-guarded`: revert by hand (`git revert -m 1 <sha>`), push
   the PR, merge when green.
6. Close the issue only when main is green again. The tripwire comments on the
   open issue instead of spawning duplicates.

## Limits

- The tripwire restores the last green tree. It does not diagnose. A
  `revert-gate-red` or `conflict` outcome always means a human looks next.
- The gate-vs-infra split reads the job named `gate` in `deploy.yml`. If that
  job is renamed, every failure reads as infra and alarms only. That fails
  safe.
- The squash merge by `GITHUB_TOKEN` fires no push run. The tripwire
  dispatches `deploy` on main itself. If that dispatch is lost, main is green
  but not deployed — re-dispatch `deploy` on main by hand.
- A merge that touches no deploy trigger path runs no `deploy` workflow on
  main. The tripwire never sees it.
- `cancel-in-progress: false` per SHA. A rerun of the same failed run queues
  rather than double-acts.
