import type { Decision, HubProject, HubTask, HubView, QuestionBatch } from './types.js';
import { buildStatus, listTasks, readDialogFor } from './hub.js';
import { listOpenQuestionBatches } from './questions.js';
import { readDecisions } from './state.js';

export const READ_TIMEOUT_MS = 30_000;
export const ACTION_TIMEOUT_MS = 150_000;
export const ANSWER_TIMEOUT_MS = 30_000;

const DECISIONS_SHOWN = 8;
const DECISIONS_SCANNED = 64;

// The feed is signal only: tier-1 auto-approvals and "Approve once" clicks are
// noise. Plan verdicts, send-backs, watchdog deaths, and wedged marks stay.
export function feedKeep(d: Decision): boolean {
  if (d.by === 'watch' && d.summary.startsWith('auto-approved "Approve once"')) return false;
  if (d.by === 'owner' && d.summary.startsWith('answered "Approve once"')) return false;
  return true;
}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

export function lastLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const line = msg.split('\n').filter((l) => l.trim()).pop() ?? msg;
  return line.replace(/^hive: /, '');
}

// One assembly for both screens (Ink and web): status + tasks + the dialogs
// map, so the two can never drift. updatedAt 0 + error means the status read
// itself failed; callers keep their previous projects/tasks in that case.
export async function buildView(root: string): Promise<HubView> {
  let status;
  try {
    status = await withTimeout(buildStatus(root), READ_TIMEOUT_MS, 'status');
  } catch (e) {
    return { root, hubName: '', projects: [], tasks: [], dialogs: {}, decisions: [], questions: [], updatedAt: 0, error: lastLine(e) };
  }
  let tasks: HubTask[] = [];
  let error = '';
  try {
    tasks = await withTimeout(listTasks(root), READ_TIMEOUT_MS, 'tasks');
  } catch (e) {
    error = `tasks not read: ${lastLine(e)}`;
  }
  let questions: QuestionBatch[] = [];
  try {
    questions = await withTimeout(listOpenQuestionBatches(root), READ_TIMEOUT_MS, 'questions');
  } catch (e) {
    error = [error, `questions not read: ${lastLine(e)}`].filter(Boolean).join(' · ');
  }
  const dialogs = await readDialogs(root, status.projects);
  // Scan further back than the feed shows, so filtered noise cannot starve it.
  const decisions = await readDecisions(root, DECISIONS_SCANNED)
    .then((ds) => ds.filter(feedKeep).slice(0, DECISIONS_SHOWN))
    .catch(() => []);
  return {
    root,
    hubName: status.hub.name ?? '',
    projects: status.projects,
    tasks,
    dialogs,
    decisions,
    questions,
    updatedAt: Date.now(),
    error,
  };
}

async function readDialogs(root: string, projects: HubProject[]): Promise<HubView['dialogs']> {
  const dialogs: HubView['dialogs'] = {};
  const jobs: Promise<void>[] = [];
  for (const p of projects) {
    if (p.orchestrator.question || p.orchestrator.starting?.question) {
      jobs.push(readDialogFor(root, p.name).then((d) => {
        if (d) dialogs[p.name] = d;
      }).catch(() => {}));
    }
    for (const a of p.agents) {
      if (a.question && a.ref) {
        jobs.push(readDialogFor(root, p.name, a.ref).then((d) => {
          if (d) dialogs[`${p.name}/${a.ref}`] = d;
        }).catch(() => {}));
      }
    }
  }
  await Promise.all(jobs);
  return dialogs;
}
