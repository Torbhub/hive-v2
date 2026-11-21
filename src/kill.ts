import { killWindow, paneExists, type PaneIdentity } from './tmux.js';
import {
  appendDecision, clearPendingPane, compareAndSwapTeamEntry, readProjects, readTeam, Refusal, withTeamLock,
} from './state.js';
import type { TeamEntry } from './types.js';
import { revokeTmuxAdmission } from './admission.js';
import { releasePendingLaunchClaim } from './project.js';

export function recordedIdentity(entry: TeamEntry): PaneIdentity {
  if (!entry.pane || !entry.pane_pid || !entry.pane_started) {
    throw new Refusal(
      `${entry.name} has no recorded pane identity; refusing to kill ${entry.pane ?? 'it'} — close the window by hand on the hive socket`,
    );
  }
  return { pid: entry.pane_pid, started: entry.pane_started };
}

async function stampEntry(
  root: string, home: string, entry: TeamEntry, closed_at: string | undefined,
): Promise<TeamEntry | null> {
  const stamped = await compareAndSwapTeamEntry(home, entry, {
    closed_at,
    ...(closed_at && entry.task ? { lease_revoked: true, admission_status: 'revoked' as const } : {}),
  });
  if (!stamped) return null;
  if (closed_at && entry.task) {
    await revokeTmuxAdmission(root, home, stamped);
    if (stamped.lease_id === undefined) return stamped;
    return (await readTeam(home)).agents.find((candidate) => candidate.lease_id === stamped.lease_id) ?? null;
  }
  return stamped;
}

async function dropEntry(home: string, entry: TeamEntry): Promise<boolean> {
  return await compareAndSwapTeamEntry(home, entry, null) === null;
}

async function killPane(entry: TeamEntry): Promise<void> {
  if (!entry.pane || !(await paneExists(entry.pane))) return;
  try {
    await killWindow(entry.pane, recordedIdentity(entry));
  } catch (e) {
    throw e instanceof Refusal ? e : new Refusal(e instanceof Error ? e.message : String(e));
  }
}

export async function assertEntryAlive(
  home: string,
  entry: TeamEntry,
  launched: { pane: string; identity: PaneIdentity },
  { allowStamped = false, cleanup = true }: { allowStamped?: boolean; cleanup?: boolean } = {},
): Promise<void> {
  const alive = await withTeamLock(home, async () => {
    const fresh = (await readTeam(home)).agents.find(
      (a) => a.name === entry.name && (entry.worktree === undefined || a.worktree === entry.worktree),
    );
    return Boolean(fresh) && (allowStamped || !fresh!.closed_at);
  });
  if (alive) return;
  if (cleanup) await killWindow(launched.pane, launched.identity).catch(() => {});
  throw new Refusal(`${entry.name} was killed while its new pane came up — the pane was taken down too`);
}

export async function killEntry(root: string, home: string, entry: TeamEntry): Promise<boolean> {
  const stamped = await stampEntry(root, home, entry, new Date().toISOString());
  if (!stamped) return false;
  try {
    await killPane(stamped);
  } catch (error) {
    await stampEntry(root, home, stamped, undefined);
    throw error;
  }
  await releasePendingLaunchClaim(root, stamped);
  return dropEntry(home, stamped);
}

export function cascadeTargets(team: { agents: TeamEntry[] }): TeamEntry[] {
  const orch = team.agents.find((a) => a.orchestrator);
  if (!orch) return [];
  return [...team.agents.filter((a) => !a.orchestrator && a.parent === orch.name), orch];
}

async function projectHome(root: string, project: string): Promise<string> {
  const p = (await readProjects(root)).projects.find((x) => x.name === project);
  if (!p) throw new Refusal(`unknown project: ${project}`);
  return p.home;
}

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

async function killCascade(root: string, project: string): Promise<{ target: string; killed: string[] }> {
  const home = await projectHome(root, project);
  const planned = cascadeTargets(await readTeam(home));
  if (planned.length === 0) throw new Refusal(`${project} has no orchestrator in team.json`);
  for (const entry of planned) {
    if (entry.pane && (await paneExists(entry.pane))) recordedIdentity(entry);
  }
  const targets: TeamEntry[] = [];
  for (const entry of planned) {
    const stamped = await stampEntry(root, home, entry, new Date().toISOString());
    if (stamped) targets.push(stamped);
  }
  const target = planned[planned.length - 1].name;
  const done: TeamEntry[] = [];
  try {
    for (const entry of targets) {
      await killPane(entry);
      await releasePendingLaunchClaim(root, entry);
      if (await dropEntry(home, entry)) done.push(entry);
    }
  } catch (e) {
    const survivors = targets.filter((entry) => !done.includes(entry));
    for (const entry of survivors) await stampEntry(root, home, entry, undefined);
    try {
      await appendDecision(root, {
        project, by: 'owner',
        summary: `killed ${done.length ? done.map((t) => t.name).join(', ') : 'nothing'} of the ${target} cascade before ${e instanceof Error ? e.message : String(e)}; not killed: ${survivors.map((t) => t.name).join(', ')}`,
      });
    } catch (le) {
      console.error(`hive: the decision was not logged: ${le instanceof Error ? le.message : le}`);
    }
    throw e;
  }
  await clearPendingPane(root, project);
  return { target, killed: done.map((t) => t.name) };
}

function summaryOf(target: string, killed: string[]): string {
  if (killed.length === 0) return 'nothing died — a respawn re-identified every entry mid-kill';
  const extra = killed.length - 1;
  return `killed ${killed[killed.length - 1]}${extra > 0 ? ` + ${extra} agent${extra === 1 ? '' : 's'}` : ''}`;
}

export async function killAgent(
  root: string,
  project: string,
  agentRef?: string,
): Promise<{ target: string; killed: string[]; summary: string }> {
  let target: string;
  let killed: string[];
  if (agentRef) {
    const home = await projectHome(root, project);
    const entry = resolveAgent(await readTeam(home), project, agentRef);
    target = entry.name;
    killed = (await killEntry(root, home, entry)) ? [entry.name] : [];
  } else {
    ({ target, killed } = await killCascade(root, project));
  }
  const summary = summaryOf(target, killed);
  if (killed.length > 0) {
    try {
      await appendDecision(root, { project, by: 'owner', summary });
    } catch (e) {
      console.error(`hive: the decision was not logged: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { target, killed, summary };
}

export async function killLine(root: string, project: string, agentRef?: string): Promise<string> {
  const r = await killAgent(root, project, agentRef);
  return `hive: ${summaryOf(r.target, r.killed)}`;
}
