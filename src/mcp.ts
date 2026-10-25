import type { QuestionBatch } from './types.js';
import { createQuestionBatch, readQuestionBatch } from './questions.js';

const PROTOCOL = '2024-11-05';
const DAY_MS = 24 * 60 * 60_000;

const ASK_OPERATOR = {
  name: 'ask_operator',
  description: [
    'Ask the human operator a whole batch of structured questions and wait for the answers.',
    'Use this whenever you need a decision: one call carries the overarching context and every',
    'question, so the operator can decide without reading your session. Each question needs its',
    'own context (why you ask), a priority (1 decides first), 2-8 choices each with a label and',
    'a description, and exactly one recommended choice id (c1 is the first choice, c2 the second).',
    'The operator can always pick Other with free text. The call returns when the batch is',
    'answered or cancelled; the answers come back as JSON.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['context', 'questions'],
    properties: {
      context: {
        type: 'string', minLength: 1, maxLength: 4000,
        description: 'Overarching context for the whole batch: what you are doing, what is decided already, why now.',
      },
      questions: {
        type: 'array', minItems: 1, maxItems: 20,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['question', 'context', 'priority', 'choices', 'recommended'],
          properties: {
            question: { type: 'string', minLength: 1, maxLength: 1000, description: 'The decision the operator must make.' },
            context: { type: 'string', minLength: 1, maxLength: 4000, description: 'Why this question is being asked: background, tradeoffs, what happens after the answer.' },
            priority: { type: 'integer', minimum: 1, description: 'Decision order: 1 is shown first.' },
            choices: {
              type: 'array', minItems: 2, maxItems: 8,
              items: {
                type: 'object', additionalProperties: false, required: ['label', 'description'],
                properties: {
                  label: { type: 'string', minLength: 1, maxLength: 200 },
                  description: { type: 'string', minLength: 1, maxLength: 2000, description: 'What this choice means, its cost and its risk.' },
                },
              },
            },
            recommended: { type: 'string', description: 'The id of your recommended choice: c1 for the first choice, c2 for the second, and so on.' },
          },
        },
      },
    },
  },
} as const;

type RpcId = string | number;
type RpcRequest = { jsonrpc?: string; id?: RpcId; method?: string; params?: Record<string, unknown> };

export type McpOptions = {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  env: NodeJS.ProcessEnv;
  pollMs?: number;
  timeoutMs?: number;
};

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

// One batch waits per call, but the read loop stays live: ping, cancellation,
// and EOF all work while an ask_operator call is waiting on the human.
export function serveMcp(opts: McpOptions): { close: () => void } {
  const pending = new Map<RpcId, AbortController>();
  let closed = false;

  const send = (msg: Record<string, unknown>): void => {
    if (!closed) opts.output.write(JSON.stringify(msg) + '\n');
  };
  const reply = (id: RpcId, result: unknown): void => send({ jsonrpc: '2.0', id, result });
  const fail = (id: RpcId | null, code: number, message: string): void =>
    send({ jsonrpc: '2.0', id, error: { code, message } });
  const toolText = (id: RpcId, text: string, isError = false): void =>
    reply(id, { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

  async function callAskOperator(id: RpcId, args: unknown, signal: AbortSignal): Promise<void> {
    const { HIVE_HUB_ROOT: root, HIVE_PROJECT: project, HIVE_AGENT: agent } = opts.env;
    if (!root || !project || !agent) {
      toolText(id, 'ask_operator only works inside a hive-spawned session: HIVE_HUB_ROOT, HIVE_PROJECT, and HIVE_AGENT must be set.', true);
      return;
    }
    let batch: QuestionBatch;
    try {
      batch = await createQuestionBatch(root, { project, agent }, args);
    } catch (e) {
      toolText(id, `the batch was rejected; fix the input and call again: ${e instanceof Error ? e.message : e}`, true);
      return;
    }
    const deadline = Date.now() + (opts.timeoutMs ?? 7 * DAY_MS);
    try {
      for (;;) {
        const current = await readQuestionBatch(root, batch.id);
        if (current.status === 'answered') {
          toolText(id, JSON.stringify({ id: batch.id, status: 'answered', answers: current.answers }));
          return;
        }
        if (current.status === 'cancelled') {
          toolText(id, `the operator cancelled question batch ${batch.id}; do not assume any answer`, true);
          return;
        }
        if (Date.now() > deadline) {
          toolText(id, `question batch ${batch.id} is still open after the wait limit; it stays on the operator's Questions screen`, true);
          return;
        }
        await sleep(opts.pollMs ?? 2000, signal);
      }
    } catch (e) {
      // Aborted by cancellation or EOF: the batch stays open for the operator,
      // and no late response is written to a dead client.
      if (!signal.aborted) {
        toolText(id, `question batch ${batch.id}: the wait failed: ${e instanceof Error ? e.message : e}`, true);
      }
    }
  }

  function handle(req: RpcRequest): void {
    const { method, id } = req;
    const hasId = id !== undefined;
    if (method === 'notifications/initialized') return;
    if (method === 'notifications/cancelled') {
      const target = req.params?.requestId;
      if (typeof target === 'string' || typeof target === 'number') pending.get(target)?.abort();
      return;
    }
    if (!hasId) return;
    if (method === 'initialize') {
      reply(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'hive-operator', version: '1.0.0' } });
      return;
    }
    if (method === 'ping') {
      reply(id, {});
      return;
    }
    if (method === 'tools/list') {
      reply(id, { tools: [ASK_OPERATOR] });
      return;
    }
    if (method === 'tools/call') {
      if (req.params?.name !== ASK_OPERATOR.name) {
        fail(id, -32602, `unknown tool: ${String(req.params?.name)}`);
        return;
      }
      if (pending.size > 0) {
        toolText(id, 'this session is already waiting on an operator batch; one outstanding batch per agent, so the operator never faces a pile from you', true);
        return;
      }
      const controller = new AbortController();
      pending.set(id, controller);
      void callAskOperator(id, req.params.arguments, controller.signal).finally(() => pending.delete(id));
      return;
    }
    fail(id, -32601, `method not found: ${method}`);
  }

  function handleLine(line: string): void {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(null, -32700, 'parse error: one JSON-RPC message per line');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      fail(null, -32600, 'invalid request: a JSON-RPC object is required');
      return;
    }
    const req = parsed as RpcRequest;
    const id = req.id;
    if (id !== undefined && typeof id !== 'string' && typeof id !== 'number') {
      fail(null, -32600, 'invalid request: an id is a string or a number');
      return;
    }
    if (typeof req.method !== 'string' || !req.method) {
      fail(id ?? null, -32600, 'invalid request: a method string is required');
      return;
    }
    if (req.jsonrpc !== '2.0') {
      fail(id ?? null, -32600, 'invalid request: jsonrpc is 2.0');
      return;
    }
    try {
      handle(req);
    } catch (e) {
      fail(id ?? null, -32603, e instanceof Error ? e.message : String(e));
    }
  }

  // A bounded splitter: a line over 1MiB is refused and discarded before it
  // can grow the process, even when no newline ever arrives.
  const MAX_LINE = 1_048_576;
  let buf: Buffer = Buffer.alloc(0);
  let dropping = false;
  const onData = (chunk: Buffer): void => {
    buf = Buffer.concat([buf, chunk]);
    let nl = buf.indexOf(10);
    while (nl >= 0) {
      const line = buf.subarray(0, nl);
      buf = buf.subarray(nl + 1);
      nl = buf.indexOf(10);
      if (dropping) {
        dropping = false;
        continue;
      }
      if (line.length > MAX_LINE) {
        fail(null, -32700, 'parse error: a message over 1MiB is not a question batch');
        continue;
      }
      handleLine(line.toString('utf8').replace(/\r$/, ''));
    }
    if (buf.length > MAX_LINE) {
      if (!dropping) fail(null, -32700, 'parse error: a message over 1MiB is not a question batch');
      dropping = true;
      buf = Buffer.alloc(0);
    }
  };
  opts.input.on('data', onData);
  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const controller of pending.values()) controller.abort();
    pending.clear();
    opts.input.off('data', onData);
  };
  opts.input.on('close', close);
  opts.input.on('end', close);
  return { close };
}

export function main(): void {
  serveMcp({ input: process.stdin, output: process.stdout, env: process.env });
}
