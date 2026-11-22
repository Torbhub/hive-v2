import { afterEach, describe, expect, it, vi } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { getEventListeners } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('../src/spawn.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/spawn.js')>();
  return { ...orig, typeLine: vi.fn(orig.typeLine) };
});

vi.mock('../src/tmux.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/tmux.js')>();
  return {
    ...orig,
    paneIs: vi.fn(orig.paneIs), capturePane: vi.fn(orig.capturePane),
    sendLiteral: vi.fn(orig.sendLiteral), sendEnter: vi.fn(orig.sendEnter), sleep: vi.fn(orig.sleep),
  };
});

import { serveMcp, sleep } from '../src/mcp.js';
import * as questionModule from '../src/questions.js';
import { answerQuestionBatch, cancelQuestionBatch, listOpenQuestionBatches } from '../src/questions.js';
import * as stateModule from '../src/state.js';
import { appendTaskEvent, hivePath, readDecisions, writeJson, writeProjects } from '../src/state.js';
import { PreInputError, typeLine } from '../src/spawn.js';
import { capturePane, paneIs, sendEnter, sendLiteral, sleep as tmuxSleep } from '../src/tmux.js';
import { AGENT_CREDENTIAL, MemoryRegistry, agentEnv, configureSecurity, registryItems } from './security-fixture.js';

const REAL_TYPE_LINE = vi.mocked(typeLine).getMockImplementation()!;

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.HIVE_ASSERTION_KEYS_JSON;
});

const GOOD_BATCH = {
  context: 'Choosing a database for the hub.',
  questions: [{
    question: 'Which store?', context: 'JSON files do not scale.', priority: 1, recommended: 'c1',
    choices: [
      { label: 'SQLite', description: 'Local file, no server.' },
      { label: 'Postgres', description: 'Real server, more operations.' },
    ],
  }],
};

type Client = ReturnType<typeof connect>;

function connect(env: NodeJS.ProcessEnv, extra: { timeoutMs?: number; registry?: MemoryRegistry } = {}) {
  const input = new PassThrough();
  let out = '';
  const output = new Writable({
    write(chunk, _enc, cb) { out += chunk.toString(); cb(); },
  });
  const server = serveMcp({ input, output, env, pollMs: 5, ...extra });
  const send = (msg: unknown): void => { input.write(JSON.stringify(msg) + '\n'); };
  const raw = (line: string): void => { input.write(line + '\n'); };
  const chunk = (data: string): void => { input.write(data); };
  const messages = (): Record<string, unknown>[] => out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const waitFor = async (fn: () => boolean | Promise<boolean>): Promise<void> => {
    const deadline = Date.now() + 3000;
    while (!(await fn())) {
      if (Date.now() > deadline) throw new Error(`timed out; got ${JSON.stringify(messages())}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return { send, raw, chunk, messages, waitFor, close: () => { server.close(); input.end(); } };
}

function envFor(root: string): NodeJS.ProcessEnv {
  return agentEnv(root);
}

async function root(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'hive-mcp-'));
  configureSecurity(false);
  return root;
}

describe('MCP protocol', () => {
  it('initializes, pings, lists the tool, and ignores initialized', async () => {
    const c = connect({});
    c.send({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
    c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    c.send({ jsonrpc: '2.0', id: 'p', method: 'ping' });
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await c.waitFor(() => c.messages().length === 3);
    const [init, ping, tools] = c.messages();
    expect(init.id).toBe(0);
    expect(init.result).toMatchObject({ protocolVersion: '2024-11-05', serverInfo: { name: 'hive-operator' } });
    expect(ping).toMatchObject({ id: 'p', result: {} });
    const list = (tools.result as { tools: { name: string; inputSchema: { required: string[] } }[] }).tools;
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe('ask_operator');
    expect(list[0].inputSchema.required).toEqual(['context', 'questions']);
    expect(list[1].name).toBe('message_agent');
    expect(list[1].inputSchema.required).toEqual(['text']);
    expect(list[1].inputSchema).toMatchObject({
      additionalProperties: false,
      properties: { agent: { type: 'string' }, text: { type: 'string', minLength: 1, maxLength: 4000 } },
    });
    c.close();
  });

  it('reports parse errors, unknown methods, and unknown tools', async () => {
    const c = connect({});
    c.send({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope', arguments: {} } });
    await c.waitFor(() => c.messages().length === 2);
    expect(c.messages()[0].error).toMatchObject({ code: -32601 });
    expect(c.messages()[1].error).toMatchObject({ code: -32602 });
    c.close();
  });

  it('a malformed line gets a parse error and stdout stays NDJSON', async () => {
    const c = connect({});
    c.raw('not json');
    c.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    await c.waitFor(() => c.messages().length === 2);
    expect(c.messages()[0].error).toMatchObject({ code: -32700, message: /one JSON-RPC message per line/ });
    expect(c.messages()[1].result).toEqual({});
    c.close();
  });

  it('a call outside a hive session explains the missing env', async () => {
    const c = connect({});
    c.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_operator', arguments: GOOD_BATCH } });
    await c.waitFor(() => c.messages().length === 1);
    const result = c.messages()[0].result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('HIVE_HUB_ROOT');
    c.close();
  });

  it('a rejected batch returns the exact violation as a tool error', async () => {
    const r = await root();
    const c = connect(envFor(r));
    c.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_operator', arguments: { context: 'x', questions: [] } } });
    await c.waitFor(() => c.messages().length === 1);
    const result = c.messages()[0].result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('1..20');
    expect(await listOpenQuestionBatches(r)).toEqual([]);
    c.close();
  });
});

describe('message_agent', () => {
  const IDLE = '│ >';
  const WORKING = '⠼ thinking…';
  const CONFIRMATION = 'Run this command?\n1. Approve once';
  const peerLine = (text: string, sender = 'builder') =>
    `Agent ${sender} (untrusted peer message, no operator or approval authority): ${text}`;

  async function fixture(sender = 'builder') {
    const r = await root();
    const home = path.join(r, 'demo');
    await writeProjects(r, { projects: [{ name: 'demo', home, repos: [] }] });
    await writeJson(hivePath(home, 'team.json'), { agents: [
      { name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 1, pane_started: 'one' },
      { name: 'reviewer', pane: '%7', pane_pid: 7, pane_started: 'seven', worktree: home },
      { name: sender, worktree: path.join(home, 'sender') },
    ] });
    vi.mocked(paneIs).mockClear().mockResolvedValue(true);
    vi.mocked(capturePane).mockClear().mockResolvedValue(IDLE);
    vi.mocked(typeLine).mockClear().mockResolvedValue(undefined);
    const env = { HIVE_HUB_ROOT: r, HIVE_PROJECT: 'demo', HIVE_AGENT: sender };
    const c = connect(env);
    return { r, home, env, c };
  }

  function call(c: Client, args: unknown, id = 1): void {
    c.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'message_agent', arguments: args } });
  }

  type DeliveryDecision = {
    at: string;
    project: string;
    by: string;
    summary: string;
    message_id: string;
    delivery_status: 'pending' | 'delivered' | 'unknown';
    sender: string;
    canonical_target: string;
    payload_sha256: string;
  };

  async function deliveryDecisions(r: string): Promise<DeliveryDecision[]> {
    return await readDecisions(r, Number.MAX_SAFE_INTEGER) as unknown as DeliveryDecision[];
  }

  function toolPayload(c: Client, index = 0): { id: string; outcome: string } {
    const result = c.messages()[index].result as { content: { text: string }[] };
    return JSON.parse(result.content[0].text);
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('delivers an untrusted peer label and audits only metadata with a canonical target', async () => {
    const { r, home, c } = await fixture();
    let pending!: DeliveryDecision;
    vi.mocked(typeLine).mockImplementation(async () => {
      [pending] = await deliveryDecisions(r);
    });
    call(c, { agent: 'reviewer', text: 'line1\nline2' });
    await c.waitFor(() => c.messages().length === 1);
    const payload = toolPayload(c);
    expect(payload.id).toMatch(UUID_RE);
    expect(pending).toMatchObject({
      message_id: payload.id,
      delivery_status: 'pending',
      project: 'demo',
      sender: 'builder',
      canonical_target: `reviewer@${home}`,
      payload_sha256: createHash('sha256').update('line1 line2').digest('hex'),
    });
    expect(payload).toEqual({ id: pending.message_id, outcome: 'delivered' });
    expect(typeLine).toHaveBeenCalledWith('%7', peerLine('line1 line2'), { pid: 7, started: 'seven' }, expect.any(Function));
    expect(typeLine).toHaveBeenCalledTimes(1);
    const decisions = await deliveryDecisions(r);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      ...pending,
      delivery_status: 'delivered',
      by: 'agent',
      summary: `agent message ${payload.id} from builder to reviewer@${home}: ${pending.payload_sha256} delivered`,
    });
    expect(JSON.stringify(pending).length).toBeLessThan(1000);
    expect(JSON.stringify({ result: c.messages()[0].result, pending, decisions })).not.toContain('line1');
    c.close();
  });

  it('persists pending before PreInputError and does not retry', async () => {
    const { r, c } = await fixture();
    let pending!: DeliveryDecision;
    vi.mocked(typeLine).mockImplementation(async () => {
      [pending] = await deliveryDecisions(r);
      throw new PreInputError('input rejected');
    });
    call(c, { text: 'pre-input secret' });
    await c.waitFor(() => c.messages().length === 1);
    const result = c.messages()[0].result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(pending).toMatchObject({ delivery_status: 'pending', sender: 'builder', canonical_target: 'demo-orchestrator' });
    expect(pending.message_id).toMatch(UUID_RE);
    expect(toolPayload(c)).toEqual({ id: pending.message_id, outcome: 'pending' });
    expect(typeLine).toHaveBeenCalledTimes(1);
    expect(await deliveryDecisions(r)).toEqual([pending]);
    expect(JSON.stringify({ result, pending })).not.toContain('pre-input secret');
    c.close();
  });

  it('returns and recovers unknown after post-input uncertainty without retrying', async () => {
    const { r, c } = await fixture();
    let pending!: DeliveryDecision;
    vi.mocked(typeLine).mockImplementation(async () => {
      [pending] = await deliveryDecisions(r);
      throw new Error('Enter may have been delivered');
    });
    call(c, { text: 'post-input secret' });
    await c.waitFor(() => c.messages().length === 1);
    expect(c.messages()[0].result).toMatchObject({ isError: true });
    expect(toolPayload(c)).toEqual({ id: pending.message_id, outcome: 'unknown' });
    expect(typeLine).toHaveBeenCalledTimes(1);
    const decisions = await deliveryDecisions(r);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      ...pending,
      delivery_status: 'unknown',
      summary: pending.summary.replace(/pending$/, 'unknown'),
    });
    expect(JSON.stringify({ result: c.messages()[0].result, decisions })).not.toContain('post-input secret');
    c.close();
  });

  it('returns and recovers unknown when the post-typeLine delivered audit fails', async () => {
    const { r, c } = await fixture();
    const appendDecision = stateModule.appendDecision;
    vi.spyOn(stateModule, 'appendDecision').mockImplementation(async (root, decision) => {
      if ((decision as { delivery_status?: string }).delivery_status === 'delivered') throw new Error('audit failed');
      await appendDecision(root, decision);
    });
    let pending!: DeliveryDecision;
    vi.mocked(typeLine).mockImplementation(async () => {
      [pending] = await deliveryDecisions(r);
    });
    call(c, { text: 'audit secret' });
    await c.waitFor(() => c.messages().length === 1);
    expect(c.messages()[0].result).toMatchObject({ isError: true });
    expect(toolPayload(c)).toEqual({ id: pending.message_id, outcome: 'unknown' });
    expect(typeLine).toHaveBeenCalledTimes(1);
    const decisions = await deliveryDecisions(r);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      ...pending,
      delivery_status: 'unknown',
      summary: pending.summary.replace(/pending$/, 'unknown'),
    });
    expect(JSON.stringify({ result: c.messages()[0].result, decisions })).not.toContain('audit secret');
    c.close();
  });

  it.each([
    { name: 'delivered and fallback unknown appends fail', typingFails: false },
    { name: 'unknown append fails after post-input uncertainty', typingFails: true },
  ])('returns unknown when $name', async ({ typingFails }) => {
    const { r, c } = await fixture();
    const appendDecision = stateModule.appendDecision;
    vi.spyOn(stateModule, 'appendDecision').mockImplementation(async (root, decision) => {
      if ((decision as { delivery_status?: string }).delivery_status !== 'pending') throw new Error('audit failed');
      await appendDecision(root, decision);
    });
    let pending!: DeliveryDecision;
    vi.mocked(typeLine).mockImplementation(async () => {
      [pending] = await deliveryDecisions(r);
      if (typingFails) throw new Error('Enter may have been delivered');
    });
    call(c, { text: 'durable pending secret' });
    await c.waitFor(() => c.messages().length === 1);
    expect(c.messages()[0].result).toMatchObject({ isError: true });
    expect(toolPayload(c)).toEqual({ id: pending.message_id, outcome: 'unknown' });
    expect(typeLine).toHaveBeenCalledTimes(1);
    expect(await deliveryDecisions(r)).toEqual([pending]);
    expect(JSON.stringify(c.messages()[0].result)).not.toContain('durable pending secret');
    c.close();
  });

  it('defaults to the orchestrator while an ask_operator batch stays open', async () => {
    const { r, c } = await fixture();
    c.send({ jsonrpc: '2.0', id: 'ask', method: 'tools/call', params: { name: 'ask_operator', arguments: GOOD_BATCH } });
    await c.waitFor(async () => (await listOpenQuestionBatches(r)).length === 1);
    call(c, { text: 'status please' }, 'message');
    await c.waitFor(() => c.messages().length === 1);
    expect(c.messages()[0].id).toBe('message');
    expect(toolPayload(c)).toEqual({ id: expect.any(String), outcome: 'delivered' });
    expect(typeLine).toHaveBeenCalledWith('%1', peerLine('status please'), { pid: 1, started: 'one' }, expect.any(Function));
    const [batch] = await listOpenQuestionBatches(r);
    await cancelQuestionBatch(r, batch.id);
    await c.waitFor(() => c.messages().length === 2);
    expect(c.messages()[1]).toMatchObject({ id: 'ask', result: { isError: true } });
    c.close();
  });

  it.each([
    { name: 'idle', afterEnter: 'done\n│ > ', wrapped: false },
    { name: 'unknown output', afterEnter: 'ordinary output without a prompt', wrapped: false },
    { name: 'dialog transition', afterEnter: CONFIRMATION, wrapped: false },
    { name: 'wrapped input', afterEnter: 'done\n│ > ', wrapped: true },
  ])('delivers a peer message through the real typing sequence with $name', async ({ afterEnter, wrapped }) => {
    const { r, c } = await fixture();
    const text = wrapped ? 'x'.repeat(100) : 'hello';
    const expected = peerLine(text);
    let screen = IDLE;
    const events: string[] = [];
    vi.mocked(typeLine).mockImplementation(REAL_TYPE_LINE);
    vi.mocked(tmuxSleep).mockResolvedValue(undefined);
    vi.mocked(capturePane).mockClear().mockImplementation(async () => {
      events.push('capture');
      return screen;
    });
    vi.mocked(sendLiteral).mockClear().mockImplementation(async (_pane, typed) => {
      events.push('literal');
      screen = wrapped ? `│ > ${typed.slice(0, 80)}\n${typed.slice(80)}` : `│ > ${typed}`;
    });
    vi.mocked(sendEnter).mockClear().mockImplementation(async () => {
      events.push('enter');
      screen = afterEnter;
    });
    call(c, { text });
    await c.waitFor(() => c.messages().length === 1);
    expect(toolPayload(c)).toEqual({ id: expect.any(String), outcome: 'delivered' });
    expect(sendLiteral).toHaveBeenCalledWith('%1', expected, { pid: 1, started: 'one' });
    expect(sendEnter).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['capture', 'literal', 'capture', 'enter', 'capture']);
    expect((await readDecisions(r))[0].by).toBe('agent');
    c.close();
  });

  it('rejects dialog controls beside the expected prompt after literal input', async () => {
    const { r, c } = await fixture();
    let screen = IDLE;
    vi.mocked(typeLine).mockImplementation(REAL_TYPE_LINE);
    vi.mocked(tmuxSleep).mockResolvedValue(undefined);
    vi.mocked(capturePane).mockImplementation(async () => screen);
    vi.mocked(sendLiteral).mockClear().mockImplementation(async (_pane, text) => {
      screen = `Press Enter to continue\n│ > ${text}`;
    });
    vi.mocked(sendEnter).mockClear();
    call(c, { text: 'hello' });
    await c.waitFor(() => c.messages().length === 1);
    expect(c.messages()[0].result).toMatchObject({ isError: true });
    const [decision] = await deliveryDecisions(r);
    expect(toolPayload(c)).toEqual({ id: decision.message_id, outcome: 'unknown' });
    expect(decision.delivery_status).toBe('unknown');
    expect(typeLine).toHaveBeenCalledTimes(1);
    expect(sendLiteral).toHaveBeenCalledTimes(1);
    expect(sendEnter).not.toHaveBeenCalled();
    c.close();
  });

  it.each([
    CONFIRMATION,
    '↑↓ select 1-2 / ↵ choose ←/→/tab switch esc cancel',
  ])('refuses retry with dialog controls beside the expected prompt on the same capture', async (controls) => {
    const { r, c } = await fixture();
    const expected = peerLine('hello');
    const captures = [IDLE, `│ > ${expected}`, `${controls}\n│ > ${expected}`, IDLE];
    let captureCount = 0;
    vi.mocked(typeLine).mockImplementation(REAL_TYPE_LINE);
    vi.mocked(tmuxSleep).mockResolvedValue(undefined);
    vi.mocked(capturePane).mockImplementation(async () => captures[Math.min(captureCount++, captures.length - 1)]);
    vi.mocked(sendLiteral).mockClear().mockResolvedValue(undefined);
    vi.mocked(sendEnter).mockClear().mockResolvedValue(undefined);
    call(c, { text: 'hello' });
    await c.waitFor(() => c.messages().length === 1);
    expect(c.messages()[0].result).toMatchObject({ isError: true });
    const [decision] = await deliveryDecisions(r);
    expect(toolPayload(c)).toEqual({ id: decision.message_id, outcome: 'unknown' });
    expect(decision.delivery_status).toBe('unknown');
    expect(typeLine).toHaveBeenCalledTimes(1);
    expect(sendLiteral).toHaveBeenCalledTimes(1);
    expect(sendEnter).toHaveBeenCalledTimes(1);
    expect(captureCount).toBe(3);
    c.close();
  });

  it('serializes overlapping delivery across independent MCP servers', async () => {
    const { env, c: first } = await fixture();
    const second = connect(env);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(typeLine).mockImplementationOnce(() => gate);
    try {
      call(first, { text: 'first' }, 'first');
      await first.waitFor(() => vi.mocked(typeLine).mock.calls.length === 1);
      call(second, { text: 'second' }, 'second');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(typeLine).toHaveBeenCalledTimes(1);
      expect(second.messages()).toEqual([]);
      release();
      await first.waitFor(() => first.messages().length === 1);
      await second.waitFor(() => second.messages().length === 1);
      expect(typeLine).toHaveBeenCalledTimes(2);
      expect(vi.mocked(typeLine).mock.calls.map((call) => call[1])).toEqual([peerLine('first'), peerLine('second')]);
    } finally {
      release();
      first.close();
      second.close();
    }
  });

  it('requires the default-mode Hive environment', async () => {
    const c = connect({});
    call(c, { text: 'hello' });
    await c.waitFor(() => c.messages().length === 1);
    expect(c.messages()[0].result).toMatchObject({ isError: true });
    expect((c.messages()[0].result as { content: { text: string }[] }).content[0].text).toContain('HIVE_HUB_ROOT');
    expect(typeLine).not.toHaveBeenCalled();
    c.close();
  });

  it('returns deliberate errors for bad input, unknown targets, and malformed refs', async () => {
    const { c } = await fixture();
    const invalid: unknown[] = [null, {}, { text: 1 }, { text: 'ok', agent: 1 }, { text: 'ok', extra: true }];
    for (const [index, args] of invalid.entries()) {
      call(c, args, index + 1);
      await c.waitFor(() => c.messages().length === index + 1);
      expect(c.messages()[index].result).toMatchObject({ isError: true });
    }
    call(c, { agent: 'ghost', text: 'hello' }, invalid.length + 1);
    await c.waitFor(() => c.messages().length === invalid.length + 1);
    expect(c.messages().at(-1)!.result).toEqual({
      isError: true, content: [{ type: 'text', text: 'demo has no agent named ghost' }],
    });
    call(c, { agent: 'reviewer@worktree@extra', text: 'hello' }, invalid.length + 2);
    await c.waitFor(() => c.messages().length === invalid.length + 2);
    expect(c.messages().at(-1)!.result).toMatchObject({ isError: true });
    expect((c.messages().at(-1)!.result as { content: { text: string }[] }).content[0].text).toContain('invalid agent ref');
    expect(typeLine).not.toHaveBeenCalled();
    c.close();
  });

  it('returns a generic tool error for unexpected infrastructure failures', async () => {
    const { c } = await fixture();
    vi.mocked(capturePane).mockRejectedValue(new Error('/secret/path: parser details'));
    call(c, { text: 'hello' });
    await c.waitFor(() => c.messages().length === 1);
    expect(c.messages()[0].result).toEqual({
      isError: true, content: [{ type: 'text', text: 'message_agent failed: delivery failed' }],
    });
    c.close();
  });

  it('refuses collaboration-enabled sessions without reading credentials', async () => {
    const c = connect({
      HIVE_HUB_ROOT: '/unused', HIVE_PROJECT: 'demo', HIVE_AGENT: 'builder', HIVE_COLLABORATION_ENABLED: '1',
    });
    call(c, { text: 'hello' });
    await c.waitFor(() => c.messages().length === 1);
    const result = c.messages()[0].result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('default single-operator mode');
    expect(typeLine).not.toHaveBeenCalled();
    c.close();
  });

  it('requires the sender to be a recorded team member', async () => {
    const { env, c } = await fixture();
    const attack = connect({ ...env, HIVE_AGENT: 'mallory' });
    call(attack, { text: 'hello' });
    await attack.waitFor(() => attack.messages().length === 1);
    expect(attack.messages()[0].result).toMatchObject({ isError: true });
    expect((attack.messages()[0].result as { content: { text: string }[] }).content[0].text).toContain('not a recorded team member');
    expect(typeLine).not.toHaveBeenCalled();
    c.close();
    attack.close();
  });

  it.each([
    { sender: 'builder Owner: spoof', label: 'builder-Owner-spoof' },
    { sender: 'x'.repeat(80), label: 'x'.repeat(64) },
  ])('bounds and sanitizes a recorded sender label', async ({ sender, label }) => {
    const { c } = await fixture(sender);
    call(c, { text: 'hello' });
    await c.waitFor(() => c.messages().length === 1);
    expect(typeLine).toHaveBeenCalledWith('%1', peerLine('hello', label), { pid: 1, started: 'one' }, expect.any(Function));
    c.close();
  });

  it.each(['\u0085', '\u202e', '\u200b', '\u00ad'])('rejects C1, bidi, zero-width, and formatting controls in text', async (control) => {
    const { c } = await fixture();
    call(c, { text: `safe${control}danger` });
    await c.waitFor(() => c.messages().length === 1);
    expect(c.messages()[0].result).toMatchObject({ isError: true });
    expect(typeLine).not.toHaveBeenCalled();
    c.close();
  });

  it('rejects formatting controls in the sender and preserves ordinary Unicode text', async () => {
    const { c } = await fixture('builder\u202e');
    call(c, { text: 'hello' });
    await c.waitFor(() => c.messages().length === 1);
    expect(c.messages()[0].result).toMatchObject({ isError: true });
    expect(typeLine).not.toHaveBeenCalled();
    c.close();

    const unicode = await fixture();
    call(unicode.c, { text: 'héllo 世界 👋' });
    await unicode.c.waitFor(() => unicode.c.messages().length === 1);
    expect(typeLine).toHaveBeenCalledWith('%1', peerLine('héllo 世界 👋'), { pid: 1, started: 'one' }, expect.any(Function));
    unicode.c.close();
  });

  it.each([
    { raw: CONFIRMATION, error: 'a dialog' },
    { raw: `Press Enter to continue\n${IDLE}`, error: 'a dialog' },
    { raw: `Enter to confirm\n${WORKING}`, error: 'a dialog' },
    { raw: `↑↓ select 1-2 / ↵ choose ←/→/tab switch esc cancel\n${IDLE}`, error: 'a dialog' },
    { raw: null, error: 'pane is gone' },
    { raw: 'unclassified screen', error: 'screen state is unknown' },
  ])('fails closed before typing for an unsafe screen', async ({ raw, error }) => {
    const { c } = await fixture();
    vi.mocked(capturePane).mockResolvedValue(raw);
    call(c, { text: 'hello' });
    await c.waitFor(() => c.messages().length === 1);
    expect((c.messages()[0].result as { content: { text: string }[] }).content[0].text).toContain(error);
    expect(typeLine).not.toHaveBeenCalled();
    c.close();
  });

  it('rechecks the screen through the typeLine guard', async () => {
    const { r, c } = await fixture();
    vi.mocked(typeLine).mockImplementation(async (_pane, _text, _identity, screenGuard) => {
      vi.mocked(capturePane).mockResolvedValue(CONFIRMATION);
      await screenGuard?.();
    });
    call(c, { text: 'hello' });
    await c.waitFor(() => c.messages().length === 1);
    expect(c.messages()[0].result).toMatchObject({ isError: true });
    const [decision] = await deliveryDecisions(r);
    expect(toolPayload(c)).toEqual({ id: decision.message_id, outcome: 'unknown' });
    expect(decision.delivery_status).toBe('unknown');
    expect(typeLine).toHaveBeenCalledTimes(1);
    c.close();
  });

  it('allows delivery to a working session', async () => {
    const { c } = await fixture();
    vi.mocked(capturePane).mockResolvedValue(WORKING);
    call(c, { text: 'hello' });
    await c.waitFor(() => c.messages().length === 1);
    expect(toolPayload(c)).toEqual({ id: expect.any(String), outcome: 'delivered' });
    c.close();
  });
});

describe('ask_operator lifecycle', () => {
  it('sleep never accumulates abort listeners across a long wait', async () => {
    const controller = new AbortController();
    for (let i = 0; i < 50; i++) await sleep(1, controller.signal);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    const pending = sleep(60_000, controller.signal).catch(() => {});
    controller.abort();
    await pending;
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    await expect(sleep(1, controller.signal)).rejects.toThrow('aborted');
  });

  it('an oversized line is rejected and the next request still works', async () => {
    const c = connect({});
    c.raw('x'.repeat(1_048_577));
    c.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    await c.waitFor(() => c.messages().length === 2);
    expect(c.messages()[0].error).toMatchObject({ code: -32700, message: /1MiB/ });
    expect(c.messages()[1].result).toEqual({});
    c.close();
  });

  it('a second outstanding batch from the same session is refused', async () => {
    const r = await root();
    const c = connect(envFor(r));
    c.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_operator', arguments: GOOD_BATCH } });
    await c.waitFor(async () => (await listOpenQuestionBatches(r)).length === 1);
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask_operator', arguments: GOOD_BATCH } });
    await c.waitFor(() => c.messages().length === 1);
    const result = c.messages()[0].result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('already waiting');
    const batches = await listOpenQuestionBatches(r);
    await cancelQuestionBatch(r, batches[0].id);
    await c.waitFor(() => c.messages().length === 2);
    c.close();
  });

  it('blocks while open, answers with JSON, and stays responsive to ping', async () => {
    const r = await root();
    const c = connect(envFor(r));
    c.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'ask_operator', arguments: GOOD_BATCH } });
    await c.waitFor(async () => (await listOpenQuestionBatches(r)).length === 1);
    const batches = await listOpenQuestionBatches(r);
    expect(batches).toHaveLength(1);
    await new Promise((res) => setTimeout(res, 30));
    expect(c.messages()).toEqual([]);
    c.send({ jsonrpc: '2.0', id: 'p', method: 'ping' });
    await c.waitFor(() => c.messages().length === 1);
    expect(c.messages()[0].id).toBe('p');
    await answerQuestionBatch(r, batches[0].id, [{ question: 'q1', choice: 'other', text: 'Neither, use DynamoDB' }]);
    await c.waitFor(() => c.messages().length === 2);
    const result = c.messages()[1].result as { content: { text: string }[] };
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({ id: batches[0].id, status: 'answered' });
    expect(payload.answers).toEqual([{ question: 'q1', choice: 'other', text: 'Neither, use DynamoDB' }]);
    c.close();
  });

  it('a cancelled batch comes back as a tool error naming the batch', async () => {
    const r = await root();
    const c = connect(envFor(r));
    c.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_operator', arguments: GOOD_BATCH } });
    await c.waitFor(async () => (await listOpenQuestionBatches(r)).length === 1);
    const batches = await listOpenQuestionBatches(r);
    await cancelQuestionBatch(r, batches[0].id);
    await c.waitFor(() => c.messages().length === 1);
    const result = c.messages()[0].result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(`cancelled question batch ${batches[0].id}`);
    c.close();
  });

  it('client cancellation aborts the wait, sends no late response, and frees the slot', async () => {
    const r = await root();
    const c = connect(envFor(r));
    c.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_operator', arguments: GOOD_BATCH } });
    await c.waitFor(async () => (await listOpenQuestionBatches(r)).length === 1);
    const batches = await listOpenQuestionBatches(r);
    expect(batches).toHaveLength(1);
    c.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
    await new Promise((res) => setTimeout(res, 30));
    expect(c.messages()).toEqual([]);
    await answerQuestionBatch(r, batches[0].id, [{ question: 'q1', choice: 'c1' }]);
    await new Promise((res) => setTimeout(res, 30));
    expect(c.messages()).toEqual([]);
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask_operator', arguments: GOOD_BATCH } });
    await c.waitFor(async () => (await listOpenQuestionBatches(r)).length === 1);
    c.send({ jsonrpc: '2.0', id: 3, method: 'ping' });
    await c.waitFor(() => c.messages().length === 1);
    expect(c.messages()[0].id).toBe(3);
    c.close();
  });

  it('cancellation works with string and zero request ids', async () => {
    const r = await root();
    const c = connect(envFor(r));
    c.send({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name: 'ask_operator', arguments: GOOD_BATCH } });
    await c.waitFor(async () => (await listOpenQuestionBatches(r)).length === 1);
    c.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 0 } });
    await new Promise((res) => setTimeout(res, 30));
    expect(c.messages()).toEqual([]);
    c.send({ jsonrpc: '2.0', id: 'abc', method: 'tools/call', params: { name: 'ask_operator', arguments: GOOD_BATCH } });
    await c.waitFor(async () => (await listOpenQuestionBatches(r)).length === 2);
    c.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'abc' } });
    await new Promise((res) => setTimeout(res, 30));
    expect(c.messages()).toEqual([]);
    expect(await listOpenQuestionBatches(r)).toHaveLength(2);
    c.close();
  });

  it('structurally invalid messages get -32600 and never crash the server', async () => {
    const c = connect({});
    c.raw('null');
    c.raw('[1,2]');
    c.raw('"text"');
    c.send({ jsonrpc: '2.0', id: { bad: true }, method: 'ping' });
    c.send({ jsonrpc: '2.0', id: 5 });
    c.send({ jsonrpc: '2.0', id: 6, method: 7 });
    c.send({ jsonrpc: '1.0', id: 7, method: 'ping' });
    c.send({ id: 9, method: 'ping' });
    c.send({ jsonrpc: '2.0', id: 8, method: 'ping' });
    await c.waitFor(() => c.messages().length === 9);
    for (const msg of c.messages().slice(0, 8)) {
      expect(msg.error).toMatchObject({ code: -32600 });
    }
    expect(c.messages()[8]).toMatchObject({ id: 8, result: {} });
    c.close();
  });

  it('an unterminated oversized stream is refused once and later lines still parse', async () => {
    const c = connect({});
    c.chunk('x'.repeat(600_000));
    c.chunk('y'.repeat(600_000));
    await c.waitFor(() => c.messages().length === 1);
    expect(c.messages()[0].error).toMatchObject({ code: -32700, message: /1MiB/ });
    c.chunk('z'.repeat(600_000));
    c.chunk('w'.repeat(600_000));
    await new Promise((res) => setTimeout(res, 30));
    expect(c.messages()).toHaveLength(1);
    c.chunk('\n');
    c.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    await c.waitFor(() => c.messages().length === 2);
    expect(c.messages()[1]).toMatchObject({ id: 1, result: {} });
    c.close();
  });

  it('re-reads and reports an answered batch at the wait limit', async () => {
    const r = await root();
    const c = connect(envFor(r), { timeoutMs: 200 });
    c.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_operator', arguments: GOOD_BATCH } });
    await c.waitFor(async () => (await listOpenQuestionBatches(r)).length === 1);
    const [batch] = await listOpenQuestionBatches(r);
    await answerQuestionBatch(r, batch.id, [{ question: 'q1', choice: 'c1' }]);
    await c.waitFor(() => c.messages().length === 1);
    const result = c.messages()[0].result as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('"status":"answered"');
    c.close();
  });

  it('a wait past the limit errors and leaves the batch open for the operator', async () => {
    const r = await root();
    const c = connect(envFor(r), { timeoutMs: 25 });
    c.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_operator', arguments: GOOD_BATCH } });
    await c.waitFor(() => c.messages().length === 1);
    const result = c.messages()[0].result as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('still open');
    expect((await listOpenQuestionBatches(r))).toHaveLength(1);
    c.close();
  });
});

describe('authenticated MCP integration', () => {
  it('returns tool errors for missing malformed and insecure credential files', async () => {
    const r = await root();
    const malformed = path.join(r, 'malformed.env');
    const insecure = path.join(r, 'insecure.env');
    await writeFile(malformed, 'not a credential\n', { mode: 0o600 });
    await writeFile(insecure, `HIVE_AGENT_CREDENTIAL='${AGENT_CREDENTIAL}'\n`, { mode: 0o644 });
    const env = {
      HIVE_HUB_ROOT: r, HIVE_COLLABORATION_ENABLED: '1',
      HIVE_AGENT_CREDENTIAL_FILE: path.join(r, 'missing.env'),
    };
    const c = connect(env);
    for (const [id, file] of [[1, env.HIVE_AGENT_CREDENTIAL_FILE], [2, malformed], [3, insecure]] as const) {
      env.HIVE_AGENT_CREDENTIAL_FILE = file;
      c.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'ask_operator', arguments: GOOD_BATCH } });
      await c.waitFor(() => c.messages().length === id);
      const result = c.messages()[id - 1].result as { isError: boolean; content: { text: string }[] };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('authorization failed');
    }
    c.close();
  });

  it('creates a batch for the exact same-named agent worktree', async () => {
    const r = await root();
    const home = path.join(r, 'demo');
    const one = path.join(home, 'one');
    const two = path.join(home, 'two');
    await writeProjects(r, { projects: [{ name: 'demo', home, repos: [] }] });
    await writeJson(hivePath(home, 'team.json'), { agents: [
      { name: 'builder', worktree: one, task: 'demo-1' },
      { name: 'builder', worktree: two, task: 'demo-2' },
    ] });
    await appendTaskEvent(r, { id: 'demo-1', project: 'demo', event: 'asked', at: new Date().toISOString() });
    await appendTaskEvent(r, { id: 'demo-2', project: 'demo', event: 'asked', at: new Date().toISOString() });
    const items = registryItems().map((row) => row.sk === 'PRINCIPAL#agent:builder'
      ? { ...row, pk: 'ACL#demo#demo-2#*', task: 'demo-2' } : row);
    const file = path.join(r, 'credential.env');
    await writeFile(file, `HIVE_AGENT_CREDENTIAL='${AGENT_CREDENTIAL}'\n`, { mode: 0o600 });
    const registry = new MemoryRegistry(items);
    const c = connect({
      HIVE_HUB_ROOT: r, HIVE_COLLABORATION_ENABLED: '1',
      HIVE_AGENT_CREDENTIAL_FILE: file, HIVE_AGENT_REF: `builder@${two}`,
    }, { registry });
    c.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_operator', arguments: GOOD_BATCH } });
    await c.waitFor(async () => (await listOpenQuestionBatches(r)).length === 1);
    const [batch] = await listOpenQuestionBatches(r);
    expect(batch.agent).toBe(`builder@${two}`);
    await cancelQuestionBatch(r, batch.id);
    await c.waitFor(() => c.messages().length === 1);
    c.close();

    const attack = connect({
      HIVE_HUB_ROOT: r, HIVE_COLLABORATION_ENABLED: '1',
      HIVE_AGENT_CREDENTIAL_FILE: file, HIVE_AGENT_REF: `mallory@${two}`,
    }, { registry });
    attack.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ask_operator', arguments: GOOD_BATCH } });
    await attack.waitFor(() => attack.messages().length === 1);
    expect(attack.messages()[0].result).toMatchObject({ isError: true });
    expect(await listOpenQuestionBatches(r)).toEqual([]);
    attack.close();
  });

  it('creates a question card for an enabled named orchestrator', async () => {
    const r = await root();
    const rows = registryItems().map((row) => JSON.parse(JSON.stringify(row).replaceAll('builder', 'demo-orchestrator')));
    const home = path.join(r, 'demo');
    await writeProjects(r, { projects: [{ name: 'demo', home, repos: [] }] });
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'demo-orchestrator', orchestrator: true, worktree: home, task: 'demo-1' }],
    });
    await appendTaskEvent(r, { id: 'demo-1', project: 'demo', event: 'asked', at: new Date().toISOString() });
    const file = path.join(r, 'orchestrator.env');
    const credential = AGENT_CREDENTIAL.replace('builder', 'demo-orchestrator');
    await writeFile(file, `HIVE_AGENT_CREDENTIAL='${credential}'\n`, { mode: 0o600 });
    const c = connect({
      HIVE_HUB_ROOT: r, HIVE_COLLABORATION_ENABLED: '1',
      HIVE_AGENT_CREDENTIAL_FILE: file, HIVE_AGENT_REF: `demo-orchestrator@${home}`,
    }, { registry: new MemoryRegistry(rows) });
    c.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_operator', arguments: GOOD_BATCH } });
    await c.waitFor(async () => (await listOpenQuestionBatches(r)).length === 1);
    const [batch] = await listOpenQuestionBatches(r);
    expect(batch.agent).toBe(`demo-orchestrator@${home}`);
    await cancelQuestionBatch(r, batch.id);
    await c.waitFor(() => c.messages().length === 1);
    c.close();
  });

  for (const rejected of [false, true]) {
    it(`suppresses a delayed timeout ${rejected ? 'failure' : 'answer'} after cancellation`, async () => {
      const r = await root();
      const original = questionModule.readQuestionBatch;
      const read = vi.spyOn(questionModule, 'readQuestionBatch').mockImplementation(async (root, id) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        if (rejected) throw new Error('late read failure');
        return original(root, id);
      });
      const c = connect(envFor(r), { timeoutMs: 10 });
      c.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_operator', arguments: GOOD_BATCH } });
      await c.waitFor(async () => (await listOpenQuestionBatches(r)).length === 1);
      await c.waitFor(() => read.mock.calls.length > 0);
      c.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(c.messages()).toEqual([]);
      c.close();
    });
  }
});
