import { paneExists } from './tmux.js';
import type {
  Checkpoint, HubTask, NativeBranchClient, RootContract,
  TaskAcceptance, TaskEvidence, TaskEvent, TaskOperation, TaskOutcome, TaskOutcomeInput, TaskReceipt,
} from './types.js';
import { CLOSED_STATES, PROGRESS_STATUSES, TASK_EVIDENCE_OUTCOMES, TASK_EVENTS } from './types.js';
import {
  Refusal, appendDecision, appendTaskEvent, assertTaskBudgetCurrent, canonicalJson, childReconciled, clearPendingPane,
  contractDigest, doneBlockers, foldTasks, planDigest, readPendingPane, readProjects, readTaskEvents, readTeam,
  taskBudgetExpired, taskEvidenceDigests, validCheckpoints, validateRootContract, withHubLock, withTeamLock,
} from './state.js';
import { containsInternalContent } from './decisions.js';
import { assertAdmissionCurrentLocked, revokeTaskAdmissionsLocked } from './admission.js';
import { evidenceAcceptanceBound } from './acceptance.js';
import {
  allowsLeaseLessFallback, canonicalActor, evaluateAcceptanceLocked, evaluateRegisteredAcceptanceLocked, matchingEvidence,
} from './evidence.js';
import { verifiedPendingPaneIdentity } from './spawn.js';
export { evaluateTaskPredicate, TASK_PREDICATES } from './evidence.js';

export type TaskRevalidate = () => Promise<void>;

function storedTask(events: TaskEvent[], id: string): HubTask {
  const task = foldTasks(events).find((candidate) => candidate.id === id);
  if (!task) throw new Refusal(`unknown task: ${id}`);
  return task;
}

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
    if (OUTCOMES.has(event as TaskOutcome)) {
      await recordOutcomeLocked(root, events, task, event as TaskOutcome, {
        actor: 'legacy', plan_digest: task.plan_digest ?? '', epoch: task.lease_epoch ?? 0, reason: note,
      });
      return;
    }
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
    assertTaskBudgetCurrent(task);
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
    const live = liveOperation(currentOperations(task));
    if (live?.kind === 'github_check' && action === 'cancel') {
      await appendTaskEvent(root, {
        id, project, event: 'operation', at: new Date().toISOString(),
        operation: {
          ...live, status: 'closing_external', close_outcome: 'cancelled', cancellation_requested: false,
          updated_at: new Date().toISOString(),
        },
      });
      return;
    }
    if (live) throw new Refusal(`${id} ${action} is ambiguous while an external operation is unresolved`);
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
  const hasOutput = typeof receipt.output_claim === 'string' && receipt.output_claim.trim().length > 0
    && typeof receipt.artifact_path === 'string' && receipt.artifact_path.trim().length > 0;
  const declaredOutput = receipt.state === 'reconciling' && hasOutput
    && Array.isArray(receipt.evidence_hashes) && receipt.evidence_hashes.length === 0;
  if (!Array.isArray(receipt.evidence_hashes) || !declaredOutput && receipt.evidence_hashes.length === 0
    || receipt.evidence_hashes.some((hash) => typeof hash !== 'string' || !HASH.test(hash))
    || (receipt.output_claim !== undefined || receipt.artifact_path !== undefined) && !hasOutput) {
    throw new Refusal('a receipt needs evidence hashes or a declared output artifact');
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
  if (receipt.state === 'blocked') {
    const condition = receipt.resume_condition;
    const validCondition = receipt.blocker_kind === 'child'
      ? condition?.type === 'child' && typeof condition.child_id === 'string' && condition.child_id.trim().length > 0
      : condition?.type === 'predicate' && typeof condition.acceptance_id === 'string'
        && condition.acceptance_id.trim().length > 0;
    if (!receipt.blocker_kind || !validCondition) {
      throw new Refusal('a blocked receipt needs a blocker kind and registered resume condition');
    }
  }
}

function declaredOutput(task: HubTask, receipt: TaskReceipt): boolean {
  return task.state !== 'blocked' && receipt.state === 'reconciling'
    && Boolean(receipt.output_claim && receipt.artifact_path) && receipt.evidence_hashes.length === 0;
}

function assertDeclaredOutputBinding(task: HubTask, receipt: TaskReceipt): void {
  const acceptance = task.contract?.acceptance.find((candidate) => candidate.predicate_id === 'task_receipt'
    && candidate.version === 1 && candidate.configuration.output_claim === receipt.output_claim
    && candidate.configuration.artifact_path === receipt.artifact_path
    && candidate.configuration.artifact_digest === receipt.artifact_digest);
  const admission = (task.admissions ?? []).find((candidate) => candidate.lease_id === receipt.lease_id
    && candidate.output_claim === receipt.output_claim && acceptance
    && candidate.acceptance_ids.includes(acceptance.id));
  if (!acceptance || !admission || receipt.evidence_hashes.length > 0) {
    throw new Refusal(`${task.id} declared output is not bound to an admitted acceptance artifact`);
  }
}

type ResumeEvaluation = {
  evidenceHashes: string[];
  after?: string | number;
  adapterId: NonNullable<TaskEvidence['verification']>['adapter_id'] | 'any';
  acceptance?: TaskAcceptance;
};

async function evaluateResumeConditionLocked(
  root: string, events: TaskEvent[], task: HubTask, native?: NativeBranchClient,
): Promise<ResumeEvaluation | null> {
  const condition = task.resume_condition;
  const blocked = task.last_receipt;
  if (!condition || !blocked || !task.contract || contractDigest(task.contract) !== task.plan_digest) return null;
  if (condition.type === 'child') {
    const reconciled = blocked.blocker_kind === 'child'
      && task.contract.required_children?.includes(condition.child_id) === true
      && childReconciled(events, condition.child_id, task.project);
    return reconciled ? { evidenceHashes: blocked.evidence_hashes, adapterId: 'any' } : null;
  }
  if (blocked.blocker_kind !== 'execution' && blocked.blocker_kind !== 'evidence') return null;
  const acceptance = task.contract.acceptance.find((candidate) => candidate.id === condition.acceptance_id);
  if (!acceptance || !await evaluateRegisteredAcceptanceLocked(root, task, acceptance, native, true)) return null;
  const requiredHashes = acceptance.required_evidence.filter((item) => /^[0-9a-f]{64}$/.test(item));
  const configuredArtifact = acceptance.configuration.artifact_digest;
  const qualifying = (await readTaskEvents(root)).filter((event, index) => {
    const evidence = event.evidence;
    return index > events.length - 1 && event.id === task.id && event.event === 'evidence'
      && evidence?.outcome === 'passed' && evidence.plan_digest === task.plan_digest && evidence.epoch === task.lease_epoch
      && (acceptance.predicate_id !== 'task_receipt' || evidence.lease_id === blocked.lease_id)
      && evidenceAcceptanceBound(task, acceptance, evidence)
      && (typeof configuredArtifact !== 'string' || evidence.artifact_digest === configuredArtifact);
  });
  if (qualifying.length === 0) return null;
  const hashes = qualifying.map((event) => event.evidence!.evidence_hash);
  if (!requiredHashes.every((hash) => hashes.includes(hash))) return null;
  return {
    evidenceHashes: hashes, after: events.length - 1,
    adapterId: acceptance.predicate_id as ResumeEvaluation['adapterId'], acceptance,
  };
}

async function assertReceiptTransition(
  root: string, events: TaskEvent[], task: HubTask, receipt: TaskReceipt, recovery: boolean, native?: NativeBranchClient,
): Promise<ResumeEvaluation | undefined> {
  if (recovery) return undefined;
  if (receipt.state === 'blocked') {
    const expected = receipt.blocker_kind === 'execution' ? 'running' : 'reconciling';
    if (task.state !== expected) {
      throw new Refusal(`${task.id} cannot enter a ${receipt.blocker_kind} blocker from ${task.state}`);
    }
  }
  if (task.state === 'blocked' && (receipt.state === 'running' || receipt.state === 'reconciling')) {
    if (task.resume_state !== receipt.state) {
      throw new Refusal(`${task.id} cannot resume ${receipt.state} from this blocker`);
    }
    const evaluation = await evaluateResumeConditionLocked(root, events, task, native);
    if (!evaluation) throw new Refusal(`${task.id} registered resume condition does not pass`);
    return evaluation;
  }
  return undefined;
}

function assertTaskProject(task: HubTask, project?: string): void {
  if (project !== undefined && task.project !== project) throw new Refusal(`unknown task: ${task.id}`);
}

function assertCurrentBinding(task: HubTask, binding: { actor: string; plan_digest: string; epoch: number }): void {
  assertTaskBudgetCurrent(task);
  if (task.lease_revoked) throw new Refusal(`${task.id} lease is revoked`);
  if (CLOSED_STATES.has(task.state)) throw new Refusal(`${task.id} is already ${task.state}`);
  if (binding.plan_digest !== task.plan_digest || binding.epoch !== task.lease_epoch) {
    throw new Refusal(`${task.id} receipt has a stale plan digest or epoch`);
  }
  if (task.receipt_actor && canonicalActor(binding.actor) !== canonicalActor(task.receipt_actor)) {
    throw new Refusal(`${task.id} receipt actor is stale`);
  }
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

export type TaskEvidenceInput = Omit<TaskEvidence, 'artifact_digest' | 'evidence_hash' | 'verification'>;

function sensitiveEvidence(value: unknown): boolean {
  if (typeof value === 'string') return containsInternalContent(value);
  if (Array.isArray(value)) return value.some(sensitiveEvidence);
  if (value && typeof value === 'object') return Object.values(value).some(sensitiveEvidence);
  return false;
}

type TaskEvidenceOptions = { project?: string; revalidate?: TaskRevalidate };

export async function recordTaskEvidence(
  root: string, id: string, input: TaskEvidenceInput, options: TaskEvidenceOptions = {},
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
    const serialized = canonicalJson({ artifact: input.artifact, content: input.content });
    if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024
      || sensitiveEvidence({ artifact: input.artifact, content: input.content })) {
      throw new Refusal('evidence content exceeds the byte cap or contains sensitive instructions');
    }
    const task = storedTask(await readTaskEvents(root), id);
    assertTaskProject(task, options.project);
    assertCurrentBinding(task, input);
    await assertWorkerBinding(root, task, input);
    const evidence: TaskEvidence = { ...input, ...taskEvidenceDigests(input.artifact, input.content), verification: undefined };
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
    native?: NativeBranchClient;
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
    const evaluation = await assertReceiptTransition(root, events, task, receipt, recovery, options.native);
    if (declaredOutput(task, receipt)) assertDeclaredOutputBinding(task, receipt);
    else if (!matchingEvidence(
      evaluation ? await readTaskEvents(root) : events,
      id, receipt, task, recovery, false, evaluation?.after, evaluation?.adapterId, evaluation?.acceptance,
    )) {
      throw new Refusal(`${id} receipt evidence is not bound to the current plan, epoch, actor, and artifact`);
    }
    await appendTaskEvent(root, {
      id, project: task.project, event: 'receipt', at: new Date().toISOString(), receipt,
    });
  });
}

export async function reconcileBlockedTasks(root: string, native?: NativeBranchClient): Promise<void> {
  const candidates = foldTasks(await readTaskEvents(root)).filter((task) => task.state === 'blocked'
    && (task.resume_state === 'running' || task.resume_state === 'reconciling') && task.resume_condition);
  for (const candidate of candidates) {
    await withHubLock(root, async () => {
      const events = await readTaskEvents(root);
      const task = storedTask(events, candidate.id);
      if (taskBudgetExpired(task)) return;
      if (task.state !== 'blocked') return;
      const evaluation = await evaluateResumeConditionLocked(root, events, task, native);
      const previous = task.last_receipt;
      if (!evaluation || !previous || !task.resume_state) return;
      const receipt: TaskReceipt = {
        ...previous, sequence: (task.last_receipt_sequence ?? 0) + 1, state: task.resume_state,
        evidence_hashes: evaluation.evidenceHashes,
        blocker_kind: undefined, unblock_condition: undefined, resume_condition: undefined,
      };
      if (!matchingEvidence(
        await readTaskEvents(root), task.id, receipt, task, false, false, evaluation.after, evaluation.adapterId,
        evaluation.acceptance,
      )) return;
      assertCurrentBinding(task, receipt);
      await assertWorkerBinding(root, task, receipt);
      await appendTaskEvent(root, {
        id: task.id, project: task.project, event: 'receipt', at: new Date().toISOString(), receipt,
      });
    });
  }
}

const SUCCESS_OUTCOMES = new Set<TaskOutcome>(['done', 'already_fixed', 'duplicate', 'no_op']);
const OUTCOMES = new Set<TaskOutcome>([...SUCCESS_OUTCOMES, 'failed', 'unknown', 'superseded']);

function operationIdentity(operation: TaskOperation): string {
  return canonicalJson({
    operation_id: operation.operation_id, idempotency_key: operation.idempotency_key, kind: operation.kind,
    actor: operation.actor, plan_digest: operation.plan_digest, epoch: operation.epoch, lease_id: operation.lease_id,
    repository_fingerprint: operation.repository_fingerprint, commit: operation.commit, branch: operation.branch,
  });
}

function currentOperations(task: HubTask): TaskOperation[] {
  const latest = new Map<string, TaskOperation>();
  const poisoned = new Set<string>();
  for (const operation of task.operations ?? []) {
    if (operation.plan_digest !== task.plan_digest || operation.epoch !== task.lease_epoch) continue;
    const previous = latest.get(operation.operation_id);
    if (previous && operationIdentity(previous) !== operationIdentity(operation)) {
      poisoned.add(operation.operation_id);
    }
    latest.set(operation.operation_id, poisoned.has(operation.operation_id)
      ? { ...operation, status: 'ambiguous', detail: 'operation identity changed' }
      : operation);
  }
  return [...latest.values()];
}

function liveOperation(operations: TaskOperation[]): TaskOperation | undefined {
  return operations.find((operation) => ['pending', 'ambiguous', 'blocked_external', 'closing_external'].includes(operation.status));
}

function assertOperations(task: HubTask, outcome: TaskOutcome): void {
  const operations = currentOperations(task);
  const live = liveOperation(operations);
  if (live) throw new Refusal(`${task.id} has a live external operation ${live.operation_id}`);
  if (!SUCCESS_OUTCOMES.has(outcome)) return;
  const invalidSuccess = operations.find((operation) => operation.result?.remote_tip !== operation.commit);
  if (invalidSuccess) throw new Refusal(`${task.id} external operation ${invalidSuccess.operation_id} lacks a verified remote tip`);
  const unsuccessful = operations.find((operation) => operation.status !== 'succeeded');
  if (unsuccessful) throw new Refusal(`${task.id} external operation ${unsuccessful.operation_id} did not succeed`);
}

async function remainingWriters(root: string, task: HubTask): Promise<string[]> {
  const active = (task.admissions ?? []).filter((admission) => !admission.lease_revoked
    && (admission.status === 'admitted' || admission.status === 'running'));
  const writers = active.map((admission) => admission.agent);
  const project = (await readProjects(root)).projects.find((candidate) => candidate.name === task.project);
  if (!project) return writers;
  return withTeamLock(project.home, async () => {
    const team = await readTeam(project.home);
    for (const entry of team.agents) {
      if (entry.task !== task.id || entry.orchestrator || entry.closed_at) continue;
      if (!entry.lease_id || active.some((admission) => admission.lease_id === entry.lease_id)) {
        if (!writers.includes(entry.name)) writers.push(entry.name);
      }
    }
    return writers;
  });
}

function assertChildren(events: TaskEvent[], task: HubTask): void {
  for (const child of task.contract?.required_children ?? []) {
    if (!childReconciled(events, child, task.project)) {
      throw new Refusal(`${task.id} required child ${child} is not reconciled in project ${task.project}`);
    }
  }
}

function assertDuplicate(events: TaskEvent[], task: HubTask, input: TaskOutcomeInput): void {
  const covering = foldTasks(events).find((candidate) => candidate.id === input.covering_record
    && candidate.project === task.project && candidate.id !== task.id);
  if (!input.covering_record?.trim() || !covering || !childReconciled(events, covering.id, task.project)) {
    throw new Refusal(`${task.id} duplicate needs a reconciled covering record in project ${task.project}`);
  }
}

async function assertAcceptance(
  root: string, task: HubTask, outcome: TaskOutcome, input: TaskOutcomeInput, native?: NativeBranchClient,
): Promise<void> {
  const acceptance = await evaluateAcceptanceLocked(root, task, native);
  const unsupported = acceptance.blockers.filter((blocker) => blocker.startsWith('blocked:unsupported_predicate'));
  if (unsupported.length) {
    await appendTaskEvent(root, {
      id: task.id, project: task.project, event: 'blocked', at: new Date().toISOString(), note: unsupported.join('; '),
    });
    throw new Refusal(unsupported.join('; '));
  }
  if (acceptance.blockers.length && !(outcome === 'no_op' && input.acceptance_inapplicable)) {
    throw new Refusal(`${task.id} registered acceptance failed: ${acceptance.blockers.join('; ')}`);
  }
}

async function assertOutcomeGuards(
  root: string, events: TaskEvent[], task: HubTask, outcome: TaskOutcome, input: TaskOutcomeInput, native?: NativeBranchClient,
) {
  if (!task.plan_approved) throw new Refusal(`${task.id} has no approved plan`);
  if (outcome === 'done') {
    const checkpoints = doneBlockers(task);
    if (checkpoints.length) throw new Refusal(`${task.id} is not done: ${checkpoints.join('; ')}`);
  }
  if (outcome === 'duplicate') assertDuplicate(events, task, input);
  const provenance = task.contract?.provenance;
  if ((outcome === 'already_fixed' || outcome === 'no_op')
    && (!provenance || provenance.kind === 'research' || provenance.base_revision !== provenance.artifact_revision)) {
    throw new Refusal(`${task.id} ${outcome} needs current-base provenance`);
  }
  if (outcome === 'superseded') {
    const replacement = foldTasks(events).find((candidate) => candidate.id === input.replacement_id
      && candidate.project === task.project && candidate.id !== task.id);
    if (!replacement) throw new Refusal(`${task.id} superseded needs a distinct existing replacement in project ${task.project}`);
  }
  assertOperations(task, outcome);
  if ((outcome === 'failed' || outcome === 'unknown') && !input.reason?.trim()) {
    throw new Refusal(`${task.id} ${outcome} needs a reason`);
  }
  const writers = await remainingWriters(root, task);
  if (writers.length) throw new Refusal(`${task.id} still has writers: ${writers.join(', ')}`);
  if (outcome === 'failed') {
    const acceptance = await evaluateAcceptanceLocked(root, task, native);
    if (acceptance.requiredBlockers.length === 0) {
      throw new Refusal(`${task.id} failed needs unsatisfied required acceptance`);
    }
    return;
  }
  if (!SUCCESS_OUTCOMES.has(outcome)) return;
  await assertAcceptance(root, task, outcome, input, native);
  assertChildren(events, task);
}

function assertOutcomeBinding(task: HubTask, input: TaskOutcomeInput): void {
  assertTaskBudgetCurrent(task);
  if (task.lease_revoked || CLOSED_STATES.has(task.state)) throw new Refusal(`${task.id} is already ${task.state}`);
  if (!input.actor.trim() || input.plan_digest !== task.plan_digest || input.epoch !== task.lease_epoch) {
    throw new Refusal(`${task.id} outcome has a stale actor, plan digest, or epoch`);
  }
}

async function recordOutcomeLocked(
  root: string, events: TaskEvent[], task: HubTask, outcome: TaskOutcome, input: TaskOutcomeInput, native?: NativeBranchClient,
): Promise<void> {
  assertOutcomeBinding(task, input);
  await assertWorkerBinding(root, task, input);
  const live = liveOperation(currentOperations(task));
  if (outcome === 'superseded' && live?.kind === 'github_check') {
    const replacement = foldTasks(events).find((candidate) => candidate.id === input.replacement_id
      && candidate.project === task.project && candidate.id !== task.id);
    if (!replacement) throw new Refusal(`${task.id} superseded needs a distinct existing replacement in project ${task.project}`);
    await appendTaskEvent(root, {
      id: task.id, project: task.project, event: 'operation', at: new Date().toISOString(),
      operation: {
        ...live, status: 'closing_external', close_outcome: 'superseded', replacement_id: replacement.id,
        cancellation_requested: false, updated_at: new Date().toISOString(),
      },
    });
    return;
  }
  await assertOutcomeGuards(root, events, task, outcome, input, native);
  await appendTaskEvent(root, {
    id: task.id, project: task.project, event: outcome, at: new Date().toISOString(), note: input.reason, outcome: input,
  });
}

export async function recordTaskOutcome(
  root: string, id: string, outcome: TaskOutcome, input: TaskOutcomeInput,
  options: { project?: string; revalidate?: TaskRevalidate; native?: NativeBranchClient } = {},
): Promise<TaskOutcomeInput> {
  if (!OUTCOMES.has(outcome)) throw new Refusal(`unknown task outcome: ${outcome}`);
  return withHubLock(root, async () => {
    await options.revalidate?.();
    const events = await readTaskEvents(root);
    const task = storedTask(events, id);
    assertTaskProject(task, options.project);
    await recordOutcomeLocked(root, events, task, outcome, input, options.native);
    return input;
  });
}

export async function recordHumanAcceptance(
  root: string, id: string, input: TaskOutcomeInput & { acceptance_id: string },
  options: { project?: string; revalidate?: TaskRevalidate } = {},
): Promise<void> {
  await withHubLock(root, async () => {
    await options.revalidate?.();
    const task = storedTask(await readTaskEvents(root), id);
    assertTaskProject(task, options.project);
    assertOutcomeBinding(task, input);
    const humanActor = input.actor.startsWith('user:') || input.actor === 'legacy';
    if (!humanActor || !task.contract?.acceptance.some((item) => item.id === input.acceptance_id)) {
      throw new Refusal('human acceptance needs a human actor and a contract acceptance ID');
    }
    await appendTaskEvent(root, {
      id, project: task.project, event: 'human_acceptance', at: new Date().toISOString(),
      human_acceptance: {
        actor: input.actor, acceptance_id: input.acceptance_id, plan_digest: input.plan_digest,
        epoch: input.epoch, at: new Date().toISOString(),
      },
    });
  });
}

const PENDING_STALE_MS = 10 * 60_000;

export async function settlePendingPane(root: string, project: string): Promise<boolean> {
  const existing = await readPendingPane(root, project);
  if (!existing) return false;
  const live = await paneExists(existing.pane);
  if (live) await verifiedPendingPaneIdentity(existing);
  if (live && Date.now() - Date.parse(existing.at) <= PENDING_STALE_MS) return true;
  await clearPendingPane(root, project);
  return false;
}

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
