# no-silent-red runbook

The tripwire (`.github/workflows/no-silent-red.yml`) watches the `deploy`
workflow on main. Policy: any failure is immediately fixed, never ignored.

## What fires it

| Signal | Action |
|---|---|
| `gate` job red on main, failed SHA == main tip | Auto-revert the tip. Branch `auto-revert/<sha>`. PR with auto-merge. Alarm issue opened or updated. Comment on the offending PR. |
| `deploy` leg red, `gate` green | Alarm-only. The content passed the gate. This is infra. Investigate the run, fix, re-dispatch if needed. |
| Red SHA no longer main tip | No-op. The tip's own checks govern. |
| Tip is itself a revert | Alarm-only (loop guard). A human resolves. |
| Revert conflicts | No PR. The alarm says `conflict`. A human reverts by hand. |

## Setup (one time, operator)

The tripwire needs three things the workflow cannot give itself.

1. A GitHub App scoped to this repo with `contents: write`,
   `pull-requests: write`, `issues: write`. Note the App ID. Mint a private
   key. PRs from the default `GITHUB_TOKEN` never trigger the PR gate, which
   would strand the revert under the required `gate` check.
2. Two repo entries: variable `HIVE_CI_APP_ID`, secret
   `HIVE_CI_APP_PRIVATE_KEY`.
3. Repo setting "Allow auto-merge" on. It is off today. Without it the revert
   PR opens but waits for a human merge, and the workflow warns.

## Probe (manual)

Actions → no-silent-red → Run workflow. A green probe means the App token
mints and reads the repo. Run this after the setup above and after any key
rotation. A dead credential fails the workflow loudly and pages via GitHub's
failure email.

## When it pages you

1. Open the rolling `no-silent-red` issue. It names the run, the SHA, and the
   outcome.
2. `revert-pr-open`: nothing to do unless the revert PR goes red. Then the
   original break is not revert-clean. Investigate the revert PR.
3. `deploy-failed`: the tree is fine. Look at the deploy leg (SSM command,
   mutex, stack update). Fix and re-dispatch.
4. `conflict` / `loop-guarded`: revert by hand (`git revert -m 1 <sha>`), push
   the PR, merge when green.
5. Close the issue only when main is green again. The tripwire comments on the
   open issue instead of spawning duplicates.

## Limits

- The tripwire restores the last green tree. It does not diagnose. A red
  revert PR or a `conflict` outcome always means a human looks next.
- The gate-vs-infra split reads the job named `gate` in `deploy.yml`. If that
  job is renamed, every failure reads as infra and alarms only. That fails
  safe.
- A merge that touches no deploy trigger path runs no `deploy` workflow on
  main. The tripwire never sees it.
- `cancel-in-progress: false` per SHA. A rerun of the same failed run queues
  rather than double-acts.
