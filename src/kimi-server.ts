import type {
  DaydreamNativeClient,
  NativeBranchCreateRequest,
  NativeMessage,
  NativePrompt,
  NativePromptInput,
  NativeServerMeta,
  NativeSession,
  NativeTranscriptOps,
  NativeTranscriptPage,
  NativeTranscriptWatermark,
} from './types.js';

const DEFAULT_DEADLINE_MS = 10_000;
const DEFAULT_RESPONSE_BYTES = 1024 * 1024;

type ClientOptions = {
  origin: string;
  token: string;
  fetch?: typeof fetch;
  deadlineMs?: number;
  maxResponseBytes?: number;
};
type RequestOptions = { method?: 'GET' | 'POST'; query?: Record<string, string | number | undefined>; body?: unknown };

function schemaError(message: string): Error {
  return new Error(`native response schema: ${message}`);
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw schemaError(`${field} must be an object`);
  return value as Record<string, unknown>;
}
function stringField(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw schemaError(`${field} must be a non-empty string`);
  return value;
}
function booleanField(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw schemaError(`${field} must be boolean`);
  return value;
}
function optionalString(value: unknown, field: string): void {
  if (value !== undefined) stringField(value, field);
}
function parseSession(value: unknown): NativeSession {
  const session = object(value, 'session');
  stringField(session.id, 'session.id');
  stringField(session.workspace_id, 'session.workspace_id');
  if (session.read_only !== undefined) {
    const policy = object(session.read_only, 'session.read_only');
    if (policy.filesystem !== 'read-only' || policy.shell !== 'denied' || policy.side_effects !== 'denied'
      || JSON.stringify(policy.tools) !== JSON.stringify(['Read', 'Grep', 'Glob'])) {
      throw schemaError('session.read_only is not the required effective policy');
    }
  }
  const metadata = object(session.metadata, 'session.metadata');
  stringField(metadata.cwd, 'session.metadata.cwd');
  optionalString(metadata.hive_branch_id, 'session.metadata.hive_branch_id');
  optionalString(metadata.hive_daydream_id, 'session.metadata.hive_daydream_id');
  optionalString(metadata.parent_session_id, 'session.metadata.parent_session_id');
  optionalString(metadata.child_session_kind, 'session.metadata.child_session_kind');
  return session as unknown as NativeSession;
}
function parseContent(value: unknown, field: string): { type: string; [key: string]: unknown }[] {
  if (!Array.isArray(value)) throw schemaError(`${field} must be an array`);
  return value.map((part, index) => {
    const parsed = object(part, `${field}[${index}]`);
    stringField(parsed.type, `${field}[${index}].type`);
    if (parsed.type === 'text' && typeof parsed.text !== 'string') throw schemaError(`${field}[${index}].text must be a string`);
    return parsed as { type: string; [key: string]: unknown };
  });
}
function parseMessage(value: unknown): NativeMessage {
  const message = object(value, 'message');
  stringField(message.id, 'message.id');
  stringField(message.session_id, 'message.session_id');
  if (!['user', 'assistant', 'tool', 'system'].includes(String(message.role))) throw schemaError('message.role is invalid');
  parseContent(message.content, 'message.content');
  stringField(message.created_at, 'message.created_at');
  return message as unknown as NativeMessage;
}
function parsePage(value: unknown, field: string): { items: unknown[]; has_more: boolean } {
  const page = object(value, field);
  if (!Array.isArray(page.items)) throw schemaError(`${field}.items must be an array`);
  const hasMore = booleanField(page.has_more, `${field}.has_more`);
  return { items: page.items, has_more: hasMore };
}
function boundedString(value: unknown, field: string, cap: number): string {
  const parsed = stringField(value, field);
  if (parsed.length > cap) throw schemaError(`${field} exceeds the ${cap} character limit`);
  return parsed;
}
function sequence(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw schemaError(`${field} must be a non-negative safe integer`);
  return Number(value);
}
function parseTranscriptOps(value: unknown): NativeTranscriptOps {
  const data = object(value, 'transcript ops');
  const agentId = boundedString(data.agent_id, 'transcript ops.agent_id', 200);
  if (!Array.isArray(data.batches) || data.batches.length > 100) throw schemaError('transcript ops.batches must contain at most 100 entries');
  let previous = -1;
  const batches = data.batches.map((entry, index) => {
    const batch = object(entry, `transcript ops.batches[${index}]`);
    const seq = sequence(batch.seq, `transcript ops.batches[${index}].seq`);
    if (seq <= previous) throw schemaError('transcript op sequence must be strictly increasing');
    previous = seq;
    if (!Array.isArray(batch.ops) || batch.ops.length > 100) throw schemaError('transcript op batch must contain at most 100 ops');
    return {
      seq,
      ops: batch.ops.map((op, opIndex) => {
        const parsed = object(op, `transcript ops.batches[${index}].ops[${opIndex}]`);
        if (parsed.type !== undefined) boundedString(parsed.type, 'transcript op.type', 200);
        return parsed as NativeTranscriptOps['batches'][number]['ops'][number];
      }),
    };
  });
  const latestSeq = sequence(data.latest_seq, 'transcript ops.latest_seq');
  if (batches.length > 0 && latestSeq < batches.at(-1)!.seq) throw schemaError('transcript latest_seq conflicts with batches');
  return { agent_id: agentId, batches, latest_seq: latestSeq, complete: booleanField(data.complete, 'transcript ops.complete') };
}
function parseTranscriptPrompt(value: unknown, index: number): NativeTranscriptPage['prompts'][number] {
  const prompt = object(value, `transcript.prompts[${index}]`);
  const content = parseContent(prompt.content, `transcript.prompts[${index}].content`);
  if (content.some((part) => part.type !== 'text')) throw schemaError('transcript prompt content must contain only text parts');
  return {
    promptId: boundedString(prompt.promptId, 'transcript prompt.promptId', 200),
    status: boundedString(prompt.status, 'transcript prompt.status', 40),
    userMessageId: boundedString(prompt.userMessageId, 'transcript prompt.userMessageId', 200),
    content: content as NativeTranscriptPage['prompts'][number]['content'],
  };
}
function parseTranscriptTurn(item: Record<string, unknown>, itemIndex: number): NativeTranscriptPage['items'][number] {
  if (!Array.isArray(item.steps) || item.steps.length > 100) throw schemaError('transcript turn steps must contain at most 100 entries');
  if (item.wedged !== undefined && typeof item.wedged !== 'boolean') throw schemaError('transcript turn.wedged must be boolean');
  return {
    kind: 'turn' as const,
    turnId: boundedString(item.turnId, 'transcript turn.turnId', 200),
    ...(item.triggerPromptId === undefined ? {} : { triggerPromptId: boundedString(item.triggerPromptId, 'transcript turn.triggerPromptId', 200) }),
    state: boundedString(item.state, 'transcript turn.state', 40),
    ...(item.wedged === undefined ? {} : { wedged: item.wedged as boolean }),
    steps: item.steps.map((step, stepIndex) => {
      const parsedStep = object(step, `transcript.items[${itemIndex}].steps[${stepIndex}]`);
      if (!Array.isArray(parsedStep.frames) || parsedStep.frames.length > 100) throw schemaError('transcript step frames must contain at most 100 entries');
      return {
        stepId: boundedString(parsedStep.stepId, 'transcript step.stepId', 200),
        frames: parsedStep.frames.map((frame, frameIndex) => {
          const parsedFrame = object(frame, `transcript.items[${itemIndex}].steps[${stepIndex}].frames[${frameIndex}]`);
          return {
            frameId: boundedString(parsedFrame.frameId, 'transcript frame.frameId', 200),
            kind: boundedString(parsedFrame.kind, 'transcript frame.kind', 100),
            ...(parsedFrame.role === undefined ? {} : { role: boundedString(parsedFrame.role, 'transcript frame.role', 100) }),
            ...(parsedFrame.text === undefined ? {} : { text: boundedString(parsedFrame.text, 'transcript frame.text', 65_536) }),
          };
        }),
      };
    }),
  };
}
function parseTranscriptRoster(value: unknown): NativeTranscriptPage['agents'] {
  if (!Array.isArray(value) || value.length > 100) throw schemaError('transcript.agents must contain at most 100 entries');
  return value.map((entry, index) => {
    const agent = object(entry, `transcript.agents[${index}]`);
    if (agent.type !== undefined && !['main', 'sub', 'independent'].includes(String(agent.type))) {
      throw schemaError('transcript agent type is invalid');
    }
    return {
      agentId: boundedString(agent.agentId, `transcript.agents[${index}].agentId`, 200),
      ...(agent.type === undefined ? {} : { type: agent.type as 'main' | 'sub' | 'independent' }),
    };
  });
}
function parseTranscript(value: unknown): NativeTranscriptPage {
  const data = object(value, 'transcript');
  const agentId = boundedString(data.agent_id, 'transcript.agent_id', 200);
  if (!Array.isArray(data.prompts) || data.prompts.length > 100) throw schemaError('transcript.prompts must contain at most 100 entries');
  const prompts = data.prompts.map(parseTranscriptPrompt);
  if (!Array.isArray(data.items) || data.items.length > 100) throw schemaError('transcript.items must contain at most 100 entries');
  const items = data.items.map((entry, itemIndex) => {
    const item = object(entry, `transcript.items[${itemIndex}]`);
    return item.kind === 'turn' ? parseTranscriptTurn(item, itemIndex) : item as NativeTranscriptPage['items'][number];
  });
  const agents = parseTranscriptRoster(data.agents);
  return {
    agent_id: agentId,
    prompts,
    items,
    has_more: booleanField(data.has_more, 'transcript.has_more'),
    agents,
    ...(data.seq === undefined ? {} : { seq: sequence(data.seq, 'transcript.seq') }),
  };
}
async function readBounded(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error('native response exceeds byte limit');
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > limit) throw new Error('native response exceeds byte limit');
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error('native response exceeds byte limit');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

export class KimiServerClient implements DaydreamNativeClient {
  private readonly origin: string;
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  private readonly deadlineMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: ClientOptions) {
    const url = new URL(options.origin);
    if (url.protocol !== 'http:' || !['127.0.0.1', '::1'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('native server origin must be loopback HTTP');
    }
    if (!options.token) throw new Error('native server bearer token is required');
    this.origin = url.origin;
    this.token = options.token;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.deadlineMs = Math.min(Math.max(options.deadlineMs ?? DEFAULT_DEADLINE_MS, 1), 60_000);
    this.maxResponseBytes = Math.min(Math.max(options.maxResponseBytes ?? DEFAULT_RESPONSE_BYTES, 1), DEFAULT_RESPONSE_BYTES);
  }

  private async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    const url = new URL(`${this.origin}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deadlineMs);
    try {
      const response = await this.fetcher(url, {
        method: options.method ?? 'GET',
        headers: {
          accept: 'application/json', authorization: `Bearer ${this.token}`,
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: 'error', signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) throw new Error('native response redirect refused');
      if (!response.ok) throw new Error(`native HTTP error ${response.status}`);
      const raw = await readBounded(response, this.maxResponseBytes);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw schemaError('malformed JSON');
      }
      const envelope = object(parsed, 'envelope');
      if (!Number.isInteger(envelope.code)) throw schemaError('envelope.code must be an integer');
      if (typeof envelope.msg !== 'string') throw schemaError('envelope.msg must be a string');
      stringField(envelope.request_id, 'envelope.request_id');
      if (envelope.code !== 0) throw new Error(`native business error ${envelope.code}: ${envelope.msg}`);
      return envelope.data;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('native request deadline exceeded');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async getSession(sessionId: string): Promise<NativeSession> {
    return parseSession(await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}`));
  }
  async createChild(sessionId: string, input: NativeBranchCreateRequest): Promise<NativeSession> {
    return parseSession(await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/children`, {
      method: 'POST',
      body: { title: input.title, metadata: input.metadata, ...(input.readOnly ? { read_only: input.readOnly } : {}) },
    }));
  }
  async forkSession(sessionId: string, input: NativeBranchCreateRequest): Promise<NativeSession> {
    return parseSession(await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}:fork`, {
      method: 'POST',
      body: { title: input.title, metadata: input.metadata, ...(input.readOnly ? { read_only: input.readOnly } : {}) },
    }));
  }
  async listChildren(sessionId: string, options: { pageSize?: number } = {}): Promise<{ items: NativeSession[]; has_more: boolean }> {
    const pageSize = options.pageSize ?? 100;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('child page size must be 1..100');
    const page = parsePage(await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/children`, {
      query: { page_size: pageSize },
    }), 'child page');
    return { items: page.items.map(parseSession), has_more: page.has_more };
  }
  async listMessages(sessionId: string, options: {
    beforeId?: string;
    pageSize?: number;
    role?: 'user' | 'assistant' | 'tool' | 'system';
  } = {}): Promise<{ items: NativeMessage[]; has_more: boolean }> {
    const pageSize = options.pageSize ?? 50;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('message page size must be 1..100');
    const page = parsePage(await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
      query: { before_id: options.beforeId, page_size: pageSize, role: options.role },
    }), 'message page');
    return { items: page.items.map(parseMessage), has_more: page.has_more };
  }
  async submitPrompt(sessionId: string, input: NativePromptInput): Promise<NativePrompt> {
    if (!input.promptId || input.content.length === 0) throw new Error('a prompt id and one text part are required');
    if (input.permissionMode !== undefined && input.permissionMode !== 'manual') throw new Error('daydream permission mode must be manual');
    if (input.agentId !== undefined && !input.agentId) throw new Error('native agent id is required when supplied');
    const prompt = object(await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts`, {
      method: 'POST',
      body: {
        prompt_id: input.promptId,
        content: input.content,
        ...(input.agentId === undefined ? {} : { agent_id: input.agentId }),
        ...(input.permissionMode === undefined ? {} : { permission_mode: input.permissionMode }),
      },
    }), 'prompt');
    stringField(prompt.prompt_id, 'prompt.prompt_id');
    stringField(prompt.user_message_id, 'prompt.user_message_id');
    if (!['running', 'queued', 'blocked'].includes(String(prompt.status))) throw schemaError('prompt.status is invalid');
    parseContent(prompt.content, 'prompt.content');
    stringField(prompt.created_at, 'prompt.created_at');
    return prompt as unknown as NativePrompt;
  }
  async createBtw(sessionId: string): Promise<{ agent_id: string }> {
    const result = object(await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}:btw`, { method: 'POST' }), 'btw result');
    return { agent_id: boundedString(result.agent_id, 'btw result.agent_id', 200) };
  }
  async getTranscript(sessionId: string, input: { agentId: string; pageSize: number }): Promise<NativeTranscriptPage> {
    if (!/^[A-Za-z0-9._-]+$/.test(input.agentId)) throw new Error('transcript agent id is invalid');
    if (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100) throw new Error('transcript page size must be 1..100');
    return parseTranscript(await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/transcript`, {
      query: { agent_id: input.agentId, page_size: input.pageSize },
    }));
  }
  async getServerMeta(): Promise<NativeServerMeta> {
    const meta = object(await this.request('/api/v1/meta'), 'server meta');
    return {
      server_id: boundedString(meta.server_id, 'server meta.server_id', 200),
      started_at: boundedString(meta.started_at, 'server meta.started_at', 40),
    };
  }
  async getTranscriptWatermark(sessionId: string, input: { agentId: string; pageSize: number }): Promise<NativeTranscriptWatermark> {
    if (!/^[A-Za-z0-9._-]+$/.test(input.agentId)) throw new Error('transcript agent id is invalid');
    if (!Number.isInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100) throw new Error('transcript page size must be 1..100');
    const page = object(await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/transcript`, {
      query: { agent_id: input.agentId, page_size: input.pageSize },
    }), 'transcript watermark');
    return {
      agent_id: boundedString(page.agent_id, 'transcript watermark.agent_id', 200),
      seq: sequence(page.seq, 'transcript watermark.seq'),
    };
  }
  async compactSession(sessionId: string, input: { instruction: string }): Promise<Record<string, never>> {
    if (input.instruction.length > 16_000) throw new Error('compaction instruction is too large');
    object(await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}:compact`, {
      method: 'POST', body: { instruction: input.instruction },
    }), 'compaction acknowledgement');
    return {};
  }
  async listTranscriptOps(sessionId: string, input: { agentId: string; sinceSeq: number }): Promise<NativeTranscriptOps> {
    if (!/^[A-Za-z0-9._-]+$/.test(input.agentId)) throw new Error('transcript agent id is invalid');
    sequence(input.sinceSeq, 'transcript sinceSeq');
    return parseTranscriptOps(await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/transcript/ops`, {
      query: { agent_id: input.agentId, since_seq: input.sinceSeq },
    }));
  }
}
