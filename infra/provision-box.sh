#!/bin/bash
# Idempotent provisioner for the hive-v2 box. Runs as root.
# Only rewrites files whose content differs, never clobbers an existing
# /etc/hive-v2/web.env.
set -euo pipefail

REPO=/home/ubuntu/hive-v2
BOX_DIR="$REPO/infra/box"
ENV_FILE=/etc/hive-v2/web.env
NGINX_AVAIL=/etc/nginx/sites-available/hive-v2
NGINX_ENABLED=/etc/nginx/sites-enabled/hive-v2
# The basic-auth fallback is gone; its credential file dies on provision.
HTPASSWD_STALE=/etc/nginx/webterm/.htpasswd-hive

if [ "$(id -u)" -ne 0 ]; then
  echo "FAIL: run as root" >&2
  exit 1
fi

install_if_different() {
  local src=$1 dst=$2 mode=$3
  if [ ! -f "$dst" ] || ! cmp -s "$src" "$dst"; then
    install -m "$mode" -D "$src" "$dst"
    echo "updated: $dst"
  else
    echo "kept:    $dst"
  fi
}

install_if_different "$BOX_DIR/hive-v2-web.service" /etc/systemd/system/hive-v2-web.service 644
install_if_different "$BOX_DIR/hive-v2-watch.service" /etc/systemd/system/hive-v2-watch.service 644
install_if_different "$BOX_DIR/hive" /usr/local/bin/hive 755

mkdir -p /etc/hive-v2
if [ ! -f "$ENV_FILE" ]; then
  umask 077
  {
    printf 'HIVE_WEB_SECRET=%s\n' "$(openssl rand -hex 24)"
    printf 'HIVE_ORIGIN_KEY=%s\n' "$(openssl rand -hex 24)"
  } > "$ENV_FILE"
  echo "generated: $ENV_FILE"
elif ! grep -q '^HIVE_ORIGIN_KEY=' "$ENV_FILE"; then
  printf 'HIVE_ORIGIN_KEY=%s\n' "$(openssl rand -hex 24)" >> "$ENV_FILE"
  echo "appended HIVE_ORIGIN_KEY to $ENV_FILE"
else
  echo "kept:    $ENV_FILE"
fi

HIVE_WEB_SECRET=$(sed -n 's/^HIVE_WEB_SECRET=//p' "$ENV_FILE")
HIVE_ORIGIN_KEY=$(sed -n 's/^HIVE_ORIGIN_KEY=//p' "$ENV_FILE")
if [ -z "$HIVE_WEB_SECRET" ] || [ -z "$HIVE_ORIGIN_KEY" ]; then
  echo "FAIL: HIVE_WEB_SECRET or HIVE_ORIGIN_KEY missing in $ENV_FILE" >&2
  exit 1
fi

# Escape & and / so a non-hex value cannot corrupt the sed render.
WEB_SECRET_ESC=${HIVE_WEB_SECRET//[&\/]/\\&}
ORIGIN_KEY_ESC=${HIVE_ORIGIN_KEY//[&\/]/\\&}

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
sed -e "s/__HIVE_WEB_SECRET__/$WEB_SECRET_ESC/" -e "s/__HIVE_ORIGIN_KEY__/$ORIGIN_KEY_ESC/" \
  "$BOX_DIR/nginx-hive.conf" > "$tmp"
install_if_different "$tmp" "$NGINX_AVAIL" 644
rm -f "$tmp"
trap - EXIT
if [ ! -e "$NGINX_ENABLED" ]; then
  ln -s "$NGINX_AVAIL" "$NGINX_ENABLED"
  echo "linked:  $NGINX_ENABLED"
fi

if [ -f "$HTPASSWD_STALE" ]; then
  rm -f "$HTPASSWD_STALE"
  echo "removed: $HTPASSWD_STALE (basic-auth fallback retired)"
fi

# nexus-push MCP client (citadel #1747), pinned fetch from the private
# citadel repo via the ubuntu user's gh auth. Bump BOTH pins to upgrade.
NEXUS_PUSH_SHA=6542be37f15e682c5c18268892fd769911d0bf5b
NEXUS_PUSH_SHA256=bdf23a9ddca9377a357400110564aedf85b546a5ce8ff762a17cbe3341024cbf
NEXUS_PUSH_DST=/opt/nexus-push/nexus_push_mcp.py

if [ -f "$NEXUS_PUSH_DST" ] && echo "$NEXUS_PUSH_SHA256  $NEXUS_PUSH_DST" | sha256sum -c --status -; then
  echo "kept:    $NEXUS_PUSH_DST"
else
  tmp=$(mktemp)
  trap 'rm -f "$tmp"' EXIT
  runuser -u ubuntu -- gh api \
    "repos/Torbhub/citadel/contents/scripts/nexus_push_mcp.py?ref=$NEXUS_PUSH_SHA" \
    -H "Accept: application/vnd.github.raw" > "$tmp"
  if ! echo "$NEXUS_PUSH_SHA256  $tmp" | sha256sum -c --status -; then
    echo "FAIL: nexus-push sha256 mismatch at pinned SHA $NEXUS_PUSH_SHA" >&2
    exit 1
  fi
  install_if_different "$tmp" "$NEXUS_PUSH_DST" 644
  rm -f "$tmp"
  trap - EXIT
fi

systemctl daemon-reload
systemctl enable --now hive-v2-web hive-v2-watch >/dev/null
systemctl restart hive-v2-web hive-v2-watch
echo "services: hive-v2-web hive-v2-watch enabled and restarted"

if nginx -t 2>/dev/null; then
  systemctl reload nginx
  echo "nginx:   config ok, reloaded"
else
  echo "FAIL: nginx -t failed; nginx not reloaded" >&2
  exit 1
fi

echo "provision: done"
