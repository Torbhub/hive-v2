#!/bin/bash
# Idempotent provisioner for the hive-v2 box. Runs as root.
# Adopts the live hand-rolled setup: only rewrites files whose content differs,
# never clobbers an existing /etc/hive-v2/web.env or htpasswd file.
set -euo pipefail

REPO=/home/ubuntu/hive-v2
BOX_DIR="$REPO/infra/box"
ENV_FILE=/etc/hive-v2/web.env
NGINX_AVAIL=/etc/nginx/sites-available/hive-v2
NGINX_ENABLED=/etc/nginx/sites-enabled/hive-v2
HTPASSWD=/etc/nginx/webterm/.htpasswd-hive

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

mkdir -p /etc/nginx/webterm
password=""
if [ ! -t 0 ]; then
  password=$(cat)
fi
if [ -n "$password" ]; then
  if ! command -v htpasswd >/dev/null 2>&1; then
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq apache2-utils >/dev/null
  fi
  printf '%s' "$password" | htpasswd -i -B -c "$HTPASSWD" alex
  chmod 644 "$HTPASSWD"
  echo "updated: $HTPASSWD"
elif [ -f "$HTPASSWD" ]; then
  echo "kept:    $HTPASSWD"
else
  echo "FAIL: no password on stdin and $HTPASSWD does not exist" >&2
  exit 1
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
