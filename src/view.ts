import type { Decision, HubProject, HubTask, HubView, NativeBranchRecord, QuestionBatch, TaskEvent, TeamEntry } from './types.js';
import { displayText } from './window-name.js';
export { displayText } from './window-name.js';
import { buildStatus, listTasks, readDialogFor, redactDialog } from './hub.js';
import { listNativeBranches } from './branches.js';
import { VIEW_BATCH_CAP, listOpenQuestionBatches } from './questions.js';
import { readDecisions, readTaskEvents, readTeam } from './state.js';
import { buildWorkTree } from './supervision.js';

export const READ_TIMEOUT_MS = 30_000;
export const ACTION_TIMEOUT_MS = 150_000;
export const ANSWER_TIMEOUT_MS = 30_000;

const DECISIONS_SHOWN = 8;
const DECISIONS_SCANNED = 64;

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

export function displayLine(e: unknown): string {
  return displayText(lastLine(e));
}

export async function buildView(root: string): Promise<HubView> {
  let questions: QuestionBatch[] = [];
  let openBatches: QuestionBatch[] = [];
  let questionsTotal = 0;
  let error = '';
  try {
    openBatches = await withTimeout(listOpenQuestionBatches(root), READ_TIMEOUT_MS, 'questions');
    questionsTotal = openBatches.length;
    questions = openBatches.slice(0, VIEW_BATCH_CAP);
  } catch (e) {
    error = `questions not read: ${displayLine(e)}`;
  }
  let status;
  try {
    status = await withTimeout(buildStatus(root, openBatches), READ_TIMEOUT_MS, 'status');
  } catch (e) {
    return { root, hubName: '', projects: [], tasks: [], dialogs: {}, decisions: [], questions: [], questionsTotal: 0, updatedAt: 0, error: displayLine(e) };
  }
  let tasks: HubTask[] = [];
  let events: TaskEvent[] = [];
  try {
    tasks = await withTimeout(listTasks(root), READ_TIMEOUT_MS, 'tasks');
    events = await readTaskEvents(root).catch(() => []);
  } catch (e) {
    error = [error, `tasks not read: ${displayLine(e)}`].filter(Boolean).join(' · ');
  }
  const teams: Record<string, TeamEntry[]> = {};
  const branches: NativeBranchRecord[] = [];
  for (const project of status.projects) {
    teams[project.name] = await readTeam(project.home).then((team) => team.agents).catch(() => []);
    branches.push(...await listNativeBranches(root, project.name).catch(() => []));
  }
  const workTree = buildWorkTree({ tasks, teams, branches, events });
  const dialogs = await readDialogs(root, status.projects);
  const decisions = await readDecisions(root, DECISIONS_SCANNED)
    .then((ds) => ds.filter(feedKeep).slice(0, DECISIONS_SHOWN)
      .map((d) => ({ ...d, summary: displayText(d.summary) })))
    .catch((e) => {
      error = [error, `decisions not read: ${displayLine(e)}`].filter(Boolean).join(' · ');
      return [];
    });
  return {
    root,
    hubName: status.hub.name ?? '',
    projects: status.projects,
    tasks,
    dialogs,
    decisions,
    questions,
    questionsTotal,
    workTree,
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
        if (d) dialogs[p.name] = redactDialog(d);
      }).catch(() => {}));
    }
    for (const a of p.agents) {
      if (a.question && a.ref) {
        jobs.push(readDialogFor(root, p.name, a.ref).then((d) => {
          if (d) dialogs[`${p.name}/${a.ref}`] = redactDialog(d);
        }).catch(() => {}));
      }
    }
  }
  await Promise.all(jobs);
  return dialogs;
}
