#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

NODE=/opt/t01/node/bin/node
RUNNER=/opt/t01/runner-source/dist-t01/tools/hermes-live
EVIDENCE=/var/lib/t01/evidence
export PATH=/opt/t01/node/bin:/opt/t01/hermes/bin:/usr/bin:/bin
export HOME=/var/lib/t01/hermes
export HERMES_HOME=/var/lib/t01/hermes
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE AWS_DEFAULT_PROFILE
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy SSH_AUTH_SOCK

printf '%s\n' node-count-runner-failed > "$EVIDENCE/bootstrap-category"
printf '%s\n' count-probe:1 > "$EVIDENCE/bootstrap-origin"
if [ ! -f "$RUNNER/count-probe.mjs" ] || [ ! -f "$RUNNER/policy.js" ]; then
  printf '%s\n' count-runner-missing > "$EVIDENCE/bootstrap-category"
  printf '%s\n' count-runner:1 > "$EVIDENCE/bootstrap-origin"
  false
fi
"$NODE" "$RUNNER/count-probe.mjs" "$EVIDENCE/count.json" >/dev/null 2>&1
if ! /usr/bin/python3 /opt/t01/runtime.py count-evidence "$EVIDENCE/count.json" >> "$EVIDENCE/preflight.jsonl" 2>/dev/null; then
  printf '%s\n' runtime-count-evidence-invalid > "$EVIDENCE/bootstrap-category"
  printf '%s\n' count-evidence:1 > "$EVIDENCE/bootstrap-origin"
  false
fi
rm -f "$EVIDENCE/bootstrap-category" "$EVIDENCE/bootstrap-origin"

if [ "$SCENARIO" = matrix ]; then
  export HIVE_T01_BROKER_URL=http://127.0.0.1:8765
  export HIVE_T01_AUTHORIZE_PAID_ADMISSIONS=yes
  export HIVE_T01_MODEL=kimi-code/k3.1-pro
  . /etc/t01/proxy.env
  HIVE_T01_PROXY_KEY="$HIVE_T01_PROXY_KEY" "$NODE" "$RUNNER/cli.js" run \
    --artifacts "$EVIDENCE/export" \
    --controls /etc/t01/broker/controls.json \
    --attestation /etc/t01/broker/pricing-attestation.json \
    --expected-policy-hash "$EXPECTED_POLICY_HASH" \
    --workspace /var/lib/t01/workspace \
    --hermes /opt/t01/hermes/bin/hermes \
    --hermes-user t01hermes \
    --python /opt/t01/hermes/bin/python \
    --paid-admissions-authorized
  unset HIVE_T01_AUTHORIZE_PAID_ADMISSIONS
  HIVE_T01_SMOKE_CREDENTIAL_ID="$(/usr/bin/python3 /opt/t01/runtime.py manifest-credential "$EVIDENCE/export/preflight.json")"
  aws s3 cp "$EVIDENCE/export" "s3://$T01_EVIDENCE_BUCKET/hive-v2-t01-smoke/$RUN_ID/" --recursive
  MANIFEST_HASH="$(sha256sum "$EVIDENCE/export/manifest.json" | cut -d' ' -f1)"
  printf '{"check":"paid_evidence_export","status":"passed","sha256":"%s","credentialId":"%s"}\n' "$MANIFEST_HASH" "$HIVE_T01_SMOKE_CREDENTIAL_ID" >> "$EVIDENCE/preflight.jsonl"
  printf '{"check":"paid_matrix_completed","status":"passed","policyHash":"%s"}\n' "$EXPECTED_POLICY_HASH" >> "$EVIDENCE/preflight.jsonl"
fi
