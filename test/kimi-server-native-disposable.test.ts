import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { KimiServerClient } from '../src/kimi-server.js';
import {
  checkVersion,
  launchServer,
  stopProcessGroup,
} from '../tools/kimi-server-spike/probe.js';

const execFileAsync = promisify(execFile);
const disposable = process.env.HIVE_KIMI_NATIVE_DISPOSABLE === '1';
const describeDisposable = disposable ? describe : describe.skip;
const BINARY = '/usr/local/bin/kimi-real';
const PROMPT_ID = 'native-disposable-parent';

export function disposableProviderBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash
    || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('disposable-provider-loopback-required');
  }
  return `${url.origin.replace(/\/+$/, '')}/coding/v1`;
}

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function routingEnvironment(stdout: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const assign = (key: string, value: unknown) => {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string') env[key] = value;
  };
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const values = parsed.env && typeof parsed.env === 'object' ? parsed.env as Record<string, unknown> : parsed;
    for (const [key, value] of Object.entries(values)) assign(key, value);
    return env;
  } catch {
    for (const line of stdout.split('\n')) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/.exec(line);
      if (!match) continue;
      let value = match[2]!.trim();
      if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1);
      assign(match[1]!, value);
    }
    return env;
  }
}

async function readJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 65_536) throw new Error('native-response-too-large');
  const text = await response.text();
  if (Buffer.byteLength(text) > 65_536) throw new Error('native-response-too-large');
  return JSON.parse(text);
}

type SessionStatus = {
  main_turn_active?: boolean;
  last_turn_reason?: string;
  pending_interaction?: string;
};
type PromptQueue = {
  active: { prompt_id: string; status: string } | null;
  queued: { prompt_id: string; status: string }[];
};

async function apiData<T>(origin: string, token: string, pathname: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${origin}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`native-api-http-${response.status}`);
  const envelope = await readJson(response) as { code?: number; data?: T };
  if (envelope.code !== 0) throw new Error(`native-api-code-${envelope.code}`);
  return envelope.data as T;
}

async function diagnostics(origin: string, token: string, parentId: string, client: KimiServerClient): Promise<string> {
  const [session, queue, messages] = await Promise.all([
    apiData<SessionStatus>(origin, token, `/api/v1/sessions/${encodeURIComponent(parentId)}`),
    apiData<PromptQueue>(origin, token, `/api/v1/sessions/${encodeURIComponent(parentId)}/prompts`),
    client.listMessages(parentId, { pageSize: 100 }),
  ]);
  return JSON.stringify({
    activePromptStatus: queue.active?.status ?? null,
    queuedPromptCount: queue.queued.length,
    mainTurnActive: session.main_turn_active ?? null,
    lastTurnReason: session.last_turn_reason ?? null,
    pendingInteraction: session.pending_interaction ?? null,
    userMessageCount: messages.items.filter((message) => message.role === 'user').length,
    assistantMessageCount: messages.items.filter((message) => message.role === 'assistant').length,
  });
}

async function abortAndReconcile(origin: string, token: string, parentId: string, client: KimiServerClient): Promise<void> {
  const queue = await apiData<PromptQueue>(origin, token, `/api/v1/sessions/${encodeURIComponent(parentId)}/prompts`);
  const active = queue.active?.prompt_id === PROMPT_ID;
  const queued = queue.queued.some((prompt) => prompt.prompt_id === PROMPT_ID);
  if (!active && !queued) return;
  try {
    const result = await apiData<{ aborted?: boolean }>(origin, token,
      `/api/v1/sessions/${encodeURIComponent(parentId)}/prompts/${encodeURIComponent(PROMPT_ID)}:abort`,
      { method: 'POST', body: '{}' });
    if (result.aborted !== true) throw new Error('native-abort-failed');
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('40903'))) throw error;
  }
  const deadline = Date.now() + 5_000;
  for (;;) {
    const [session, current] = await Promise.all([
      apiData<SessionStatus>(origin, token, `/api/v1/sessions/${encodeURIComponent(parentId)}`),
      apiData<PromptQueue>(origin, token, `/api/v1/sessions/${encodeURIComponent(parentId)}/prompts`),
    ]);
    const terminal = ['completed', 'cancelled', 'failed'].includes(session.last_turn_reason ?? '');
    if (!current.active && current.queued.length === 0 && session.main_turn_active === false && terminal) return;
    if (Date.now() >= deadline) {
      throw new Error(`native-abort-reconcile-timeout:${await diagnostics(origin, token, parentId, client)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function createParent(origin: string, token: string, home: string): Promise<{ id: string; workspace_id: string }> {
  const response = await fetch(`${origin}/api/v1/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ title: 'Disposable native parent', metadata: { cwd: home } }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('parent-create-failed');
  const envelope = await readJson(response) as { code?: number; data?: { id?: string; workspace_id?: string } };
  if (envelope.code !== 0 || !envelope.data?.id || !envelope.data.workspace_id) throw new Error('parent-create-failed');
  return { id: envelope.data.id, workspace_id: envelope.data.workspace_id };
}

function sameCurrentSnapshot(parent: { id: string; content: unknown }[], fork: { id: string; content: unknown }[], parentId: string, forkId: string): boolean {
  if (parent.length !== fork.length) return false;
  const prefixes = (sessionId: string) => [...new Set([`msg_${sessionId}_`, `msg_${sessionId.replace(/^session_/, '')}_`])];
  const parentPrefixes = prefixes(parentId);
  const forkPrefixes = prefixes(forkId);
  return parent.every((message, index) => {
    const candidate = fork[index];
    if (!candidate || sha(message.content) !== sha(candidate.content)) return false;
    if (message.id === candidate.id) return true;
    return parentPrefixes.some((prefix, prefixIndex) => {
      const suffix = message.id.startsWith(prefix) ? message.id.slice(prefix.length) : '';
      return suffix.length > 0 && candidate.id === `${forkPrefixes[prefixIndex]}${suffix}`;
    });
  });
}

describeDisposable('Kimi Server 2.5.3 disposable native compatibility', () => {
  it('verifies parent, child, fork, and prompt contracts in one fresh home', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'kimi-native-disposable-'));
    let server: Awaited<ReturnType<typeof launchServer>> | undefined;
    let parentId: string | undefined;
    let cleanupFailed = false;
    let cleanupError: unknown;
    try {
      const routing = await execFileAsync('teamkimi', ['env', '--no-mitm'], {
        encoding: 'utf8', timeout: 10_000, maxBuffer: 65_536,
      });
      const env = { ...routingEnvironment(routing.stdout), HOME: home, KIMI_CODE_HOME: home, PATH: process.env.PATH ?? '' };
      if (typeof env.KIMI_BASE_URL !== 'string' || env.KIMI_BASE_URL.length === 0) throw new Error('native-routing-unavailable');
      const providerBaseUrl = disposableProviderBaseUrl(env.KIMI_BASE_URL);
      await fs.writeFile(path.join(home, 'config.toml'), `default_model = "kimi-code/k3.1-pro"
default_permission_mode = "auto"
telemetry = false
[providers."managed:kimi-code"]
type = "kimi"
api_key = ""
base_url = ${JSON.stringify(providerBaseUrl)}
[models."kimi-code/k3.1-pro"]
provider = "managed:kimi-code"
model = "k3.1-pro-highspeed"
max_context_size = 1048576
capabilities = ["thinking", "always_thinking", "image_in", "video_in", "tool_use"]
`, { mode: 0o600 });
      try {
        await checkVersion(BINARY, home, env);
      } catch (error) {
        if (error instanceof Error && error.message === 'process-cleanup-failed') cleanupFailed = true;
        throw error;
      }

      try {
        server = await launchServer(BINARY, home, env);
      } catch (error) {
        if (error instanceof Error && error.message === 'process-cleanup-failed') cleanupFailed = true;
        throw error;
      }
      const client = new KimiServerClient({ origin: server.origin, token: server.token, deadlineMs: 15_000 });
      const parent = await createParent(server.origin, server.token, home);
      parentId = parent.id;
      const catalog = await apiData<{ items?: { model?: unknown }[] }>(server.origin, server.token, '/api/v1/models');
      const advertised = new Set((catalog.items ?? []).map((item) => item.model).filter((id): id is string => typeof id === 'string'));
      const modelAlias = advertised.has('kimi-code/k3.1-pro')
        ? 'kimi-code/k3.1-pro'
        : advertised.has('kimi-code/k3') ? 'kimi-code/k3' : undefined;
      if (!modelAlias) throw new Error(`native-model-unavailable:${JSON.stringify({ modelsCount: advertised.size })}`);
      await apiData(server.origin, server.token, `/api/v1/sessions/${encodeURIComponent(parent.id)}/profile`, {
        method: 'POST',
        body: JSON.stringify({ agent_config: { model: modelAlias } }),
      });
      const ack = await client.submitPrompt(parent.id, {
        promptId: PROMPT_ID,
        content: [{ type: 'text', text: 'Reply with the single word OK.' }],
      });
      expect({ promptId: ack.prompt_id, userMessageId: ack.user_message_id, status: ack.status, contentHash: sha(ack.content) }).toEqual({
        promptId: PROMPT_ID,
        userMessageId: expect.any(String),
        status: expect.stringMatching(/^(queued|running|blocked)$/),
        contentHash: sha([{ type: 'text', text: 'Reply with the single word OK.' }]),
      });
      expect(sha(ack.created_at)).toMatch(/^[a-f0-9]{64}$/);

      const deadline = Date.now() + 85_000;
      let parentMessages: Awaited<ReturnType<typeof client.listMessages>>['items'] = [];
      for (;;) {
        const [session] = await Promise.all([
          apiData<SessionStatus>(server.origin, server.token, `/api/v1/sessions/${encodeURIComponent(parent.id)}`),
          apiData<PromptQueue>(server.origin, server.token, `/api/v1/sessions/${encodeURIComponent(parent.id)}/prompts`),
        ]);
        parentMessages = (await client.listMessages(parent.id, { pageSize: 100 })).items;
        const userPresent = parentMessages.some((message) => message.id === ack.user_message_id && message.role === 'user');
        const assistantPresent = parentMessages.some((message) => message.role === 'assistant');
        if (session.pending_interaction && session.pending_interaction !== 'none') {
          throw new Error(`native-parent-interaction:${await diagnostics(server.origin, server.token, parent.id, client)}`);
        }
        if (session.last_turn_reason === 'failed' || session.last_turn_reason === 'cancelled') {
          throw new Error(`native-parent-turn-failed:${await diagnostics(server.origin, server.token, parent.id, client)}`);
        }
        if (session.last_turn_reason === 'completed' && userPresent && assistantPresent) break;
        if (session.last_turn_reason === 'completed' && !assistantPresent) {
          throw new Error(`native-parent-missing-assistant:${await diagnostics(server.origin, server.token, parent.id, client)}`);
        }
        if (Date.now() >= deadline) {
          throw new Error(`native-parent-response-timeout:${await diagnostics(server.origin, server.token, parent.id, client)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect((await client.getSession(parent.id)).id).toBe(parent.id);
      expect(parentMessages.some((message) => message.id === ack.user_message_id && message.role === 'user')).toBe(true);
      expect(parentMessages.some((message) => message.role === 'assistant')).toBe(true);

      const child = await client.createChild(parent.id, {
        title: 'Disposable native child', metadata: { hive_branch_id: 'native-disposable-child' },
      });
      expect({
        id: child.id,
        parentId: child.metadata.parent_session_id,
        kind: child.metadata.child_session_kind,
        hiveBranchId: child.metadata.hive_branch_id,
        workspaceId: child.workspace_id,
        cwdHash: sha(child.metadata.cwd),
      }).toEqual({
        id: expect.any(String),
        parentId: parent.id,
        kind: 'child',
        hiveBranchId: 'native-disposable-child',
        workspaceId: parent.workspace_id,
        cwdHash: sha(home),
      });
      const children = await client.listChildren(parent.id, { pageSize: 100 });
      expect(children.items.some((session) => session.id === child.id)).toBe(true);
      expect(children.items.filter((session) => session.id === child.id)).toHaveLength(1);

      const fork = await client.forkSession(parent.id, {
        title: 'Disposable native fork', metadata: { hive_branch_id: 'native-disposable-fork' },
      });
      expect(fork.metadata.hive_branch_id).toBe('native-disposable-fork');
      const forkMessages = (await client.listMessages(fork.id, { pageSize: 100 })).items;
      expect(sameCurrentSnapshot(parentMessages, forkMessages, parent.id, fork.id)).toBe(true);
    } finally {
      if (server && parentId) {
        try {
          await abortAndReconcile(server.origin, server.token, parentId, new KimiServerClient({
            origin: server.origin, token: server.token, deadlineMs: 5_000,
          }));
        } catch (error) {
          cleanupFailed = true;
          cleanupError = error;
        }
      }
      if (server) {
        try {
          await stopProcessGroup(server.child);
        } catch (error) {
          cleanupFailed = true;
          cleanupError ??= error;
        }
      }
      if (!cleanupFailed) await fs.rm(home, { recursive: true, force: true });
      if (cleanupError) throw cleanupError;
    }
  }, 120_000);
});

describe('disposableProviderBaseUrl', () => {
  it('allows only numeric loopback HTTP and appends coding/v1 exactly once', () => {
    expect(disposableProviderBaseUrl('http://127.0.0.1:3466')).toBe('http://127.0.0.1:3466/coding/v1');
    expect(disposableProviderBaseUrl('http://127.0.0.1:3466/')).toBe('http://127.0.0.1:3466/coding/v1');
  });

  it('normalizes localhost to numeric loopback before applying all other checks', () => {
    expect(disposableProviderBaseUrl('http://localhost:3466')).toBe('http://127.0.0.1:3466/coding/v1');
  });

  it.each([
    'http://192.0.2.10:3466',
    'http://user:pass@127.0.0.1:3466',
    'http://127.0.0.1:3466/?route=one',
    'http://127.0.0.1:3466/#token=secret',
    'https://127.0.0.1:3466',
  ])('rejects unsafe or non-loopback input %s', (value) => {
    expect(() => disposableProviderBaseUrl(value)).toThrow();
  });
});
