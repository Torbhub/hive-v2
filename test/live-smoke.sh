#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

teamkimi status >/dev/null
[ -d dist ] || npm run build >/dev/null
exec node test/live-smoke.mjs
