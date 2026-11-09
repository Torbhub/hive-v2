#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

HERMES_VERSION=v0.22.6
HERMES_COMMIT=f0d94882e89ab8d4098b5bb2f166adfb9ee0a0ab
HERMES_ARCHIVE_SHA256=551f2c190f21a0df8e0576a20809c63d3077bc56568fe009b98b289fae2efa81
NODE_VERSION=22.23.2
NODE_ARCHIVE_SHA256=d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307
EVIDENCE=/var/lib/t01/evidence/preflight.jsonl
EVIDENCE_IP=
TUNNEL_PID=
BROKER_PORT=8765
if [ "$SCENARIO" != preflight ]; then
  BROKER_PORT=8766
fi

mkdir -p /opt/t01/source /opt/t01/fixtures /opt/t01/tools /opt/t01/pm-home
mkdir -p /opt/t01/runner-source /opt/t01/node /var/lib/t01/evidence /var/lib/t01/hermes /var/lib/t01/workspace /etc/t01/broker
chown root:root /opt/t01 /var/lib/t01 /etc/t01
chmod 0711 /opt/t01 /var/lib/t01 /etc/t01
chmod 0700 /var/lib/t01/evidence /opt/t01/pm-home
: > "$EVIDENCE"
chmod 0600 /var/lib/t01/evidence/preflight.jsonl
shutdown -h +"${LIFETIME_MINUTES}"

emit() {
  local check="$1" status="$2" details="${3:-}" record
  record="{\"check\":\"$check\",\"status\":\"$status\"${details:+,$details}}"
  printf '%s\n' "$record" >> "$EVIDENCE"
}

publish_evidence() {
  local record
  while IFS= read -r record; do
    printf 'T01_EVIDENCE %s\n' "$record" > /dev/console
  done < "$EVIDENCE"
}

stop_tunnel() {
  if [ -n "$TUNNEL_PID" ]; then
    kill -TERM -- "-$TUNNEL_PID"
    wait "$TUNNEL_PID" || [ "$?" = 143 ]
    TUNNEL_PID=
  fi
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
  if [ "$SCENARIO" != preflight ]; then
    iptables -A OUTPUT -o lo -p tcp --dport 8765 -m owner --uid-owner 10000 -j REJECT
  fi
  iptables -A OUTPUT -o lo -j ACCEPT
  iptables -A OUTPUT -d 169.254.169.254 -j REJECT
  iptables -A OUTPUT -d 169.254.170.2 -j REJECT
  iptables -A OUTPUT -p udp --dport 53 -j REJECT
  iptables -A OUTPUT -p tcp --dport 53 -j REJECT
  iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  if [ -n "$EVIDENCE_IP" ]; then
    iptables -A OUTPUT -p tcp -d "$EVIDENCE_IP" --dport 443 -m owner --uid-owner 0 -j ACCEPT
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

read_hermes_check_metadata() {
  local directory="${hermes_check_output%/*}" candidate_category candidate_origin
  local category_file="$directory/bootstrap-category" origin_file="$directory/bootstrap-origin"
  [ -f "$category_file" ] && [ ! -L "$category_file" ] || return 0
  [ -f "$origin_file" ] && [ ! -L "$origin_file" ] || return 0
  [ "$(stat -c %s "$category_file")" -le 64 ] || return 0
  [ "$(stat -c %s "$origin_file")" -le 64 ] || return 0
  candidate_category="$(cat "$category_file")"
  candidate_origin="$(cat "$origin_file")"
  case "$candidate_category" in
    runtime-version-check-failed|runtime-version-exit-failed|runtime-version-format-failed|runtime-identity-check-failed|lazy-install-config-check-failed|lazy-install-request-accepted|hermes-check-timeout|hermes-check-os-error|hermes-check-json-error|hermes-check-runtime-error|hermes-check-value-error) ;;
    runtime-version-dependency-bootstrap-failed|runtime-version-permission-denied|runtime-version-missing-module|runtime-version-import-failed) ;;
    runtime-version-missing-module-pm|runtime-version-missing-module-hermes-cli|runtime-version-missing-module-hermes-bootstrap|runtime-version-missing-module-hermes-constants|runtime-version-missing-module-openai|runtime-version-missing-module-httpx|runtime-version-missing-module-rich|runtime-version-missing-module-ruamel|runtime-version-missing-module-pydantic|runtime-version-missing-module-mcp|runtime-version-missing-module-fire|runtime-version-missing-module-dotenv) ;;
    runtime-version-system-exit-[1-9]|runtime-version-system-exit-[1-9][0-9]|runtime-version-system-exit-1[0-9][0-9]|runtime-version-system-exit-2[0-4][0-9]|runtime-version-system-exit-25[0-5]) ;;
    runtime-version-signal-[1-9]|runtime-version-signal-[1-5][0-9]|runtime-version-signal-6[0-4]) ;;
    *) return 0 ;;
  esac
  [ "$candidate_origin" = hermes-check:1 ] || return 0
  category="$candidate_category"
  origin="$candidate_origin"
}

on_error() {
  local status=$?
  trap - ERR
  set +e
  stop_tunnel
  lock_down
  local category=unknown origin=unknown:0
  local hermes_check_output="${T01_RUNTIME_CHECK_OUT:-/var/lib/t01/hermes/runtime-check.json}"
  if [ -n "${BOOTSTRAP_STAGE:-}" ]; then
    category="failure:$BOOTSTRAP_STAGE"
    origin="$BOOTSTRAP_STAGE:$status"
  fi
  if [[ "$status" =~ ^(124|137)$ ]] && [ -n "${BOOTSTRAP_STAGE:-}" ]; then
    category="timeout:$BOOTSTRAP_STAGE"
    origin="$BOOTSTRAP_STAGE:$status"
  fi
  if [ -f /var/lib/t01/evidence/bootstrap-category ]; then
    category="$(cat /var/lib/t01/evidence/bootstrap-category)"
  fi
  if [ -f /var/lib/t01/evidence/bootstrap-origin ]; then
    origin="$(cat /var/lib/t01/evidence/bootstrap-origin)"
  fi
  read_hermes_check_metadata
  [[ "$category" =~ ^[A-Za-z][A-Za-z0-9_.:-]*$ ]] || category=unknown
  [[ "$origin" =~ ^[A-Za-z0-9_.-]+:[0-9]+$ ]] || origin=unknown:0
  emit bootstrap_error failed "\"category\":\"$category\",\"origin\":\"$origin\""
  emit provisioning failed
  emit complete failed
  publish_evidence
  exit 1
}
trap on_error ERR

BOOTSTRAP_STAGE=filesystem-init
mkdir -p /opt/t01/source /opt/t01/fixtures /opt/t01/tools /opt/t01/pm-home
mkdir -p /var/lib/t01/evidence /var/lib/t01/hermes /etc/t01/broker
chown root:root /opt/t01 /var/lib/t01 /etc/t01
chmod 0711 /opt/t01 /var/lib/t01 /etc/t01
chmod 0700 /var/lib/t01/evidence /opt/t01/pm-home
: > "$EVIDENCE"
chmod 0600 /var/lib/t01/evidence/preflight.jsonl
shutdown -h +"${LIFETIME_MINUTES}"

require_value() {
  if [ -z "${!1:-}" ]; then
    emit "missing_$1" failed
    false
  fi
}

BOOTSTRAP_STAGE=input-validation
for name in TEAMKIMI_SECRET_ARN SCENARIO MATRIX PAID_ADMISSION LIFETIME_MINUTES RUN_ID RUNTIME_SCRIPT_URL RUNTIME_SCRIPT_SHA256 RUNNER_ARCHIVE_URL RUNNER_ARCHIVE_SHA256; do
  require_value "$name"
done
case "$SCENARIO/$MATRIX/$PAID_ADMISSION/$MAX_PAID_ADMISSIONS" in
  preflight/none/false/0) ;;
  count/none/false/0|matrix/full/true/12) require_value T01_TEAMKIMI_HOST_ID ;;
  *) false ;;
esac

BOOTSTRAP_STAGE=system-packages
SESSION_MANAGER_PLUGIN_VERSION=1.2.896.0
SESSION_MANAGER_PLUGIN_SHA256=89a4a07fcb92169bdd2f07c2531acd11b84857338172e7638964aaa08fd5f0e3
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --max-redirs 0 --connect-timeout 10 --max-time 60 \
  "https://s3.amazonaws.com/session-manager-downloads/plugin/$SESSION_MANAGER_PLUGIN_VERSION/linux_64bit/session-manager-plugin.rpm" \
  --output /opt/t01/session-manager-plugin.rpm
printf '%s  %s\n' "$SESSION_MANAGER_PLUGIN_SHA256" /opt/t01/session-manager-plugin.rpm | sha256sum -c -
for attempt in 1 2 3; do
  if dnf install -y gcc gcc-c++ make cmake python3-devel python3.11 python3.11-devel libffi-devel libatomic git xz ca-certificates iptables awscli /opt/t01/session-manager-plugin.rpm; then
    break
  fi
  if [ "$attempt" = 3 ]; then
    false
  fi
  sleep 5
done
rm -f /opt/t01/session-manager-plugin.rpm
BOOTSTRAP_STAGE=runtime-download
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --max-redirs 0 --connect-timeout 10 --max-time 60 \
  "$RUNTIME_SCRIPT_URL" --output /opt/t01/runtime.py
printf '%s  %s\n' "$RUNTIME_SCRIPT_SHA256" /opt/t01/runtime.py | sha256sum -c -
chmod 0555 /opt/t01/runtime.py
BOOTSTRAP_STAGE=source-download
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --max-redirs 0 --connect-timeout 10 --max-time 180 \
  "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" --output /opt/t01/node.tar.xz
printf '%s  %s\n' "$NODE_ARCHIVE_SHA256" /opt/t01/node.tar.xz | sha256sum -c -
tar -xJf /opt/t01/node.tar.xz -C /opt/t01/node --strip-components=1
rm -f /opt/t01/node.tar.xz
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --max-redirs 0 --connect-timeout 10 --max-time 180 \
  "$RUNNER_ARCHIVE_URL" --output /opt/t01/runner.tar.gz
printf '%s  %s\n' "$RUNNER_ARCHIVE_SHA256" /opt/t01/runner.tar.gz | sha256sum -c -
tar -xzf /opt/t01/runner.tar.gz -C /opt/t01/runner-source --strip-components=1
rm -f /opt/t01/runner.tar.gz
cd /opt/t01/runner-source
export PATH=/opt/t01/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
/opt/t01/node/bin/npm ci --ignore-scripts
/opt/t01/node/bin/node ./node_modules/typescript/bin/tsc -p tools/hermes-live/tsconfig.json
cp tools/hermes-live/hermes_preflight_probe.py tools/hermes-live/count-probe.mjs dist-t01/tools/hermes-live/
cp -R tools/hermes-live/fixtures dist-t01/tools/hermes-live/
cp infra/t01-smoke/paid.sh /opt/t01/paid.sh
chmod 0500 /opt/t01/paid.sh
emit node_runtime_locked passed "\"version\":\"$NODE_VERSION\""
emit runner_dependencies_locked passed
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --max-redirs 0 --connect-timeout 10 --max-time 180 \
  "https://codeload.github.com/NousResearch/hermes-agent/tar.gz/$HERMES_COMMIT" \
  --output /opt/t01/hermes.tar.gz
printf '%s  %s\n' "$HERMES_ARCHIVE_SHA256" /opt/t01/hermes.tar.gz | sha256sum -c -
tar -xzf /opt/t01/hermes.tar.gz -C /opt/t01/source --strip-components=1
rm -f /opt/t01/hermes.tar.gz
printf '{"schemaVersion":2,"baseVersion":"0.22.6","commit":"%s","artifactSha256":"%s","distribution":"source","source":"t01","updateMechanism":"external"}\n' \
  "$HERMES_COMMIT" "$HERMES_ARCHIVE_SHA256" > /opt/t01/source/install-stamp.json
emit source_sha256 passed "\"sha256\":\"$HERMES_ARCHIVE_SHA256\""

export HERMES_HOME=/opt/t01/pm-home
export HERMES_RUNTIME_DIR=/opt/t01/tools
export UV_FROZEN=1
cd /opt/t01/source
ensure_package() {
  BOOTSTRAP_STAGE="$1"
  timeout --signal=TERM --kill-after=30s 600 python3.11 - "$1" <<'PY'
from pathlib import Path
import sys
import traceback
try:
    from pm import ensure
    ensure(sys.argv[1], explicit=True)
except Exception as error:
    category = f'{type(error).__name__}:{getattr(error, "package", "unknown")}'
    frame = traceback.extract_tb(error.__traceback__)[-1]
    Path('/var/lib/t01/evidence/bootstrap-category').write_text(category, encoding='utf-8')
    Path('/var/lib/t01/evidence/bootstrap-origin').write_text(f'{Path(frame.filename).name}:{frame.lineno}', encoding='utf-8')
    raise SystemExit(1)
PY
}
ensure_package uv
emit uv_install passed
ensure_package python
emit python_install passed
BOOTSTRAP_STAGE=python-binary
PYTHON="$(python3.11 -c 'from pm import installed_package; print(installed_package("python").binary)')"
BOOTSTRAP_STAGE=pm-build
timeout --signal=TERM --kill-after=30s 1800 python3.11 -m pm.build_env \
  --source /opt/t01/source \
  --python "$PYTHON" \
  --cache /opt/t01/uv-cache \
  --out /opt/t01/hermes \
  --extra mcp \
  --sealed
export UV_OFFLINE=1
[ -f /opt/t01/source/uv.lock ]
[ -x /opt/t01/hermes/bin/hermes ]
emit frozen_hash_lock_install passed
BOOTSTRAP_STAGE=credential-users

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
mkdir -p /var/lib/t01/workspace/home /var/lib/t01/workspace/hermes-home
chown -R t01hermes:t01hermes /var/lib/t01/workspace
chmod 0700 /var/lib/t01/workspace /var/lib/t01/workspace/home /var/lib/t01/workspace/hermes-home
chown root:root /var/lib/t01/hermes/config.yaml
chmod 0444 /var/lib/t01/hermes/config.yaml

BOOTSTRAP_STAGE=credential-secret
command -v aws >/dev/null
aws secretsmanager get-secret-value --secret-id "$TEAMKIMI_SECRET_ARN" \
  --query SecretString --output text > /etc/t01/broker/teamkimi.json
chown t01broker:t01broker /etc/t01/broker/teamkimi.json
chmod 0400 /etc/t01/broker/teamkimi.json

if [ "$SCENARIO" = matrix ]; then
  python3 /opt/t01/runtime.py write-proxy-environment
fi

BOOTSTRAP_STAGE=evidence-endpoint
if [ "$SCENARIO" != preflight ]; then
  EVIDENCE_IP="$(python3 - <<'PY'
import socket
addresses = socket.getaddrinfo('s3.us-east-1.amazonaws.com', 443, socket.AF_INET, socket.SOCK_STREAM)
if not addresses:
    raise SystemExit('evidence endpoint resolution failed')
print(addresses[0][4][0])
PY
)"
  printf '%s %s\n' "$EVIDENCE_IP" s3.us-east-1.amazonaws.com >> /etc/hosts
fi

BOOTSTRAP_STAGE=broker-config
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
    "teamkimi_model_id": "Kimi 3.1 Pro",
    "paid_admission": os.environ["PAID_ADMISSION"] == "true",
})
Path("/etc/t01/broker/config.json").write_text(json.dumps(config, sort_keys=True), encoding="utf-8")
controls = {
    "credential": {"smokeOnly": True, "shortLived": True, "isolatedFromHermes": True},
    "isolation": {
        "disposable": True, "readOnlyFixtures": True, "confinedWorkingDirectories": True,
        "noPrivilegedMode": True, "noHostNetwork": True, "noHostPid": True,
        "noContainerSockets": True, "noCredentialMounts": True, "noWritableHostPaths": True,
        "noOnDemandInstalls": True, "coreDumpsDisabled": True, "debuggingDisabled": True,
    },
    "egress": {
        "defaultDeny": True, "approvedDestination": True, "directIpDenied": True,
        "unapprovedDnsDenied": True, "redirectDenied": True, "ipv6Denied": True,
        "alternatePortDenied": True, "metadataDenied": True,
    },
}
Path("/etc/t01/broker/controls.json").write_text(json.dumps(controls, sort_keys=True), encoding="utf-8")
PY
if [ "$SCENARIO" = matrix ]; then
  printf '%s' "$PRICING_ATTESTATION_BASE64" | base64 -d > /etc/t01/broker/pricing-attestation.json
else
  : > /etc/t01/broker/pricing-attestation.json
fi
chown root:t01broker /etc/t01/broker /etc/t01/broker/config.json /etc/t01/broker/controls.json /etc/t01/broker/pricing-attestation.json
chmod 0750 /etc/t01/broker
chmod 0440 /etc/t01/broker/config.json /etc/t01/broker/controls.json /etc/t01/broker/pricing-attestation.json
chown root:t01hermes /var/lib/t01/hermes/config.yaml
chmod 0440 /var/lib/t01/hermes/config.yaml
chmod 0700 /var/lib/t01/hermes
chmod -R a+rX,go-w /opt/t01/source /opt/t01/hermes /opt/t01/tools /opt/t01/fixtures /opt/t01/runner-source /opt/t01/node

cat > /etc/systemd/system/t01-broker.service <<EOF
[Unit]
Description=T01 no-model TeamKimi broker
After=network.target

[Service]
Type=simple
User=t01broker
Group=t01broker
Environment=T01_BROKER_PORT=$BROKER_PORT
ExecStart=/usr/bin/python3 /opt/t01/runtime.py broker
Restart=no
NoNewPrivileges=yes
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ReadOnlyPaths=/etc/t01/broker /opt/t01/runtime.py
IPAddressDeny=any
IPAddressAllow=127.0.0.0/8
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
Environment=HERMES_INSTALL_ROOT=/opt/t01/source
Environment=PYTHONPATH=/opt/t01/source
Environment=HERMES_RUNTIME_DIR=/opt/t01/tools
Environment=TEAMKIMI_OPENAI_COMPATIBLE_URL=http://127.0.0.1:$BROKER_PORT/v1
Environment=TEAMKIMI_MODEL_ID=Kimi 3.1 Pro
ExecStart=/opt/t01/hermes/bin/python /opt/t01/runtime.py hermes-check
NoNewPrivileges=yes
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ReadOnlyPaths=/opt/t01/fixtures /opt/t01/hermes /opt/t01/source /opt/t01/tools
ReadWritePaths=/var/lib/t01/hermes
ReadOnlyPaths=/var/lib/t01/hermes/config.yaml
IPAddressDeny=any
IPAddressAllow=127.0.0.0/8
IPAddressAllow=::1/128
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
StandardOutput=null
StandardError=null
EOF

cat > /etc/systemd/system/t01-paid.service <<EOF
[Unit]
Description=T01 count-only probe and explicitly admitted paid matrix

[Service]
Type=oneshot
User=root
Group=root
Environment=SCENARIO=$SCENARIO
Environment=EXPECTED_POLICY_HASH=$EXPECTED_POLICY_HASH
Environment=T01_EVIDENCE_BUCKET=$T01_EVIDENCE_BUCKET
Environment=RUN_ID=$RUN_ID
Environment=AWS_REGION=us-east-1
Environment=AWS_ENDPOINT_URL=https://s3.us-east-1.amazonaws.com
ExecStart=/opt/t01/paid.sh
NoNewPrivileges=yes
CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_KILL CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ReadOnlyPaths=/opt/t01 /etc/t01/broker/controls.json /etc/t01/broker/pricing-attestation.json
ReadWritePaths=/var/lib/t01/evidence /var/lib/t01/workspace
IPAddressDeny=any
IPAddressAllow=127.0.0.0/8
IPAddressAllow=::1/128
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
StandardOutput=null
StandardError=null
EOF
if [ "$SCENARIO" != preflight ]; then
  printf 'IPAddressAllow=%s/32\n' "$EVIDENCE_IP" >> /etc/systemd/system/t01-paid.service
fi
chmod 0444 /etc/systemd/system/t01-broker.service /etc/systemd/system/t01-hermes-check.service /etc/systemd/system/t01-paid.service

BOOTSTRAP_STAGE=default-deny-lockdown
systemctl daemon-reload
if [ "$SCENARIO" != preflight ]; then
  setsid runuser -u t01broker -- env -i HOME=/nonexistent PATH=/usr/local/sessionmanagerplugin/bin:/usr/local/bin:/usr/bin:/bin AWS_REGION=us-east-1 \
    aws ssm start-session --target "$T01_TEAMKIMI_HOST_ID" \
    --document-name hive-v2-t01-teamkimi-port-forward >/dev/null 2>&1 &
  TUNNEL_PID=$!
  runuser -u t01broker -- env -i PATH=/usr/bin:/bin /usr/bin/python3 /opt/t01/runtime.py wait-for-teamkimi
  emit trusted_tunnel_ready passed
fi
lock_down
emit default_deny_lockdown passed
BOOTSTRAP_STAGE=broker-access
command -v curl runuser timeout >/dev/null
runuser -u t01broker -- test -r /opt/t01/runtime.py
runuser -u t01broker -- test -r /etc/t01/broker/config.json
runuser -u t01broker -- test -r /etc/t01/broker/teamkimi.json
runuser -u t01broker -- test ! -w /etc/t01/broker/teamkimi.json
BOOTSTRAP_STAGE=hermes-access
runuser -u t01hermes -- test -x /opt/t01/hermes/bin
runuser -u t01hermes -- test -r /opt/t01/fixtures/query.txt
runuser -u t01hermes -- test -r /var/lib/t01/hermes/config.yaml
runuser -u t01hermes -- test -w /var/lib/t01/hermes
if runuser -u t01hermes -- test -r /etc/t01/broker/teamkimi.json; then
  false
fi
if runuser -u t01hermes -- test -x /etc/t01/broker; then
  false
fi
if [ "$SCENARIO" = matrix ] && runuser -u t01hermes -- test -r /etc/t01/proxy.env; then
  false
fi
BOOTSTRAP_STAGE=broker-start
systemctl start t01-broker.service
BOOTSTRAP_STAGE=broker-health
runuser -u t01hermes -- env -i PATH=/usr/bin:/bin T01_BROKER_PORT=$BROKER_PORT /usr/bin/python3 /opt/t01/runtime.py wait-for-broker
BOOTSTRAP_STAGE=hermes-check
systemctl start t01-hermes-check.service
BOOTSTRAP_STAGE=runtime-version
read -r RUNTIME_VERSION RUNTIME_COMMIT < <(python3 - <<'PY'
import json
with open('/var/lib/t01/hermes/runtime-check.json', encoding='utf-8') as source:
    record = json.load(source)
print(record['version'], record['commit'])
PY
)
[ "$RUNTIME_VERSION" = "${HERMES_VERSION#v}" ]
[ "$RUNTIME_COMMIT" = "$HERMES_COMMIT" ]
emit hermes_version passed "\"version\":\"$RUNTIME_VERSION\",\"commit\":\"$RUNTIME_COMMIT\""
emit lazy_install_disabled passed
emit service_filesystem_access passed

as_hermes() {
  runuser -u t01hermes -- env -i \
    HOME=/var/lib/t01/hermes \
    PATH=/usr/bin:/bin \
    HERMES_HOME=/var/lib/t01/hermes \
    TEAMKIMI_OPENAI_COMPATIBLE_URL=http://127.0.0.1:$BROKER_PORT/v1 \
    TEAMKIMI_MODEL_ID='Kimi 3.1 Pro' "$@"
}

expect_denied() {
  local name="$1" rc=0
  shift
  as_hermes timeout 12 "$@" >/dev/null 2>&1 || rc=$?
  case "$rc" in
    6|7|28|124) emit "$name" passed ;;
    *)
      emit "$name" failed
      return 1
      ;;
  esac
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

BOOTSTRAP_STAGE=network-negative
expect_denied direct_ip curl -4 --fail --silent https://192.0.2.1/
expect_denied unapproved_dns curl -4 --fail --silent https://example.com/
expect_denied redirect curl -4 --fail --silent --location "http://127.0.0.1:$BROKER_PORT/redirect-fixture"
expect_denied ipv6 curl -6 --fail --silent 'https://[2606:4700:4700::1111]/'
expect_denied alternate_port curl -4 --fail --silent https://192.0.2.1:8443/
expect_denied metadata curl -4 --fail --silent http://169.254.169.254/latest/meta-data/
expect_denied container_credentials curl -4 --fail --silent http://169.254.170.2/
BOOTSTRAP_STAGE=teamkimi-no-model
expect_allowed teamkimi_no_model curl -4 --fail --silent "http://127.0.0.1:$BROKER_PORT/health"
expect_broker_allowed() {
  local name="$1"
  shift
  if ! runuser -u t01broker -- env -i PATH=/usr/bin:/bin timeout 15 "$@" >/dev/null 2>&1; then
    emit "$name" failed
    return 1
  fi
  emit "$name" passed
}
expect_broker_rejected() {
  local name="$1" expected="$2" code
  shift 2
  if ! code="$(runuser -u t01broker -- env -i PATH=/usr/bin:/bin \
      timeout 15 curl --silent --output /dev/null --write-out '%{http_code}' "$@" 2>/dev/null)"; then
    emit "$name" failed
    return 1
  fi
  if [ "$code" != "$expected" ]; then
    emit "$name" failed
    return 1
  fi
  emit "$name" passed
}
if [ "$SCENARIO" != preflight ]; then
  expect_denied teamkimi_control_port curl -4 --fail --silent -X POST -H 'content-type: application/json' \
    --data '{"scope":"generation"}' http://127.0.0.1:8765/teamkimi/smoke/credentials
  expect_broker_allowed teamkimi_control_broker curl -4 --fail --silent http://127.0.0.1:8765/teamkimi/smoke/status
  expect_broker_rejected teamkimi_messages_rejected 401 --request POST \
    -H 'content-type: application/json' -H 'x-api-key: tcc-local-negative-check' \
    --data '{}' http://127.0.0.1:8765/v1/messages
  if [ "$SCENARIO" = count ]; then
    expect_broker_rejected teamkimi_generation_rejected 403 --request POST \
      -H 'content-type: application/json' --data '{"scope":"generation"}' \
      http://127.0.0.1:8765/teamkimi/smoke/credentials
  fi
fi
BOOTSTRAP_STAGE=broker-stop
systemctl stop t01-broker.service
if [ "$SCENARIO" = preflight ]; then
  emit paid_admission_disabled passed
else
  systemctl start t01-paid.service
  stop_tunnel
  emit tunnel_cleanup passed
  if [ "$SCENARIO" = count ]; then
    emit paid_admission_disabled passed
  fi
fi
emit complete passed
publish_evidence
