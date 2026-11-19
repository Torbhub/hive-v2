import { spawnSync } from 'node:child_process';
import { mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mine: vi.fn(async () => ({ id: 'daydream-1', status: 'mining' })),
  verify: vi.fn(async () => ({ id: 'daydream-1', status: 'compacted' })),
  recover: vi.fn(async () => ({ id: 'daydream-1', status: 'recovered' })),
  list: vi.fn(async () => [{ id: 'daydream-1', status: 'recovered' }]),
}));

vi.mock('../src/daydream.js', () => ({
  MAX_DAYDREAM_BRIEF_BYTES: 64,
  mineDaydream: mocks.mine,
  verifyDaydreamBrief: mocks.verify,
  recoverDaydream: mocks.recover,
  listDaydreams: mocks.list,
}));

import { daydreamCommand } from '../src/daydream-cli.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAYDREAM = '7ca3c50b-8304-45f0-a925-f41d10a14cf2';

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'hive-daydream-cli-'));
}

function mineArgs(): string[] {
  return ['mine', 'demo', '--agent', 'builder', '--checkpoint', 'cp1', '--question', 'Which facts survive?'];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('HIVE_DAYDREAM', '1');
  vi.stubEnv('HIVE_NATIVE_BRANCHES', '1');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('hive daydream cli', () => {
  it('dispatches the exact manual mining scope and question', async () => {
    const root = tmp();
    const native = { kind: 'fake-native' };
    await daydreamCommand(root, mineArgs(), { native, now: '2026-11-19T12:00:00.000Z' });
    expect(mocks.mine).toHaveBeenCalledWith(
      { root, project: 'demo', agent: 'builder' },
      { checkpointId: 'cp1', question: 'Which facts survive?' },
      native,
      expect.objectContaining({ now: '2026-11-19T12:00:00.000Z' }),
    );
  });

  it('requires both feature flags for every native mutation', async () => {
    for (const disabled of ['HIVE_DAYDREAM', 'HIVE_NATIVE_BRANCHES']) {
      vi.stubEnv('HIVE_DAYDREAM', '1');
      vi.stubEnv('HIVE_NATIVE_BRANCHES', '1');
      vi.stubEnv(disabled, '0');
      await expect(daydreamCommand(tmp(), mineArgs(), { native: {} })).rejects.toThrow(/HIVE_DAYDREAM|HIVE_NATIVE_BRANCHES|disabled/);
      await expect(daydreamCommand(tmp(), ['verify', 'demo', DAYDREAM, '--file', 'brief.json'], { native: {} }))
        .rejects.toThrow(/HIVE_DAYDREAM|HIVE_NATIVE_BRANCHES|disabled/);
      await expect(daydreamCommand(tmp(), ['recover', 'demo', DAYDREAM], { native: {} }))
        .rejects.toThrow(/HIVE_DAYDREAM|HIVE_NATIVE_BRANCHES|disabled/);
    }
    expect(mocks.mine).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.recover).not.toHaveBeenCalled();
  });

  it('reads a bounded regular JSON brief for verify and optional recovery', async () => {
    const root = tmp();
    const file = path.join(root, 'brief.json');
    await fs.writeFile(file, '{"schemaVersion":1}');
    const native = {};
    await daydreamCommand(root, ['verify', 'demo', DAYDREAM, '--file', file], { native });
    expect(mocks.verify).toHaveBeenCalledWith(
      { root, project: 'demo' }, DAYDREAM, { schemaVersion: 1 }, native, expect.anything(),
    );

    await daydreamCommand(root, ['recover', 'demo', DAYDREAM, '--file', file], { native });
    expect(mocks.recover).toHaveBeenLastCalledWith(
      { root, project: 'demo' }, DAYDREAM, { schemaVersion: 1 }, native, expect.anything(),
    );
    await daydreamCommand(root, ['recover', 'demo', DAYDREAM], { native });
    expect(mocks.recover).toHaveBeenLastCalledWith(
      { root, project: 'demo' }, DAYDREAM, undefined, native, expect.anything(),
    );
  });

  it('refuses symlinked, non-file, and oversized briefs before native work', async () => {
    const root = tmp();
    const target = path.join(root, 'target.json');
    const link = path.join(root, 'brief.json');
    await fs.writeFile(target, '{"schemaVersion":1}');
    await fs.symlink(target, link);
    await expect(daydreamCommand(root, ['verify', 'demo', DAYDREAM, '--file', link], { native: {} }))
      .rejects.toThrow(/symlink|regular|file|follow/i);

    const directory = path.join(root, 'directory.json');
    await fs.mkdir(directory);
    await expect(daydreamCommand(root, ['recover', 'demo', DAYDREAM, '--file', directory], { native: {} }))
      .rejects.toThrow(/regular|file/i);

    const oversized = path.join(root, 'oversized.json');
    await fs.writeFile(oversized, 'x'.repeat(65));
    await expect(daydreamCommand(root, ['verify', 'demo', DAYDREAM, '--file', oversized], { native: {} }))
      .rejects.toThrow(/oversize|limit|too large/i);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.recover).not.toHaveBeenCalled();
  });

  it('keeps status read-only and supports one project or all projects', async () => {
    vi.stubEnv('HIVE_DAYDREAM', '0');
    vi.stubEnv('HIVE_NATIVE_BRANCHES', '0');
    const root = tmp();
    await fs.mkdir(path.join(root, '.hive-hub'), { recursive: true });
    await fs.writeFile(path.join(root, '.hive-hub', 'projects.json'), JSON.stringify({
      projects: [{ name: 'demo', home: path.join(root, 'demo'), repos: [] }],
    }));
    await daydreamCommand(root, ['status', 'demo'], { native: {} });
    expect(mocks.list).toHaveBeenCalledWith(root, 'demo');
    expect(vi.mocked(console.log)).toHaveBeenCalledWith(JSON.stringify([{ id: 'daydream-1', status: 'recovered' }], null, 2));

    await daydreamCommand(root, ['status'], { native: {} });
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.list).toHaveBeenLastCalledWith(root, 'demo');
    expect(mocks.mine).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.recover).not.toHaveBeenCalled();
  });

  it('rejects malformed commands and flags that imply historical forks or automatic work', async () => {
    const invalid = [
      [],
      ['watch'],
      ['mine', 'demo'],
      ['verify', 'demo', DAYDREAM],
      [...mineArgs(), '--turn', '2'],
      [...mineArgs(), '--fork'],
      [...mineArgs(), '--watch'],
      ['status', 'demo', '--json'],
    ];
    for (const args of invalid) {
      await expect(daydreamCommand(tmp(), args, { native: {} })).rejects.toThrow(/usage: hive daydream|unknown daydream flag/i);
    }
    expect(mocks.mine).not.toHaveBeenCalled();
  });

  it('is wired into the main CLI and fails closed before native setup', () => {
    const root = tmp();
    const tsx = path.join(repository, 'node_modules', '.bin', 'tsx');
    const run = spawnSync(tsx, [path.join(repository, 'src', 'cli.ts'), 'daydream', ...mineArgs()], {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: root },
    });
    expect(run.status).toBe(64);
    expect(run.stderr).toContain('HIVE_DAYDREAM');
    expect(run.stderr).not.toContain('unknown command: daydream');
  });
});
