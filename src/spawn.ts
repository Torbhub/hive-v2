import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeNoFollow } from './safe-write.js';
import { fileURLToPath } from 'node:url';
import {
  killWindow, newWindow, paneIdentity, paneIs, capturePane,
  sendArrow, sendEnter, sendLiteral, sleep, run, windowName, type PaneIdentity,
} from './tmux.js';
import { classify, lines, parseDialog } from './screen.js';
import {
  appendDecision, compareAndSwapTeamEntry, foldTasks, hivePath, hubPath, insertTeamEntry, manifestAdd,
  readProjects, readTaskEvents, readTeam, clearPendingPane, valueDigest, withTeamLock, type ProjectsFile,
} from './state.js';
import type { Approvals, ProjectMode, TeamEntry, TmuxAdmission } from './types.js';
import { withLaunchClaim, withProjectLock } from './project.js';
import {
  admitTmux, assertTmuxGrant, completeTmuxLaunch, recordTmuxLaunchOutcome, registerTmuxLaunch, withTmuxGrant,
} from './admission.js';
import { taskScope } from './scope.js';
import { applyMemoryBlock, memoryBlockFor } from './memory.js';
import { assertEntryAlive, killEntry, recordedIdentity } from './kill.js';
import { requireAgentCredential } from './collaboration-credentials.js';
import { assertExecutionAllowed } from './rollout.js';
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

export function pickupLine(root: string, project: string, agent: string, handoff?: string): string {
  const decisions = ` Decisions so far: read ${hubPath(root, 'decisions.jsonl')} — they are permanent.`;
  if (agent === orchestratorName(project)) {
    return `You are ${agent}, the orchestrator of project ${project}. Read .hive/handoffs/${agent}.md from the top: its START HERE block is your prompt. Your role: .hive/team/${agent}/role.md. The rules: .hive/team/${agent}/RULES.md. The owner talks to you only through the hub: report plans, questions, blockers and finished work to it.${decisions}`;
  }
  return `You are ${agent} of project ${project}. Read ${handoff ?? `.hive/handoffs/${agent}.md`} from the top. Start with the Assignment and Deliverable in START HERE. Your role: .hive/team/${agent}/role.md. The rules: .hive/team/${agent}/RULES.md. Report the required deliverable to the orchestrator.${decisions}`;
}

export async function ensureAgentFiles(projectHome: string, agent: string, role: string): Promise<void> {
  const root = packageRoot();
  const dir = hivePath(projectHome, 'team', agent);
  const roleSrc = path.join(root, 'roles', `${role}.md`);
  await writeNoFollow(path.join(dir, 'role.md'), await fs.readFile(roleSrc, 'utf8'), projectHome);
  await writeNoFollow(
    path.join(dir, 'RULES.md'),
    await fs.readFile(path.join(root, 'rules', 'RULES.md'), 'utf8'),
    projectHome,
  );
  const handoff = hivePath(projectHome, 'handoffs', `${agent}.md`);
  if (!existsSync(handoff)) {
    await writeNoFollow(handoff, `# ${agent} handoff\n\n## START HERE\nYou were just spawned. Wait for the first message, then do what it asks. Before any rotation, rewrite this block: what you are doing, what is done, what is next, which paths matter.\n`, projectHome);
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

type TrustTarget = { cwd: string; identity: PaneIdentity };

async function answerTrustMenu(pane: string, target?: TrustTarget): Promise<boolean> {
  if (!target || !(await paneIs(pane, target.identity))) return false;
  const raw = await capturePane(pane);
  if (raw === null) return false;
  const d = parseDialog(lines(raw));
  const opt = d.options.find((o) => o.label === 'Trust this folder');
  if (d.kind !== 'menu' || !opt) return false;
  const displayed = lines(raw).map((line) => line.trim()).filter((line) => path.isAbsolute(line));
  if (displayed.length !== 1) return false;
  const [expected, actual] = await Promise.all([
    fs.realpath(target.cwd).catch(() => null), fs.realpath(displayed[0]).catch(() => null),
  ]);
  if (!expected || expected !== actual) return false;
  const delta = opt.n - (d.cursor ?? 1);
  for (let i = 0; i < Math.abs(delta); i++) await sendArrow(pane, delta > 0 ? 'Down' : 'Up', target.identity);
  await sendEnter(pane, target.identity);
  return true;
}

async function waitIdleTrust(pane: string, target?: TrustTarget): Promise<'idle' | 'dialog' | 'timeout'> {
  const idle = await waitIdle(pane);
  if (idle !== 'dialog') return idle;
  if (!(await answerTrustMenu(pane, target))) return 'dialog';
  return waitIdle(pane);
}

export class PreInputError extends Error {}

// The first Enter after a literal send is sometimes swallowed by the TUI; one retry, then give up.
export async function typeLine(
  pane: string, text: string, identity: PaneIdentity, screenGuard?: (raw?: string) => Promise<void>,
): Promise<void> {
  if (!(await paneIs(pane, identity))) throw new PreInputError(`pane ${pane} is no longer the session it was`);
  await sendLiteral(pane, text, identity);
  await sleep(500);
  if (screenGuard) await screenGuard();
  await sendEnter(pane, identity);
  for (let i = 0; i < 6; i++) {
    await sleep(1000);
    const raw = await capturePane(pane);
    if (raw === null) throw new Error(`pane ${pane} died while typing`);
    if (screenGuard) await screenGuard(raw);
    const ls = lines(raw);
    const promptLine = [...ls].reverse().find((l) => /^\s*│\s*>/.test(l));
    if (!promptLine || !promptLine.includes(text.slice(0, 40))) return;
    if (screenGuard) await screenGuard();
    await sendEnter(pane, identity);
  }
  throw new Error(`the line stayed in the prompt of ${pane}; not typed`);
}

// -S combines with -y/--auto/-m per kimi --help, so mode and model apply to resumes too.
const MODEL_RE = /^[A-Za-z0-9._/[\]-]{1,64}$/;

type LaunchMode = ProjectMode | 'supervised-auto';

// In ask mode kimi blocks on its own prompt for every command and the watch
// answers 5-17s later, stalling the lane. With approvals safe|smart the watch
// is already the backstop, so launch the orchestrator in supervised auto.
// Launch-time only: the stored project mode is not rewritten, and manual keeps ask.
export function effectiveOrchestratorMode(mode: ProjectMode, approvals?: Approvals): LaunchMode {
  return mode === 'ask' && (approvals === 'safe' || approvals === 'smart') ? 'supervised-auto' : mode;
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

export function launchCommand(
  sessionId: string | undefined,
  mode: LaunchMode = 'ask',
  model: string = DEFAULT_MODEL,
  profile?: string,
): string {
  checkModel(model);
  const quote = (v: string): string => `'${v.replaceAll("'", `'\\''`)}'`;
  const args = [
    sessionId ? `--session ${sessionId}` : '',
    !sessionId && profile ? `--agent-file ${quote(profile)}` : '',
    mode === 'supervised-auto' ? '--auto' : mode === 'yolo' ? '-y' : '',
    `-m '${model}'`,
  ].filter(Boolean);
  // No session lock: kimi's take-over repair prompt is interactive, and a hive lane is already one client per session.
  return `KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run${args.length ? ` -- ${args.join(' ')}` : ''}`;
}

async function ensureAgentProfile(cwd: string, agent: string): Promise<string> {
  const file = hivePath(cwd, 'team', agent, 'agent.md');
  await writeNoFollow(file, `---\nname: hive-${agent}\ndescription: Hive-managed agent with structured operator questions\ndisallowedTools:\n  - AskUserQuestion\n---\n\n\${base_prompt}\n\nYou are a Hive agent. Do not use AskUserQuestion. Use mcp__hive-operator__ask_operator for every operator decision. Harness faults are Hive-owned errors to repair or degrade. Do not turn them into owner questions.\n`, cwd);
  return file;
}

export async function launchWindow(
  root: string,
  project: string,
  agent: string,
  cwd: string,
  sessionId?: string,
  mode: LaunchMode = 'ask',
  model?: string,
  beforeWindow?: () => Promise<void>,
): Promise<{ pane: string; identity: PaneIdentity }> {
  await assertExecutionAllowed(root, project);
  // HIVE_AGENT names the pane's own agent: a `hive spawn` run inside the pane
  // reads it to record its parent, and the memory CLI already reports with it.
  // HIVE_PROJECT + HIVE_HUB_ROOT route the agent's ask_operator MCP calls.
  const quote = (v: string): string => `'${v.replaceAll("'", `'\\''`)}'`;
  const profile = await ensureAgentProfile(cwd, agent);
  await requireAgentCredential(cwd, project, agent);
  const credentialFile = process.env.HIVE_COLLABORATION_ENABLED === '1'
    ? `HIVE_COLLABORATION_ENABLED=1 HIVE_AGENT_REF=${quote(`${agent}@${cwd}`)} HIVE_AGENT_CREDENTIAL= HIVE_AGENT_CREDENTIAL_FILE=${quote(hivePath(cwd, 'team', agent, 'credential.env'))} ` : '';
  await assertExecutionAllowed(root, project);
  await beforeWindow?.();
  const pane = await newWindow(
    windowName(project, agent),
    cwd,
    `HIVE_AGENT=${agent} HIVE_PROJECT=${project} HIVE_HUB_ROOT=${quote(path.resolve(root))} ${credentialFile}${launchCommand(sessionId, mode, model, profile)}`,
  );
  const deadline = Date.now() + 15_000;
  let identity: PaneIdentity | null = null;
  try {
    while (Date.now() < deadline) {
      identity = await paneIdentity(pane);
      if (identity) return { pane, identity };
      await sleep(500);
    }
  } catch (error) {
    await killWindow(pane, identity ?? undefined).catch((cleanupError: unknown) => {
      const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new Error(`new pane cleanup failed: ${detail}`, { cause: error });
    });
    throw error;
  }
  await killWindow(pane).catch((cleanupError: unknown) => {
    const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    throw new Error(`new pane cleanup failed: ${detail}`);
  });
  throw new Error(`pane ${pane} never got a process identity`);
}

async function hashRuntimeDirectory(worktree: string, relative: string, runtime_files: Record<string, string>): Promise<void> {
  const entries = await fs.readdir(path.join(worktree, relative), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = path.posix.join(relative, entry.name);
    if (child === '.hive-hub/launches') continue;
    if (entry.isDirectory()) await hashRuntimeDirectory(worktree, child, runtime_files);
    else if (entry.isFile()) runtime_files[child] = valueDigest(await fs.readFile(path.join(worktree, child), 'utf8'));
  }
}

async function launchRuntimeEvidence(
  worktree: string, agent: string, handoff: string, launchClaim: string, launchClaimDigest: string,
) {
  const runtime_files: Record<string, string> = {};
  for (const relative of [`team/${agent}/role.md`, `team/${agent}/RULES.md`, `team/${agent}/agent.md`, `team/${agent}/credential.env`]) {
    const content = await fs.readFile(hivePath(worktree, relative), 'utf8').catch(() => null);
    if (content !== null) runtime_files[`.hive/${relative}`] = valueDigest(content);
  }
  await hashRuntimeDirectory(worktree, '.hive-hub', runtime_files);
  const claim = await fs.readFile(path.join(worktree, launchClaim), 'utf8').catch(() => null);
  return {
    runtime_files,
    launch_claim_path: launchClaim,
    launch_claim_digest: launchClaimDigest,
    launch_claim_in_worktree: claim !== null,
    launch_claim_completed: false,
    handoff_path: path.relative(worktree, handoff).split(path.sep).join('/'),
    handoff_digest: valueDigest(await fs.readFile(handoff, 'utf8')),
  };
}

async function captureTeamStateHash(home: string, worktree: string): Promise<string | undefined> {
  return withTeamLock(home, async () => {
    const content = await fs.readFile(hivePath(worktree, 'team.json'), 'utf8').catch(() => null);
    return content === null ? undefined : valueDigest(content);
  });
}

type LaunchResult = { pane: string; identity: PaneIdentity; home: string; worktree: string; admission?: TmuxAdmission };

async function finishLaunch(root: string, claim: string, result: LaunchResult): Promise<void> {
  if (!result.admission) {
    await fs.rm(path.join(result.worktree, claim), { force: true });
    return;
  }
  await completeTmuxLaunch(
    root, result.home, result.admission.task, result.admission.agent, result.admission.lease_id, result.worktree, claim,
  );
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
  if (!p) throw new Error(`unknown project: ${project} (add it with: hive hub add ${project} [path])`);
  return p;
}

async function admissionRequest(
  root: string, taskId: string, outputClaim: string, old?: TeamEntry,
): Promise<Parameters<typeof admitTmux>[4]> {
  const project = taskId.replace(/-\d+$/, '');
  if (!new RegExp(`^${project}-\\d+$`).test(taskId) || project.includes('/')) {
    throw new Error(`a task id is ${project}-<n>: ${taskId}`);
  }
  const brief = await fs.readFile(hubPath(root, 'tasks', `${taskId}.md`), 'utf8').catch(() => null);
  if (brief === null) throw new Error(`no task file for ${taskId}`);
  const parsedScope = taskScope(brief);
  if (parsedScope.kind === 'invalid') throw new Error(`${taskId}: ${parsedScope.why}; fix the brief before spawning on it`);
  const task = foldTasks(await readTaskEvents(root)).find((candidate) => candidate.id === taskId);
  if (!task?.plan_approved) {
    throw new Error(`${taskId} has no approved plan; the owner approves the plan before workers spawn`);
  }
  if (!task.contract || !task.plan_digest) throw new Error(`${taskId} has no current root contract grant`);
  return {
    parent_id: taskId,
    plan_digest: task.plan_digest,
    output_claim: old?.output_claim ?? outputClaim,
    acceptance_ids: old?.acceptance_ids ?? task.contract.acceptance.map((acceptance) => acceptance.id),
    provenance: old?.provenance ?? task.contract.provenance,
    write_scope: old?.write_scope ?? task.contract.write_scope,
    adapter: 'tmux',
    budget: { depth: 1, attempts: task.contract.budget.attempts },
    ...(old ? {
      retry_of: old.name,
      retry_lease_id: old.lease_id,
      retry_plan_digest: old.plan_digest,
      lineage_id: old.lineage_id,
    } : {}),
  };
}

export type WorkerContract = { assignment: string; deliverable: string };
export type SpawnOptions = {
  agent: string;
  role?: string;
  worktree?: string;
  task?: string;
  model?: string;
  parent?: string;
  assignment?: string;
  deliverable?: string;
};

function checkWorkerContract(contract: Partial<WorkerContract>): asserts contract is WorkerContract {
  for (const field of ['assignment', 'deliverable'] as const) {
    const value = contract[field];
    if (typeof value !== 'string' || value.trim().length < 12 || value.length > 8000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
      throw new Error('a worker needs an assignment and deliverable (12-8000 characters each, no control characters)');
    }
    if (/you were just spawned|wait for (?:the |its )?first message/i.test(value)) {
      throw new Error('a worker assignment and deliverable must name concrete work, not a request for another brief');
    }
    if (/^#{1,6} /m.test(value)) {
      throw new Error('a worker assignment and deliverable must not contain Markdown heading lines');
    }
  }
}

function contractSection(text: string, field: string): string | undefined {
  return text.match(new RegExp(`^### ${field}\\s*\\n([\\s\\S]*?)(?=^#{1,6} |(?![\\s\\S]))`, 'm'))?.[1];
}

function replaceContractSection(text: string, field: string, value: string): string {
  const progress = field === 'Deliverable' && contractSection(text, 'Progress') === undefined
    ? '### Progress\n\n'
    : '';
  const section = `### ${field}\n${value.trim()}\n\n${progress}`;
  const pattern = new RegExp(`^### ${field}\\s*\\n[\\s\\S]*?(?=^#{1,6} |(?![\\s\\S]))`, 'm');
  if (pattern.test(text)) return text.replace(pattern, section);
  const marker = '## START HERE\n';
  return text.includes(marker) ? text.replace(marker, marker + section) : `${text.trimEnd()}\n\n${section}`;
}

async function writeWorkerContract(
  worktree: string, agent: string, contract: Partial<WorkerContract>, recordedFile?: string,
): Promise<string> {
  checkWorkerContract(contract);
  const file = recordedFile ?? hivePath(worktree, 'handoffs', `${agent}.md`);
  let text = await fs.readFile(file, 'utf8').catch((e: unknown) => {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw e;
  });
  if (!text) text = `# ${agent} handoff\n\n## START HERE\n`;
  const oldSections = [contractSection(text, 'Assignment'), contractSection(text, 'Deliverable')];
  if (oldSections.some((value) => value && /^\s*Progress:/m.test(value)) && contractSection(text, 'Progress') === undefined) {
    throw new Error(`hive: move legacy Progress under its own heading in ${file} before respawn`);
  }
  text = replaceContractSection(text, 'Assignment', contract.assignment);
  text = replaceContractSection(text, 'Deliverable', contract.deliverable);
  text = text.replace(/^You were just spawned\. Wait for the first message.*\n?/m, '');
  text = text.replace(/^Wait for (?:the first message|a message)\.\n?/m, '');
  await writeNoFollow(file, text.endsWith('\n') ? text : `${text}\n`, recordedFile ? path.dirname(file) : worktree);
  return file;
}

async function requireWorkerContract(old: TeamEntry, home: string): Promise<void> {
  const file = old.handoff ?? hivePath(old.worktree || home, 'handoffs', `${old.name}.md`);
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  try {
    checkWorkerContract({
      assignment: contractSection(text, 'Assignment'),
      deliverable: contractSection(text, 'Deliverable'),
    });
  } catch {
    throw new Error(`${old.name} needs Assignment and Deliverable sections in ${file}; repair them with explicit respawn options`);
  }
}

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
  await assertExecutionAllowed(root, project);
  if (!AGENT_NAME_RE.test(opts.agent)) throw new Error(`an agent name is lowercase letters, digits, '-': ${opts.agent}`);
  checkWorkerContract(opts);
  checkModel(opts.model);
  await preflight();
  const launched = await withLaunchClaim(root, project,
    (p, launchClaim, launchClaimDigest) => spawnRegisteredAgent(root, p, opts, launchClaim, launchClaimDigest));
  return launched.pane;
}

async function spawnRegisteredAgent(
  root: string,
  p: ProjectsFile['projects'][number],
  opts: SpawnOptions,
  launchClaim: string,
  launchClaimDigest: string,
): Promise<LaunchResult> {
  const { agent, role = 'implementer' } = opts;
  const project = p.name;
  const home = p.home;
  if ((await readTeam(home)).agents.some((entry) => entry.name === agent)) {
    throw new Error(`${project} already has an agent named ${agent} (close or respawn it)`);
  }
  const task = opts.task;
  const worktree = opts.worktree ? path.resolve(home, opts.worktree) : hivePath(home, 'lanes', agent);
  const parent = opts.parent ?? envParent(agent);
  const model = opts.model ?? DEFAULT_MODEL;
  const admission = task ? await admitTmux(
    root, home, task, agent, await admissionRequest(root, task, opts.deliverable!),
    { parent, worktree, model },
  ) : undefined;

  let launched: { pane: string; identity: PaneIdentity } | null = null;
  let registered: TeamEntry | undefined;
  let jjLane: { name: string; path: string } | null = null;
  let hookInstallFailed = false;
  const worktreeExisted = existsSync(worktree);
  try {
    // Neither jj workspace add nor git worktree add creates missing parent dirs.
    await fs.mkdir(path.dirname(worktree), { recursive: true });
    // jj root answers only inside a jj repo; a failure tries git next.
    const jjRepo = (await run('jj', ['root'], home)).code === 0;
    const plainFolder = !opts.worktree && !jjRepo &&
      (await run('git', ['rev-parse', '--is-inside-work-tree'], home)).code !== 0;
    if (jjRepo) {
      const base = await jjBaseRev(home);
      const existed = existsSync(worktree);
      const made = await run('jj', ['-R', home, 'workspace', 'add', worktree, '-r', base], home);
      if (made.code !== 0) {
        // jj can register the workspace and create the dir yet still fail.
        if (!existed && existsSync(worktree)) await undoJjWorkspace(home, path.basename(worktree), worktree);
        throw new Error(`jj workspace add failed: ${made.stderr.trim()}`);
      }
      jjLane = { name: path.basename(worktree), path: worktree };
      if (existsSync(path.join(worktree, 'scripts', 'install-git-hooks.sh'))) {
        const hooks = await run('bash', ['scripts/install-git-hooks.sh'], worktree);
        hookInstallFailed = hooks.code !== 0;
      }
      await manifestAdd(home, { kind: 'jj-workspace', at: new Date().toISOString(), path: worktree });
    } else if (plainFolder) {
      await fs.mkdir(worktree, { recursive: true });
    } else {
      const branch = `${project}/${agent}`;
      const head = await run('git', ['rev-parse', '--verify', '-q', 'HEAD'], home);
      if (head.code !== 0 && head.code !== 1) {
        throw new Error(`git HEAD lookup failed: ${head.stderr.trim() || `exit ${head.code}`}`);
      }
      const add = head.code === 0
        ? ['worktree', 'add', '-q', '-b', branch, worktree, 'HEAD']
        : ['worktree', 'add', '-q', '--orphan', '-b', branch, worktree];
      const made = await run('git', add, home);
      if (made.code !== 0) throw new Error(`git worktree add failed: ${made.stderr.trim()}`);
      await manifestAdd(home, { kind: 'worktree', at: new Date().toISOString(), path: worktree, branch });
    }

    await ensureAgentFiles(worktree, agent, role);
    await writeWorkerContract(worktree, agent, opts);
    if (task) {
      // Recall never blocks a spawn: memoryBlockFor fails open in 3s.
      const block = await memoryBlockFor(root, project, task);
      if (block) await applyMemoryBlock(hivePath(worktree, 'handoffs', `${agent}.md`), block);
    }
    let evidence: Awaited<ReturnType<typeof launchRuntimeEvidence>> | undefined;
    let teamStateHash: string | undefined;
    launched = await launchWindow(root, project, agent, worktree, undefined, p.mode ?? 'ask', model, async () => {
      evidence = await launchRuntimeEvidence(
        worktree, agent, hivePath(worktree, 'handoffs', `${agent}.md`), launchClaim, launchClaimDigest,
      );
      teamStateHash = await captureTeamStateHash(home, worktree);
    });
    const { pane, identity } = launched;
    await manifestAdd(home, {
      kind: 'tmux', at: new Date().toISOString(), pane, window: windowName(project, agent),
      pane_pid: identity.pid, pane_started: identity.started,
    });
    const patch = {
      pane, pane_pid: identity.pid, pane_started: identity.started,
      worktree, handoff: hivePath(worktree, 'handoffs', `${agent}.md`), task, model, parent,
      launch_mode: p.mode ?? 'ask', launch_scoped_auto: p.mode === 'auto',
      migration_state: undefined, watch_authority_revoked_at: undefined,
      ...evidence!, team_state_hash: teamStateHash,
    };
    if (task && admission) {
      await projectEntry(root, project);
      await assertTmuxGrant(root, home, task, agent, admission.lease_id);
      registered = await registerTmuxLaunch(root, home, task, agent, admission.lease_id, patch);
    } else {
      registered = await withProjectLock(root, project, () => insertTeamEntry(home, { name: agent, ...patch }));
    }
    if (hookInstallFailed) {
      try {
        await appendDecision(root, {
          project, by: 'orchestrator',
          summary: `WARNING: worker ${agent} started without push hooks; repair push hooks before pushing`,
        });
      } catch (e) {
        console.error(`hive: the decision was not logged: ${e instanceof Error ? e.message : e}`);
      }
    }

    const idle = await waitIdleTrust(pane, worktreeExisted ? undefined : { cwd: worktree, identity });
    if (idle === 'dialog' && p.mode === 'auto') {
      await finishLaunch(root, launchClaim, { pane, identity, home, worktree, admission });
      return { pane, identity, home, worktree, admission };
    }
    if (idle !== 'idle') {
      throw new Error(idle === 'dialog'
        ? `a dialog is on the screen of ${pane}; answer it in the pane, then respawn`
        : `${pane} never went idle; nothing was typed`);
    }
    if (task && admission) {
      await withTmuxGrant(root, home, task, agent, admission.lease_id, async () => {
        await assertExecutionAllowed(root, project);
        await typeLine(pane, pickupLine(root, project, agent), identity);
      });
    } else {
      await withProjectLock(root, project, async () => {
        await assertExecutionAllowed(root, project);
        await typeLine(pane, pickupLine(root, project, agent), identity);
      });
    }
    const sessionId = await findLatestSession(worktree, agent);
    if (sessionId && registered) {
      await withProjectLock(root, project, () => compareAndSwapTeamEntry(home, registered!, { session_id: sessionId }));
    }
    await finishLaunch(root, launchClaim, { pane, identity, home, worktree, admission });
    return { pane, identity, home, worktree, admission };
  } catch (error) {
    if (task) {
      await recordTmuxLaunchOutcome(root, home, task, agent, admission!.lease_id, error instanceof Error ? error.message : String(error));
    }
    if (launched) await killWindow(launched.pane, launched.identity).catch(() => {});
    if (jjLane) await undoJjWorkspace(home, jjLane.name, jjLane.path);
    throw error;
  }
}

export async function closeAgent(root: string, project: string, agent: string): Promise<void> {
  const home = (await projectEntry(root, project)).home;
  const team = await readTeam(home);
  const entry = team.agents.find((a) => a.name === agent);
  if (!entry) throw new Error(`${project} has no agent named ${agent}`);
  await killEntry(root, home, entry);
  if (entry.orchestrator) await clearPendingPane(root, project);
}

// Shared tail of respawnAgent and wakeAgent: new window, team record, pickup line.
async function relaunchAgent(
  root: string,
  p: ProjectsFile['projects'][number],
  old: TeamEntry,
  sessionId: string | undefined,
  admission?: TmuxAdmission,
): Promise<string> {
  const launched = await withLaunchClaim(root, p.name, (registered, launchClaim, launchClaimDigest) =>
    relaunchRegisteredAgent(root, registered, old, sessionId, launchClaim, launchClaimDigest, admission));
  return launched.pane;
}

async function relaunchRegisteredAgent(
  root: string,
  p: ProjectsFile['projects'][number],
  old: TeamEntry,
  sessionId: string | undefined,
  launchClaim: string,
  launchClaimDigest: string,
  admission?: TmuxAdmission,
): Promise<LaunchResult> {
  const home = p.home;
  const worktree = old.worktree || home;
  const mode = old.orchestrator ? effectiveOrchestratorMode(p.mode ?? 'ask', p.approvals) : p.mode ?? 'ask';
  let evidence: Awaited<ReturnType<typeof launchRuntimeEvidence>> | undefined;
  let teamStateHash: string | undefined;
  const { pane, identity } = await launchWindow(root, p.name, old.name, worktree, sessionId, mode, old.model, async () => {
    if (old.task) {
      evidence = await launchRuntimeEvidence(
        worktree, old.name, old.handoff ?? hivePath(worktree, 'handoffs', `${old.name}.md`), launchClaim, launchClaimDigest,
      );
      teamStateHash = await captureTeamStateHash(home, worktree);
    }
  });
  try {
    await manifestAdd(home, {
      kind: 'tmux', at: new Date().toISOString(), pane, window: windowName(p.name, old.name),
      pane_pid: identity.pid, pane_started: identity.started,
    });
    const patch = {
      pane, pane_pid: identity.pid, pane_started: identity.started,
      session_id: sessionId, model: old.model ?? DEFAULT_MODEL, closed_at: undefined, wedged_at: undefined,
      launch_mode: mode, launch_scoped_auto: mode === 'auto',
      migration_state: undefined, watch_authority_revoked_at: undefined,
      ...evidence, team_state_hash: teamStateHash,
    };
    let registered: TeamEntry | undefined;
    if (old.task && admission) {
      registered = await registerTmuxLaunch(root, home, old.task, old.name, admission.lease_id, patch, { allowClosed: true });
    } else {
      await withProjectLock(root, p.name, async () => {
        await assertEntryAlive(home, old, { pane, identity }, { allowStamped: true, cleanup: false });
        const fresh = (await readTeam(home)).agents.find((entry) => entry.name === old.name);
        if (fresh) registered = await compareAndSwapTeamEntry(home, fresh, patch) ?? undefined;
        if (!registered) throw new Error(`${old.name} was killed while its new pane came up`);
      });
    }
    const idle = await waitIdleTrust(pane);
    if (idle === 'dialog' && p.mode === 'auto') {
      await finishLaunch(root, launchClaim, { pane, identity, home, worktree, admission });
      return { pane, identity, home, worktree, admission };
    }
    if (idle !== 'idle') {
      throw new Error(idle === 'dialog'
        ? `a dialog is on the screen of ${pane}; answer it in the pane, then respawn`
        : `${pane} never went idle; nothing was typed`);
    }
    if (old.task && admission) {
      await withTmuxGrant(root, home, old.task, old.name, admission.lease_id, async () => {
        await assertExecutionAllowed(root, p.name);
        await typeLine(pane, pickupLine(root, p.name, old.name, old.handoff), identity);
      });
    } else {
      await withProjectLock(root, p.name, async () => {
        await assertExecutionAllowed(root, p.name);
        await typeLine(pane, pickupLine(root, p.name, old.name, old.handoff), identity);
      });
    }
    const sessionIdFound = await findLatestSession(worktree, old.name);
    if (sessionIdFound && registered) {
      await withProjectLock(root, p.name, () => compareAndSwapTeamEntry(home, registered!, { session_id: sessionIdFound }));
    }
    await finishLaunch(root, launchClaim, { pane, identity, home, worktree, admission });
    return { pane, identity, home, worktree, admission };
  } catch (error) {
    let cleanupError: unknown;
    await killWindow(pane, identity).catch((cause: unknown) => { cleanupError = cause; });
    if (cleanupError) {
      const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new Error(`new pane cleanup failed: ${detail}`, { cause: error });
    }
    throw error;
  }
}

async function admitReplacement(
  root: string, home: string, old: TeamEntry, resumeExternal = false,
): Promise<TmuxAdmission | undefined> {
  if (!old.task || old.orchestrator) return undefined;
  const externalResume = resumeExternal && old.external_operation_id !== undefined;
  return admitTmux(root, home, old.task, old.name, await admissionRequest(root, old.task, '', old), {
    parent: old.parent,
    worktree: old.worktree,
    model: old.model,
    externalOperationId: externalResume ? old.external_operation_id : undefined,
    resumeExternal: externalResume,
  });
}

export async function respawnAgent(
  root: string, project: string, agent: string, options: Partial<WorkerContract> = {},
): Promise<string> {
  await assertExecutionAllowed(root, project);
  const p = await projectEntry(root, project);
  const home = p.home;
  const old = (await readTeam(home)).agents.find((entry) => entry.name === agent);
  if (!old) throw new Error(`${project} has no agent named ${agent}`);
  const repair = !old.orchestrator && (options.assignment !== undefined || options.deliverable !== undefined);
  if (repair) checkWorkerContract(options);
  if (!old.orchestrator && !repair) await requireWorkerContract(old, home);
  checkModel(old.model);
  await preflight();
  if (old.task && !old.orchestrator) await admissionRequest(root, old.task, '', old);
  if (repair) await writeWorkerContract(old.worktree || home, agent, options, old.handoff);
  await assertExecutionAllowed(root, project);
  const admission = await admitReplacement(root, home, old);
  const reserved = admission
    ? (await readTeam(home)).agents.find((entry) => entry.lease_id === admission.lease_id)
    : old;
  const stamped = reserved
    ? await compareAndSwapTeamEntry(home, reserved, { closed_at: new Date().toISOString() })
    : null;
  if (!stamped) throw new Error(`${agent} was replaced before respawn`);
  try {
    if (old.pane) await killWindow(old.pane, recordedIdentity(old));
    return await relaunchAgent(root, p, old, undefined, admission);
  } catch (error) {
    if (old.task && !old.orchestrator) {
      await recordTmuxLaunchOutcome(root, home, old.task, agent, admission!.lease_id, error instanceof Error ? error.message : String(error));
    } else {
      await compareAndSwapTeamEntry(home, stamped, { closed_at: undefined });
    }
    throw error;
  }
}

// The watchdog's agent ensure: a dead agent with a recorded session comes back
// with that session resumed. A stamped close is never woken.
export async function wakeAgent(root: string, project: string, agent: string): Promise<string> {
  await assertExecutionAllowed(root, project);
  const p = await projectEntry(root, project);
  const old = (await readTeam(p.home)).agents.find((entry) => entry.name === agent);
  if (!old) throw new Error(`${project} has no agent named ${agent}`);
  if (old.closed_at) throw new Error(`${agent} was closed on purpose at ${old.closed_at}; not waking it`);
  if (!old.session_id) throw new Error(`${agent} has no recorded session to resume; respawn it instead`);
  if (!old.orchestrator) await requireWorkerContract(old, p.home);
  checkModel(old.model);
  await preflight();
  if (old.task && !old.orchestrator) await admissionRequest(root, old.task, '', old);
  if (old.pane && (await paneIs(old.pane, { pid: old.pane_pid ?? 0, started: old.pane_started ?? '' }))) {
    throw new Error(`${agent} is already running`);
  }
  const admission = await admitReplacement(root, p.home, old, true);
  try {
    return await relaunchAgent(root, p, old, old.session_id, admission);
  } catch (error) {
    if (old.task && !old.orchestrator) {
      await recordTmuxLaunchOutcome(root, p.home, old.task, agent, admission!.lease_id, error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
}
