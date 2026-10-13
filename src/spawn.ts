import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  killWindow, newWindow, paneIdentity, paneIs, capturePane,
  sendEnter, sendLiteral, sleep, run, windowName, type PaneIdentity,
} from './tmux.js';
import { classify, lines } from './screen.js';
import {
  hivePath, manifestAdd, readPendingPane, readProjects, readTeam,
  removeTeamEntry, upsertTeamEntry, writePendingPane, clearPendingPane,
} from './state.js';
import type { TeamEntry } from './types.js';

export function orchestratorName(project: string): string {
  return `${project}-orchestrator`;
}

export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export async function preflight(): Promise<void> {
  const r = await run('teamkimi', ['status']);
  if (r.code !== 0) {
    throw new Error('the teamkimi proxy is down; start it (teamkimi server) — hive spawns nothing without it');
  }
}

export function pickupLine(project: string, agent: string): string {
  if (agent === orchestratorName(project)) {
    return `You are ${agent}, the orchestrator of project ${project}. Read .hive/handoffs/${agent}.md from the top: its START HERE block is your prompt. Your role: .hive/team/${agent}/role.md. The rules: .hive/team/${agent}/RULES.md. The owner talks to you only through the hub: report plans, questions, blockers and finished work to it.`;
  }
  return `You are ${agent} of project ${project}. Read .hive/handoffs/${agent}.md from the top: its START HERE block is your prompt. Your role: .hive/team/${agent}/role.md. The rules: .hive/team/${agent}/RULES.md. Report to the orchestrator; wait for its first message.`;
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

export async function launchWindow(
  project: string,
  agent: string,
  cwd: string,
  sessionId?: string,
): Promise<{ pane: string; identity: PaneIdentity }> {
  const resume = sessionId ? ` -- --session ${sessionId}` : '';
  const pane = await newWindow(
    windowName(project, agent),
    cwd,
    `KIMI_CODE_NO_AUTO_UPDATE=1 exec teamkimi run${resume}`,
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

// Newest kimi session recorded for a working directory; basis for wake --resume.
// Agents share a cwd, so a session is only trusted when its first prompt is
// that agent's pickup line.
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

async function projectHome(root: string, project: string): Promise<string> {
  const pf = await readProjects(root);
  const p = pf.projects.find((x) => x.name === project);
  if (!p) throw new Error(`unknown project: ${project} (add it with: hive hub add ${project} <path>)`);
  return p.home;
}

export type SpawnOptions = { agent: string; role?: string; worktree?: string };

export async function spawnAgent(root: string, project: string, opts: SpawnOptions): Promise<string> {
  const { agent, role = 'implementer' } = opts;
  if (!AGENT_NAME_RE.test(agent)) throw new Error(`an agent name is lowercase letters, digits, '-': ${agent}`);
  await preflight();
  const home = await projectHome(root, project);
  const team = await readTeam(home);
  if (team.agents.some((a) => a.name === agent)) {
    throw new Error(`${project} already has an agent named ${agent} (close or respawn it)`);
  }

  let worktree = home;
  if (opts.worktree) {
    const wt = path.resolve(home, opts.worktree);
    const branch = `${project}/${agent}`;
    const made = await run('git', ['worktree', 'add', '-q', '-b', branch, wt, 'HEAD'], home);
    if (made.code !== 0) throw new Error(`git worktree add failed: ${made.stderr.trim()}`);
    await manifestAdd(home, { kind: 'worktree', at: new Date().toISOString(), path: wt, branch });
    worktree = wt;
  }

  await ensureAgentFiles(worktree, agent, role);
  const { pane, identity } = await launchWindow(project, agent, worktree);
  await manifestAdd(home, {
    kind: 'tmux', at: new Date().toISOString(), pane, window: windowName(project, agent),
    pane_pid: identity.pid, pane_started: identity.started,
  });
  const entry: TeamEntry = {
    name: agent, pane, pane_pid: identity.pid, pane_started: identity.started,
    worktree, handoff: hivePath(worktree, 'handoffs', `${agent}.md`),
  };
  await upsertTeamEntry(home, entry);

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
  const home = await projectHome(root, project);
  const team = await readTeam(home);
  const entry = team.agents.find((a) => a.name === agent);
  if (!entry) throw new Error(`${project} has no agent named ${agent}`);
  if (entry.pane) await killWindow(entry.pane, recordedIdentity(entry));
  await removeTeamEntry(home, agent);
  if (entry.orchestrator) await clearPendingPane(root, project);
}

export async function respawnAgent(root: string, project: string, agent: string): Promise<string> {
  const home = await projectHome(root, project);
  const team = await readTeam(home);
  const old = team.agents.find((a) => a.name === agent);
  if (!old) throw new Error(`${project} has no agent named ${agent}`);
  await preflight();
  if (old.pane) await killWindow(old.pane, recordedIdentity(old));
  const worktree = old.worktree ?? home;
  const { pane, identity } = await launchWindow(project, agent, worktree);
  await upsertTeamEntry(home, {
    name: agent, pane, pane_pid: identity.pid, pane_started: identity.started, session_id: undefined,
  });
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

export { readPendingPane, writePendingPane };
