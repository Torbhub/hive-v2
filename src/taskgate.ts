import { paneExists } from './tmux.js';
import type { Checkpoint, HubTask, TaskEvent } from './types.js';
import { PROGRESS_STATUSES, TASK_EVENTS } from './types.js';
import {
  Refusal, appendDecision, appendTaskEvent, clearPendingPane, doneBlockers, foldTasks,
  readPendingPane, readTaskEvents, validCheckpoints,
} from './state.js';

// hubLog's teeth: owner verdicts enter through plan-answer and accept, plans
// carry checkpoints, handed needs an approved plan, done needs every
// checkpoint terminal.
export function assertLogAllowed(task: HubTask, event: string, checkpoints?: Checkpoint[]): void {
  if (event === 'answered' || event === 'planaccept') {
    throw new Refusal(`${event} is owner-only: use hive hub plan-answer or hive hub accept`);
  }
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

export async function hubLog(root: string, id: string, event: string, note?: string, checkpoints?: Checkpoint[]): Promise<void> {
  const events = await readTaskEvents(root);
  if (!events.some((e) => e.id === id)) throw new Error(`unknown task: ${id}`);
  if (!(TASK_EVENTS as readonly string[]).includes(event)) throw new Error(`unknown task event: ${event}`);
  assertLogAllowed(foldTasks(events).find((t) => t.id === id)!, event, checkpoints);
  const project = id.replace(/-\d+$/, '');
  await appendTaskEvent(root, {
    id, project, event: event as TaskEvent['event'], at: new Date().toISOString(), note,
    ...(event === 'plan' ? { checkpoints } : {}),
  });
  if (event === 'decided') {
    await appendDecision(root, { project, task: id, by: 'orchestrator', summary: note ?? '' });
  }
}

// One progress event per checkpoint call; the fold turns them into the trail.
export async function hubProgress(
  root: string, id: string, checkpoint: string, status: string, note?: string,
): Promise<void> {
  if (!(PROGRESS_STATUSES as readonly string[]).includes(status)) {
    throw new Refusal(`a progress status is started|ok|fail|skip: ${status}`);
  }
  const task = foldTasks(await readTaskEvents(root)).find((t) => t.id === id);
  if (!task) throw new Error(`unknown task: ${id}`);
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
}

// The owner accepts a failed checkpoint; only then can done pass with a fail.
export async function hubAccept(root: string, id: string, checkpoint: string): Promise<void> {
  const task = foldTasks(await readTaskEvents(root)).find((t) => t.id === id);
  if (!task) throw new Error(`unknown task: ${id}`);
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
}

// planAnswer's verdict math. A plan without valid checkpoints cannot be
// approved; approve turns into a send-back so the orchestrator re-plans.
export function planVerdict(
  task: HubTask,
  verdict: string,
  feedback: string,
): { line: string; event: 'answered' | 'handed'; note: string; summary: string } {
  const approved = verdict === 'approve' && (task.checkpoints ?? []).length > 0;
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
    const ci = args.indexOf('--checkpoints');
    const pos = ci === -1 ? args : args.filter((_, i) => i !== ci && i !== ci + 1);
    let checkpoints: Checkpoint[] | undefined;
    if (ci !== -1) {
      const raw = args[ci + 1];
      if (raw === undefined || raw.startsWith('--')) throw new Refusal('--checkpoints needs a value');
      try {
        checkpoints = JSON.parse(raw) as Checkpoint[];
      } catch {
        throw new Refusal('--checkpoints is a JSON array of {"id","desc","etaMin"}');
      }
    }
    await hubLog(root, pos[0], pos[1], pos.length > 2 ? pos.slice(2).join(' ') : undefined, checkpoints);
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
