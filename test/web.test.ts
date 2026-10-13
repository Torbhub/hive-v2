import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';

const WEB_DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');

// The view reads state only; no pane exists, but keep tmux pointed at a
// throwaway socket anyway.
process.env.HIVE_TMUX_SOCKET = `hive-test-${process.pid}`;

vi.mock('../src/hub.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/hub.js')>();
  return { ...orig, wake: vi.fn(orig.wake), hubTask: vi.fn(orig.hubTask), startProject: vi.fn(orig.startProject) };
});

import { hubTask, startProject, wake } from '../src/hub.js';
import { createServer } from '../web/server.js';
import { appendTaskEvent, hubPath, writeJson } from '../src/state.js';

let server: Server;
let base: string;

async function listenOn(root: string): Promise<{ s: Server; url: string }> {
  const s = createServer(root);
  await new Promise<void>((resolve) => {
    s.listen(0, '127.0.0.1', resolve);
  });
  return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}

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

const post = (pathname: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
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

describe('request hardening', () => {
  it('rejects a non-JSON content type with 415', async () => {
    const r = await fetch(`${base}/api/wake`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{"project":"demo"}',
    });
    expect(r.status).toBe(415);
    expect((await r.json()).ok).toBe(false);
  });

  it('rejects a cross-site Origin and Sec-Fetch-Site, allows same-host', async () => {
    const body = { project: 'demo', choice: '1', fingerprint: 'x' };
    const cross = await post('/api/answer', body, { origin: 'https://evil.example' });
    expect(cross.status).toBe(403);
    const fetchSite = await post('/api/answer', body, { 'sec-fetch-site': 'cross-site' });
    expect(fetchSite.status).toBe(403);
    const sameHost = await post('/api/answer', body, {
      origin: base,
      'sec-fetch-site': 'same-origin',
    });
    expect(sameHost.status).toBe(400); // the usual no-dialog refusal, not a 403
  });

  it('sends cache-control: no-store on API responses', async () => {
    const r = await fetch(`${base}/api/view`);
    expect(r.headers.get('cache-control')).toBe('no-store');
    const p = await post('/api/answer', { project: 'demo', choice: '1', fingerprint: 'x' });
    expect(p.headers.get('cache-control')).toBe('no-store');
  });

  it('internal errors are generic 500s and never name filesystem paths', async () => {
    const bad = mkdtempSync(path.join(tmpdir(), 'hive-web-bad-'));
    await fs.mkdir(hubPath(bad), { recursive: true });
    await fs.writeFile(hubPath(bad, 'projects.json'), '{"projects": [');
    const { s, url } = await listenOn(bad);
    try {
      const r = await fetch(`${url}/api/wake`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project: 'demo' }),
      });
      expect(r.status).toBe(500);
      const text = await r.text();
      expect(JSON.parse(text)).toEqual({ ok: false, detail: 'internal error' });
      expect(text).not.toContain(bad);
      // The view sanitizes its error line the same way (root is shown by design).
      const view = await (await fetch(`${url}/api/view`)).json();
      expect(view.error).toBe('the status read failed');
      expect(view.error).not.toContain(bad);
    } finally {
      s.close();
    }
  });
});

describe('action serialization', () => {
  it('two wakes for the same project never overlap; different projects run freely', async () => {
    let active = 0;
    let maxActive = 0;
    vi.mocked(wake).mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 120));
      active -= 1;
      return '%1';
    });
    try {
      const [r1, r2] = await Promise.all([
        post('/api/wake', { project: 'demo' }),
        post('/api/wake', { project: 'demo' }),
      ]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect((await r1.json()).pane).toBe('%1');
      expect(maxActive).toBe(1);

      const [r3, r4] = await Promise.all([
        post('/api/wake', { project: 'demo' }),
        post('/api/wake', { project: 'other' }),
      ]);
      expect(r3.status).toBe(200);
      expect(r4.status).toBe(200);
      expect(maxActive).toBe(2);
    } finally {
      vi.mocked(wake).mockRestore();
    }
  });

  it('task then start for the same project run in request order, never overlapped', async () => {
    const order: string[] = [];
    vi.mocked(hubTask).mockImplementation(async (root, project) => {
      await new Promise((r) => setTimeout(r, 120));
      order.push('task');
      return `${project}-7`;
    });
    vi.mocked(startProject).mockImplementation(async () => {
      order.push('start');
      return '%2';
    });
    try {
      const [t, s] = await Promise.all([
        post('/api/task', { project: 'demo', text: 'queued behind nothing' }),
        post('/api/start', { project: 'demo', task: 'demo-7' }),
      ]);
      expect(t.status).toBe(200);
      expect(s.status).toBe(200);
      expect((await s.json()).pane).toBe('%2');
      expect(order).toEqual(['task', 'start']);
    } finally {
      vi.mocked(hubTask).mockRestore();
      vi.mocked(startProject).mockRestore();
    }
  });
});

describe('HIVE_WEB_SECRET gate', () => {
  it('403s every request without the header, allows with it', async () => {
    process.env.HIVE_WEB_SECRET = 's3cret';
    try {
      expect((await fetch(`${base}/api/view`)).status).toBe(403);
      expect((await fetch(`${base}/`)).status).toBe(403);
      expect((await fetch(`${base}/api/view`, { headers: { 'x-hive-auth': 'nope' } })).status).toBe(403);
      const ok = await fetch(`${base}/api/view`, { headers: { 'x-hive-auth': 's3cret' } });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('cache-control')).toBe('no-store');
    } finally {
      delete process.env.HIVE_WEB_SECRET;
    }
  });
});

describe('POST /api/task', () => {
  it('records a task and returns its id', async () => {
    const r = await post('/api/task', { project: 'demo', text: 'write the smoke docs' });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.id).toBe('demo-2');
    const again = await post('/api/task', { project: 'demo', text: 'a second one' });
    expect((await again.json()).id).toBe('demo-3');
  });

  it('unknown project is a clean 400', async () => {
    const r = await post('/api/task', { project: 'nope', text: 'x' });
    expect(r.status).toBe(400);
    expect((await r.json()).detail).toMatch(/unknown project/);
  });

  it('empty or blank text is a 400', async () => {
    expect((await post('/api/task', { project: 'demo', text: '' })).status).toBe(400);
    expect((await post('/api/task', { project: 'demo', text: '   ' })).status).toBe(400);
    expect((await post('/api/task', { project: 'demo' })).status).toBe(400);
  });

  it('text past the cap is a 413', async () => {
    const r = await post('/api/task', { project: 'demo', text: 'x'.repeat(4001) });
    expect(r.status).toBe(413);
  });
});

describe('POST /api/start', () => {
  it('a malformed or missing task id is a clean 400 Refusal, no internals leak', async () => {
    const bad = await post('/api/start', { project: 'demo', task: '../../etc' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).detail).toMatch(/task id/);
    const missing = await post('/api/start', { project: 'demo', task: 'demo-99' });
    expect(missing.status).toBe(400);
    expect((await missing.json()).detail).toMatch(/no task file/);
  });
});
