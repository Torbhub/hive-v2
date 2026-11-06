#!/usr/bin/env bash
set -euo pipefail
umask 077

STACK_NAME=hive-v2-t01-smoke
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
  [ "$SCENARIO" = preflight ] || { echo "only the preflight scenario is available" >&2; exit 2; }
  [ "$MATRIX" = none ] || { echo "the paid matrix is not available" >&2; exit 2; }
  [ "$PAID_ADMISSION" = false ] || { echo "paid admission requires the separate TeamKimi broker PR" >&2; exit 2; }
  validate_integer_cap MAX_INPUT_TOKENS 16000
  validate_integer_cap MAX_OUTPUT_TOKENS 2000
  validate_integer_cap MAX_REASONING_TOKENS 4000
  validate_integer_cap MAX_TOTAL_TOKENS 22000
  validate_integer_cap MAX_API_CALLS 1
  validate_integer_cap MAX_PAID_ADMISSIONS 0
  require_env MAX_ESTIMATED_COST_USD
  python3 - "$MAX_ESTIMATED_COST_USD" <<'PY'
from decimal import Decimal, InvalidOperation
import sys
try:
    value = Decimal(sys.argv[1])
except InvalidOperation:
    raise SystemExit("cost cap must be numeric")
if value < 0 or value > Decimal("0.50"):
    raise SystemExit("cost cap must be from 0 to 0.50")
PY
  validate_integer_cap LIFETIME_MINUTES 120
  (( LIFETIME_MINUTES >= 5 )) || { echo "lifetime must be at least five minutes" >&2; exit 2; }
}

acquire_mutex() {
  bash infra/deploy-mutex.sh acquire aws-acts "$OWNER"
}

deploy_stack() {
  local name
  for name in VPC_ID SUBNET_ID AMI_ID TEAMKIMI_URL TEAMKIMI_SECRET_ARN TEAMKIMI_SECRET_KEY TEAMKIMI_CONNECTIVITY_PATH GITHUB_REPOSITORY GITHUB_SHA; do
    require_env "$name"
  done
  local script_sha runtime_sha
  script_sha="$(sha256sum infra/t01-smoke/provision.sh | cut -d' ' -f1)"
  runtime_sha="$(sha256sum infra/t01-smoke/runtime.py | cut -d' ' -f1)"
  aws cloudformation deploy \
    --stack-name "$STACK_NAME" \
    --template-file infra/t01-smoke/template.yaml \
    --capabilities CAPABILITY_NAMED_IAM \
    --parameter-overrides \
      "VpcId=$VPC_ID" \
      "SubnetId=$SUBNET_ID" \
      "AmiId=$AMI_ID" \
      "TeamKimiUrl=$TEAMKIMI_URL" \
      "TeamKimiSecretArn=$TEAMKIMI_SECRET_ARN" \
      "TeamKimiSecretKey=$TEAMKIMI_SECRET_KEY" \
      "TeamKimiConnectivityPath=$TEAMKIMI_CONNECTIVITY_PATH" \
      "Scenario=$SCENARIO" \
      "Matrix=$MATRIX" \
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

collect_evidence() {
  require_env LIFETIME_MINUTES
  local instance_id console candidate evidence_dir now next_renewal=0
  instance_id="$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
    --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue | [0]' --output text)"
  [ -n "$instance_id" ] && [ "$instance_id" != None ] || { echo "stack has no instance output" >&2; exit 1; }
  evidence_dir="${EVIDENCE_DIR:-$PWD/t01-evidence}"
  mkdir -p -m 0700 "$evidence_dir"
  console="$(mktemp)"
  candidate="$(mktemp)"
  trap "rm -f $console $candidate" EXIT
  : > "$evidence_dir/preflight.jsonl"
  for ((poll = 0; poll < LIFETIME_MINUTES * 2; poll++)); do
    now="$(date +%s)"
    if (( now >= next_renewal )); then
      bash infra/deploy-mutex.sh renew aws-acts "$OWNER" || exit $?
      next_renewal=$(( now + 600 ))
    fi
    if aws ec2 get-console-output --instance-id "$instance_id" --query Output --output text > "$console"; then
      : > "$candidate"
      while IFS= read -r line; do
        case "$line" in
          T01_EVIDENCE\ *) printf '%s\n' "${line#T01_EVIDENCE }" >> "$candidate" ;;
        esac
      done < "$console"
      if [ -s "$candidate" ]; then
        cp "$candidate" "$evidence_dir/preflight.jsonl"
      fi
      if grep -q '"check":"complete"' "$candidate"; then
        if python3 infra/t01-smoke/runtime.py validate-evidence "$candidate"; then
          exit 0
        fi
        echo "preflight failed or mandatory evidence is missing; review only the sanitized artifact" >&2
        exit 1
      fi
    fi
    sleep 30
  done
  echo "preflight did not complete before the lifetime deadline" >&2
  exit 1
}

cleanup() {
  local status=0 describe_rc release_rc=0 stack_exists describe_output describe_error
  describe_output="$(mktemp)"
  describe_error="$(mktemp)"
  trap "rm -f $describe_output $describe_error" EXIT
  if aws cloudformation describe-stacks --stack-name "$STACK_NAME" >"$describe_output" 2>"$describe_error"; then
    stack_exists=true
  else
    describe_rc=$?
    stack_exists=false
    if ! grep -q ValidationError "$describe_error" || ! grep -q 'does not exist' "$describe_error"; then
      status=$describe_rc
    fi
  fi
  if [ "$stack_exists" = true ]; then
    aws cloudformation delete-stack --stack-name "$STACK_NAME" || status=$?
    if (( status == 0 )); then
      aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" || status=$?
    fi
  fi
  bash infra/deploy-mutex.sh release aws-acts "$OWNER" || release_rc=$?
  if (( status == 0 && release_rc != 0 )); then
    status=$release_rc
  fi
  return "$status"
}

case "${1:-}" in
  validate-inputs) validate_inputs ;;
  acquire) acquire_mutex ;;
  deploy) deploy_stack ;;
  collect) collect_evidence ;;
  cleanup) cleanup ;;
  *) echo "usage: $0 validate-inputs|acquire|deploy|collect|cleanup" >&2; exit 2 ;;
esac
