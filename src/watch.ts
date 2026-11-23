import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { captureDeathBundle, wireLogMtime } from './death-bundle.js';
import { maybeCompact } from './compact.js';
import { answerDialog, buildStatus, continueProject, dialogApprovalFingerprint, readDialogFor, reconcileBlockedTasks, Refusal, wake } from './hub.js';
import { DEFAULT_MODEL, typeLine, wakeAgent } from './spawn.js';
import { classify, isNativeQuestion, lines } from './screen.js';
import { appendDecision, compareAndSwapTeamEntry, foldTasks, hasLiveSendingClaim, hivePath, hubPath, readPendingPane, readProjects, readTaskEvents, readTeam, valueDigest, writeJson, writePendingPane } from './state.js';
import { capturePane, killWindow, paneExists, paneIs, run, sendEscape, sleep } from './tmux.js';
import { lastLine, withTimeout } from './view.js';
import { loadProcessedKeys, migrateLegacyStaleKey, recordProcessedKey } from './watch-persist.js';
import type { Approvals, DaydreamAutomationOptions, TeamEntry } from './types.js';
import { CLOSED_STATES } from './types.js';
import { assertExecutionAllowed, RolloutPaused } from './rollout.js';
import { withTmuxGrant } from './admission.js';
import { OPERATION_REGISTRY } from './evidence.js';
import { createRootDeltaQuestion, findDeclaredPush } from './questions.js';
import { redactSecrets } from './logview.js';
import { pendingMigrationRequired } from './launch.js';
import { supervisionPass, type GitHubOptions } from './supervision.js';

const SAFE_LEADERS = [
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'pwd', 'echo', 'wc', 'tsc',
  'git status', 'git log', 'git diff', 'git show', 'git branch',
  'jj st', 'jj status', 'jj log', 'jj diff', 'jj show',
  'jj bookmark list', 'jj git root', 'jj root',
  'hive hub status', 'hive hub tasks', 'hive hub dialog',
  'npm run build',
];

const GIT_PUSH_RE = /git\s+push/;
const NEVER_RES = [
  /\brm\s/, GIT_PUSH_RE, /git\s+reset/, /\bsudo\b/, /\bdd\s/, /\bmkfs\b/,
  /\bjj\s+push\b/, /\bjj\s+abandon\b/, /jj\s+workspace\s+forget/,
  /chmod\s+-R/, /(?:curl|wget)[^|]*\|\s*(?:ba|z)?sh\b/, />\s*\/(etc|usr|bin|sbin|var|boot|lib)(\/|\s|$)/,
  /\bnpm\s+ci\b/, /\bnpm\s+(?:i|install)\b/, /\bnpx\s+vitest\b/, /\bnpm\s+test\b/,
  /\bnpx\s+jest\b/, /\bcargo\s+build\b/, /\bmake\s/, /\bdocker\s+build\b/, /\bpip\s+install\b/,
];

export function extractCommand(dialogText: string): string | null {
  const m = dialogText.match(/^\s*(?:▶\s*)?\$\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

export function neverApprove(dialogText: string, scopedPush = false): boolean {
  return NEVER_RES.some((re) => (!scopedPush || re !== GIT_PUSH_RE) && re.test(dialogText));
}

export function tier1Approves(command: string): boolean {
  const segments = command.split(/\s*(?:&&|\|\||[;|])\s*/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((seg) => SAFE_LEADERS.some((w) => seg === w || seg.startsWith(`${w} `)));
}

const AUTO_TOKEN = /^[A-Za-z0-9_./:@%+=,-]+$/;
const AUTO_OPTIONS: Record<string, ReadonlySet<string>> = {
  ls: new Set(['-a', '-l', '-la', '-lh', '-R', '-r', '-t', '-S', '-X', '-v', '-1', '--all', '--long', '--reverse', '--sort', '--time', '--ignore']),
  cat: new Set(['-n', '-b', '-s', '-E', '-T', '-v', '--number', '--number-nonblank', '--squeeze-blank', '--show-ends', '--show-tabs', '--show-nonprinting']),
  head: new Set(['-n', '-c', '-q', '-v', '--lines', '--bytes', '--quiet', '--verbose']),
  tail: new Set(['-n', '-c', '-q', '-v', '--lines', '--bytes', '--quiet', '--verbose']),
  grep: new Set(['-i', '-n', '-r', '-R', '-l', '-c', '-v', '-E', '-F', '--include', '--exclude', '--exclude-dir', '--color']),
  rg: new Set(),
  pwd: new Set(['-L', '-P']),
  echo: new Set(['-n', '-e', '-E']),
  wc: new Set(['-l', '-w', '-m', '-c', '-L', '--lines', '--words', '--chars', '--bytes', '--max-line-length']),
};
const GIT_OPTIONS: Record<string, ReadonlySet<string>> = {
  status: new Set(['-s', '-b', '-u', '--short', '--long', '--porcelain', '--branch', '--untracked-files', '--show-stash', '--ignored', '--no-renames', '--no-color', '--ahead-behind', '--no-ahead-behind']),
  log: new Set(['-n', '-1', '--oneline', '--stat', '--name-only', '--name-status', '--no-renames', '--no-color', '--decorate', '--abbrev-commit', '--max-count', '--follow']),
  branch: new Set(['-a', '-r', '-v', '-vv', '--all', '--remotes', '--verbose', '--list', '--show-current']),
};

function allowedOptions(parts: string[], options: ReadonlySet<string>): boolean {
  return parts.every((part) => !part.startsWith('-') || options.has(part));
}

function autoReadOnlySegment(parts: string[]): boolean {
  if (parts.length === 0 || parts.some((part) => !AUTO_TOKEN.test(part))) return false;
  const [command, subcommand, ...rest] = parts;
  if (command === 'find') return false;
  if (AUTO_OPTIONS[command]) return allowedOptions(parts.slice(1), AUTO_OPTIONS[command]);
  if (command === 'tsc') return parts.length === 2 && subcommand === '--noEmit';
  if (command === 'git') {
    const options = GIT_OPTIONS[subcommand];
    return options !== undefined && allowedOptions(rest, options);
  }
  if (command !== 'hive' || subcommand !== 'hub') return false;
  return ['status', 'tasks', 'dialog'].includes(rest[0]) && allowedOptions(rest.slice(1), new Set(['--json']));
}

function autoReadOnly(command: string): boolean {
  if (/(?:&&|\|\||[;|])\s*$/.test(command)) return false;
  return command.split(/\s*(?:&&|\|\||[;|])\s*/)
    .every((segment) => autoReadOnlySegment(segment.trim().split(/\s+/)));
}

const CLASSIFY_TIMEOUT_MS = 60_000;
const CYCLE_TIMEOUT_MS = 120_000;

export async function kimiEnv(): Promise<NodeJS.ProcessEnv> {
  const r = await run('teamkimi', ['env']);
  const env: Record<string, string> = {};
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return env;
}

export async function classifyWithKimi(
  project: string,
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const prompt = `In project ${project}, an agent asks to run this command:\n$ ${command}\nAnswer APPROVE only if this is clearly a safe, read-only or build/test action with no external side effects. Otherwise answer ASK.`;
  const model = [env.HIVE_CLASSIFIER_MODEL, process.env.HIVE_CLASSIFIER_MODEL]
    .find((value) => value?.trim()) ?? DEFAULT_MODEL;
  const spawnEnv = { ...process.env, ...env, KIMI_CODE_NO_AUTO_UPDATE: '1' };
  const args = ['-m', model, '-p', prompt];
  const r = await run('kimi', args, undefined, spawnEnv, CLASSIFY_TIMEOUT_MS);
  return r.code === 0 && r.stdout.trimStart().startsWith('APPROVE');
}

const approveCache = new Map<string, true>();
const inFlightMarks = new Set<string>();
const nativeQuestionMarks = new Map<string, string>();

async function appendWatchLog(root: string, line: string): Promise<void> {
  await fs.mkdir(hubPath(root), { recursive: true });
  await fs.appendFile(hubPath(root, 'watch.log'), `${redactSecrets(line)}\n`);
}

async function withTaskBoundPane<T>(
  root: string, project: string, agent: TeamEntry, fn: () => Promise<T>,
): Promise<T | undefined> {
  try {
    if (agent.migration_state || agent.watch_authority_revoked_at) return undefined;
    if (!agent.task || !agent.lease_id) return await fn();
    return await withTmuxGrant(root, (await readProjects(root)).projects.find((candidate) => candidate.name === project)!.home,
      agent.task, agent.name, agent.lease_id, fn);
  } catch (error) {
    if (error instanceof Refusal) return undefined;
    throw error;
  }
}

async function withResolvedTaskBoundPane<T>(
  root: string, project: string, agentRef: string | undefined, fn: () => Promise<T>,
): Promise<T | undefined> {
  const registered = (await readProjects(root)).projects.find((candidate) => candidate.name === project);
  if (!registered) return fn();
  const [name, worktree] = agentRef?.split('@') ?? [];
  const matches = (await readTeam(registered.home)).agents.filter((agent) => agentRef === undefined
    ? agent.orchestrator
    : !agent.orchestrator && agent.name === name && (worktree === undefined || agent.worktree === worktree));
  if (matches.length > 1) return undefined;
  if (matches.length === 0) return fn();
  return withTaskBoundPane(root, project, matches[0], fn);
}

type PushDialog = { branch: string; commit?: string };

function parseGitPush(command: string): PushDialog | null {
  const parts = command.split(/\s+/);
  if (parts.length !== 4 || parts[0] !== 'git' || parts[1] !== 'push' || parts[2] !== 'origin') return null;
  const target = parts[3];
  const match = target.match(/^([0-9a-f]{40}):refs\/heads\/(.+)$/);
  const branch = match?.[2] ?? target;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch)
    || branch.includes('..') || branch.includes('//') || branch.includes('@{') || branch.startsWith('-')) return null;
  return match ? { branch, commit: match[1] } : { branch };
}

async function watchAgent(root: string, project: string, agentRef: string | undefined) {
  const registered = (await readProjects(root)).projects.find((candidate) => candidate.name === project);
  if (!registered) throw new Refusal(`unknown project: ${project}`);
  const [name, worktree] = agentRef?.split('@') ?? [];
  const matches = (await readTeam(registered.home)).agents.filter((agent) => agentRef === undefined
    ? agent.orchestrator
    : !agent.orchestrator && agent.name === name && (worktree === undefined || agent.worktree === worktree));
  if (matches.length > 1 || agentRef !== undefined && matches.length === 0) {
    throw new Refusal('watch agent identity is unknown');
  }
  return { home: registered.home, entry: matches[0] as TeamEntry | undefined };
}

async function cancelNativeDialog(
  root: string, project: string, agentRef: string | undefined,
  dialog: NonNullable<Awaited<ReturnType<typeof readDialogFor>>>,
): Promise<void> {
  const answer = await answerDialog(root, project, agentRef, 'esc', dialogApprovalFingerprint(dialog));
  if (!answer.dialog_gone) throw new Refusal('native mutation dialog did not close; no operation ran');
}

async function dispatchDeclaredPush(
  root: string, project: string, agentRef: string | undefined,
  dialog: NonNullable<Awaited<ReturnType<typeof readDialogFor>>>, push: PushDialog,
): Promise<boolean> {
  const declared = await findDeclaredPush(root, project, agentRef, push.branch, push.commit);
  if (!declared) return false;
  const current = await withResolvedTaskBoundPane(root, project, agentRef, async () => true);
  if (!current) return true;
  const { home, entry } = await watchAgent(root, project, agentRef);
  await cancelNativeDialog(root, project, agentRef, dialog);
  const cwd = entry?.worktree || home;
  const agentName = declared.agent.split('@')[0];
  const env = {
    ...process.env, HIVE_HUB_ROOT: root, HIVE_PROJECT: project, HIVE_AGENT_REF: declared.agent,
    HIVE_AGENT_CREDENTIAL: '', HIVE_AGENT_CREDENTIAL_FILE: hivePath(cwd, 'team', agentName, 'credential.env'),
  };
  await OPERATION_REGISTRY.push.dispatch('origin', declared.commit, declared.branch, cwd, declared.reference, env);
  await appendDecision(root, {
    project, by: 'watch', task: entry?.task,
    summary: redactSecrets(`dispatched declared push ${declared.commit} to origin/${declared.branch} without native approval`),
  });
  return true;
}

async function watchRootTask(root: string, project: string, agentRef: string | undefined) {
  const { entry } = await watchAgent(root, project, agentRef);
  const tasks = foldTasks(await readTaskEvents(root));
  const candidates = tasks.filter((candidate) => candidate.project === project
    && candidate.contract && !CLOSED_STATES.has(candidate.state));
  const task = entry?.task
    ? tasks.find((candidate) => candidate.id === entry.task)
    : candidates.length === 1 ? candidates[0] : undefined;
  return task?.contract && task.plan_digest && task.lease_epoch ? task : undefined;
}

async function declaredCommand(root: string, project: string, agentRef: string | undefined, command: string) {
  const current = await withResolvedTaskBoundPane(root, project, agentRef, async () => true);
  if (!current) return true;
  const task = await watchRootTask(root, project, agentRef);
  return task?.contract!.action_scope.includes(`command:${valueDigest(command)}`) ?? false;
}

async function requestRootDelta(
  root: string, project: string, agentRef: string | undefined,
  dialog: NonNullable<Awaited<ReturnType<typeof readDialogFor>>>, command: string,
): Promise<void> {
  const current = await withResolvedTaskBoundPane(root, project, agentRef, async () => true);
  if (!current) return;
  const task = await watchRootTask(root, project, agentRef);
  if (!task) {
    await cancelNativeDialog(root, project, agentRef, dialog);
    await appendDecision(root, {
      project, by: 'watch',
      summary: `blocked undeclared mutation without a root contract: $ ${redactSecrets(command)}`,
    });
    return;
  }
  const actionScope = new Set([...task.contract!.action_scope, `command:${valueDigest(command)}`]);
  if (parseGitPush(command)) actionScope.add('push');
  const nextContract = { ...task.contract!, action_scope: [...actionScope] };
  const batch = await createRootDeltaQuestion(root, task.id, nextContract, `Blocked command: ${redactSecrets(command)}`);
  await cancelNativeDialog(root, project, agentRef, dialog);
  await appendDecision(root, {
    project, by: 'watch', task: task.id,
    summary: `blocked undeclared mutation and opened root delta ${batch.id}: $ ${redactSecrets(command)}`,
  });
}

async function maybeAutoApprove(
  root: string,
  project: string,
  agentRef: string | undefined,
  dialog: NonNullable<Awaited<ReturnType<typeof readDialogFor>>>,
  approvals: Approvals,
  env: NodeJS.ProcessEnv,
  verdicts: Map<string, true>,
  marks: Set<string>,
  auto = false,
): Promise<void> {
  try {
    await assertExecutionAllowed(root, project);
  } catch (error) {
    if (error instanceof RolloutPaused) return;
    throw error;
  }
  const command = extractCommand(dialog.text);
  const push = auto && command ? parseGitPush(command) : null;
  const hardDeny = neverApprove(dialog.text, push !== null);
  if (!auto && hardDeny) return;
  if (auto) {
    if (!command) return;
    if (push && !hardDeny && await dispatchDeclaredPush(root, project, agentRef, dialog, push)) return;
    if (!autoReadOnly(command) || hardDeny) {
      if (await declaredCommand(root, project, agentRef, command)) {
        if (hardDeny) return;
      } else {
        await requestRootDelta(root, project, agentRef, dialog, command);
        return;
      }
    }
  }
  if (!command) return;
  const cacheKey = command.replace(/\s+/g, ' ');
  let ok = auto || tier1Approves(command);
  if (!auto && !ok && approvals === 'smart') {
    if (verdicts.has(cacheKey)) {
      ok = true;
    } else if (!marks.has(dialog.fingerprint)) {
      marks.add(dialog.fingerprint);
      try {
        ok = await classifyWithKimi(project, command, env);
      } finally {
        marks.delete(dialog.fingerprint);
      }
      if (ok) verdicts.set(cacheKey, true);
    }
  }
  if (!ok) return;
  const opt = auto
    ? dialog.options.find((option) => option.offered && !option.saves_rule && /^(Approve|Allow)\b/i.test(option.label))
    : dialog.options.find((option) => option.n === 1);
  if (!opt || !opt.offered || opt.saves_rule) return;
  const { entry } = await watchAgent(root, project, agentRef);
  const approval = dialogApprovalFingerprint(dialog);
  const answered = entry?.launch_pending
    ? await answerDialog(root, project, agentRef, String(opt.n), approval)
    : await withResolvedTaskBoundPane(root, project, agentRef,
      () => answerDialog(root, project, agentRef, String(opt.n), approval));
  if (answered === undefined) return;
  await appendDecision(root, {
    project, by: 'watch', summary: `auto-approved "${opt.label}" for: $ ${redactSecrets(command)}`,
  });
}

export async function handleCurrentOrchestratorDialog(root: string, project: string): Promise<void> {
  const p = (await readProjects(root)).projects.find((x) => x.name === project);
  if (!p) throw new Refusal(`unknown project: ${project}`);
  const recorded = (await readTeam(p.home)).agents.find((agent) => agent.orchestrator);
  const orchestrator = recorded
    ? await fenceLegacyPane(root, project, p.home, recorded)
    : undefined;
  const pending = await readPendingPane(root, project);
  if (orchestrator?.migration_state || pending && await fencePendingOrchestrator(root, project, pending, orchestrator)) return;
  const approvals = p.approvals ?? 'manual';
  if (p.mode !== 'auto' && approvals === 'manual') return;
  const dialog = await readDialogFor(root, project).catch((e: unknown) => {
    if (!(e instanceof Refusal)) throw e;
    return null;
  });
  if (!dialog) return;
  const env: NodeJS.ProcessEnv = p.mode !== 'auto' && approvals === 'smart' ? await kimiEnv().catch(() => ({})) : {};
  await maybeAutoApprove(root, project, undefined, dialog, approvals, env, approveCache, inFlightMarks, p.mode === 'auto');
}

export const WAKE_MAX_ATTEMPTS = 60;
export const WEDGE_STILL_MS = 10 * 60_000;
export const STALE_WIRE_MS = 15 * 60_000;
const WEDGE_DUMP_TIMEOUT_MS = 15_000;

export type WakeState = Map<string, { attempts: number; nextAt: number }>;

async function handleDeath(
  root: string,
  project: string,
  home: string,
  a: TeamEntry,
  deaths: Set<string>,
  wakes: WakeState,
): Promise<void> {
  const key = `${a.pane}:${a.pane_pid}`;
  if (!deaths.has(key)) {
    deaths.add(key);
    await recordProcessedKey(root, key);
    await appendWatchLog(
      root,
      `${new Date().toISOString()} ${project} ${a.name} pane ${a.pane} died (pid ${a.pane_pid}, started ${a.pane_started})`,
    );
    const bundle = await captureDeathBundle(root, project, a).catch(() => null);
    await appendWatchLog(
      root,
      `${new Date().toISOString()} ${project} ${a.name} death bundle: ${bundle ?? 'capture failed'}`,
    );
  }
  if (!a.orchestrator && !a.session_id) return;
  const w = wakes.get(key) ?? { attempts: 0, nextAt: 0 };
  if (w.attempts >= WAKE_MAX_ATTEMPTS || Date.now() < w.nextAt) return;
  const attempt = w.attempts + 1;
  wakes.set(key, { attempts: attempt, nextAt: Date.now() + Math.min(5000 * 2 ** (attempt - 1), 600_000) });
  try {
    const pane = a.orchestrator ? await wake(root, project) : await wakeAgent(root, project, a.name, a);
    const entries = (await readTeam(home)).agents.filter((x) => x.name === a.name
      && x.worktree === a.worktree && Boolean(x.orchestrator) === Boolean(a.orchestrator));
    if (entries.length !== 1) {
      throw new Error(`wake returned ${pane} but the ${a.name} registration is duplicate or ambiguous`);
    }
    const entry = entries[0];
    if (entry?.pane !== pane) {
      throw new Error(`wake returned ${pane} but the team entry still points at ${entry?.pane ?? 'nothing'}`);
    }
    if (!(await paneIs(pane, { pid: entry.pane_pid ?? 0, started: entry.pane_started ?? '' }))) {
      throw new Error(`wake returned ${pane} but the team entry has a stale process identity`);
    }
    await appendDecision(root, {
      project, by: 'watch',
      summary: a.orchestrator
        ? `woke the orchestrator after pane ${a.pane} died`
        : `woke ${a.name} after pane ${a.pane} died`,
    });
    await appendWatchLog(
      root,
      `${new Date().toISOString()} ${project} resurrected ${a.name} in pane ${pane} (wake attempt ${attempt})`,
    );
  } catch (e) {
    await appendWatchLog(root, `${new Date().toISOString()} ${project} wake attempt ${attempt} failed: ${lastLine(e)}`);
    if (attempt === WAKE_MAX_ATTEMPTS) {
      await appendWatchLog(
        root,
        `${new Date().toISOString()} ${project} gave up waking ${a.name} after ${WAKE_MAX_ATTEMPTS} attempts; wake it by hand`,
      );
    }
  }
}

async function flagStale(
  root: string,
  project: string,
  a: TeamEntry,
  seen: Set<string>,
): Promise<void> {
  if (!a.session_id || !a.pane) return;
  const wireAt = await wireLogMtime(os.homedir(), a.session_id);
  if (wireAt === null) return;
  const ageMs = Date.now() - wireAt;
  if (ageMs < STALE_WIRE_MS) return;
  const key = `stale:${a.session_id}:${a.pane}:${wireAt}`;
  if (seen.has(key)) return;
  seen.add(key);
  try {
    if (await migrateLegacyStaleKey(root, project, a, wireAt, key, seen)) return;
    await appendDecision(root, {
      project, by: 'watch', watch_key: key,
      summary: `stale: ${project}/${a.name} no output for ${Math.floor(ageMs / 60_000)}m`,
    });
  } catch (e) {
    seen.delete(key);
    throw e;
  }
}

async function stackProbe(sections: string[], title: string, cmd: string, args: string[]): Promise<void> {
  try {
    const r = await run(cmd, args, undefined, undefined, WEDGE_DUMP_TIMEOUT_MS);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `exit code ${r.code}`);
    sections.push(title, r.stdout.trimEnd() || 'no output');
  } catch (e) {
    sections.push(title, `unavailable (${lastLine(e)})`);
  }
}

async function captureWedgeDump(home: string, a: TeamEntry): Promise<string> {
  const sections: string[] = [`agent: ${a.name}`, `pane: ${a.pane ?? '?'}`, `pid: ${a.pane_pid ?? '?'}`];
  await stackProbe(sections, `== pstack ${a.pane_pid} ==`, 'sudo', ['-n', 'pstack', String(a.pane_pid)]);
  const pySpy = await run('which', ['py-spy'], undefined, undefined, WEDGE_DUMP_TIMEOUT_MS);
  if (pySpy.code === 0) await stackProbe(sections, '== py-spy dump ==', 'py-spy', ['dump', '--pid', String(a.pane_pid)]);
  const file = hivePath(home, 'wedges', `${a.name}-${Math.floor(Date.now() / 1000)}.log`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, sections.join('\n') + '\n');
  return file;
}

export type Stillness = Map<string, { content: string; since: number; cpu: number | null }>;

async function treeCpuTime(pid: number): Promise<number | null> {
  const r = await run('ps', ['-eo', 'pid=,ppid=,times='], undefined, undefined, WEDGE_DUMP_TIMEOUT_MS);
  if (r.code !== 0) return null;
  const kids = new Map<number, number[]>();
  const times = new Map<number, number>();
  for (const line of r.stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)/);
    if (!m) continue;
    const [p, pp, t] = [Number(m[1]), Number(m[2]), Number(m[3])];
    times.set(p, t);
    kids.set(pp, [...(kids.get(pp) ?? []), p]);
  }
  if (!times.has(pid)) return null;
  let total = 0;
  const stack = [pid];
  while (stack.length) {
    const p = stack.pop()!;
    total += times.get(p) ?? 0;
    stack.push(...(kids.get(p) ?? []));
  }
  return total;
}

async function clearWedged(root: string, home: string, project: string, a: TeamEntry): Promise<void> {
  const updated = await compareAndSwapTeamEntry(home, a, { wedged_at: undefined });
  if (!updated) return;
  await appendWatchLog(root, `${new Date().toISOString()} ${project} ${a.name} is moving again; cleared the wedged mark`);
}

async function judgeWedge(
  root: string,
  project: string,
  home: string,
  a: TeamEntry,
  stills: Stillness,
  stillMs: number,
): Promise<void> {
  const pane = a.pane;
  if (!pane) return;
  const key = `${pane}:${a.pane_pid}`;
  const raw = await capturePane(pane);
  if (raw === null || classify(lines(raw)) !== 'working') {
    stills.delete(key);
    if (a.wedged_at) await clearWedged(root, home, project, a);
    return;
  }
  const seen = stills.get(key);
  if (!seen || seen.content !== raw) {
    const cpu = a.pane_pid ? await treeCpuTime(a.pane_pid) : null;
    stills.set(key, { content: raw, since: Date.now(), cpu });
    if (seen && a.wedged_at) await clearWedged(root, home, project, a);
    return;
  }
  if (Date.now() - seen.since < stillMs) return;
  const cpu = a.pane_pid ? await treeCpuTime(a.pane_pid) : null;
  if (cpu !== null && seen.cpu !== null && cpu > seen.cpu) {
    stills.set(key, { content: raw, since: Date.now(), cpu });
    return;
  }
  if (a.session_id) {
    const wireAt = await wireLogMtime(os.homedir(), a.session_id);
    if (wireAt !== null && Date.now() - wireAt < stillMs) return;
  }
  if (a.wedged_at) return;
  const updated = await compareAndSwapTeamEntry(home, a, { wedged_at: new Date().toISOString() });
  if (!updated) return;
  await appendWatchLog(
    root,
    `${new Date().toISOString()} ${project} ${a.name} looks wedged: pane ${pane} frozen on a spinner for ${Math.round(stillMs / 60_000)}m`,
  );
  const dump = await captureWedgeDump(home, a).catch(() => null);
  await appendWatchLog(root, `${new Date().toISOString()} ${project} ${a.name} stack dump: ${dump ?? 'capture failed'}`);
  if (!a.orchestrator && !a.session_id) {
    await appendDecision(root, {
      project, by: 'watch',
      summary: `marked ${a.name} wedged: frozen pane, no session to resume, stack dump saved, left for the owner`,
    });
    return;
  }
  await appendDecision(root, {
    project, by: 'watch',
    summary: `marked ${a.name} wedged: frozen pane, stale wire log, stack dump saved, restarting it`,
  });
  if (!a.pane_pid || !a.pane_started) {
    await appendWatchLog(root, `${new Date().toISOString()} ${project} ${a.name} has no recorded pane identity; refusing to kill ${pane}`);
    return;
  }
  await withTaskBoundPane(root, project, a,
    () => killWindow(pane, { pid: a.pane_pid!, started: a.pane_started! })).catch(async (e: unknown) => {
      await appendWatchLog(root, `${new Date().toISOString()} ${project} killing the wedged pane failed: ${lastLine(e)}`);
    });
}

async function redirectNativeQuestion(
  root: string, project: string, a: TeamEntry, seen: Map<string, string>,
): Promise<boolean> {
  const pane = a.pane;
  if (!pane) return false;
  const key = `${pane}:${a.pane_pid}`;
  const raw = await capturePane(pane);
  if (raw === null || !isNativeQuestion(lines(raw))) {
    seen.delete(key);
    return false;
  }
  if (seen.get(key) === raw) return true;
  return (await withTaskBoundPane(root, project, a, async () => {
    const identity = { pid: a.pane_pid ?? 0, started: a.pane_started ?? '' };
    await sendEscape(pane, identity);
    await sleep(250);
    await typeLine(pane, 'Hive blocked native AskUserQuestion. Use mcp__hive-operator__ask_operator for every operator decision.', identity);
    const after = await capturePane(pane);
    if (after === null || isNativeQuestion(lines(after))) {
      throw new Error(`native AskUserQuestion dismissal is not confirmed on ${a.pane}`);
    }
    seen.set(key, raw);
    await appendDecision(root, {
      project, by: 'watch',
      summary: `blocked native AskUserQuestion for ${project}/${a.name}; redirected to mcp__hive-operator__ask_operator`,
    });
    return true;
  })) ?? false;
}

async function fencePendingOrchestrator(
  root: string, project: string,
  pending: NonNullable<Awaited<ReturnType<typeof readPendingPane>>>, orchestrator?: TeamEntry,
): Promise<boolean> {
  if (!pendingMigrationRequired(pending, orchestrator)) return false;
  if (!pending.migration_state) {
    await writePendingPane(root, project, {
      ...pending, migration_state: 'legacy_auto_blocked', watch_authority_revoked_at: new Date().toISOString(),
    });
  }
  return true;
}

async function fenceLegacyPane(
  root: string, project: string, home: string, agent: TeamEntry,
): Promise<TeamEntry> {
  if (agent.closed_at || agent.migration_state) return agent;
  const unknownIdentity = Boolean(agent.pane && (!agent.pane_pid || !agent.pane_started));
  const legacyAuto = agent.launch_mode === undefined
    || agent.launch_mode === 'auto' && agent.launch_scoped_auto !== true;
  if (!unknownIdentity && !legacyAuto) return agent;
  const migrationState = unknownIdentity ? 'unknown_identity_blocked' : 'legacy_auto_blocked';
  const updated = await compareAndSwapTeamEntry(home, agent, {
    migration_state: migrationState, watch_authority_revoked_at: new Date().toISOString(),
  });
  if (!updated) return (await readTeam(home)).agents.find((candidate) => candidate.name === agent.name) ?? agent;
  await appendDecision(root, {
    project, by: 'watch', task: agent.task,
    summary: unknownIdentity
      ? `blocked ${agent.name}: recorded pane identity is incomplete; explicit migration is required`
      : `blocked legacy auto ${agent.name}: watch authority revoked; natural exit or explicit migration is required`,
  });
  return updated;
}

async function markLegacyNaturalExit(root: string, project: string, home: string, agent: TeamEntry): Promise<void> {
  if (agent.migration_state === 'natural_exit_ready') return;
  const updated = await compareAndSwapTeamEntry(home, agent, { migration_state: 'natural_exit_ready' });
  if (!updated) return;
  await appendWatchLog(root, `${new Date().toISOString()} ${project} ${agent.name} exited naturally; resume needs explicit migration`);
  await appendDecision(root, {
    project, by: 'watch', task: agent.task,
    summary: `${agent.name} exited naturally with its legacy fence intact; explicit migration can resume its lineage`,
  });
}

export async function watchCycle(
  root: string,
  env: NodeJS.ProcessEnv = {},
  deaths: Set<string> = new Set(),
  wakes: WakeState = new Map(),
  stills: Stillness = new Map(),
  { wedgeStillMs = WEDGE_STILL_MS, verdicts = approveCache, marks = inFlightMarks, nativeQuestions = nativeQuestionMarks, daydreamAutomation, github, now }: {
    wedgeStillMs?: number;
    verdicts?: Map<string, true>;
    marks?: Set<string>;
    nativeQuestions?: Map<string, string>;
    daydreamAutomation?: DaydreamAutomationOptions;
    github?: GitHubOptions;
    now?: number;
  } = {},
): Promise<void> {
  await reconcileBlockedTasks(root);
  await supervisionPass(root, github, now);
  const pf = await readProjects(root);
  const status = await buildStatus(root);
  for (const p of pf.projects) {
    const proj = status.projects.find((x) => x.name === p.name);
    const team = await readTeam(p.home);
    for (const recorded of team.agents) {
      const a = await fenceLegacyPane(root, p.name, p.home, recorded);
      if (a.migration_state) {
        if (a.pane && !a.closed_at && !(await paneExists(a.pane))) {
          await markLegacyNaturalExit(root, p.name, p.home, a);
        }
        continue;
      }
      const automation = a.daydream_automation === true
        && (process.env.HIVE_DAYDREAM_AUTOMATION === '1' || daydreamAutomation !== undefined);
      if (automation) {
        await maybeCompact(root, p.name, a, { daydreamAutomation }).catch(async (e: unknown) => {
          await appendWatchLog(root, `${new Date().toISOString()} ${p.name} auto-compaction failed for ${a.name}: ${lastLine(e)}`);
        });
      } else {
        await maybeCompact(root, p.name, a).catch(async (e: unknown) => {
          await appendWatchLog(root, `${new Date().toISOString()} ${p.name} auto-compaction failed for ${a.name}: ${lastLine(e)}`);
        });
      }
      if (!a.pane || a.closed_at) continue;
      if (!(await paneExists(a.pane))) {
        await handleDeath(root, p.name, p.home, a, deaths, wakes);
        continue;
      }
      if (await redirectNativeQuestion(root, p.name, a, nativeQuestions).catch(async (e: unknown) => {
        await appendWatchLog(root, `${new Date().toISOString()} ${p.name} native question redirect failed for ${a.name}: ${lastLine(e)}`);
        return true;
      })) continue;
      const waiting = a.orchestrator
        ? proj?.orchestrator.operator_waiting === true
        : proj?.agents.some((x) => x.name === a.name && x.worktree === a.worktree && x.operator_waiting) === true;
      if (waiting) {
        stills.delete(`${a.pane}:${a.pane_pid}`);
        if (a.wedged_at) await clearWedged(root, p.home, p.name, a);
        continue;
      }
      await flagStale(root, p.name, a, deaths);
      await judgeWedge(root, p.name, p.home, a, stills, wedgeStillMs);
    }

    const starting = proj?.orchestrator.starting;
    const orchestrator = (await readTeam(p.home)).agents.find((agent) => agent.orchestrator);
    const pending = await readPendingPane(root, p.name);
    const pendingFenced = pending
      ? await fencePendingOrchestrator(root, p.name, pending, orchestrator)
      : false;
    if (proj && !pendingFenced && !orchestrator?.migration_state
      && starting?.typed === false && starting.question === false && !proj.orchestrator.question) {
      if (pending?.typed === false && !hasLiveSendingClaim(pending)) {
        await continueProject(root, p.name).catch(async (e: unknown) => {
          if (!(e instanceof Refusal)) {
            await appendWatchLog(root, `${new Date().toISOString()} ${p.name} continue failed: ${lastLine(e)}`);
          }
        });
      }
    }

    const approvals = p.approvals ?? 'manual';
    if (p.mode !== 'auto' && approvals === 'manual') continue;
    if (!proj) continue;
    const targets: (string | undefined)[] = [];
    const orchDialog = proj.orchestrator.screen_question
      ?? (proj.orchestrator.question === true && proj.orchestrator.operator_question !== true);
    if (orchDialog || proj.orchestrator.starting?.question) targets.push(undefined);
    for (const a of proj.agents) {
      if ((a.screen_question ?? (a.question && !a.operator_question)) && a.ref) targets.push(a.ref);
    }
    for (const ref of targets) {
      const dialog = await readDialogFor(root, p.name, ref).catch((e: unknown) => {
        if (!(e instanceof Refusal)) throw e;
        return null;
      });
      if (!dialog) continue;
      await maybeAutoApprove(root, p.name, ref, dialog, approvals, env, verdicts, marks, p.mode === 'auto');
    }
  }
}

export async function watch(
  root: string,
  { intervalMs = 5000, cycleTimeoutMs = CYCLE_TIMEOUT_MS }: { intervalMs?: number; cycleTimeoutMs?: number } = {},
): Promise<void> {
  const env = await kimiEnv().catch(() => ({} as NodeJS.ProcessEnv));
  const deaths = await loadProcessedKeys(root);
  const wakes: WakeState = new Map();
  const stills: Stillness = new Map();
  let cycles = 0;
  for (;;) {
    await withTimeout(watchCycle(root, env, deaths, wakes, stills), cycleTimeoutMs, 'watch cycle').catch(async (e: unknown) => {
      await appendWatchLog(root, `${new Date().toISOString()} cycle error: ${lastLine(e)}`);
    });
    cycles += 1;
    await writeJson(hubPath(root, 'watch-status.json'), { ts: new Date().toISOString(), cycles }).catch(() => {});
    await sleep(intervalMs);
  }
}
