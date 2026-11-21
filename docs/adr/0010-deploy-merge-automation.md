# ADR 10: Deploy and merge automation preserves supply-chain and recovery boundaries

## Context

Automated merges and reverts can change their own control plane. GitHub token actions suppress normal follow-on workflow events. AWS operations outside stack deploys need fleet-wide serialization. GitHub OIDC subjects and branch protection are external security contracts.

## Decision

Keep human control over control-plane changes. Run no repository code during merge classification. Revert only content failures. Make recovery idempotent and nonrecursive. Preserve newest-wins without losing the last deploy. Exempt CloudFormation stack updates from the mutex, then serialize later box and SSM work through `citadel-deploy-mutex`. Retry only lock contention. Bound acquisition and expiry. Restrict renewal and release by owner. Never delete a row by hand to unstick it. Use immutable OIDC subjects. Require explicit operator action for branch-protection mutation.

## Consequences

Pull requests cannot authorize their own policy changes. Recovery cannot loop or silently skip required gates. Crashed mutex holders recover after expiry without hiding AWS defects. Renames do not invalidate OIDC trust. The cross-stack mutex dependency requires coordinated changes.

## Sources

- `.github/workflows/no-silent-red.yml:2-11`, `.github/workflows/no-silent-red.yml:17`, `.github/workflows/no-silent-red.yml:57-58`, `.github/workflows/no-silent-red.yml:65`, `.github/workflows/no-silent-red.yml:72-73`, `.github/workflows/no-silent-red.yml:99-101`, `.github/workflows/no-silent-red.yml:118-119`, `.github/workflows/no-silent-red.yml:121`
- `.github/workflows/deploy.yml:18-21`, `.github/workflows/deploy.yml:64-65`, `.github/workflows/deploy.yml:81-85`, `.github/workflows/deploy.yml:96-99`, `.github/workflows/deploy.yml:114-115`, `.github/workflows/deploy.yml:120`, `.github/workflows/deploy.yml:180`
- `.github/workflows/auto-merge.yml:4-29`, `.github/workflows/auto-merge.yml:51`, `.github/workflows/auto-merge.yml:116`
- `infra/template.yaml:21-23`, `infra/template.yaml:159-160`
- `infra/deploy-mutex.sh:2-19`, `infra/deploy-mutex.sh:41-103`
- `scripts/apply_branch_protection.sh:2-7`
- `test/deploy_workflow_checks.py:83-84`
