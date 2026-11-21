const REDACTIONS: [RegExp, string][] = [
  [/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*=)[^\s`"']+/g, '$1[redacted]'],
  [/\b((?:password|passwd|passphrase|secret|token|api[-_ ]?key)\s*(?:[:=]|is)\s*[`"']?)[^\s`"']+/gi, '$1[redacted]'],
  [/(\/\s*`)[^\s`]{6,}(`)/g, '$1[redacted]$2'],
];

export function redact(text: string): string {
  return REDACTIONS.reduce((t, [re, to]) => t.replace(re, to), text);
}
