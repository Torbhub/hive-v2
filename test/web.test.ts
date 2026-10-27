import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

vi.mock('../src/interrupt.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/interrupt.js')>();
  return { ...orig, interruptAgent: vi.fn(orig.interruptAgent) };
});

vi.mock('../src/kill.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/kill.js')>();
  return { ...orig, killAgent: vi.fn(orig.killAgent) };
});

vi.mock('../src/spawn.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/spawn.js')>();
  return { ...orig, typeLine: vi.fn(orig.typeLine) };
});

vi.mock('../src/tmux.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/tmux.js')>();
  return { ...orig, paneIs: vi.fn(orig.paneIs), capturePane: vi.fn(orig.capturePane) };
});

import { hubLog, hubTask, startProject, wake } from '../src/hub.js';
import { interruptAgent } from '../src/interrupt.js';
import { killAgent } from '../src/kill.js';
import { createQuestionBatch } from '../src/questions.js';
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

  it('GET /api/view carries the latest kept decisions, newest first', async () => {
    const { appendDecision } = await import('../src/state.js');
    // Tier-1 auto-approvals and "Approve once" clicks are noise: the feed drops them.
    await appendDecision(root, { project: 'demo', by: 'watch', summary: 'auto-approved "Approve once" for: $ ls' });
    await appendDecision(root, { project: 'demo', by: 'owner', summary: 'approved the plan' });
    await appendDecision(root, { project: 'demo', by: 'owner', summary: 'answered "Approve once" for: $ rm x' });
    await appendDecision(root, { project: 'demo', by: 'watch', summary: 'marked fixer wedged: frozen pane, restarting it' });
    const view = await (await fetch(`${base}/api/view`)).json();
    const summaries = view.decisions.map((d: { summary: string }) => d.summary);
    expect(summaries).toEqual([
      'marked fixer wedged: frozen pane, restarting it',
      'approved the plan',
    ]);
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

describe('POST /api/task-resolve', () => {
  beforeAll(async () => {
    await appendTaskEvent(root, { id: 'demo-8', project: 'demo', event: 'asked', at: new Date().toISOString() });
    await appendTaskEvent(root, {
      id: 'demo-8', project: 'demo', event: 'blocked', at: new Date().toISOString(), note: 'no API key',
    });
    await appendTaskEvent(root, { id: 'demo-9', project: 'demo', event: 'asked', at: new Date().toISOString() });
    // demo-9 lives the full cycle before its rebrief: approved plan, progress, then blocked.
    await appendTaskEvent(root, {
      id: 'demo-9', project: 'demo', event: 'plan', at: new Date().toISOString(),
      checkpoints: [{ id: 'a', desc: 'write it', etaMin: 5 }],
    });
    await appendTaskEvent(root, {
      id: 'demo-9', project: 'demo', event: 'answered', at: new Date().toISOString(), note: 'plan approved by owner',
    });
    await appendTaskEvent(root, {
      id: 'demo-9', project: 'demo', event: 'progress', at: new Date().toISOString(), checkpoint: 'a', status: 'started',
    });
    await appendTaskEvent(root, {
      id: 'demo-9', project: 'demo', event: 'blocked', at: new Date().toISOString(), note: 'which schema?',
    });
  });

  it('cancel moves a blocked task to cancelled and logs the decision', async () => {
    const r = await post('/api/task-resolve', { project: 'demo', task: 'demo-8', action: 'cancel' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    const view = await (await fetch(`${base}/api/view`)).json();
    expect(view.tasks.find((t: { id: string }) => t.id === 'demo-8').state).toBe('cancelled');
    const log = (await fs.readFile(hubPath(root, 'decisions.jsonl'), 'utf8')).trim().split('\n');
    const last = JSON.parse(log[log.length - 1]);
    expect(last).toMatchObject({ by: 'owner', task: 'demo-8' });
    expect(last.summary).toContain('cancelled demo-8');
  });

  it('a closed task refuses with a 400', async () => {
    const r = await post('/api/task-resolve', { project: 'demo', task: 'demo-8', action: 'cancel' });
    expect(r.status).toBe(400);
    expect((await r.json()).detail).toMatch(/already cancelled/);
  });

  it('rebrief without a note is a 400; with a note the task goes back to asked', async () => {
    // The blocked demo-9 carries an approved plan and a progress trail.
    const before = await (await fetch(`${base}/api/view`)).json();
    const b9 = before.tasks.find((x: { id: string }) => x.id === 'demo-9');
    expect(b9.state).toBe('blocked');
    expect(b9.plan_approved).toBe(true);
    expect(b9.progress.a.status).toBe('started');
    const bare = await post('/api/task-resolve', { project: 'demo', task: 'demo-9', action: 'rebrief' });
    expect(bare.status).toBe(400);
    expect((await bare.json()).detail).toMatch(/needs a note/);
    const r = await post('/api/task-resolve', {
      project: 'demo', task: 'demo-9', action: 'rebrief', note: 'use postgres, per the brief',
    });
    expect(r.status).toBe(200);
    const view = await (await fetch(`${base}/api/view`)).json();
    const t = view.tasks.find((x: { id: string }) => x.id === 'demo-9');
    expect(t.state).toBe('asked');
    expect(t.last_note).toBe('use postgres, per the brief');
    expect(t.needs_owner).toBe(false);
    // The old plan's approval, trail, and progress clock must not carry over.
    expect(t.plan_approved).toBe(false);
    expect(t.checkpoints).toEqual([]);
    expect(t.progress).toEqual({});
    expect(t.last_progress_at).toBeNull();
    // The composed gate: with the approval cleared, handed refuses end-to-end.
    await expect(hubLog(root, 'demo-9', 'handed')).rejects.toThrow(/no approved plan/);
  });

  it('an unknown task, a bad action, and a cross-site call are refused', async () => {
    const missing = await post('/api/task-resolve', { project: 'demo', task: 'demo-99', action: 'cancel' });
    expect(missing.status).toBe(400);
    expect((await missing.json()).detail).toMatch(/unknown task/);
    const badAction = await post('/api/task-resolve', { project: 'demo', task: 'demo-9', action: 'kill' });
    expect(badAction.status).toBe(400);
    expect((await badAction.json()).detail).toMatch(/cancel\|rebrief/);
    const cross = await post('/api/task-resolve',
      { project: 'demo', task: 'demo-9', action: 'cancel' }, { origin: 'https://evil.example' });
    expect(cross.status).toBe(403);
  });

  it('a control character in the note is a 400 refusal, same as a message', async () => {
    const r = await post('/api/task-resolve', { project: 'demo', task: 'demo-9', action: 'rebrief', note: 'bad\u001bnote' });
    expect(r.status).toBe(400);
    expect((await r.json()).detail).toMatch(/control characters/);
  });
});

describe('POST /api/progress', () => {
  beforeAll(async () => {
    await appendTaskEvent(root, { id: 'demo-10', project: 'demo', event: 'asked', at: new Date().toISOString() });
    await appendTaskEvent(root, {
      id: 'demo-10', project: 'demo', event: 'plan', at: new Date().toISOString(),
      checkpoints: [{ id: 'a', desc: 'write it', etaMin: 5 }, { id: 'b', desc: 'ship it', etaMin: 10 }],
    });
  });

  it('records a progress event the fold can read back', async () => {
    const r = await post('/api/progress', { project: 'demo', task: 'demo-10', checkpoint: 'a', status: 'started' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    const ok = await post('/api/progress', { project: 'demo', task: 'demo-10', checkpoint: 'a', status: 'ok' });
    expect(ok.status).toBe(200);
    const view = await (await fetch(`${base}/api/view`)).json();
    const t = view.tasks.find((x: { id: string }) => x.id === 'demo-10');
    expect(t.progress.a.status).toBe('ok');
    expect(t.last_progress_at).toBeTruthy();
  });

  it('a bad status, an unknown checkpoint, and a skip without a note are 400s', async () => {
    const badStatus = await post('/api/progress', { project: 'demo', task: 'demo-10', checkpoint: 'a', status: 'meh' });
    expect(badStatus.status).toBe(400);
    expect((await badStatus.json()).detail).toMatch(/started\|ok\|fail\|skip/);
    const badCp = await post('/api/progress', { project: 'demo', task: 'demo-10', checkpoint: 'z', status: 'ok' });
    expect(badCp.status).toBe(400);
    expect((await badCp.json()).detail).toMatch(/no checkpoint z/);
    const bareSkip = await post('/api/progress', { project: 'demo', task: 'demo-10', checkpoint: 'b', status: 'skip' });
    expect(bareSkip.status).toBe(400);
    expect((await bareSkip.json()).detail).toMatch(/saying why/);
  });

  it('an unknown task and missing fields are 400s', async () => {
    const missing = await post('/api/progress', { project: 'demo', task: 'demo-99', checkpoint: 'a', status: 'ok' });
    expect(missing.status).toBe(400);
    expect((await missing.json()).detail).toMatch(/unknown task/);
    expect((await post('/api/progress', { project: 'demo', status: 'ok' })).status).toBe(400);
  });
});

describe('POST /api/interrupt', () => {
  // The spy wraps the real function, so refusal tests below reach it too;
  // each test starts from a clean call history.
  beforeEach(() => {
    vi.mocked(interruptAgent).mockClear();
  });

  it('an unknown project, a bad agent name, and a dead pane are 400s', async () => {
    const noProject = await post('/api/interrupt', { project: 'nope' });
    expect(noProject.status).toBe(400);
    expect((await noProject.json()).detail).toMatch(/unknown project/);
    expect((await post('/api/interrupt', { project: 'demo', agent: 'bad name' })).status).toBe(400);
    // The recorded pane %999 is not on the throwaway socket, so it reads as dead.
    const dead = await post('/api/interrupt', { project: 'demo' });
    expect(dead.status).toBe(400);
    expect((await dead.json()).detail).toMatch(/no live pane/);
  });

  it('a cross-site request is a 403', async () => {
    const r = await post('/api/interrupt', { project: 'demo' }, { 'sec-fetch-site': 'cross-site' });
    expect(r.status).toBe(403);
  });

  it('success answers the target, and interrupts serialize per project', async () => {
    let active = 0;
    let maxActive = 0;
    vi.mocked(interruptAgent).mockImplementation(async (_root, project) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 120));
      active -= 1;
      return { target: `${project}-orchestrator`, pane: '%1' };
    });
    try {
      const [r1, r2] = await Promise.all([
        post('/api/interrupt', { project: 'demo' }),
        post('/api/interrupt', { project: 'demo', agent: 'builder' }),
      ]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(await r1.json()).toEqual({ ok: true, target: 'demo-orchestrator', pane: '%1' });
      expect(vi.mocked(interruptAgent).mock.calls).toEqual([
        [root, 'demo', undefined],
        [root, 'demo', 'builder'],
      ]);
      expect(maxActive).toBe(1);
    } finally {
      vi.mocked(interruptAgent).mockRestore();
    }
  });
});

describe('POST /api/kill', () => {
  beforeEach(() => {
    vi.mocked(killAgent).mockClear();
  });

  it('an unknown project and a bad agent name are 400s', async () => {
    const noProject = await post('/api/kill', { project: 'nope' });
    expect(noProject.status).toBe(400);
    expect((await noProject.json()).detail).toMatch(/unknown project/);
    expect((await post('/api/kill', { project: 'demo', agent: 'bad name' })).status).toBe(400);
  });

  it('success answers the killed list and passes the agent ref through', async () => {
    vi.mocked(killAgent).mockImplementation(async (_root, project, ref) => ({
      target: ref ?? `${project}-orchestrator`,
      killed: ref ? [ref] : ['builder', `${project}-orchestrator`],
      summary: ref ? `killed ${ref}` : `killed ${project}-orchestrator + 1 agent`,
    }));
    try {
      const r = await post('/api/kill', { project: 'demo' });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({
        ok: true, target: 'demo-orchestrator', killed: ['builder', 'demo-orchestrator'],
        summary: 'killed demo-orchestrator + 1 agent',
      });
      expect(vi.mocked(killAgent).mock.calls).toEqual([[root, 'demo', undefined]]);
    } finally {
      vi.mocked(killAgent).mockRestore();
    }
  });
});

describe('operator question endpoints', () => {
  let questionRoot: string;
  let questionServer: Server;
  let questionBase: string;

  beforeEach(async () => {
    questionRoot = mkdtempSync(path.join(tmpdir(), 'hive-web-questions-'));
    const home = path.join(questionRoot, 'demo');
    await writeJson(hubPath(questionRoot, 'projects.json'), {
      projects: [{ name: 'demo', home, repos: [{ folder: home }] }],
    });
    await writeJson(hubPath(questionRoot, 'hub.json'), { name: 'hub' });
    const listening = await listenOn(questionRoot);
    questionServer = listening.s;
    questionBase = listening.url;
  });

  afterEach(() => {
    questionServer.close();
  });

  const questionPost = (pathname: string, body: unknown) => fetch(questionBase + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const openBatch = () => createQuestionBatch(questionRoot, { project: 'demo', agent: 'builder' }, {
    context: 'Choose the launch setup.',
    questions: [{
      question: 'Which database should we use?',
      context: 'The hub keeps project state.',
      priority: 1,
      choices: [
        { label: 'Postgres', description: 'Use the existing database.' },
        { label: 'SQLite', description: 'Keep state on this box.' },
      ],
      recommended: 'c1',
    }, {
      question: 'When should we launch?',
      context: 'The deploy window starts soon.',
      priority: 2,
      choices: [
        { label: 'Now', description: 'Use the next deploy.' },
        { label: 'Later', description: 'Wait for another review.' },
      ],
      recommended: 'c2',
    }],
  });

  it('answers without a project and returns only open batches in the view', async () => {
    const batch = await openBatch();
    const before = await (await fetch(`${questionBase}/api/view`)).json();
    expect(before.questions).toEqual([batch]);

    const answers = [
      { question: 'q1', choice: 'c1' },
      { question: 'q2', choice: 'other', text: 'Next week' },
    ];
    const r = await questionPost('/api/questions/answer', { id: batch.id, answers });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({
      ok: true,
      batch: { id: batch.id, status: 'answered', answers },
    });
    const after = await (await fetch(`${questionBase}/api/view`)).json();
    expect(after.questions).toEqual([]);
  });

  it('cancels without a project and refuses a second terminal transition', async () => {
    const batch = await openBatch();
    const r = await questionPost('/api/questions/cancel', { id: batch.id });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, batch: { id: batch.id, status: 'cancelled' } });
    const after = await (await fetch(`${questionBase}/api/view`)).json();
    expect(after.questions).toEqual([]);

    const again = await questionPost('/api/questions/cancel', { id: batch.id });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ ok: false, detail: expect.stringMatching(/already cancelled/) });
  });

  it('returns clean 400s for invalid answers and leaves the batch open', async () => {
    const batch = await openBatch();
    const invalid = await questionPost('/api/questions/answer', {
      id: batch.id,
      answers: [{ question: 'q1', choice: 'nope' }, { question: 'q2', choice: 'c2' }],
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ ok: false, detail: expect.stringMatching(/q1 offers/) });
    const blankOther = await questionPost('/api/questions/answer', {
      id: batch.id,
      answers: [{ question: 'q1', choice: 'c1' }, { question: 'q2', choice: 'other', text: '  ' }],
    });
    expect(blankOther.status).toBe(400);
    const view = await (await fetch(`${questionBase}/api/view`)).json();
    expect(view.questions).toEqual([batch]);
  });

  it('allows one terminal transition and turns the race loser into a 400', async () => {
    const batch = await openBatch();
    const answers = [{ question: 'q1', choice: 'c1' }, { question: 'q2', choice: 'c2' }];
    const responses = await Promise.all([
      questionPost('/api/questions/answer', { id: batch.id, answers }),
      questionPost('/api/questions/cancel', { id: batch.id }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 400]);
    const loser = responses.find((r) => r.status === 400)!;
    expect(await loser.json()).toMatchObject({ ok: false, detail: expect.stringMatching(/already answered|already cancelled/) });
  });

  it('a question-only read failure is labeled questions, not tasks', async () => {
    const batch = await openBatch();
    await fs.writeFile(hubPath(questionRoot, 'questions', `${batch.id}.json`), '{broken');
    const view = await (await fetch(`${questionBase}/api/view`)).json();
    expect(view.error).toBe('the questions read failed');
  });

  it('accepts twenty full-length Other answers past the old 64KiB body cap', async () => {
    const batch = await createQuestionBatch(questionRoot, { project: 'demo', agent: 'builder' }, {
      context: 'A large batch.',
      questions: Array.from({ length: 20 }, (_, i) => ({
        question: `Question ${i + 1}?`, context: 'Background.', priority: i + 1, recommended: 'c1',
        choices: [{ label: 'A', description: 'First.' }, { label: 'B', description: 'Second.' }],
      })),
    });
    const answers = batch.questions.map((q) => ({ question: q.id, choice: 'other', text: 'é'.repeat(4000) }));
    const r = await questionPost('/api/questions/answer', { id: batch.id, answers });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, batch: { status: 'answered' } });
  });

  it('bounds the view to 50 open batches and reports the total', async () => {
    for (let i = 0; i < 55; i++) await openBatch();
    const view = await (await fetch(`${questionBase}/api/view`)).json();
    expect(view.questions).toHaveLength(50);
    expect(view.questionsTotal).toBe(55);
  });
});

describe('POST /api/project-delete', () => {
  let deleteRoot: string;
  let deleteServer: Server;
  let deleteBase: string;

  beforeEach(async () => {
    deleteRoot = mkdtempSync(path.join(tmpdir(), 'hive-web-delete-'));
    const home = path.join(deleteRoot, 'demo');
    await writeJson(hubPath(deleteRoot, 'projects.json'), {
      projects: [{ name: 'demo', home, repos: [{ folder: home }] }],
    });
    await writeJson(hivePath(home, 'team.json'), { agents: [] });
    const listening = await listenOn(deleteRoot);
    deleteServer = listening.s;
    deleteBase = listening.url;
  });

  afterEach(() => {
    deleteServer.close();
  });

  const deletePost = (pathname: string, body: unknown) => fetch(deleteBase + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('unregisters an empty project and refuses unknown or invalid names', async () => {
    const r = await deletePost('/api/project-delete', { project: 'demo' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, name: 'demo' });
    const view = await (await fetch(`${deleteBase}/api/view`)).json();
    expect(view.projects).toEqual([]);
    expect(JSON.parse(await fs.readFile(hivePath(path.join(deleteRoot, 'demo'), 'team.json'), 'utf8'))).toEqual({ agents: [] });

    const again = await deletePost('/api/project-delete', { project: 'demo' });
    expect(again.status).toBe(400);
    expect((await again.json()).detail).toMatch(/unknown project/);
    expect((await deletePost('/api/project-delete', { project: '../demo' })).status).toBe(400);
  });

  it('rechecks launch safety after waiting for the project action chain', async () => {
    const { writePendingPane } = await import('../src/state.js');
    let markStarted!: () => void;
    let releaseStart!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseStart = resolve; });
    vi.mocked(startProject).mockImplementation(async () => {
      await writePendingPane(deleteRoot, 'demo', { pane: '%9', kind: 'start', at: '2026-10-27T00:00:00Z' });
      markStarted();
      await release;
      return '%9';
    });
    try {
      const starting = deletePost('/api/start', { project: 'demo', task: 'demo-1' });
      await started;
      const deleting = deletePost('/api/project-delete', { project: 'demo' });
      releaseStart();
      const [startResponse, deleteResponse] = await Promise.all([starting, deleting]);
      expect(startResponse.status).toBe(200);
      expect(deleteResponse.status).toBe(400);
      expect((await deleteResponse.json()).detail).toMatch(/launch is pending/);
      const view = await (await fetch(`${deleteBase}/api/view`)).json();
      expect(view.projects.map((p: { name: string }) => p.name)).toEqual(['demo']);
    } finally {
      releaseStart();
      vi.mocked(startProject).mockRestore();
    }
  });
});
