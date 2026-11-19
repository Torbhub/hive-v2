import { spawnSync } from 'node:child_process';
import { mkdtempSync, promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pruneDaydreamArtifacts } from '../src/daydream-retention.js';
import { daydreamCommand } from '../src/daydream-cli.js';
import { hivePath, hubPath, writeJson } from '../src/state.js';

const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const DAY = 24 * 60 * 60_000;

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'hive-daydream-retention-'));
  const home = path.join(root, 'demo');
  await fs.mkdir(hivePath(home, 'daydreams'), { recursive: true });
  await writeJson(hubPath(root, 'projects.json'), { projects: [{ name: 'demo', home, repos: [] }] });
  return { root, home, daydreams: hivePath(home, 'daydreams') };
}

async function tombstone(
  fixture: { daydreams: string },
  id: string,
  tombstonedAt: number,
  overrides: Record<string, unknown> = {},
) {
  const artifact = path.join(fixture.daydreams, 'automation', 'artifacts', `${id}.json`);
  const metadata = path.join(fixture.daydreams, 'automation', 'metadata', `${id}.json`);
  await fs.mkdir(path.dirname(artifact), { recursive: true });
  await fs.mkdir(path.dirname(metadata), { recursive: true });
  await fs.writeFile(artifact, JSON.stringify({ id, facts: ['Hive-owned artifact'] }));
  await writeJson(metadata, {
    schemaVersion: 1,
    owner: 'hive-daydream-automation',
    id,
    status: 'tombstoned',
    artifact: path.relative(fixture.daydreams, artifact),
    tombstonedAt: new Date(tombstonedAt).toISOString(),
    ...overrides,
  });
  return { artifact, metadata };
}

async function exists(file: string): Promise<boolean> {
  return fs.lstat(file).then(() => true, () => false);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('HIVE_DAYDREAM_AUTOMATION', '0');
  vi.stubEnv('HIVE_DAYDREAM', '0');
  vi.stubEnv('HIVE_NATIVE_BRANCHES', '0');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('daydream retention', () => {
  it('dry-run reports an owned tombstoned pair without deleting it', async () => {
    const fixture = await setup();
    const pair = await tombstone(fixture, 'old', NOW - 60 * DAY);

    const result = await pruneDaydreamArtifacts(fixture.root, 'demo', {
      dryRun: true,
      now: NOW,
      maxAgeMs: 30 * DAY,
      maxCount: 10,
    });

    expect(result.dryRun).toBe(true);
    expect(result.candidates).toEqual(expect.arrayContaining([pair.artifact, pair.metadata]));
    expect(result.pruned).toEqual([]);
    expect(await exists(pair.artifact)).toBe(true);
    expect(await exists(pair.metadata)).toBe(true);
  });

  it('applies the age cap and deletes only the corresponding tombstoned metadata', async () => {
    const fixture = await setup();
    const old = await tombstone(fixture, 'old', NOW - 60 * DAY);
    const recent = await tombstone(fixture, 'recent', NOW - DAY);
    const active = await tombstone(fixture, 'active', NOW - 90 * DAY, { status: 'active' });

    const result = await pruneDaydreamArtifacts(fixture.root, 'demo', {
      now: NOW,
      maxAgeMs: 30 * DAY,
      maxCount: 10,
    });

    expect(result.pruned).toEqual(expect.arrayContaining([old.artifact, old.metadata]));
    expect(await exists(old.artifact)).toBe(false);
    expect(await exists(old.metadata)).toBe(false);
    for (const pair of [recent, active]) {
      expect(await exists(pair.artifact)).toBe(true);
      expect(await exists(pair.metadata)).toBe(true);
    }
  });

  it('keeps the newest count-capped tombstones even when all are age-eligible', async () => {
    const fixture = await setup();
    const oldest = await tombstone(fixture, 'oldest', NOW - 3 * DAY);
    const middle = await tombstone(fixture, 'middle', NOW - 2 * DAY);
    const newest = await tombstone(fixture, 'newest', NOW - DAY);

    await pruneDaydreamArtifacts(fixture.root, 'demo', {
      now: NOW,
      maxAgeMs: 30 * DAY,
      maxCount: 2,
    });

    expect(await exists(oldest.artifact)).toBe(false);
    expect(await exists(oldest.metadata)).toBe(false);
    for (const pair of [middle, newest]) {
      expect(await exists(pair.artifact)).toBe(true);
      expect(await exists(pair.metadata)).toBe(true);
    }
  });

  it('refuses a symlinked artifact and fails closed before pruning another eligible pair', async () => {
    const fixture = await setup();
    const outside = path.join(fixture.root, 'outside.json');
    await fs.writeFile(outside, '{"native":true}');
    const linked = await tombstone(fixture, 'linked', NOW - 60 * DAY);
    await fs.rm(linked.artifact);
    await fs.symlink(outside, linked.artifact);
    const ordinary = await tombstone(fixture, 'ordinary', NOW - 60 * DAY);

    await expect(pruneDaydreamArtifacts(fixture.root, 'demo', {
      now: NOW,
      maxAgeMs: 30 * DAY,
      maxCount: 10,
    })).rejects.toThrow(/symlink|foreign|outside|refus/i);

    expect(await fs.readFile(outside, 'utf8')).toBe('{"native":true}');
    expect(await exists(linked.metadata)).toBe(true);
    expect(await exists(ordinary.artifact)).toBe(true);
    expect(await exists(ordinary.metadata)).toBe(true);
  });

  it('refuses tombstone metadata that points outside .hive/daydreams', async () => {
    const fixture = await setup();
    const outside = path.join(fixture.root, 'native-session.json');
    await fs.writeFile(outside, '{"session":"native"}');
    const pair = await tombstone(fixture, 'escape', NOW - 60 * DAY, { artifact: outside });

    await expect(pruneDaydreamArtifacts(fixture.root, 'demo', {
      now: NOW,
      maxAgeMs: 30 * DAY,
      maxCount: 10,
    })).rejects.toThrow(/foreign|outside|escape|refus/i);

    expect(await fs.readFile(outside, 'utf8')).toBe('{"session":"native"}');
    expect(await exists(pair.artifact)).toBe(true);
    expect(await exists(pair.metadata)).toBe(true);
  });

  it('refuses a symlinked daydream root without following it', async () => {
    const fixture = await setup();
    const real = path.join(fixture.root, 'real-daydreams');
    await fs.mkdir(real);
    const artifact = path.join(real, 'artifact.json');
    await fs.writeFile(artifact, 'keep');
    await fs.rm(fixture.daydreams, { recursive: true });
    await fs.symlink(real, fixture.daydreams);

    await expect(pruneDaydreamArtifacts(fixture.root, 'demo', {
      now: NOW,
      maxAgeMs: 30 * DAY,
      maxCount: 10,
    })).rejects.toThrow(/symlink|regular|directory|refus/i);

    expect(await fs.readFile(artifact, 'utf8')).toBe('keep');
  });

  it.each(['fifo', 'socket', 'directory', 'device'] as const)('rejects a %s with a .json name', async (kind) => {
    const fixture = await setup();
    const pair = await tombstone(fixture, kind, NOW - 60 * DAY);
    await fs.rm(pair.artifact);
    let server: ReturnType<typeof createServer> | undefined;
    if (kind === 'directory') await fs.mkdir(pair.artifact);
    if (kind === 'fifo') expect(spawnSync('mkfifo', [pair.artifact]).status).toBe(0);
    if (kind === 'socket') {
      server = createServer();
      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(pair.artifact, resolve);
      });
    }
    if (kind === 'device') {
      await fs.writeFile(pair.artifact, 'simulated device');
      const originalLstat = fs.lstat;
      vi.spyOn(fs, 'lstat').mockImplementation(async (file, options) => {
        const stat = await originalLstat(file, options);
        if (String(file) !== pair.artifact) return stat;
        const device = Object.create(stat) as typeof stat;
        device.isFile = () => false;
        return device;
      });
    }

    try {
      await expect(pruneDaydreamArtifacts(fixture.root, 'demo', {
        now: NOW,
        maxAgeMs: 30 * DAY,
        maxCount: 10,
      })).rejects.toThrow(/regular|file|directory|symlink|refus/i);
    } finally {
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(await exists(pair.metadata)).toBe(true);
  });

  it('deletes through verified directory handles when ancestors are swapped during pruning', async () => {
    const fixture = await setup();
    const pair = await tombstone(fixture, 'owned', NOW - 60 * DAY);
    const artifacts = path.dirname(pair.artifact);
    const metadata = path.dirname(pair.metadata);
    const movedArtifacts = `${artifacts}.verified`;
    const movedMetadata = `${metadata}.verified`;
    const externalArtifacts = path.join(fixture.root, 'external-artifacts');
    const externalMetadata = path.join(fixture.root, 'external-metadata');
    await fs.mkdir(externalArtifacts);
    await fs.mkdir(externalMetadata);
    const externalArtifact = path.join(externalArtifacts, path.basename(pair.artifact));
    const externalMetadatum = path.join(externalMetadata, path.basename(pair.metadata));
    await fs.writeFile(externalArtifact, 'external artifact');
    await fs.writeFile(externalMetadatum, 'external metadata');

    const removedPaths: string[] = [];
    const originalRm = fs.rm;
    vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      removedPaths.push(String(target));
      if (removedPaths.length === 1) {
        await fs.rename(artifacts, movedArtifacts);
        await fs.symlink(externalArtifacts, artifacts);
        await fs.rename(metadata, movedMetadata);
        await fs.symlink(externalMetadata, metadata);
      }
      return originalRm(target, options);
    });

    await pruneDaydreamArtifacts(fixture.root, 'demo', {
      now: NOW,
      maxAgeMs: 30 * DAY,
      maxCount: 10,
    });

    expect(removedPaths).toHaveLength(2);
    expect(removedPaths.every((file) => file.startsWith('/proc/self/fd/'))).toBe(true);
    expect(await exists(path.join(movedArtifacts, path.basename(pair.artifact)))).toBe(false);
    expect(await exists(path.join(movedMetadata, path.basename(pair.metadata)))).toBe(false);
    expect(await fs.readFile(externalArtifact, 'utf8')).toBe('external artifact');
    expect(await fs.readFile(externalMetadatum, 'utf8')).toBe('external metadata');
  });
});

describe('manual prune CLI', () => {
  it('supports prune <project> --dry-run without native or automation flags', async () => {
    const fixture = await setup();
    const pair = await tombstone(fixture, 'old', NOW - 60 * DAY);

    await daydreamCommand(fixture.root, ['prune', 'demo', '--dry-run'], {
      retention: { now: NOW, maxAgeMs: 30 * DAY, maxCount: 10 },
    });

    expect(vi.mocked(console.log)).toHaveBeenCalledWith(expect.stringContaining('"dryRun": true'));
    expect(await exists(pair.artifact)).toBe(true);
    expect(await exists(pair.metadata)).toBe(true);
  });
});
