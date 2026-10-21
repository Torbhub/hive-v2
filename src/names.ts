// Project and agent names end up in tmux window names and filesystem paths;
// this shape can never be read as tmux target syntax or a path traversal.
export const NAME_RE = /^[a-z0-9][a-z0-9-]*$/i;

// Registering a project is stricter. hubAdd and the web add share this rule;
// do not merge it with the looser NAME_RE above.
export const PROJECT_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

export function checkName(kind: string, value: string): string {
  if (!NAME_RE.test(value)) {
    throw new Error(`a ${kind} name is letters, digits and '-', and starts with a letter or digit: ${value}`);
  }
  return value;
}
