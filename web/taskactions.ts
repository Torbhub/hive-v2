import { Refusal, hubLog, hubProgress, listTasks } from '../src/hub.js';
import { appendDecision } from '../src/state.js';
import { CLOSED_STATES } from '../src/types.js';

// Same cap as a task brief.
const RESOLVE_NOTE_CAP = 4000;

// Owner verdicts on a waiting task: cancel it, or send it back to asked with a
// new brief. Ledger appends only, so a dead pane never blocks the call.
async function taskResolve(
  root: string,
  project: string,
  body: Record<string, unknown>,
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
  const task = (await listTasks(root)).find((t) => t.id === taskId);
  if (!task || task.project !== project) throw new Refusal(`unknown task: ${taskId}`);
  if (CLOSED_STATES.has(task.state)) throw new Refusal(`${taskId} is already ${task.state}`);
  if (action === 'cancel') {
    await hubLog(root, taskId, 'cancelled', brief || 'cancelled by the owner');
    await appendDecision(root, { project, task: taskId, by: 'owner', summary: `cancelled ${taskId}` });
  } else {
    await hubLog(root, taskId, 'asked', brief);
    await appendDecision(root, {
      project, task: taskId, by: 'owner', summary: `rebriefed ${taskId}: ${brief.slice(0, 120)}`,
    });
  }
  return { ok: true };
}

// Thin pass-through to the hub progress function; workers mostly use the CLI.
async function recordProgress(
  root: string,
  project: string,
  body: Record<string, unknown>,
): Promise<{ ok: true }> {
  const taskId = String(body.task ?? '').trim();
  const checkpoint = String(body.checkpoint ?? '').trim();
  if (!taskId || !checkpoint) throw new Refusal('task and checkpoint are required');
  const task = (await listTasks(root)).find((t) => t.id === taskId);
  if (!task || task.project !== project) throw new Refusal(`unknown task: ${taskId}`);
  await hubProgress(
    root, taskId, checkpoint, String(body.status ?? ''),
    body.note === undefined ? undefined : String(body.note),
  );
  return { ok: true };
}

// null means the path is not a task action and the caller keeps dispatching.
export async function handleTaskAction(
  root: string,
  project: string,
  pathname: string,
  body: Record<string, unknown>,
): Promise<unknown | null> {
  if (pathname === '/api/task-resolve') return taskResolve(root, project, body);
  if (pathname === '/api/progress') return recordProgress(root, project, body);
  return null;
}
