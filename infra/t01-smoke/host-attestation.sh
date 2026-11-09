#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ "${T01_TEAMKIMI_HOST_ID:-}" =~ ^i-[0-9a-f]{8,17}$ ]] || { echo "health attestation host ID is invalid" >&2; exit 2; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail() {
  echo "health attestation refresh failed at $1" >&2
  exit 1
}

command_id="$(aws ssm send-command \
  --instance-ids "$T01_TEAMKIMI_HOST_ID" \
  --document-name AWS-RunShellScript \
  --parameters '{"commands":["/usr/bin/python3 /home/ubuntu/hive-v2/infra/t01-smoke/teamkimi_attestation.py"]}' \
  --query Command.CommandId --output text 2>"$work/send-error")" || fail send
[[ "$command_id" =~ ^[A-Za-z0-9-]+$ ]] || fail command_id
aws ssm wait command-executed --instance-id "$T01_TEAMKIMI_HOST_ID" \
  --command-id "$command_id" >"$work/wait-output" 2>"$work/wait-error" || fail wait
aws ssm get-command-invocation --instance-id "$T01_TEAMKIMI_HOST_ID" \
  --command-id "$command_id" --query '{Status:Status,Output:StandardOutputContent}' \
  --output json >"$work/invocation.json" 2>"$work/invocation-error" || fail readback

python3 - "$work/invocation.json" "$(dirname "${BASH_SOURCE[0]}")" <<'PY' || fail sanitize
import json
import os
from pathlib import Path
import sys
import time

sys.path.insert(0, sys.argv[2])
from teamkimi_attestation import validate_attestation

try:
    invocation_path = Path(sys.argv[1])
    if invocation_path.stat().st_size > 65536:
        raise ValueError('oversized invocation')
    invocation = json.loads(invocation_path.read_text(encoding='utf-8'))
    if not isinstance(invocation, dict) or set(invocation) != {'Status', 'Output'}:
        raise ValueError('invalid invocation fields')
    if invocation['Status'] != 'Success' or not isinstance(invocation['Output'], str):
        raise ValueError('command failed')
    output = invocation['Output']
    if len(output.encode('utf-8')) > 4096:
        raise ValueError('oversized output')
    value = json.loads(output)
    validate_attestation(value, int(time.time()))
except (OSError, UnicodeError, json.JSONDecodeError, ValueError):
    raise SystemExit(1) from None

encoded = json.dumps(value, separators=(',', ':'), sort_keys=True)
print(encoded)
destination = os.environ.get('GITHUB_OUTPUT')
if destination:
    with open(destination, 'a', encoding='utf-8') as output_file:
        output_file.write(f'attestation={encoded}\n')
PY
