import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';

const WEB_DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');

// The view reads state only; no pane exists, but keep tmux pointed at a
// throwaway socket anyway.
process.env.HIVE_TMUX_SOCKET = `hive-test-${process.pid}`;

import { createServer } from '../web/server.js';
import { appendTaskEvent, hubPath, writeJson } from '../src/state.js';

let server: Server;
let base: string;

beforeAll(async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hive-web-'));
  const home = path.join(root, 'demo');
  await writeJson(hubPath(root, 'projects.json'), {
    projects: [{ name: 'demo', home, repos: [{ folder: home }] }],
  });
  await writeJson(hubPath(root, 'hub.json'), { name: 'hub' });
  await appendTaskEvent(root, {
    id: 'demo-1', project: 'demo', event: 'asked', at: new Date().toISOString(),
  });
  await appendTaskEvent(root, {
    id: 'demo-1', project: 'demo', event: 'plan', at: new Date().toISOString(),
  });
  server = createServer(root);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

const post = (pathname: string, body: unknown) =>
  fetch(base + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('GET /api/view', () => {
  it('returns the full HubView in one shot', async () => {
    const r = await fetch(`${base}/api/view`);
    expect(r.status).toBe(200);
    const view = await r.json();
    expect(view.hubName).toBe('hub');
    expect(view.projects.map((p: { name: string }) => p.name)).toEqual(['demo']);
    const task = view.tasks.find((t: { id: string }) => t.id === 'demo-1');
    expect(task.state).toBe('plan');
    expect(task.needs_owner).toBe(true);
    expect(view.updatedAt).toBeGreaterThan(0);
    expect(view.error).toBe('');
  });
});

describe('POST action endpoints', () => {
  it('a bogus fingerprint is a clean 400 JSON error, not a crash', async () => {
    const r = await post('/api/answer', { project: 'demo', choice: '1', fingerprint: 'bogus' });
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.detail).toMatch(/no dialog/);
  });

  it('wake on an unknown project is a 400', async () => {
    const r = await post('/api/wake', { project: 'nope' });
    expect(r.status).toBe(400);
    expect((await r.json()).detail).toMatch(/unknown project/);
  });

  it('project names are validated at the API boundary too', async () => {
    const r = await post('/api/continue', { project: '../x' });
    expect(r.status).toBe(400);
    expect((await r.json()).detail).toMatch(/project name is/);
  });

  it('rejects a non-JSON body, a huge body, and a non-object body', async () => {
    expect((await post('/api/wake', 'not json')).status).toBe(400);
    expect((await post('/api/wake', '"demo"')).status).toBe(400);
    const big = await post('/api/wake', { project: 'demo', pad: 'x'.repeat(70 * 1024) });
    expect(big.status).toBe(413);
  });

  it('GET on an action endpoint is a 405', async () => {
    expect((await fetch(`${base}/api/wake`)).status).toBe(405);
  });
});

describe('static', () => {
  it('encoded traversal stays confined and misses', async () => {
    const r = await fetch(`${base}/%2e%2e/%2e%2e/package.json`);
    expect([400, 404]).toContain(r.status);
  });

  it.skipIf(!existsSync(path.join(WEB_DIST, 'index.html')))(
    'serves the built SPA shell at /',
    async () => {
      const r = await fetch(`${base}/`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/html');
      expect(await r.text()).toContain('hive hub');
    },
  );
});
