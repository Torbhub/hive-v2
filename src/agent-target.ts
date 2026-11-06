import { AuthorizationError } from './security.js';
import { readProjects, readTeam } from './state.js';

export async function storedAgentTask(root: string, project: string, agentRef: unknown): Promise<string | undefined> {
  const registration = (await readProjects(root)).projects.find((candidate) => candidate.name === project);
  if (!registration) throw new AuthorizationError('not found');
  const team = await readTeam(registration.home);
  const ref = agentRef === undefined || agentRef === '' ? undefined : String(agentRef);
  const [name, worktree] = ref?.split('@') ?? [];
  const candidates = name
    ? team.agents.filter((agent) => !agent.orchestrator && agent.name === name)
    : team.agents.filter((agent) => agent.orchestrator);
  const entry = worktree
    ? candidates.find((agent) => agent.worktree === worktree)
    : candidates.length === 1 ? candidates[0] : undefined;
  if (!entry) throw new AuthorizationError('not found');
  return entry.task;
}
