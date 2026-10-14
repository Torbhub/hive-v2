#!/bin/bash
# Deploy payload run ON the box via SSM. Runs as root.
# Resets the repo to the exact merged commit, rebuilds, reprovisions, health-checks.
set -euo pipefail

REPO=/home/ubuntu/hive-v2
SHA=${1:-}
if [ -z "$SHA" ]; then
  echo "usage: deploy-box.sh <commit-sha>" >&2
  exit 1
fi

cd "$REPO"
runuser -u ubuntu -- git fetch origin main
runuser -u ubuntu -- git reset --hard "$SHA"
runuser -u ubuntu -- env PATH=/opt/node22/bin:$PATH npm ci
runuser -u ubuntu -- env PATH=/opt/node22/bin:$PATH npm run build

# No password on stdin: an existing htpasswd file is preserved.
bash infra/provision-box.sh </dev/null

systemctl restart hive-v2-web hive-v2-watch

SECRET=$(sed -n 's/^HIVE_WEB_SECRET=//p' /etc/hive-v2/web.env)
URL=http://127.0.0.1:7684/api/view

fail=0

code_noauth=$(curl -sf -o /dev/null -w '%{http_code}' "$URL" || true)
if [ "$code_noauth" = 403 ]; then
  echo "PASS: no auth header -> 403"
else
  echo "FAIL: no auth header -> $code_noauth (want 403)"
  fail=1
fi

code_auth=""
for _ in $(seq 1 6); do
  code_auth=$(curl -s -o /dev/null -w '%{http_code}' -H "x-hive-auth: $SECRET" "$URL" || true)
  [ "$code_auth" = 200 ] && break
  sleep 5
done
if [ "$code_auth" = 200 ]; then
  echo "PASS: auth header -> 200"
else
  echo "FAIL: auth header -> $code_auth (want 200)"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "deploy: FAIL"
  exit 1
fi
echo "deploy: PASS ($SHA)"
