import { paneExists } from './tmux.js';
import type { Checkpoint, HubTask, RootContract, TaskEvidence, TaskEvent, TaskReceipt } from './types.js';
import { CLOSED_STATES, PROGRESS_STATUSES, TASK_EVIDENCE_OUTCOMES, TASK_EVENTS } from './types.js';
import {
  Refusal, appendDecision, appendTaskEvent, clearPendingPane, contractDigest, doneBlockers, foldTasks,
  planDigest, readPendingPane, readProjects, readTaskEvents, taskEvidenceDigests, validCheckpoints, validateRootContract,
  withHubLock, withTeamLock,
} from './state.js';
import { assertAdmissionCurrentLocked, revokeTaskAdmissionsLocked, transitionTmuxAdmissionLocked } from './admission.js';
import { gitDiffScope } from './scope.js';

export type TaskRevalidate = () => Promise<void>;

function storedTask(events: TaskEvent[], id: string): HubTask {
  const task = foldTasks(events).find((candidate) => candidate.id === id);
  if (!task) throw new Refusal(`unknown task: ${id}`);
  return task;
}

// hubLog's teeth: owner verdicts enter through plan-answer and accept, plans
// carry checkpoints, handed needs an approved plan, done needs every
// checkpoint terminal.
export function assertLogAllowed(task: HubTask, event: string, checkpoints?: Checkpoint[]): void {
  if (event === 'answered' || event === 'planaccept') {
    throw new Refusal(`${event} is owner-only: use hive hub plan-answer or hive hub accept`);
  }
  if (event === 'receipt') throw new Refusal('receipt is adapter-only: use the task receipt API');
  if (event === 'plan' && !validCheckpoints(checkpoints)) {
    throw new Refusal(`a plan needs checkpoints: [{"id":"a","desc":"what","etaMin":5}, ...]`);
  }
  if (event === 'handed' || event === 'done') {
    if (!task.plan_approved) {
      throw new Refusal(`${task.id} has no approved plan; the owner approves the plan first`);
    }
    if (event === 'done') {
      const blockers = doneBlockers(task);
      if (blockers.length) throw new Refusal(`${task.id} is not done: ${blockers.join('; ')}`);
    }
  }
}

export async function hubLog(
  root: string, id: string, event: string, note?: string, checkpoints?: Checkpoint[], revalidate?: TaskRevalidate,
  contract?: RootContract,
): Promise<void> {
  if (!(TASK_EVENTS as readonly string[]).includes(event)) throw new Error(`unknown task event: ${event}`);
  if (contract !== undefined && event !== 'plan') throw new Refusal('a root contract belongs on a plan event');
  if (contract) validateRootContract(contract);
  await withHubLock(root, async () => {
    await revalidate?.();
    const events = await readTaskEvents(root);
    const task = storedTask(events, id);
    assertLogAllowed(task, event, checkpoints);
    await appendTaskEvent(root, {
      id, project: task.project, event: event as TaskEvent['event'], at: new Date().toISOString(), note,
      ...(event === 'plan' ? {
        checkpoints,
        plan_digest: contract ? contractDigest(contract) : planDigest(checkpoints!, note),
        ...(contract ? { contract } : {}),
      } : {}),
    });
    if (event === 'decided') {
      await appendDecision(root, { project: task.project, task: id, by: 'orchestrator', summary: note ?? '' });
    }
  });
}

// One progress event per checkpoint call; the fold turns them into the trail.
export async function hubProgress(
  root: string, id: string, checkpoint: string, status: string, note?: string, revalidate?: TaskRevalidate,
  project?: string,
): Promise<void> {
  if (!(PROGRESS_STATUSES as readonly string[]).includes(status)) {
    throw new Refusal(`a progress status is started|ok|fail|skip: ${status}`);
  }
  await withHubLock(root, async () => {
    await revalidate?.();
    const task = storedTask(await readTaskEvents(root), id);
    assertTaskProject(task, project);
    if (!(task.checkpoints ?? []).some((c) => c.id === checkpoint)) {
      throw new Refusal(`${id} has no checkpoint ${checkpoint} in its plan`);
    }
    if (status === 'skip' && !note?.trim()) {
      throw new Refusal('a skipped checkpoint needs a note saying why');
    }
    await appendTaskEvent(root, {
      id, project: task.project, event: 'progress', at: new Date().toISOString(),
      note, checkpoint, status: status as TaskEvent['status'],
    });
  });
}

// The owner accepts a failed checkpoint; only then can done pass with a fail.
export async function hubAccept(
  root: string, id: string, checkpoint: string, revalidate?: TaskRevalidate,
): Promise<void> {
  await withHubLock(root, async () => {
    await revalidate?.();
    const task = storedTask(await readTaskEvents(root), id);
    if (!(task.checkpoints ?? []).some((c) => c.id === checkpoint)) {
      throw new Refusal(`${id} has no checkpoint ${checkpoint} in its plan`);
    }
    if (task.progress?.[checkpoint]?.status !== 'fail') {
      throw new Refusal(`${id} checkpoint ${checkpoint} has not failed; nothing to accept`);
    }
    await appendTaskEvent(root, {
      id, project: task.project, event: 'planaccept', at: new Date().toISOString(),
      checkpoint, note: 'owner accepted the failure',
    });
  });
}

export async function hubResolve(
  root: string, project: string, id: string, action: 'cancel' | 'rebrief', note?: string,
  revalidate?: TaskRevalidate,
): Promise<void> {
  await withHubLock(root, async () => {
    await revalidate?.();
    const task = storedTask(await readTaskEvents(root), id);
    assertTaskProject(task, project);
    if (CLOSED_STATES.has(task.state)) throw new Refusal(`${id} is already ${task.state}`);
    const registered = (await readProjects(root)).projects.find((candidate) => candidate.name === project);
    if (registered) await withTeamLock(registered.home, () => revokeTaskAdmissionsLocked(root, registered.home, id));
    await appendTaskEvent(root, {
      id, project, event: action === 'cancel' ? 'cancelled' : 'asked',
      at: new Date().toISOString(), note: action === 'cancel' ? note || 'cancelled by the owner' : note,
    });
    await appendDecision(root, {
      project, task: id, by: 'owner',
      summary: action === 'cancel' ? `cancelled ${id}` : `rebriefed ${id}: ${(note ?? '').slice(0, 120)}`,
    });
  });
}

// planAnswer's verdict math. A plan without valid checkpoints cannot be
// approved; approve turns into a send-back so the orchestrator re-plans.
export function planVerdict(
  task: HubTask,
  verdict: string,
  feedback: string,
): { line: string; event: 'answered' | 'handed'; note: string; summary: string } {
  const approved = verdict === 'approve' && validCheckpoints(task.checkpoints) !== null;
  const reason = verdict === 'approve' && !approved ? 'plan has no checkpoints' : feedback;
  return {
    line: approved
      ? `${task.id}: the plan is approved — go ahead.`
      : `${task.id}: the plan is sent back${reason ? ` — ${reason}` : ''}.`,
    event: approved ? 'answered' : 'handed',
    note: approved ? 'plan approved by owner' : `plan sent back${reason ? `: ${reason}` : ''}`,
    summary: approved ? 'approved the plan' : `sent the plan back${reason ? `: ${reason}` : ''}`,
  };
}

const HASH = /^[0-9a-f]{64}$/;

function validReceipt(receipt: TaskReceipt): void {
  if (typeof receipt.actor !== 'string' || !receipt.actor.trim()
    || typeof receipt.plan_digest !== 'string' || !receipt.plan_digest.trim()
    || typeof receipt.artifact_digest !== 'string' || !HASH.test(receipt.artifact_digest)) {
    throw new Refusal('a receipt needs an actor, plan digest, and artifact digest');
  }
  if (!Number.isSafeInteger(receipt.epoch) || receipt.epoch < 1
    || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1) {
    throw new Refusal('receipt epoch and sequence must be positive integers');
  }
  if (!Array.isArray(receipt.evidence_hashes) || receipt.evidence_hashes.length === 0
    || receipt.evidence_hashes.some((hash) => typeof hash !== 'string' || !HASH.test(hash))) {
    throw new Refusal('a receipt needs evidence hashes');
  }
  if (!receipt.counters || typeof receipt.counters !== 'object' || Array.isArray(receipt.counters)
    || Object.values(receipt.counters).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Refusal('receipt counters must be non-negative integers');
  }
  if (!receipt.external_ids || typeof receipt.external_ids !== 'object' || Array.isArray(receipt.external_ids)
    || Object.values(receipt.external_ids).some((value) => typeof value !== 'string' || !value)) {
    throw new Refusal('receipt external IDs must be non-empty strings');
  }
  if (receipt.state !== undefined && !['running', 'reconciling', 'blocked', 'failed'].includes(receipt.state)) {
    throw new Refusal(`unknown receipt state: ${receipt.state}`);
  }
  if (receipt.blocker_kind !== undefined && !['execution', 'child', 'evidence'].includes(receipt.blocker_kind)) {
    throw new Refusal(`unknown blocker kind: ${receipt.blocker_kind}`);
  }
  if (receipt.state === 'blocked' && (!receipt.blocker_kind || !receipt.unblock_condition?.trim())) {
    throw new Refusal('a blocked receipt needs a blocker kind and unblock condition');
  }
}

function assertReceiptTransition(task: HubTask, receipt: TaskReceipt, recovery: boolean): void {
  if (recovery) return;
  if (receipt.state === 'blocked') {
    const expected = receipt.blocker_kind === 'execution' ? 'running' : 'reconciling';
    if (task.state !== expected) {
      throw new Refusal(`${task.id} cannot enter a ${receipt.blocker_kind} blocker from ${task.state}`);
    }
  }
  if (task.state === 'blocked' && (receipt.state === 'running' || receipt.state === 'reconciling')
    && task.resume_state !== receipt.state) {
    throw new Refusal(`${task.id} cannot resume ${receipt.state} from this blocker`);
  }
}

function assertTaskProject(task: HubTask, project?: string): void {
  if (project !== undefined && task.project !== project) throw new Refusal(`unknown task: ${task.id}`);
}

function assertCurrentBinding(task: HubTask, binding: { actor: string; plan_digest: string; epoch: number }): void {
  if (task.lease_revoked) throw new Refusal(`${task.id} lease is revoked`);
  if (CLOSED_STATES.has(task.state)) throw new Refusal(`${task.id} is already ${task.state}`);
  if (binding.plan_digest !== task.plan_digest || binding.epoch !== task.lease_epoch) {
    throw new Refusal(`${task.id} receipt has a stale plan digest or epoch`);
  }
  if (task.receipt_actor && canonicalActor(binding.actor) !== canonicalActor(task.receipt_actor)) {
    throw new Refusal(`${task.id} receipt actor is stale`);
  }
}

function canonicalActor(actor: string): string {
  return actor.startsWith('agent:') ? actor.slice('agent:'.length) : actor;
}

function allowsLeaseLessFallback(task: HubTask, actor: string): boolean {
  const canonical = canonicalActor(actor);
  if ((task.admissions ?? []).some((admission) => admission.agent === canonical)) return false;
  if (actor.startsWith('agent:')) return !task.contract;
  if (!task.contract) return true;
  return ['legacy', 'orchestrator', `${task.project}-orchestrator`].includes(canonical)
    || canonical.startsWith('user:');
}

async function assertWorkerBinding(
  root: string, task: HubTask, binding: { actor: string; lease_id?: string },
): Promise<void> {
  const active = (task.admissions ?? []).filter((admission) => !admission.lease_revoked
    && (admission.status === 'admitted' || admission.status === 'running'));
  const actor = canonicalActor(binding.actor);
  const actorAdmission = active.find((admission) => actor === admission.agent);
  if (!binding.lease_id) {
    if (!allowsLeaseLessFallback(task, binding.actor)) {
      throw new Refusal(`${task.id} worker evidence needs a lease ID`);
    }
    return;
  }
  const admission = active.find((candidate) => candidate.lease_id === binding.lease_id);
  if (!admission || admission !== actorAdmission) throw new Refusal(`${task.id} worker lease or actor is stale`);
  const project = (await readProjects(root)).projects.find((candidate) => candidate.name === task.project);
  if (!project) throw new Refusal(`unknown project: ${task.project}`);
  await withTeamLock(project.home, async () => {
    await assertAdmissionCurrentLocked(root, project.home, task.id, admission.agent, admission.lease_id);
  });
}

function latestEvidence(events: TaskEvent[], id: string, hash: string): TaskEvidence | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.id === id && event.event === 'evidence' && event.evidence?.evidence_hash === hash) {
      return event.evidence;
    }
  }
  return undefined;
}

function matchingEvidence(
  events: TaskEvent[], id: string, receipt: TaskReceipt, task: HubTask, recovery: boolean,
): TaskEvidence[] | null {
  const matches: TaskEvidence[] = [];
  for (const hash of receipt.evidence_hashes) {
    const evidence = latestEvidence(events, id, hash);
    if (!evidence || evidence.artifact_digest !== receipt.artifact_digest
      || evidence.lease_id !== receipt.lease_id) return null;
    const digests = taskEvidenceDigests(evidence.artifact, evidence.content);
    if (evidence.artifact_digest !== digests.artifact_digest || evidence.evidence_hash !== digests.evidence_hash) {
      return null;
    }
    if (receipt.state === 'reconciling' && evidence.outcome !== 'passed') return null;
    if (recovery) {
      if (evidence.plan_digest !== receipt.plan_digest || evidence.epoch !== receipt.epoch) return null;
    } else if (evidence.plan_digest !== task.plan_digest || evidence.epoch !== task.lease_epoch
      || canonicalActor(evidence.actor) !== canonicalActor(receipt.actor)
      || canonicalActor(receipt.actor) !== canonicalActor(task.receipt_actor ?? '')) {
      return null;
    }
    matches.push(evidence);
  }
  return matches;
}

export type TaskEvidenceInput = Omit<TaskEvidence, 'artifact_digest' | 'evidence_hash'>;

export async function recordTaskEvidence(
  root: string, id: string, input: TaskEvidenceInput,
  options: { project?: string; revalidate?: TaskRevalidate } = {},
): Promise<TaskEvidence> {
  return withHubLock(root, async () => {
    await options.revalidate?.();
    if (typeof input.actor !== 'string' || !input.actor.trim()
      || typeof input.plan_digest !== 'string' || !input.plan_digest.trim()
      || !Number.isSafeInteger(input.epoch) || input.epoch < 1
      || !TASK_EVIDENCE_OUTCOMES.includes(input.outcome)
      || input.artifact === undefined || input.content === undefined) {
      throw new Refusal('evidence needs an actor, plan digest, epoch, outcome, artifact, and content');
    }
    const task = storedTask(await readTaskEvents(root), id);
    assertTaskProject(task, options.project);
    assertCurrentBinding(task, input);
    await assertWorkerBinding(root, task, input);
    const evidence: TaskEvidence = { ...input, ...taskEvidenceDigests(input.artifact, input.content) };
    await appendTaskEvent(root, { id, project: task.project, event: 'evidence', at: new Date().toISOString(), evidence });
    return evidence;
  });
}

export async function recordTaskReceipt(
  root: string, id: string, receipt: TaskReceipt,
  options: {
    project?: string;
    trustedReconciler?: boolean;
    revalidate?: TaskRevalidate;
    revalidateReconciler?: TaskRevalidate;
  } = {},
): Promise<void> {
  await withHubLock(root, async () => {
    await options.revalidate?.();
    validReceipt(receipt);
    const events = await readTaskEvents(root);
    const task = storedTask(events, id);
    assertTaskProject(task, options.project);
    const recovery = task.lease_revoked === true && options.trustedReconciler === true
      && (receipt.state === 'blocked' || receipt.state === 'failed');
    if (task.lease_revoked && !recovery) throw new Refusal(`${id} lease is revoked`);
    if (recovery) {
      if (!options.revalidateReconciler) throw new Refusal('trusted reconciliation needs an admin grant');
      await options.revalidateReconciler();
    } else {
      assertCurrentBinding(task, receipt);
      await assertWorkerBinding(root, task, receipt);
    }
    if (receipt.sequence !== (task.last_receipt_sequence ?? 0) + 1) {
      throw new Refusal(`${id} receipt sequence is duplicate or regressive`);
    }
    if (!matchingEvidence(events, id, receipt, task, recovery)) {
      throw new Refusal(`${id} receipt evidence is not bound to the current plan, epoch, actor, and artifact`);
    }
    assertReceiptTransition(task, receipt, recovery);
    await appendTaskEvent(root, {
      id, project: task.project, event: 'receipt', at: new Date().toISOString(), receipt,
    });
  });
}

export type TaskReceiptPredicateConfig = {
  plan_digest: string;
  artifact_digest: string;
  evidence_hashes?: string[];
  lease_id?: string;
};
export type GitDiffScopePredicateConfig = {
  lease_id: string;
  base_revision: string;
  artifact_revision: string;
};
export type TaskPredicateConfig = TaskReceiptPredicateConfig | GitDiffScopePredicateConfig;

function currentReceiptLease(task: HubTask, receipt: TaskReceipt, config: TaskReceiptPredicateConfig): boolean {
  if (!receipt.lease_id) return !config.lease_id && allowsLeaseLessFallback(task, receipt.actor);
  return config.lease_id === receipt.lease_id && (task.admissions ?? []).some((admission) =>
    admission.lease_id === receipt.lease_id && !admission.lease_revoked
    && (admission.status === 'admitted' || admission.status === 'running'));
}

export const TASK_PREDICATES = {
  task_receipt(events: TaskEvent[], id: string, config: TaskReceiptPredicateConfig): boolean {
    const task = foldTasks(events).find((candidate) => candidate.id === id);
    const receipt = task?.last_receipt;
    if (!task || task.lease_revoked || task.state !== 'reconciling' || receipt?.state !== 'reconciling'
      || receipt.plan_digest !== config.plan_digest || receipt.plan_digest !== task.plan_digest
      || receipt.epoch !== task.lease_epoch || receipt.actor !== task.receipt_actor
      || receipt.artifact_digest !== config.artifact_digest || !currentReceiptLease(task, receipt, config)) {
      return false;
    }
    if (!matchingEvidence(events, id, receipt, task, false)) return false;
    return (config.evidence_hashes ?? []).every((hash) => receipt.evidence_hashes.includes(hash));
  },
};

async function evaluateGitDiffScope(root: string, id: string, config: GitDiffScopePredicateConfig): Promise<boolean> {
  return withHubLock(root, async () => {
    const task = storedTask(await readTaskEvents(root), id);
    const admission = task.admissions?.find((candidate) => candidate.lease_id === config.lease_id);
    if (!admission || !task.contract?.acceptance.some((acceptance) => acceptance.predicate_id === 'git_diff_scope'
      && admission.acceptance_ids.includes(acceptance.id))) {
      throw new Refusal(`${id} has no registered git_diff_scope allocation for this lease`);
    }
    if (config.base_revision !== admission.provenance.base_revision
      || config.artifact_revision !== admission.provenance.artifact_revision) {
      throw new Refusal('git_diff_scope revisions do not match the admitted provenance');
    }
    const project = (await readProjects(root)).projects.find((candidate) => candidate.name === task.project);
    if (!project) throw new Refusal(`unknown project: ${task.project}`);
    return withTeamLock(project.home, async () => {
      const { entry } = await assertAdmissionCurrentLocked(root, project.home, id, admission.agent, admission.lease_id);
      const result = await gitDiffScope({
        repository: entry.worktree || project.home,
        base_revision: config.base_revision,
        artifact_revision: config.artifact_revision,
        write_scope: admission.write_scope,
        runtime: {
          files: admission.runtime_files,
          team_state_hash: admission.team_state_hash,
          handoff_path: admission.handoff_path,
          handoff_digest: admission.handoff_digest,
          launch_claim_path: admission.launch_claim_path,
          launch_claim_digest: admission.launch_claim_digest,
          launch_claim_completed: admission.launch_claim_completed,
          output_claim: admission.output_claim,
        },
      }).catch(async (error: unknown) => {
        await transitionTmuxAdmissionLocked(root, project.home, admission, 'released', 'git_diff_scope adapter error');
        throw error;
      });
      const digests = taskEvidenceDigests(result.changes, result);
      await appendTaskEvent(root, {
        id, project: task.project, event: 'evidence', at: new Date().toISOString(),
        evidence: {
          actor: `agent:${admission.agent}`, plan_digest: admission.plan_digest, epoch: admission.root_lease_epoch,
          outcome: result.passed ? 'passed' : 'failed', lease_id: admission.lease_id,
          artifact: result.changes, content: result, ...digests,
        },
      });
      if (!result.passed) {
        await transitionTmuxAdmissionLocked(root, project.home, admission, 'released', 'out-of-scope Git changes');
      }
      return result.passed;
    });
  });
}

export async function evaluateTaskPredicate(
  root: string, id: string, predicate: keyof typeof TASK_PREDICATES | 'git_diff_scope', config: TaskPredicateConfig,
): Promise<boolean> {
  if (predicate === 'git_diff_scope') return evaluateGitDiffScope(root, id, config as GitDiffScopePredicateConfig);
  const evaluate = TASK_PREDICATES[predicate];
  if (!evaluate) throw new Refusal(`unknown task predicate: ${predicate}`);
  return evaluate(await readTaskEvents(root), id, config as TaskReceiptPredicateConfig);
}

// A pending-pane record older than this is a crashed start, not a live one.
const PENDING_STALE_MS = 10 * 60_000;

// True means a live, young start is still in flight: route through continue.
// A dead or stale record is a crashed start: clear it and let the caller relaunch.
export async function settlePendingPane(root: string, project: string): Promise<boolean> {
  const existing = await readPendingPane(root, project);
  if (!existing) return false;
  const live = await paneExists(existing.pane);
  if (live && Date.now() - Date.parse(existing.at) <= PENDING_STALE_MS) return true;
  await clearPendingPane(root, project);
  return false;
}

// The cli's log/progress/accept handler; argument counts are checked by the caller.
export async function ledgerCommand(root: string, sub: string, args: string[]): Promise<string> {
  if (sub === 'log') {
    const checkpointIndex = args.indexOf('--checkpoints');
    const contractIndex = args.indexOf('--contract');
    const flagIndexes = [checkpointIndex, contractIndex].filter((index) => index >= 0);
    const pos = args.filter((_, index) => !flagIndexes.includes(index) && !flagIndexes.includes(index - 1));
    let checkpoints: Checkpoint[] | undefined;
    if (checkpointIndex !== -1) {
      const raw = args[checkpointIndex + 1];
      if (raw === undefined || raw.startsWith('--')) throw new Refusal('--checkpoints needs a value');
      try {
        checkpoints = JSON.parse(raw) as Checkpoint[];
      } catch {
        throw new Refusal('--checkpoints is a JSON array of {"id","desc","etaMin"}');
      }
    }
    let contract: RootContract | undefined;
    if (contractIndex !== -1) {
      const raw = args[contractIndex + 1];
      if (raw === undefined || raw.startsWith('--')) throw new Refusal('--contract needs a value');
      try {
        contract = JSON.parse(raw) as RootContract;
      } catch {
        throw new Refusal('--contract is a JSON root contract');
      }
    }
    await hubLog(root, pos[0], pos[1], pos.length > 2 ? pos.slice(2).join(' ') : undefined, checkpoints, undefined, contract);
    return '';
  }
  const [task, checkpoint, status, ...note] = args;
  if (sub === 'accept') {
    await hubAccept(root, task, checkpoint);
    return `hive: ${task} ${checkpoint} accepted`;
  }
  await hubProgress(root, task, checkpoint, status, note.length ? note.join(' ') : undefined);
  return `hive: ${task} ${checkpoint} ${status}`;
}
