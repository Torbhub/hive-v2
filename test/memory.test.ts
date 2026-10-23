import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listCandidates, memoryEnabled, promoteCandidate, proposeMemory, searchMemory,
} from '../src/memory.js';

const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, message: '', request_id: 'r', data }), { status: 200 });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv('HIVE_MEMORY_KEY', 'sk-mem-test');
  fetchMock = vi.fn(async () => ok({}));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('memoryEnabled', () => {
  it('is off without HIVE_MEMORY_KEY and on with it', () => {
    vi.stubEnv('HIVE_MEMORY_KEY', '');
    expect(memoryEnabled()).toBe(false);
    vi.stubEnv('HIVE_MEMORY_KEY', 'sk-mem-test');
    expect(memoryEnabled()).toBe(true);
  });
});

describe('searchMemory', () => {
  it('never calls fetch when memory is off', async () => {
    vi.stubEnv('HIVE_MEMORY_KEY', '');
    expect(await searchMemory('demo', 'anything')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('formats hits as a bullet block', async () => {
    fetchMock.mockResolvedValue(ok({ items: [
      { id: 'a', content: 'first lesson' },
      { id: 'b', content: 'second lesson' },
    ] }));
    expect(await searchMemory('demo', 'q')).toBe('- first lesson\n- second lesson');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8420/v3/atomic/search');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ team_id: 'hive-demo', agent_id: 'team', user_id: 'hive', query: 'q', limit: 5 });
    const headers = init.headers as Record<string, string>;
    expect(headers['x-tdai-user-key']).toBe('sk-mem-test');
    expect(headers['x-tdai-service-id']).toBe('default');
  });

  it('caps the block at 2000 chars', async () => {
    const fat = { id: 'a', content: 'x'.repeat(500) };
    fetchMock.mockResolvedValue(ok({ items: Array.from({ length: 10 }, () => fat) }));
    const block = await searchMemory('demo', 'q', 10);
    expect(block).not.toBeNull();
    expect(block!.length).toBeLessThanOrEqual(2000);
  });

  it('caps a single oversized hit', async () => {
    fetchMock.mockResolvedValue(ok({ items: [{ id: 'a', content: 'x'.repeat(5000) }] }));
    const block = await searchMemory('demo', 'q');
    expect(block!.length).toBeLessThanOrEqual(2000);
  });

  it('fails open on a 500', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    expect(await searchMemory('demo', 'q')).toBeNull();
  });

  it('fails open on a network error', async () => {
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    expect(await searchMemory('demo', 'q')).toBeNull();
  });

  it('fails open on a non-JSON answer', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));
    expect(await searchMemory('demo', 'q')).toBeNull();
  });

  it('fails open on a non-zero envelope code', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 100, message: 'bad key' }), { status: 200 }));
    expect(await searchMemory('demo', 'q')).toBeNull();
  });

  it('fails open on the 3s timeout', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal?.addEventListener('abort', () => rej(init.signal?.reason));
    }));
    expect(await searchMemory('demo', 'q')).toBeNull();
  }, 10_000);

  it('returns null when there are no hits', async () => {
    fetchMock.mockResolvedValue(ok({ items: [] }));
    expect(await searchMemory('demo', 'q')).toBeNull();
  });
});

describe('proposeMemory', () => {
  it('writes a private candidate with provenance', async () => {
    fetchMock.mockResolvedValue(ok({ id: 'x', updated_at: 'now' }));
    const id = await proposeMemory('demo', 'builder', 'the gate needs a green run', { session: 'session_1' });
    expect(id).toMatch(/^cand-/);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8420/v3/atomic/update');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      team_id: 'hive-demo', agent_id: 'candidates', user_id: 'hive',
      id, content: 'the gate needs a green run',
    });
    expect(body.background).toBe('project: demo, agent: builder, session: session_1');
  });

  it('returns null when memory is down', async () => {
    fetchMock.mockRejectedValue(new Error('down'));
    expect(await proposeMemory('demo', 'builder', 'text')).toBeNull();
  });
});

describe('listCandidates', () => {
  it('queries the candidates bucket', async () => {
    fetchMock.mockResolvedValue(ok({ items: [{ id: 'cand-1', content: 'note' }], total: 1 }));
    const items = await listCandidates('demo');
    expect(items).toEqual([{ id: 'cand-1', content: 'note' }]);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ team_id: 'hive-demo', agent_id: 'candidates' });
  });
});

describe('promoteCandidate', () => {
  const cand = { id: 'cand-1', content: 'lesson', background: 'project: demo, agent: builder' };

  it('copies to the team bucket, then deletes the candidate', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/v3/atomic/query')) return ok({ items: [cand], total: 1 });
      return ok({});
    });
    const r = await promoteCandidate('demo', 'cand-1');
    expect(r).toEqual({ kind: 'promoted', id: 'mem-1' });
    const paths = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(paths).toEqual([
      expect.stringContaining('/v3/atomic/query'),
      expect.stringContaining('/v3/atomic/update'),
      expect.stringContaining('/v3/atomic/delete'),
    ]);
    const write = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body));
    expect(write).toMatchObject({ agent_id: 'team', id: 'mem-1', content: 'lesson', background: cand.background });
    const del = JSON.parse(String((fetchMock.mock.calls[2] as [string, RequestInit])[1].body));
    expect(del).toMatchObject({ agent_id: 'candidates', ids: ['cand-1'] });
  });

  it('reports a missing candidate', async () => {
    fetchMock.mockResolvedValue(ok({ items: [], total: 0 }));
    expect(await promoteCandidate('demo', 'cand-nope')).toEqual({ kind: 'missing' });
  });

  it('reports memory down', async () => {
    fetchMock.mockRejectedValue(new Error('down'));
    expect(await promoteCandidate('demo', 'cand-1')).toEqual({ kind: 'unavailable' });
  });
});
