#!/usr/bin/env bash
# jj-push-gate.sh — pre-push gate for the jj path. `jj git push` fires NO git
# hooks (upstream: jj-vcs/jj discussion #403), so the repo's pre-push hook is
# wired here instead: scripts/install-git-hooks.sh installs this script next
# to the hooks plus a repo-local jj alias, so that `jj push` runs the
# installed pre-push hook and only then delegates to `jj git push`.
#
# Use:  jj push --bookmark <name>     (gated — the only supported jj push path)
# Never: jj git push ...              (bypasses every gate; do not)
# Escape hatch: PRESUBMIT=off jj push ... — prints a loud warning. Declare the
# escape in your lane pulse.
set -euo pipefail

# A jj workspace has no .git — resolve the root and the shared git dir
# through jj first, git second.
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

# The hook checks the working tree, which in a jj clone IS the pushed change
# (@) — no stdin sha resolution needed.
"$hook" </dev/null
echo "jj-push-gate: pre-push hook green — delegating: jj git push $*" >&2
exec jj git push "$@"
