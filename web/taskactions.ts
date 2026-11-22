import {
  Refusal, hubLog, hubProgress, hubResolve, recordHumanAcceptance, recordTaskEvidence, recordTaskOutcome, recordTaskReceipt,
} from '../src/hub.js';
import type { TaskRevalidate } from '../src/taskgate.js';
import type { Principal } from '../src/security.js';
import type { Checkpoint, RootContract, TaskEvidenceOutcome, TaskOutcome, TaskReceipt } from '../src/types.js';

const RESOLVE_NOTE_CAP = 4000;

async function taskResolve(
  root: string,
  project: string,
  body: Record<string, unknown>,
  revalidate?: TaskRevalidate,
): Promise<{ ok: true }> {
  const taskId = String(body.task ?? '');
  const action = String(body.action ?? '');
  const note = body.note === undefined ? undefined : String(body.note);
  if (action !== 'cancel' && action !== 'rebrief') {
    throw new Refusal(`a resolve action is cancel|rebrief: ${action}`);
  }
  const brief = note?.replace(/\s+/g, ' ').trim() ?? '';
  if (action === 'rebrief' && !brief) throw new Refusal('a rebrief needs a note: the new brief');
  if (brief.length > RESOLVE_NOTE_CAP) {
    throw new Refusal(`the note is capped at ${RESOLVE_NOTE_CAP} characters`);
  }
  if (/[\x00-\x1f\x7f]/.test(brief)) {
    throw new Refusal('the note holds control characters; they are not typeable');
  }
  await hubResolve(root, project, taskId, action, brief, revalidate);
  return { ok: true };
}

async function taskPlan(
  root: string,
  project: string,
  body: Record<string, unknown>,
  revalidate?: TaskRevalidate,
): Promise<{ ok: true }> {
  const taskId = String(body.task ?? '').trim();
  if (!taskId) throw new Refusal('task is required');
  await hubLog(
    root, taskId, 'plan', body.note === undefined ? undefined : String(body.note),
    body.checkpoints as Checkpoint[], revalidate, body.contract as RootContract,
  );
  return { ok: true };
}

async function recordProgress(
  root: string,
  project: string,
  body: Record<string, unknown>,
  revalidate?: TaskRevalidate,
): Promise<{ ok: true }> {
  const taskId = String(body.task ?? '').trim();
  const checkpoint = String(body.checkpoint ?? '').trim();
  if (!taskId || !checkpoint) throw new Refusal('task and checkpoint are required');
  await hubProgress(
    root, taskId, checkpoint, String(body.status ?? ''),
    body.note === undefined ? undefined : String(body.note), revalidate, project,
  );
  return { ok: true };
}

async function taskReceipt(
  root: string,
  project: string,
  body: Record<string, unknown>,
  principal: Principal,
  revalidate?: TaskRevalidate,
  revalidateReconciler?: TaskRevalidate,
): Promise<{ ok: true }> {
  const receipt = {
    actor: principal.subject,
    plan_digest: String(body.plan_digest ?? ''),
    epoch: Number(body.epoch),
    sequence: Number(body.sequence),
    artifact_digest: String(body.artifact_digest ?? ''),
    counters: body.counters,
    external_ids: body.external_ids,
    evidence_hashes: body.evidence_hashes,
    ...(body.lease_id === undefined ? {} : { lease_id: String(body.lease_id) }),
    ...(body.state === undefined ? {} : { state: body.state }),
    ...(body.blocker_kind === undefined ? {} : { blocker_kind: body.blocker_kind }),
    ...(body.unblock_condition === undefined ? {} : { unblock_condition: String(body.unblock_condition) }),
    ...(body.resume_condition === undefined ? {} : { resume_condition: body.resume_condition }),
    ...(body.output_claim === undefined ? {} : { output_claim: String(body.output_claim) }),
    ...(body.artifact_path === undefined ? {} : { artifact_path: String(body.artifact_path) }),
  } as TaskReceipt;
  await recordTaskReceipt(root, String(body.task ?? ''), receipt, {
    project, trustedReconciler: principal.kind === 'human', revalidate, revalidateReconciler,
  });
  return { ok: true };
}

function outcomeBinding(body: Record<string, unknown>, principal: Principal) {
  return {
    actor: principal.subject,
    plan_digest: String(body.plan_digest ?? ''),
    epoch: Number(body.epoch),
    ...(body.lease_id === undefined ? {} : { lease_id: String(body.lease_id) }),
  };
}

async function taskEvidence(root: string, project: string, body: Record<string, unknown>, principal: Principal, revalidate?: TaskRevalidate) {
  const evidence = await recordTaskEvidence(root, String(body.task ?? ''), {
    ...outcomeBinding(body, principal), outcome: String(body.outcome ?? '') as TaskEvidenceOutcome,
    artifact: body.artifact, content: body.content,
  }, { project, revalidate });
  return { ok: true, evidence };
}

async function taskOutcome(root: string, project: string, body: Record<string, unknown>, principal: Principal, revalidate?: TaskRevalidate) {
  const outcome = await recordTaskOutcome(root, String(body.task ?? ''), String(body.outcome ?? '') as TaskOutcome, {
    ...outcomeBinding(body, principal),
    ...(body.covering_record === undefined ? {} : { covering_record: String(body.covering_record) }),
    ...(body.replacement_id === undefined ? {} : { replacement_id: String(body.replacement_id) }),
    ...(body.reason === undefined ? {} : { reason: String(body.reason) }),
    ...(body.acceptance_inapplicable === undefined ? {} : { acceptance_inapplicable: body.acceptance_inapplicable === true }),
  }, { project, revalidate });
  return { ok: true, outcome };
}

async function taskAcceptance(root: string, project: string, body: Record<string, unknown>, principal: Principal, revalidate?: TaskRevalidate) {
  if (principal.kind !== 'human') throw new Refusal('human acceptance needs a human actor');
  await recordHumanAcceptance(root, String(body.task ?? ''), {
    ...outcomeBinding(body, principal), acceptance_id: String(body.acceptance_id ?? ''),
  }, { project, revalidate });
  return { ok: true };
}

export async function handleTaskAction(
  root: string,
  project: string,
  pathname: string,
  body: Record<string, unknown>,
  principal: Principal = { kind: 'human', subject: 'legacy', aclEpoch: 0 },
  revalidate?: TaskRevalidate,
  revalidateReconciler?: TaskRevalidate,
): Promise<unknown | null> {
  if (pathname === '/api/task-resolve') return taskResolve(root, project, body, revalidate);
  if (pathname === '/api/task-plan') return taskPlan(root, project, body, revalidate);
  if (pathname === '/api/progress') return recordProgress(root, project, body, revalidate);
  if (pathname === '/api/task-receipt') {
    return taskReceipt(root, project, body, principal, revalidate, revalidateReconciler);
  }
  if (pathname === '/api/task-evidence') return taskEvidence(root, project, body, principal, revalidate);
  if (pathname === '/api/task-outcome') return taskOutcome(root, project, body, principal, revalidate);
  if (pathname === '/api/task-acceptance') return taskAcceptance(root, project, body, principal, revalidate);
  return null;
}
