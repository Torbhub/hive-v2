import type { HubProject, HubTask, HubView } from './types.js';
import { buildStatus, listTasks, readDialogFor } from './hub.js';
import { readDecisions } from './state.js';

export const READ_TIMEOUT_MS = 30_000;
export const ACTION_TIMEOUT_MS = 150_000;
export const ANSWER_TIMEOUT_MS = 30_000;

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
    return { root, hubName: '', projects: [], tasks: [], dialogs: {}, decisions: [], updatedAt: 0, error: lastLine(e) };
  }
  let tasks: HubTask[] = [];
  let error = '';
  try {
    tasks = await withTimeout(listTasks(root), READ_TIMEOUT_MS, 'tasks');
  } catch (e) {
    error = `tasks not read: ${lastLine(e)}`;
  }
  const dialogs = await readDialogs(root, status.projects);
  const decisions = await readDecisions(root, 8).catch(() => []);
  return {
    root,
    hubName: status.hub.name ?? '',
    projects: status.projects,
    tasks,
    dialogs,
    decisions,
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
