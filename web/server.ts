import http from 'node:http';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Refusal, answerDialog, continueProject, hubLog, hubProgress, hubTask, listTasks, planAnswer, setProjectApprovals, setProjectMode, startProject, wake } from '../src/hub.js';
import { sendOwnerMessage } from '../src/message.js';
import { checkName } from '../src/names.js';
import { addProjectFromBody } from '../src/project.js';
import { appendDecision } from '../src/state.js';
import { CLOSED_STATES } from '../src/types.js';
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

class HttpError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

function sendJson(res: http.ServerResponse, code: number, value: unknown): void {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_CAP) throw new HttpError(413, 'body too large');
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
    if (host !== req.headers.host) throw new HttpError(403, 'cross-site request');
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

// projects.json writers share one key so their read-modify-write cannot race. Other actions serialize per project.
const actionChains = new Map<string, Promise<void>>();

function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = actionChains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const sweep = () => { if (actionChains.get(key) === tail) actionChains.delete(key); };
  const tail = run.then(sweep, sweep);
  actionChains.set(key, tail);
  return run;
}

const TASK_TEXT_CAP = 4000;
const STRETCH_FIELD_CAP = 200;

// Owner verdicts on a waiting task: cancel it, or send it back to asked with a
// new brief. Ledger appends only, so a dead pane never blocks the call.
async function taskResolve(
  root: string,
  project: string,
  taskId: string,
  action: string,
  note?: string,
): Promise<{ ok: true }> {
  if (action !== 'cancel' && action !== 'rebrief') {
    throw new Refusal(`a resolve action is cancel|rebrief: ${action}`);
  }
  const brief = note?.replace(/\s+/g, ' ').trim() ?? '';
  if (action === 'rebrief' && !brief) throw new Refusal('a rebrief needs a note: the new brief');
  if (brief.length > TASK_TEXT_CAP) {
    throw new Refusal(`the note is capped at ${TASK_TEXT_CAP} characters`);
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

// The stretchtext skill reads this log to know which spans the owner opened.
function stretchLogPath(): string {
  return process.env.HIVE_STRETCH_LOG
    ?? path.join(os.homedir(), '.kimi-code', 'stretch-opened.jsonl');
}

async function recordStretchOpened(body: Record<string, unknown>): Promise<unknown> {
  const short = String(body.short ?? '').trim();
  if (!short) throw new HttpError(400, 'short is empty');
  if (short.length > STRETCH_FIELD_CAP) {
    throw new HttpError(413, `short is capped at ${STRETCH_FIELD_CAP} characters`);
  }
  const pane = String(body.pane ?? '').slice(0, STRETCH_FIELD_CAP);
  const file = stretchLogPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify({ ts: Date.now(), short, pane })}\n`);
  return { ok: true };
}

async function handlePost(root: string, pathname: string, body: Record<string, unknown>): Promise<unknown> {
  if (!['/api/wake', '/api/continue', '/api/answer', '/api/task', '/api/start', '/api/mode', '/api/approvals', '/api/plan-answer', '/api/message', '/api/stretch-opened', '/api/project', '/api/task-resolve', '/api/progress'].includes(pathname)) {
    throw new HttpError(404, `unknown endpoint: ${pathname}`);
  }
  if (pathname === '/api/stretch-opened') return recordStretchOpened(body);
  if (pathname === '/api/project') return serialized('projects', () => addProjectFromBody(root, body));
  const project = projectName(body);
  return serialized(['/api/mode', '/api/approvals'].includes(pathname) ? 'projects' : project, async () => {
    if (pathname === '/api/mode') {
      return { ok: true, mode: await setProjectMode(root, project, String(body.mode ?? '')) };
    }
    if (pathname === '/api/approvals') {
      return { ok: true, approvals: await setProjectApprovals(root, project, String(body.approvals ?? '')) };
    }
    if (pathname === '/api/wake') {
      const pane = await withTimeout(wake(root, project), ACTION_TIMEOUT_MS, 'wake');
      return { ok: true, pane };
    }
    if (pathname === '/api/continue') {
      const pane = await withTimeout(continueProject(root, project), ACTION_TIMEOUT_MS, 'continue');
      return { ok: true, pane };
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
      const pane = await withTimeout(
        startProject(root, project, String(body.task ?? '')), ACTION_TIMEOUT_MS, 'start',
      );
      return { ok: true, pane };
    }
    if (pathname === '/api/message') {
      const r = await withTimeout(
        sendOwnerMessage(root, project, agentRefOf(body), String(body.text ?? '')), ACTION_TIMEOUT_MS, 'message',
      );
      return { ok: true, typed: r.typed };
    }
    if (pathname === '/api/plan-answer') {
      const r = await withTimeout(
        planAnswer(
          root, project, String(body.task ?? ''), String(body.verdict ?? ''),
          body.feedback === undefined ? undefined : String(body.feedback),
        ),
        ACTION_TIMEOUT_MS, 'plan-answer',
      );
      return { ok: true, typed: r.typed };
    }
    if (pathname === '/api/task-resolve') {
      return taskResolve(
        root, project, String(body.task ?? ''), String(body.action ?? ''),
        body.note === undefined ? undefined : String(body.note),
      );
    }
    if (pathname === '/api/progress') {
      const taskId = String(body.task ?? '').trim();
      const checkpoint = String(body.checkpoint ?? '').trim();
      if (!taskId || !checkpoint) throw new HttpError(400, 'task and checkpoint are required');
      const task = (await listTasks(root)).find((t) => t.id === taskId);
      if (!task || task.project !== project) throw new Refusal(`unknown task: ${taskId}`);
      await hubProgress(
        root, taskId, checkpoint, String(body.status ?? ''),
        body.note === undefined ? undefined : String(body.note),
      );
      return { ok: true };
    }
    const r = await withTimeout(
      answerDialog(root, project, agentRefOf(body), String(body.choice ?? ''), String(body.fingerprint ?? '')),
      ANSWER_TIMEOUT_MS,
      'answer',
    );
    return { ok: true, option: r.option, choice: r.choice, session: r.session, dialog_gone: r.dialog_gone };
  });
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
            error: view.updatedAt === 0 ? 'the status read failed' : 'the tasks read failed',
          });
          return;
        }
        sendJson(res, 200, view);
        return;
      }
      if (pathname.startsWith('/api/')) {
        if (req.method !== 'POST') throw new HttpError(405, `${pathname} is POST only`);
        checkBrowserHeaders(req);
        const contentType = req.headers['content-type'] ?? '';
        if (!contentType.startsWith('application/json')) throw new HttpError(415, 'POST a JSON body');
        sendJson(res, 200, await handlePost(root, pathname, await readBody(req)));
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
