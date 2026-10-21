import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  killWindow, newWindow, paneIdentity, paneIs, capturePane,
  sendEnter, sendLiteral, sleep, run, windowName, type PaneIdentity,
} from './tmux.js';
import { classify, lines } from './screen.js';
import {
  hivePath, manifestAdd, readProjects, readTeam,
  removeTeamEntry, upsertTeamEntry, clearPendingPane, withTeamLock, writeJson, type ProjectsFile,
} from './state.js';
import type { ProjectMode, TeamEntry } from './types.js';
import { checkTaskScope } from './scope.js';

export function orchestratorName(project: string): string {
  return `${project}-orchestrator`;
}

// Compiled this lives in dist/src/, in tests in src/ — walk up to the dir holding roles/.
export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(path.join(dir, 'roles', 'orchestrator.md'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('hive: cannot find roles/ above the running module');
}

export async function preflight(): Promise<void> {
  const r = await run('teamkimi', ['status']);
  if (r.code !== 0) {
    throw new Error('the teamkimi proxy is down; start it (teamkimi server) — hive spawns nothing without it');
  }
}

export function pickupLine(project: string, agent: string): string {
  const decisions = ' Decisions so far: read .hive-hub/decisions.jsonl — they are permanent.';
  if (agent === orchestratorName(project)) {
    return `You are ${agent}, the orchestrator of project ${project}. Read .hive/handoffs/${agent}.md from the top: its START HERE block is your prompt. Your role: .hive/team/${agent}/role.md. The rules: .hive/team/${agent}/RULES.md. The owner talks to you only through the hub: report plans, questions, blockers and finished work to it.${decisions}`;
  }
  return `You are ${agent} of project ${project}. Read .hive/handoffs/${agent}.md from the top: its START HERE block is your prompt. Your role: .hive/team/${agent}/role.md. The rules: .hive/team/${agent}/RULES.md. Report to the orchestrator; wait for its first message.${decisions}`;
}

export async function ensureAgentFiles(projectHome: string, agent: string, role: string): Promise<void> {
  const root = packageRoot();
  const dir = hivePath(projectHome, 'team', agent);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(hivePath(projectHome, 'handoffs'), { recursive: true });
  const roleSrc = path.join(root, 'roles', `${role}.md`);
  await fs.copyFile(roleSrc, path.join(dir, 'role.md'));
  await fs.copyFile(path.join(root, 'rules', 'RULES.md'), path.join(dir, 'RULES.md'));
  const handoff = hivePath(projectHome, 'handoffs', `${agent}.md`);
  try {
    await fs.access(handoff);
  } catch {
    await fs.writeFile(handoff, `# ${agent} handoff\n\n## START HERE\nYou were just spawned. Wait for the first message, then do what it asks. Before any rotation, rewrite this block: what you are doing, what is done, what is next, which paths matter.\n`);
  }
}

const AGENT_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

export async function waitIdle(
  pane: string,
  { stillMs = 3000, maxMs = 120_000 }: { stillMs?: number; maxMs?: number } = {},
): Promise<'idle' | 'dialog' | 'timeout'> {
  const deadline = Date.now() + maxMs;
  let last = '';
  let stillSince = Date.now();
  while (Date.now() < deadline) {
    const raw = await capturePane(pane);
    if (raw === null) return 'timeout';
    const state = classify(lines(raw));
    if (state === 'dialog') return 'dialog';
    if (raw !== last) {
      last = raw;
      stillSince = Date.now();
    } else if (state === 'idle' && Date.now() - stillSince >= stillMs) {
      return 'idle';
    }
    await sleep(1000);
  }
  return 'timeout';
}

// The first Enter after a literal send is sometimes swallowed by the TUI; one retry, then give up.
export async function typeLine(pane: string, text: string, identity: PaneIdentity): Promise<void> {
  if (!(await paneIs(pane, identity))) throw new Error(`pane ${pane} is no longer the session it was`);
  await sendLiteral(pane, text, identity);
  await sleep(500);
  await sendEnter(pane, identity);
  for (let i = 0; i < 6; i++) {
    await sleep(1000);
    const raw = await capturePane(pane);
    if (raw === null) throw new Error(`pane ${pane} died while typing`);
    const ls = lines(raw);
    const promptLine = [...ls].reverse().find((l) => /^\s*│\s*>/.test(l));
    if (!promptLine || !promptLine.includes(text.slice(0, 40))) return;
    await sendEnter(pane, identity);
  }
  throw new Error(`the line stayed in the prompt of ${pane}; not typed`);
}

// -S combines with -y/--auto per kimi --help, so the mode applies to resumes too.
export function launchCommand(sessionId: string | undefined, mode: ProjectMode = 'ask'): string {
  const args = [
    sessionId ? `--session ${sessionId}` : '',
    mode === 'yolo' ? '-y' : mode === 'auto' ? '--auto' : '',
  ].filter(Boolean);
  return `KIMI_CODE_NO_AUTO_UPDATE=1 exec teamkimi run${args.length ? ` -- ${args.join(' ')}` : ''}`;
}

export async function launchWindow(
  project: string,
  agent: string,
  cwd: string,
  sessionId?: string,
  mode: ProjectMode = 'ask',
): Promise<{ pane: string; identity: PaneIdentity }> {
  const pane = await newWindow(
    windowName(project, agent),
    cwd,
    launchCommand(sessionId, mode),
  );
  const deadline = Date.now() + 15_000;
  let identity: PaneIdentity | null = null;
  while (Date.now() < deadline) {
    identity = await paneIdentity(pane);
    if (identity) return { pane, identity };
    await sleep(500);
  }
  throw new Error(`pane ${pane} never got a process identity`);
}

// Agents share a cwd, so a session counts only when its first prompt is that agent's pickup line.
export async function findLatestSession(cwd: string, agent?: string): Promise<string | null> {
  const base = path.join(os.homedir(), '.kimi-code', 'sessions');
  let best: { id: string; at: number } | null = null;
  let wds: string[];
  try {
    wds = await fs.readdir(base);
  } catch {
    return null;
  }
  for (const wd of wds) {
    let sessions: string[];
    try {
      sessions = await fs.readdir(path.join(base, wd));
    } catch {
      continue;
    }
    for (const s of sessions) {
      if (!s.startsWith('session_')) continue;
      try {
        const st = JSON.parse(
          await fs.readFile(path.join(base, wd, s, 'state.json'), 'utf8'),
        ) as { cwd?: string; updatedAt?: number; lastPrompt?: string };
        if (st.cwd !== cwd) continue;
        if (agent && !(st.lastPrompt ?? '').startsWith(`You are ${agent}`)) continue;
        const at = st.updatedAt ?? 0;
        if (!best || at > best.at) best = { id: s, at };
      } catch {
        continue;
      }
    }
  }
  return best ? best.id : null;
}

async function projectEntry(root: string, project: string): Promise<ProjectsFile['projects'][number]> {
  const pf = await readProjects(root);
  const p = pf.projects.find((x) => x.name === project);
  if (!p) throw new Error(`unknown project: ${project} (add it with: hive hub add ${project} <path>)`);
  return p;
}

export type SpawnOptions = { agent: string; role?: string; worktree?: string; task?: string };

export async function spawnAgent(root: string, project: string, opts: SpawnOptions): Promise<string> {
  const { agent, role = 'implementer' } = opts;
  if (!AGENT_NAME_RE.test(agent)) throw new Error(`an agent name is lowercase letters, digits, '-': ${agent}`);
  await preflight();
  const p = await projectEntry(root, project);
  const home = p.home;
  const team = await readTeam(home);
  if (team.agents.some((a) => a.name === agent)) {
    throw new Error(`${project} already has an agent named ${agent} (close or respawn it)`);
  }
  // Claim the scope and the name in one lock: two concurrent spawns on
  // overlapping tasks must not both pass the check.
  const task = opts.task;
  if (task) {
    // The lock lives in .hive/, which a first spawn has not created yet.
    await fs.mkdir(hivePath(home), { recursive: true });
    await withTeamLock(home, async () => {
      const fresh = await readTeam(home);
      if (fresh.agents.some((a) => a.name === agent)) {
        throw new Error(`${project} already has an agent named ${agent} (close or respawn it)`);
      }
      await checkTaskScope(root, project, home, task);
      await writeJson(hivePath(home, 'team.json'), { agents: [...fresh.agents, { name: agent, task }] });
    });
  }

  let pane: string;
  let identity: PaneIdentity;
  let worktree = home;
  try {
    if (opts.worktree) {
      const wt = path.resolve(home, opts.worktree);
      const branch = `${project}/${agent}`;
      const made = await run('git', ['worktree', 'add', '-q', '-b', branch, wt, 'HEAD'], home);
      if (made.code !== 0) throw new Error(`git worktree add failed: ${made.stderr.trim()}`);
      await manifestAdd(home, { kind: 'worktree', at: new Date().toISOString(), path: wt, branch });
      worktree = wt;
    }

    await ensureAgentFiles(worktree, agent, role);
    ({ pane, identity } = await launchWindow(project, agent, worktree, undefined, p.mode ?? 'ask'));
    await manifestAdd(home, {
      kind: 'tmux', at: new Date().toISOString(), pane, window: windowName(project, agent),
      pane_pid: identity.pid, pane_started: identity.started,
    });
    const entry: TeamEntry = {
      name: agent, pane, pane_pid: identity.pid, pane_started: identity.started,
      worktree, handoff: hivePath(worktree, 'handoffs', `${agent}.md`), task,
    };
    await upsertTeamEntry(home, entry);
  } catch (e) {
    if (task) await removeTeamEntry(home, agent);
    throw e;
  }

  const idle = await waitIdle(pane);
  if (idle !== 'idle') {
    throw new Error(idle === 'dialog'
      ? `a dialog is on the screen of ${pane}; answer it in the pane, then respawn`
      : `${pane} never went idle; nothing was typed`);
  }
  await typeLine(pane, pickupLine(project, agent), identity);
  const sid = await findLatestSession(worktree, agent);
  if (sid) await upsertTeamEntry(home, { name: agent, session_id: sid });
  return pane;
}

function recordedIdentity(entry: TeamEntry): PaneIdentity {
  if (!entry.pane || !entry.pane_pid || !entry.pane_started) {
    throw new Error(
      `${entry.name} has no recorded pane identity; refusing to kill ${entry.pane ?? 'it'} — close the window by hand on the hive socket`,
    );
  }
  return { pid: entry.pane_pid, started: entry.pane_started };
}

export async function closeAgent(root: string, project: string, agent: string): Promise<void> {
  const home = (await projectEntry(root, project)).home;
  const team = await readTeam(home);
  const entry = team.agents.find((a) => a.name === agent);
  if (!entry) throw new Error(`${project} has no agent named ${agent}`);
  await upsertTeamEntry(home, { name: agent, closed_at: new Date().toISOString() });
  try {
    if (entry.pane) await killWindow(entry.pane, recordedIdentity(entry));
  } catch (e) {
    // The pane survived; a surviving stamp would hide it from the watch.
    await upsertTeamEntry(home, { name: agent, closed_at: undefined });
    throw e;
  }
  await removeTeamEntry(home, agent);
  if (entry.orchestrator) await clearPendingPane(root, project);
}

// Shared tail of respawnAgent and wakeAgent: new window, team record, pickup line.
async function relaunchAgent(
  p: ProjectsFile['projects'][number],
  old: TeamEntry,
  sessionId: string | undefined,
): Promise<string> {
  const home = p.home;
  const worktree = old.worktree ?? home;
  const { pane, identity } = await launchWindow(p.name, old.name, worktree, sessionId, p.mode ?? 'ask');
  await manifestAdd(home, {
    kind: 'tmux', at: new Date().toISOString(), pane, window: windowName(p.name, old.name),
    pane_pid: identity.pid, pane_started: identity.started,
  });
  await upsertTeamEntry(home, {
    name: old.name, pane, pane_pid: identity.pid, pane_started: identity.started,
    session_id: sessionId, closed_at: undefined, wedged_at: undefined,
  });
  const idle = await waitIdle(pane);
  if (idle !== 'idle') {
    throw new Error(idle === 'dialog'
      ? `a dialog is on the screen of ${pane}; answer it in the pane, then respawn`
      : `${pane} never went idle; nothing was typed`);
  }
  await typeLine(pane, pickupLine(p.name, old.name), identity);
  const sid = await findLatestSession(worktree, old.name);
  if (sid) await upsertTeamEntry(home, { name: old.name, session_id: sid });
  return pane;
}

export async function respawnAgent(root: string, project: string, agent: string): Promise<string> {
  const p = await projectEntry(root, project);
  const home = p.home;
  const team = await readTeam(home);
  const old = team.agents.find((a) => a.name === agent);
  if (!old) throw new Error(`${project} has no agent named ${agent}`);
  await preflight();
  await upsertTeamEntry(home, { name: agent, closed_at: new Date().toISOString() });
  try {
    if (old.pane) await killWindow(old.pane, recordedIdentity(old));
    return await relaunchAgent(p, old, undefined);
  } catch (e) {
    // A failed respawn must not leave the agent invisible to the watch.
    await upsertTeamEntry(home, { name: agent, closed_at: undefined });
    throw e;
  }
}

// The watchdog's agent ensure: a dead agent with a recorded session comes back
// with that session resumed. A stamped close is never woken.
export async function wakeAgent(root: string, project: string, agent: string): Promise<string> {
  const p = await projectEntry(root, project);
  const team = await readTeam(p.home);
  const old = team.agents.find((a) => a.name === agent);
  if (!old) throw new Error(`${project} has no agent named ${agent}`);
  if (old.closed_at) throw new Error(`${agent} was closed on purpose at ${old.closed_at}; not waking it`);
  if (!old.session_id) throw new Error(`${agent} has no recorded session to resume; respawn it instead`);
  await preflight();
  if (old.pane && (await paneIs(old.pane, { pid: old.pane_pid ?? 0, started: old.pane_started ?? '' }))) {
    throw new Error(`${agent} is already running`);
  }
  return relaunchAgent(p, old, old.session_id);
}
