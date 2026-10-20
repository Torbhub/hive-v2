sed -i 's|^export const NAME_RE = .*|export const NAME_RE = /^[a-z0-9][a-z0-9/-]*$/i;|' src/names.ts
grep -q 'a-z0-9/' src/names.ts || { echo 'setup drifted: names-traversal' >&2; exit 1; }
