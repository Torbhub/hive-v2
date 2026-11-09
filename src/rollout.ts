import { readProjects, Refusal, withHubLock, writeProjects } from './state.js';

export class RolloutPaused extends Error {
  constructor(project: string) {
    super(`rollout paused for ${project}`);
    this.name = 'RolloutPaused';
  }
}

export async function assertExecutionAllowed(root: string, project: string): Promise<void> {
  if (process.env.HIVE_COLLABORATION_ENABLED !== '1') return;
  try {
    const current = (await readProjects(root)).projects.find((candidate) => candidate.name === project);
    if (!current || current.collaboration_execution_disabled_at !== undefined) throw new RolloutPaused(project);
  } catch (error) {
    if (error instanceof RolloutPaused) throw error;
    throw new RolloutPaused(project);
  }
}

export async function disableExecution(root: string, project: string): Promise<string> {
  return withHubLock(root, async () => {
    const pf = await readProjects(root);
    const current = pf.projects.find((candidate) => candidate.name === project);
    if (!current) throw new Refusal(`unknown project: ${project}`);
    if (current.collaboration_execution_disabled_at !== undefined) return current.collaboration_execution_disabled_at;
    const disabledAt = new Date().toISOString();
    await writeProjects(root, {
      ...pf,
      projects: pf.projects.map((candidate) => candidate.name === project
        ? { ...candidate, collaboration_execution_disabled_at: disabledAt }
        : candidate),
    });
    return disabledAt;
  });
}

export async function executionDisabledAt(root: string, project: string): Promise<string | undefined> {
  const pf = await readProjects(root);
  const current = pf.projects.find((candidate) => candidate.name === project);
  if (!current) throw new Refusal(`unknown project: ${project}`);
  return current.collaboration_execution_disabled_at;
}

export async function executionLine(root: string, project: string, action: 'off' | 'status'): Promise<string> {
  const disabledAt = action === 'off'
    ? await disableExecution(root, project)
    : await executionDisabledAt(root, project);
  return disabledAt
    ? `hive: ${project} execution disabled at ${disabledAt}`
    : `hive: ${project} execution enabled`;
}
