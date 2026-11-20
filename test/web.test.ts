import { existsSync } from 'node:fs';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';

const WEB_DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');
const COMMAND_DIALOG = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dialog-permission.txt'), 'utf8',
);

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
  return {
    ...orig,
    paneIs: vi.fn(orig.paneIs), paneExists: vi.fn(orig.paneExists), capturePane: vi.fn(orig.capturePane),
    sendLiteral: vi.fn(orig.sendLiteral), sleep: vi.fn(orig.sleep), run: vi.fn(orig.run),
  };
});

import { hubLog, hubTask, startProject, wake } from '../src/hub.js';
import { interruptAgent } from '../src/interrupt.js';
import { killAgent } from '../src/kill.js';
import { createQuestionBatch } from '../src/questions.js';
import { sendOwnerMessage } from '../src/message.js';
import { typeLine } from '../src/spawn.js';
import { capturePane, paneExists, paneIs, run, sendLiteral, sleep } from '../src/tmux.js';
import { createServer } from '../web/server.js';
import { appendTaskEvent, contractDigest, foldTasks, hivePath, hubPath, readProjects, readTaskEvents, Refusal, writeJson } from '../src/state.js';
import { authHeaders, configureSecurity } from './security-fixture.js';
import { taskContract } from './task-contract.js';
import { snapshotNativeMessages } from '../src/native-history.js';

let server: Server;
let base: string;
let root: string;
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  if (!headers.has('authorization')) headers.set('authorization', authHeaders().authorization);
  return originalFetch(input, { ...init, headers });
};

async function listenOn(root: string): Promise<{ s: Server; url: string }> {
  configureSecurity(false);
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
  configureSecurity(false);
  server = createServer(root);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
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

describe('POST /api/task-plan', () => {
  it('persists a validated root contract with its canonical digest', async () => {
    const contract = taskContract(path.join(root, 'demo'), [], 'Return the bounded artifact.');
    const response = await post('/api/task-plan', {
      project: 'demo', task: 'demo-1', note: 'the plan',
      checkpoints: [{ id: 'work', desc: 'bounded work', etaMin: 5 }], contract,
    });
    expect(response.status).toBe(200);
    const task = foldTasks(await readTaskEvents(root)).find((candidate) => candidate.id === 'demo-1')!;
    expect(task.contract).toEqual(contract);
    expect(task.plan_digest).toBe(contractDigest(contract));
  });

  it('refuses an invalid contract without appending it', async () => {
    const contract = { ...taskContract(path.join(root, 'demo'), [], 'Return the bounded artifact.'), acceptance: [] };
    const response = await post('/api/task-plan', {
      project: 'demo', task: 'demo-1', checkpoints: [{ id: 'work', desc: 'bounded work', etaMin: 5 }], contract,
    });
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toMatch(/acceptance/);
  });
});

describe('POST /api/start', () => {
  const realStart = vi.mocked(startProject).getMockImplementation()!;
  const realMessage = vi.mocked(sendOwnerMessage).getMockImplementation()!;
  afterEach(() => {
    vi.mocked(startProject).mockReset().mockImplementation(realStart);
    vi.mocked(sendOwnerMessage).mockReset().mockImplementation(realMessage);
  });

  it('a malformed or missing task id is a clean 400 Refusal, no internals leak', async () => {
    const bad = await post('/api/start', { project: 'demo', task: '../../etc' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).detail).toMatch(/task id/);
    const missing = await post('/api/start', { project: 'demo', task: 'demo-99' });
    expect(missing.status).toBe(400);
    expect((await missing.json()).detail).toMatch(/no task file/);
  });

  it('delivers a registered task to an orchestrator that is already running', async () => {
    vi.mocked(startProject).mockRejectedValueOnce(new Refusal("demo's orchestrator is already running"));
    vi.mocked(sendOwnerMessage).mockResolvedValueOnce({ typed: 'Owner: task' });
    const r = await post('/api/start', { project: 'demo', task: 'demo-1' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, typed: 'Owner: task' });
    expect(startProject).toHaveBeenCalledTimes(1);
    expect(sendOwnerMessage).toHaveBeenCalledWith(
      root, 'demo', undefined,
      `New task demo-1: read ${hubPath(root, 'tasks', 'demo-1.md')} and take it from there.`,
    );
  });

  it('does not turn unrelated start refusals into messages', async () => {
    vi.mocked(startProject).mockRejectedValueOnce(new Refusal('no task file for demo-1'));
    const r = await post('/api/start', { project: 'demo', task: 'demo-1' });
    expect(r.status).toBe(400);
    expect((await r.json()).detail).toMatch(/no task file/);
    expect(sendOwnerMessage).not.toHaveBeenCalled();
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

describe('POST settings with a current dialog', () => {
  it.each([
    { pathname: '/api/mode', change: { mode: 'auto' }, expected: { ok: true, mode: 'auto' } },
    { pathname: '/api/approvals', change: { approvals: 'smart' }, expected: { ok: true, approvals: 'smart' } },
  ])('$pathname persists and answers before responding', async ({ pathname, change, expected }) => {
    const home = path.join(root, 'demo');
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{
        name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 1, pane_started: 'x',
        launch_mode: 'auto', launch_scoped_auto: true,
      }],
    });
    let answered = false;
    vi.mocked(paneExists).mockResolvedValue(true);
    vi.mocked(capturePane).mockImplementation(async () => answered ? '' : COMMAND_DIALOG);
    vi.mocked(sendLiteral).mockClear().mockImplementation(async () => { answered = true; });
    vi.mocked(sleep).mockResolvedValue(undefined);
    vi.mocked(run).mockClear().mockImplementation(async (cmd) => ({
      code: 0, stdout: cmd === 'kimi' ? 'APPROVE current command' : '', stderr: '',
    }));
    try {
      const r = await post(pathname, { project: 'demo', ...change });

      expect(r.status).toBe(200);
      expect(await r.json()).toEqual(expected);
      expect(sendLiteral).toHaveBeenCalledWith('%1', '1');
      expect((await readProjects(root)).projects[0]).toMatchObject(change);
      if ('mode' in change) expect(vi.mocked(run).mock.calls.filter((c) => c[0] === 'kimi')).toEqual([]);
    } finally {
      await writeJson(hivePath(home, 'team.json'), { agents: [] });
      await writeJson(hubPath(root, 'projects.json'), {
        projects: [{ name: 'demo', home, repos: [{ folder: home }] }],
      });
      vi.mocked(paneExists).mockRestore();
      vi.mocked(capturePane).mockRestore();
      vi.mocked(sendLiteral).mockRestore();
      vi.mocked(sleep).mockRestore();
      vi.mocked(run).mockRestore();
    }
  });
});

describe('POST /api/project', () => {
  it('registers a repo folder with mode and approvals, and the view shows it', async () => {
    const home = path.join(root, 'newproj');
    await fs.mkdir(path.join(home, '.git'), { recursive: true });
    const r = await post('/api/project', { name: 'newproj', path: home, mode: 'yolo', approvals: 'safe' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, name: 'newproj', home });
    const view = await (await fetch(`${base}/api/view`)).json();
    const p = view.projects.find((x: { name: string }) => x.name === 'newproj');
    expect(p.home).toBe(home);
    expect(p.mode).toBe('yolo');
    expect(p.approvals).toBe('safe');
  });

  it('accepts a missing path and returns the allocated home', async () => {
    const r = await post('/api/project', { name: 'autoapi' });
    expect(r.status).toBe(200);
    const home = path.join(root, 'autoapi');
    expect(await r.json()).toEqual({ ok: true, name: 'autoapi', home });
    expect((await fs.stat(path.join(home, '.git'))).isDirectory()).toBe(true);
  });

  it('refuses a source together with an explicit path', async () => {
    const r = await post('/api/project', { name: 'badcombo', path: root, source: root });
    expect(r.status).toBe(400);
    expect((await r.json()).detail).toMatch(/source.*path|path.*source/);
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

  it('refuses a relative path and creates missing or plain explicit directories', async () => {
    const relative = await post('/api/project', { name: 'relproj', path: 'some/where' });
    expect(relative.status).toBe(400);
    expect((await relative.json()).detail).toMatch(/must be absolute/);

    const missingHome = path.join(root, 'not-there');
    const missing = await post('/api/project', { name: 'goneproj', path: missingHome });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ ok: true, name: 'goneproj', home: missingHome });
    expect((await fs.stat(path.join(missingHome, '.git'))).isDirectory()).toBe(true);

    const plain = path.join(root, 'plainproj');
    await fs.mkdir(plain, { recursive: true });
    await fs.writeFile(path.join(plain, 'keep.txt'), 'keep\n');
    const initialized = await post('/api/project', { name: 'plainproj', path: plain });
    expect(initialized.status).toBe(200);
    expect(await initialized.json()).toEqual({ ok: true, name: 'plainproj', home: plain });
    expect((await fs.stat(path.join(plain, '.git'))).isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(plain, 'keep.txt'), 'utf8')).toBe('keep\n');
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

  const openBatch = (agent = 'builder') => createQuestionBatch(questionRoot, { project: 'demo', agent }, {
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

  it('bounds the view to 50 open batches without truncating agent wait status', async () => {
    const home = path.join(questionRoot, 'demo');
    await writeJson(hivePath(home, 'team.json'), {
      agents: Array.from({ length: 55 }, (_, i) => ({ name: `worker-${i}` })),
    });
    for (let i = 0; i < 55; i++) await openBatch(`worker-${i}`);
    const view = await (await fetch(`${questionBase}/api/view`)).json();
    expect(view.questions).toHaveLength(50);
    expect(view.questionsTotal).toBe(55);
    expect(view.projects[0].agents[54]).toMatchObject({ name: 'worker-54', operator_question: true, operator_waiting: true });
  });

  it('approves a root delta through the existing question endpoint without an executor', async () => {
    const home = path.join(questionRoot, 'demo');
    await fs.mkdir(home, { recursive: true });
    const contract = taskContract(home, ['src'], 'Return the bounded artifact.');
    const at = new Date().toISOString();
    const planDigest = contractDigest(contract);
    await appendTaskEvent(questionRoot, { id: 'demo-1', project: 'demo', event: 'asked', at });
    await appendTaskEvent(questionRoot, {
      id: 'demo-1', project: 'demo', event: 'plan', at, contract, plan_digest: planDigest,
      checkpoints: [{ id: 'work', desc: 'bounded work', etaMin: 5 }],
    });
    await appendTaskEvent(questionRoot, { id: 'demo-1', project: 'demo', event: 'answered', at, plan_digest: planDigest });
    const next = { ...contract, action_scope: ['command:docs-mutation'] };
    const { createRootDeltaQuestion } = await import('../src/questions.js');
    const batch = await createRootDeltaQuestion(questionRoot, 'demo-1', next, 'Approve the docs mutation.');
    const response = await questionPost('/api/questions/answer', {
      id: batch.id, answers: [{ question: 'q1', choice: 'c2' }],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      batch: { status: 'answered', answers: [{ decision: { action: 'scope_delta', grant: { executionAuthority: 'none' } } }] },
    });
    const task = foldTasks(await readTaskEvents(questionRoot))[0];
    expect(task).toMatchObject({ plan_digest: contractDigest(next), lease_epoch: 2 });
    expect(task.operations).toBeUndefined();
  });
});

describe('root-delta question read authorization', () => {
  async function deltaView(projectReadWithRevokedTask: boolean) {
    const questionRoot = mkdtempSync(path.join(tmpdir(), 'hive-web-delta-acl-'));
    const home = path.join(questionRoot, 'demo');
    await fs.mkdir(home, { recursive: true });
    await writeJson(hubPath(questionRoot, 'projects.json'), { projects: [{ name: 'demo', home, repos: [] }] });
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 1, pane_started: 'x' }],
    });
    const contract = taskContract(home, ['src'], 'Return the bounded artifact.');
    const at = new Date().toISOString();
    const planDigest = contractDigest(contract);
    await appendTaskEvent(questionRoot, { id: 'demo-1', project: 'demo', event: 'asked', at });
    await appendTaskEvent(questionRoot, {
      id: 'demo-1', project: 'demo', event: 'plan', at, contract, plan_digest: planDigest,
      checkpoints: [{ id: 'work', desc: 'bounded work', etaMin: 5 }],
    });
    await appendTaskEvent(questionRoot, { id: 'demo-1', project: 'demo', event: 'answered', at, plan_digest: planDigest });
    const next = { ...contract, action_scope: ['command:delta-acl'] };
    const { createRootDeltaQuestion } = await import('../src/questions.js');
    const batch = await createRootDeltaQuestion(questionRoot, 'demo-1', next, 'Review the delta.');
    const { registryItems, startTestRegistry } = await import('./security-fixture.js');
    const items = registryItems();
    if (projectReadWithRevokedTask) {
      items.push({
        pk: 'ACL#demo#*#*', sk: 'PRINCIPAL#user:alice', project: 'demo', principal: 'user:alice',
        grantId: 'project-read', actions: ['read'], aclEpoch: 1, revokedAt: null,
      });
      items.push({ pk: 'REVOCATION#ACL#demo#demo-1#*', sk: 'PRINCIPAL#user:alice' });
    }
    const { broker, registry } = await startTestRegistry(items);
    configureSecurity();
    const server = createServer(questionRoot, registry);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/view`);
      return { view: await response.json(), batch, home };
    } finally {
      server.close();
      broker.close();
      configureSecurity(false);
    }
  }

  it('shows the root delta to a principal with task-only read access', async () => {
    const { view, batch, home } = await deltaView(false);
    expect(view.questionsTotal).toBe(1);
    expect(view.questions).toHaveLength(1);
    expect(view.questions[0].id).toBe(batch.id);
    expect(view.questions[0].rootDelta.nextContract.provenance.repository).toBe(home);
  });

  it('hides the root delta, total, contract, and provenance when project read does not include the root task', async () => {
    const { view, home } = await deltaView(true);
    expect(view.questions).toEqual([]);
    expect(view.questionsTotal).toBe(0);
    expect(JSON.stringify(view)).not.toContain('nextContract');
    expect(JSON.stringify(view)).not.toContain(home);
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

  it('deletes a project named projects without deadlocking its registry chain', async () => {
    const home = path.join(deleteRoot, 'projects');
    await writeJson(hubPath(deleteRoot, 'projects.json'), {
      projects: [{ name: 'projects', home, repos: [{ folder: home }] }],
    });
    await writeJson(hivePath(home, 'team.json'), { agents: [] });
    const r = await deletePost('/api/project-delete', { project: 'projects' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, name: 'projects' });
  });

  it('rechecks launch safety after waiting for the project action chain', async () => {
    const { writePendingPane } = await import('../src/state.js');
    let markStarted!: () => void;
    let releaseStart!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseStart = resolve; });
    vi.mocked(startProject).mockImplementation(async () => {
      await writePendingPane(deleteRoot, 'demo', { pane: '%9', kind: 'start', launch_mode: 'ask', launch_scoped_auto: false, at: '2026-10-27T00:00:00Z' });
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

  it('keeps delete queued after start times out until the launch actually settles', async () => {
    const { ACTION_TIMEOUT_MS } = await import('../src/view.js');
    const { readProjects, writePendingPane } = await import('../src/state.js');
    let markStarted!: () => void;
    let releaseStart!: (pane: string) => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const release = new Promise<string>((resolve) => { releaseStart = resolve; });
    vi.mocked(startProject).mockImplementation(async () => {
      await writePendingPane(deleteRoot, 'demo', { pane: '%9', kind: 'start', launch_mode: 'ask', launch_scoped_auto: false, at: '2026-10-27T00:00:00Z' });
      markStarted();
      return release;
    });
    vi.useFakeTimers();
    try {
      const starting = deletePost('/api/start', { project: 'demo', task: 'demo-1' });
      await started;
      const deleting = deletePost('/api/project-delete', { project: 'demo' });
      let deleteSettled = false;
      void deleting.then(() => { deleteSettled = true; });
      await vi.advanceTimersByTimeAsync(ACTION_TIMEOUT_MS);
      expect((await starting).status).toBe(500);
      vi.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));
      expect(deleteSettled).toBe(false);
      expect((await readProjects(deleteRoot)).projects.map((p) => p.name)).toEqual(['demo']);

      releaseStart('%9');
      const deleteResponse = await deleting;
      expect(deleteResponse.status).toBe(400);
      expect((await deleteResponse.json()).detail).toMatch(/launch is pending/);
    } finally {
      releaseStart('%9');
      vi.useRealTimers();
      vi.mocked(startProject).mockRestore();
    }
  });
});

describe('POST /api/task-receipt', () => {
  async function receiptFixture() {
    const receiptRoot = mkdtempSync(path.join(tmpdir(), 'hive-web-receipt-'));
    const home = path.join(receiptRoot, 'demo');
    await writeJson(hubPath(receiptRoot, 'projects.json'), {
      projects: [{ name: 'demo', home, repos: [{ folder: home }] }],
    });
    await appendTaskEvent(receiptRoot, { id: 'demo-1', project: 'demo', event: 'asked', at: new Date().toISOString() });
    await writeJson(hivePath(home, 'team.json'), {
      agents: [
        { name: 'builder', worktree: home, task: 'demo-1' },
        { name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 1, pane_started: 'x' },
      ],
    });
    await hubLog(receiptRoot, 'demo-1', 'plan', 'the plan', [{ id: 'a', desc: 'write it', etaMin: 5 }]);
    const { foldTasks, readTaskEvents } = await import('../src/state.js');
    const planned = foldTasks(await readTaskEvents(receiptRoot))[0];
    const { recordTaskEvidence } = await import('../src/taskgate.js');
    const evidence = await recordTaskEvidence(receiptRoot, 'demo-1', {
      actor: 'agent:builder', plan_digest: planned.plan_digest!, epoch: planned.lease_epoch!, outcome: 'passed',
      artifact: { diff: 'src/a.ts' }, content: { check: 'unit', status: 'passed' },
    });
    const { agentHeaders, configureSecurity, registryItems, startTestRegistry } = await import('./security-fixture.js');
    const items = registryItems();
    const { broker, registry } = await startTestRegistry(items);
    configureSecurity();
    const receiptServer = createServer(receiptRoot, registry);
    await new Promise<void>((resolve) => receiptServer.listen(0, '127.0.0.1', resolve));
    const receiptBase = `http://127.0.0.1:${(receiptServer.address() as AddressInfo).port}`;
    const events = await readTaskEvents(receiptRoot);
    const task = foldTasks(events)[0];
    return {
      receiptRoot, receiptBase, receiptServer, broker, registry, items, task, events, evidence,
      headers: agentHeaders(),
    };
  }

  function receiptBody(
    task: { plan_digest?: string | null; lease_epoch?: number },
    evidence: { artifact_digest: string; evidence_hash: string },
  ) {
    return {
      project: 'demo', task: 'demo-1', actor: 'agent:mallory', plan_digest: task.plan_digest,
      epoch: task.lease_epoch, sequence: 1, artifact_digest: evidence.artifact_digest, counters: {},
      external_ids: {}, evidence_hashes: [evidence.evidence_hash], state: 'reconciling',
    };
  }

  function send(url: string, body: unknown, headers: Record<string, string>) {
    return fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
  }

  it('binds the receipt to the authenticated actor and rejects duplicate sequences without mutation', async () => {
    const fixture = await receiptFixture();
    try {
      const response = await send(
        fixture.receiptBase + '/api/task-receipt', receiptBody(fixture.task, fixture.evidence), fixture.headers,
      );
      expect(response.status).toBe(200);
      const { readTaskEvents } = await import('../src/state.js');
      const events = await readTaskEvents(fixture.receiptRoot);
      expect(events.at(-1)).toMatchObject({ event: 'receipt', receipt: { actor: 'agent:builder', sequence: 1 } });
      const duplicate = await send(
        fixture.receiptBase + '/api/task-receipt', receiptBody(fixture.task, fixture.evidence), fixture.headers,
      );
      expect(duplicate.status).toBe(400);
      expect(await readTaskEvents(fixture.receiptRoot)).toEqual(events);
    } finally {
      fixture.receiptServer.close();
      fixture.broker.close();
    }
  });

  it('requires admin authority for trusted reconciliation after cancellation', async () => {
    const fixture = await receiptFixture();
    try {
      const first = await send(
        fixture.receiptBase + '/api/task-receipt', receiptBody(fixture.task, fixture.evidence), fixture.headers,
      );
      expect(first.status).toBe(200);
      await hubLog(fixture.receiptRoot, 'demo-1', 'cancelled', 'owner revoked the lease');
      const { readTaskEvents } = await import('../src/state.js');
      const before = await readTaskEvents(fixture.receiptRoot);
      const grant = fixture.items.find((row) => row.pk === 'ACL#demo#demo-1#*' && row.sk === 'PRINCIPAL#user:alice')!;
      grant.actions = ['read', 'write'];
      const { authHeaders } = await import('./security-fixture.js');
      const response = await send(fixture.receiptBase + '/api/task-receipt', {
        ...receiptBody(fixture.task, fixture.evidence), sequence: 2, state: 'blocked',
        actor: 'user:alice', blocker_kind: 'execution', unblock_condition: 'retry later',
      }, authHeaders());
      expect(response.status).toBe(404);
      expect(await readTaskEvents(fixture.receiptRoot)).toEqual(before);
    } finally {
      fixture.receiptServer.close();
      fixture.broker.close();
    }
  });

  it.each(['/api/progress', '/api/task-receipt'])('rejects a cross-project legacy %s without mutation', async (pathname) => {
    const fixture = await receiptFixture();
    const legacy = await listenOn(fixture.receiptRoot);
    try {
      const body = pathname === '/api/progress'
        ? { project: 'other', task: 'demo-1', checkpoint: 'a', status: 'ok' }
        : { ...receiptBody(fixture.task, fixture.evidence), project: 'other' };
      const response = await send(legacy.url + pathname, body, fixture.headers);
      expect(response.status).toBe(400);
      const { readTaskEvents } = await import('../src/state.js');
      expect(await readTaskEvents(fixture.receiptRoot)).toEqual(fixture.events);
    } finally {
      legacy.s.close();
      fixture.receiptServer.close();
      fixture.broker.close();
    }
  });

  it.each(['/api/task-receipt', '/api/progress', '/api/task-resolve'])(
    'revalidates a revoked actor under the hub lock before %s mutates', async (pathname) => {
      const fixture = await receiptFixture();
      try {
        const credential = fixture.items.find((row) => row.pk === 'AGENT#builder' && row.sk.startsWith('CRED#'))!;
        const original = fixture.registry.currentAccount.bind(fixture.registry);
        let agentAuthentications = 0;
        fixture.registry.currentAccount = async (subject, assertion) => {
          if (assertion.startsWith('hva1.') && ++agentAuthentications === 2) credential.revokedAt = 1;
          return original(subject, assertion);
        };
        const body = pathname === '/api/task-receipt' ? receiptBody(fixture.task, fixture.evidence)
          : pathname === '/api/progress'
            ? { project: 'demo', task: 'demo-1', checkpoint: 'a', status: 'ok' }
            : { project: 'demo', task: 'demo-1', action: 'cancel' };
        const response = await send(fixture.receiptBase + pathname, body, fixture.headers);
        expect(response.status).toBe(pathname === '/api/task-resolve' ? 404 : 401);
        const { readTaskEvents } = await import('../src/state.js');
        expect(await readTaskEvents(fixture.receiptRoot)).toEqual(fixture.events);
      } finally {
        fixture.receiptServer.close();
        fixture.broker.close();
      }
    },
  );

  it('rejects agent owner verdicts without pane input, answered state, or audit', async () => {
    const fixture = await receiptFixture();
    try {
      const batch = await createQuestionBatch(fixture.receiptRoot, { project: 'demo', agent: 'builder' }, {
        context: 'Choose one option.',
        questions: [{
          question: 'Continue?', context: 'Owner review.', priority: 1, recommended: 'c1',
          choices: [{ label: 'Yes', description: 'Continue.' }, { label: 'No', description: 'Stop.' }],
        }],
      });
      const { readTaskEvents } = await import('../src/state.js');
      const { readQuestionBatch } = await import('../src/questions.js');
      const before = await readTaskEvents(fixture.receiptRoot);
      vi.mocked(typeLine).mockClear();
      const bodies = [
        ['/api/plan-answer', { project: 'demo', task: 'demo-1', verdict: 'approve' }],
        ['/api/task-resolve', { project: 'demo', task: 'demo-1', action: 'cancel' }],
        ['/api/questions/answer', { id: batch.id, answers: [{ question: 'q1', choice: 'c1' }] }],
        ['/api/answer', { project: 'demo', agent: 'builder', choice: '1', fingerprint: 'stale' }],
        ['/api/task-acceptance', {
          project: 'demo', task: 'demo-1', plan_digest: fixture.task.plan_digest, epoch: 1, acceptance_id: 'extra',
        }],
      ] as const;
      for (const [pathname, body] of bodies) {
        const response = await send(fixture.receiptBase + pathname, body, fixture.headers);
        expect(response.status).toBe(404);
      }
      expect(await readTaskEvents(fixture.receiptRoot)).toEqual(before);
      expect((await readQuestionBatch(fixture.receiptRoot, batch.id)).status).toBe('open');
      expect(vi.mocked(typeLine)).not.toHaveBeenCalled();
    } finally {
      fixture.receiptServer.close();
      fixture.broker.close();
    }
  });

  it('allows an authorized human plan answer with the same digest and epoch', async () => {
    const fixture = await receiptFixture();
    try {
      vi.mocked(capturePane).mockResolvedValue('');
      vi.mocked(paneExists).mockResolvedValue(true);
      const tmux = await import('../src/tmux.js');
      vi.spyOn(tmux, 'paneIdentity').mockResolvedValue({ pid: 1, started: 'x' });
      vi.mocked(typeLine).mockClear().mockResolvedValue(undefined);
      const { authHeaders } = await import('./security-fixture.js');
      const response = await send(fixture.receiptBase + '/api/plan-answer', {
        project: 'demo', task: 'demo-1', verdict: 'approve',
      }, authHeaders());
      expect(response.status).toBe(200);
      const { readTaskEvents, readDecisions } = await import('../src/state.js');
      const task = foldTasks(await readTaskEvents(fixture.receiptRoot))[0];
      expect(task).toMatchObject({
        state: 'answered', plan_approved: true, plan_digest: fixture.task.plan_digest,
        lease_epoch: fixture.task.lease_epoch,
      });
      expect((await readDecisions(fixture.receiptRoot))[0].summary).toBe('approved the plan');
    } finally {
      fixture.receiptServer.close();
      fixture.broker.close();
    }
  });

  it('keeps public evidence untrusted and binds outcome actors to the authenticated principal', async () => {
    const fixture = await receiptFixture();
    try {
      await appendTaskEvent(fixture.receiptRoot, {
        id: 'demo-1', project: 'demo', event: 'answered', at: new Date().toISOString(),
        plan_digest: fixture.task.plan_digest,
      });
      const evidenceResponse = await send(fixture.receiptBase + '/api/task-evidence', {
        project: 'demo', task: 'demo-1', actor: 'agent:mallory', plan_digest: fixture.task.plan_digest,
        epoch: fixture.task.lease_epoch, outcome: 'passed', artifact: { diff: 'fake' }, content: { check: 'fake' },
      }, fixture.headers);
      expect(evidenceResponse.status).toBe(200);
      const { readTaskEvents } = await import('../src/state.js');
      const storedEvidence = (await readTaskEvents(fixture.receiptRoot)).at(-1)?.evidence;
      expect(storedEvidence).toMatchObject({ actor: 'agent:builder' });
      expect(storedEvidence?.verification).toBeUndefined();
      const receiptResponse = await send(fixture.receiptBase + '/api/task-receipt', receiptBody(
        fixture.task, storedEvidence!,
      ), fixture.headers);
      expect(receiptResponse.status).toBe(200);
      const { evaluateTaskPredicate } = await import('../src/hub.js');
      await expect(evaluateTaskPredicate(fixture.receiptRoot, 'demo-1', 'task_receipt', {
        plan_digest: fixture.task.plan_digest!, artifact_digest: storedEvidence!.artifact_digest,
      })).resolves.toBe(false);

      const { readTeam } = await import('../src/state.js');
      const home = path.join(fixture.receiptRoot, 'demo');
      const team = await readTeam(home);
      await writeJson(hivePath(home, 'team.json'), {
        agents: team.agents.map((agent) => ({ ...agent, closed_at: new Date().toISOString() })),
      });
      const outcomeResponse = await send(fixture.receiptBase + '/api/task-outcome', {
        project: 'demo', task: 'demo-1', actor: 'agent:mallory', plan_digest: fixture.task.plan_digest,
        epoch: fixture.task.lease_epoch, outcome: 'failed', reason: 'verification failed',
      }, fixture.headers);
      expect(outcomeResponse.status).toBe(200);
      expect((await readTaskEvents(fixture.receiptRoot)).at(-1)?.outcome).toMatchObject({
        actor: 'agent:builder', reason: 'verification failed',
      });
    } finally {
      fixture.receiptServer.close();
      fixture.broker.close();
    }
  });

  it('rejects cross-project, oversized, and sensitive evidence without persistence', async () => {
    const fixture = await receiptFixture();
    try {
      const baseBody = {
        task: 'demo-1', plan_digest: fixture.task.plan_digest, epoch: fixture.task.lease_epoch,
        outcome: 'passed', artifact: { diff: 'fake' }, content: { check: 'fake' },
      };
      const cross = await send(fixture.receiptBase + '/api/task-evidence', {
        ...baseBody, project: 'other',
      }, fixture.headers);
      expect(cross.status).toBe(404);
      const oversized = await send(fixture.receiptBase + '/api/task-evidence', {
        ...baseBody, project: 'demo', content: 'x'.repeat(70 * 1024),
      }, fixture.headers);
      expect(oversized.status).toBe(413);
      const sensitive = await send(fixture.receiptBase + '/api/task-evidence', {
        ...baseBody, project: 'demo', content: 'Error: fake diff\n at secret.js:1:1',
      }, fixture.headers);
      expect(sensitive.status).toBe(400);
      const { readTaskEvents } = await import('../src/state.js');
      expect(await readTaskEvents(fixture.receiptRoot)).toEqual(fixture.events);
    } finally {
      fixture.receiptServer.close();
      fixture.broker.close();
    }
  });

  it('rejects revoked writes and agent human acceptance without mutation', async () => {
    const fixture = await receiptFixture();
    try {
      const credential = fixture.items.find((row) => row.pk === 'AGENT#builder' && row.sk.startsWith('CRED#'))!;
      const original = fixture.registry.currentAccount.bind(fixture.registry);
      let agentAuthentications = 0;
      fixture.registry.currentAccount = async (subject, assertion) => {
        if (assertion.startsWith('hva1.') && ++agentAuthentications === 2) credential.revokedAt = 1;
        return original(subject, assertion);
      };
      const response = await send(fixture.receiptBase + '/api/task-evidence', {
        project: 'demo', task: 'demo-1', plan_digest: fixture.task.plan_digest, epoch: fixture.task.lease_epoch,
        outcome: 'passed', artifact: { diff: 'fake' }, content: { check: 'fake' },
      }, fixture.headers);
      expect(response.status).toBe(401);
      credential.revokedAt = null;
      const acceptance = await send(fixture.receiptBase + '/api/task-acceptance', {
        project: 'demo', task: 'demo-1', plan_digest: fixture.task.plan_digest, epoch: 1, acceptance_id: 'extra',
      }, fixture.headers);
      expect(acceptance.status).toBe(404);
      const { readTaskEvents } = await import('../src/state.js');
      expect(await readTaskEvents(fixture.receiptRoot)).toEqual(fixture.events);
    } finally {
      fixture.receiptServer.close();
      fixture.broker.close();
    }
  });
});


describe('work-tree read authorization', () => {
  async function treeFixture() {
    const treeRoot = mkdtempSync(path.join(tmpdir(), 'hive-web-tree-'));
    const home = path.join(treeRoot, 'demo');
    const at = new Date().toISOString();
    const rootContract = { ...taskContract(home, ['src'], 'Return the artifact.'), required_children: ['demo-2'] };
    const planDigest = contractDigest(rootContract);
    await writeJson(hubPath(treeRoot, 'projects.json'), { projects: [{ name: 'demo', home, repos: [] }] });
    await writeJson(hubPath(treeRoot, 'hub.json'), { name: 'hub' });
    await appendTaskEvent(treeRoot, { id: 'demo-1', project: 'demo', event: 'asked', at });
    await appendTaskEvent(treeRoot, {
      id: 'demo-1', project: 'demo', event: 'plan', at, contract: rootContract, plan_digest: planDigest,
      checkpoints: [{ id: 'work', desc: 'bounded work', etaMin: 5 }],
    });
    await appendTaskEvent(treeRoot, { id: 'demo-2', project: 'demo', event: 'asked', at });
    const admission = {
      task: 'demo-1', project: 'demo', agent: 'builder', parent_id: 'demo-1', plan_digest: planDigest,
      root_lease_epoch: 1, lease_id: 'lease-1', lease_epoch: 1 as const, lease_revoked: false,
      output_claim: 'Return the artifact.', acceptance_ids: ['diff'], provenance: rootContract.provenance,
      provenance_digest: 'proof', write_scope: ['src'], adapter: 'tmux' as const,
      lineage_id: 'lineage-1', attempts_used: 2, status: 'running' as const,
    };
    await appendTaskEvent(treeRoot, { id: 'demo-1', project: 'demo', event: 'admission', at, admission });
    await appendTaskEvent(treeRoot, {
      id: 'demo-1', project: 'demo', event: 'admission', at,
      admission: {
        ...admission, agent: 'native-child', lease_id: 'lease-2', adapter: 'native' as const,
        parent_lease_id: 'lease-1', depth: 2, lineage_id: 'lineage-2', attempts_used: 1, status: 'admitted' as const,
      },
    });
    await appendTaskEvent(treeRoot, {
      id: 'demo-1', project: 'demo', event: 'operation', at,
      operation: {
        operation_id: 'github-check-1', idempotency_key: 'key-1', kind: 'github_check' as const,
        actor: 'adapter:github_check', plan_digest: planDigest, epoch: 1, repository_fingerprint: 'repo',
        commit: 'a'.repeat(40), branch: 'check', status: 'blocked_external' as const, updated_at: at,
        repository: 'octo/hive', external_id: 'external-check', external_run_id: 'external-run-1',
        artifact_digest: 'b'.repeat(64), resume_condition: 'success', watcher_id: 'watcher-1',
      },
    });
    await writeJson(hivePath(home, 'team.json'), {
      agents: [
        { name: 'demo-orchestrator', orchestrator: true, pane: '%1', session_id: 'orchestrator-session' },
        {
          name: 'builder', task: 'demo-1', pane: '%7', session_id: 'parent-session', lease_id: 'lease-1',
          admission_status: 'running', parent_id: 'demo-1', plan_digest: planDigest,
        },
      ],
    });
    const branch = {
      schemaVersion: 1 as const, id: '7ca3c50b-8304-45f0-a925-f41d10a14cf2', kind: 'child' as const,
      purpose: 'Review the stored result', parentSessionId: 'parent-session', childSessionId: 'child-session',
      workspaceId: 'secret-workspace', cwd: '/secret-native',
      scope: { project: 'demo', agent: 'builder', task: 'demo-1' },
      parentSnapshot: snapshotNativeMessages([]),
      childSnapshot: snapshotNativeMessages([]),
      status: 'active' as const, createdAt: at, updatedAt: at, leaseId: 'lease-2', error: 'native blocker',
    };
    await writeJson(hivePath(home, 'branches', `${branch.id}.json`), branch);
    return { treeRoot, home, branch };
  }

  it('projects root, tmux, and native descendants without writes or raw run data', async () => {
    const { treeRoot, home, branch } = await treeFixture();
    const listening = await listenOn(treeRoot);
    const files = [hubPath(treeRoot, 'tasks.jsonl'), hivePath(home, 'team.json'), hivePath(home, 'branches', `${branch.id}.json`)];
    const before = await Promise.all(files.map((file) => fs.readFile(file, 'utf8')));
    try {
      const response = await fetch(`${listening.url}/api/view`);
      expect(response.status).toBe(200);
      const view = await response.json();
      const nodes = view.workTree.nodes;
      expect(nodes.map((node: { kind: string }) => node.kind)).toEqual(['task', 'task', 'tmux', 'native']);
      const native = nodes.find((node: { kind: string }) => node.kind === 'native');
      expect(native).toMatchObject({ parentId: 'tmux:demo:lease-1', recordId: branch.id });
      expect(native).not.toHaveProperty('externalId');
      expect(native.details).toEqual(expect.arrayContaining([
        { label: 'parent session', value: 'parent-session' }, { label: 'child session', value: 'child-session' },
      ]));
      expect(nodes[0].externalId).toBe('external-run-1');
      expect(JSON.stringify(view.workTree)).not.toContain('/secret-native');
      expect(JSON.stringify(view.workTree)).not.toContain('secret-workspace');
      expect(await Promise.all(files.map((file) => fs.readFile(file, 'utf8')))).toEqual(before);
    } finally {
      listening.s.close();
    }
  });

  it('removes a revoked parent and every external ID while keeping an authorized child as a root', async () => {
    const { treeRoot } = await treeFixture();
    const { registryItems, startTestRegistry } = await import('./security-fixture.js');
    const items = registryItems();
    items.push({
      pk: 'ACL#demo#*#*', sk: 'PRINCIPAL#user:alice', project: 'demo', principal: 'user:alice',
      grantId: 'project-read', actions: ['read'], aclEpoch: 1, revokedAt: null,
    });
    items.push({ pk: 'REVOCATION#ACL#demo#demo-1#*', sk: 'PRINCIPAL#user:alice' });
    const { broker, registry } = await startTestRegistry(items);
    configureSecurity();
    const treeServer = createServer(treeRoot, registry);
    await new Promise<void>((resolve) => treeServer.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(treeServer.address() as AddressInfo).port}/api/view`);
      const view = await response.json();
      expect(view.workTree.nodes).toHaveLength(1);
      expect(view.workTree.nodes[0]).toMatchObject({ id: 'task:demo:demo-2', parentId: null });
      expect(view.workTree.nodes[0]).not.toHaveProperty('externalId');
      expect(view.workTree.truncated).toBe(true);
      expect(JSON.stringify(view.workTree)).not.toContain('external-run-1');
      expect(JSON.stringify(view.workTree)).not.toContain('external-check');
      expect(JSON.stringify(view.workTree)).not.toContain('/secret-native');
    } finally {
      treeServer.close();
      broker.close();
      configureSecurity(false);
    }
  });

  it('uses generic blockers when a required child and its descendants are revoked', async () => {
    const { treeRoot, home, branch } = await treeFixture();
    const team = JSON.parse(await fs.readFile(hivePath(home, 'team.json'), 'utf8'));
    await writeJson(hivePath(home, 'team.json'), {
      agents: [...team.agents, {
        name: 'child-writer', task: 'demo-2', pane: '%99', session_id: 'child-secret-session',
        external_operation_id: 'child-external-secret',
      }],
    });
    const childBranchId = '8ca3c50b-8304-45f0-a925-f41d10a14cf2';
    await writeJson(hivePath(home, 'branches', `${childBranchId}.json`), {
      ...branch, id: childBranchId, scope: { ...branch.scope, task: 'demo-2' }, childSessionId: 'child-secret-native',
    });
    const { registryItems, startTestRegistry } = await import('./security-fixture.js');
    const items = registryItems();
    items.push({
      pk: 'ACL#demo#*#*', sk: 'PRINCIPAL#user:alice', project: 'demo', principal: 'user:alice',
      grantId: 'project-read', actions: ['read'], aclEpoch: 1, revokedAt: null,
    });
    items.push({ pk: 'REVOCATION#ACL#demo#demo-2#*', sk: 'PRINCIPAL#user:alice' });
    const { broker, registry } = await startTestRegistry(items);
    configureSecurity();
    const treeServer = createServer(treeRoot, registry);
    await new Promise<void>((resolve) => treeServer.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(treeServer.address() as AddressInfo).port}/api/view`);
      const view = await response.json();
      const parent = view.workTree.nodes.find((node: { id: string }) => node.id === 'task:demo:demo-1');
      expect(parent).toBeDefined();
      expect(parent.doneBlockers).toContain('required work is unresolved');
      expect(JSON.stringify(parent.doneBlockers)).not.toContain('demo-2');
      const serialized = JSON.stringify(view.workTree);
      for (const secret of [
        'child-writer', 'child-secret-session', 'child-external-secret', childBranchId, 'child-secret-native',
      ]) expect(serialized).not.toContain(secret);
    } finally {
      treeServer.close();
      broker.close();
      configureSecurity(false);
    }
  });
});
