import { orchestratorName } from './spawn.js';
import { appendDecision, readPendingPane, readProjects, readTeam, Refusal } from './state.js';
import { paneExists, paneIdentity, paneIs, sendEscape, type PaneIdentity } from './tmux.js';
import type { TeamEntry } from './types.js';

// Same rules as a dialog read: a bare name that matches two agents is an
// error, never a guess.
function resolveAgent(team: { agents: TeamEntry[] }, project: string, ref: string): TeamEntry {
  const [name, wt] = ref.split('@', 2);
  const matches = team.agents.filter((a) => !a.orchestrator && a.name === name);
  const entry = wt
    ? matches.find((a) => a.worktree === wt)
    : matches.length === 1 ? matches[0] : undefined;
  if (!wt && matches.length > 1) {
    throw new Refusal(`${project} has ${matches.length} agents named ${name}; say which: ${name}@<worktree>`);
  }
  if (!entry) throw new Refusal(`${project} has no agent named ${ref}`);
  return entry;
}

// Escape to a live pane: a running turn stops mid-turn and the session
// survives, so the owner can steer the agent after. The pane identity is
// verified before the key lands, like every hive mutation.
export async function interruptAgent(
  root: string,
  project: string,
  agentRef?: string,
): Promise<{ target: string; pane: string }> {
  const pf = await readProjects(root);
  const p = pf.projects.find((x) => x.name === project);
  if (!p) throw new Refusal(`unknown project: ${project}`);
  const team = await readTeam(p.home);

  let entry: TeamEntry | undefined;
  let target: string;
  if (agentRef) {
    entry = resolveAgent(team, project, agentRef);
    target = agentRef;
  } else {
    target = orchestratorName(project);
    entry = team.agents.find((a) => a.orchestrator);
    // A starting orchestrator not yet registered still owns its pending pane.
    if (!entry?.pane) {
      const pending = await readPendingPane(root, project);
      if (pending) entry = { name: target, pane: pending.pane };
    }
  }
  if (!entry?.pane || !(await paneExists(entry.pane))) {
    throw new Refusal(`${target} has no live pane`);
  }
  const pane = entry.pane;
  const recorded: PaneIdentity | null = entry.pane_pid && entry.pane_started
    ? { pid: entry.pane_pid, started: entry.pane_started }
    : null;
  const identity = recorded ?? (await paneIdentity(pane));
  if (!identity || !(await paneIs(pane, identity))) {
    throw new Refusal(`${target}'s pane is no longer the recorded session`);
  }
  await sendEscape(pane, identity);
  try {
    await appendDecision(root, { project, by: 'owner', summary: `interrupted ${target}` });
  } catch (e) {
    console.error(`hive: the decision was not logged: ${e instanceof Error ? e.message : e}`);
  }
  return { target, pane };
}

export async function interruptLine(root: string, project: string, agentRef?: string): Promise<string> {
  const r = await interruptAgent(root, project, agentRef);
  return `hive: interrupted ${r.target} (pane ${r.pane})`;
}
