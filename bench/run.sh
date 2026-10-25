#!/usr/bin/env bash
# run one bench task against a candidate action and print a pass/fail verdict
# usage: bench/run.sh bench/tasks/<id> [action-cmd...]
set -euo pipefail
task="$(cd "${1:?usage: bench/run.sh bench/tasks/<id> [action-cmd...]}" && pwd)"
shift
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp -r "$task" "$work/task"
git clone -q --filter=blob:none https://github.com/Torbhub/hive-v2 "$work/hive"
cd "$work/hive"
git checkout -q "$(cat "$work/task/rev")"
npm ci --no-audit --no-fund >&2
bash "$work/task/setup.sh" >&2
if [ $# -gt 0 ]; then
  # The agent's own output is diagnostic and goes to stderr; stdout stays
  # reserved for the verdict line, or the caller's line count breaks.
  "$@" >&2 || true
fi
changed="$(git status --porcelain | cut -c4- || true)"
verdict=fail
detail=
outside=
if [ -f "$work/task/allows" ]; then
  outside="$(comm -13 <(sort "$work/task/allows") <(printf '%s\n' "$changed" | sort) || true)"
fi
if [ -n "$outside" ]; then
  detail="touched outside allows: $outside"
else
  git add -A
  git -c user.name=hive-bench -c user.email=hive-bench@local commit -q --allow-empty -m "bench candidate: $(basename "$task")"
  if ! npm run build >/dev/null 2>&1; then
    detail="npm run build failed"
  else
    node dist/src/cli.js gate --log "$work/gate.log" -- check "bash '$work/task/check.sh'" >/dev/null || true
    detail="$(node dist/src/cli.js gate-verify log "$work/gate.log" --expect check --commit HEAD 2>&1 || true)"
    if printf '%s\n' "$detail" | grep -q '^GREEN'; then
      verdict=pass
      detail=
    fi
  fi
fi
if [ -n "$detail" ]; then
  printf '%s\n' "$detail" >&2
fi
printf '{"task":"%s","verdict":"%s","changed":"%s","ts":"%s"}\n' \
  "$(basename "$task")" "$verdict" \
  "$(printf '%s' "$changed" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ' | sed 's/ $//')" \
  "$(date -u +%FT%TZ)"
[ "$verdict" = pass ]
