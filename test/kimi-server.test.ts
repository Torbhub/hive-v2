import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { KimiServerClient } from '../src/kimi-server.js';
import type { DaydreamStatus, NativePromptInput } from '../src/types.js';

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

  it('creates a native BTW and submits only agent and manual fields', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const prompt = {
      prompt_id: 'hive-daydream-mine', user_message_id: 'msg_mine', status: 'queued',
      content: [{ type: 'text', text: 'Mine the bounded facts.' }], created_at: '2026-11-19T12:00:00.000Z',
    };
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse(envelope(calls.length === 1 ? { agent_id: 'agent_btw_1' } : prompt));
    };
    const api = client(fetcher);

    await expect(api.createBtw('session_child')).resolves.toEqual({ agent_id: 'agent_btw_1' });
    await api.submitPrompt('session_child', {
      promptId: 'hive-daydream-mine',
      content: [{ type: 'text', text: 'Mine the bounded facts.' }],
      agentId: 'agent_btw_1',
      permissionMode: 'manual',
    });

    expect(new URL(calls[0].url).pathname).toBe('/api/v1/sessions/session_child:btw');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.body).toBeUndefined();
    const body = JSON.parse(String(calls[1].init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      prompt_id: 'hive-daydream-mine',
      content: [{ type: 'text', text: 'Mine the bounded facts.' }],
      agent_id: 'agent_btw_1',
      permission_mode: 'manual',
    });
    expect(body).not.toHaveProperty('profile');
    expect(body).not.toHaveProperty('disabled_tools');
  });

  it('reads per-agent turns, prompts, frames, roster, and live sequence from transcript', async () => {
    const transcript = {
      agent_id: 'agent_btw_1',
      prompts: [{
        promptId: 'hive-daydream-mine', status: 'completed', userMessageId: 'msg_mine',
        content: [{ type: 'text', text: 'Mine the bounded facts.' }],
      }],
      items: [
        { kind: 'marker', marker: 'compaction', payload: { phase: 'completed' } },
        {
          kind: 'turn',
          turnId: 'turn_btw_1',
          triggerPromptId: 'hive-daydream-mine',
          state: 'completed',
          steps: [{
            stepId: 'step_btw_1',
            frames: [
              { frameId: 'frame_tool', kind: 'tool.call' },
              { frameId: 'frame_brief', kind: 'text', role: 'assistant', text: '{"schemaVersion":1}' },
            ],
          }],
        },
        { kind: 'turn', turnId: 'turn_unrelated', state: 'running', steps: [] },
      ],
      has_more: false,
      agents: [{ agentId: 'main', type: 'main' }, { agentId: 'agent_btw_1', type: 'sub' }],
      seq: 11,
    };
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/api/v1/sessions/session_child/transcript');
      expect(Object.fromEntries(url.searchParams)).toEqual({ agent_id: 'agent_btw_1', page_size: '10' });
      return jsonResponse(envelope(transcript));
    };
    const page = await client(fetcher).getTranscript('session_child', { agentId: 'agent_btw_1', pageSize: 10 });
    expect(page).toEqual(transcript);
    expect(page.items.find((item) => item.kind === 'turn' && item.turnId === 'turn_unrelated'))
      .not.toHaveProperty('triggerPromptId');
  });

  it('preserves same-prompt turn candidates and pagination for terminal selection', async () => {
    const prompt = {
      promptId: 'hive-daydream-mine', status: 'completed', userMessageId: 'msg_mine',
      content: [{ type: 'text', text: 'Mine the bounded facts.' }],
    };
    const turns = [
      {
        kind: 'turn', turnId: 'turn_btw_1', triggerPromptId: prompt.promptId, state: 'completed',
        steps: [{ stepId: 'step_btw_1', frames: [{ frameId: 'frame_brief', kind: 'text', role: 'assistant', text: '{"schemaVersion":1}' }] }],
      },
      { kind: 'turn', turnId: 'turn_btw_2', triggerPromptId: prompt.promptId, state: 'running', steps: [] },
    ];
    const transcript = {
      agent_id: 'agent_btw_1',
      prompts: [prompt],
      items: [{ kind: 'marker', marker: 'compaction', payload: { phase: 'completed' } }, ...turns],
      has_more: true,
      agents: [{ agentId: 'main', type: 'main' }, { agentId: 'agent_btw_1', type: 'sub' }],
      seq: 12,
    };
    const page = await client(async () => jsonResponse(envelope(transcript)))
      .getTranscript('session_child', { agentId: 'agent_btw_1', pageSize: 10 });
    expect(page).toEqual(transcript);
    expect(page.items.filter((item) => item.kind === 'turn')).toEqual(turns);
    expect(page.has_more).toBe(true);
  });

  it('rejects malformed BTW identity, prompt, turn, frame, roster, and live sequence fields', async () => {
    await expect(client(async () => jsonResponse(envelope({ agent_id: '' }))).createBtw('session_child'))
      .rejects.toThrow(/schema|invalid|agent/);
    const malformed = [
      { agent_id: 'agent_btw_1', prompts: [], items: [{ kind: 'turn', turnId: 17 }], has_more: false, agents: [], seq: 1 },
      {
        agent_id: 'agent_btw_1',
        prompts: [{ promptId: 'p', status: 'completed', userMessageId: 17, content: [] }],
        items: [], has_more: false, agents: [], seq: 1,
      },
      {
        agent_id: 'agent_btw_1',
        prompts: [],
        items: [{
          kind: 'turn', turnId: 'turn_1', triggerPromptId: 'p', state: 'completed',
          steps: [{ stepId: 's', frames: [{ frameId: 'f', kind: 'text', role: 'assistant', text: 17 }] }],
        }],
        has_more: false, agents: [], seq: 1,
      },
      { agent_id: 'agent_btw_1', prompts: [], items: [], has_more: false, agents: {}, seq: 1 },
      { agent_id: 'agent_btw_1', prompts: [], items: [], has_more: false, agents: [{ agentId: 'agent_btw_1', type: 'btw' }], seq: 1 },
      { agent_id: 'agent_btw_1', prompts: [], items: [], has_more: false, agents: [], seq: -1 },
    ];
    for (const data of malformed) {
      await expect(client(async () => jsonResponse(envelope(data))).getTranscript('session_child', { agentId: 'agent_btw_1', pageSize: 10 }))
        .rejects.toThrow(/schema|invalid|malformed/);
    }
  });

  it('uses native full compaction and bounded transcript-op catch-up routes', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const ops = {
      agent_id: 'main',
      batches: [
        { seq: 8, ops: [{ op: 'marker.upsert', item: { marker: 'compaction', payload: { phase: 'started', trigger: 'manual', agentId: 'main', instruction: 'nonce=test' } } }] },
        { seq: 9, ops: [{ op: 'marker.upsert', item: { marker: 'compaction', payload: { phase: 'completed', agentId: 'main', result: { summary: 'Compacted mining evidence.', compactedCount: 2, tokensBefore: 1200, tokensAfter: 300 } } } }] },
      ],
      latest_seq: 9,
      complete: true,
    };
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse(envelope(calls.length === 1 ? {} : ops));
    };
    const api = client(fetcher);

    await expect(api.compactSession('session_child', { instruction: 'Retain the active objective.' })).resolves.toEqual({});
    await expect(api.listTranscriptOps('session_child', { agentId: 'main', sinceSeq: 7 })).resolves.toEqual(ops);

    expect(new URL(calls[0].url).pathname).toBe('/api/v1/sessions/session_child:compact');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ instruction: 'Retain the active objective.' });
    const transcriptUrl = new URL(calls[1].url);
    expect(transcriptUrl.pathname).toBe('/api/v1/sessions/session_child/transcript/ops');
    expect(Object.fromEntries(transcriptUrl.searchParams)).toEqual({ agent_id: 'main', since_seq: '7' });
  });

  it('reads only server incarnation and live transcript watermark fields from exact routes', async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      calls.push(String(input));
      return jsonResponse(envelope(calls.length === 1 ? {
        server_id: 'server-one', started_at: '2026-11-19T11:00:00.000Z', server_version: '2.5.3', experimental_flags: {},
      } : {
        agent_id: 'main', items: [], has_more: false, interactions: [], attachments: [], agents: [], pending_interactions: [], seq: 7,
      }));
    };
    const api = client(fetcher);
    await expect(api.getServerMeta()).resolves.toEqual({ server_id: 'server-one', started_at: '2026-11-19T11:00:00.000Z' });
    await expect(api.getTranscriptWatermark('session_child', { agentId: 'main', pageSize: 1 })).resolves.toEqual({ agent_id: 'main', seq: 7 });

    expect(new URL(calls[0]).pathname).toBe('/api/v1/meta');
    const transcript = new URL(calls[1]);
    expect(transcript.pathname).toBe('/api/v1/sessions/session_child/transcript');
    expect(Object.fromEntries(transcript.searchParams)).toEqual({ agent_id: 'main', page_size: '1' });
  });

  it('rejects missing watermark or incarnation fields and non-manual permission options before fetch', async () => {
    const missingWatermark = client(async () => jsonResponse(envelope({ agent_id: 'main', items: [], has_more: false })));
    await expect(missingWatermark.getTranscriptWatermark('session_child', { agentId: 'main', pageSize: 1 }))
      .rejects.toThrow(/schema|watermark|seq|invalid/);
    const missingIncarnation = client(async () => jsonResponse(envelope({ server_id: 'server-one' })));
    await expect(missingIncarnation.getServerMeta()).rejects.toThrow(/schema|incarnation|started_at|invalid/);

    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(envelope({})));
    const api = client(fetcher);
    const input = { promptId: 'hive-daydream-mine', content: [{ type: 'text' as const, text: 'Mine.' }] };
    await expect(api.submitPrompt('session_child', { ...input, permissionMode: 'yolo' as never })).rejects.toThrow(/manual|permission/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('accepts an incomplete transcript journal as data so the caller can block recovery', async () => {
    const api = client(async () => jsonResponse(envelope({ agent_id: 'main', batches: [], latest_seq: 12, complete: false })));
    await expect(api.listTranscriptOps('session_child', { agentId: 'main', sinceSeq: 3 })).resolves.toEqual({
      agent_id: 'main', batches: [], latest_seq: 12, complete: false,
    });
  });

  it('rejects malformed, duplicate, non-monotonic, or oversized transcript fields', async () => {
    const badOps = [
      { agent_id: 'main', batches: [], latest_seq: -1, complete: true },
      { agent_id: 'main', batches: [{ seq: 2, ops: [] }, { seq: 2, ops: [] }], latest_seq: 2, complete: true },
      { agent_id: 'main', batches: [{ seq: 1, ops: Array.from({ length: 101 }, () => ({ type: 'marker' })) }], latest_seq: 1, complete: true },
      { agent_id: 'main', batches: Array.from({ length: 101 }, (_, index) => ({ seq: index + 1, ops: [] })), latest_seq: 101, complete: true },
    ];
    for (const data of badOps) {
      const api = client(async () => jsonResponse(envelope(data)));
      await expect(api.listTranscriptOps('session_child', { agentId: 'main', sinceSeq: 0 }))
        .rejects.toThrow(/schema|invalid|bound|limit|monotonic|sequence/i);
    }
  });

  it('limits daydream statuses and native prompt policy types and omits dead tool discovery', () => {
    const api = client(async () => jsonResponse(envelope({})));
    expect(api).not.toHaveProperty('listTools');
    expectTypeOf<'stale'>().not.toMatchTypeOf<DaydreamStatus>();
    expectTypeOf<NativePromptInput['permissionMode']>().toEqualTypeOf<'manual' | undefined>();
    expectTypeOf<NativePromptInput['agentId']>().toEqualTypeOf<string | undefined>();
  });
});
