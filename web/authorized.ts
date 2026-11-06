import type http from 'node:http';
import type { HubView } from '../src/types.js';
import { listOpenQuestionBatches } from '../src/questions.js';
import { readAgentLog, resolveLogTarget } from '../src/logview.js';
import { RegistryUnavailable, type Registry } from '../src/registry.js';
import { Refusal } from '../src/state.js';
import {
  AuthenticationError, AuthorizationError, authorize, bearerFromRequest, createWakeSubscription,
  publicAgentIdentity, revoked, revokeWakeSubscription, type Principal,
} from '../src/security.js';
import { buildView, lastLine } from '../src/view.js';
import { BODY_CAP, checkBrowserHeaders, handlePost, postAction, postScope, readBody, storedAgentTask } from './actions.js';
import { HttpError } from './http-error.js';
import { serveStatic } from './static.js';

function sendJson(res: http.ServerResponse, code: number, value: unknown): void {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

async function filteredView(root: string, view: HubView, principal: Principal, registry: Registry,
  allOpen: HubView['questions']): Promise<HubView> {
  const visibleProjects = new Set<string>();
  const fullReadProjects = new Set<string>();
  const allowed = async (project: string, task?: string): Promise<boolean> => {
    try {
      await authorize(principal, registry, 'read', { project, task });
      visibleProjects.add(project);
      if (task === undefined) fullReadProjects.add(project);
      return true;
    } catch (error) {
      if (error instanceof AuthorizationError) return false;
      throw error;
    }
  };
  for (const project of view.projects) await allowed(project.name);
  const tasks = [];
  for (const task of view.tasks) {
    if (await allowed(task.project, task.id)) tasks.push(task);
  }
  const agentTask = async (project: string, agent: unknown): Promise<string | null | undefined> => {
    try {
      return await storedAgentTask(root, project, agent);
    } catch (error) {
      if (error instanceof AuthorizationError) return null;
      throw error;
    }
  };
  const visibleAllOpen = [];
  for (const question of allOpen) {
    const task = await agentTask(question.project, question.agent);
    if (task !== null && await allowed(question.project, task)) visibleAllOpen.push(question);
  }
  const visibleQuestionIds = new Set(visibleAllOpen.map((question) => question.id));
  const decisions = [];
  for (const decision of view.decisions) {
    if (await allowed(decision.project, decision.task)) decisions.push(decision);
  }
  const dialogs = [];
  for (const entry of Object.entries(view.dialogs)) {
    const [project, agent] = entry[0].split('/');
    const task = await agentTask(project, agent);
    if (task !== null && await allowed(project, task)) dialogs.push(entry);
  }
  const projects = [];
  for (const project of view.projects) {
    if (!visibleProjects.has(project.name)) continue;
    if (fullReadProjects.has(project.name)) {
      projects.push(project);
      continue;
    }
    const agents = [];
    for (const agent of project.agents) {
      const task = await agentTask(project.name, agent.ref ?? agent.name);
      if (task !== null && await allowed(project.name, task)) agents.push(agent);
    }
    projects.push({
      ...project, home: '', repos: [], agents,
      orchestrator: { state: 'unregistered' as const },
      open_tasks: tasks.filter((task) => task.project === project.name).length,
      mode: undefined, approvals: undefined,
    });
  }
  return {
    ...view,
    projects,
    tasks,
    questions: view.questions.filter((question) => visibleQuestionIds.has(question.id)),
    questionsTotal: visibleAllOpen.length,
    dialogs: Object.fromEntries(dialogs),
    decisions,
  };
}

function agentId(body: Record<string, unknown>): string {
  const value = String(body.agentId ?? '');
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(value)) throw new AuthorizationError('not found');
  return value;
}

export type RequestContext = {
  root: string;
  registry: Registry;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  pathname: string;
  authenticate: () => Promise<Principal>;
};

async function viewResponse(context: RequestContext): Promise<void> {
  const view = await buildView(context.root);
  const current = await context.authenticate();
  const allOpen = view.error.startsWith('questions') ? [] : await listOpenQuestionBatches(context.root);
  const filtered = await filteredView(context.root, view, current, context.registry, allOpen);
  if (filtered.error) {
    console.error('hive web: view error:', filtered.error);
    filtered.error = filtered.updatedAt === 0 ? 'the status read failed'
      : filtered.error.startsWith('questions') ? 'the questions read failed' : 'the tasks read failed';
  }
  sendJson(context.res, 200, filtered);
}

async function logResponse(context: RequestContext, principal: Principal): Promise<void> {
  const project = context.url.searchParams.get('project') ?? '';
  const agent = context.url.searchParams.get('agent') ?? undefined;
  if (context.url.searchParams.has('thread')) throw new AuthorizationError('not found');
  let target: { name: string; task?: string };
  try {
    target = await resolveLogTarget(context.root, project, principal.kind === 'agent' ? principal.agentId : agent);
  } catch {
    throw new AuthorizationError('not found');
  }
  if (principal.kind === 'agent' && target.name !== principal.agentId) throw new AuthorizationError('not found');
  const scope = { project, task: target.task };
  await authorize(principal, context.registry, 'read', scope);
  const log = await readAgentLog(context.root, project, target.name);
  const current = await context.authenticate();
  await authorize(current, context.registry, 'read', scope);
  sendJson(context.res, 200, log);
}

async function wakeListResponse(context: RequestContext, principal: Principal): Promise<void> {
  const id = context.url.searchParams.get('agentId') ?? '';
  const profile = await context.registry.get(`AGENT#${id}`, 'PROFILE');
  if (!profile || await revoked(context.registry, profile)) {
    throw new AuthorizationError('not found');
  }
  if (principal.kind !== 'human' || principal.subject !== profile.ownerSubject) {
    await authorize(principal, context.registry, 'execute', { project: String(profile.project) });
  }
  const rows = await context.registry.query(`AGENT#${id}`, 'WAKE#');
  sendJson(context.res, 200, rows.map((row) => ({
    subscriptionId: row.subscriptionId, agentId: row.agentId, executionGrantId: row.executionGrantId,
    createdBy: row.createdBy, createdAt: row.createdAt, revokedAt: row.revokedAt, aclEpoch: row.aclEpoch,
  })));
}

async function postResponse(context: RequestContext, principal: Principal): Promise<void> {
  const { pathname, req, res } = context;
  if (req.method !== 'POST') throw new HttpError(405, `${pathname} is POST only`);
  checkBrowserHeaders(req);
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.startsWith('application/json')) throw new HttpError(415, 'POST a JSON body');
  const body = await readBody(req, pathname === '/api/questions/answer' ? 512 * 1024 : BODY_CAP);
  if (pathname === '/api/wake-subscriptions') {
    sendJson(res, 200, await createWakeSubscription(
      context.registry, principal, agentId(body), String(body.executionGrantId ?? ''),
      bearerFromRequest(req),
    ));
    return;
  }
  if (pathname === '/api/wake-subscriptions/revoke') {
    await revokeWakeSubscription(
      context.registry, principal, agentId(body), String(body.subscriptionId ?? ''),
      bearerFromRequest(req),
    );
    sendJson(res, 200, { ok: true });
    return;
  }
  if (pathname === '/api/stretch-opened') {
    if (principal.kind !== 'human') throw new AuthorizationError('not found');
    const result = await handlePost(context.root, pathname, body, principal);
    await context.authenticate();
    sendJson(res, 200, result);
    return;
  }
  if (pathname === '/api/message' && principal.kind === 'agent') throw new AuthorizationError('not found');
  const scope = await postScope(context.root, pathname, body, principal);
  const action = postAction(pathname);
  await authorize(principal, context.registry, action, scope);
  const result = await handlePost(context.root, pathname, body, principal);
  const current = await context.authenticate();
  await authorize(current, context.registry, action, scope);
  sendJson(res, 200, result);
}

async function legacyRouteRequest(context: RequestContext): Promise<void> {
  const { pathname, req, res } = context;
  if (pathname === '/api/agent/identity' || pathname.startsWith('/api/wake-subscriptions')) {
    throw new HttpError(404, 'not found');
  }
  if (pathname === '/api/view' && req.method === 'GET') {
    const view = await buildView(context.root);
    if (view.error) {
      console.error('hive web: view error:', view.error);
      view.error = view.updatedAt === 0 ? 'the status read failed'
        : view.error.startsWith('questions') ? 'the questions read failed' : 'the tasks read failed';
    }
    sendJson(res, 200, view);
    return;
  }
  if (pathname === '/api/log' && req.method === 'GET') {
    const log = await readAgentLog(
      context.root, context.url.searchParams.get('project') ?? '',
      context.url.searchParams.get('agent') ?? undefined,
    );
    sendJson(res, 200, log);
    return;
  }
  if (pathname.startsWith('/api/')) {
    if (req.method !== 'POST') throw new HttpError(405, `${pathname} is POST only`);
    checkBrowserHeaders(req);
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.startsWith('application/json')) throw new HttpError(415, 'POST a JSON body');
    const body = await readBody(req, pathname === '/api/questions/answer' ? 512 * 1024 : BODY_CAP);
    const principal: Principal = { kind: 'human', subject: 'legacy', aclEpoch: 0 };
    sendJson(res, 200, await handlePost(context.root, pathname, body, principal));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'GET only');
  await serveStatic(res, pathname);
}

export async function routeRequest(context: RequestContext): Promise<void> {
  if (process.env.HIVE_COLLABORATION_ENABLED !== '1') return legacyRouteRequest(context);
  const { pathname, req, res } = context;
  let principal = await context.authenticate();
  if (pathname === '/api/agent/identity' && req.method === 'GET') {
    publicAgentIdentity(principal);
    principal = await context.authenticate();
    sendJson(res, 200, publicAgentIdentity(principal));
    return;
  }
  if (pathname === '/api/view' && req.method === 'GET') return viewResponse(context);
  if (pathname === '/api/log' && req.method === 'GET') return logResponse(context, principal);
  if (pathname === '/api/wake-subscriptions' && req.method === 'GET') return wakeListResponse(context, principal);
  if (pathname.startsWith('/api/')) return postResponse(context, principal);
  if (principal.kind !== 'human') throw new AuthorizationError('not found');
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'GET only');
  await serveStatic(res, pathname);
}

export function errorResponse(res: http.ServerResponse, error: unknown): void {
  if (error instanceof AuthenticationError) return sendJson(res, 401, { ok: false, detail: 'authentication failed' });
  if (error instanceof AuthorizationError) return sendJson(res, 404, { ok: false, detail: 'not found' });
  if (error instanceof RegistryUnavailable) {
    if (error.status === 401) return sendJson(res, 401, { ok: false, detail: 'authentication failed' });
    if (error.status === 404) return sendJson(res, 404, { ok: false, detail: 'not found' });
    return sendJson(res, 503, { ok: false, detail: 'identity service unavailable' });
  }
  if (error instanceof HttpError) return sendJson(res, error.code, { ok: false, detail: error.message });
  if (error instanceof Refusal) return sendJson(res, 400, { ok: false, detail: lastLine(error) });
  console.error('hive web:', error);
  sendJson(res, 500, { ok: false, detail: 'internal error' });
}
