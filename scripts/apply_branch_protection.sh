#!/usr/bin/env bash
# apply_branch_protection.sh — OPERATOR GATE (NOT run autonomously).
#
# Applies the branch-protection spec in docs/governance/BRANCH-PROTECTION.md to
# `main` of Torbhub/hive-v2. DRY-RUN by default: it prints the current state and
# the gh api calls it WOULD make, and changes nothing. Pass --apply to mutate
# settings — that requires a token with repo-admin scope and is a human action.
set -euo pipefail

REPO="Torbhub/hive-v2"
CHECKS=(gate)

APPLY=0
[[ "${1:-}" == "--apply" ]] && APPLY=1

contexts=$(printf '"%s",' "${CHECKS[@]}")
payload=$(cat <<JSON
{
  "required_status_checks": {"strict":true,"contexts":[${contexts%,}]},
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 1,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
)

endpoint="repos/${REPO}/branches/main/protection"

echo "# current state (read-only):"
gh api "$endpoint" 2>/dev/null | jq '{required_status_checks, required_pull_request_reviews, enforce_admins, allow_force_pushes, allow_deletions}' \
  || echo "# main is UNPROTECTED (404)"

if [[ "$APPLY" -eq 1 ]]; then
  echo ">> applying branch protection: ${REPO}@main"
  printf '%s' "$payload" | gh api -X PUT "$endpoint" \
    -H "Accept: application/vnd.github+json" --input - >/dev/null
  gh api -X PATCH "repos/${REPO}" -f allow_auto_merge=true >/dev/null
  echo "   done."
else
  echo
  echo "# DRY RUN — would: gh api -X PUT ${endpoint} --input - <<'PAYLOAD'"
  printf '%s\n' "$payload"
  echo "# DRY RUN — would: gh api -X PATCH repos/${REPO} -f allow_auto_merge=true"
  echo "# (dry run only — no settings changed. Re-run with --apply as a repo-admin to enforce.)"
fi
