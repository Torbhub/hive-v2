#!/usr/bin/env bash
# deploy-mutex.sh — the fleet deploy lock (docs/runbooks/deploy-mutex.md).
# One DynamoDB row per deployable resource. acquire takes the row with a
# conditional write. release deletes it on an owner match. A crashed holder's
# row expires via the table TTL, and the next acquirer steals it.
#
# Env: DEPLOY_MUTEX_TABLE (default citadel-deploy-mutex), AWS_REGION
# (default us-east-1).
set -euo pipefail

TABLE="${DEPLOY_MUTEX_TABLE:-citadel-deploy-mutex}"
REGION="${AWS_REGION:-us-east-1}"

usage() {
  echo "usage: deploy-mutex.sh acquire <resource> <owner> [ttl_seconds] [wait_seconds]" >&2
  echo "       deploy-mutex.sh release <resource> <owner>" >&2
  exit 2
}

# One clean line per outcome. AWS error dumps never reach the caller.
acquire() {
  local resource="$1" owner="$2" ttl="${3:-1500}" wait="${4:-600}"
  local now acquired_at deadline holder
  deadline=$((SECONDS + wait))
  while true; do
    now=$(date +%s)
    acquired_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    if aws dynamodb put-item --region "$REGION" --table-name "$TABLE" \
      --item "{\"resource\": {\"S\": \"$resource\"}, \"owner\": {\"S\": \"$owner\"}, \"expires_at\": {\"N\": \"$((now + ttl))\"}, \"acquired_at\": {\"S\": \"$acquired_at\"}}" \
      --condition-expression "attribute_not_exists(resource) OR expires_at < :now" \
      --expression-attribute-values "{\":now\": {\"N\": \"$now\"}}" \
      --output text >/dev/null 2>&1; then
      echo "acquired $resource"
      return 0
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      holder=$(aws dynamodb get-item --region "$REGION" --table-name "$TABLE" \
        --key "{\"resource\": {\"S\": \"$resource\"}}" \
        --query 'Item.[owner.S, acquired_at.S]' --output text 2>/dev/null || true)
      if [ -n "$holder" ] && [ "$holder" != "None	None" ]; then
        echo "mutex held by $(echo "$holder" | cut -f1) since $(echo "$holder" | cut -f2)" >&2
      else
        echo "mutex $resource unavailable" >&2
      fi
      return 1
    fi
    sleep 10
  done
}

# A release never fails a workflow's cleanup: a stolen or expired row warns
# and exits 0.
release() {
  local resource="$1" owner="$2"
  if aws dynamodb delete-item --region "$REGION" --table-name "$TABLE" \
    --key "{\"resource\": {\"S\": \"$resource\"}}" \
    --condition-expression "owner = :owner" \
    --expression-attribute-values "{\":owner\": {\"S\": \"$owner\"}}" \
    --output text >/dev/null 2>&1; then
    echo "released $resource"
  else
    echo "release $resource: not held by $owner (stolen or expired) — nothing to do" >&2
  fi
  return 0
}

[ $# -ge 3 ] || usage
cmd="$1"
[ "$cmd" = "acquire" ] || [ "$cmd" = "release" ] || usage
shift
case "$cmd" in
  acquire) acquire "$@" ;;
  release) release "$@" ;;
esac
