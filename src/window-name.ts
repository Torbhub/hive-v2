export function withoutPaneIds(text: string): string {
  return text.replace(/%\d+\b/g, '?');
}

export function displayText(text: string): string {
  const commandAt = text.indexOf('for: $');
  if (commandAt === -1) return withoutPaneIds(text);
  const prefix = withoutPaneIds(text.slice(0, commandAt));
  const command = text.slice(commandAt).replace(/(-t\s+['"]?)%\d+\b/g, '$1?');
  return prefix + command;
}

export function orchestratorName(project: string): string {
  return `${project}-orchestrator`;
}

export function windowName(project: string, agent: string): string {
  return `${project}:${agent}`;
}
