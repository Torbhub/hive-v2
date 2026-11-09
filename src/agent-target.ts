import { AuthorizationError } from './security.js';
import { RolloutPaused } from './rollout.js';
import { readProjects, readTeam, type ProjectsFile } from './state.js';

export async function storedAgentTask(
  root: string, project: string, agentRef: unknown, pauseOnConfigFailure = false,
): Promise<string | undefined> {
  let pf: ProjectsFile;
  try {
    pf = await readProjects(root);
  } catch (error) {
    if (pauseOnConfigFailure) throw new RolloutPaused(project);
    throw error;
  }
  const registration = pf.projects.find((candidate) => candidate.name === project);
  if (!registration) {
    if (pauseOnConfigFailure) throw new RolloutPaused(project);
    throw new AuthorizationError('not found');
  }
  const team = await readTeam(registration.home);
  const ref = agentRef === undefined || agentRef === '' ? undefined : String(agentRef);
  const [name, worktree] = ref?.split('@') ?? [];
  const candidates = name
    ? team.agents.filter((agent) => agent.name === name)
    : team.agents.filter((agent) => agent.orchestrator);
  const entry = worktree
    ? candidates.find((agent) => agent.worktree === worktree)
    : candidates.length === 1 ? candidates[0] : undefined;
  if (!entry) throw new AuthorizationError('not found');
  return entry.task;
}
