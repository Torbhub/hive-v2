#!/usr/bin/env bash
set -euo pipefail

if [ -n "${JJ_WORKSPACE_ROOT:-}" ]; then
  root="$JJ_WORKSPACE_ROOT"
else
  root="$(jj root 2>/dev/null || git rev-parse --show-toplevel)" || {
    echo "jj-push-gate: cannot resolve the repo root" >&2; exit 1; }
fi
cd "$root"
hook="$(jj git root 2>/dev/null || git rev-parse --git-dir)/hooks/pre-push"

if [ ! -x "$hook" ]; then
  echo "jj-push-gate: REFUSING push — no executable pre-push hook at $hook" >&2
  echo "  Install it once per clone: bash scripts/install-git-hooks.sh" >&2
  exit 1
fi

"$hook" </dev/null
rm -f infra/t01-smoke/__pycache__/health_credential.cpython-312.pyc \
  infra/t01-smoke/__pycache__/runtime.cpython-312.pyc \
  infra/t01-smoke/__pycache__/teamkimi_attestation.cpython-312.pyc \
  test/__pycache__/t01_workflow_harness.cpython-312.pyc
echo "jj-push-gate: pre-push hook green — delegating: jj git push $*" >&2
exec jj git push "$@"
