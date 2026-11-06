import type http from 'node:http';
import { Refusal, answerDialog, continueProject, hubTask, listTasks, planAnswer, setProjectApprovals, setProjectMode, startProject, wake } from '../src/hub.js';
import { hubPath } from '../src/state.js';
export { storedAgentTask } from '../src/agent-target.js';
import { storedAgentTask } from '../src/agent-target.js';
import { interruptAgent } from '../src/interrupt.js';
import { killAgent } from '../src/kill.js';
import { sendOwnerMessage } from '../src/message.js';
import { checkName, PROJECT_NAME_RE } from '../src/names.js';
import { addProjectFromBody, removeProject } from '../src/project.js';
import { handleCurrentOrchestratorDialog } from '../src/watch.js';
import { readQuestionBatch, type ApprovalAuthorization } from '../src/questions.js';
import { AuthorizationError, type Principal } from '../src/security.js';
import { ACTION_TIMEOUT_MS, ANSWER_TIMEOUT_MS, withTimeout } from '../src/view.js';
import { HttpError } from './http-error.js';
import { recordStretchOpened } from './stretch.js';
import { serialized } from './serialized.js';
import { handleTaskAction } from './taskactions.js';
import { handleQuestionAction } from './questionactions.js';

export const BODY_CAP = 64 * 1024;
const TASK_TEXT_CAP = 4000;

export async function readBody(req: http.IncomingMessage, cap = BODY_CAP): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > cap) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'the body is not a JSON object');
  }
}

// Cross-site POSTs die here: no-cors forms cannot set a JSON content type,
// and any browser request from another origin carries a mismatched Origin or
// Sec-Fetch-Site.
export function checkBrowserHeaders(req: http.IncomingMessage): void {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'cross-site request');
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {
      throw new HttpError(403, 'bad origin header');
    }
    if (host !== req.headers.host)
      throw new HttpError(403, `cross-site request (origin host ${host} != host ${req.headers.host})`);
  }
}

function projectName(body: Record<string, unknown>): string {
  try {
    return checkName('project', String(body.project ?? ''));
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
}

function agentRefOf(body: Record<string, unknown>): string | undefined {
  if (body.agent === undefined || body.agent === null || body.agent === '') return undefined;
  const ref = String(body.agent);
  try {
    checkName('agent', ref.split('@')[0]);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
  return ref;
}

export function requestAgentRef(body: Record<string, unknown>, principal: Principal): string | undefined {
  if (principal.kind === 'agent') {
    const ref = body.agent === undefined || body.agent === null || body.agent === ''
      ? undefined : String(body.agent);
    if (ref !== undefined && ref.split('@')[0] !== principal.agentId) {
      throw new AuthorizationError('not found');
    }
    return ref ?? principal.agentId;
  }
  return agentRefOf(body);
}

export async function handlePost(root: string, pathname: string, body: Record<string, unknown>,
  principal: Principal, authorization?: ApprovalAuthorization): Promise<unknown> {
  const questionAction = await handleQuestionAction(root, pathname, body, authorization);
  if (questionAction !== null) return questionAction;
  if (!['/api/wake', '/api/continue', '/api/answer', '/api/task', '/api/start', '/api/mode', '/api/approvals', '/api/plan-answer', '/api/message', '/api/interrupt', '/api/kill', '/api/stretch-opened', '/api/project', '/api/project-delete', '/api/task-resolve', '/api/progress'].includes(pathname)) {
    throw new HttpError(404, `unknown endpoint: ${pathname}`);
  }
  if (pathname === '/api/stretch-opened') return recordStretchOpened(body);
  if (pathname === '/api/project') return serialized('projects', () => addProjectFromBody(root, body));
  const project = projectName(body);
  if (pathname === '/api/project-delete') return serialized('projects', () => serialized(`project:${project}`, () => removeProject(root, project)));
  const action = serialized(['/api/mode', '/api/approvals'].includes(pathname) ? 'projects' : `project:${project}`, async () => {
    if (pathname === '/api/mode') {
      const mode = await setProjectMode(root, project, String(body.mode ?? ''));
      await handleCurrentOrchestratorDialog(root, project);
      return { ok: true, mode };
    }
    if (pathname === '/api/approvals') {
      const approvals = await setProjectApprovals(root, project, String(body.approvals ?? ''));
      await handleCurrentOrchestratorDialog(root, project);
      return { ok: true, approvals };
    }
    if (pathname === '/api/wake') {
      return { ok: true, pane: await wake(root, project) };
    }
    if (pathname === '/api/continue') {
      return { ok: true, pane: await continueProject(root, project) };
    }
    if (pathname === '/api/task') {
      // Task text only ever lands in tasks/<id>.md; the pickup line names the
      // file path, so this text never touches a shell or send-keys.
      const text = String(body.text ?? '');
      if (!text.trim()) throw new HttpError(400, 'task text is empty');
      if (text.length > TASK_TEXT_CAP) {
        throw new HttpError(413, `task text is capped at ${TASK_TEXT_CAP} characters`);
      }
      return { ok: true, id: await hubTask(root, project, text) };
    }
    if (pathname === '/api/start') {
      const task = String(body.task ?? '');
      try {
        return { ok: true, pane: await startProject(root, project, task) };
      } catch (e) {
        if (!(e instanceof Refusal) || e.message !== `${project}'s orchestrator is already running`) throw e;
        const r = await sendOwnerMessage(
          root, project, undefined,
          `New task ${task}: read ${hubPath(root, 'tasks', `${task}.md`)} and take it from there.`,
        );
        return { ok: true, typed: r.typed };
      }
    }
    if (pathname === '/api/message') {
      const r = await sendOwnerMessage(root, project, requestAgentRef(body, principal), String(body.text ?? ''));
      return { ok: true, typed: r.typed };
    }
    if (pathname === '/api/interrupt') {
      const r = await interruptAgent(root, project, requestAgentRef(body, principal));
      return { ok: true, target: r.target, pane: r.pane };
    }
    if (pathname === '/api/kill') {
      const r = await killAgent(root, project, requestAgentRef(body, principal));
      return { ok: true, target: r.target, killed: r.killed, summary: r.summary };
    }
    if (pathname === '/api/plan-answer') {
      const r = await planAnswer(
        root, project, String(body.task ?? ''), String(body.verdict ?? ''),
        body.feedback === undefined ? undefined : String(body.feedback),
      );
      return { ok: true, typed: r.typed };
    }
    const taskAction = await handleTaskAction(root, project, pathname, body);
    if (taskAction !== null) return taskAction;
    const r = await answerDialog(root, project, requestAgentRef(body, principal), String(body.choice ?? ''), String(body.fingerprint ?? ''));
    return { ok: true, option: r.option, choice: r.choice, session: r.session, dialog_gone: r.dialog_gone };
  });
  if (['/api/mode', '/api/approvals', '/api/task', '/api/task-resolve', '/api/progress'].includes(pathname)) return action;
  return withTimeout(action, pathname === '/api/answer' ? ANSWER_TIMEOUT_MS : ACTION_TIMEOUT_MS, pathname.slice(5));
}

export function postAction(pathname: string): string {
  if (['/api/project', '/api/project-delete', '/api/mode', '/api/approvals', '/api/task-resolve', '/api/questions/cancel', '/api/task'].includes(pathname)) return 'admin';
  if (['/api/wake', '/api/continue', '/api/start', '/api/interrupt', '/api/kill', '/api/answer'].includes(pathname)) return 'execute';
  return 'write';
}

async function storedTask(root: string, project: string, taskId: unknown): Promise<string | undefined> {
  if (taskId === undefined || taskId === '') return undefined;
  const tasks = await listTasks(root);
  const task = tasks.find((candidate) => candidate.id === taskId && candidate.project === project);
  if (!task) throw new AuthorizationError('not found');
  return task.id;
}

export async function postScope(root: string, pathname: string,
  body: Record<string, unknown>, principal: Principal): Promise<{ project: string; task?: string; thread?: string }> {
  if (body.thread !== undefined) throw new AuthorizationError('not found');
  if (pathname.startsWith('/api/questions/')) {
    try {
      const batch = await readQuestionBatch(root, String(body.id ?? ''));
      return { project: batch.project, task: await storedAgentTask(root, batch.project, batch.agent) };
    } catch (error) {
      if (error instanceof AuthorizationError) throw error;
      throw new AuthorizationError('not found');
    }
  }
  let project: string;
  if (pathname === '/api/project') {
    project = String(body.name ?? '');
    if (!PROJECT_NAME_RE.test(project)) {
      throw new HttpError(400, `a project name is lowercase letters, digits and '-', and starts with a letter: ${project}`);
    }
  } else {
    project = projectName(body);
  }
  if (['/api/task', '/api/wake', '/api/continue', '/api/mode', '/api/approvals', '/api/project-delete'].includes(pathname)) {
    return { project };
  }
  const task = await storedTask(root, project, body.task);
  if (['/api/message', '/api/interrupt', '/api/kill', '/api/answer'].includes(pathname)) {
    return { project, task: await storedAgentTask(root, project, requestAgentRef(body, principal)) };
  }
  return { project, task };
}
