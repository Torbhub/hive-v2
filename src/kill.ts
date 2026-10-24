import { killWindow, paneExists, type PaneIdentity } from './tmux.js';
import {
  appendDecision, clearPendingPane, hivePath, readProjects, readTeam,
  Refusal, withTeamLock, writeJson,
} from './state.js';
import type { TeamEntry } from './types.js';

export function recordedIdentity(entry: TeamEntry): PaneIdentity {
  if (!entry.pane || !entry.pane_pid || !entry.pane_started) {
    throw new Refusal(
      `${entry.name} has no recorded pane identity; refusing to kill ${entry.pane ?? 'it'} — close the window by hand on the hive socket`,
    );
  }
  return { pid: entry.pane_pid, started: entry.pane_started };
}

// team.json helpers here match name AND worktree: upsert/remove by bare name
// would hit a same-named twin in another worktree.
const sameEntry = (a: TeamEntry, b: TeamEntry) => a.name === b.name && a.worktree === b.worktree;

async function stampEntry(home: string, entry: TeamEntry, closed_at: string | undefined): Promise<void> {
  await withTeamLock(home, async () => {
    const team = await readTeam(home);
    await writeJson(hivePath(home, 'team.json'), {
      agents: team.agents.map((a) => (sameEntry(a, entry) ? { ...a, closed_at } : a)),
    });
  });
}

// Conditional on the identity the stamp saw: a respawn racing the kill writes
// a fresh pane identity first, and that entry is a new lease, not the kill's
// target — keep it. Returns whether the entry was dropped.
async function dropEntry(home: string, entry: TeamEntry): Promise<boolean> {
  return withTeamLock(home, async () => {
    const team = await readTeam(home);
    const kept = (a: TeamEntry) =>
      !sameEntry(a, entry) || a.pane !== entry.pane || a.pane_started !== entry.pane_started;
    const dropped = team.agents.some((a) => !kept(a));
    if (dropped) await writeJson(hivePath(home, 'team.json'), { agents: team.agents.filter(kept) });
    return dropped;
  });
}

// tmux failures are plain Errors; the web layer only shows Refusals, so the
// reason is re-wrapped or the toast would read "internal error".
async function killPane(entry: TeamEntry): Promise<void> {
  if (!entry.pane || !(await paneExists(entry.pane))) return;
  try {
    await killWindow(entry.pane, recordedIdentity(entry));
  } catch (e) {
    throw e instanceof Refusal ? e : new Refusal(e instanceof Error ? e.message : String(e));
  }
}

// A launch (wake/respawn/continue) that began before a cascade must not
// re-register afterwards: the final upsert pushes when the entry is absent.
// Re-check under the lock; when the entry was dropped (or, unless
// allowStamped, is stamped closed — respawn stamps its own entry), take the
// fresh pane down with its in-hand identity and refuse instead of
// resurrecting the agent. Worktree pins the match when the caller knows it.
export async function assertEntryAlive(
  home: string,
  entry: TeamEntry,
  launched: { pane: string; identity: PaneIdentity },
  { allowStamped = false }: { allowStamped?: boolean } = {},
): Promise<void> {
  const alive = await withTeamLock(home, async () => {
    const fresh = (await readTeam(home)).agents.find(
      (a) => a.name === entry.name && (entry.worktree === undefined || a.worktree === entry.worktree),
    );
    return Boolean(fresh) && (allowStamped || !fresh!.closed_at);
  });
  if (alive) return;
  await killWindow(launched.pane, launched.identity).catch(() => {});
  throw new Refusal(`${entry.name} was killed while its new pane came up — the pane was taken down too`);
}

// The watchdog's wakeAgent resurrects any dead pane without a closed_at
// stamp, so the stamp lands before the kill. A failed kill un-stamps: a
// surviving stamp would hide a live pane from the watch.
export async function killEntry(home: string, entry: TeamEntry): Promise<boolean> {
  await stampEntry(home, entry, new Date().toISOString());
  try {
    await killPane(entry);
  } catch (e) {
    await stampEntry(home, entry, undefined);
    throw e;
  }
  return dropEntry(home, entry);
}

// The cascade targets: the orchestrator's children (team.json entries whose
// parent is the orchestrator), children first, orchestrator last.
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

// A bare name that matches two agents is an error, never a guess (same rule
// as a dialog read). A named kill is one agent, no cascade: workers spawn nothing.
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

// Orchestrator + every child. Stamping is one locked write before any pane
// dies; a kill that fails mid-cascade hands the survivors' stamps back, so
// the watch still sees them. Identity is re-proven per pane by killWindow.
// An entry a respawn re-identified mid-cascade is kept by the drop and is
// not named as killed.
async function killCascade(root: string, project: string): Promise<{ target: string; killed: string[] }> {
  const home = await projectHome(root, project);
  const planned = cascadeTargets(await readTeam(home));
  if (planned.length === 0) throw new Refusal(`${project} has no orchestrator in team.json`);
  for (const t of planned) {
    if (t.pane && (await paneExists(t.pane))) recordedIdentity(t);
  }
  const targets = await withTeamLock(home, async () => {
    const fresh = await readTeam(home);
    const ts = cascadeTargets(fresh);
    const at = new Date().toISOString();
    await writeJson(hivePath(home, 'team.json'), {
      agents: fresh.agents.map((a) => (ts.some((t) => sameEntry(t, a)) ? { ...a, closed_at: at } : a)),
    });
    return ts;
  });
  const target = targets[targets.length - 1].name;
  const done: TeamEntry[] = [];
  try {
    for (const t of targets) {
      await killPane(t);
      if (await dropEntry(home, t)) done.push(t);
    }
  } catch (e) {
    const survivors = targets.filter((t) => !done.includes(t));
    for (const t of survivors) await stampEntry(home, t, undefined);
    // A partial kill is still lore: record plainly what died and what did not.
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
    killed = (await killEntry(home, entry)) ? [entry.name] : [];
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
