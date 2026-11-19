import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDaydreamAutomationRunner } from './daydream-automation-runner.js';
import { recordDaydreamArtifact } from './daydream-retention.js';
import { wireActivityAt } from './death-bundle.js';
import { KimiServerClient } from './kimi-server.js';
import { withProjectLock } from './project.js';
import { readProcessStartTime } from './process-lease.js';
import { redactSecrets } from './logview.js';
import { assertExecutionAllowed } from './rollout.js';
import {
  appendDecision,
  hivePath,
  readJson,
  readProjects,
  readTeam,
  Refusal,
  withTeamLock,
  writeJson,
} from './state.js';
import type {
  DaydreamAutomationBudgets,
  DaydreamAutomationCeilings,
  DaydreamAutomationOptions,
  DaydreamAutomationOutcome,
  DaydreamAutomationProjectStatus,
  DaydreamAutomationReservation,
  DaydreamAutomationRun,
  DaydreamAutomationRunner,
  DaydreamAutomationUsage,
  DaydreamNativeClient,
  TeamEntry,
} from './types.js';

export type {
  DaydreamAutomationBudgets,
  DaydreamAutomationOptions,
  DaydreamAutomationOutcome,
  DaydreamAutomationProjectStatus,
  DaydreamAutomationReservation,
  DaydreamAutomationRun,
  DaydreamAutomationRunInput,
  DaydreamAutomationRunner,
  DaydreamAutomationUsage,
} from './types.js';

const IDLE_MS = 30 * 60_000;
const PROMPT_CEILING = 3;
const COMPACTION_CEILING = 1;
const DEFAULT_BUDGETS: DaydreamAutomationBudgets = {
  perAgent: { runs: 4, prompts: 12, compactions: 4 },
  perProject: { runs: 16, prompts: 48, compactions: 16 },
};
type DailyUsage = { project: DaydreamAutomationUsage; agents: Record<string, DaydreamAutomationUsage> };
type AutomationState = { schemaVersion: 1; runs: DaydreamAutomationRun[]; daily: Record<string, DailyUsage> };

function emptyUsage(): DaydreamAutomationUsage {
  return { runs: 0, prompts: 0, compactions: 0, tokens: 0 };
}
function emptyState(): AutomationState {
  return { schemaVersion: 1, runs: [], daily: {} };
}
function automationDirectory(home: string): string {
  return hivePath(home, 'daydreams', 'automation');
}
function stateFile(home: string): string {
  return path.join(automationDirectory(home), 'state.json');
}
function agentKey(agent: Pick<TeamEntry, 'name' | 'worktree' | 'orchestrator'>): string {
  return `${agent.orchestrator ? 'orchestrator' : 'agent'}:${agent.name}@${agent.worktree ?? ''}`;
}
function dayAt(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}
function usage(value: unknown): DaydreamAutomationUsage {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const result = emptyUsage();
  for (const field of ['runs', 'prompts', 'compactions', 'tokens'] as const) {
    const number = raw[field] === undefined ? 0 : raw[field];
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) throw new Refusal('daydream automation usage is invalid');
    result[field] = number;
  }
  return result;
}
function parseState(value: unknown): AutomationState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Refusal('daydream automation state is invalid');
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.runs) || !raw.daily || typeof raw.daily !== 'object' || Array.isArray(raw.daily)) {
    throw new Refusal('daydream automation state is invalid');
  }
  const runs = raw.runs.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Refusal('daydream automation run is invalid');
    const run = entry as Record<string, unknown>;
    if (run.schemaVersion !== 1 || !['reserved', 'recovered', 'unknown'].includes(String(run.status))
      || typeof run.fenced !== 'boolean' || typeof run.usageRecorded !== 'boolean') {
      throw new Refusal('daydream automation run is invalid');
    }
    for (const field of ['fingerprint', 'daydreamId', 'project', 'agentKey', 'agentName', 'sessionId', 'createdAt', 'updatedAt']) {
      if (typeof run[field] !== 'string' || !run[field]) throw new Refusal('daydream automation run identity is invalid');
    }
    for (const field of ['activityAt', 'reservedPrompts', 'reservedCompactions']) {
      if (typeof run[field] !== 'number' || !Number.isSafeInteger(run[field]) || Number(run[field]) < 0) {
        throw new Refusal('daydream automation run budget is invalid');
      }
    }
    const counted = usage(run);
    return { ...entry, ...counted } as DaydreamAutomationRun;
  });
  const daily: Record<string, DailyUsage> = {};
  for (const [day, entry] of Object.entries(raw.daily)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Refusal('daydream automation daily usage is invalid');
    const record = entry as Record<string, unknown>;
    const agents: Record<string, DaydreamAutomationUsage> = {};
    if (!record.agents || typeof record.agents !== 'object' || Array.isArray(record.agents)) throw new Refusal('daydream automation agent usage is invalid');
    for (const [key, value] of Object.entries(record.agents)) agents[key] = usage(value);
    daily[day] = { project: usage(record.project), agents };
  }
  return { schemaVersion: 1, runs, daily };
}
async function realDirectory(directory: string, create: boolean): Promise<boolean> {
  let stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat && !create) return false;
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Refusal('daydream automation directory must be a real directory');
  if (!stat) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    stat = await fs.lstat(directory);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Refusal('daydream automation directory must be a real directory');
  return true;
}
async function loadState(home: string): Promise<AutomationState> {
  if (!await realDirectory(hivePath(home, 'daydreams'), false)) return emptyState();
  if (!await realDirectory(automationDirectory(home), false)) return emptyState();
  const value = await readJson<unknown>(stateFile(home));
  return value === null ? emptyState() : parseState(value);
}
async function writeState(home: string, state: AutomationState): Promise<void> {
  await realDirectory(hivePath(home, 'daydreams'), true);
  await realDirectory(automationDirectory(home), true);
  await writeJson(stateFile(home), state, 0o600);
}
function dailyFor(state: AutomationState, day: string): DailyUsage {
  return state.daily[day] ?? { project: emptyUsage(), agents: {} };
}
function addUsage(target: DaydreamAutomationUsage, addition: DaydreamAutomationUsage): void {
  target.runs += addition.runs;
  target.prompts += addition.prompts;
  target.compactions += addition.compactions;
  target.tokens += addition.tokens;
}
function reservedUsage(runs: DaydreamAutomationRun[]): DaydreamAutomationUsage {
  const total = emptyUsage();
  for (const run of runs) {
    if (run.status !== 'reserved') continue;
    total.runs += 1;
    total.prompts += run.reservedPrompts;
    total.compactions += run.reservedCompactions;
  }
  return total;
}
function withinCeiling(used: DaydreamAutomationUsage, reserved: DaydreamAutomationUsage, ceiling: DaydreamAutomationCeilings): boolean {
  return used.runs + reserved.runs + 1 <= ceiling.runs
    && used.prompts + reserved.prompts + PROMPT_CEILING <= ceiling.prompts
    && used.compactions + reserved.compactions + COMPACTION_CEILING <= ceiling.compactions;
}
function budgetsAllow(state: AutomationState, day: string, key: string, budgets: DaydreamAutomationBudgets): boolean {
  const daily = dailyFor(state, day);
  const reserved = reservedUsage(state.runs.filter((run) => dayAt(Date.parse(run.createdAt)) === day));
  const agentReserved = reservedUsage(state.runs.filter((run) => run.agentKey === key && dayAt(Date.parse(run.createdAt)) === day));
  return withinCeiling(daily.project, reserved, budgets.perProject)
    && withinCeiling(daily.agents[key] ?? emptyUsage(), agentReserved, budgets.perAgent);
}
function budgetsFor(options: DaydreamAutomationOptions): DaydreamAutomationBudgets {
  const budgets = options.budgets ?? DEFAULT_BUDGETS;
  for (const ceilings of [budgets.perAgent, budgets.perProject]) {
    for (const value of [ceilings.runs, ceilings.prompts, ceilings.compactions]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Refusal('daydream automation budget ceilings must be non-negative integers');
    }
  }
  return budgets;
}
function automationEnabled(agent: TeamEntry): boolean {
  return process.env.HIVE_DAYDREAM_AUTOMATION === '1'
    && process.env.HIVE_DAYDREAM === '1'
    && process.env.HIVE_NATIVE_BRANCHES === '1'
    && agent.daydream_automation === true
    && agent.orchestrator !== true
    && !agent.closed_at
    && typeof agent.session_id === 'string'
    && agent.session_id.length > 0;
}
function nativeFor(options: DaydreamAutomationOptions): DaydreamNativeClient {
  if (options.native) return options.native;
  const token = process.env.HIVE_KIMI_SERVER_TOKEN;
  if (!token) throw new Refusal('HIVE_KIMI_SERVER_TOKEN is required for automated daydreams');
  return new KimiServerClient({ origin: process.env.HIVE_KIMI_SERVER_ORIGIN ?? 'http://127.0.0.1:58627', token });
}
function runnerFor(options: DaydreamAutomationOptions): { runner: DaydreamAutomationRunner; native?: DaydreamNativeClient } {
  if (options.runner) return { runner: options.runner, native: options.native };
  const native = nativeFor(options);
  return { runner: createDaydreamAutomationRunner(native), native };
}
function fingerprint(key: string, sessionId: string, activityAt: number, reason: 'idle' | 'before_compaction'): string {
  return `${key}:${sessionId}:${activityAt}:${reason}`;
}
function currentAgent(team: { agents: TeamEntry[] }, expected: TeamEntry): TeamEntry | undefined {
  return team.agents.find((candidate) => candidate.orchestrator !== true
    && candidate.name === expected.name
    && candidate.worktree === expected.worktree
    && candidate.session_id === expected.session_id);
}
async function revalidateReservation(
  root: string,
  project: string,
  reservation: DaydreamAutomationReservation,
): Promise<TeamEntry | null> {
  const registered = (await readProjects(root)).projects.find((candidate) => candidate.name === project);
  if (!registered) return null;
  return withTeamLock(registered.home, async () => {
    const current = currentAgent(await readTeam(registered.home), {
      name: reservation.agentName,
      worktree: reservation.worktree,
      session_id: reservation.sessionId,
    });
    return current && automationEnabled(current) ? current : null;
  });
}
function errorDetail(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

export async function reserveDaydreamAutomation(
  root: string,
  project: string,
  agent: TeamEntry,
  options: DaydreamAutomationOptions = {},
): Promise<DaydreamAutomationReservation | null> {
  if (!automationEnabled(agent)) return null;
  const now = options.now ?? Date.now();
  const activityAt = options.activityAt === undefined
    ? await wireActivityAt(os.homedir(), agent.session_id!)
    : options.activityAt;
  if (activityAt === null || !Number.isFinite(activityAt)) return null;
  const reason = options.trigger ?? 'idle';
  if (reason === 'idle' && now - activityAt < (options.idleMs ?? IDLE_MS)) return null;
  await assertExecutionAllowed(root, project);
  const budgets = budgetsFor(options);
  const key = agentKey(agent);
  const print = fingerprint(key, agent.session_id!, activityAt, reason);
  const ownerStartTime = await readProcessStartTime(process.pid);
  return withProjectLock(root, project, async (registered) => {
    const current = currentAgent(await readTeam(registered.home), agent);
    if (!current || !automationEnabled(current)) return null;
    const state = await loadState(registered.home);
    if (state.runs.some((run) => run.fingerprint === print)) return null;
    if (state.runs.some((run) => run.fenced)) return null;
    if (!budgetsAllow(state, dayAt(now), key, budgets)) return null;
    const at = new Date(now).toISOString();
    const run: DaydreamAutomationRun = {
      schemaVersion: 1,
      fingerprint: print,
      daydreamId: randomUUID(),
      project,
      agentKey: key,
      agentName: agent.name,
      sessionId: agent.session_id!,
      ownerPid: process.pid,
      ownerStartTime,
      worktree: agent.worktree,
      activityAt,
      reason,
      status: 'reserved',
      fenced: true,
      usageRecorded: false,
      reservedPrompts: PROMPT_CEILING,
      reservedCompactions: COMPACTION_CEILING,
      prompts: 0,
      compactions: 0,
      tokens: 0,
      createdAt: at,
      updatedAt: at,
    };
    state.runs.push(run);
    await writeState(registered.home, state);
    return run;
  });
}

function validCounts(result: DaydreamAutomationOutcome): boolean {
  return ['prompts', 'compactions', 'tokens'].every((field) => {
    const value = result[field as 'prompts' | 'compactions' | 'tokens'];
    return Number.isSafeInteger(value) && value >= 0;
  });
}
function validRecovery(run: DaydreamAutomationRun, result: DaydreamAutomationOutcome): boolean {
  return result.status === 'recovered' && result.daydreamId === run.daydreamId && validCounts(result)
    && result.prompts <= PROMPT_CEILING && result.compactions <= COMPACTION_CEILING;
}
function actualUsage(run: DaydreamAutomationRun, result: DaydreamAutomationOutcome, conservative: boolean): DaydreamAutomationUsage {
  if (conservative || !validCounts(result)) {
    return { runs: 1, prompts: run.reservedPrompts, compactions: run.reservedCompactions, tokens: 0 };
  }
  return { runs: 1, prompts: result.prompts, compactions: result.compactions, tokens: result.tokens };
}
async function finalizeUsage(
  root: string,
  project: string,
  reservation: DaydreamAutomationReservation,
  result: DaydreamAutomationOutcome,
  now: number,
  { crashed = false, reconciled = false }: { crashed?: boolean; reconciled?: boolean } = {},
): Promise<DaydreamAutomationRun> {
  return withProjectLock(root, project, async (registered) => {
    const state = await loadState(registered.home);
    const run = state.runs.find((candidate) => candidate.daydreamId === reservation.daydreamId);
    if (!run) throw new Refusal('daydream automation reservation is missing');
    if (run.status === 'recovered' && !run.fenced) return run;
    const recovered = validRecovery(run, result) && !crashed;
    const missing = reconciled && result.status === 'missing';
    const invalidSuccess = result.status === 'recovered' && !recovered;
    const counted = actualUsage(run, result, crashed || reconciled || invalidSuccess);
    const daily = dailyFor(state, dayAt(Date.parse(run.createdAt)));
    if (!run.usageRecorded) {
      addUsage(daily.project, counted);
      addUsage(daily.agents[run.agentKey] ??= emptyUsage(), counted);
      run.prompts = counted.prompts;
      run.compactions = counted.compactions;
      run.tokens = counted.tokens;
      run.usageRecorded = true;
    } else if (recovered) {
      const delta = {
        runs: 0,
        prompts: Math.max(0, counted.prompts - run.prompts),
        compactions: Math.max(0, counted.compactions - run.compactions),
        tokens: Math.max(0, counted.tokens - run.tokens),
      };
      addUsage(daily.project, delta);
      addUsage(daily.agents[run.agentKey] ??= emptyUsage(), delta);
      run.prompts = Math.max(run.prompts, counted.prompts);
      run.compactions = Math.max(run.compactions, counted.compactions);
      run.tokens = Math.max(run.tokens, counted.tokens);
    }
    state.daily[dayAt(Date.parse(run.createdAt))] = daily;
    run.status = recovered ? 'recovered' : 'unknown';
    run.fenced = !recovered && !missing;
    run.updatedAt = new Date(now).toISOString();
    run.unknownStage = recovered ? undefined : result.unknownStage ?? (invalidSuccess ? 'prompt' : 'result');
    run.error = recovered || !crashed ? undefined : `unknown: ${errorDetail(result.unknownStage ?? 'native effect')}`;
    if (reconciled) run.reconciledAt = run.updatedAt;
    if (recovered) await recordDaydreamArtifact(registered.home, run);
    await writeState(registered.home, state);
    return run;
  });
}

export async function maybeDaydreamAutomation(
  root: string,
  project: string,
  agent: TeamEntry,
  options: DaydreamAutomationOptions = {},
): Promise<DaydreamAutomationRun | null> {
  const reservation = await reserveDaydreamAutomation(root, project, agent, options);
  if (!reservation) return null;
  const current = await revalidateReservation(root, project, reservation);
  if (!current) {
    return finalizeUsage(root, project, reservation, {
      daydreamId: reservation.daydreamId,
      status: 'unknown',
      prompts: reservation.reservedPrompts,
      compactions: reservation.reservedCompactions,
      tokens: 0,
      unknownStage: 'reservation',
    }, options.now ?? Date.now(), { crashed: true });
  }
  const { runner, native } = runnerFor(options);
  let result: DaydreamAutomationOutcome;
  let crashed = false;
  try {
    result = await runner.run({
      root,
      project,
      agent: current,
      daydreamId: reservation.daydreamId,
      sessionId: reservation.sessionId,
      activityAt: reservation.activityAt,
      reason: reservation.reason,
      native,
      now: options.now ?? Date.now(),
    });
  } catch {
    crashed = true;
    result = {
      daydreamId: reservation.daydreamId,
      status: 'unknown',
      prompts: reservation.reservedPrompts,
      compactions: reservation.reservedCompactions,
      tokens: 0,
      unknownStage: 'result',
    };
  }
  return finalizeUsage(root, project, reservation, result, options.now ?? Date.now(), { crashed });
}

export async function reconcileDaydreamAutomation(
  root: string,
  project: string,
  daydreamId: string,
  options: DaydreamAutomationOptions = {},
): Promise<DaydreamAutomationRun> {
  const reservation = await withProjectLock(root, project, async (registered) => {
    const state = await loadState(registered.home);
    const run = state.runs.find((candidate) => candidate.daydreamId === daydreamId);
    if (!run) throw new Refusal(`unknown automated daydream: ${daydreamId}`);
    return run;
  });
  if (!reservation.fenced) return reservation;
  const { runner, native } = runnerFor(options);
  const result = await runner.reconcile({
    root,
    project,
    daydreamId,
    parentSessionId: reservation.sessionId,
    ownerPid: reservation.ownerPid,
    ownerStartTime: reservation.ownerStartTime,
    native,
    now: options.now ?? Date.now(),
  });
  if (result.status === 'unknown' || result.daydreamId !== daydreamId) return reservation;
  return finalizeUsage(root, project, reservation, result, options.now ?? Date.now(), { reconciled: true });
}

export async function getDaydreamAutomationStatus(root: string, project: string): Promise<DaydreamAutomationProjectStatus> {
  const registered = (await readProjects(root)).projects.find((candidate) => candidate.name === project);
  if (!registered) throw new Refusal(`unknown project: ${project}`);
  const [team, state] = await Promise.all([readTeam(registered.home), loadState(registered.home)]);
  const daily = dailyFor(state, dayAt(Date.now()));
  return {
    project,
    agents: team.agents.map((agent) => ({
      name: agent.name,
      ...(agent.worktree === undefined ? {} : { worktree: agent.worktree }),
      daydreamAutomation: agent.daydream_automation === true,
      fencedDaydreamId: state.runs.find((run) => run.agentKey === agentKey(agent) && run.fenced)?.daydreamId ?? null,
    })),
    runs: state.runs,
    daily,
  };
}

export async function setDaydreamAutomation(
  root: string,
  project: string,
  agentRef: string | undefined,
  enabled: boolean,
): Promise<void> {
  if (agentRef === undefined) throw new Refusal('daydream automation requires a worker agent');
  const registered = (await readProjects(root)).projects.find((candidate) => candidate.name === project);
  if (!registered) throw new Refusal(`unknown project: ${project}`);
  await withTeamLock(registered.home, async () => {
    const team = await readTeam(registered.home);
    const [name, worktree] = agentRef.split('@');
    const matches = team.agents.filter((agent) => !agent.orchestrator && agent.name === name
      && (worktree === undefined || agent.worktree === worktree));
    if (matches.length > 1) throw new Refusal(`${project} has several agents named ${name}; say which: ${name}@<worktree>`);
    const index = matches.length === 1 ? team.agents.indexOf(matches[0]) : -1;
    if (index < 0) throw new Refusal(`${project} has no agent named ${agentRef ?? `${project}-orchestrator`}`);
    team.agents[index] = { ...team.agents[index], daydream_automation: enabled };
    await writeJson(hivePath(registered.home, 'team.json'), team);
    await appendDecision(root, {
      project,
      by: 'owner',
      summary: `${enabled ? 'enabled' : 'disabled'} daydream automation for ${project}/${team.agents[index].name}`,
    });
  });
}
