sed -i 's|^export const NAME_RE = .*|export const NAME_RE = /^[a-z0-9][a-z0-9/-]*$/i;|' src/names.ts
