import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import { createHandyServer, HANDY_PORT } from '../src/handy.js';
import type { Server } from 'node:http';
import { launchChrome } from './browser-launcher.js';

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

const VIEW = {
  root: '/r', hubName: 'hub', projects: [{
    name: 'demo', home: '/r/demo', repos: [], mode: 'ask', orchestrator: {
      state: 'stopped', question: false, name: 'demo-orchestrator', session_id: 'session_x',
    }, agents: [], open_tasks: 0,
  }],
  tasks: [], dialogs: {}, decisions: [], questions: [], updatedAt: Date.now(), error: '',
};

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
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

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
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    await page.call('Page.enable');
    await page.call('Runtime.enable');
    return page;
  }

  async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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
  await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}

async function fill(selector: string, value: string): Promise<void> {
  await cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await cdp.call('Input.insertText', { text: value });
}

describe('real Chrome dictation E2E', () => {
  it('uses real loopback HTTP, stops tracks, inserts for review, and never submits', async () => {
    await click('button[aria-label="Start dictation for new task for demo"]');
    await cdp.waitFor(`document.querySelector('input[type="password"]')`);
    await fill('input[type="password"]', TOKEN);
    await cdp.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent === 'Connect and dictate').click()`);
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

describe('real Chrome native branch E2E', () => {
  it('lazy loads, reviews, previews, arms without posting, confirms the digest, and shows the actual receipt', async () => {
    branchState = { ...ACTIVE_BRANCH };
    branchRequests = [];
    expect(await cdp.evaluate(`window.__fetchTrace.filter(([url]) => url.includes('/api/branch')).length`)).toBe(0);
    expect(await cdp.evaluate(`(() => {
      const matches = [...document.querySelectorAll('button')].filter((button) => button.textContent === 'Branches');
      return matches.length === 1 && matches[0].parentElement?.textContent?.includes('Logs');
    })()`)).toBe(true);

    await cdp.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent === 'Branches').click()`);
    await cdp.waitFor(`document.body.innerText.includes('Review the transport boundary')`);
    expect(branchRequests.map((request) => request.url)).toEqual(['/api/branches?project=demo']);
    expect(branchRequests.some((request) => request.url.startsWith('/api/branch?'))).toBe(false);

    await cdp.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.includes('Review the transport boundary')).click()`);
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
    await cdp.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent === 'Review').click()`);
    await cdp.waitFor(`document.querySelector('[data-branch-prompt]')`);
    expect(branchRequests.at(-1)).toMatchObject({
      url: '/api/branch-review', method: 'POST',
      body: { project: 'demo', branch: BRANCH_ID, findingIds: ['finding-1'] },
    });
    expect(await cdp.evaluate(`document.querySelector('[data-branch-prompt]').textContent`)).toBe(BRANCH_PROMPT);
    expect(await cdp.evaluate(`document.querySelector('[data-branch-prompt] img')`)).toBeNull();
    expect(await cdp.evaluate(`window.__branchXss`)).toBeUndefined();

    await cdp.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent === 'Rejoin').click()`);
    await cdp.waitFor(`[...document.querySelectorAll('button')].some((button) => button.textContent === 'Confirm rejoin')`);
    expect(branchRequests.filter((request) => request.url === '/api/branch-rejoin')).toHaveLength(0);
    await cdp.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent === 'Confirm rejoin').click()`);
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
