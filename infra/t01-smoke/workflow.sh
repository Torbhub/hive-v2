#!/usr/bin/env bash
set -euo pipefail
umask 077

STACK_NAME=hive-v2-t01-smoke
HEALTH_SECRET_NAME="hive-v2-t01-smoke-health-${GITHUB_RUN_ID:-manual}"
PROXY_SECRET_NAME="hive-v2-t01-smoke-proxy-${GITHUB_RUN_ID:-manual}"
OWNER="hive-v2-t01-smoke/${GITHUB_RUN_ID:-manual}"

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "missing required input: $name" >&2
    exit 2
  fi
}

validate_integer_cap() {
  local name="$1" maximum="$2"
  require_env "$name"
  if [[ ! "${!name}" =~ ^[0-9]+$ ]] || (( ${!name} > maximum )); then
    echo "$name must be an integer from 0 to $maximum" >&2
    exit 2
  fi
}

validate_inputs() {
  require_env SCENARIO
  require_env MATRIX
  require_env PAID_ADMISSION
  validate_integer_cap MAX_INPUT_TOKENS 16000
  validate_integer_cap MAX_OUTPUT_TOKENS 2000
  validate_integer_cap MAX_REASONING_TOKENS 4000
  validate_integer_cap MAX_PAID_ADMISSIONS 12
  require_env MAX_ESTIMATED_COST_USD
  require_env MAX_TOTAL_TOKENS
  require_env MAX_API_CALLS
  case "$SCENARIO/$MATRIX/$PAID_ADMISSION" in
    preflight/none/false)
      validate_integer_cap MAX_TOTAL_TOKENS 22000
      validate_integer_cap MAX_API_CALLS 1
      [ "$MAX_PAID_ADMISSIONS" = 0 ] || { echo "preflight requires zero paid admissions" >&2; exit 2; }
      python3 - "$MAX_ESTIMATED_COST_USD" 0.50 <<'PY'
from decimal import Decimal, InvalidOperation
import sys
try:
    value = Decimal(sys.argv[1])
except InvalidOperation:
    raise SystemExit("cost cap must be numeric")
if value < 0 or value > Decimal(sys.argv[2]):
    raise SystemExit("cost cap exceeds the scenario limit")
PY
      ;;
    count/none/false)
      [ "$MAX_TOTAL_TOKENS" = 0 ] && [ "$MAX_API_CALLS" = 0 ] && [ "$MAX_PAID_ADMISSIONS" = 0 ] \
        && [ "$MAX_ESTIMATED_COST_USD" = 0 ] || { echo "count requires zero generation caps and admissions" >&2; exit 2; }
      require_env T01_TEAMKIMI_HOST_ID
      [[ "$T01_TEAMKIMI_HOST_ID" =~ ^i-[0-9a-f]{8,17}$ ]] || { echo "invalid TeamKimi host ID" >&2; exit 2; }
      ;;
    matrix/full/true)
      [ "$MAX_INPUT_TOKENS" = 16000 ] && [ "$MAX_OUTPUT_TOKENS" = 2000 ] && [ "$MAX_REASONING_TOKENS" = 4000 ] \
        && [ "$MAX_TOTAL_TOKENS" = 132000 ] && [ "$MAX_API_CALLS" = 12 ] && [ "$MAX_PAID_ADMISSIONS" = 12 ] \
        && [ "$MAX_ESTIMATED_COST_USD" = 5 ] || { echo "full matrix requires exact reviewed ceilings" >&2; exit 2; }
      require_env T01_TEAMKIMI_HOST_ID
      [[ "$T01_TEAMKIMI_HOST_ID" =~ ^i-[0-9a-f]{8,17}$ ]] || { echo "invalid TeamKimi host ID" >&2; exit 2; }
      local attestation_file
      attestation_file="$(mktemp)"
      trap "rm -f $attestation_file" EXIT
      python3 - "$attestation_file" <<'PY'
import os
from pathlib import Path
import sys
Path(sys.argv[1]).write_text(os.environ['PRICING_ATTESTATION'], encoding='utf-8')
PY
      node_modules/.bin/tsx tools/hermes-live/cli.ts validate-policy \
        --attestation "$attestation_file" --expected-policy-hash "$EXPECTED_POLICY_HASH" || exit 2
      ;;
    *)
      echo "scenario, matrix, and paid admission do not form a reviewed dispatch" >&2
      exit 2
      ;;
  esac
  validate_integer_cap LIFETIME_MINUTES 120
  (( LIFETIME_MINUTES >= 5 )) || { echo "lifetime must be at least five minutes" >&2; exit 2; }
}

acquire_mutex() {
  bash infra/deploy-mutex.sh acquire aws-acts "$OWNER"
}

mutex_renewer() {
  while [ ! -e "$RENEWAL_STOP_FILE" ]; do
    bash infra/deploy-mutex.sh renew aws-acts "$OWNER" || return $?
    sleep 600
  done
}

stop_mutex_renewal() {
  local rc=0
  if [ -z "${MUTEX_RENEWER_PID:-}" ]; then
    return 0
  fi
  if mkdir "$RENEWAL_DIR/stop-complete" 2>/dev/null; then
    : > "$RENEWAL_STOP_FILE"
    kill -TERM -- "-$MUTEX_RENEWER_PID" 2>/dev/null || true
  fi
  wait "$MUTEX_RENEWER_PID" 2>/dev/null || rc=$?
  case "$rc" in
    0|143) rc=0 ;;
  esac
  unset MUTEX_RENEWER_PID
  return "$rc"
}

with_mutex_renewal() {
  local command="$1" command_rc=0 renewal_rc=0 command_pid wait_n_rc finished_pid
  shift
  RENEWAL_DIR="$(mktemp -d)"
  RENEWAL_STOP_FILE="$RENEWAL_DIR/stop"
  set -m
  mutex_renewer &
  MUTEX_RENEWER_PID=$!
  export RENEWAL_STOP_FILE RENEWAL_DIR MUTEX_RENEWER_PID
  ( "$command" "$@" ) &
  command_pid=$!
  set +m
  while true; do
    wait_n_rc=0 finished_pid=
    wait -n -p finished_pid "$command_pid" "$MUTEX_RENEWER_PID" || wait_n_rc=$?
    case "$finished_pid" in
      "$command_pid")
        command_rc="$wait_n_rc"
        stop_mutex_renewal || renewal_rc=$?
        break
        ;;
      "$MUTEX_RENEWER_PID")
        renewal_rc="$wait_n_rc"
        if [ -e "$RENEWAL_STOP_FILE" ] && [ "$renewal_rc" -eq 143 ]; then
          renewal_rc=0
        fi
        if [ "$renewal_rc" -ne 0 ]; then
          kill -TERM -- "-$command_pid" 2>/dev/null || true
        fi
        wait "$command_pid" || command_rc=$?
        break
        ;;
      *)
        return 127
        ;;
    esac
  done
  rm -rf "$RENEWAL_DIR"
  if [ "$command" = cleanup ] && (( command_rc == 0 && renewal_rc == 0 )); then
    bash infra/deploy-mutex.sh release aws-acts "$OWNER" || return $?
  fi
  if (( renewal_rc != 0 )); then
    return "$renewal_rc"
  fi
  return "$command_rc"
}

issue_health_credential() {
  require_env GITHUB_RUN_ID
  require_env T01_HEALTH_ATTESTATION
  require_env LIFETIME_MINUTES
  python3 infra/t01-smoke/health_credential.py
}

refresh_health_credential() {
  require_env GITHUB_RUN_ID
  require_env T01_HEALTH_ATTESTATION
  python3 infra/t01-smoke/health_credential.py refresh
}

issue_proxy_credential() {
  require_env GITHUB_RUN_ID
  require_env TEAMKIMI_PROXY_KEY
  python3 infra/t01-smoke/runtime.py create-proxy-secret
}

health_secret_arn() {
  aws secretsmanager describe-secret --secret-id "$HEALTH_SECRET_NAME" --query ARN --output text
}

deploy_stack() {
  local name
  for name in VPC_ID SUBNET_ID RESOLVER_IP AMI_ID GITHUB_REPOSITORY GITHUB_SHA; do
    require_env "$name"
  done
  if [ "$SCENARIO" = matrix ]; then
    require_env TEAMKIMI_PROXY_SECRET_ARN
  fi
  local script_sha runtime_sha runner_archive_url runner_archive_sha
  TEAMKIMI_SECRET_ARN="$(health_secret_arn)"
  script_sha="$(sha256sum infra/t01-smoke/provision.sh | cut -d' ' -f1)"
  runtime_sha="$(sha256sum infra/t01-smoke/runtime.py | cut -d' ' -f1)"
  runner_archive_url="https://codeload.github.com/$GITHUB_REPOSITORY/tar.gz/$GITHUB_SHA"
  runner_archive_sha="$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-redirs 0 --max-time 180 "$runner_archive_url" | sha256sum | cut -d' ' -f1)"
  aws cloudformation deploy \
    --stack-name "$STACK_NAME" \
    --template-file infra/t01-smoke/template.yaml \
    --capabilities CAPABILITY_NAMED_IAM \
    --parameter-overrides \
      "VpcId=$VPC_ID" \
      "SubnetId=$SUBNET_ID" \
      "ResolverIp=$RESOLVER_IP" \
      "AmiId=$AMI_ID" \
      "TeamKimiSecretArn=$TEAMKIMI_SECRET_ARN" \
      "TeamKimiProxySecretArn=${TEAMKIMI_PROXY_SECRET_ARN:-}" \
      "Scenario=$SCENARIO" \
      "Matrix=$MATRIX" \
      "PaidAdmission=$PAID_ADMISSION" \
      "TeamKimiHostId=${T01_TEAMKIMI_HOST_ID:-}" \
      "ExpectedPolicyHash=${EXPECTED_POLICY_HASH:-}" \
      "PricingAttestationBase64=$(printf '%s' "${PRICING_ATTESTATION:-}" | base64 -w0)" \
      "RunnerArchiveUrl=$runner_archive_url" \
      "RunnerArchiveSha256=$runner_archive_sha" \
      "MaxInputTokens=$MAX_INPUT_TOKENS" \
      "MaxOutputTokens=$MAX_OUTPUT_TOKENS" \
      "MaxReasoningTokens=$MAX_REASONING_TOKENS" \
      "MaxTotalTokens=$MAX_TOTAL_TOKENS" \
      "MaxApiCalls=$MAX_API_CALLS" \
      "MaxEstimatedCostUsd=$MAX_ESTIMATED_COST_USD" \
      "MaxPaidAdmissions=$MAX_PAID_ADMISSIONS" \
      "LifetimeMinutes=$LIFETIME_MINUTES" \
      "ProvisionScriptUrl=https://raw.githubusercontent.com/$GITHUB_REPOSITORY/$GITHUB_SHA/infra/t01-smoke/provision.sh" \
      "ProvisionScriptSha256=$script_sha" \
      "RuntimeScriptUrl=https://raw.githubusercontent.com/$GITHUB_REPOSITORY/$GITHUB_SHA/infra/t01-smoke/runtime.py" \
      "RuntimeScriptSha256=$runtime_sha" \
      "RunId=${GITHUB_RUN_ID:-0}"
}

collect_paid_evidence() {
  local candidate="$1" evidence_dir="$2" quarantine credential_id
  require_env PRICING_ATTESTATION
  require_env EXPECTED_POLICY_HASH
  require_env GITHUB_RUN_ID
  quarantine="$(mktemp -d)"
  trap "rm -rf $quarantine" RETURN
  aws s3 cp "s3://${T01_EVIDENCE_BUCKET:-hive-v2-t01-evidence-594552273052}/hive-v2-t01-smoke/$GITHUB_RUN_ID/" "$quarantine/export" --recursive
  credential_id="$(python3 infra/t01-smoke/runtime.py paid-export-credential "$candidate" "$quarantine/export/manifest.json")"
  python3 - "$quarantine/attestation.json" <<'PY'
import os
from pathlib import Path
import sys
Path(sys.argv[1]).write_text(os.environ['PRICING_ATTESTATION'], encoding='utf-8')
PY
  node dist-t01/tools/hermes-live/cli.js verify \
    --manifest "$quarantine/export/manifest.json" \
    --attestation "$quarantine/attestation.json" \
    --expected-policy-hash "$EXPECTED_POLICY_HASH" \
    --credential-id "$credential_id"
  mv "$quarantine/export" "$evidence_dir/export"
  export PAID_EVIDENCE_VERIFIED=yes
}

handle_evidence_candidate() {
  local console="$1" candidate="$2" evidence_dir="$3" line classification reason
  : > "$candidate"
  while IFS= read -r line; do
    case "$line" in
      T01_EVIDENCE\ *) printf '%s\n' "${line#T01_EVIDENCE }" >> "$candidate" ;;
    esac
  done < "$console"
  classification="$(python3 infra/t01-smoke/runtime.py classify-evidence "$candidate")"
  reason="$(python3 infra/t01-smoke/runtime.py evidence-rejection-reason "$candidate")"
  case "$classification" in
    passed)
      cp "$candidate" "$evidence_dir/preflight.jsonl"
      if [ "${SCENARIO:-preflight}" = matrix ]; then
        collect_paid_evidence "$candidate" "$evidence_dir"
      fi
      exit 0
      ;;
    failed)
      cp "$candidate" "$evidence_dir/preflight.jsonl"
      echo "preflight failed; reason=$reason; review only the sanitized artifact" >&2
      exit 1
      ;;
    incomplete)
      if [ -s "$candidate" ]; then
        cp "$candidate" "$evidence_dir/preflight.jsonl"
      fi
      ;;
    invalid)
      echo "console produced rejected evidence; reason=$reason; it was not copied to the artifact" >&2
      exit 1
      ;;
  esac
}

collect_evidence() {
  require_env LIFETIME_MINUTES
  local instance_id console console_error candidate evidence_dir rc reason
  instance_id="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue | [0]' --output text)"
  [ -n "$instance_id" ] && [ "$instance_id" != None ] || { echo "stack has no instance output" >&2; exit 1; }
  evidence_dir="${EVIDENCE_DIR:-$PWD/t01-evidence}"
  mkdir -p -m 0700 "$evidence_dir"
  console="$(mktemp)"
  console_error="$(mktemp)"
  candidate="$(mktemp)"
  trap "rm -f $console $console_error $candidate" EXIT
  for ((poll = 0; poll < LIFETIME_MINUTES * 2; poll++)); do
    if aws ec2 get-console-output --instance-id "$instance_id" --query Output --output text > "$console" 2>"$console_error"; then
      handle_evidence_candidate "$console" "$candidate" "$evidence_dir"
    else
      rc=$?
      if grep -qE 'ThrottlingException|RequestLimitExceeded|ServiceUnavailable|InternalError|RequestTimeout' "$console_error"; then
        sleep 30
        continue
      fi
      echo "get-console-output failed with an unrecoverable error" >&2
      exit "$rc"
    fi
    sleep 30
  done
  reason="$(python3 infra/t01-smoke/runtime.py evidence-rejection-reason "$candidate")"
  echo "preflight did not complete before the lifetime deadline; reason=$reason" >&2
  exit 1
}

delete_stack() {
  local stack_name="$1" describe_rc
  if aws cloudformation describe-stacks --stack-name "$stack_name" >"$CLEANUP_OUTPUT" 2>"$CLEANUP_ERROR"; then
    if grep -q '"StackStatus": "DELETE_COMPLETE"' "$CLEANUP_OUTPUT"; then
      return 0
    fi
    aws cloudformation delete-stack --stack-name "$stack_name" || return $?
    aws cloudformation wait stack-delete-complete --stack-name "$stack_name" || return $?
    return 0
  else
    describe_rc=$?
  fi
  if grep -q ValidationError "$CLEANUP_ERROR" && grep -q 'does not exist' "$CLEANUP_ERROR"; then
    return 0
  fi
  return "$describe_rc"
}

delete_run_secret() {
  local secret_name="$1" describe_rc poll
  if aws secretsmanager describe-secret --secret-id "$secret_name" >"$CLEANUP_OUTPUT" 2>"$CLEANUP_ERROR"; then
    aws secretsmanager delete-secret --secret-id "$secret_name" --force-delete-without-recovery \
      --query '{Name:Name,VersionId:VersionId,DeletionDate:DeletionDate}' --output json || return $?
    for ((poll = 0; poll < 10; poll++)); do
      if aws secretsmanager describe-secret --secret-id "$secret_name" >"$CLEANUP_OUTPUT" 2>"$CLEANUP_ERROR"; then
        sleep 1
      else
        describe_rc=$?
        if grep -q ResourceNotFoundException "$CLEANUP_ERROR"; then
          return 0
        fi
        return "$describe_rc"
      fi
    done
    echo "run secret still exists after deletion" >&2
    return 1
  else
    describe_rc=$?
  fi
  if grep -q ResourceNotFoundException "$CLEANUP_ERROR"; then
    return 0
  fi
  return "$describe_rc"
}

cleanup() {
  local status=0
  if [ "${SCENARIO:-preflight}" = matrix ] && [ "${PAID_EVIDENCE_VERIFIED:-no}" != yes ] \
      && [ "${T01_REVIEWED_UNCERTAIN_CLEANUP:-}" != yes ]; then
    echo "external paid evidence is not verified; retaining resources and the fleet mutex" >&2
    return 1
  fi
  CLEANUP_OUTPUT="$(mktemp)"
  CLEANUP_ERROR="$(mktemp)"
  trap "rm -f $CLEANUP_OUTPUT $CLEANUP_ERROR" EXIT
  if [ "${SCENARIO:-preflight}" = matrix ] && [ "${PAID_EVIDENCE_VERIFIED:-no}" = yes ]; then
    require_env GITHUB_RUN_ID
    aws s3 rm "s3://${T01_EVIDENCE_BUCKET:-hive-v2-t01-evidence-594552273052}/hive-v2-t01-smoke/$GITHUB_RUN_ID/" --recursive || status=$?
  fi
  if (( status == 0 )); then
    delete_stack "$STACK_NAME" || status=$?
  fi
  if (( status == 0 )); then
    delete_run_secret "$HEALTH_SECRET_NAME" || status=$?
  fi
  if (( status == 0 )) && [ "${SCENARIO:-preflight}" = matrix ]; then
    delete_run_secret "$PROXY_SECRET_NAME" || status=$?
  fi
  if (( status == 0 )) && [ "${SCENARIO:-preflight}" != preflight ] && [ "${T01_REVIEWED_UNCERTAIN_CLEANUP:-}" != yes ]; then
    if ! python3 infra/t01-smoke/runtime.py validate-evidence "${EVIDENCE_DIR:-$PWD/t01-evidence}/preflight.jsonl"; then
      echo "paid evidence is incomplete or uncertain; retaining the fleet mutex" >&2
      status=1
    fi
  fi
  if (( status == 0 )) && [ "${SCENARIO:-preflight}" = count ] && [ "${T01_COUNT_STOP_VERIFIED:-no}" != yes ]; then
    echo "count host stop is not proven; retaining the fleet mutex and run state" >&2
    status=1
  fi
  return "$status"
}

count_host() {
  [ "${SCENARIO:-}" = count ] || return 2
  bash infra/t01-smoke/count-host.sh "$1"
}

case "${1:-}" in
  validate-inputs) validate_inputs ;;
  acquire) acquire_mutex ;;
  count-start) with_mutex_renewal count_host start ;;
  count-stop) with_mutex_renewal count_host stop ;;
  issue-health-credential) with_mutex_renewal issue_health_credential ;;
  refresh-health-credential) with_mutex_renewal refresh_health_credential ;;
  issue-proxy-credential) with_mutex_renewal issue_proxy_credential ;;
  deploy) with_mutex_renewal deploy_stack ;;
  collect) with_mutex_renewal collect_evidence ;;
  cleanup) with_mutex_renewal cleanup ;;
  *) echo "usage: $0 validate-inputs|acquire|count-start|count-stop|issue-health-credential|refresh-health-credential|issue-proxy-credential|deploy|collect|cleanup" >&2; exit 2 ;;
esac
