import type {
  NativeBranchClient,
  NativeMessage,
  NativePrompt,
  NativeSession,
  NativeTextPart,
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
  const metadata = object(session.metadata, 'session.metadata');
  stringField(metadata.cwd, 'session.metadata.cwd');
  optionalString(metadata.hive_branch_id, 'session.metadata.hive_branch_id');
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

export class KimiServerClient implements NativeBranchClient {
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
  async createChild(sessionId: string, input: { title: string; metadata: Record<string, unknown> }): Promise<NativeSession> {
    return parseSession(await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/children`, {
      method: 'POST', body: { title: input.title, metadata: input.metadata },
    }));
  }
  async forkSession(sessionId: string, input: { title: string; metadata: Record<string, unknown> }): Promise<NativeSession> {
    return parseSession(await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}:fork`, {
      method: 'POST', body: { title: input.title, metadata: input.metadata },
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
  async submitPrompt(sessionId: string, input: { promptId: string; content: NativeTextPart[] }): Promise<NativePrompt> {
    if (!input.promptId || input.content.length === 0) throw new Error('a prompt id and one text part are required');
    const prompt = object(await this.request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts`, {
      method: 'POST', body: { prompt_id: input.promptId, content: input.content },
    }), 'prompt');
    stringField(prompt.prompt_id, 'prompt.prompt_id');
    stringField(prompt.user_message_id, 'prompt.user_message_id');
    if (!['running', 'queued', 'blocked'].includes(String(prompt.status))) throw schemaError('prompt.status is invalid');
    parseContent(prompt.content, 'prompt.content');
    stringField(prompt.created_at, 'prompt.created_at');
    return prompt as unknown as NativePrompt;
  }
}
