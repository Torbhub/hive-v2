#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/scripts/git-hooks"
if GITDIR="$(jj --repository "$ROOT" git root 2>/dev/null)"; then
  DEST="$GITDIR/hooks"
else
  DEST="$(git -C "$ROOT" rev-parse --git-path hooks)"
  case "$DEST" in /*) ;; *) DEST="$ROOT/$DEST" ;; esac
fi
MARKER="hive-v2 tracked hook: scripts/git-hooks/"
LEGACY_MARKER="tracked in the repo at scripts/git-hooks/"
mkdir -p "$DEST"

install_hook() {
  local name="$1" target="$DEST/$1"
  if [ -f "$target" ] && ! cmp -s "$SRC/$name" "$target"; then
    if grep -q -F -e "$MARKER" -e "$LEGACY_MARKER" "$target"; then
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
