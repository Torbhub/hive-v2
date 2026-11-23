import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeNoFollow } from './safe-write.js';
import { fileURLToPath } from 'node:url';
import {
  killWindow, newWindow, paneIdentity, paneIs, capturePane, processStartTime,
  sendArrow, sendEnter, sendLiteral, sleep, run, windowName, type PaneIdentity,
} from './tmux.js';
import { classify, dialogFingerprint, lines, parseDialog } from './screen.js';
import {
  appendDecision, canonicalJson, compareAndSwapTeamEntry, foldTasks, hivePath, hubPath, insertTeamEntry,
  manifestAdd, manifestRead, manifestUpdate, readProjects, readTaskEvents, readTeam, clearPendingPane, Refusal,
  valueDigest, withTeamLock, type PendingPane, type ProjectsFile,
} from './state.js';
import type { Approvals, ProjectMode, TeamEntry, TmuxAdmission } from './types.js';
import { releasePendingLaunchClaim, withLaunchClaim, withProjectLock } from './project.js';
import {
  admitTmux, assertTmuxGrant, completeTmuxLaunch, recordTmuxLaunchOutcome, registerTmuxLaunch, withTmuxGrant,
} from './admission.js';
import { taskScope } from './scope.js';
import { applyMemoryBlock, memoryBlockFor } from './memory.js';
import { assertEntryAlive, killEntry, recordedIdentity } from './kill.js';
import { requireAgentCredential } from './collaboration-credentials.js';
import { assertExecutionAllowed } from './rollout.js';
import { redactSecrets } from './logview.js';
import { assertModelConfigured } from './model-config.js';
export { assertEntryAlive } from './kill.js';

export function orchestratorName(project: string): string {
  return `${project}-orchestrator`;
}

export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(path.join(dir, 'roles', 'orchestrator.md'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('hive: cannot find roles/ above the running module');
}

export async function preflight(model: string): Promise<void> {
  await assertModelConfigured(model, DEFAULT_MODEL);
  const r = await run('teamkimi', ['status'], undefined, undefined, 10_000);
  if (r.code !== 0) {
    throw new Error('model preflight failed: the teamkimi proxy is down or did not respond within 10s. Start it with teamkimi server, then retry. Hive spawns nothing without it');
  }
}

const COMMENT_POLICY = 'Write no comments in any repository. This rule is additive to target-repo instructions. Record durable decisions with the target repo\'s ADR convention. Escalate conflicts to the orchestrator.';

export function pickupLine(root: string, project: string, agent: string, handoff?: string): string {
  const decisions = ` Decisions so far: read ${hubPath(root, 'decisions.jsonl')} — they are permanent.`;
  if (agent === orchestratorName(project)) {
    return `You are ${agent}, the orchestrator of project ${project}. Read .hive/handoffs/${agent}.md from the top: its START HERE block is your prompt. Your role: .hive/team/${agent}/role.md. The rules: .hive/team/${agent}/RULES.md. The owner talks to you only through the hub: report plans, questions, blockers and finished work to it.${decisions} ${COMMENT_POLICY}`;
  }
  return `You are ${agent} of project ${project}. Read ${handoff ?? `.hive/handoffs/${agent}.md`} from the top. Start with the Assignment and Deliverable in START HERE. Your role: .hive/team/${agent}/role.md. The rules: .hive/team/${agent}/RULES.md. Report the required deliverable to the orchestrator.${decisions} ${COMMENT_POLICY}`;
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
    const ls = lines(raw);
    const promptLine = [...ls].reverse().find((l) => /^\s*│\s*>/.test(l));
    if (!promptLine || !promptLine.includes(text.slice(0, 40))) return;
    if (screenGuard) await screenGuard(raw);
    await sendEnter(pane, identity);
  }
  throw new Error(`the line stayed in the prompt of ${pane}; not typed`);
}

const MODEL_RE = /^[A-Za-z0-9._/[\]-]{1,64}$/;

type LaunchMode = ProjectMode | 'supervised-auto';

export function effectiveOrchestratorMode(mode: ProjectMode, approvals?: Approvals): LaunchMode {
  return mode === 'ask' && (approvals === 'safe' || approvals === 'smart') ? 'supervised-auto' : mode;
}

export function checkModel(model: string | undefined): void {
  if (model !== undefined && !MODEL_RE.test(model)) {
    throw new Error(`a model alias is letters, digits, '.', '_', '-', '/', '[', ']': ${model}`);
  }
}

export const DEFAULT_MODEL = 'kimi-code/k3.1-pro-highspeed';

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
  return `KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run${args.length ? ` -- ${args.join(' ')}` : ''}`;
}

async function ensureAgentProfile(cwd: string, agent: string): Promise<string> {
  const file = hivePath(cwd, 'team', agent, 'agent.md');
  await writeNoFollow(file, `---\nname: hive-${agent}\ndescription: Hive-managed agent with structured operator questions\ndisallowedTools:\n  - AskUserQuestion\n---\n\n\${base_prompt}\n\nYou are a Hive agent. Do not use AskUserQuestion. Use mcp__hive-operator__ask_operator for every operator decision. Harness faults are Hive-owned errors to repair or degrade. Do not turn them into owner questions.\n${COMMENT_POLICY}\n`, cwd);
  return file;
}

function windowStartedError(error: unknown): Error {
  return Object.assign(error instanceof Error ? error : new Error(String(error)), { windowStarted: true });
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
  credentialCwd = cwd,
): Promise<{ pane: string; identity: PaneIdentity }> {
  await assertExecutionAllowed(root, project);
  const quote = (v: string): string => `'${v.replaceAll("'", `'\\''`)}'`;
  const profile = await ensureAgentProfile(cwd, agent);
  await requireAgentCredential(credentialCwd, project, agent);
  const credentialFile = process.env.HIVE_COLLABORATION_ENABLED === '1'
    ? `HIVE_COLLABORATION_ENABLED=1 HIVE_AGENT_REF=${quote(`${agent}@${cwd}`)} HIVE_AGENT_CREDENTIAL= HIVE_AGENT_CREDENTIAL_FILE=${quote(hivePath(credentialCwd, 'team', agent, 'credential.env'))} ` : '';
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
    let cleanupError: unknown;
    await killWindow(pane, identity ?? undefined).catch((cause: unknown) => { cleanupError = cause; });
    if (cleanupError) {
      const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw windowStartedError(new Error(`new pane cleanup failed: ${detail}`, { cause: error }));
    }
    throw windowStartedError(error);
  }
  let cleanupError: unknown;
  await killWindow(pane).catch((cause: unknown) => { cleanupError = cause; });
  if (cleanupError) {
    const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    throw windowStartedError(new Error(`new pane cleanup failed: ${detail}`));
  }
  throw windowStartedError(new Error(`pane ${pane} never got a process identity`));
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

type LaunchLease = Pick<TmuxAdmission, 'task' | 'agent' | 'lease_id'>;

type LaunchResult = {
  pane: string;
  identity: PaneIdentity;
  home: string;
  worktree: string;
  admission?: LaunchLease;
  claimPending?: boolean;
};

async function registerPendingWorkerLaunch(
  root: string,
  project: string,
  home: string,
  registered: TeamEntry,
  worktree: string,
  launchClaim: string,
  launchClaimDigest: string,
  jjWorkspace?: string,
): Promise<void> {
  const pane = registered.pane!;
  const raw = await capturePane(pane);
  const dialog = raw === null ? null : parseDialog(lines(raw));
  if (!dialog || dialog.kind === 'none') throw new Error(`${pane} dialog disappeared before it was recorded`);
  const launch_pending: NonNullable<TeamEntry['launch_pending']> = {
    at: new Date().toISOString(), agent: registered.name, pane,
    pane_pid: registered.pane_pid!, pane_started: registered.pane_started!,
    worktree, task: registered.task, lease_id: registered.lease_id,
    launch_claim_path: launchClaim, launch_claim_digest: launchClaimDigest,
    dialog: redactSecrets(dialog.text).slice(0, 4000), fingerprint: dialog.fingerprint,
    jj_workspace: jjWorkspace,
  };
  const pendingRegistration = await withProjectLock(
    root, project,
    () => compareAndSwapTeamEntry(home, registered, {
      launch_pending,
      worktree,
      launch_claim_path: launchClaim,
      launch_claim_digest: launchClaimDigest,
      launch_claim_in_worktree: registered.launch_claim_in_worktree ?? false,
      launch_claim_completed: false,
    }),
  );
  if (!pendingRegistration) throw new Error(`${registered.name} changed while its dialog launch was recorded`);
}

async function finishLaunch(root: string, claim: string, result: LaunchResult): Promise<void> {
  if (!result.admission) {
    await fs.rm(path.join(result.worktree, claim), { force: true });
    return;
  }
  await completeTmuxLaunch(
    root, result.home, result.admission.task, result.admission.agent, result.admission.lease_id, result.worktree, claim,
  );
}

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
export type RespawnOptions = Partial<WorkerContract> & { model?: string };
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

async function jjBaseRev(home: string): Promise<string> {
  for (const rev of ['main@origin', 'main', '@']) {
    const probe = await run('jj', ['-R', home, 'log', '-r', rev, '-T', "''", '--no-graph', '--limit', '1'], home);
    if (probe.code === 0) return rev;
  }
  throw new Error(`jj: no base revision in ${home} (tried main@origin, main, @)`);
}

async function removeLaneManifest(home: string, worktree: string): Promise<void> {
  await manifestUpdate(home, (records) => records.filter((record) =>
    !(record.kind === 'worktree' || record.kind === 'jj-workspace') || record.path !== worktree));
}

async function undoJjWorkspace(home: string, name: string, wt: string): Promise<void> {
  const dest = path.join(hivePath(home, 'trash', new Date().toISOString().slice(0, 10)), `${name}-${randomUUID()}`);
  const errors: unknown[] = [];
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rename(wt, dest).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(error);
  });
  const forgotten = await run('jj', ['-R', home, 'workspace', 'forget', name], home).catch((error: unknown) => {
    errors.push(error);
    return null;
  });
  if (forgotten && forgotten.code !== 0) {
    errors.push(new Error(`jj workspace forget failed: ${forgotten.stderr.trim() || `exit ${forgotten.code}`}`));
  }
  if (!errors.length && forgotten?.code === 0) {
    const pruned = await run('git', ['worktree', 'prune'], home).catch((error: unknown) => {
      errors.push(error);
      return null;
    });
    if (pruned && pruned.code !== 0) {
      errors.push(new Error(`git worktree prune failed: ${pruned.stderr.trim() || `exit ${pruned.code}`}`));
    }
  }
  if (errors.length) throw new AggregateError(errors, `failed to roll back jj workspace ${wt}`);
  await removeLaneManifest(home, wt);
}

async function undoGitWorktree(home: string, worktree: string, branch: string): Promise<void> {
  const errors: unknown[] = [];
  const removed = await run('git', ['worktree', 'remove', '--force', worktree], home).catch((error: unknown) => {
    errors.push(error);
    return null;
  });
  if (removed && removed.code !== 0) {
    errors.push(new Error(`git worktree remove failed: ${removed.stderr.trim() || `exit ${removed.code}`}`));
  }
  const deleted = await run('git', ['branch', '-D', branch], home).catch((error: unknown) => {
    errors.push(error);
    return null;
  });
  if (deleted && deleted.code !== 0) {
    errors.push(new Error(`git branch rollback failed: ${deleted.stderr.trim() || `exit ${deleted.code}`}`));
  }
  if (errors.length) throw new AggregateError(errors, `failed to roll back git worktree ${worktree}`);
  await removeLaneManifest(home, worktree);
}

async function canonicalWorktree(worktree: string): Promise<string> {
  return fs.realpath(worktree).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path.resolve(worktree);
    throw error;
  });
}

function worktreesOverlap(left: string, right: string): boolean {
  const contained = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  return contained(left, right) || contained(right, left);
}

export async function assertWorktreeNotShared(home: string, worktree: string, self?: TeamEntry): Promise<void> {
  const expected = await canonicalWorktree(worktree);
  for (const candidate of (await readTeam(home)).agents) {
    if (self && canonicalJson(candidate) === canonicalJson(self)) continue;
    if (candidate.closed_at || !candidate.pane || !candidate.worktree) continue;
    if (!await paneIs(candidate.pane, { pid: candidate.pane_pid ?? 0, started: candidate.pane_started ?? '' })) continue;
    if (worktreesOverlap(await canonicalWorktree(candidate.worktree), expected)) {
      throw new Refusal(`worktree ${worktree} overlaps live agent ${candidate.name} at ${candidate.worktree}`);
    }
  }
}

export async function verifiedPendingPaneIdentity(pending: PendingPane): Promise<PaneIdentity> {
  if (typeof pending.pane_pid !== 'number' || !pending.pane_started) {
    throw new Refusal(`pending pane ${pending.pane} has no recorded process identity`);
  }
  const expected = { pid: pending.pane_pid, started: pending.pane_started };
  const current = await paneIdentity(pending.pane);
  if (!current || current.pid !== expected.pid || current.started !== expected.started) {
    throw new Refusal(`pending pane ${pending.pane} has a stale or reused process identity`);
  }
  return current;
}

export async function assertNoLiveAgentReplacement(
  home: string, project: string, agent: string, old?: TeamEntry,
): Promise<void> {
  const records = (await manifestRead(home)).filter((record) => record.kind === 'tmux' && record.window === windowName(project, agent));
  let currentRecord = -1;
  records.forEach((record, index) => {
    if (old?.pane === record.pane && old?.pane_pid === record.pane_pid && old?.pane_started === record.pane_started) currentRecord = index;
  });
  for (const record of records.slice(currentRecord + 1)) {
    if (typeof record.pane !== 'string' || typeof record.pane_pid !== 'number' || typeof record.pane_started !== 'string') continue;
    if (await paneIs(record.pane, { pid: record.pane_pid, started: record.pane_started })) {
      throw new Refusal(`${agent} has a verified live replacement in pane ${record.pane}; refusing a duplicate launch`);
    }
  }
}

async function freshWorktree(home: string, agent: string, requested?: string): Promise<string> {
  if (requested?.split(/[\\/]/).includes('..')) throw new Refusal(`unsafe worktree traversal: ${requested}`);
  const worktree = requested ? path.resolve(home, requested) : hivePath(home, 'lanes', agent);
  const canonical = hivePath(home, 'lanes', agent);
  if (worktree !== canonical) throw new Refusal(`worktree must be the canonical lane ${canonical}`);
  const relative = path.relative(home, worktree);
  let current = home;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) throw new Refusal(`unsafe symlink in worktree path: ${current}`);
  }
  return worktree;
}

export async function withAgentLaneReservation<T>(
  home: string, project: string, agent: string, requested: string | undefined,
  fn: (worktree: string) => Promise<T>,
): Promise<T> {
  const worktree = await freshWorktree(home, agent, requested);
  await assertWorktreeNotShared(home, worktree);
  await assertNoLiveAgentReplacement(home, project, agent);
  const reservation = hivePath(home, 'lanes', `.${agent}.reserve`);
  try {
    await fs.mkdir(path.dirname(reservation), { recursive: true });
    await fs.mkdir(reservation);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Refusal(`${agent} already has a pending lane reservation`);
    }
    throw error;
  }
  try {
    return await fn(worktree);
  } finally {
    await fs.rm(reservation, { recursive: true, force: true });
  }
}

export type AgentLane = {
  worktree: string;
  existed: boolean;
  jjWorkspace?: string;
  hookInstallFailed: boolean;
  rollback: () => Promise<void>;
};

export async function allocateAgentLane(home: string, project: string, agent: string, requested?: string): Promise<AgentLane> {
  const worktree = await freshWorktree(home, agent, requested);
  const existed = existsSync(worktree);
  if (existed) {
    const preserved = (await manifestRead(home)).find((record) =>
      (record.kind === 'worktree' || record.kind === 'jj-workspace') && record.path === worktree);
    if (preserved) {
      return {
        worktree, existed, hookInstallFailed: false, rollback: async () => {},
        ...(preserved.kind === 'jj-workspace' ? { jjWorkspace: agent } : {}),
      };
    }
  }
  let rollback: (() => Promise<void>) | undefined;
  try {
    await fs.mkdir(path.dirname(worktree), { recursive: true });
    const jjRepo = (await run('jj', ['root'], home)).code === 0;
    const plainFolder = !jjRepo
      && (await run('git', ['rev-parse', '--is-inside-work-tree'], home)).code !== 0;
    if (jjRepo) {
      const base = await jjBaseRev(home);
      const name = path.basename(worktree);
      const made = await run('jj', ['-R', home, 'workspace', 'add', worktree, '-r', base], home);
      if (made.code !== 0) {
        if (!existed && existsSync(worktree)) rollback = () => undoJjWorkspace(home, name, worktree);
        throw new Error(`jj workspace add failed: ${made.stderr.trim()}`);
      }
      rollback = existed ? async () => {} : () => undoJjWorkspace(home, name, worktree);
      let hookInstallFailed = false;
      if (existsSync(path.join(worktree, 'scripts', 'install-git-hooks.sh'))) {
        const hooks = await run('bash', ['scripts/install-git-hooks.sh'], worktree);
        hookInstallFailed = hooks.code !== 0;
      }
      await manifestAdd(home, { kind: 'jj-workspace', at: new Date().toISOString(), path: worktree, workspace_name: name });
      return { worktree, existed, jjWorkspace: name, hookInstallFailed, rollback };
    }
    if (plainFolder) {
      if (existed) return { worktree, existed, hookInstallFailed: false, rollback: async () => {} };
      await fs.mkdir(worktree, { recursive: true });
      rollback = () => fs.rm(worktree, { recursive: true, force: true });
      return { worktree, existed, hookInstallFailed: false, rollback };
    }
    const branch = `${project}/${agent}`;
    const head = await run('git', ['rev-parse', '--verify', '-q', 'HEAD'], home);
    if (head.code !== 0 && head.code !== 1) {
      throw new Error(`git HEAD lookup failed: ${head.stderr.trim() || `exit ${head.code}`}`);
    }
    const add = head.code === 0
      ? ['worktree', 'add', '-q', '-b', branch, worktree, 'HEAD']
      : ['worktree', 'add', '-q', '--orphan', '-b', branch, worktree];
    const made = await run('git', add, home);
    if (made.code !== 0) {
      if (!existed && existsSync(worktree)) rollback = () => undoGitWorktree(home, worktree, branch);
      throw new Error(`git worktree add failed: ${made.stderr.trim()}`);
    }
    rollback = existed ? async () => {} : () => undoGitWorktree(home, worktree, branch);
    await manifestAdd(home, { kind: 'worktree', at: new Date().toISOString(), path: worktree, branch });
    return { worktree, existed, hookInstallFailed: false, rollback };
  } catch (error) {
    if (!rollback) throw error;
    try {
      await rollback();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
}

function envParent(self: string): string | undefined {
  const v = process.env.HIVE_AGENT;
  return v && v !== self && AGENT_NAME_RE.test(v) ? v : undefined;
}

export async function spawnAgent(root: string, project: string, opts: SpawnOptions): Promise<string> {
  await assertExecutionAllowed(root, project);
  if (!AGENT_NAME_RE.test(opts.agent)) throw new Error(`an agent name is lowercase letters, digits, '-': ${opts.agent}`);
  checkWorkerContract(opts);
  const model = opts.model ?? DEFAULT_MODEL;
  checkModel(model);
  const p = await projectEntry(root, project);
  return withAgentLaneReservation(p.home, project, opts.agent, opts.worktree, async () => {
    await preflight(model);
    const launched = await withLaunchClaim(
      root, project,
      (registered, launchClaim, launchClaimDigest) => spawnRegisteredAgent(root, registered, opts, launchClaim, launchClaimDigest),
      { preserveClaim: (result) => result.claimPending === true },
    );
    return launched.pane;
  });
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

  let lane: Awaited<ReturnType<typeof allocateAgentLane>> | undefined;
  let launched: { pane: string; identity: PaneIdentity } | null = null;
  let registered: TeamEntry | undefined;
  try {
    lane = await allocateAgentLane(home, project, agent, opts.worktree);
    await ensureAgentFiles(worktree, agent, role);
    await writeWorkerContract(worktree, agent, opts);
    if (task) {
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
    if (lane.hookInstallFailed) {
      try {
        await appendDecision(root, {
          project, by: 'orchestrator',
          summary: `WARNING: worker ${agent} started without push hooks; repair push hooks before pushing`,
        });
      } catch (e) {
        console.error(`hive: the decision was not logged: ${e instanceof Error ? e.message : e}`);
      }
    }

    const idle = await waitIdleTrust(pane, lane.existed ? undefined : { cwd: worktree, identity });
    if (idle === 'dialog') {
      if (!registered) throw new Error(`${agent} launch was not registered`);
      await registerPendingWorkerLaunch(root, project, home, registered, worktree, launchClaim, launchClaimDigest, lane.jjWorkspace);
      return { pane, identity, home, worktree, admission, claimPending: true };
    }
    if (idle !== 'idle') throw new Error(`${pane} never went idle; nothing was typed`);
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
      const withSession = await withProjectLock(root, project, () =>
        compareAndSwapTeamEntry(home, registered!, { session_id: sessionId }));
      if (!withSession) throw new Error(`${agent} session registration changed before finalization`);
      registered = withSession;
    }
    await finishLaunch(root, launchClaim, { pane, identity, home, worktree, admission });
    return { pane, identity, home, worktree, admission };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    let paneCleanupFailed = false;
    if (launched) {
      await killWindow(launched.pane, launched.identity).catch((cleanup: unknown) => {
        paneCleanupFailed = true;
        cleanupErrors.push(cleanup);
      });
    }
    if (registered && !task && !paneCleanupFailed) {
      try {
        const removed = await compareAndSwapTeamEntry(home, registered, null);
        if (removed === undefined) throw new Error(`${agent} registration changed during rollback`);
      } catch (cleanup) {
        cleanupErrors.push(cleanup);
      }
    }
    if (task) {
      await recordTmuxLaunchOutcome(root, home, task, agent, admission!.lease_id, error instanceof Error ? error.message : String(error))
        .catch((cleanup: unknown) => { cleanupErrors.push(cleanup); });
    }
    const possibleWork = launched !== null || (error as { windowStarted?: boolean }).windowStarted === true;
    if (lane && !possibleWork) await lane.rollback().catch((cleanup: unknown) => { cleanupErrors.push(cleanup); });
    if (cleanupErrors.length) {
      throw new AggregateError([error, ...cleanupErrors], error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
}

type PendingLaunch = NonNullable<TeamEntry['launch_pending']>;
type PendingAnswer = { fingerprint: string; choice: string; option: string; approved: boolean };

function assertPendingIdentity(entry: TeamEntry, pending: PendingLaunch): PaneIdentity {
  const identity = { pid: pending.pane_pid, started: pending.pane_started };
  if (pending.agent !== entry.name || pending.pane !== entry.pane
    || entry.pane_pid !== identity.pid || entry.pane_started !== identity.started
    || entry.worktree !== pending.worktree || entry.task !== pending.task || entry.lease_id !== pending.lease_id
    || entry.launch_claim_path !== pending.launch_claim_path || entry.launch_claim_digest !== pending.launch_claim_digest
    || entry.closed_at || entry.lease_revoked || (entry.task && !entry.lease_id)) {
    throw new Refusal(`${entry.name} pending launch identity changed. Read its current state before answering again`);
  }
  return identity;
}

export function pendingApprovalFingerprint(entry: TeamEntry): string {
  const pending = entry.launch_pending!;
  return dialogFingerprint(JSON.stringify([
    pending.fingerprint, pending.agent, pending.pane, pending.pane_pid, pending.pane_started,
    pending.worktree, pending.lease_id ?? null, pending.launch_claim_digest,
  ]));
}

export async function pendingWorkerAnswerTarget(
  root: string, project: string, agentRef: string | undefined, pane: string | undefined, fingerprint: string,
): Promise<TeamEntry | undefined> {
  if (!agentRef) return undefined;
  const p = await projectEntry(root, project);
  const [name, worktree] = agentRef.split('@');
  const matches = (await readTeam(p.home)).agents.filter(
    (candidate) => !candidate.orchestrator && candidate.name === name
      && (worktree === undefined || candidate.worktree === worktree),
  );
  const entry = matches.length === 1 ? matches[0] : undefined;
  const pending = entry?.launch_pending;
  if (!entry || !pending) return undefined;
  if (pendingApprovalFingerprint(entry) !== fingerprint || pane !== undefined && entry.pane !== pane) {
    throw new Refusal(`${name} pending launch approval or pane changed. Read it again before answering`);
  }
  assertPendingIdentity(entry, pending);
  return entry;
}

async function updatePendingEntry(home: string, entry: TeamEntry, update: Partial<TeamEntry>): Promise<TeamEntry> {
  const updated = await compareAndSwapTeamEntry(home, entry, update);
  if (!updated) throw new Refusal(`${entry.name} pending launch changed during recovery`);
  return updated;
}

function assertPendingAnswer(pending: PendingLaunch, answer: PendingAnswer): void {
  if (pending.answer_choice !== undefined
    && (pending.answer_choice !== answer.choice || pending.answer_option !== answer.option
      || pending.approved !== answer.approved)) {
    throw new Refusal(`${pending.agent} pending launch already has a different recorded answer`);
  }
}

export async function recordPendingWorkerAnswer(
  root: string, project: string, agentRef: string | undefined, pane: string, answer: PendingAnswer,
): Promise<void> {
  const entry = await pendingWorkerAnswerTarget(root, project, agentRef, pane, answer.fingerprint);
  if (!entry) return;
  const pending = entry.launch_pending!;
  assertPendingAnswer(pending, answer);
  const home = (await projectEntry(root, project)).home;
  await updatePendingEntry(home, entry, {
    launch_pending: {
      ...pending, answer_choice: answer.choice, answer_option: answer.option, approved: answer.approved,
    },
  });
}

export async function markPendingWorkerAnswerDelivered(
  root: string, project: string, agentRef: string | undefined, pane: string, answer: PendingAnswer,
): Promise<void> {
  const entry = await pendingWorkerAnswerTarget(root, project, agentRef, pane, answer.fingerprint);
  if (!entry) return;
  const pending = entry.launch_pending!;
  assertPendingAnswer(pending, answer);
  const home = (await projectEntry(root, project)).home;
  await updatePendingEntry(home, entry, {
    launch_pending: { ...pending, dialog_delivered: true },
  });
}

async function releaseResume(home: string, entry: TeamEntry): Promise<void> {
  const token = entry.launch_pending!.resume_token;
  const current = (await readTeam(home)).agents.find(
    (candidate) => candidate.name === entry.name && candidate.launch_pending?.resume_token === token,
  );
  if (!current?.launch_pending) return;
  await updatePendingEntry(home, current, {
    launch_pending: {
      ...current.launch_pending,
      resume_token: undefined, resume_pid: undefined, resume_started: undefined,
    },
  });
}

async function abortPendingLaunch(root: string, home: string, entry: TeamEntry, error: unknown): Promise<void> {
  const pending = entry.launch_pending!;
  const reason = error instanceof Error ? error.message : String(error);
  const detail = redactSecrets(`${reason}\n${pending.dialog}`).slice(0, 4000);
  let failed = await updatePendingEntry(home, entry, {
    closed_at: new Date().toISOString(), launch_error: detail,
    launch_pending: { ...pending, resume_token: undefined, resume_pid: undefined, resume_started: undefined },
  });
  if (failed.task && failed.lease_id) {
    await recordTmuxLaunchOutcome(root, home, failed.task, failed.name, failed.lease_id, detail);
    failed = (await readTeam(home)).agents.find((candidate) => candidate.lease_id === failed.lease_id) ?? failed;
  }
  let cleanupError: unknown;
  await killWindow(pending.pane, { pid: pending.pane_pid, started: pending.pane_started })
    .catch((cause: unknown) => { cleanupError = cause; });
  await releasePendingLaunchClaim(root, failed);
  if (pending.jj_workspace) await undoJjWorkspace(home, pending.jj_workspace, pending.worktree);
  if (cleanupError) {
    const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    throw new Error(`pending pane cleanup failed: ${detail}`, { cause: error });
  }
}

const resumeOwners = new Set<string>();

async function resumeOwnerLive(pending: PendingLaunch): Promise<boolean> {
  const token = pending.resume_token!;
  if (resumeOwners.has(token)) return true;
  if (pending.resume_pid === process.pid) return false;
  if (!pending.resume_pid || !pending.resume_started) return false;
  return await processStartTime(pending.resume_pid) === pending.resume_started;
}

export async function assertPendingWorkerResumeAvailable(entry: TeamEntry): Promise<void> {
  const pending = entry.launch_pending;
  if (pending?.resume_token && await resumeOwnerLive(pending)) {
    throw new Refusal(`${entry.name} pending launch is already resuming`);
  }
}

export async function resumePendingWorkerLaunch(
  root: string, project: string, agentRef: string | undefined, pane: string, answer: PendingAnswer,
): Promise<void> {
  const entry = await pendingWorkerAnswerTarget(root, project, agentRef, pane, answer.fingerprint);
  if (!entry) return;
  const agent = entry.name;
  const pending = entry.launch_pending!;
  if (!pending.dialog_delivered) throw new Refusal(`${agent} pending answer has no confirmed dialog delivery`);
  assertPendingAnswer(pending, answer);
  const home = (await projectEntry(root, project)).home;
  if (pending.resume_token && await resumeOwnerLive(pending)) {
    throw new Refusal(`${agent} pending launch is already resuming`);
  }
  if (pending.resume_token && pending.pickup_started && !pending.pickup_typed) {
    await abortPendingLaunch(root, home, entry, new Error(`${agent} resume stopped during pickup`));
    throw new Refusal(`${agent} resume stopped during pickup and was closed`);
  }
  const identity = assertPendingIdentity(entry, pending);
  const token = randomUUID();
  let current = await updatePendingEntry(home, entry, {
    launch_pending: {
      ...pending, resume_token: token, resume_pid: process.pid,
      resume_started: (await processStartTime(process.pid)) ?? 'unknown',
      answer_choice: answer.choice, answer_option: answer.option, approved: answer.approved,
    },
  });
  resumeOwners.add(token);
  try {
    if (!answer.approved) {
      await abortPendingLaunch(root, home, current, new Error(`launch dialog denied with "${answer.option}"`));
      return;
    }

    let stage: 'wait' | 'pickup' | 'session' | 'finish' | 'mark' | 'clear' = 'wait';
    try {
      if (!current.launch_pending!.pickup_typed) {
        if (!(await paneIs(pane, identity))) throw new Refusal(`${pane} is no longer the pending launch for ${agent}`);
        if ((await waitIdle(pane)) !== 'idle') throw new Refusal(`${pane} is not idle after its dialog answer`);
        stage = 'pickup';
        current = await updatePendingEntry(home, current, {
          launch_pending: { ...current.launch_pending!, pickup_started: true },
        });
        const typePickup = async (): Promise<void> => {
          const fresh = (await readTeam(home)).agents.find(
            (candidate) => candidate.name === agent && candidate.pane === pane,
          );
          if (fresh?.launch_pending?.resume_token !== token) {
            throw new Refusal(`${agent} pending launch changed before its first line was typed`);
          }
          await assertExecutionAllowed(root, project);
          await typeLine(pane, pickupLine(root, project, agent), identity);
        };
        if (current.task && current.lease_id) {
          await withTmuxGrant(root, home, current.task, agent, current.lease_id, typePickup);
        } else {
          await withProjectLock(root, project, typePickup);
        }
        current = await updatePendingEntry(home, current, {
          launch_pending: { ...current.launch_pending!, pickup_typed: true },
        });
      }

      stage = 'session';
      const sessionId = await findLatestSession(pending.worktree, agent);
      if (sessionId && current.session_id !== sessionId) {
        current = await updatePendingEntry(home, current, { session_id: sessionId });
      }

      if (!current.launch_pending!.claim_completed) {
        stage = 'finish';
        const admission = current.task && current.lease_id
          ? { task: current.task, agent, lease_id: current.lease_id }
          : undefined;
        await finishLaunch(root, pending.launch_claim_path, { pane, identity, home, worktree: pending.worktree, admission });
        if (!admission) await fs.rm(path.join(root, pending.launch_claim_path), { force: true });
        stage = 'mark';
        current = await updatePendingEntry(home, current, {
          launch_pending: { ...current.launch_pending!, claim_completed: true },
        });
      }

      stage = 'clear';
      current = await updatePendingEntry(home, current, { launch_pending: undefined });
    } catch (error) {
      if (stage === 'pickup' || stage === 'finish') await abortPendingLaunch(root, home, current, error);
      else await releaseResume(home, current);
      throw error;
    }
  } finally {
    resumeOwners.delete(token);
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

async function relaunchAgent(
  root: string,
  p: ProjectsFile['projects'][number],
  old: TeamEntry,
  sessionId: string | undefined,
  admission?: TmuxAdmission,
): Promise<string> {
  const launched = await withLaunchClaim(
    root, p.name,
    (registered, launchClaim, launchClaimDigest) =>
      relaunchRegisteredAgent(root, registered, old, sessionId, launchClaim, launchClaimDigest, admission),
    { preserveClaim: (result) => result.claimPending === true },
  );
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
      worktree, session_id: sessionId, model: old.model, closed_at: undefined, wedged_at: undefined,
      launch_mode: mode, launch_scoped_auto: mode === 'auto',
      migration_state: undefined, watch_authority_revoked_at: undefined, launch_pending: undefined,
      ...evidence, team_state_hash: teamStateHash,
    };
    let registered: TeamEntry | undefined;
    if (old.task && admission) {
      registered = await registerTmuxLaunch(root, home, old.task, old.name, admission.lease_id, patch, { allowClosed: true });
    } else {
      await withProjectLock(root, p.name, async () => {
        await assertEntryAlive(home, old, { pane, identity }, { allowStamped: true, cleanup: false });
        let claimedMatches = (await readTeam(home)).agents.filter((entry) => entry.name === old.name
          && Boolean(entry.orchestrator) === Boolean(old.orchestrator)
          && entry.pane === old.pane && entry.pane_pid === old.pane_pid && entry.pane_started === old.pane_started);
        if (old.lease_id !== undefined) {
          claimedMatches = claimedMatches.filter((entry) => entry.lease_id === old.lease_id);
        } else {
          const expectedWorktree = await canonicalWorktree(old.worktree || home);
          const matches: TeamEntry[] = [];
          for (const entry of claimedMatches) {
            if (await canonicalWorktree(entry.worktree || home) === expectedWorktree) matches.push(entry);
          }
          claimedMatches = matches;
        }
        const claimed = claimedMatches.length === 1 ? claimedMatches[0] : undefined;
        if (claimed) registered = await compareAndSwapTeamEntry(home, claimed, patch) ?? undefined;
        if (!registered) throw new Error(`${old.name} was killed while its new pane came up`);
      });
    }
    const idle = await waitIdleTrust(pane);
    if (idle === 'dialog') {
      if (!registered) throw new Error(`${old.name} launch was not registered`);
      await registerPendingWorkerLaunch(root, p.name, home, registered, worktree, launchClaim, launchClaimDigest);
      return { pane, identity, home, worktree, admission, claimPending: true };
    }
    if (idle !== 'idle') throw new Error(`${pane} never went idle; nothing was typed`);
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
  root: string, project: string, agent: string, options: RespawnOptions = {},
): Promise<string> {
  await assertExecutionAllowed(root, project);
  const p = await projectEntry(root, project);
  const home = p.home;
  const old = (await readTeam(home)).agents.find((entry) => entry.name === agent);
  if (!old) throw new Error(`${project} has no agent named ${agent}`);
  await assertNoLiveAgentReplacement(home, project, agent, old);
  await assertWorktreeNotShared(home, old.worktree || home, old);
  if (old.model === undefined && options.model === undefined) {
    throw new Error(`${agent} is missing its recorded model. Use hive spawn respawn ${project} --agent ${agent} --model ${DEFAULT_MODEL}`);
  }
  if (old.model !== undefined && options.model !== undefined) {
    throw new Error('a respawn model can be set only when the recorded model is missing');
  }
  const model = options.model ?? old.model!;
  const migrated = { ...old, model };
  const repair = !old.orchestrator && (options.assignment !== undefined || options.deliverable !== undefined);
  if (repair) checkWorkerContract(options);
  if (!old.orchestrator && !repair) await requireWorkerContract(old, home);
  checkModel(model);
  await preflight(model);
  if (old.task && !old.orchestrator) await admissionRequest(root, old.task, '', migrated);
  if (repair) await writeWorkerContract(old.worktree || home, agent, options, old.handoff);
  await assertExecutionAllowed(root, project);
  const admission = await admitReplacement(root, home, migrated);
  const reserved = admission
    ? (await readTeam(home)).agents.find((entry) => entry.lease_id === admission.lease_id)
    : old;
  const stamped = reserved
    ? await compareAndSwapTeamEntry(home, reserved, { closed_at: new Date().toISOString() })
    : null;
  if (!stamped) throw new Error(`${agent} was replaced before respawn`);
  try {
    if (old.pane) await killWindow(old.pane, recordedIdentity(old));
    await releasePendingLaunchClaim(root, old);
    return await relaunchAgent(root, p, { ...migrated, launch_pending: undefined }, undefined, admission);
  } catch (error) {
    if (old.task && !old.orchestrator) {
      await recordTmuxLaunchOutcome(root, home, old.task, agent, admission!.lease_id, error instanceof Error ? error.message : String(error));
    } else if (old.launch_pending) {
      const reason = error instanceof Error ? error.message : String(error);
      const current = (await readTeam(home)).agents.find((candidate) => candidate.name === agent);
      if (!current) {
        throw new AggregateError([error, new Error(`${agent} replacement disappeared during rollback`)], reason);
      }
      const pending = current.launch_pending ?? stamped.launch_pending;
      const detail = redactSecrets(`${reason}${pending ? `\n${pending.dialog}` : ''}`).slice(0, 4000);
      const failed = await compareAndSwapTeamEntry(home, current, {
        closed_at: new Date().toISOString(), launch_error: detail, admission_status: 'launch_failed',
        launch_pending: pending ? {
          ...pending, resume_token: undefined, resume_pid: undefined, resume_started: undefined,
        } : undefined,
      });
      if (!failed) throw new AggregateError([error, new Error(`${agent} rollback CAS failed`)], reason);
    } else {
      await compareAndSwapTeamEntry(home, stamped, { closed_at: undefined });
    }
    throw error;
  }
}

export async function wakeAgent(root: string, project: string, agent: string, expected?: TeamEntry): Promise<string> {
  await assertExecutionAllowed(root, project);
  const p = await projectEntry(root, project);
  const matches = (await readTeam(p.home)).agents.filter((entry) => entry.name === agent);
  if (!expected && matches.length > 1) throw new Error(`${project} has ambiguous workers named ${agent}`);
  const old = expected ? matches.find((entry) => canonicalJson(entry) === canonicalJson(expected)) : matches[0];
  if (!old) throw new Error(`${project} has no agent named ${agent}`);
  await assertNoLiveAgentReplacement(p.home, project, agent, old);
  await assertWorktreeNotShared(p.home, old.worktree || p.home, old);
  if (old.closed_at) throw new Error(`${agent} was closed on purpose at ${old.closed_at}; not waking it`);
  if (!old.session_id) throw new Error(`${agent} has no recorded session to resume; respawn it instead`);
  if (old.model === undefined) {
    throw new Error(`${agent} is missing its recorded model. Use hive spawn respawn ${project} --agent ${agent} --model ${DEFAULT_MODEL}`);
  }
  if (!old.orchestrator) await requireWorkerContract(old, p.home);
  const model = old.model;
  checkModel(model);
  await preflight(model);
  if (old.task && !old.orchestrator) await admissionRequest(root, old.task, '', old);
  if (old.pane && (await paneIs(old.pane, { pid: old.pane_pid ?? 0, started: old.pane_started ?? '' }))) {
    throw new Error(`${agent} is already running`);
  }
  const admission = await admitReplacement(root, p.home, old, true);
  const reserved = admission
    ? (await readTeam(p.home)).agents.find((entry) => entry.lease_id === admission.lease_id)
    : old;
  const claimed = reserved
    ? await compareAndSwapTeamEntry(p.home, reserved, { closed_at: new Date().toISOString() })
    : null;
  if (!claimed) throw new Error(`${agent} wake claim changed before launch`);
  try {
    await releasePendingLaunchClaim(root, old);
    return await relaunchAgent(root, p, { ...claimed, launch_pending: undefined }, old.session_id, admission);
  } catch (error) {
    if (old.task && !old.orchestrator) {
      await recordTmuxLaunchOutcome(root, p.home, old.task, agent, admission!.lease_id, error instanceof Error ? error.message : String(error));
    }
    await compareAndSwapTeamEntry(p.home, claimed, { closed_at: old.closed_at });
    throw error;
  }
}
