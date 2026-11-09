#!/usr/bin/env bash
set -euo pipefail
umask 077

ACTION="${1:-}"
RUN_ID="${2:-}"
COMMIT=ab0dcf76cc96a31e2376677a915990d011c5c807
ARCHIVE_SHA256=87b6648a0ec932da74c3a3e383d9209c34dafaff5b3a1f6b4373d6ac11f9f3f4
SOURCE=/opt/teamkimi-count/$COMMIT
STATE=/var/lib/teamkimi-count/$RUN_ID
UNIT="teamkimi-count@$RUN_ID.service"
NORMAL_UNIT=teamkimi-tmux.service
SOURCE_OWNER=0
SOURCE_GROUP=0

fail() {
  printf 'T01_COUNT %s failed\n' "$1"
  exit 1
}

[ "$(id -u)" = 0 ] || fail count_permissions
[[ "$RUN_ID" =~ ^[0-9]+$ ]] || fail count_run_id
case "$ACTION" in start|stop) ;; *) fail count_action ;; esac

normal_proxy_pid() {
  systemctl show "$NORMAL_UNIT" -p MainPID --value 2>/dev/null
}

NORMAL_PID="$(normal_proxy_pid)"
[[ "$NORMAL_PID" =~ ^[0-9]+$ ]] || fail count_proxy
[ "$NORMAL_PID" = 0 ] || fail count_proxy
if systemctl is-active --quiet "$NORMAL_UNIT" 2>/dev/null; then
  fail count_proxy
fi

verify_normal_proxy() {
  local current
  current="$(normal_proxy_pid)"
  [[ "$current" =~ ^[0-9]+$ ]] || fail count_proxy
  [ "$current" = "$NORMAL_PID" ] || fail count_proxy
  if systemctl is-active --quiet "$NORMAL_UNIT" 2>/dev/null; then
    fail count_proxy
  fi
}

verify_source() {
  [ -d "$SOURCE" ] && [ ! -L "$SOURCE" ] && [ ! -L "${SOURCE%/*}" ] || fail count_source
  [ -f /etc/systemd/system/teamkimi-count@.service ] || fail count_source
  [ "$(stat -c %u "$SOURCE")" = "$SOURCE_OWNER" ] || fail count_source
  [ "$(stat -c %g "$SOURCE")" = "$SOURCE_GROUP" ] || fail count_source
  python3 - "$SOURCE" "$COMMIT" "$ARCHIVE_SHA256" "$SOURCE_OWNER" "$SOURCE_GROUP" <<'PY' || fail count_source
import json
import os
from pathlib import Path
import sys

root = Path(sys.argv[1])
stamp = json.loads((root / 'provenance.json').read_text(encoding='utf-8'))
if stamp.get('commit') != sys.argv[2] or stamp.get('archiveSha256') != sys.argv[3]:
    raise SystemExit(1)
for directory, names, files in os.walk(root):
    for name in [*names, *files]:
        path = Path(directory) / name
        info = path.lstat()
        if path.is_symlink() or not (path.is_dir() or path.is_file()):
            raise SystemExit(1)
        if info.st_mode & 0o222 or info.st_uid != int(sys.argv[4]) or info.st_gid != int(sys.argv[5]):
            raise SystemExit(1)
PY
  printf 'T01_COUNT count_source passed\n'
}

port_unused() {
  local listeners
  listeners="$(ss -ltnH 'sport = :8765' 2>/dev/null)" || return 1
  [ -z "$listeners" ]
}

verify_status() {
  python3 - "$1" <<'PY'
import json
from pathlib import Path
import sys

path = Path(sys.argv[1])
if path.stat().st_size > 65536:
    raise SystemExit(1)
status = json.loads(path.read_text(encoding='utf-8'))
if status.get('enabled') is not True or status.get('countOnly') is not True:
    raise SystemExit(1)
if status.get('pricingVerified') is not False or status.get('admissionAllowed') is not False:
    raise SystemExit(1)
if status.get('blockedReason') is not None or status.get('reservations') != []:
    raise SystemExit(1)
if status.get('totals', {}).get('admissions') != 0:
    raise SystemExit(1)
credentials = status.get('credentials')
if not isinstance(credentials, list) or any(item.get('revokedAt') is None for item in credentials):
    raise SystemExit(1)
PY
}

fetch_status() {
  curl --fail --silent --show-error --connect-timeout 2 --max-time 5 \
    --output "$1" http://127.0.0.1:8765/teamkimi/smoke/status >/dev/null 2>&1
}

[ ! -L "${STATE%/*}" ] || fail count_state
verify_source
case "$ACTION" in
  start)
    if systemctl is-active --quiet "$UNIT" 2>/dev/null; then
      fail count_start
    fi
    [ ! -e "$STATE" ] && [ ! -L "$STATE" ] || fail count_state
    port_unused || fail count_port_owner
    install -d -m 0700 -o ubuntu -g ubuntu "$STATE"
    systemctl start "$UNIT" >/dev/null 2>&1 || fail count_start
    status_file="$(mktemp)"
    trap 'rm -f "$status_file"' EXIT
    ready=no
    for _ in {1..30}; do
      if fetch_status "$status_file" && verify_status "$status_file"; then
        ready=yes
        break
      fi
      sleep 1
    done
    [ "$ready" = yes ] || fail count_loopback
    verify_normal_proxy
    printf 'T01_COUNT count_loopback passed\n'
    printf 'T01_COUNT count_proxy passed\n'
    printf 'T01_COUNT count_start passed\n'
    ;;
  stop)
    systemctl is-active --quiet "$UNIT" 2>/dev/null || fail count_stop
    [ -d "$STATE" ] && [ ! -L "$STATE" ] || fail count_state
    [ "$(stat -c %U "$STATE")" = ubuntu ] || fail count_state
    [ "$(stat -c %a "$STATE")" = 700 ] || fail count_state
    [ -f "$STATE/ledger.json" ] || fail count_state
    status_file="$(mktemp)"
    trap 'rm -f "$status_file"' EXIT
    fetch_status "$status_file" || fail count_status
    verify_status "$status_file" || fail count_active_state
    verify_normal_proxy
    systemctl stop "$UNIT" >/dev/null 2>&1 || fail count_stop
    if systemctl is-active --quiet "$UNIT" 2>/dev/null; then
      fail count_stop
    fi
    port_unused || fail count_port_closed
    verify_normal_proxy
    printf 'T01_COUNT count_stop passed\n'
    printf 'T01_COUNT count_port_closed passed\n'
    printf 'T01_COUNT count_proxy passed\n'
    ;;
esac
