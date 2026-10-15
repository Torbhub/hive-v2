// Skims compress real replies, and real replies can carry secrets verbatim — the bench samples
// agent sessions, which share credentials in plain text. redact() strips the common shapes before
// a skim is stored. It errs toward over-masking.
const REDACTIONS: [RegExp, string][] = [
  // env-style: GITHUB_TOKEN=..., AWS_SECRET_ACCESS_KEY=...
  [/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*=)[^\s`"']+/g, '$1[redacted]'],
  // prose: password: ..., password = ..., token is `...`
  [/\b((?:password|passwd|passphrase|secret|token|api[-_ ]?key)\s*(?:[:=]|is)\s*[`"']?)[^\s`"']+/gi, '$1[redacted]'],
  // basic-auth shares: user / `password`
  [/(\/\s*`)[^\s`]{6,}(`)/g, '$1[redacted]$2'],
];

export function redact(text: string): string {
  return REDACTIONS.reduce((t, [re, to]) => t.replace(re, to), text);
}
