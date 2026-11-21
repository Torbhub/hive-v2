#!/usr/bin/env bash
set -euo pipefail
umask 077

TEAMKIMI_COUNT_COMMIT=a0ee0a586ca445ad4d1cdb4fbf14579236b017e7
TEAMKIMI_COUNT_ARCHIVE_SHA256=30e2c4ccae49f8819b061f90237f4c2e0fc55b81638f3d26b4ea0df8704fb9b7
TEAMKIMI_COUNT_ARCHIVE_URL="https://codeload.github.com/Torbhub/teamkimi/tar.gz/$TEAMKIMI_COUNT_COMMIT"
SOURCE_PARENT=/opt/teamkimi-count
SOURCE="$SOURCE_PARENT/$TEAMKIMI_COUNT_COMMIT"

if [ "$(id -u)" -ne 0 ]; then
  echo "FAIL: run as root" >&2
  exit 1
fi

verify_source() {
  local source="${1:-$SOURCE}"
  python3 - "$source" "$TEAMKIMI_COUNT_COMMIT" "$TEAMKIMI_COUNT_ARCHIVE_SHA256" "$TEAMKIMI_COUNT_ARCHIVE_URL" <<'PY'
import json
import os
from pathlib import Path
import sys

root = Path(sys.argv[1])
expected = {
    'commit': sys.argv[2],
    'archiveSha256': sys.argv[3],
    'archiveUrl': sys.argv[4],
}
if root.is_symlink() or not root.is_dir():
    raise SystemExit('invalid TeamKimi count source')
if json.loads((root / 'provenance.json').read_text(encoding='utf-8')) != expected:
    raise SystemExit('TeamKimi count provenance mismatch')
for directory, names, files in os.walk(root):
    for name in [*names, *files]:
        path = Path(directory) / name
        mode = path.lstat().st_mode
        if path.is_symlink() or not (path.is_dir() or path.is_file()):
            raise SystemExit('TeamKimi count source contains a non-regular path')
        if mode & 0o222 or path.stat().st_uid != 0 or path.stat().st_gid != 0:
            raise SystemExit('TeamKimi count source is not root-owned and read-only')
if not (root / 'src/index.js').is_file():
    raise SystemExit('TeamKimi count CLI is absent')
PY
}

if [ -L "$SOURCE_PARENT" ]; then
  echo "FAIL: TeamKimi count source parent must not be a symlink" >&2
  exit 1
fi
if [ -d "$SOURCE" ]; then
  verify_source
  echo "kept:    $SOURCE"
  exit 0
fi
if [ -e "$SOURCE" ] || [ -L "$SOURCE" ]; then
  echo "FAIL: unexpected TeamKimi count source path" >&2
  exit 1
fi

archive="$(mktemp)"
staging="$(mktemp -d /opt/teamkimi-count-install.XXXXXX)"
trap 'rm -f "$archive"; rm -rf "$staging"' EXIT
runuser -u ubuntu -- gh api "repos/Torbhub/teamkimi/tarball/$TEAMKIMI_COUNT_COMMIT" > "$archive"
printf '%s  %s\n' "$TEAMKIMI_COUNT_ARCHIVE_SHA256" "$archive" | sha256sum -c --status -
tar -xzf "$archive" -C "$staging" --strip-components=1
printf '%s\n' "{\"commit\":\"$TEAMKIMI_COUNT_COMMIT\",\"archiveSha256\":\"$TEAMKIMI_COUNT_ARCHIVE_SHA256\",\"archiveUrl\":\"$TEAMKIMI_COUNT_ARCHIVE_URL\"}" > "$staging/provenance.json"
chown -R root:root "$staging"
chmod -R a-w,a+rX "$staging"
verify_source "$staging"
install -d -o root -g root -m 0755 "$SOURCE_PARENT"
chmod u+w "$staging"
mv "$staging" "$SOURCE"
chmod a-w "$SOURCE"
trap - EXIT
rm -f "$archive"
echo "updated: $SOURCE"
