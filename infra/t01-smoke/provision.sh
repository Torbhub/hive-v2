#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

HERMES_VERSION=v0.22.6
HERMES_COMMIT=f0d94882e89ab8d4098b5bb2f166adfb9ee0a0ab
HERMES_ARCHIVE_SHA256=551f2c190f21a0df8e0576a20809c63d3077bc56568fe009b98b289fae2efa81
EVIDENCE=/var/lib/t01/evidence/preflight.jsonl
TEAMKIMI_IP=

mkdir -p /opt/t01/source /opt/t01/fixtures /opt/t01/hermes /opt/t01/tools /opt/t01/pm-home
mkdir -p /var/lib/t01/evidence /var/lib/t01/hermes /etc/t01/broker
: > "$EVIDENCE"
chmod 0600 /var/lib/t01/evidence/preflight.jsonl
shutdown -h +"${LIFETIME_MINUTES}"

emit() {
  local check="$1" status="$2" record
  record="{\"check\":\"$check\",\"status\":\"$status\"}"
  printf '%s\n' "$record" | tee -a "$EVIDENCE"
  printf 'T01_EVIDENCE %s\n' "$record" > /dev/console
}

lock_down() {
  iptables -P INPUT DROP
  iptables -P FORWARD DROP
  iptables -P OUTPUT DROP
  iptables -F INPUT
  iptables -F FORWARD
  iptables -F OUTPUT
  iptables -A INPUT -i lo -j ACCEPT
  iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  iptables -A OUTPUT -o lo -j ACCEPT
  iptables -A OUTPUT -d 169.254.169.254 -j REJECT
  iptables -A OUTPUT -d 169.254.170.2 -j REJECT
  iptables -A OUTPUT -p udp --dport 53 -j REJECT
  iptables -A OUTPUT -p tcp --dport 53 -j REJECT
  iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  if [ -n "$TEAMKIMI_IP" ]; then
    iptables -A OUTPUT -p tcp -d "$TEAMKIMI_IP" --dport 443 -m owner --uid-owner 10001 -j ACCEPT
  fi
  iptables -A OUTPUT -j REJECT
  ip6tables -P INPUT DROP
  ip6tables -P FORWARD DROP
  ip6tables -P OUTPUT DROP
  ip6tables -F INPUT
  ip6tables -F FORWARD
  ip6tables -F OUTPUT
  ip6tables -A INPUT -i lo -j ACCEPT
  ip6tables -A OUTPUT -o lo -j ACCEPT
  ip6tables -A OUTPUT -d fd00:ec2::254 -j REJECT
  ip6tables -A OUTPUT -j REJECT
}

on_error() {
  trap - ERR
  set +e
  lock_down
  emit provisioning failed
  emit complete failed
  exit 1
}
trap on_error ERR

require_value() {
  if [ -z "${!1:-}" ]; then
    emit "missing_$1" failed
    false
  fi
}

for name in TEAMKIMI_URL TEAMKIMI_SECRET_ARN TEAMKIMI_SECRET_KEY TEAMKIMI_CONNECTIVITY_PATH SCENARIO MATRIX LIFETIME_MINUTES RUN_ID; do
  require_value "$name"
done
[ "$SCENARIO" = preflight ]
[ "$MATRIX" = none ]
[ "$MAX_PAID_ADMISSIONS" = 0 ]

curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --max-redirs 0 --connect-timeout 10 --max-time 180 \
  "https://codeload.github.com/NousResearch/hermes-agent/tar.gz/$HERMES_COMMIT" \
  --output /opt/t01/hermes.tar.gz
printf '%s  %s\n' "$HERMES_ARCHIVE_SHA256" /opt/t01/hermes.tar.gz | sha256sum -c -
tar -xzf /opt/t01/hermes.tar.gz -C /opt/t01/source --strip-components=1
rm -f /opt/t01/hermes.tar.gz
printf '{"schemaVersion":2,"commit":"%s","distribution":"source","source":"t01","updateMechanism":"external"}\n' \
  "$HERMES_COMMIT" > /opt/t01/source/install-stamp.json
emit "hermes_${HERMES_VERSION}_${HERMES_COMMIT}" passed
emit "source_sha256_${HERMES_ARCHIVE_SHA256}" passed

export HERMES_HOME=/opt/t01/pm-home
export HERMES_RUNTIME_DIR=/opt/t01/tools
export UV_FROZEN=1
cd /opt/t01/source
python3 -c 'from pm import ensure; ensure("uv", explicit=True); ensure("python", explicit=True)'
PYTHON="$(python3 -c 'from pm import installed_package; print(installed_package("python").binary)')"
python3 -m pm.build_env \
  --source /opt/t01/source \
  --python "$PYTHON" \
  --cache /opt/t01/uv-cache \
  --out /opt/t01/hermes \
  --sealed
export UV_OFFLINE=1
[ -f /opt/t01/source/uv.lock ]
[ -x /opt/t01/hermes/bin/hermes ]
emit frozen_hash_lock_install passed

cat > /var/lib/t01/hermes/config.yaml <<'EOF'
security:
  allow_lazy_installs: false
EOF
chmod 0444 /var/lib/t01/hermes/config.yaml
printf 'Return the exact text: T01 fixture only.\n' > /opt/t01/fixtures/query.txt
chmod 0444 /opt/t01/fixtures/query.txt
chmod 0555 /opt/t01/fixtures
chmod -R go-w /opt/t01/source /opt/t01/hermes /opt/t01/tools

useradd --system --user-group --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin t01broker
useradd --system --user-group --uid 10000 --home-dir /var/lib/t01/hermes --shell /usr/sbin/nologin t01hermes
chown -R t01hermes:t01hermes /var/lib/t01/hermes
chown root:root /var/lib/t01/hermes/config.yaml
chmod 0444 /var/lib/t01/hermes/config.yaml

aws secretsmanager get-secret-value --secret-id "$TEAMKIMI_SECRET_ARN" \
  --query SecretString --output text > /etc/t01/broker/teamkimi.json
chown t01broker:t01broker /etc/t01/broker/teamkimi.json
chmod 0400 /etc/t01/broker/teamkimi.json

read -r TEAMKIMI_HOST TEAMKIMI_IP < <(python3 - "$TEAMKIMI_URL" <<'PY'
import socket
import sys
from urllib.parse import urlsplit
url = urlsplit(sys.argv[1])
if url.scheme != "https" or url.username or url.password or url.query or url.fragment:
    raise SystemExit("TeamKimi URL must be an HTTPS origin without credentials, query, or fragment")
if url.path or url.port not in (None, 443):
    raise SystemExit("TeamKimi URL must use only the origin and port 443")
addresses = socket.getaddrinfo(url.hostname, 443, socket.AF_INET, socket.SOCK_STREAM)
if not addresses:
    raise SystemExit("TeamKimi IPv4 resolution failed")
print(url.hostname, addresses[0][4][0])
PY
)
printf '%s %s\n' "$TEAMKIMI_IP" "$TEAMKIMI_HOST" >> /etc/hosts

python3 - <<'PY'
import json
import os
from pathlib import Path
names = (
    "SCENARIO", "MATRIX", "MAX_INPUT_TOKENS", "MAX_OUTPUT_TOKENS",
    "MAX_REASONING_TOKENS", "MAX_TOTAL_TOKENS", "MAX_API_CALLS",
    "MAX_ESTIMATED_COST_USD", "MAX_PAID_ADMISSIONS", "RUN_ID",
)
config = {name.lower(): os.environ[name] for name in names}
config.update({
    "teamkimi_url": os.environ["TEAMKIMI_URL"],
    "teamkimi_secret_key": os.environ["TEAMKIMI_SECRET_KEY"],
    "teamkimi_connectivity_path": os.environ["TEAMKIMI_CONNECTIVITY_PATH"],
    "teamkimi_model_id": "Kimi 3.1 Pro",
    "paid_admission": False,
})
Path("/etc/t01/broker/config.json").write_text(json.dumps(config, sort_keys=True), encoding="utf-8")
PY
chmod 0444 /etc/t01/broker/config.json

cat > /opt/t01/broker.py <<'PY'
import http.client
import json
import os
import ssl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

with open("/etc/t01/broker/config.json", encoding="utf-8") as config_file:
    CONFIG = json.load(config_file)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def reply(self, status, body):
        payload = json.dumps(body, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == "/redirect-fixture":
            self.send_response(302)
            self.send_header("Location", "https://example.com/")
            self.send_header("Connection", "close")
            self.end_headers()
            return
        if self.path != "/health":
            self.reply(404, {"status": "unavailable"})
            return
        try:
            with open("/etc/t01/broker/teamkimi.json", encoding="utf-8") as secret_file:
                secret = json.load(secret_file)
            api_key = secret[CONFIG["teamkimi_secret_key"]]
            if not isinstance(api_key, str) or not api_key:
                raise ValueError("invalid credential shape")
            target = urlsplit(CONFIG["teamkimi_url"])
            connection = http.client.HTTPSConnection(
                target.hostname, 443, timeout=10, context=ssl.create_default_context()
            )
            connection.request("GET", CONFIG["teamkimi_connectivity_path"], headers={
                "Authorization": f"Bearer {api_key}",
                "Accept": "application/json",
                "Connection": "close",
            })
            response = connection.getresponse()
            response.read(1024)
            connection.close()
            if 200 <= response.status < 300:
                self.reply(200, {"status": "ok"})
            else:
                self.reply(502, {"status": "upstream_rejected", "upstream_status": response.status})
        except (OSError, ValueError, KeyError, json.JSONDecodeError, ssl.SSLError):
            self.reply(502, {"status": "connectivity_failed"})


ThreadingHTTPServer(("127.0.0.1", 8765), Handler).serve_forever()
PY
chmod 0555 /opt/t01/broker.py

cat > /etc/systemd/system/t01-broker.service <<EOF
[Unit]
Description=T01 no-model TeamKimi broker
After=network.target

[Service]
Type=simple
User=t01broker
Group=t01broker
ExecStart=/usr/bin/python3 /opt/t01/broker.py
Restart=no
NoNewPrivileges=yes
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ReadOnlyPaths=/etc/t01/broker /opt/t01/broker.py
IPAddressDeny=any
IPAddressAllow=127.0.0.0/8
IPAddressAllow=${TEAMKIMI_IP}/32
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
StandardOutput=null
StandardError=null

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/t01-hermes-check.service <<'EOF'
[Unit]
Description=T01 sealed Hermes invocation check

[Service]
Type=oneshot
User=t01hermes
Group=t01hermes
Environment=HOME=/var/lib/t01/hermes
Environment=PATH=/opt/t01/hermes/bin:/usr/bin:/bin
Environment=HERMES_HOME=/var/lib/t01/hermes
Environment=TEAMKIMI_OPENAI_COMPATIBLE_URL=http://127.0.0.1:8765/v1
Environment=TEAMKIMI_MODEL_ID=Kimi 3.1 Pro
ExecStart=/opt/t01/hermes/bin/hermes --version
NoNewPrivileges=yes
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ReadOnlyPaths=/opt/t01/fixtures /opt/t01/hermes /opt/t01/source
ReadWritePaths=/var/lib/t01/hermes
IPAddressDeny=any
IPAddressAllow=127.0.0.0/8
IPAddressAllow=::1/128
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
StandardOutput=null
StandardError=null
EOF
chmod 0444 /etc/systemd/system/t01-broker.service /etc/systemd/system/t01-hermes-check.service

systemctl daemon-reload
lock_down
emit default_deny_lockdown passed
systemctl start t01-broker.service
systemctl start t01-hermes-check.service
emit hermes_version_invocation passed

as_hermes() {
  runuser -u t01hermes -- env -i \
    HOME=/var/lib/t01/hermes \
    PATH=/usr/bin:/bin \
    HERMES_HOME=/var/lib/t01/hermes \
    TEAMKIMI_OPENAI_COMPATIBLE_URL=http://127.0.0.1:8765/v1 \
    TEAMKIMI_MODEL_ID='Kimi 3.1 Pro' "$@"
}

expect_denied() {
  local name="$1"
  shift
  if as_hermes timeout 12 "$@" >/dev/null 2>&1; then
    emit "$name" failed
    return 1
  fi
  emit "$name" passed
}

expect_allowed() {
  local name="$1"
  shift
  if ! as_hermes timeout 15 "$@" >/dev/null 2>&1; then
    emit "$name" failed
    return 1
  fi
  emit "$name" passed
}

expect_denied direct_ip curl -4 --fail --silent https://192.0.2.1/
expect_denied unapproved_dns curl -4 --fail --silent https://example.com/
expect_denied redirect curl -4 --fail --silent --location http://127.0.0.1:8765/redirect-fixture
expect_denied ipv6 curl -6 --fail --silent 'https://[2606:4700:4700::1111]/'
expect_denied alternate_port curl -4 --fail --silent "https://${TEAMKIMI_HOST}:8443/"
expect_denied metadata curl -4 --fail --silent http://169.254.169.254/latest/meta-data/
expect_denied container_credentials curl -4 --fail --silent http://169.254.170.2/
expect_allowed teamkimi_no_model curl -4 --fail --silent http://127.0.0.1:8765/health
systemctl stop t01-broker.service
emit paid_admission_disabled passed
emit complete passed
