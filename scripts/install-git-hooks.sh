#!/usr/bin/env bash
# install-git-hooks.sh — (re)install hive-v2's tracked hooks into this clone.
#
# Git hooks live under .git/ and are NOT version-controlled, so a fresh clone
# has no gate at all until this runs once:
#
#     bash scripts/install-git-hooks.sh
#
# The hook bodies are tracked in scripts/git-hooks/. Idempotent: re-running
# replaces a hook this script installed. A foreign hook (different bytes, no
# hive-v2 marker) is backed up next to the target, never deleted.
#
# jj WIRING. `jj git push` fires NO git hooks, so in a jj-colocated clone this
# also installs a repo-local jj alias: `jj push` runs scripts/jj-push-gate.sh,
# which runs the pre-push hook and only then delegates to `jj git push`.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/scripts/git-hooks"
# A jj workspace has no .git of its own — jj git root prints the shared git
# dir. Plain-clone fallback: rev-parse --git-path prints a RELATIVE path, so
# anchor it to ROOT or hooks land in the caller's cwd.
if GITDIR="$(jj --repository "$ROOT" git root 2>/dev/null)"; then
  DEST="$GITDIR/hooks"
else
  DEST="$(git -C "$ROOT" rev-parse --git-path hooks)"
  case "$DEST" in /*) ;; *) DEST="$ROOT/$DEST" ;; esac
fi
MARKER="tracked in the repo at scripts/git-hooks/"
mkdir -p "$DEST"

install_hook() {
  local name="$1" target="$DEST/$1"
  if [ -f "$target" ] && ! cmp -s "$SRC/$name" "$target"; then
    if grep -q "$MARKER" "$target"; then
      echo "[hooks] replace $target (older copy)"
    else
      local bak="$target.bak-$(date +%Y%m%d-%H%M%S)"
      mv "$target" "$bak"
      echo "[hooks] foreign hook backed up to $bak"
    fi
  fi
  cp "$SRC/$name" "$target"
  chmod +x "$target"
  echo "[hooks] installed $target"
}

install_hook pre-push

# --- jj gate: install the wrapper next to the hooks, then route `jj push`
# through it via a repo-local alias. Nothing is written outside .git/ here.
if [ -d "$ROOT/.jj" ] && command -v jj >/dev/null 2>&1; then
  cp "$ROOT/scripts/jj-push-gate.sh" "$DEST/jj-push-gate"
  chmod +x "$DEST/jj-push-gate"
  gate_alias='["util", "exec", "--", "bash", "-c", "exec bash \"$(jj git root 2>/dev/null || git rev-parse --git-dir)/hooks/jj-push-gate\" \"$@\"", "jj-push-gate"]'
  current="$(jj --repository "$ROOT" config get aliases.push 2>/dev/null || true)"
  if [ -n "$current" ] && [ "$current" != "$gate_alias" ]; then
    echo "[hooks] WARN replacing existing repo-local jj alias push: $current"
  fi
  jj config set --repo aliases.push "$gate_alias" >/dev/null
  echo "[hooks] installed $DEST/jj-push-gate + jj alias: use 'jj push' (gated) — bare 'jj git push' bypasses the gate"
fi
echo "[hooks] done (bypass: --no-verify or PRESUBMIT=off)"
