#!/bin/bash
# Idempotent provisioner for the hive-v2 box. Runs as root.
# Only rewrites files whose content differs, never clobbers an existing
# /etc/hive-v2/web.env.
set -euo pipefail

# HIVE_PROVISION_REPO exists so a branch can be provision-tested from its
# worktree before merge; deploys always use the default.
REPO=${HIVE_PROVISION_REPO:-/home/ubuntu/hive-v2}
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
install_if_different "$BOX_DIR/hive-v2-tmux.service" /etc/systemd/system/hive-v2-tmux.service 644
install_if_different "$BOX_DIR/hive-v2-tmux.sudoers" /etc/sudoers.d/hive-v2-tmux 440
visudo -cf /etc/sudoers.d/hive-v2-tmux >/dev/null
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

systemctl daemon-reload
systemctl enable --now hive-v2-web hive-v2-watch >/dev/null
systemctl enable hive-v2-tmux >/dev/null
# hive-v2-tmux is never restarted here: its cgroup holds every agent pane.
# Start it only when no server answers the socket. A live server started
# outside the unit (an old build, in the watch cgroup) stays foreign-owned
# until it dies; the wake path then starts the server through the unit.
if [ -S /tmp/tmux-1000/hive-v2 ] && runuser -u ubuntu -- tmux -L hive-v2 list-sessions >/dev/null 2>&1; then
  echo "tmux:    server already up; hive-v2-tmux not started (foreign-owned until it dies)"
else
  rm -f /tmp/tmux-1000/hive-v2
  systemctl restart hive-v2-tmux
  echo "tmux:    hive-v2-tmux (re)started"
fi
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
