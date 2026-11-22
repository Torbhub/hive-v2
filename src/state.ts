import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readJsonl } from './jsonl.js';
import type { Approvals, Checkpoint, Decision, HubTask, ProjectMode, RootContract, TaskEvent, TeamEntry } from './types.js';
import { APPROVALS_MODES, NEEDS_OWNER_STATES, PROJECT_MODES, TASK_EVENTS } from './types.js';

export const HUB_DIR = '.hive-hub';
export const HIVE_DIR = '.hive';

export class Refusal extends Error {}

export function hubPath(root: string, ...parts: string[]): string {
  return path.join(root, HUB_DIR, ...parts);
}

export function hivePath(projectHome: string, ...parts: string[]): string {
  return path.join(projectHome, HIVE_DIR, ...parts);
}

export async function readJson<T>(file: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new Error(`corrupt JSON in ${file}: ${e instanceof Error ? e.message : e}`);
  }
}

export async function writeJson(file: string, value: unknown, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', mode === undefined ? {} : { mode });
  await fs.rename(tmp, file);
}

export type ProjectsFile = {
  projects: {
    name: string; home: string; repos: { folder: string }[]; mode?: ProjectMode; approvals?: Approvals;
    collaboration_execution_disabled_at?: string;
  }[];
};

export async function readProjects(root: string): Promise<ProjectsFile> {
  return (await readJson<ProjectsFile>(hubPath(root, 'projects.json'))) ?? { projects: [] };
}

export async function writeProjects(root: string, pf: ProjectsFile): Promise<void> {
  for (const p of pf.projects) {
    if (p.mode !== undefined && !(PROJECT_MODES as readonly string[]).includes(p.mode)) {
      throw new Error(`a project mode is ask|yolo|auto: ${p.mode}`);
    }
    if (p.approvals !== undefined && !(APPROVALS_MODES as readonly string[]).includes(p.approvals)) {
      throw new Error(`project approvals is manual|safe|smart: ${p.approvals}`);
    }
  }
  await writeJson(hubPath(root, 'projects.json'), pf);
}

export async function appendTaskEvent(root: string, ev: TaskEvent): Promise<void> {
  if (!(TASK_EVENTS as readonly string[]).includes(ev.event)) {
    throw new Error(`unknown task event: ${ev.event}`);
  }
  await fs.mkdir(hubPath(root), { recursive: true });
  await fs.appendFile(hubPath(root, 'tasks.jsonl'), JSON.stringify(ev) + '\n');
}

export async function readTaskEvents(root: string): Promise<TaskEvent[]> {
  return readJsonl<TaskEvent>(hubPath(root, 'tasks.jsonl'));
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function valueDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function contractDigest(contract: RootContract): string {
  return valueDigest(contract);
}

export function validateRootContract(contract: RootContract): void {
  const nonEmpty = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
  if (!contract || contract.schema_version !== 1
    || ![contract.objective, contract.consumer, contract.deliverable].every(nonEmpty)
    || !['build', 'research', 'remediation'].includes(contract.kind)) {
    throw new Refusal('the root contract is incomplete');
  }
  if (!Array.isArray(contract.acceptance) || contract.acceptance.length === 0) {
    throw new Refusal('the root contract needs registered acceptance predicates');
  }
  const ids = new Set<string>();
  for (const acceptance of contract.acceptance) {
    if (!nonEmpty(acceptance.id) || ids.has(acceptance.id) || !nonEmpty(acceptance.predicate_id)
      || !positive(acceptance.version) || !acceptance.configuration || Array.isArray(acceptance.configuration)
      || !Array.isArray(acceptance.required_evidence) || acceptance.required_evidence.length === 0
      || !acceptance.required_evidence.every(nonEmpty)
      || acceptance.required !== undefined && typeof acceptance.required !== 'boolean') {
      throw new Refusal('the root contract has an invalid acceptance predicate');
    }
    ids.add(acceptance.id);
  }
  const provenance = contract.provenance;
  const sources = provenance?.kind === 'research' ? provenance.source_range.sources : [];
  const validResearch = provenance?.kind === 'research' && contract.kind === 'research'
    && nonEmpty(provenance.source_range.start) && nonEmpty(provenance.source_range.end)
    && Array.isArray(sources) && sources.length > 0
    && sources.every((source) => nonEmpty(source.id) && nonEmpty(source.path)
      && /^[0-9a-f]{64}$/.test(source.sha256) && Number.isFinite(Date.parse(source.observed_at)))
    && new Set(sources.map((source) => source.id)).size === sources.length
    && sources[0].id === provenance.source_range.start
    && sources.at(-1)!.id === provenance.source_range.end
    && Number.isFinite(Date.parse(provenance.evidence_window?.starts_at ?? ''))
    && Number.isFinite(Date.parse(provenance.evidence_window?.ends_at ?? ''))
    && Date.parse(provenance.evidence_window.starts_at) < Date.parse(provenance.evidence_window.ends_at);
  const validCode = provenance && (provenance.kind === undefined || provenance.kind === 'code')
    && nonEmpty(provenance.repository)
    && /^[0-9a-f]{40}$/i.test(provenance.base_revision)
    && /^[0-9a-f]{40}$/i.test(provenance.artifact_revision);
  if (!provenance || !validResearch && !validCode
    || !Array.isArray(contract.write_scope) || !Array.isArray(contract.action_scope)
    || !contract.write_scope.every(nonEmpty) || !contract.action_scope.every(nonEmpty)
    || contract.required_children !== undefined
      && (!Array.isArray(contract.required_children) || !contract.required_children.every(nonEmpty))) {
    throw new Refusal('the root contract has invalid provenance or scope');
  }
  if (!contract.budget || !(['depth', 'active_children', 'active_project_records', 'attempts'] as const)
    .every((key) => positive(contract.budget[key]))
    || contract.budget.wall_seconds !== undefined && !positive(contract.budget.wall_seconds)
    || !contract.delegation || !Array.isArray(contract.delegation.output_claims)
    || !contract.delegation.output_claims.every(nonEmpty) || contract.delegation.output_claims.length === 0
    || !Array.isArray(contract.delegation.adapters) || contract.delegation.adapters.length === 0) {
    throw new Refusal('the root contract has invalid budgets or delegation');
  }
  if (contract.kind === 'remediation' && !nonEmpty(contract.defect_fingerprint)) {
    throw new Refusal('remediation needs a defect fingerprint');
  }
}

export function planDigest(checkpoints: Checkpoint[], note?: string): string {
  return createHash('sha256').update(canonicalJson({ schema_version: 1, checkpoints, note: note ?? '' })).digest('hex');
}

export function taskEvidenceDigests(artifact: unknown, content: unknown): {
  artifact_digest: string; evidence_hash: string;
} {
  return {
    artifact_digest: createHash('sha256').update(canonicalJson(artifact)).digest('hex'),
    evidence_hash: createHash('sha256').update(canonicalJson({ artifact, content })).digest('hex'),
  };
}

function wallDeadline(contract: RootContract | null | undefined, admittedAt: string | null | undefined): string | null {
  if (!contract?.budget.wall_seconds || !admittedAt) return null;
  return new Date(Date.parse(admittedAt) + contract.budget.wall_seconds * 1000).toISOString();
}

export function taskBudgetExpired(task: HubTask, now = Date.now()): boolean {
  return task.state === 'blocked:budget_exhausted'
    || task.expires_at !== undefined && task.expires_at !== null && Date.parse(task.expires_at) <= now;
}

export function assertTaskBudgetCurrent(task: HubTask, now = Date.now()): void {
  if (taskBudgetExpired(task, now)) throw new Refusal(`${task.id} is blocked:budget_exhausted`);
}

export function hasAttemptRecovery(events: TaskEvent[], taskId: string): boolean {
  let contract: RootContract | null | undefined;
  let previousContract: RootContract | null | undefined;
  for (const event of events) {
    if (event.id !== taskId) continue;
    if (event.event === 'asked') contract = null;
    if (event.event === 'plan') {
      previousContract = contract;
      contract = event.contract ?? null;
    }
    if (event.event === 'answered' && event.note === 'root contract delta approved by owner'
      && previousContract && contract && contract.budget.attempts > previousContract.budget.attempts) {
      return true;
    }
  }
  return false;
}

export function foldTasks(events: TaskEvent[]): HubTask[] {
  const byId = new Map<string, HubTask & { decisions: { at: string; reason: string }[] }>();
  const previousContracts = new Map<string, RootContract | null | undefined>();
  const previousDeadlines = new Map<string, string | null | undefined>();
  const recoveredTasks = new Set<string>();
  for (const ev of events) {
    const previous = byId.get(ev.id);
    let t = previous;
    if (!t) {
      t = {
        id: ev.id, project: ev.project, asked: ev.at, state: ev.event,
        updated: ev.at, last_note: null, needs_owner: false, decisions: [],
        checkpoints: [], progress: {}, last_progress_at: null, plan_approved: false, checkpoint_accepts: {},
      };
      byId.set(ev.id, t);
    }
    t.updated = ev.at;
    if (ev.lease_epoch !== undefined) t.lease_epoch = ev.lease_epoch;
    if (ev.event === 'admission') {
      if (ev.admission) {
        const admissions = t.admissions ??= [];
        for (const old of admissions) {
          if (ev.supersedes?.includes(old.lease_id)) {
            old.status = 'superseded';
            old.lease_revoked = true;
          }
        }
        const index = admissions.findIndex((old) => old.lease_id === ev.admission!.lease_id);
        if (index < 0) admissions.push(ev.admission);
        else admissions[index] = ev.admission;
      }
    } else if (ev.event === 'operation' && ev.operation) {
      (t.operations ??= []).push(ev.operation);
      if (ev.operation.kind === 'github_check'
        && (ev.operation.status === 'blocked_external' || ev.operation.status === 'closing_external')) {
        t.state = ev.operation.detail === 'deadline_exceeded' ? 'blocked_external:deadline_exceeded' : ev.operation.status;
        t.resume_state = 'reconciling';
        t.unblock_condition = ev.operation.resume_condition ?? null;
        t.resume_condition = null;
        t.last_note = ev.operation.detail ?? null;
      }
    } else if (ev.event === 'human_acceptance' && ev.human_acceptance) {
      const acceptance = ev.human_acceptance;
      (t.human_acceptance ??= {})[acceptance.acceptance_id] = acceptance;
    } else if (ev.event === 'note') {
      t.last_note = ev.note ?? null;
    } else if (ev.event === 'progress') {
      if (ev.checkpoint && ev.status) {
        t.progress![ev.checkpoint] = { status: ev.status, note: ev.note, at: ev.at };
        t.last_progress_at = ev.at;
        if (ev.status === 'fail') delete t.checkpoint_accepts![ev.checkpoint];
      }
    } else if (ev.event === 'planaccept') {
      if (ev.checkpoint) t.checkpoint_accepts![ev.checkpoint] = ev.at;
    } else if (ev.event === 'evidence' && ev.evidence) {
      t.receipt_actor ??= ev.evidence.actor;
    } else if (ev.event === 'receipt' && ev.receipt) {
      const receipt = ev.receipt;
      t.last_receipt = receipt;
      t.receipt_actor = receipt.actor;
      t.last_receipt_sequence = receipt.sequence;
      if (receipt.state) t.state = receipt.state;
      if (receipt.state === 'blocked') {
        t.resume_state = receipt.blocker_kind === 'execution' ? 'running' : 'reconciling';
        t.unblock_condition = receipt.unblock_condition ?? null;
        t.resume_condition = receipt.resume_condition ?? null;
      } else if (receipt.state) {
        t.resume_state = null;
        t.unblock_condition = null;
        t.resume_condition = null;
      }
      if (ev.note) t.last_note = ev.note;
    } else {
      const prev = t.state;
      t.state = ev.event;
      t.resume_state = null;
      t.unblock_condition = null;
      t.resume_condition = null;
      if (ev.event === 'blocked' && ev.note === 'blocked:budget_exhausted') {
        t.state = 'blocked:budget_exhausted';
        t.lease_revoked = true;
      }
      if (ev.event === 'blocked' && ev.note?.startsWith('blocked:unsupported_predicate')) {
        t.resume_state = 'reconciling';
        t.unblock_condition = ev.note;
      }
      if (ev.event === 'plan') {
        previousContracts.set(ev.id, t.contract);
        previousDeadlines.set(ev.id, t.expires_at);
        t.checkpoints = validCheckpoints(ev.checkpoints) ?? [];
        t.plan_digest = ev.plan_digest ?? (t.checkpoints.length ? planDigest(t.checkpoints, ev.note) : null);
        t.contract = ev.contract ?? null;
        t.lease_epoch ??= 1;
        if (prev === 'blocked:budget_exhausted') t.lease_revoked = false;
        t.progress = {};
        t.checkpoint_accepts = {};
        t.plan_approved = false;
        t.receipt_actor = null;
        t.last_receipt_sequence = 0;
        t.last_receipt = null;
        t.expires_at = wallDeadline(t.contract, t.admitted_at);
      }
      if (ev.event === 'asked') {
        if (previous) {
          t.lease_epoch = (t.lease_epoch ?? 1) + 1;
          t.lease_revoked = false;
        }
        t.checkpoints = [];
        t.plan_digest = null;
        t.contract = null;
        t.progress = {};
        t.checkpoint_accepts = {};
        t.plan_approved = false;
        t.last_progress_at = null;
        t.receipt_actor = null;
        t.last_receipt_sequence = 0;
        t.last_receipt = null;
        t.admitted_at = null;
        t.expires_at = null;
      }
      if (ev.event === 'cancelled' || ev.event === 'superseded') {
        t.lease_epoch = (t.lease_epoch ?? 1) + 1;
        t.lease_revoked = true;
      }
      if (ev.event === 'answered' && prev === 'plan') {
        const previousContract = previousContracts.get(ev.id);
        const previousDeadline = previousDeadlines.get(ev.id);
        const attemptRecovery = ev.note === 'root contract delta approved by owner' && previousContract
          && t.contract!.budget.attempts > previousContract.budget.attempts;
        t.plan_approved = true;
        t.admitted_at ??= ev.at;
        if (attemptRecovery) {
          const firstRecovery = !recoveredTasks.has(ev.id);
          recoveredTasks.add(ev.id);
          t.expires_at = firstRecovery && previousDeadline
            ? wallDeadline(t.contract, previousDeadline)
            : previousDeadline ?? wallDeadline(t.contract, t.admitted_at);
        } else {
          t.expires_at = wallDeadline(t.contract, t.admitted_at);
        }
      }
      if (ev.event === 'decided') t.decisions.push({ at: ev.at, reason: ev.note ?? '' });
      if (ev.note) t.last_note = ev.note;
    }
  }
  const out = [...byId.values()];
  for (const t of out) t.needs_owner = NEEDS_OWNER_STATES.has(t.state);
  out.sort((a, b) => a.asked.localeCompare(b.asked));
  return out;
}

function outcomeDetails(events: TaskEvent[], task: HubTask): TaskEvent['outcome'] {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.id === task.id && event.event === task.state && event.outcome) return event.outcome;
  }
  return undefined;
}

export function childReconciled(events: TaskEvent[], id: string, project: string, seen = new Set<string>()): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  const tasks = foldTasks(events);
  const task = tasks.find((candidate) => candidate.id === id && candidate.project === project);
  if (!task) return false;
  if (['done', 'already_fixed', 'no_op'].includes(task.state)) return true;
  if (task.state !== 'duplicate') return false;
  const covering = outcomeDetails(events, task)?.covering_record;
  if (!covering) return false;
  return tasks.some((candidate) => candidate.id === covering && candidate.project === project)
    ? childReconciled(events, covering, project, seen) : false;
}

export function validCheckpoints(cps: unknown): Checkpoint[] | null {
  if (!Array.isArray(cps) || cps.length === 0) return null;
  const ids = new Set<string>();
  for (const c of cps) {
    if (!c || typeof c !== 'object') return null;
    const { id, desc, etaMin } = c as Checkpoint;
    if (typeof id !== 'string' || !id.trim()) return null;
    if (ids.has(id.trim())) return null;
    ids.add(id.trim());
    if (typeof desc !== 'string' || !desc.trim()) return null;
    if (typeof etaMin !== 'number' || !Number.isFinite(etaMin) || !(etaMin > 0)) return null;
  }
  return cps as Checkpoint[];
}

export function doneBlockers(t: HubTask): string[] {
  const out: string[] = [];
  for (const c of t.checkpoints ?? []) {
    const p = t.progress?.[c.id];
    if (!p || p.status === 'started') {
      out.push(`${c.id} has no terminal progress`);
      continue;
    }
    if (p.status === 'ok') continue;
    if (p.status === 'skip') {
      if (!p.note?.trim()) out.push(`${c.id} was skipped without a note`);
      continue;
    }
    if (!t.checkpoint_accepts?.[c.id]) out.push(`${c.id} failed and the owner has not accepted it`);
  }
  return out;
}

export function extractCommand(dialogText: string): string | null {
  const m = dialogText.match(/^\s*(?:▶\s*)?\$\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

export async function nextTaskId(root: string, project: string): Promise<string> {
  const events = await readTaskEvents(root);
  let max = 0;
  for (const ev of events) {
    const m = ev.id.match(new RegExp(`^${project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${project}-${max + 1}`;
}

export async function readTeam(projectHome: string): Promise<{ agents: TeamEntry[] }> {
  return (await readJson<{ agents: TeamEntry[] }>(hivePath(projectHome, 'team.json'))) ?? { agents: [] };
}

type LockOptions = { staleMs?: number; waitMs?: number };

export async function releaseDirLock(lock: string, token: string): Promise<void> {
  const owner = await readJson<{ token: string }>(path.join(lock, 'owner.json'));
  if (owner?.token !== token) return;
  await fs.rm(lock, { recursive: true, force: true });
}

async function withDirLock<T>(lock: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const { waitMs = 10_000 } = options;
  await fs.mkdir(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + waitMs;
  const token = randomUUID();
  for (;;) {
    try {
      await fs.mkdir(lock);
      await writeJson(path.join(lock, 'owner.json'), { token });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        await fs.rmdir(lock).catch(() => {});
        throw error;
      }
      if (Date.now() > deadline) throw new Error(`locked: ${lock}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await fn();
  } finally {
    await releaseDirLock(lock, token);
  }
}

export async function withTeamLock<T>(projectHome: string, fn: () => Promise<T>, options?: LockOptions): Promise<T> {
  return withDirLock(hivePath(projectHome, 'team.json.lock'), fn, options);
}

export async function withHubLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  return withDirLock(hubPath(root, 'lock'), fn);
}

export async function insertTeamEntry(projectHome: string, entry: TeamEntry): Promise<TeamEntry> {
  return withTeamLock(projectHome, async () => {
    const team = await readTeam(projectHome);
    if (team.agents.some((old) => old.name === entry.name && old.worktree === entry.worktree)) {
      throw new Refusal(`${projectHome} already has an agent named ${entry.name}`);
    }
    await writeJson(hivePath(projectHome, 'team.json'), { agents: [...team.agents, entry] });
    return entry;
  });
}

export async function compareAndSwapTeamEntryLocked(
  projectHome: string, expected: TeamEntry, update: Partial<TeamEntry> | null,
): Promise<TeamEntry | null | undefined> {
  const team = await readTeam(projectHome);
  const index = team.agents.findIndex((old) => canonicalJson(old) === canonicalJson(expected));
  if (index < 0) return undefined;
  const next = update === null ? null : { ...team.agents[index], ...update };
  const agents = team.agents.filter((_, candidate) => candidate !== index);
  if (next) agents.splice(index, 0, next);
  await writeJson(hivePath(projectHome, 'team.json'), { agents });
  return next;
}

export async function compareAndSwapTeamEntry(
  projectHome: string, expected: TeamEntry, update: Partial<TeamEntry> | null,
): Promise<TeamEntry | null | undefined> {
  return withTeamLock(projectHome, () => compareAndSwapTeamEntryLocked(projectHome, expected, update));
}

export async function upsertTeamEntry(projectHome: string, entry: TeamEntry): Promise<void> {
  await withTeamLock(projectHome, async () => {
    const team = await readTeam(projectHome);
    const i = team.agents.findIndex((a) => a.name === entry.name);
    if (i >= 0) team.agents[i] = { ...team.agents[i], ...entry };
    else team.agents.push(entry);
    await writeJson(hivePath(projectHome, 'team.json'), team);
  });
}

export type ManifestRecord = { kind: 'worktree' | 'jj-workspace' | 'tmux' | 'process'; at: string; [k: string]: unknown };

export async function manifestAdd(projectHome: string, rec: ManifestRecord): Promise<void> {
  await fs.mkdir(hivePath(projectHome), { recursive: true });
  await fs.appendFile(hivePath(projectHome, 'manifest.jsonl'), JSON.stringify(rec) + '\n');
}

export async function manifestRead(projectHome: string): Promise<ManifestRecord[]> {
  return readJsonl<ManifestRecord>(hivePath(projectHome, 'manifest.jsonl'));
}

export async function manifestWrite(projectHome: string, recs: ManifestRecord[]): Promise<void> {
  await fs.writeFile(
    hivePath(projectHome, 'manifest.jsonl'),
    recs.map((r) => JSON.stringify(r)).join('\n') + (recs.length ? '\n' : ''),
  );
}

export type PendingPane = {
  pane: string; kind: string; at: string;
  pane_pid?: number; pane_started?: string;
  typed?: boolean; sending?: boolean; claim_token?: string; question?: boolean; task?: string; line?: string;
  model?: string;
  launch_mode?: TeamEntry['launch_mode'];
  launch_scoped_auto?: boolean;
  watch_authority_revoked_at?: string;
  migration_state?: TeamEntry['migration_state'];
};

const SENDING_CLAIM_STALE_MS = 10 * 60_000;

export function hasLiveSendingClaim(pending: PendingPane, now = Date.now()): boolean {
  if (!pending.sending) return false;
  const age = now - Date.parse(pending.at);
  return !Number.isFinite(age) || age <= SENDING_CLAIM_STALE_MS;
}

export async function readPendingPane(root: string, project: string): Promise<PendingPane | null> {
  return readJson<PendingPane>(hubPath(root, 'panes', `${project}.json`));
}

export async function writePendingPane(root: string, project: string, p: PendingPane): Promise<void> {
  await writeJson(hubPath(root, 'panes', `${project}.json`), p);
}

export async function clearPendingPane(root: string, project: string): Promise<void> {
  await fs.rm(hubPath(root, 'panes', `${project}.json`), { force: true });
}

export async function appendDecision(root: string, d: Omit<Decision, 'at'> & { at?: string }): Promise<void> {
  await fs.mkdir(hubPath(root), { recursive: true });
  await fs.appendFile(
    hubPath(root, 'decisions.jsonl'),
    JSON.stringify({ ...d, at: d.at ?? new Date().toISOString() }) + '\n',
  );
}

export async function readDecisions(root: string, latest = 8): Promise<Decision[]> {
  const records = await readJsonl<Decision>(hubPath(root, 'decisions.jsonl'));
  const now = Date.now();
  const logical = new Map<string, Decision>();
  let messageCount = 0;
  for (const [index, decision] of records.entries()) {
    const key = decision.message_id === undefined ? `decision:${index}` : `message:${decision.message_id}`;
    if (decision.message_id !== undefined && !logical.has(key)) messageCount++;
    logical.delete(key);
    const stale = decision.delivery_status === 'pending' && now - Date.parse(decision.at) > SENDING_CLAIM_STALE_MS;
    logical.set(key, stale ? {
      ...decision,
      delivery_status: 'unknown',
      summary: decision.summary.replace(/pending$/, 'unknown'),
    } : decision);
  }
  let excess = messageCount - 64;
  for (const key of logical.keys()) {
    if (excess <= 0) break;
    if (key.startsWith('message:')) {
      logical.delete(key);
      excess--;
    }
  }
  return [...logical.values()].slice(-latest).reverse();
}
