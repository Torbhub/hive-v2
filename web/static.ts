import type http from 'node:http';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './http-error.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const STATIC_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; connect-src 'self' http://127.0.0.1:7685; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
};

// Compiled this file lives in dist/web/, in tests in web/ — find web/dist from either.
function staticDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const up of ['..', '../..']) {
    const candidate = path.resolve(here, up, 'web', 'dist');
    if (existsSync(candidate)) return candidate;
  }
  return path.resolve(here, '../../web/dist');
}

export async function serveStatic(res: http.ServerResponse, pathname: string): Promise<void> {
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
