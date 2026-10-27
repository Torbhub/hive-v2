import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  killWindow, newWindow, paneIdentity, paneIs, capturePane,
  sendArrow, sendEnter, sendLiteral, sleep, run, windowName, type PaneIdentity,
} from './tmux.js';
import { classify, lines, parseDialog } from './screen.js';
import {
  foldTasks, hivePath, manifestAdd, readProjects, readTaskEvents, readTeam,
  removeTeamEntry, upsertTeamEntry, clearPendingPane, withTeamLock, writeJson, type ProjectsFile,
} from './state.js';
import type { Approvals, ProjectMode, TeamEntry } from './types.js';
import { withLaunchClaim, withProjectLock } from './project.js';
import { checkTaskScope } from './scope.js';
import { applyMemoryBlock, memoryBlockFor } from './memory.js';
import { assertEntryAlive, killEntry, recordedIdentity } from './kill.js';
export { assertEntryAlive } from './kill.js';

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

// The folder-trust menu on a spawn-created worktree is answered once: hive
// made the folder, so the answer is always "Trust this folder".
async function answerTrustMenu(pane: string): Promise<boolean> {
  const raw = await capturePane(pane);
  if (raw === null) return false;
  const d = parseDialog(lines(raw));
  const opt = d.options.find((o) => o.label === 'Trust this folder');
  if (d.kind !== 'menu' || !opt) return false;
  const delta = opt.n - (d.cursor ?? 1);
  for (let i = 0; i < Math.abs(delta); i++) await sendArrow(pane, delta > 0 ? 'Down' : 'Up');
  await sendEnter(pane);
  return true;
}

// waitIdle with one trust-menu answer in the middle; any other dialog surfaces as before.
async function waitIdleTrust(pane: string): Promise<'idle' | 'dialog' | 'timeout'> {
  const idle = await waitIdle(pane);
  if (idle !== 'dialog') return idle;
  if (!(await answerTrustMenu(pane))) return 'dialog';
  return waitIdle(pane);
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

// -S combines with -y/--auto/-m per kimi --help, so mode and model apply to resumes too.
const MODEL_RE = /^[A-Za-z0-9._/[\]-]{1,64}$/;

// In ask mode kimi blocks on its own prompt for every command and the watch
// answers 5-17s later, stalling the lane. With approvals safe|smart the watch
// is already the backstop, so launch the orchestrator in auto. Launch-time
// only: the stored project mode is not rewritten, and manual keeps ask.
export function effectiveOrchestratorMode(mode: ProjectMode, approvals?: Approvals): ProjectMode {
  return mode === 'ask' && (approvals === 'safe' || approvals === 'smart') ? 'auto' : mode;
}

// Called before any side effect (worktree add, pane kill): a bad alias is a
// recoverable config error and must never orphan a worktree or kill a live agent.
function checkModel(model: string | undefined): void {
  if (model !== undefined && !MODEL_RE.test(model)) {
    throw new Error(`a model alias is letters, digits, '.', '_', '-', '/', '[', ']': ${model}`);
  }
}

// Sessions without an explicit model get the house default, not whatever
// default_model a drifting config.toml happens to say.
export const DEFAULT_MODEL = 'kimi-code/k3.1-pro';

export function launchCommand(sessionId: string | undefined, mode: ProjectMode = 'ask', model: string = DEFAULT_MODEL): string {
  checkModel(model);
  const args = [
    sessionId ? `--session ${sessionId}` : '',
    mode === 'yolo' ? '-y' : mode === 'auto' ? '--auto' : '',
    `-m '${model}'`,
  ].filter(Boolean);
  // No session lock: kimi's take-over repair prompt is interactive, and a hive lane is already one client per session.
  return `KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run${args.length ? ` -- ${args.join(' ')}` : ''}`;
}

export async function launchWindow(
  root: string,
  project: string,
  agent: string,
  cwd: string,
  sessionId?: string,
  mode: ProjectMode = 'ask',
  model?: string,
): Promise<{ pane: string; identity: PaneIdentity }> {
  // HIVE_AGENT names the pane's own agent: a `hive spawn` run inside the pane
  // reads it to record its parent, and the memory CLI already reports with it.
  // HIVE_PROJECT + HIVE_HUB_ROOT route the agent's ask_operator MCP calls.
  const quote = (v: string): string => `'${v.replaceAll("'", `'\\''`)}'`;
  const pane = await newWindow(
    windowName(project, agent),
    cwd,
    `HIVE_AGENT=${agent} HIVE_PROJECT=${project} HIVE_HUB_ROOT=${quote(path.resolve(root))} ${launchCommand(sessionId, mode, model)}`,
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

// Workers never launch on a task whose plan the owner has not approved.
async function requireApprovedPlan(root: string, task: string): Promise<void> {
  const t = foldTasks(await readTaskEvents(root)).find((x) => x.id === task);
  if (!t?.plan_approved) {
    throw new Error(`${task} has no approved plan; the owner approves the plan before workers spawn`);
  }
}

export type SpawnOptions = { agent: string; role?: string; worktree?: string; task?: string; model?: string; parent?: string };

// Prefer the remote tip; the fallbacks keep offline and master-based repos lane-able.
async function jjBaseRev(home: string): Promise<string> {
  for (const rev of ['main@origin', 'main', '@']) {
    const probe = await run('jj', ['-R', home, 'log', '-r', rev, '-T', "''", '--no-graph', '--limit', '1'], home);
    if (probe.code === 0) return rev;
  }
  throw new Error(`jj: no base revision in ${home} (tried main@origin, main, @)`);
}

// Trash first, then forget: forget is jj's flow for a directory already gone.
async function undoJjWorkspace(home: string, name: string, wt: string): Promise<void> {
  const dest = path.join(hivePath(home, 'trash', new Date().toISOString().slice(0, 10)), name);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rename(wt, dest).catch(() => {});
  await run('jj', ['-R', home, 'workspace', 'forget', name], home);
}

// A spawn run inside a pane records the pane's agent as the child's parent,
// so a cascade kill can enumerate the orchestrator's children. In the owner's
// shell HIVE_AGENT is unset and the spawn has no parent.
function envParent(self: string): string | undefined {
  const v = process.env.HIVE_AGENT;
  return v && v !== self && AGENT_NAME_RE.test(v) ? v : undefined;
}

export async function spawnAgent(root: string, project: string, opts: SpawnOptions): Promise<string> {
  if (!AGENT_NAME_RE.test(opts.agent)) throw new Error(`an agent name is lowercase letters, digits, '-': ${opts.agent}`);
  checkModel(opts.model);
  await preflight();
  return withLaunchClaim(root, project, (p) => spawnRegisteredAgent(root, p, opts));
}

async function spawnRegisteredAgent(
  root: string,
  p: ProjectsFile['projects'][number],
  opts: SpawnOptions,
): Promise<string> {
  const { agent, role = 'implementer' } = opts;
  const project = p.name;
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
      await requireApprovedPlan(root, task);
      await writeJson(hivePath(home, 'team.json'), { agents: [...fresh.agents, { name: agent, task }] });
    });
  }

  let pane: string;
  let identity: PaneIdentity;
  let worktree: string;
  let jjLane: { name: string; path: string } | null = null;
  try {
    const wt = opts.worktree ? path.resolve(home, opts.worktree) : hivePath(home, 'lanes', agent);
    // Neither jj workspace add nor git worktree add creates missing parent dirs.
    await fs.mkdir(path.dirname(wt), { recursive: true });
    // jj root answers only inside a jj repo; a failure tries git next.
    const jjRepo = (await run('jj', ['root'], home)).code === 0;
    const plainFolder = !opts.worktree && !jjRepo &&
      (await run('git', ['rev-parse', '--is-inside-work-tree'], home)).code !== 0;
    if (jjRepo) {
      const base = await jjBaseRev(home);
      const existed = existsSync(wt);
      const made = await run('jj', ['-R', home, 'workspace', 'add', wt, '-r', base], home);
      if (made.code !== 0) {
        // jj can register the workspace and create the dir yet still fail.
        if (!existed && existsSync(wt)) await undoJjWorkspace(home, path.basename(wt), wt);
        throw new Error(`jj workspace add failed: ${made.stderr.trim()}`);
      }
      jjLane = { name: path.basename(wt), path: wt };
      if (existsSync(path.join(wt, 'scripts', 'install-git-hooks.sh'))) {
        const hooks = await run('bash', ['scripts/install-git-hooks.sh'], wt);
        if (hooks.code !== 0) throw new Error(`install-git-hooks failed in ${wt}: ${hooks.stderr.trim()}`);
      }
      await manifestAdd(home, { kind: 'jj-workspace', at: new Date().toISOString(), path: wt });
    } else if (plainFolder) {
      await fs.mkdir(wt, { recursive: true });
    } else {
      const branch = `${project}/${agent}`;
      const made = await run('git', ['worktree', 'add', '-q', '-b', branch, wt, 'HEAD'], home);
      if (made.code !== 0) throw new Error(`git worktree add failed: ${made.stderr.trim()}`);
      await manifestAdd(home, { kind: 'worktree', at: new Date().toISOString(), path: wt, branch });
    }
    worktree = wt;

    await ensureAgentFiles(worktree, agent, role);
    if (task) {
      // Recall never blocks a spawn: memoryBlockFor fails open in 3s.
      const block = await memoryBlockFor(root, project, task);
      if (block) await applyMemoryBlock(hivePath(worktree, 'handoffs', `${agent}.md`), block);
    }
    const model = opts.model ?? DEFAULT_MODEL;
    ({ pane, identity } = await launchWindow(root, project, agent, worktree, undefined, p.mode ?? 'ask', model));
    await manifestAdd(home, {
      kind: 'tmux', at: new Date().toISOString(), pane, window: windowName(project, agent),
      pane_pid: identity.pid, pane_started: identity.started,
    });
    const entry: TeamEntry = {
      name: agent, pane, pane_pid: identity.pid, pane_started: identity.started,
      worktree, handoff: hivePath(worktree, 'handoffs', `${agent}.md`), task, model,
      parent: opts.parent ?? envParent(agent),
    };
    await withProjectLock(root, project, () => upsertTeamEntry(home, entry));
  } catch (e) {
    if (jjLane) {
      // A failed spawn must not strand a registered lane.
      await undoJjWorkspace(home, jjLane.name, jjLane.path);
    }
    if (task) await removeTeamEntry(home, agent);
    throw e;
  }

  const idle = await waitIdleTrust(pane);
  if (idle !== 'idle') {
    throw new Error(idle === 'dialog'
      ? `a dialog is on the screen of ${pane}; answer it in the pane, then respawn`
      : `${pane} never went idle; nothing was typed`);
  }
  await typeLine(pane, pickupLine(project, agent), identity);
  const sid = await findLatestSession(worktree, agent);
  if (sid) await withProjectLock(root, project, () => upsertTeamEntry(home, { name: agent, session_id: sid }));
  return pane;
}

export async function closeAgent(root: string, project: string, agent: string): Promise<void> {
  const home = (await projectEntry(root, project)).home;
  const team = await readTeam(home);
  const entry = team.agents.find((a) => a.name === agent);
  if (!entry) throw new Error(`${project} has no agent named ${agent}`);
  await killEntry(home, entry);
  if (entry.orchestrator) await clearPendingPane(root, project);
}

// Shared tail of respawnAgent and wakeAgent: new window, team record, pickup line.
async function relaunchAgent(
  root: string,
  p: ProjectsFile['projects'][number],
  old: TeamEntry,
  sessionId: string | undefined,
): Promise<string> {
  return withLaunchClaim(root, p.name, (registered) => relaunchRegisteredAgent(root, registered, old, sessionId));
}

async function relaunchRegisteredAgent(
  root: string,
  p: ProjectsFile['projects'][number],
  old: TeamEntry,
  sessionId: string | undefined,
): Promise<string> {
  const home = p.home;
  const worktree = old.worktree ?? home;
  const mode = old.orchestrator ? effectiveOrchestratorMode(p.mode ?? 'ask', p.approvals) : p.mode ?? 'ask';
  const { pane, identity } = await launchWindow(root, p.name, old.name, worktree, sessionId, mode, old.model);
  await manifestAdd(home, {
    kind: 'tmux', at: new Date().toISOString(), pane, window: windowName(p.name, old.name),
    pane_pid: identity.pid, pane_started: identity.started,
  });
  // A cascade that landed mid-launch dropped the entry; never re-register it.
  // respawnAgent stamped the entry itself, so a stamp alone is not a kill.
  await withProjectLock(root, p.name, async () => {
    await assertEntryAlive(home, old, { pane, identity }, { allowStamped: true });
    await upsertTeamEntry(home, {
      name: old.name, pane, pane_pid: identity.pid, pane_started: identity.started,
      session_id: sessionId, closed_at: undefined, wedged_at: undefined,
      model: old.model ?? DEFAULT_MODEL,
    });
  });
  const idle = await waitIdleTrust(pane);
  if (idle !== 'idle') {
    throw new Error(idle === 'dialog'
      ? `a dialog is on the screen of ${pane}; answer it in the pane, then respawn`
      : `${pane} never went idle; nothing was typed`);
  }
  await typeLine(pane, pickupLine(p.name, old.name), identity);
  const sid = await findLatestSession(worktree, old.name);
  if (sid) await withProjectLock(root, p.name, () => upsertTeamEntry(home, { name: old.name, session_id: sid }));
  return pane;
}

export async function respawnAgent(root: string, project: string, agent: string): Promise<string> {
  const p = await projectEntry(root, project);
  const home = p.home;
  const team = await readTeam(home);
  const old = team.agents.find((a) => a.name === agent);
  if (!old) throw new Error(`${project} has no agent named ${agent}`);
  checkModel(old.model);
  await preflight();
  if (old.task && !old.orchestrator) await requireApprovedPlan(root, old.task);
  await upsertTeamEntry(home, { name: agent, closed_at: new Date().toISOString() });
  try {
    if (old.pane) await killWindow(old.pane, recordedIdentity(old));
    return await relaunchAgent(root, p, old, undefined);
  } catch (e) {
    // A failed respawn must not leave the agent invisible to the watch — but
    // when a cascade dropped the entry mid-flight, the kill owns the outcome.
    const fresh = (await readTeam(home)).agents.find((a) => a.name === agent);
    if (fresh) await upsertTeamEntry(home, { name: agent, closed_at: undefined });
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
  checkModel(old.model);
  await preflight();
  if (old.task && !old.orchestrator) await requireApprovedPlan(root, old.task);
  if (old.pane && (await paneIs(old.pane, { pid: old.pane_pid ?? 0, started: old.pane_started ?? '' }))) {
    throw new Error(`${agent} is already running`);
  }
  return relaunchAgent(root, p, old, old.session_id);
}
