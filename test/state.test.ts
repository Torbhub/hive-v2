import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendDecision, hivePath, hubPath, manifestRead, readDecisions, readJson, readProjects, releaseDirLock, withTeamLock,
  writeJson, writeProjects,
} from '../src/state.js';

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'hive-state-'));
}

describe('readJson', () => {
  it('returns null only when the file is absent', async () => {
    expect(await readJson(path.join(tmp(), 'nope.json'))).toBeNull();
  });
  it('rethrows a corrupt file with its path, so callers never overwrite real data', async () => {
    const dir = tmp();
    const file = path.join(dir, 'team.json');
    await fs.writeFile(file, '{"agents": [');
    await expect(readJson(file)).rejects.toThrow(/team\.json/);
  });
});

describe('writeJson', () => {
  it('writes via tmp + rename, leaving no tmp file behind', async () => {
    const dir = tmp();
    const file = path.join(dir, 'a', 'b.json');
    await writeJson(file, { x: 1 });
    expect(await readJson(file)).toEqual({ x: 1 });
    expect((await fs.readdir(path.join(dir, 'a'))).filter((f) => f.includes('.tmp.'))).toEqual([]);
  });
});

describe('manifestRead', () => {
  it('drops only the torn line, keeps the good records', async () => {
    const home = tmp();
    await fs.mkdir(hivePath(home), { recursive: true });
    const good = JSON.stringify({ kind: 'tmux', at: 'x', pane: '%1' });
    await fs.writeFile(hivePath(home, 'manifest.jsonl'), `${good}\n{"kind":"wor`);
    const recs = await manifestRead(home);
    expect(recs).toHaveLength(1);
    expect(recs[0].pane).toBe('%1');
  });
});

describe('withTeamLock', () => {
  it('does not steal a stale lock from its owner', async () => {
    const home = tmp();
    const lock = hivePath(home, 'team.json.lock');
    await fs.mkdir(lock, { recursive: true });
    await writeJson(path.join(lock, 'owner.json'), { token: 'owner' });
    const old = new Date(Date.now() - 20 * 60_000);
    await fs.utimes(lock, old, old);
    await expect(withTeamLock(home, async () => 'ran', { waitMs: 50 })).rejects.toThrow(/locked/);
    expect(await readJson(path.join(lock, 'owner.json'))).toEqual({ token: 'owner' });
    await releaseDirLock(lock, 'owner');
  });

  it('lets only the current owner generation release through a successor and third waiter', async () => {
    const home = tmp();
    const lock = hivePath(home, 'team.json.lock');
    await fs.mkdir(lock, { recursive: true });
    await writeJson(path.join(lock, 'owner.json'), { token: 'old' });
    await releaseDirLock(lock, 'old');
    await fs.mkdir(lock);
    await writeJson(path.join(lock, 'owner.json'), { token: 'new' });
    let settled = false;
    const third = withTeamLock(home, async () => 'third', { waitMs: 250 }).finally(() => { settled = true; });
    await releaseDirLock(lock, 'old');
    expect(await readJson(path.join(lock, 'owner.json'))).toEqual({ token: 'new' });
    expect(settled).toBe(false);
    await releaseDirLock(lock, 'new');
    await expect(third).resolves.toBe('third');
  });

  it('waits on a fresh lock instead of breaking it', async () => {
    const home = tmp();
    await fs.mkdir(hivePath(home, 'team.json.lock'), { recursive: true });
    const started = Date.now();
    setTimeout(() => fs.rmdir(hivePath(home, 'team.json.lock')).catch(() => {}), 300);
    await expect(withTeamLock(home, async () => 'ran')).resolves.toBe('ran');
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it('keeps a live stalled holder exclusive beyond the stale interval', async () => {
    const home = tmp();
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const first = withTeamLock(home, async () => {
      started();
      await new Promise<void>((resolve) => { release = resolve; });
      return 'first';
    }, { staleMs: 50 });
    await entered;
    const second = withTeamLock(home, async () => 'second', { staleMs: 50, waitMs: 250 });
    await expect(second).rejects.toThrow(/locked/);
    release();
    await expect(first).resolves.toBe('first');
    await expect(withTeamLock(home, async () => 'third')).resolves.toBe('third');
  });
});

describe('project mode', () => {
  it('round-trips through projects.json and rejects a bad mode at write', async () => {
    const root = tmp();
    const home = path.join(root, 'demo');
    await writeProjects(root, { projects: [{ name: 'demo', home, repos: [], mode: 'yolo' }] });
    expect((await readProjects(root)).projects[0].mode).toBe('yolo');
    await expect(
      writeProjects(root, { projects: [{ name: 'demo', home, repos: [], mode: 'chaos' as never }] }),
    ).rejects.toThrow(/mode is ask\|yolo\|auto/);
  });
});

describe('decisions log', () => {
  it('appends and reads the latest N, newest first', async () => {
    const root = tmp();
    for (let i = 1; i <= 10; i++) {
      await appendDecision(root, { project: 'demo', by: 'watch', summary: `decision ${i}`, at: `2026-10-13T00:00:${String(i).padStart(2, '0')}Z` });
    }
    const latest = await readDecisions(root, 8);
    expect(latest).toHaveLength(8);
    expect(latest[0].summary).toBe('decision 10');
    expect(latest[7].summary).toBe('decision 3');
  });
  it('preserves raw decision text', async () => {
    const root = tmp();
    await appendDecision(root, { project: 'demo', by: 'watch', summary: 'wake returned %9 after %1 died' });
    expect((await readDecisions(root))[0].summary).toBe('wake returned %9 after %1 died');
    const raw = await fs.readFile(hubPath(root, 'decisions.jsonl'), 'utf8');
    expect(raw).toContain('%9');
    expect(raw).toContain('%1');
  });

  it('reads an absent log as empty', async () => {
    expect(await readDecisions(tmp())).toEqual([]);
  });

  function messageDecision(id: string, status: 'pending' | 'delivered' | 'unknown', at: string): Record<string, string> {
    return {
      at,
      project: 'demo',
      by: 'agent',
      summary: `agent message ${id} from builder to reviewer@/tmp/reviewer: ${'a'.repeat(64)} ${status}`,
      message_id: id,
      delivery_status: status,
      sender: 'builder',
      canonical_target: 'reviewer@/tmp/reviewer',
      payload_sha256: 'a'.repeat(64),
    };
  }

  async function writeDecisions(root: string, records: Record<string, string>[]): Promise<void> {
    await fs.mkdir(hubPath(root), { recursive: true });
    await fs.writeFile(hubPath(root, 'decisions.jsonl'), records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  }

  async function readMessageDecisions(root: string): Promise<Record<string, string>[]> {
    return await readDecisions(root, Number.MAX_SAFE_INTEGER) as unknown as Record<string, string>[];
  }

  it('folds pending message records into their terminal outcomes', async () => {
    const root = tmp();
    const delivered = '11111111-1111-4111-8111-111111111111';
    const unknown = '22222222-2222-4222-8222-222222222222';
    await writeDecisions(root, [
      messageDecision(delivered, 'pending', '2026-11-22T00:00:00.000Z'),
      messageDecision(delivered, 'delivered', '2026-11-22T00:00:01.000Z'),
      messageDecision(unknown, 'pending', '2026-11-22T00:00:02.000Z'),
      messageDecision(unknown, 'unknown', '2026-11-22T00:00:03.000Z'),
    ]);
    const recovered = await readMessageDecisions(root);
    expect(recovered).toHaveLength(2);
    expect(Object.fromEntries(recovered.map((record) => [record.message_id, record.delivery_status]))).toEqual({
      [delivered]: 'delivered',
      [unknown]: 'unknown',
    });
  });

  it('retains 64 logical messages without disturbing ordinary decisions', async () => {
    const root = tmp();
    const at = '2026-11-22T00:00:00.000Z';
    const ids = Array.from({ length: 65 }, (_, index) => `message-${index}`);
    const ordinary = (summary: string): Record<string, string> => ({ at, project: 'demo', by: 'watch', summary });
    await writeDecisions(root, [
      ordinary('before'),
      ...ids.map((id) => messageDecision(id, 'delivered', at)),
      ordinary('middle'),
      messageDecision(ids[0], 'unknown', at),
      ordinary('after'),
    ]);
    const recovered = await readMessageDecisions(root);
    expect(recovered.map((record) => record.message_id ?? record.summary)).toEqual([
      'after', ids[0], 'middle', ...ids.slice(2).reverse(), 'before',
    ]);
    expect(recovered[1]).toMatchObject({ message_id: ids[0], delivery_status: 'unknown' });
  });

  it('reads stale pending as unknown without rewriting the log', async () => {
    const root = tmp();
    const id = '33333333-3333-4333-8333-333333333333';
    const staleAt = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    await writeDecisions(root, [messageDecision(id, 'pending', staleAt)]);
    const file = hubPath(root, 'decisions.jsonl');
    const before = await fs.stat(file, { bigint: true });
    const raw = await fs.readFile(file, 'utf8');
    const recovered = await readMessageDecisions(root);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ message_id: id, delivery_status: 'unknown' });
    expect((await fs.stat(file, { bigint: true })).mtimeNs).toBe(before.mtimeNs);
    expect(await fs.readFile(file, 'utf8')).toBe(raw);
    expect((await readMessageDecisions(root))[0]).toMatchObject({ message_id: id, delivery_status: 'unknown' });
    expect((await fs.stat(file, { bigint: true })).mtimeNs).toBe(before.mtimeNs);
  });
});
