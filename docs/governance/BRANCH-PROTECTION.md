# Branch protection — READY-TO-APPLY spec (OPERATOR GATE)

> **This is a human/admin action. It is NOT applied autonomously.** Changing
> GitHub branch protection is a repo-admin SETTINGS action. An operator runs
> the steps below when ready. Until then, merges rely on lane discipline plus
> the green `gate` check.

## What gets applied (repo: `Torbhub/hive-v2`, branch `main`)

1. **Required status check** on `main` (strict / up-to-date-before-merge):
   `gate` — the gate job in `.github/workflows/deploy.yml` (npm test, build,
   infra script syntax, cfn-lint). A PR cannot merge without it green.
2. **Required review:** at least 1 approving review. Stale reviews dismiss on
   new pushes. This is the deslop review from `AGENTS.md`, enforced.
3. **No direct pushes to `main`:** `enforce_admins` on. The only merge path
   is a reviewed PR. No force pushes, no branch deletion.
4. **Auto-merge** enabled at the repo level (`allow_auto_merge`). The tiered
   policy in `.github/workflows/auto-merge.yml` decides which PRs may use it.

## How to apply

```bash
# DRY RUN (default) — prints the current state and the gh api calls it WOULD
# make, changes nothing:
scripts/apply_branch_protection.sh

# APPLY — operator/admin only, requires a token with repo-admin scope:
scripts/apply_branch_protection.sh --apply
```
