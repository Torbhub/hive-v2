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
MEMORY_ENV=/etc/hive-v2/memory.env
GATEWAY_YAML=/etc/hive-v2/tdai-gateway.yaml
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
install_if_different "$BOX_DIR/hive-memory-core.service" /etc/systemd/system/hive-memory-core.service 644
install_if_different "$BOX_DIR/hive-memory-panel.service" /etc/systemd/system/hive-memory-panel.service 644
install_if_different "$BOX_DIR/hive-memory-llm-forward.service" /etc/systemd/system/hive-memory-llm-forward.service 644
install_if_different "$BOX_DIR/hive-memory-relay.service" /etc/systemd/system/hive-memory-relay.service 644
install_if_different "$BOX_DIR/hive-v2-tmux.sudoers" /etc/sudoers.d/hive-v2-tmux 440
install_if_different "$BOX_DIR/hive-v2-dmesg.sudoers" /etc/sudoers.d/hive-v2-dmesg 440
install_if_different "$BOX_DIR/hive-v2-pstack.sudoers" /etc/sudoers.d/hive-v2-pstack 440
install_if_different "$BOX_DIR/hive" /usr/local/bin/hive 755
install_if_different "$BOX_DIR/hub-attach.sh" /opt/hive-v2/hub-attach.sh 755
install_if_different "$BOX_DIR/daily-scan.sh" /opt/hive-v2/daily-scan.sh 755
install_if_different "$BOX_DIR/llm-forward.py" /opt/hive-v2/llm-forward.py 755
install_if_different "$BOX_DIR/memory-relay.py" /opt/hive-v2/memory-relay.py 755

# Every kimi session gets the hive-operator MCP server. Per-agent routing
# comes from the session's own HIVE_* env, never from this file.
sudo -u ubuntu /opt/node22/bin/node "$REPO/infra/merge-mcp.mjs" /home/ubuntu/.kimi-code/mcp.json

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

# memory.env is generated once and never overwritten: it holds live secrets.
if [ ! -f "$MEMORY_ENV" ]; then
  umask 077
  gw_key=$(openssl rand -hex 24)
  ks_key="ks-svc-$(openssl rand -hex 16)"
  cat > "$MEMORY_ENV" <<EOF
# hive memory stack config. Empty means unconfigured.
# MEMORY_LLM_* feeds the core gateway config (rendered by provision).
# LLM_* is the same LLM mirrored for the panel container. Fill both groups,
# then: systemctl restart hive-memory-core hive-memory-panel
MEMORY_LLM_BASE_URL=
MEMORY_LLM_API_KEY=
MEMORY_LLM_MODEL=
MEMORY_LLM_PROTOCOL=openai
MEMORY_PROMPT_MODE=code
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=
LLM_PROTOCOL=openai
# Core gateway Bearer key. The panel authenticates with REMOTE_INSTANCE_KEY.
# Keep the two equal.
TDAI_GATEWAY_API_KEY=$gw_key
REMOTE_INSTANCE_KEY=$gw_key
# Panel to knowledge auth, injected into both sides. Keep the pair equal.
KNOWLEDGE_SERVICE_KEY=$ks_key
KNOWLEDGE_AUTH_TOKEN=$ks_key
# Where the browser reaches the knowledge API. Needs the /v3 suffix.
KNOWLEDGE_PUBLIC_BASE_URL=http://127.0.0.1:8424/v3
KNOWLEDGE_LLM_BINDING_SYNC=0
# System-admin bootstrap for the v3 meta API (user/key minting). Generate a
# random key once; the core creates this user on startup. Never a lane key.
TDAI_MEMORY_SYSTEM_USER_ID=
TDAI_MEMORY_SYSTEM_USER_KEY=
EOF
  echo "generated: $MEMORY_ENV"
else
  echo "kept:    $MEMORY_ENV"
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

# Render the memory-core gateway config from memory.env, same sed pattern as
# nginx. The stock image ships no config and boots with skill/knowledge off.
mem_conf() { sed -n "s/^$1=//p" "$MEMORY_ENV" | head -n 1; }
# Escape for a YAML double-quoted scalar first (\ and "), then for the sed
# replacement (&, /, \), so any secret survives both layers.
yaml_esc() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | sed -e 's/[&\/\\]/\\&/g'
}

MEM_BASE=$(mem_conf MEMORY_LLM_BASE_URL)
MEM_KEY=$(mem_conf MEMORY_LLM_API_KEY)
MEM_MODEL=$(mem_conf MEMORY_LLM_MODEL)
MEM_MODE=$(mem_conf MEMORY_PROMPT_MODE)
MEM_MODE=${MEM_MODE:-code}
if [ -z "$MEM_BASE" ] || [ -z "$MEM_KEY" ] || [ -z "$MEM_MODEL" ]; then
  echo "memory:   LLM not configured in $MEMORY_ENV; extraction stays idle"
fi

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
sed -e "s/__MEMORY_LLM_BASE_URL__/$(yaml_esc "$MEM_BASE")/" \
    -e "s/__MEMORY_LLM_API_KEY__/$(yaml_esc "$MEM_KEY")/" \
    -e "s/__MEMORY_LLM_MODEL__/$(yaml_esc "$MEM_MODEL")/" \
    -e "s/__MEMORY_PROMPT_MODE__/$(yaml_esc "$MEM_MODE")/" \
    "$BOX_DIR/tdai-gateway.yaml" > "$tmp"
install_if_different "$tmp" "$GATEWAY_YAML" 600
rm -f "$tmp"
trap - EXIT

if ! command -v docker >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io
  echo "docker:   installed docker.io"
else
  echo "kept:    docker already installed"
fi
systemctl enable --now docker >/dev/null
if ! id -nG ubuntu | grep -qw docker; then
  usermod -aG docker ubuntu
  echo "docker:   added ubuntu to the docker group"
fi
if ! docker network inspect tdai-memory-stack >/dev/null 2>&1; then
  # Fixed subnet: memory.env points LLM base URLs at the gateway address,
  # so the gateway must survive a network recreate unchanged.
  docker network create --subnet=172.18.0.0/16 tdai-memory-stack >/dev/null
  echo "docker:   created network tdai-memory-stack"
elif [ "$(docker network inspect tdai-memory-stack --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')" != "172.18.0.1" ]; then
  echo "WARN: tdai-memory-stack gateway is not 172.18.0.1; the LLM base URLs in $MEMORY_ENV assume it" >&2
fi
docker pull agentmemory/memory-core:1.0.3-beta.1
docker pull agentmemory/memory-hub:1.0.3-beta.1

systemctl daemon-reload
systemctl enable --now hive-v2-web hive-v2-watch hive-v2-webterm hive-memory-core hive-memory-panel hive-memory-llm-forward hive-memory-relay >/dev/null
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
systemctl restart hive-v2-web hive-v2-watch hive-v2-webterm hive-memory-core hive-memory-panel hive-memory-llm-forward hive-memory-relay
echo "services: hive-v2-web hive-v2-watch hive-v2-webterm hive-memory-core hive-memory-panel hive-memory-llm-forward hive-memory-relay enabled and restarted"
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
