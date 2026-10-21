#!/bin/bash
# Posts today's daily-scan task to the hub web API and starts the team on
# it. Runs from hive-v2-daily-scan.timer. HIVE_WEB_SECRET arrives through
# the unit's EnvironmentFile (/etc/hive-v2/web.env) and is never echoed.
set -euo pipefail

API=http://127.0.0.1:7684
PROJECT=hivev2
TASKS_DIR=/home/ubuntu/hive-work/.hive-hub/tasks
TODAY=$(date -u +%F)
MARKER="daily-scan $TODAY"

if [ -z "${HIVE_WEB_SECRET:-}" ]; then
  echo "FAIL: HIVE_WEB_SECRET is not set (the unit reads /etc/hive-v2/web.env)" >&2
  exit 1
fi

post() {
  curl -sS -w '\n%{http_code}' -X POST "$API$1" \
    -H "x-hive-auth: $HIVE_WEB_SECRET" -H 'content-type: application/json' \
    -d "$2"
}

start_task() {
  local id=$1 resp code body
  resp=$(post /api/start "$(jq -n --arg project "$PROJECT" --arg task "$id" '{project:$project, task:$task}')")
  code=${resp##*$'\n'}
  body=${resp%$'\n'*}
  if [ "$code" != 200 ]; then
    # A live orchestrator picks the task up from the ledger on its own.
    # Refusing to start a second one is not a failure of the daily loop.
    if grep -q 'already running' <<<"$body"; then
      echo "note: orchestrator already running. $id waits in the ledger"
      return 0
    fi
    echo "FAIL: POST /api/start $id -> $code: $body" >&2
    return 1
  fi
  echo "started: $id"
}

# Idempotency: the task text opens with the dated marker, so a task file
# that already carries it means today was posted, by this script or by
# hand. A closed one stays closed. An open one may be orphaned (posted but
# never started), so retry the start before exiting.
file=$(grep -lxF "$MARKER" "$TASKS_DIR/$PROJECT"-*.md 2>/dev/null | head -1 || true)
if [ -n "$file" ]; then
  id=$(basename "$file" .md)
  state=$(curl -fsS "$API/api/view" -H "x-hive-auth: $HIVE_WEB_SECRET" \
    | jq -r --arg id "$id" '.tasks[] | select(.id == $id) | .state')
  if [ "$state" = done ] || [ "$state" = cancelled ]; then
    echo "kept: $MARKER already posted and closed ($id)"
    exit 0
  fi
  echo "kept: $MARKER already posted ($id). Retrying the start."
  start_task "$id"
  exit 0
fi

read -r -d '' TEXT <<EOF || true
$MARKER

Run the daily self-improvement loop for hive-v2. The pipeline is
skills/experiment/SKILL.md. Follow it. The roles it uses:
roles/news-scout.md and roles/deslop-reviewer.md.
EOF

resp=$(post /api/task "$(jq -n --arg project "$PROJECT" --arg text "$TEXT" '{project:$project, text:$text}')")
code=${resp##*$'\n'}
body=${resp%$'\n'*}
[ "$code" = 200 ] || { echo "FAIL: POST /api/task -> $code: $body" >&2; exit 1; }
id=$(jq -r '.id // empty' <<<"$body")
[ -n "$id" ] || { echo "FAIL: POST /api/task returned no id: $body" >&2; exit 1; }
echo "posted: $id"

start_task "$id"
