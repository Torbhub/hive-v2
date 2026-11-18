import { describe, expect, it, vi } from 'vitest';
import { KimiServerClient } from '../src/kimi-server.js';

const ORIGIN = 'http://127.0.0.1:58627';
const TOKEN = 'synthetic-native-token';

function nativeSession(id: string) {
  return {
    id,
    workspace_id: 'workspace_test',
    metadata: {
      cwd: '/tmp/hive-native-test', hive_branch_id: '7ca3c50b-8304-45f0-a925-f41d10a14cf2',
      parent_session_id: 'session_parent', child_session_kind: 'child',
    },
  };
}

function envelope(data: unknown, code = 0) {
  return { code, msg: code === 0 ? 'success' : 'conflict', data, request_id: '01JZX4A6E7M8V0R3Q0N2K2M5Q9' };
}

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

function client(fetcher: typeof fetch, options: { deadlineMs?: number; maxResponseBytes?: number } = {}) {
  return new KimiServerClient({ origin: ORIGIN, token: TOKEN, fetch: fetcher, ...options });
}

describe('Kimi Server 2.5.3 native client', () => {
  it('uses exact child, fork, and child-discovery routes with only consumed session fields', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      const data = calls.length === 3 ? { items: [nativeSession('session_child')], has_more: false } : nativeSession(calls.length === 1 ? 'session_child' : 'session_fork');
      return jsonResponse(envelope(data));
    };
    const api = client(fetcher);

    await expect(api.createChild('session_parent', {
      title: 'Hive child', metadata: { hive_branch_id: '7ca3c50b-8304-45f0-a925-f41d10a14cf2' },
    })).resolves.toMatchObject({ id: 'session_child', workspace_id: 'workspace_test' });
    await api.forkSession('session_parent', {
      title: 'Hive fork', metadata: { hive_branch_id: '7ca3c50b-8304-45f0-a925-f41d10a14cf2' },
    });
    await api.listChildren('session_parent', { pageSize: 100 });

    expect(calls.map((call) => [new URL(call.url).pathname, call.init?.method])).toEqual([
      ['/api/v1/sessions/session_parent/children', 'POST'],
      ['/api/v1/sessions/session_parent:fork', 'POST'],
      ['/api/v1/sessions/session_parent/children', 'GET'],
    ]);
    expect(JSON.parse(String(calls[0].init?.body))).not.toHaveProperty('turn_index');
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      title: 'Hive fork', metadata: { hive_branch_id: '7ca3c50b-8304-45f0-a925-f41d10a14cf2' },
    });
    expect(new URL(calls[2].url).searchParams.get('page_size')).toBe('100');
  });

  it('pages flattened history with before_id only and accepts messages without parent_message_id', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const message = {
      id: 'msg_new', session_id: 'session_parent', role: 'user',
      content: [{ type: 'text', text: 'selected findings' }], created_at: '2026-11-18T12:01:00.000Z',
    };
    const prompt = {
      prompt_id: 'hive-rejoin-test', user_message_id: 'msg_new', status: 'queued',
      content: message.content, created_at: message.created_at,
    };
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse(envelope(calls.length === 1 ? { items: [message], has_more: false } : prompt));
    };
    const api = client(fetcher);

    await expect(api.listMessages('session_parent', { beforeId: 'msg_old', pageSize: 25, role: 'user' }))
      .resolves.toEqual({ items: [message], has_more: false });
    await api.submitPrompt('session_parent', { promptId: 'hive-rejoin-test', content: message.content });

    const url = new URL(calls[0].url);
    expect(url.pathname).toBe('/api/v1/sessions/session_parent/messages');
    expect(Object.fromEntries(url.searchParams)).toEqual({ before_id: 'msg_old', page_size: '25', role: 'user' });
    expect(url.searchParams.has('after_id')).toBe(false);
    expect(new URL(calls[1].url).pathname).toBe('/api/v1/sessions/session_parent/prompts');
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ prompt_id: 'hive-rejoin-test', content: message.content });
  });

  it('authenticates every request and refuses non-loopback origins before fetching', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(envelope(nativeSession('session_parent'))));
    await client(fetcher).getSession('session_parent');
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(() => new KimiServerClient({ origin: 'http://192.0.2.10:58627', token: TOKEN, fetch: fetcher }))
      .toThrow(/loopback/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('bounds response bytes and rejects redirects without following them', async () => {
    const oversized = client(async () => new Response('x'.repeat(65)), { maxResponseBytes: 64 });
    await expect(oversized.getSession('session_parent')).rejects.toThrow(/response.*(limit|oversize)|oversize.*response/i);

    let init: RequestInit | undefined;
    const redirected = client(async (_input, requestInit) => {
      init = requestInit;
      return new Response(null, { status: 302, headers: { location: `${ORIGIN}/elsewhere` } });
    });
    await expect(redirected.getSession('session_parent')).rejects.toThrow(/redirect/);
    expect(init?.redirect).toBe('error');
  });

  it('aborts a request at its deadline', async () => {
    const pending: typeof fetch = (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
    await expect(client(pending, { deadlineMs: 5 }).getSession('session_parent')).rejects.toThrow(/deadline|timeout/);
  });

  it('checks the business code on HTTP 200 and rejects malformed consumed session fields', async () => {
    const conflict = client(async () => jsonResponse(envelope(nativeSession('session_parent'), 40901)));
    await expect(conflict.getSession('session_parent')).rejects.toThrow(/40901/);
    const malformed = client(async () => jsonResponse(envelope({ ...nativeSession('session_parent'), workspace_id: 17 })));
    await expect(malformed.getSession('session_parent')).rejects.toThrow(/schema|invalid|malformed/);
  });

  it('rejects malformed message pages, child pages, and prompt acknowledgements', async () => {
    const badPage = client(async () => jsonResponse(envelope({ items: [{ id: 'msg_new', content: 'not-parts' }], has_more: false })));
    await expect(badPage.listMessages('session_parent')).rejects.toThrow(/schema|invalid|malformed/);
    await expect(badPage.listChildren('session_parent')).rejects.toThrow(/schema|invalid|malformed/);

    const badPrompt = client(async () => jsonResponse(envelope({ prompt_id: 'hive-rejoin-test', status: 'done', content: [] })));
    await expect(badPrompt.submitPrompt('session_parent', {
      promptId: 'hive-rejoin-test', content: [{ type: 'text', text: 'selected findings' }],
    })).rejects.toThrow(/schema|invalid|malformed/);
  });
});
