#!/usr/bin/env bash
set -euo pipefail
umask 077

ACTION="${1:-}"
case "$ACTION" in start|stop) ;; *) echo "count host action is invalid" >&2; exit 2 ;; esac
[[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ ]] || { echo "count run ID is invalid" >&2; exit 2; }
[[ "${T01_TEAMKIMI_HOST_ID:-}" =~ ^i-[0-9a-f]{8,17}$ ]] || { echo "count host ID is invalid" >&2; exit 2; }
EVIDENCE_DIR="${EVIDENCE_DIR:-$PWD/t01-evidence}"
mkdir -p -m 0700 "$EVIDENCE_DIR"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail() {
  echo "count host $ACTION failed at $1" >&2
  exit 1
}

command_id="$(aws ssm send-command \
  --instance-ids "$T01_TEAMKIMI_HOST_ID" \
  --document-name AWS-RunShellScript \
  --parameters "{\"commands\":[\"/opt/hive-v2/teamkimi-count-host.sh $ACTION $GITHUB_RUN_ID\"]}" \
  --query Command.CommandId --output text 2>"$work/send-error")" || fail send
[[ "$command_id" =~ ^[A-Za-z0-9-]+$ ]] || fail command_id
aws ssm wait command-executed --instance-id "$T01_TEAMKIMI_HOST_ID" \
  --command-id "$command_id" >"$work/wait-output" 2>"$work/wait-error" || fail wait
aws ssm get-command-invocation --instance-id "$T01_TEAMKIMI_HOST_ID" \
  --command-id "$command_id" --query '{Status:Status,Output:StandardOutputContent}' \
  --output json >"$work/invocation.json" 2>"$work/invocation-error" || fail readback

python3 - "$work/invocation.json" "$EVIDENCE_DIR/count-host.jsonl" "$ACTION" <<'PY' || fail sanitize
import json
from pathlib import Path
import sys

invocation_path, evidence_path, action = sys.argv[1:]
try:
    if Path(invocation_path).stat().st_size > 65536:
        raise SystemExit('size')
    invocation = json.loads(Path(invocation_path).read_text(encoding='utf-8'))
except (OSError, UnicodeError, json.JSONDecodeError):
    raise SystemExit('json') from None
if invocation.get('Status') != 'Success':
    raise SystemExit('status')
sequences = {
    'start': ['count_source', 'count_loopback', 'count_proxy', 'count_start'],
    'stop': ['count_source', 'count_stop', 'count_port_closed', 'count_proxy'],
}
lines = invocation.get('Output', '').splitlines()
expected = [f'T01_COUNT {name} passed' for name in sequences[action]]
if lines != expected:
    raise SystemExit('markers')
with Path(evidence_path).open('a', encoding='utf-8') as evidence:
    for line in lines:
        print(line)
        evidence.write(line + '\n')
PY
