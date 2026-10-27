import http from 'node:http';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Refusal, answerDialog, continueProject, hubTask, planAnswer, setProjectApprovals, setProjectMode, startProject, wake } from '../src/hub.js';
import { interruptAgent } from '../src/interrupt.js';
import { killAgent } from '../src/kill.js';
import { sendOwnerMessage } from '../src/message.js';
import { checkName } from '../src/names.js';
import { addProjectFromBody, removeProject } from '../src/project.js';
import { HttpError } from './http-error.js';
import { readAgentLog } from '../src/logview.js';
import { recordStretchOpened } from './stretch.js';
import { serialized } from './serialized.js';
import { handleTaskAction } from './taskactions.js'; import { handleQuestionAction } from './questionactions.js';
import {
  ACTION_TIMEOUT_MS, ANSWER_TIMEOUT_MS, buildView, lastLine, withTimeout,
} from '../src/view.js';

const BODY_CAP = 64 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const STATIC_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
};

function sendJson(res: http.ServerResponse, code: number, value: unknown): void {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

async function readBody(req: http.IncomingMessage, cap = BODY_CAP): Promise<Record<string, unknown>> {
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
function checkBrowserHeaders(req: http.IncomingMessage): void {
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

const TASK_TEXT_CAP = 4000;

async function handlePost(root: string, pathname: string, body: Record<string, unknown>): Promise<unknown> {
  const questionAction = await handleQuestionAction(root, pathname, body); if (questionAction !== null) return questionAction;
  if (!['/api/wake', '/api/continue', '/api/answer', '/api/task', '/api/start', '/api/mode', '/api/approvals', '/api/plan-answer', '/api/message', '/api/interrupt', '/api/kill', '/api/stretch-opened', '/api/project', '/api/project-delete', '/api/task-resolve', '/api/progress'].includes(pathname)) {
    throw new HttpError(404, `unknown endpoint: ${pathname}`);
  }
  if (pathname === '/api/stretch-opened') return recordStretchOpened(body);
  if (pathname === '/api/project') return serialized('projects', () => addProjectFromBody(root, body));
  const project = projectName(body);
  if (pathname === '/api/project-delete') return serialized('projects', () => serialized(`project:${project}`, () => removeProject(root, project)));
  const action = serialized(['/api/mode', '/api/approvals'].includes(pathname) ? 'projects' : `project:${project}`, async () => {
    if (pathname === '/api/mode') {
      return { ok: true, mode: await setProjectMode(root, project, String(body.mode ?? '')) };
    }
    if (pathname === '/api/approvals') {
      return { ok: true, approvals: await setProjectApprovals(root, project, String(body.approvals ?? '')) };
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
      return { ok: true, pane: await startProject(root, project, String(body.task ?? '')) };
    }
    if (pathname === '/api/message') {
      const r = await sendOwnerMessage(root, project, agentRefOf(body), String(body.text ?? ''));
      return { ok: true, typed: r.typed };
    }
    if (pathname === '/api/interrupt') {
      const r = await interruptAgent(root, project, agentRefOf(body));
      return { ok: true, target: r.target, pane: r.pane };
    }
    if (pathname === '/api/kill') {
      const r = await killAgent(root, project, agentRefOf(body));
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
    const r = await answerDialog(root, project, agentRefOf(body), String(body.choice ?? ''), String(body.fingerprint ?? ''));
    return { ok: true, option: r.option, choice: r.choice, session: r.session, dialog_gone: r.dialog_gone };
  });
  if (['/api/mode', '/api/approvals', '/api/task', '/api/task-resolve', '/api/progress'].includes(pathname)) return action;
  return withTimeout(action, pathname === '/api/answer' ? ANSWER_TIMEOUT_MS : ACTION_TIMEOUT_MS, pathname.slice(5));
}

// Compiled this file lives in dist/web/, in tests in web/ — find web/dist from either.
function staticDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const up of ['..', '../..']) {
    const candidate = path.resolve(here, up, 'web', 'dist');
    if (existsSync(candidate)) return candidate;
  }
  return path.resolve(here, '../../web/dist');
}

async function serveStatic(res: http.ServerResponse, pathname: string): Promise<void> {
  const dist = staticDir();
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const wanted = path.resolve(dist, rel);
  if (wanted !== dist && !wanted.startsWith(dist + path.sep)) throw new HttpError(400, 'bad path');
  let file = wanted;
  let real = await fs.realpath(file).catch(() => null);
  if (real === null && path.extname(file) === '') {
    // Single-page app: extensionless paths fall back to the shell.
    file = path.join(dist, 'index.html');
    real = await fs.realpath(file).catch(() => null);
  }
  const distReal = await fs.realpath(dist).catch(() => dist);
  if (real === null || (real !== distReal && !real.startsWith(distReal + path.sep))) {
    throw new HttpError(404, 'not found');
  }
  const data = await fs.readFile(real);
  // hashed assets are immutable forever; the html shell must revalidate or a
  // heuristic cache pins visitors to a stale bundle.
  const hashed = /[.-][0-9A-Za-z_-]{8}\.(js|css|woff2)$/.test(real);
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[path.extname(real)] ?? 'application/octet-stream',
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    ...STATIC_HEADERS,
  });
  res.end(data);
}

export function createServer(root: string): http.Server {
  const server = http.createServer((req, res) => {
    void (async () => {
      const secret = process.env.HIVE_WEB_SECRET;
      if (secret && req.headers['x-hive-auth'] !== secret) {
        throw new HttpError(403, 'missing or wrong x-hive-auth header');
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      // nexus fronts this app under /hive/; standalone serving stays at root.
      const pathname = url.pathname === '/hive' ? '/'
        : url.pathname.startsWith('/hive/') ? url.pathname.slice('/hive'.length)
        : url.pathname;
      if (pathname === '/api/view' && req.method === 'GET') {
        const view = await buildView(root);
        if (view.error) {
          // The read-failure reason can name filesystem paths; the browser
          // gets the generic line, the log gets the truth.
          console.error('hive web: view error:', view.error);
          sendJson(res, 200, {
            ...view,
            error: view.updatedAt === 0 ? 'the status read failed' : view.error.startsWith('questions') ? 'the questions read failed' : 'the tasks read failed',
          });
          return;
        }
        sendJson(res, 200, view);
        return;
      }
      if (pathname === '/api/log' && req.method === 'GET') {
        const log = await readAgentLog(
          root, url.searchParams.get('project') ?? '', url.searchParams.get('agent') ?? undefined,
        );
        sendJson(res, 200, log);
        return;
      }
      if (pathname.startsWith('/api/')) {
        if (req.method !== 'POST') throw new HttpError(405, `${pathname} is POST only`);
        checkBrowserHeaders(req);
        const contentType = req.headers['content-type'] ?? '';
        if (!contentType.startsWith('application/json')) throw new HttpError(415, 'POST a JSON body');
        sendJson(res, 200, await handlePost(root, pathname, await readBody(req, pathname === '/api/questions/answer' ? 512 * 1024 : BODY_CAP)));
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'GET only');
      await serveStatic(res, pathname);
    })().catch((e: unknown) => {
      if (e instanceof HttpError) {
        sendJson(res, e.code, { ok: false, detail: e.message });
        return;
      }
      // Refusals are deliberate, operator-safe messages; anything else is
      // infrastructure (corrupt state, locks, tmux) and never leaves the box.
      if (e instanceof Refusal) {
        sendJson(res, 400, { ok: false, detail: lastLine(e) });
        return;
      }
      console.error('hive web:', e);
      sendJson(res, 500, { ok: false, detail: 'internal error' });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}

export function listen(root: string, port: number): Promise<http.Server> {
  const server = createServer(root);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
