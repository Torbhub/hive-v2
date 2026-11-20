import { spawnSync } from 'node:child_process';
import { mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const record = {
    id: 'branch-1', kind: 'child', status: 'active', purpose: 'Review',
    scope: { project: 'demo', agent: 'builder', task: 'demo-1' }, createdAt: 'created', updatedAt: 'updated',
  };
  return {
    create: vi.fn(async () => ({ ...record })),
    list: vi.fn(async () => [{ ...record }]),
    refresh: vi.fn(async () => ({ ...record })),
    result: vi.fn(async () => ({ ...record, result: { digest: 'a'.repeat(64), findings: [] } })),
    read: vi.fn(),
    reconcileCreation: vi.fn(async () => ({ ...record })),
    reconcile: vi.fn(async () => ({
      ...record,
      rejoin: { status: 'unknown', reviewDigest: 'a'.repeat(64), promptId: 'prompt', promptHash: 'b'.repeat(64), intentAt: 'now' },
    })),
  };
});

vi.mock('../src/branches.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/branches.js')>(),
  MAX_NATIVE_BRANCH_RESULT_BYTES: 64,
  createNativeBranch: mocks.create,
  listNativeBranches: mocks.list,
  readNativeBranch: mocks.read,
  refreshNativeBranch: mocks.refresh,
  recordNativeBranchResult: mocks.result,
  reconcileNativeBranchCreation: mocks.reconcileCreation,
  reconcileNativeBranchRejoin: mocks.reconcile,
}));

import { branchCommand } from '../src/branch-cli.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRANCH = '7ca3c50b-8304-45f0-a925-f41d10a14cf2';

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'hive-native-branch-cli-'));
}

function createArgs(): string[] {
  return ['create', 'demo', '--agent', 'builder', '--purpose', 'inspect the boundary'];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('HIVE_NATIVE_BRANCHES', '1');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('hive branch cli', () => {
  it('rejects missing, unknown, review, and rejoin subcommands with usage', async () => {
    for (const args of [[], ['merge'], ['review', 'demo', BRANCH], ['rejoin', 'demo', BRANCH]]) {
      await expect(branchCommand(tmp(), args)).rejects.toThrow(/usage: hive branch/);
    }
  });

  it('is off by default and reaches no branch operation', async () => {
    vi.stubEnv('HIVE_NATIVE_BRANCHES', '0');
    await expect(branchCommand(tmp(), createArgs(), { native: {} })).rejects.toThrow(/HIVE_NATIVE_BRANCHES|disabled/);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('dispatches creation with only project and agent scope', async () => {
    const root = tmp();
    const native = { kind: 'fake-native' };
    await branchCommand(root, createArgs(), { native, now: '2026-11-18T12:00:00.000Z' });
    expect(mocks.create).toHaveBeenCalledWith(
      { root, project: 'demo', agent: 'builder' },
      { kind: 'child', purpose: 'inspect the boundary' },
      native,
      expect.objectContaining({ now: '2026-11-18T12:00:00.000Z' }),
    );
  });

  it('passes only root allocation fields when creation needs disambiguation', async () => {
    const root = tmp();
    const native = {};
    await branchCommand(root, [
      ...createArgs(), '--output-claim', 'Review the native child.', '--acceptance', 'native', '--acceptance', 'native-extra',
    ], { native });
    expect(mocks.create).toHaveBeenCalledWith(
      { root, project: 'demo', agent: 'builder' },
      {
        kind: 'child', purpose: 'inspect the boundary', outputClaim: 'Review the native child.',
        acceptanceIds: ['native', 'native-extra'],
      },
      native,
      expect.anything(),
    );
  });

  it('dispatches a current-boundary fork without a turn index', async () => {
    const root = tmp();
    const native = {};
    await branchCommand(root, [...createArgs(), '--fork'], { native });
    expect(mocks.create).toHaveBeenCalledWith(
      { root, project: 'demo', agent: 'builder' },
      { kind: 'fork', purpose: 'inspect the boundary' },
      native,
      expect.anything(),
    );
  });

  it('rejects removed scope, review, ttl, and json flags', async () => {
    for (const flag of ['task', 'session', 'generation', 'reviewer', 'ttl-ms', 'json', 'fork-turn', 'write-scope']) {
      const args = [...createArgs(), `--${flag}`];
      if (flag !== 'json') args.push('2');
      await expect(branchCommand(tmp(), args, { native: {} })).rejects.toThrow(/unknown branch flag|usage/);
    }
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('keeps status read-only and prints durable JSON without a json flag', async () => {
    vi.stubEnv('HIVE_NATIVE_BRANCHES', '0');
    await branchCommand(tmp(), ['status', 'demo'], { native: {} });
    expect(mocks.list).toHaveBeenCalledWith(expect.any(String), 'demo');
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(vi.mocked(console.log)).toHaveBeenCalledWith(JSON.stringify([{
      id: 'branch-1', status: 'active', purpose: 'Review', agent: 'builder', task: 'demo-1',
      createdAt: 'created', updatedAt: 'updated', hasResult: false,
    }], null, 2));
  });

  it('filters leases, sessions, paths, snapshots, grants, and native evidence from CLI output', async () => {
    mocks.list.mockResolvedValueOnce([{
      id: BRANCH, status: 'active', purpose: 'Review', scope: { project: 'demo', agent: 'builder', task: 'demo-1' },
      createdAt: 'created', updatedAt: 'updated', hasResult: true,
      leaseId: 'private-lease', parentSessionId: 'private-parent', childSessionId: 'private-child',
      cwd: '/private/path', parentSnapshot: { historyHash: 'private-history' },
      review: { approverGrantId: 'private-grant' }, result: { findings: [{ nativeEvidence: ['private-evidence'] }] },
    }] as never);
    await branchCommand(tmp(), ['status', 'demo'], { native: {} });
    const output = vi.mocked(console.log).mock.calls[0][0] as string;
    expect(JSON.parse(output)).toEqual([{
      id: BRANCH, status: 'active', purpose: 'Review', agent: 'builder', task: 'demo-1',
      createdAt: 'created', updatedAt: 'updated', hasResult: true,
    }]);
    for (const secret of ['private-lease', 'private-parent', 'private-child', '/private/path', 'private-history', 'private-grant', 'private-evidence']) {
      expect(output).not.toContain(secret);
    }
  });

  it('reads a regular result file as structured JSON and passes native evidence verification', async () => {
    const root = tmp();
    const file = path.join(root, 'result.json');
    await fs.writeFile(file, '{"schemaVersion":1}');
    const native = {};
    await branchCommand(root, ['result', 'demo', BRANCH, '--file', file], { native });
    expect(mocks.result).toHaveBeenCalledWith(
      { root, project: 'demo' }, BRANCH, { schemaVersion: 1 }, native, expect.anything(),
    );
  });

  it('refuses symlinked and oversized result files before parsing or native work', async () => {
    const root = tmp();
    const target = path.join(root, 'target.json');
    const link = path.join(root, 'result.json');
    await fs.writeFile(target, '{"schemaVersion":1}');
    await fs.symlink(target, link);
    await expect(branchCommand(root, ['result', 'demo', BRANCH, '--file', link], { native: {} }))
      .rejects.toThrow(/symlink|regular|file|follow/i);

    const directory = path.join(root, 'directory.json');
    await fs.mkdir(directory);
    await expect(branchCommand(root, ['result', 'demo', BRANCH, '--file', directory], { native: {} }))
      .rejects.toThrow(/regular|file/i);

    const oversized = path.join(root, 'oversized.json');
    await fs.writeFile(oversized, 'x'.repeat(65));
    await expect(branchCommand(root, ['result', 'demo', BRANCH, '--file', oversized], { native: {} }))
      .rejects.toThrow(/oversize|limit|too large/);
    expect(mocks.result).not.toHaveBeenCalled();
  });

  it('dispatches creation reconciliation for creating or creation-unknown records and rejoin only for intent', async () => {
    const root = tmp();
    mocks.read
      .mockResolvedValueOnce({ id: BRANCH, status: 'creating' })
      .mockResolvedValueOnce({ id: BRANCH, status: 'unknown' })
      .mockResolvedValueOnce({ id: BRANCH, status: 'unknown', rejoin: { status: 'unknown' } });
    for (let index = 0; index < 3; index++) {
      await branchCommand(root, ['reconcile', 'demo', BRANCH], { native: {} });
    }
    expect(mocks.reconcileCreation).toHaveBeenCalledTimes(2);
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
    expect(mocks.reconcileCreation).toHaveBeenCalledWith({ root, project: 'demo' }, BRANCH, {}, expect.anything());
    expect(mocks.reconcile).toHaveBeenCalledWith({ root, project: 'demo' }, BRANCH, {}, expect.anything());
  });

  it('is wired into the main CLI and fails closed before native setup', () => {
    const root = tmp();
    const tsx = path.join(repository, 'node_modules', '.bin', 'tsx');
    const run = spawnSync(tsx, [path.join(repository, 'src', 'cli.ts'), 'branch', ...createArgs()], {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: root },
    });
    expect(run.status).toBe(64);
    expect(run.stderr).toContain('HIVE_NATIVE_BRANCHES');
    expect(run.stderr).not.toContain('unknown command: branch');
  });
});
