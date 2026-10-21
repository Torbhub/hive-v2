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

visudo -cf "$BOX_DIR/hive-v2-tmux.sudoers" >/dev/null
visudo -cf "$BOX_DIR/hive-v2-dmesg.sudoers" >/dev/null
visudo -cf "$BOX_DIR/hive-v2-pstack.sudoers" >/dev/null
install_if_different "$BOX_DIR/hive-v2-web.service" /etc/systemd/system/hive-v2-web.service 644
install_if_different "$BOX_DIR/hive-v2-watch.service" /etc/systemd/system/hive-v2-watch.service 644
install_if_different "$BOX_DIR/hive-v2-tmux.service" /etc/systemd/system/hive-v2-tmux.service 644
install_if_different "$BOX_DIR/hive-v2-webterm.service" /etc/systemd/system/hive-v2-webterm.service 644
install_if_different "$BOX_DIR/hive-v2-daily-scan.service" /etc/systemd/system/hive-v2-daily-scan.service 644
install_if_different "$BOX_DIR/hive-v2-daily-scan.timer" /etc/systemd/system/hive-v2-daily-scan.timer 644
install_if_different "$BOX_DIR/hive-v2-tmux.sudoers" /etc/sudoers.d/hive-v2-tmux 440
install_if_different "$BOX_DIR/hive-v2-dmesg.sudoers" /etc/sudoers.d/hive-v2-dmesg 440
install_if_different "$BOX_DIR/hive-v2-pstack.sudoers" /etc/sudoers.d/hive-v2-pstack 440
install_if_different "$BOX_DIR/hive" /usr/local/bin/hive 755
install_if_different "$BOX_DIR/hub-attach.sh" /opt/hive-v2/hub-attach.sh 755
install_if_different "$BOX_DIR/daily-scan.sh" /opt/hive-v2/daily-scan.sh 755

mkdir -p /etc/hive-v2
if [ ! -f "$ENV_FILE" ]; then
  umask 077
  printf 'HIVE_WEB_SECRET=%s\n' "$(openssl rand -hex 24)" > "$ENV_FILE"
  echo "generated: $ENV_FILE"
elif grep -q '^HIVE_ORIGIN_KEY=' "$ENV_FILE"; then
  # The public 443 vhost is gone; the origin key has no consumer left.
  sed -i '/^HIVE_ORIGIN_KEY=/d' "$ENV_FILE"
  echo "pruned HIVE_ORIGIN_KEY from $ENV_FILE"
else
  echo "kept:    $ENV_FILE"
fi

HIVE_WEB_SECRET=$(sed -n 's/^HIVE_WEB_SECRET=//p' "$ENV_FILE")
if [ -z "$HIVE_WEB_SECRET" ]; then
  echo "FAIL: HIVE_WEB_SECRET missing in $ENV_FILE" >&2
  exit 1
fi

# Escape & and / so a non-hex value cannot corrupt the sed render.
WEB_SECRET_ESC=${HIVE_WEB_SECRET//[&\/]/\\&}

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
sed "s/__HIVE_WEB_SECRET__/$WEB_SECRET_ESC/" "$BOX_DIR/nginx-hive.conf" > "$tmp"
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
systemctl enable --now hive-v2-web hive-v2-watch hive-v2-webterm >/dev/null
systemctl enable hive-v2-tmux >/dev/null
# hive-v2-tmux is never restarted here: its cgroup holds every agent pane.
# Start it only when no server answers the socket. A live server started
# outside the unit (an old build, in the watch cgroup) stays foreign-owned
# until it dies; the wake path then starts the server through the unit.
if [ -S /tmp/tmux-1000/hive-v2 ] && runuser -u ubuntu -- tmux -L hive-v2 list-sessions >/dev/null 2>&1; then
  echo "tmux:    server already up; hive-v2-tmux not started (foreign-owned until it dies)"
else
  # No rm of the socket: tmux rebinds over a stale file itself, and a probe
  # gap could otherwise unlink a live socket.
  systemctl restart hive-v2-tmux
  echo "tmux:    hive-v2-tmux (re)started"
fi
systemctl restart hive-v2-web hive-v2-watch hive-v2-webterm
echo "services: hive-v2-web hive-v2-watch hive-v2-webterm enabled and restarted"
# A timer, not a service: enable and (re)start the timer itself, never the
# oneshot it fires.
systemctl enable --now hive-v2-daily-scan.timer >/dev/null
systemctl restart hive-v2-daily-scan.timer
echo "timer:    hive-v2-daily-scan.timer enabled"

if nginx -t 2>/dev/null; then
  systemctl reload nginx
  echo "nginx:   config ok, reloaded"
else
  echo "FAIL: nginx -t failed; nginx not reloaded" >&2
  exit 1
fi

echo "provision: done"
