import { afterEach, describe, expect, it, vi } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { getEventListeners } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serveMcp, sleep } from '../src/mcp.js';
import * as questionModule from '../src/questions.js';
import { answerQuestionBatch, cancelQuestionBatch, listOpenQuestionBatches } from '../src/questions.js';
import { appendTaskEvent, hivePath, writeJson, writeProjects } from '../src/state.js';
import { AGENT_CREDENTIAL, MemoryRegistry, agentEnv, configureSecurity, registryItems } from './security-fixture.js';

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
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('ask_operator');
    expect(list[0].inputSchema.required).toEqual(['context', 'questions']);
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
