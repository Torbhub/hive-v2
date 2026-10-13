import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hivePath, manifestRead, readJson, readProjects, withTeamLock, writeJson, writeProjects,
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
    await fs.writeFile(hivePath(home, 'manifest.jsonl'), `${good}\n{"kind":"wor\n`);
    const recs = await manifestRead(home);
    expect(recs).toHaveLength(1);
    expect(recs[0].pane).toBe('%1');
  });
});

describe('withTeamLock', () => {
  it('breaks a lock older than the staleness window', async () => {
    const home = tmp();
    const lock = hivePath(home, 'team.json.lock');
    await fs.mkdir(lock, { recursive: true });
    const old = new Date(Date.now() - 20 * 60_000);
    await fs.utimes(lock, old, old);
    await expect(withTeamLock(home, async () => 'ran')).resolves.toBe('ran');
    await expect(fs.stat(lock)).rejects.toThrow();
  });
  it('waits on a fresh lock instead of breaking it', async () => {
    const home = tmp();
    await fs.mkdir(hivePath(home, 'team.json.lock'), { recursive: true });
    const started = Date.now();
    setTimeout(() => fs.rmdir(hivePath(home, 'team.json.lock')).catch(() => {}), 300);
    await expect(withTeamLock(home, async () => 'ran')).resolves.toBe('ran');
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
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
