#!/usr/bin/env bash
# Tag HEAD and push the tag before a retro-driven edit of roles/rules/skills lands.
# Rollback: rm -rf roles rules skills && git checkout <tag> -- roles rules skills
set -euo pipefail
note="${1:-}"
cd "$(git rev-parse --show-toplevel)"
tag="cp-$(date -u +%F)"
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  tag="cp-$(date -u +%F-%H%M%S)"
  git rev-parse -q --verify "refs/tags/$tag" >/dev/null && { echo "tag collision: $tag" >&2; exit 1; }
fi
git tag -a "$tag" -m "${note:-checkpoint $tag}"
git push -q origin "refs/tags/$tag"
echo "$tag"
