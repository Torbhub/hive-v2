import { readProjects, Refusal, withHubLock, writeProjects } from './state.js';

export class RolloutPaused extends Error {
  constructor(project: string) {
    super(`rollout paused for ${project}`);
    this.name = 'RolloutPaused';
  }
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function pauseMarker(project: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    throw new RolloutPaused(project);
  }
  return value;
}

export async function assertExecutionAllowed(root: string, project: string): Promise<void> {
  if (process.env.HIVE_COLLABORATION_ENABLED !== '1') return;
  try {
    const current = (await readProjects(root)).projects.find((candidate) => candidate.name === project);
    if (!current || pauseMarker(project, current.collaboration_execution_disabled_at) !== undefined) {
      throw new RolloutPaused(project);
    }
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
    const existing = pauseMarker(project, current.collaboration_execution_disabled_at);
    if (existing !== undefined) return existing;
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
  return pauseMarker(project, current.collaboration_execution_disabled_at);
}

export async function executionLine(root: string, project: string, action: 'off' | 'status'): Promise<string> {
  const disabledAt = action === 'off'
    ? await disableExecution(root, project)
    : await executionDisabledAt(root, project);
  return disabledAt
    ? `hive: ${project} execution disabled at ${disabledAt}`
    : `hive: ${project} execution enabled`;
}
