#!/usr/bin/env bash
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
  echo "usage: deploy-mutex.sh acquire|renew|release <resource> <owner>" >&2
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
        cat "$err_file" >&2
        exit 1
      fi
      if [ "$now" -ge "$deadline" ]; then
        holder=$(_ddb get-item --key "$(_key)" \
          --query 'Item.owner.S' --output text 2>/dev/null || echo unknown)
        [ "$holder" = "None" ] && holder=unknown
        echo "mutex $TABLE/$resource held by $holder after ${WAIT_SECONDS}s" >&2
        exit 1
      fi
      sleep "$SLEEP_SECONDS"
    done
    ;;
  renew)
    now=$(date +%s)
    _ddb update-item \
      --key "$(_key)" \
      --update-expression 'SET #t = :ttl' \
      --condition-expression '#o = :me' \
      --expression-attribute-names '{"#o":"owner","#t":"ttl"}' \
      --expression-attribute-values "$(printf '{":me":{"S":"%s"},":ttl":{"N":"%s"}}' "$owner" "$(( now + TTL_SECONDS ))")"
    echo "renewed $TABLE/$resource (owner $owner)"
    ;;
  release)
    err_file=$(mktemp)
    trap 'rm -f "$err_file"' EXIT
    if _ddb delete-item \
        --key "$(_key)" \
        --condition-expression "#o = :me" \
        --expression-attribute-names '{"#o":"owner"}' \
        --expression-attribute-values "$(printf '{":me":{"S":"%s"}}' "$owner")" \
        2>"$err_file"; then
      exit 0
    else
      rc=$?
    fi
    if grep -q ConditionalCheckFailedException "$err_file"; then
      exit 0
    fi
    cat "$err_file" >&2
    exit "$rc"
    ;;
  *)
    die_usage
    ;;
esac
