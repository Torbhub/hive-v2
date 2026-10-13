import http from 'node:http';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { answerDialog, continueProject, wake } from '../src/hub.js';
import { checkName } from '../src/names.js';
import {
  ACTION_TIMEOUT_MS, ANSWER_TIMEOUT_MS, buildView, lastLine, withTimeout,
} from '../src/view.js';

const BODY_CAP = 64 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

class HttpError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: http.ServerResponse, code: number, value: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
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

function projectName(body: Record<string, unknown>): string {
  return checkName('project', String(body.project ?? ''));
}

function agentRefOf(body: Record<string, unknown>): string | undefined {
  if (body.agent === undefined || body.agent === null || body.agent === '') return undefined;
  const ref = String(body.agent);
  checkName('agent', ref.split('@')[0]);
  return ref;
}

async function handlePost(root: string, pathname: string, body: Record<string, unknown>): Promise<unknown> {
  if (pathname === '/api/wake') {
    const pane = await withTimeout(wake(root, projectName(body)), ACTION_TIMEOUT_MS, 'wake');
    return { ok: true, pane };
  }
  if (pathname === '/api/continue') {
    const pane = await withTimeout(continueProject(root, projectName(body)), ACTION_TIMEOUT_MS, 'continue');
    return { ok: true, pane };
  }
  if (pathname === '/api/answer') {
    const r = await withTimeout(
      answerDialog(
        root, projectName(body), agentRefOf(body),
        String(body.choice ?? ''), String(body.fingerprint ?? ''),
      ),
      ANSWER_TIMEOUT_MS,
      'answer',
    );
    return { ok: true, option: r.option, choice: r.choice, session: r.session, dialog_gone: r.dialog_gone };
  }
  throw new HttpError(404, `unknown endpoint: ${pathname}`);
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
  let file = path.resolve(dist, rel);
  if (file !== dist && !file.startsWith(dist + path.sep)) throw new HttpError(400, 'bad path');
  let data: Buffer;
  try {
    data = await fs.readFile(file);
  } catch {
    // Single-page app: extensionless paths fall back to the shell.
    if (path.extname(file) === '') {
      file = path.join(dist, 'index.html');
      data = await fs.readFile(file).catch(() => {
        throw new HttpError(404, 'not found');
      });
    } else {
      throw new HttpError(404, 'not found');
    }
  }
  res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream' });
  res.end(data);
}

export function createServer(root: string): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/api/view' && req.method === 'GET') {
        sendJson(res, 200, await buildView(root));
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'POST') throw new HttpError(405, `${url.pathname} is POST only`);
        sendJson(res, 200, await handlePost(root, url.pathname, await readBody(req)));
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'GET only');
      await serveStatic(res, url.pathname);
    })().catch((e: unknown) => {
      // Action failures (bad fingerprint, unknown project, busy pane) are
      // client-visible conditions, not server faults: 400 with the last line.
      const code = e instanceof HttpError ? e.code : 400;
      sendJson(res, code, { ok: false, detail: lastLine(e) });
    });
  });
}

export function listen(root: string, port: number): Promise<http.Server> {
  const server = createServer(root);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
