#!/bin/bash
# Posts today's daily-scan task to the hub web API and starts the team on
# it. Runs from hive-v2-daily-scan.timer; HIVE_WEB_SECRET arrives through
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

# Idempotency: the task text opens with the dated marker, so a task file
# that already carries it means today was posted — by this script or by
# hand. A cancelled one counts too: a human closed it, do not repost.
if grep -lxF "$MARKER" "$TASKS_DIR/$PROJECT"-*.md >/dev/null 2>&1; then
  echo "kept: $MARKER already posted"
  exit 0
fi

read -r -d '' TEXT <<EOF || true
$MARKER

Run the daily self-improvement loop for hive-v2. The pipeline is
skills/experiment/SKILL.md — follow it.

1. Spawn a news-scout (roles/news-scout.md). It crawls the standing
   sources in docs/crawl-sources.md plus one web-search pass for new Kimi
   Code, agent-orchestration, tmux-automation, and CLI-harness news, and
   writes docs/crawl/$TODAY.md.
2. Read the findings. Pick at most one candidate experiment. Nothing
   worth trying is a normal result: log done with the reason and close.
3. Try the pick in a jj workspace lane, get the gate green in CI, open
   the PR, and hand it to the deslop-reviewer
   (roles/deslop-reviewer.md).
4. An experiment that touches infra/ or .github/ is never auto-merged:
   leave its PR open for the owner and say so.
EOF

post() {
  curl -sS -w '\n%{http_code}' -X POST "$API$1" \
    -H "x-hive-auth: $HIVE_WEB_SECRET" -H 'content-type: application/json' \
    -d "$2"
}

resp=$(post /api/task "$(jq -n --arg project "$PROJECT" --arg text "$TEXT" '{project:$project, text:$text}')")
code=${resp##*$'\n'}
body=${resp%$'\n'*}
[ "$code" = 200 ] || { echo "FAIL: POST /api/task -> $code: $body" >&2; exit 1; }
id=$(jq -r '.id // empty' <<<"$body")
[ -n "$id" ] || { echo "FAIL: POST /api/task returned no id: $body" >&2; exit 1; }
echo "posted: $id"

resp=$(post /api/start "$(jq -n --arg project "$PROJECT" --arg task "$id" '{project:$project, task:$task}')")
code=${resp##*$'\n'}
body=${resp%$'\n'*}
if [ "$code" != 200 ]; then
  # A live orchestrator picks the task up from the ledger on its own;
  # refusing to start a second one is not a failure of the daily loop.
  if grep -q 'already running' <<<"$body"; then
    echo "note: orchestrator already running; $id waits in the ledger"
    exit 0
  fi
  echo "FAIL: POST /api/start $id -> $code: $body" >&2
  exit 1
fi
echo "started: $id"
