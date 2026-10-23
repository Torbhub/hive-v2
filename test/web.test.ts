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

vi.mock('../src/message.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/message.js')>();
  return { ...orig, sendOwnerMessage: vi.fn(orig.sendOwnerMessage) };
});

vi.mock('../src/spawn.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/spawn.js')>();
  return { ...orig, typeLine: vi.fn(orig.typeLine) };
});

vi.mock('../src/tmux.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/tmux.js')>();
  return { ...orig, paneIs: vi.fn(orig.paneIs), capturePane: vi.fn(orig.capturePane) };
});

import { hubTask, startProject, wake } from '../src/hub.js';
import { sendOwnerMessage } from '../src/message.js';
import { typeLine } from '../src/spawn.js';
import { capturePane, paneIs } from '../src/tmux.js';
import { createServer } from '../web/server.js';
import { appendTaskEvent, hivePath, hubPath, writeJson } from '../src/state.js';

let server: Server;
let base: string;
let root: string;

async function listenOn(root: string): Promise<{ s: Server; url: string }> {
  const s = createServer(root);
  await new Promise<void>((resolve) => {
    s.listen(0, '127.0.0.1', resolve);
  });
  return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'hive-web-'));
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
    expect((await cross.json()).detail).toContain('origin host evil.example != host');
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

describe('/hive prefix (nexus embed)', () => {
  it('/hive/api/view answers identically to /api/view', async () => {
    const [plain, prefixed] = await Promise.all([
      fetch(`${base}/api/view`),
      fetch(`${base}/hive/api/view`),
    ]);
    expect(prefixed.status).toBe(200);
    // updatedAt is read-time; everything else must be identical.
    const strip = (v: { updatedAt: number }) => ({ ...v, updatedAt: 0 });
    expect(strip(await prefixed.json())).toEqual(strip(await plain.json()));
  });

  it('/hive/api/* POSTs route like their unprefixed twins', async () => {
    const r = await post('/hive/api/wake', { project: 'nope' });
    expect(r.status).toBe(400);
    expect((await r.json()).detail).toMatch(/unknown project/);
  });

  it('a lookalike prefix is not stripped', async () => {
    // /hivex/... is not the API: a POST there is GET-only static territory.
    expect((await post('/hivex/api/wake', { project: 'demo' })).status).toBe(405);
  });

  it.skipIf(!existsSync(path.join(WEB_DIST, 'index.html')))(
    '/hive/ and /hive both serve the SPA shell',
    async () => {
      for (const p of ['/hive/', '/hive']) {
        const r = await fetch(`${base}${p}`);
        expect(r.status).toBe(200);
        expect(await r.text()).toContain('hive hub');
      }
    },
  );
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

describe('POST /api/stretch-opened', () => {
  it('appends one JSON line per open to the stretch log', async () => {
    const log = path.join(root, 'stretch-opened.jsonl');
    process.env.HIVE_STRETCH_LOG = log;
    try {
      const r = await post('/api/stretch-opened', { short: 'why', pane: 'demo-1' });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true });
      await post('/api/stretch-opened', { short: 'evidence' });
      const lines = (await fs.readFile(log, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0]);
      expect(first.short).toBe('why');
      expect(first.pane).toBe('demo-1');
      expect(typeof first.ts).toBe('number');
      expect(JSON.parse(lines[1]).pane).toBe('');
    } finally {
      delete process.env.HIVE_STRETCH_LOG;
    }
  });

  it('an empty or missing short is a 400, an oversized one a 413', async () => {
    process.env.HIVE_STRETCH_LOG = path.join(root, 'stretch-opened.jsonl');
    try {
      expect((await post('/api/stretch-opened', { short: '  ' })).status).toBe(400);
      expect((await post('/api/stretch-opened', {})).status).toBe(400);
      expect((await post('/api/stretch-opened', { short: 'x'.repeat(201) })).status).toBe(413);
    } finally {
      delete process.env.HIVE_STRETCH_LOG;
    }
  });
});

describe('POST /api/mode', () => {
  it('persists a valid mode and returns it', async () => {
    const r = await post('/api/mode', { project: 'demo', mode: 'yolo' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, mode: 'yolo' });
    const view = await (await fetch(`${base}/api/view`)).json();
    expect(view.projects[0].mode).toBe('yolo');
    const back = await post('/api/mode', { project: 'demo', mode: 'ask' });
    expect((await back.json()).mode).toBe('ask');
  });

  it('a bad mode is a 400, an unknown project is a 400', async () => {
    const badEnum = await post('/api/mode', { project: 'demo', mode: 'chaos' });
    expect(badEnum.status).toBe(400);
    expect((await badEnum.json()).detail).toMatch(/mode is ask\|yolo\|auto/);
    const noProject = await post('/api/mode', { project: 'nope', mode: 'yolo' });
    expect(noProject.status).toBe(400);
    expect((await noProject.json()).detail).toMatch(/unknown project/);
  });
});

describe('POST /api/approvals + decisions in the view', () => {
  it('persists approvals and rejects a bad enum', async () => {
    const r = await post('/api/approvals', { project: 'demo', approvals: 'safe' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, approvals: 'safe' });
    const bad = await post('/api/approvals', { project: 'demo', approvals: 'chaos' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).detail).toMatch(/manual\|safe\|smart/);
    const back = await post('/api/approvals', { project: 'demo', approvals: 'manual' });
    expect(back.status).toBe(200);
  });

  it('GET /api/view carries the latest decisions, newest first', async () => {
    const { appendDecision } = await import('../src/state.js');
    await appendDecision(root, { project: 'demo', by: 'watch', summary: 'auto-approved "Approve once" for: $ ls' });
    const view = await (await fetch(`${base}/api/view`)).json();
    expect(view.decisions.length).toBeGreaterThan(0);
    expect(view.decisions[0].summary).toContain('auto-approved');
    expect(view.decisions[0].by).toBe('watch');
  });
});

describe('POST /api/project', () => {
  it('registers a repo folder with mode and approvals, and the view shows it', async () => {
    const home = path.join(root, 'newproj');
    await fs.mkdir(path.join(home, '.git'), { recursive: true });
    const r = await post('/api/project', { name: 'newproj', path: home, mode: 'yolo', approvals: 'safe' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, name: 'newproj' });
    const view = await (await fetch(`${base}/api/view`)).json();
    const p = view.projects.find((x: { name: string }) => x.name === 'newproj');
    expect(p.home).toBe(home);
    expect(p.mode).toBe('yolo');
    expect(p.approvals).toBe('safe');
  });

  it('a worktree (a .git file, not a directory) registers too, with default mode and approvals', async () => {
    const home = path.join(root, 'wtproj');
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, '.git'), 'gitdir: /elsewhere\n');
    const r = await post('/api/project', { name: 'wtproj', path: home });
    expect(r.status).toBe(200);
    const view = await (await fetch(`${base}/api/view`)).json();
    const p = view.projects.find((x: { name: string }) => x.name === 'wtproj');
    expect(p.mode).toBe('ask');
    expect(p.approvals).toBe('manual');
  });

  it('a duplicate name is a 400', async () => {
    const r = await post('/api/project', { name: 'newproj', path: path.join(root, 'newproj') });
    expect(r.status).toBe(400);
    expect((await r.json()).detail).toMatch(/a project named newproj exists/);
  });

  it('a bad name is a 400, and so is a traversal-style one', async () => {
    for (const name of ['Bad Name', '../x', '1proj', '']) {
      const r = await post('/api/project', { name, path: root });
      expect(r.status).toBe(400);
      expect((await r.json()).detail).toMatch(/project name is/);
    }
  });

  it('a relative path, a missing folder, and a folder without git are all 400s', async () => {
    const relative = await post('/api/project', { name: 'relproj', path: 'some/where' });
    expect(relative.status).toBe(400);
    expect((await relative.json()).detail).toMatch(/must be absolute/);

    const missing = await post('/api/project', { name: 'goneproj', path: path.join(root, 'not-there') });
    expect(missing.status).toBe(400);
    expect((await missing.json()).detail).toMatch(/not a folder/);

    const plain = path.join(root, 'plainproj');
    await fs.mkdir(plain, { recursive: true });
    const noGit = await post('/api/project', { name: 'plainproj', path: plain });
    expect(noGit.status).toBe(400);
    expect((await noGit.json()).detail).toMatch(/not a git repo/);
  });

  it('a bad mode or approvals value is a 400 and writes nothing', async () => {
    const home = path.join(root, 'newproj');
    const badMode = await post('/api/project', { name: 'enumproj', path: home, mode: 'chaos' });
    expect(badMode.status).toBe(400);
    expect((await badMode.json()).detail).toMatch(/mode is ask\|yolo\|auto/);
    const badApprovals = await post('/api/project', { name: 'enumproj', path: home, approvals: 'chaos' });
    expect(badApprovals.status).toBe(400);
    expect((await badApprovals.json()).detail).toMatch(/manual\|safe\|smart/);
    const view = await (await fetch(`${base}/api/view`)).json();
    expect(view.projects.some((x: { name: string }) => x.name === 'enumproj')).toBe(false);
  });

  it('a bogus .git file is not a worktree pointer and is refused', async () => {
    const bogus = path.join(root, 'bogusproj');
    await fs.mkdir(bogus, { recursive: true });
    await fs.writeFile(path.join(bogus, '.git'), 'not a pointer\n');
    const r = await post('/api/project', { name: 'bogusproj', path: bogus });
    expect(r.status).toBe(400);
    expect((await r.json()).detail).toMatch(/not a git repo/);
    const empty = path.join(root, 'emptyproj');
    await fs.mkdir(empty, { recursive: true });
    await fs.writeFile(path.join(empty, '.git'), '');
    expect((await post('/api/project', { name: 'emptyproj', path: empty })).status).toBe(400);
  });
});

describe('POST /api/message', () => {
  beforeAll(async () => {
    // The recorded pane is not on the throwaway socket, so it reads as dead.
    await writeJson(hivePath(path.join(root, 'demo'), 'team.json'), {
      agents: [{
        name: 'demo-orchestrator', orchestrator: true,
        pane: '%999', pane_pid: 424242, pane_started: 'Mon Jan  1 00:00:00 2024',
      }],
    });
  });

  it('empty or blank text is a 400', async () => {
    expect((await post('/api/message', { project: 'demo', text: '' })).status).toBe(400);
    expect((await post('/api/message', { project: 'demo', text: '   ' })).status).toBe(400);
    const j = await (await post('/api/message', { project: 'demo' })).json();
    expect(j.detail).toMatch(/message text is empty/);
  });

  it('text past the cap is a 400', async () => {
    const r = await post('/api/message', { project: 'demo', text: 'x'.repeat(4001) });
    expect(r.status).toBe(400);
    expect((await r.json()).detail).toMatch(/capped at 4000/);
  });

  it('unknown project is a 400', async () => {
    const r = await post('/api/message', { project: 'nope', text: 'hi' });
    expect(r.status).toBe(400);
    expect((await r.json()).detail).toMatch(/unknown project/);
  });

  it('an unknown agent is a 400', async () => {
    const r = await post('/api/message', { project: 'demo', agent: 'ghost', text: 'hi' });
    expect(r.status).toBe(400);
    expect((await r.json()).detail).toMatch(/no agent named ghost/);
  });

  it('a dead pane is a clean refusal, not a crash', async () => {
    const r = await post('/api/message', { project: 'demo', text: 'are you there' });
    expect(r.status).toBe(400);
    expect((await r.json()).detail).toMatch(/pane is gone/);
  });

  it('a control character in the text is a 400 refusal', async () => {
    const r = await post('/api/message', { project: 'demo', text: 'bad\u001btext' });
    expect(r.status).toBe(400);
    expect((await r.json()).detail).toMatch(/control characters/);
  });

  it('a good send returns the typed line', async () => {
    vi.mocked(sendOwnerMessage).mockImplementation(async () => ({ typed: 'Owner: hello there' }));
    try {
      const r = await post('/api/message', { project: 'demo', text: 'hello there' });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true, typed: 'Owner: hello there' });
      expect(vi.mocked(sendOwnerMessage)).toHaveBeenCalledWith(root, 'demo', undefined, 'hello there');
    } finally {
      vi.mocked(sendOwnerMessage).mockRestore();
    }
  });

  it('the real send folds newlines into one typed line and logs the decision', async () => {
    vi.mocked(paneIs).mockResolvedValue(true);
    vi.mocked(capturePane).mockResolvedValue('demo-orchestrator is idle at its prompt');
    vi.mocked(typeLine).mockResolvedValue(undefined);
    try {
      const r = await post('/api/message', { project: 'demo', text: 'line1\nline2' });
      expect(r.status).toBe(200);
      expect((await r.json()).typed).toBe('Owner: line1 line2');
      expect(vi.mocked(typeLine)).toHaveBeenCalledWith(
        '%999', 'Owner: line1 line2', { pid: 424242, started: 'Mon Jan  1 00:00:00 2024' },
      );
      const log = (await fs.readFile(hubPath(root, 'decisions.jsonl'), 'utf8')).trim().split('\n');
      const last = JSON.parse(log[log.length - 1]);
      expect(last.by).toBe('owner');
      expect(last.summary).toContain('line1 line2');
    } finally {
      vi.mocked(paneIs).mockRestore();
      vi.mocked(capturePane).mockRestore();
      vi.mocked(typeLine).mockRestore();
    }
  });
});
