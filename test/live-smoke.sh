#!/usr/bin/env bash
# Live smoke: spawn a real kimi session through teamkimi, detect idle, type a
# prompt, see it work and go idle, close it. Spends API quota; not run in CI.
set -euo pipefail
cd "$(dirname "$0")/.."

teamkimi status >/dev/null
[ -d dist ] || npm run build >/dev/null
exec node test/live-smoke.mjs
