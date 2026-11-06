import http from 'node:http';
import { registryFromEnv } from '../src/registry.js';
import { authenticateRequest } from '../src/security.js';
import { errorResponse, routeRequest, type RequestContext } from './authorized.js';
import { HttpError } from './http-error.js';

export function createServer(root: string): http.Server {
  const registry = registryFromEnv();
  const server = http.createServer((req, res) => {
    const secret = process.env.HIVE_WEB_SECRET;
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname === '/hive' ? '/'
      : url.pathname.startsWith('/hive/') ? url.pathname.slice('/hive'.length)
      : url.pathname;
    const context: RequestContext = {
      root, registry, req, res, url, pathname,
      authenticate: () => authenticateRequest(req, registry),
    };
    void (async () => {
      if (secret && req.headers['x-hive-auth'] !== secret) {
        throw new HttpError(403, 'missing or wrong x-hive-auth header');
      }
      await routeRequest(context);
    })().catch((error: unknown) => errorResponse(res, error));
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
