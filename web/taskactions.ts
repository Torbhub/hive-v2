import { Refusal, hubProgress, hubResolve, recordTaskReceipt } from '../src/hub.js';
import type { TaskRevalidate } from '../src/taskgate.js';
import type { Principal } from '../src/security.js';
import type { TaskReceipt } from '../src/types.js';

// Same cap as a task brief.
const RESOLVE_NOTE_CAP = 4000;

// Owner verdicts on a waiting task: cancel it, or send it back to asked with a
// new brief. Ledger appends only, so a dead pane never blocks the call.
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
  // Same parity as an owner message: the fold took \t \n \r, so a control
  // byte left over is hostile or broken input.
  if (/[\x00-\x1f\x7f]/.test(brief)) {
    throw new Refusal('the note holds control characters; they are not typeable');
  }
  await hubResolve(root, project, taskId, action, brief, revalidate);
  return { ok: true };
}

// Thin pass-through to the hub progress function; workers mostly use the CLI.
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
    ...(body.state === undefined ? {} : { state: body.state }),
    ...(body.blocker_kind === undefined ? {} : { blocker_kind: body.blocker_kind }),
    ...(body.unblock_condition === undefined ? {} : { unblock_condition: String(body.unblock_condition) }),
  } as TaskReceipt;
  await recordTaskReceipt(root, String(body.task ?? ''), receipt, {
    project, trustedReconciler: principal.kind === 'human', revalidate, revalidateReconciler,
  });
  return { ok: true };
}

// null means the path is not a task action and the caller keeps dispatching.
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
  if (pathname === '/api/progress') return recordProgress(root, project, body, revalidate);
  if (pathname === '/api/task-receipt') {
    return taskReceipt(root, project, body, principal, revalidate, revalidateReconciler);
  }
  return null;
}
