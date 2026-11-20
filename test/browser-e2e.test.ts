import { execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import { createHandyServer, HANDY_PORT } from '../src/handy.js';
import type { Server } from 'node:http';
import { launchChrome } from './browser-launcher.js';

vi.mock('../src/compact.js', () => ({ maybeCompact: vi.fn(async () => {}) }));
vi.mock('../src/tmux.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tmux.js')>();
  return { ...actual, paneExists: vi.fn(async () => true) };
});
vi.mock('../src/hub.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/hub.js')>();
  return {
    ...actual,
    answerDialog: vi.fn(async () => ({ option: 'Esc', choice: 'esc', session: 'demo', dialog_gone: true })),
    buildStatus: vi.fn(actual.buildStatus),
    readDialogFor: vi.fn(actual.readDialogFor),
  };
});

import { answerDialog, buildStatus, readDialogFor } from '../src/hub.js';
import { admitTmux } from '../src/admission.js';
import { answerQuestionBatch, createQuestionBatch, listOpenQuestionBatches } from '../src/questions.js';
import { appendTaskEvent, contractDigest, foldTasks, hubPath, readTaskEvents, upsertTeamEntry, writeJson } from '../src/state.js';
import { taskContract } from './task-contract.js';
import { watchCycle } from '../src/watch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'real-browser-fake-engine-token-32';
const TRANSCRIPT = 'real browser fake transcript';
let vite: ViteDevServer;
let bridge: Server;
let browser: ChildProcess;
let profile: string;
let cdp: ChromePage;
let origin: string;
let submissions: string[];
let outcomeRequests: Record<string, unknown>[] = [];

const VIEW = {
  root: '/r', hubName: 'hub', projects: [{
    name: 'demo', home: '/r/demo', repos: [], mode: 'ask', orchestrator: {
      state: 'stopped', question: false, name: 'demo-orchestrator', session_id: 'session_x',
    }, agents: [], open_tasks: 0,
  }],
  tasks: [], dialogs: {}, decisions: [], questions: [], updatedAt: Date.now(), error: '',
};

let deltaRoot: string | null = null;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function dialogWith(text: string) {
  return {
    fingerprint: 'fp', text, kind: 'numbered', cursor: null, esc: true,
    options: [{ n: 1, label: 'Approve once', detail: '', offered: true, saves_rule: false }],
  };
}

async function declaredPushProject() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'hive-browser-delta-'));
  const remote = path.join(root, 'remote.git');
  const home = path.join(root, 'push-home');
  git(root, 'init', '--bare', remote);
  git(root, 'init', '-b', 'main', home);
  git(home, 'config', 'user.email', 'test@example.invalid');
  git(home, 'config', 'user.name', 'Test');
  await fs.writeFile(path.join(home, 'a.txt'), 'base\n');
  git(home, 'add', 'a.txt');
  git(home, 'commit', '-m', 'feat: base');
  const base = git(home, 'rev-parse', 'HEAD');
  git(home, 'remote', 'add', 'origin', remote);
  git(home, 'update-ref', 'refs/remotes/origin/main', base);
  git(home, 'checkout', '-b', 'feat/watch');
  await fs.writeFile(path.join(home, 'a.txt'), 'change\n');
  git(home, 'commit', '-am', 'feat: declared watch push');
  const commit = git(home, 'rev-parse', 'HEAD');
  const output = 'Publish the bounded change and return evidence.';
  const contract = {
    ...taskContract(home, ['a.txt'], output),
    provenance: { repository: home, base_revision: base, artifact_revision: commit },
    action_scope: ['push'],
  };
  const at = new Date().toISOString();
  const planDigest = contractDigest(contract);
  await writeJson(hubPath(root, 'projects.json'), { projects: [{ name: 'demo', home, repos: [], mode: 'auto' }] });
  await appendTaskEvent(root, { id: 'demo-1', project: 'demo', event: 'asked', at });
  await appendTaskEvent(root, {
    id: 'demo-1', project: 'demo', event: 'plan',
    at, contract, plan_digest: planDigest, checkpoints: [{ id: 'publish', desc: 'push the reviewed commit', etaMin: 1 }],
  });
  await appendTaskEvent(root, { id: 'demo-1', project: 'demo', event: 'answered', at, plan_digest: planDigest });
  await admitTmux(root, home, 'demo-1', 'builder', {
    parent_id: 'demo-1', plan_digest: planDigest, output_claim: output,
    acceptance_ids: ['diff'], provenance: contract.provenance, write_scope: ['a.txt'], adapter: 'tmux',
  });
  await upsertTeamEntry(home, {
    name: 'builder', worktree: home, pane: '%2', pane_pid: 22, pane_started: 'b', session_id: 'session_b',
    launch_mode: 'auto', launch_scoped_auto: true,
  });
  const batch = await createQuestionBatch(root, { project: 'demo', agent: `builder@${home}` }, {
    context: 'Publish the reviewed change.',
    questions: [{ priority: 1, decision: { action: 'push', branch: 'feat/watch', commit, reason: 'Reviewed.' } }],
  });
  await answerQuestionBatch(root, batch.id, [{ question: 'q1', choice: 'c2' }]);
  return { root, remote, home, commit, batch };
}

const BRANCH_ID = '7ca3c50b-8304-45f0-a925-f41d10a14cf2';
const REVIEW_DIGEST = 'a'.repeat(64);
const PROMPT_ID = `hive-rejoin-${BRANCH_ID}-${REVIEW_DIGEST.slice(0, 16)}`;
const REJOINED_AT = '2026-11-18T12:02:00.000Z';
const BRANCH_PROMPT = JSON.stringify({
  kind: 'hive.native-branch.reviewed-findings',
  branchId: BRANCH_ID,
  reviewDigest: REVIEW_DIGEST,
  promptId: PROMPT_ID,
  escaped: '<img src=x onerror="window.__branchXss = true">\\n\"quoted\"',
});
const ACTIVE_BRANCH = {
  id: BRANCH_ID,
  kind: 'child',
  status: 'active',
  purpose: 'Review the transport boundary',
  agent: 'builder',
  task: 'demo-1',
  createdAt: '2026-11-18T12:00:00.000Z',
  updatedAt: '2026-11-18T12:01:00.000Z',
  hasResult: true,
  error: 'child transport needs attention',
  findings: [{
    id: 'finding-1',
    answer: 'Return only the reviewed finding.',
    recommendation: 'Use the exact prompt preview.',
    uncertainty: 'No unselected finding is included.',
  }],
};
let branchState: Record<string, unknown> = { ...ACTIVE_BRANCH };
let branchRequests: { url: string; method: string; body?: Record<string, unknown> }[] = [];

function branchSummary() {
  return {
    id: ACTIVE_BRANCH.id,
    status: branchState.status,
    purpose: ACTIVE_BRANCH.purpose,
    agent: ACTIVE_BRANCH.agent,
    task: ACTIVE_BRANCH.task,
    createdAt: ACTIVE_BRANCH.createdAt,
    updatedAt: branchState.updatedAt,
    hasResult: true,
    error: ACTIVE_BRANCH.error,
  };
}

async function chromeExecutable(): Promise<string> {
  const candidates = [
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter((value): value is string => Boolean(value));
  const playwright = path.join(process.env.HOME ?? '', '.cache', 'ms-playwright');
  for (const version of await fs.readdir(playwright).catch(() => [])) {
    candidates.push(path.join(playwright, version, 'chrome-linux64', 'chrome'));
    candidates.push(path.join(playwright, version, 'chrome-linux', 'chrome'));
    candidates.push(path.join(playwright, version, 'headless_shell', 'headless_shell'));
  }
  for (const candidate of candidates) {
    if (await fs.stat(candidate).then((stat) => stat.isFile()).catch(() => false)) return candidate;
  }
  throw new Error('Chrome is required. Set CHROME_BIN to a Chrome executable.');
}

class ChromePage {
  private sequence = 0;
  private pending = new Map<number, { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  private constructor(private socket: WebSocket) {}

  static async open(port: number): Promise<ChromePage> {
    let target: { webSocketDebuggerUrl: string } | undefined;
    const deadline = Date.now() + 15_000;
    while (!target && Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
        if (response.ok) target = await response.json();
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (!target) throw new Error('Chrome DevTools endpoint did not start');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('Chrome WebSocket failed')), { once: true });
    });
    const page = new ChromePage(socket);
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const pending = page.pending.get(message.id);
      if (!pending) return;
      page.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result);
    });
    await page.call('Page.enable');
    await page.call('Runtime.enable');
    return page;
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const label = method === 'Runtime.evaluate' ? `${method}: ${String(params.expression)}` : method;
      this.pending.set(id, { method: label, resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = await this.call('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    }) as { exceptionDetails?: { text: string }; result?: { value?: unknown } };
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result?.value;
  }

  async waitFor(expression: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await this.evaluate(`Boolean(${expression})`)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const body = await this.evaluate('document.body?.innerText');
    const trace = await this.evaluate('JSON.stringify(window.__fetchTrace)');
    throw new Error(`Timed out waiting for ${expression}. Body: ${body}. HTTP: ${trace}`);
  }

  close(): void {
    this.socket.close();
  }
}

beforeAll(async () => {
  submissions = [];
  vite = await createServer({
    configFile: path.join(ROOT, 'vite.config.mjs'),
    logLevel: 'silent',
    plugins: [{
      name: 'fake-hive-api',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/api/view') {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(VIEW));
            return;
          }
          if (req.url?.startsWith('/api/branch')) {
            void (async () => {
              const url = new URL(req.url ?? '/', 'http://fake');
              let body: Record<string, unknown> | undefined;
              if (req.method === 'POST') {
                let raw = '';
                for await (const chunk of req) raw += chunk;
                body = JSON.parse(raw || '{}') as Record<string, unknown>;
              }
              branchRequests.push({ url: req.url!, method: req.method ?? 'GET', ...(body ? { body } : {}) });
              const send = (value: unknown, status = 200) => {
                const raw = JSON.stringify(value);
                res.statusCode = status;
                res.setHeader('content-type', 'application/json');
                res.end(raw);
              };
              if (url.pathname === '/api/branches' && req.method === 'GET') {
                send({ ok: true, branches: [branchSummary()] });
                return;
              }
              if (url.pathname === '/api/branch' && req.method === 'GET') {
                send({ ok: true, branch: branchState });
                return;
              }
              if (url.pathname === '/api/branch-review' && req.method === 'POST') {
                branchState = {
                  ...ACTIVE_BRANCH,
                  review: {
                    digest: REVIEW_DIGEST,
                    findingIds: ['finding-1'],
                    createdAt: ACTIVE_BRANCH.updatedAt,
                    expiresAt: '2026-11-18T12:16:00.000Z',
                    promptId: PROMPT_ID,
                    prompt: BRANCH_PROMPT,
                  },
                };
                send({ ok: true, branch: branchState });
                return;
              }
              if (url.pathname === '/api/branch-rejoin' && req.method === 'POST') {
                if (body?.reviewDigest !== REVIEW_DIGEST) {
                  send({ ok: false, detail: 'review digest mismatch' }, 400);
                  return;
                }
                branchState = {
                  ...branchState,
                  status: 'rejoined',
                  updatedAt: REJOINED_AT,
                  rejoin: {
                    status: 'rejoined', reviewDigest: REVIEW_DIGEST, promptId: PROMPT_ID,
                    nativeMessageId: 'msg_rejoined', rejoinedAt: REJOINED_AT,
                  },
                };
                send({ ok: true, branch: branchState });
                return;
              }
              send({ ok: false, detail: 'not found' }, 404);
            })().catch(next);
            return;
          }
          if (req.url === '/api/task-outcome' && req.method === 'POST') {
            void (async () => {
              let raw = '';
              for await (const chunk of req) raw += chunk;
              const body = JSON.parse(raw) as Record<string, unknown>;
              outcomeRequests.push(body);
              if (body.task === 'bad') {
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: false, detail: 'bad outcome' }));
                return;
              }
              const tree = (VIEW as unknown as { workTree: { nodes: Record<string, unknown>[] } }).workTree;
              const node = tree.nodes.find((candidate) => candidate.task === body.task);
              Object.assign(node!, {
                state: 'done', active: false, terminal: true, done: true, doneEnabled: false, doneBlockers: [],
              });
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({ ok: true }));
            })().catch(next);
            return;
          }
          if (req.url === '/api/questions/answer' && req.method === 'POST' && deltaRoot) {
            void (async () => {
              let raw = '';
              for await (const chunk of req) raw += chunk;
              const body = JSON.parse(raw) as { id: string; answers: never };
              const batch = await answerQuestionBatch(deltaRoot!, body.id, body.answers);
              const task = foldTasks(await readTaskEvents(deltaRoot!)).find((candidate) => candidate.id === 'demo-1')!;
              Object.assign(VIEW, { questions: [] });
              const tree = (VIEW as unknown as { workTree: { nodes: Record<string, unknown>[] } }).workTree;
              const node = tree.nodes.find((candidate) => candidate.task === task.id);
              Object.assign(node!, { planDigest: task.plan_digest, epoch: task.lease_epoch });
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({ ok: true, batch }));
            })().catch(next);
            return;
          }
          if (req.url?.startsWith('/api/')) {
            submissions.push(req.url);
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, id: 'demo-1', pane: '%1' }));
            return;
          }
          next();
        });
      },
    }],
    server: { host: '127.0.0.1', port: 0 },
  });
  await vite.listen();
  const address = vite.httpServer!.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
  bridge = createHandyServer({
    origin,
    token: TOKEN,
    check: async () => {},
    transcribe: async () => TRANSCRIPT,
  });
  await new Promise<void>((resolve) => bridge.listen(HANDY_PORT, '127.0.0.1', resolve));

  profile = await fs.mkdtemp(path.join(tmpdir(), 'hive-chrome-e2e-'));
  const launched = await launchChrome(await chromeExecutable(), profile);
  browser = launched.browser;
  cdp = await ChromePage.open(launched.activePort);
  await cdp.call('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__trackStops = 0;
      window.__fetchTrace = [];
      const originalFetch = window.fetch;
      window.fetch = async (...args) => {
        try {
          const response = await originalFetch(...args);
          window.__fetchTrace.push([String(args[0]), response.status]);
          return response;
        } catch (error) {
          window.__fetchTrace.push([String(args[0]), error.message]);
          throw error;
        }
      };
      Object.defineProperty(navigator, 'mediaDevices', { value: {
        getUserMedia: async () => ({ getTracks: () => [{ stop: () => { window.__trackStops += 1; } }] })
      }});
      window.MediaRecorder = class {
        state = 'inactive';
        mimeType = 'audio/webm';
        start() { this.state = 'recording'; }
        stop() {
          this.state = 'inactive';
          this.ondataavailable?.({ data: new Blob([new Uint8Array(32)]) });
          this.onstop?.();
        }
      };
      window.AudioContext = class {
        async decodeAudioData() { return { duration: 1 }; }
        async close() {}
      };
      window.OfflineAudioContext = class {
        destination = {};
        createBufferSource() { return { connect() {}, start() {}, buffer: null }; }
        async startRendering() { return { getChannelData: () => new Float32Array(16000) }; }
      };
    `,
  });
  await cdp.call('Page.navigate', { url: origin });
  await cdp.waitFor(`document.querySelector('input[aria-label="new task for demo"]')`);
}, 90_000);

async function stopChrome(): Promise<void> {
  if (!browser || browser.exitCode !== null || browser.signalCode !== null) return;
  const exited = once(browser, 'exit');
  browser.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (browser.exitCode === null && browser.signalCode === null) {
    const killed = once(browser, 'exit');
    browser.kill('SIGKILL');
    await killed;
  }
}

afterAll(async () => {
  cdp?.close();
  await stopChrome();
  await Promise.all([
    vite?.close(),
    new Promise<void>((resolve) => bridge?.close(() => resolve())),
  ]);
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}, 30_000);

async function click(selector: string): Promise<void> {
  const point = await cdp.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('missing pointer target: ${selector}');
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    if (hit !== element && !element.contains(hit)) throw new Error('pointer target is covered: ${selector}');
    return { x, y };
  })()`) as { x: number; y: number };
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await cdp.evaluate(`window.__pointerFocus = {
    tag: document.activeElement?.tagName,
    done: document.activeElement?.getAttribute('data-work-tree-done') ?? null,
  }`);
  await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}

async function clickButton(text: string, includes = false): Promise<void> {
  await cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) =>
      ${includes ? `candidate.textContent.includes(${JSON.stringify(text)})` : `candidate.textContent === ${JSON.stringify(text)}`});
    if (!button) throw new Error('missing button: ${text}');
    button.setAttribute('data-pointer-button', ${JSON.stringify(text)});
  })()`);
  await click(`[data-pointer-button=${JSON.stringify(text)}]`);
  await cdp.evaluate(`document.querySelector('[data-pointer-button]')?.removeAttribute('data-pointer-button')`);
}

async function fill(selector: string, value: string): Promise<void> {
  await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await cdp.call('Input.insertText', { text: value });
}

async function press(key: string): Promise<void> {
  const code = key === ' ' ? 'Space' : key;
  const virtual = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[key];
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtual });
  await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtual });
}

function treeNode(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'task:demo:demo-1', parentId: null, project: 'demo', task: 'demo-1', kind: 'task', recordId: 'demo-1',
    adapter: 'root', state: 'running', active: true, terminal: false, done: false, doneEnabled: false,
    doneBlockers: ['github has no passing registered evidence'], planDigest: 'c'.repeat(64), epoch: 1,
    scope: ['src'], details: [], ...overrides,
  };
}

function installTree(nodes: Record<string, unknown>[]): void {
  Object.assign(VIEW, { workTree: { nodes, truncated: false }, questions: [] });
}

async function captureViewport(width: number, height: number, label: string): Promise<void> {
  await cdp.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await cdp.evaluate('new Promise((resolve) => requestAnimationFrame(() => resolve(true)))');
  const directory = process.env.HIVE_TEST_ARTIFACTS;
  if (!directory) return;
  await fs.mkdir(directory, { recursive: true });
  const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' }) as { data: string };
  await fs.writeFile(path.join(directory, `${label}-${width}x${height}.png`), Buffer.from(screenshot.data, 'base64'));
}

describe('real Chrome dictation E2E', () => {
  it('uses real loopback HTTP, stops tracks, inserts for review, and never submits', async () => {
    await click('button[aria-label="Start dictation for new task for demo"]');
    await cdp.waitFor(`document.querySelector('input[type="password"]')`);
    await fill('input[type="password"]', TOKEN);
    await clickButton('Connect and dictate');
    await cdp.waitFor(`document.querySelector('[data-dictation-state="recording"]')`);
    await click('button[aria-label="Stop dictation for new task for demo"]');
    await cdp.waitFor(`document.querySelector('[data-dictation-state="success"]')`);
    expect(await cdp.evaluate(`document.querySelector('input[aria-label="new task for demo"]').value`)).toBe(TRANSCRIPT);
    expect(await cdp.evaluate('window.__trackStops')).toBe(1);
    expect(submissions).toEqual([]);

    await click('button[aria-label="Start dictation for new task for demo"]');
    await cdp.waitFor(`document.querySelector('[data-dictation-state="recording"]')`);
    await click('button[aria-label="Cancel dictation for new task for demo"]');
    await cdp.waitFor(`document.querySelector('[data-dictation-state="cancelled"]')`);
    expect(await cdp.evaluate('window.__trackStops')).toBe(2);
    expect(await cdp.evaluate(`document.querySelector('input[aria-label="new task for demo"]').value`)).toBe(TRANSCRIPT);
    expect(submissions).toEqual([]);
  }, 30_000);
});

describe('real Chrome work tree E2E', () => {
  it('shows root, tmux, and native IDs with read-only keyboard and narrow-viewport navigation', async () => {
    installTree([
      treeNode({
        state: 'blocked_external', externalId: 'external-run-1',
        details: [{ label: 'orchestrator', value: 'demo-orchestrator' }, { label: 'pane', value: '%1' }],
      }),
      treeNode({
        id: 'tmux:demo:lease-1', parentId: 'task:demo:demo-1', kind: 'tmux', recordId: 'lease-1', adapter: 'tmux',
        state: 'running', lineageId: 'lineage-1', attempts: 2,
        details: [{ label: 'agent', value: 'builder' }, { label: 'pane', value: '%7' }, { label: 'session', value: 'parent-session' }],
      }),
      treeNode({
        id: 'native:demo:branch-1', parentId: 'tmux:demo:lease-1', kind: 'native', recordId: 'branch-1', adapter: 'native',
        state: 'active', details: [{ label: 'kind', value: 'child' }, { label: 'child session', value: 'child-session' }],
      }),
    ]);
    submissions = [];
    await clickButton('refresh');
    await cdp.waitFor(`document.querySelector('[data-work-tree-node="task:demo:demo-1"]')`);
    for (const text of ['demo-1', 'lease-1', 'branch-1', 'blocked_external · active']) {
      expect(await cdp.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`)).toBe(true);
    }
    await click('[data-work-tree-node="tmux:demo:lease-1"]');
    const tmuxDetails = await cdp.evaluate(`document.querySelector('[data-work-tree-details]').textContent`);
    for (const text of ['%7', 'parent-session', 'lineage-1', 'attempts: 2', 'scope: src']) {
      expect(tmuxDetails).toContain(text);
    }
    await click('[data-work-tree-node="native:demo:branch-1"]');
    expect(await cdp.evaluate(`document.querySelector('[data-work-tree-details]').textContent`)).toContain('child-session');

    await cdp.evaluate(`document.querySelector('[data-work-tree-node="task:demo:demo-1"]').focus()`);
    await press('ArrowDown');
    expect(await cdp.evaluate(`document.querySelector('[data-work-tree-node="tmux:demo:lease-1"]').getAttribute('aria-selected')`)).toBe('true');
    await press('ArrowDown');
    expect(await cdp.evaluate(`document.querySelector('[data-work-tree-node="native:demo:branch-1"]').getAttribute('aria-selected')`)).toBe('true');
    await cdp.evaluate(`document.querySelector('[data-work-tree-node="task:demo:demo-1"]').focus()`);
    expect(await cdp.evaluate(`document.querySelector('[data-work-tree-node="task:demo:demo-1"]').getAttribute('aria-selected')`)).toBe('true');
    await press('End');
    expect(await cdp.evaluate(`document.querySelector('[data-work-tree-node="native:demo:branch-1"]').getAttribute('aria-selected')`)).toBe('true');
    await press('Home');
    expect(await cdp.evaluate(`document.querySelector('[data-work-tree-node="task:demo:demo-1"]').getAttribute('aria-selected')`)).toBe('true');
    await press('ArrowDown');
    await press('Enter');
    expect(await cdp.evaluate(`document.querySelector('[data-work-tree-node="tmux:demo:lease-1"]').getAttribute('aria-selected')`)).toBe('true');
    await press('Home');
    await press(' ');
    expect(await cdp.evaluate(`document.querySelector('[data-work-tree-node="task:demo:demo-1"]').getAttribute('aria-selected')`)).toBe('true');
    await captureViewport(1280, 900, 'PROCESS_TREE_MONITOR-tree-states-desktop');
    await captureViewport(390, 844, 'PROCESS_TREE_MONITOR-tree-states-narrow');
    expect(await cdp.evaluate('document.documentElement.scrollWidth <= 390')).toBe(true);
    await captureViewport(1280, 900, 'PROCESS_TREE_MONITOR-tree-states-desktop-restored');
    expect(submissions).toEqual([]);
  }, 30_000);

  it('distinguishes active waits, evidence outcomes, done, and non-done terminal states', async () => {
    installTree([
      treeNode({ state: 'closing_external' }),
      treeNode({ id: 'task:demo:fixed', task: 'fixed', recordId: 'fixed', state: 'already_fixed', active: false, terminal: true, evidenceOutcome: 'passed' }),
      treeNode({ id: 'task:demo:duplicate', task: 'duplicate', recordId: 'duplicate', state: 'duplicate', active: false, terminal: true, evidenceOutcome: 'passed' }),
      treeNode({ id: 'task:demo:noop', task: 'noop', recordId: 'noop', state: 'no_op', active: false, terminal: true, evidenceOutcome: 'passed' }),
      treeNode({ id: 'task:demo:failed', task: 'failed', recordId: 'failed', state: 'failed', active: false, terminal: true }),
      treeNode({ id: 'task:demo:superseded', task: 'superseded', recordId: 'superseded', state: 'superseded', active: false, terminal: true }),
      treeNode({ id: 'task:demo:unknown', task: 'unknown', recordId: 'unknown', state: 'unknown', active: false, terminal: true }),
      treeNode({ id: 'task:demo:done', task: 'done', recordId: 'done', state: 'done', active: false, terminal: true, done: true }),
    ]);
    await clickButton('refresh');
    await cdp.waitFor(`document.body.innerText.includes('closing_external · active')`);
    const body = await cdp.evaluate('document.body.innerText');
    for (const text of [
      'already_fixed · evidence: passed', 'duplicate · evidence: passed', 'no_op · evidence: passed',
      'failed · not done', 'superseded · not done', 'unknown · not done',
    ]) expect(body).toContain(text);
    expect(body).not.toContain('done · not done');
  }, 30_000);

  it('disables Done for missing evidence, unresolved children and writers, and unsupported extra acceptance', async () => {
    const cases = [
      ['demo-1', ['github has no passing registered evidence']],
      ['child-wait', ['required work is unresolved']],
      ['writer-wait', ['required work is unresolved']],
      ['extra-wait', ['Extra acceptance human-review needs a human. Required registered passes still apply.']],
    ];
    installTree(cases.map(([id, blockers]) => treeNode({ id: `task:demo:${id}`, task: id, recordId: id, doneBlockers: blockers })));
    submissions = [];
    for (const [id, blockers] of cases) {
      await clickButton('refresh');
      await click(`[data-work-tree-node="task:demo:${id}"]`);
      expect(await cdp.evaluate(`document.querySelector('[data-work-tree-done="${id}"]').disabled`)).toBe(true);
      for (const blocker of blockers) {
        expect(await cdp.evaluate(`document.querySelector('[data-work-tree-details]').textContent.includes(${JSON.stringify(blocker)})`)).toBe(true);
      }
    }
    expect(submissions).toEqual([]);
  }, 30_000);

  it('posts an enabled Done with pointer focus and clears a failed Done error on selection', async () => {
    installTree([treeNode({ doneEnabled: true, doneBlockers: [], planDigest: 'd'.repeat(64), epoch: 7 })]);
    outcomeRequests = [];
    await clickButton('refresh');
    await cdp.waitFor(`document.querySelector('[data-work-tree-done="demo-1"]:not([disabled])')`);
    await click('[data-work-tree-done="demo-1"]');
    await cdp.waitFor(`document.querySelector('[data-work-tree-done="demo-1"]') === null`);
    expect(outcomeRequests).toEqual([{
      project: 'demo', task: 'demo-1', outcome: 'done', plan_digest: 'd'.repeat(64), epoch: 7,
    }]);
    expect(await cdp.evaluate(`document.querySelector('[data-work-tree-node="task:demo:demo-1"]').textContent.includes('done')`)).toBe(true);
    expect(await cdp.evaluate('window.__pointerFocus')).toMatchObject({ tag: 'BUTTON', done: 'demo-1' });

    installTree([
      treeNode({ id: 'task:demo:bad', task: 'bad', recordId: 'bad', doneEnabled: true, doneBlockers: [] }),
      treeNode({ id: 'task:demo:other', task: 'other', recordId: 'other', doneEnabled: false }),
    ]);
    await clickButton('refresh');
    await cdp.waitFor(`document.querySelector('[data-work-tree-done="bad"]:not([disabled])')`);
    await click('[data-work-tree-done="bad"]');
    await cdp.waitFor(`document.querySelector('[role="alert"]')`);
    await click('[data-work-tree-node="task:demo:other"]');
    await cdp.waitFor(`document.querySelector('[role="alert"]') === null`);
  }, 30_000);

  it('renders hostile node text without markup or script execution', async () => {
    const hostile = '<img src=x onerror="window.__treeXss = true">';
    installTree([treeNode({ recordId: hostile })]);
    await clickButton('refresh');
    await cdp.waitFor(`document.body.innerText.includes(${JSON.stringify(hostile)})`);
    expect(await cdp.evaluate(`document.querySelector('[data-work-tree] img')`)).toBeNull();
    expect(await cdp.evaluate('window.__treeXss')).toBeUndefined();
  }, 30_000);

  it('drives declared push and one production root delta through pointer approval', async () => {
    const { root, remote, home, commit } = await declaredPushProject();
    deltaRoot = root;
    vi.mocked(buildStatus).mockResolvedValue({
      hub: { root: '' },
      projects: [{
        name: 'demo', home, repos: [], open_tasks: 1,
        orchestrator: { state: 'running', question: false },
        agents: [{ name: 'builder', state: 'running', question: true, ref: `builder@${home}` }],
      }],
    } as never);
    vi.mocked(readDialogFor).mockResolvedValue(dialogWith(
      `Run this command?\n  $ git push origin ${commit}:refs/heads/feat/watch`,
    ) as never);
    await watchCycle(root);
    expect(git(remote, 'rev-parse', 'refs/heads/feat/watch')).toBe(commit);
    expect(await listOpenQuestionBatches(root)).toEqual([]);

    installTree([treeNode({ planDigest: foldTasks(await readTaskEvents(root))[0].plan_digest })]);
    await clickButton('refresh');
    await cdp.waitFor(`document.querySelector('[data-work-tree]')`);
    expect(await cdp.evaluate(`[...document.querySelectorAll('button')].some((button) => button.textContent.startsWith('Questions'))`)).toBe(false);

    for (const command of ['python3 auto_mode_probe.py', 'python3 auto_mode_probe.py', 'python3 child_mutation.py']) {
      vi.mocked(readDialogFor).mockResolvedValue(dialogWith(`Run this command?\n  $ ${command}`) as never);
      await watchCycle(root);
    }
    const open = await listOpenQuestionBatches(root);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      agent: 'demo-orchestrator', rootDelta: { task: 'demo-1' }, questions: [{ decision: { action: 'scope_delta' } }],
    });
    Object.assign(VIEW, { questions: open });
    await clickButton('refresh');
    await cdp.waitFor(`document.body.innerText.includes('Approve a new root contract for demo-1?')`);
    expect(await cdp.evaluate(`[...document.querySelectorAll('button')].filter((button) => button.textContent === 'Questions 1').length`)).toBe(1);
    expect(await cdp.evaluate(`[...document.querySelectorAll('button')].filter((button) => button.textContent === 'Submit').length`)).toBe(1);
    expect(await cdp.evaluate(`document.body.innerText.includes('child delta')`)).toBe(false);
    await captureViewport(1280, 900, 'PROCESS_TREE_MONITOR-production-root-delta-desktop');
    await captureViewport(390, 844, 'PROCESS_TREE_MONITOR-production-root-delta-narrow');

    await click(`input[value="c2"]`);
    await clickButton('Submit');
    await cdp.waitFor(`![...document.querySelectorAll('button')].some((button) => button.textContent.startsWith('Questions'))`);
    const transitioned = foldTasks(await readTaskEvents(root))[0];
    expect(transitioned.lease_epoch).toBe(2);
    expect(transitioned.plan_digest).toBe(contractDigest(open[0].rootDelta!.nextContract));

    vi.mocked(readDialogFor).mockResolvedValue(dialogWith('Run this command?\n  $ python3 auto_mode_probe.py') as never);
    await watchCycle(root);
    expect(vi.mocked(answerDialog).mock.calls.at(-1)).toEqual([root, 'demo', `builder@${home}`, '1', 'fp']);
    expect(await listOpenQuestionBatches(root)).toEqual([]);
    deltaRoot = null;
    installTree([]);
  }, 60_000);
});

describe('real Chrome native branch E2E', () => {
  it('lazy loads, reviews, previews, arms without posting, confirms the digest, and shows the actual receipt', async () => {
    branchState = { ...ACTIVE_BRANCH };
    branchRequests = [];
    expect(await cdp.evaluate(`window.__fetchTrace.filter(([url]) => url.includes('/api/branch')).length`)).toBe(0);
    expect(await cdp.evaluate(`(() => {
      const matches = [...document.querySelectorAll('button')].filter((button) => button.textContent === 'Branches');
      return matches.length === 1 && matches[0].parentElement?.textContent?.includes('Logs');
    })()`)).toBe(true);

    await clickButton('Branches');
    await cdp.waitFor(`document.body.innerText.includes('Review the transport boundary')`);
    expect(branchRequests.map((request) => request.url)).toEqual(['/api/branches?project=demo']);
    expect(branchRequests.some((request) => request.url.startsWith('/api/branch?'))).toBe(false);

    await clickButton('Review the transport boundary', true);
    await cdp.waitFor(`document.querySelector('input[aria-label="select finding finding-1"]')`);
    expect(await cdp.evaluate(`document.querySelector('input[aria-label="select finding finding-1"]').checked`)).toBe(false);
    expect(await cdp.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent === 'Review').disabled`)).toBe(true);
    for (const text of [
      'active', 'builder', 'demo-1', ACTIVE_BRANCH.createdAt, ACTIVE_BRANCH.updatedAt, ACTIVE_BRANCH.error,
      ACTIVE_BRANCH.findings[0].answer, ACTIVE_BRANCH.findings[0].recommendation, ACTIVE_BRANCH.findings[0].uncertainty,
    ]) {
      expect(await cdp.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`)).toBe(true);
    }

    await click('input[aria-label="select finding finding-1"]');
    expect(await cdp.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent === 'Review').disabled`)).toBe(false);
    await clickButton('Review');
    await cdp.waitFor(`document.querySelector('[data-branch-prompt]')`);
    expect(branchRequests.at(-1)).toMatchObject({
      url: '/api/branch-review', method: 'POST',
      body: { project: 'demo', branch: BRANCH_ID, findingIds: ['finding-1'] },
    });
    expect(await cdp.evaluate(`document.querySelector('[data-branch-prompt]').textContent`)).toBe(BRANCH_PROMPT);
    expect(await cdp.evaluate(`document.querySelector('[data-branch-prompt] img')`)).toBeNull();
    expect(await cdp.evaluate(`window.__branchXss`)).toBeUndefined();

    await clickButton('Rejoin');
    await cdp.waitFor(`[...document.querySelectorAll('button')].some((button) => button.textContent === 'Confirm rejoin')`);
    expect(branchRequests.filter((request) => request.url === '/api/branch-rejoin')).toHaveLength(0);
    await clickButton('Confirm rejoin');
    await cdp.waitFor(`document.querySelector('[data-branch-receipt]')`);
    expect(branchRequests.at(-1)).toMatchObject({
      url: '/api/branch-rejoin', method: 'POST',
      body: { project: 'demo', branch: BRANCH_ID, reviewDigest: REVIEW_DIGEST },
    });
    const receipt = await cdp.evaluate(`document.querySelector('[data-branch-receipt]').textContent`);
    for (const text of ['Rejoined', 'msg_rejoined', REJOINED_AT, PROMPT_ID, REVIEW_DIGEST]) {
      expect(receipt).toContain(text);
    }
    expect(receipt).not.toContain('unknown');

  }, 30_000);
});
