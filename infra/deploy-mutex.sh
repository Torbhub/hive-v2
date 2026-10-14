#!/usr/bin/env bash
# deploy-mutex.sh — the fleet deploy mutex (deploy-discipline skill).
#
# One DynamoDB table, citadel-deploy-mutex (us-east-1, the nexus stack owns
# it). Any AWS act outside a stack deploy holds the mutex first.
#
# acquire blocks up to DEPLOY_MUTEX_WAIT_SECONDS (default 600) and exits 1
# naming the holder when the lock stays taken. release frees the lock, and
# releasing a lock the caller does not hold is a safe no-op. A crashed
# holder's row expires after 25 min (ttl). A later acquire then steals it.
# Never delete a row by hand to unstick it.
set -euo pipefail

TABLE="${DEPLOY_MUTEX_TABLE:-citadel-deploy-mutex}"
REGION="${AWS_REGION:-us-east-1}"
TTL_SECONDS=1500
WAIT_SECONDS="${DEPLOY_MUTEX_WAIT_SECONDS:-600}"
SLEEP_SECONDS="${DEPLOY_MUTEX_SLEEP_SECONDS:-10}"

cmd="${1:-}"
resource="${2:-}"
owner="${3:-}"

die_usage() {
  echo "usage: deploy-mutex.sh acquire|release <resource> <owner>" >&2
  exit 2
}

[ -n "$cmd" ] && [ -n "$resource" ] && [ -n "$owner" ] || die_usage
case "$resource$owner" in
  *[!a-zA-Z0-9._/-]*)
    echo "resource and owner take letters, digits, dot, dash, slash, underscore" >&2
    exit 2
    ;;
esac

_ddb() { aws dynamodb "$@" --table-name "$TABLE" --region "$REGION"; }
_key() { printf '{"resource":{"S":"%s"}}' "$resource"; }

case "$cmd" in
  acquire)
    deadline=$(( $(date +%s) + WAIT_SECONDS ))
    err_file=$(mktemp)
    trap 'rm -f "$err_file"' EXIT
    while :; do
      now=$(date +%s)
      if _ddb put-item \
          --item "$(printf '{"resource":{"S":"%s"},"owner":{"S":"%s"},"ttl":{"N":"%s"}}' \
              "$resource" "$owner" "$(( now + TTL_SECONDS ))")" \
          --condition-expression "attribute_not_exists(#r) OR #t < :now" \
          --expression-attribute-names '{"#r":"resource","#t":"ttl"}' \
          --expression-attribute-values "$(printf '{":now":{"N":"%s"}}' "$now")" \
          2>"$err_file"; then
        echo "acquired $TABLE/$resource (owner $owner)"
        exit 0
      fi
      if ! grep -q ConditionalCheckFailedException "$err_file"; then
        # Not contention: a missing table, AccessDenied, or a bad call.
        # Fail closed at once, do not retry.
        cat "$err_file" >&2
        exit 1
      fi
      if [ "$now" -ge "$deadline" ]; then
        holder=$(_ddb get-item --key "$(_key)" \
          --query 'Item.owner.S' --output text 2>/dev/null || echo unknown)
        # The holder released between the last put and this get: the row is
        # gone and the query prints None. The next acquire succeeds.
        [ "$holder" = "None" ] && holder=unknown
        echo "mutex $TABLE/$resource held by $holder after ${WAIT_SECONDS}s" >&2
        exit 1
      fi
      sleep "$SLEEP_SECONDS"
    done
    ;;
  release)
    _ddb delete-item \
      --key "$(_key)" \
      --condition-expression "#o = :me" \
      --expression-attribute-names '{"#o":"owner"}' \
      --expression-attribute-values "$(printf '{":me":{"S":"%s"}}' "$owner")" \
      2>/dev/null || true
    exit 0
    ;;
  *)
    die_usage
    ;;
esac
