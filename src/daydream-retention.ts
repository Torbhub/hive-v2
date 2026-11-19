import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { readBoundedFile } from './bounded-file.js';
import { hivePath, readProjects, Refusal, writeJson } from './state.js';
import type { DaydreamAutomationRun } from './types.js';

const MAX_METADATA_BYTES = 64 * 1024;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_MAX_COUNT = 100;
const OWNER = 'hive-daydream-automation';
const SAFE_ID = /^[A-Za-z0-9-]+$/;

export type DaydreamRetentionOptions = {
  dryRun?: boolean;
  now?: number;
  maxAgeMs?: number;
  maxCount?: number;
};
export type DaydreamRetentionResult = {
  dryRun: boolean;
  candidates: string[];
  pruned: string[];
};
type Tombstone = {
  id: string;
  artifact: string;
  metadata: string;
  artifactProc: string;
  metadataProc: string;
  tombstonedAt: number;
  artifactIdentity: { dev: bigint; ino: bigint };
  metadataIdentity: { dev: bigint; ino: bigint };
};

function automationDirectory(home: string): string {
  return hivePath(home, 'daydreams', 'automation');
}
async function realDirectory(directory: string, create: boolean): Promise<boolean> {
  let stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat && !create) return false;
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Refusal('daydream retention refuses a symlink or non-directory');
  if (!stat) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    stat = await fs.lstat(directory);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Refusal('daydream retention refuses a symlink or non-directory');
  return true;
}
async function identity(file: string): Promise<{ dev: bigint; ino: bigint }> {
  const stat = await fs.lstat(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Refusal('daydream retention refuses a symlink or non-regular file');
  return { dev: stat.dev, ino: stat.ino };
}
function sameIdentity(a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function artifactPath(daydreams: string, id: string): string {
  return path.join(daydreams, 'automation', 'artifacts', `${id}.json`);
}
function metadataPath(daydreams: string, id: string): string {
  return path.join(daydreams, 'automation', 'metadata', `${id}.json`);
}

export async function recordDaydreamArtifact(home: string, run: DaydreamAutomationRun): Promise<void> {
  const daydreams = hivePath(home, 'daydreams');
  await realDirectory(daydreams, true);
  await realDirectory(automationDirectory(home), true);
  await realDirectory(path.join(automationDirectory(home), 'artifacts'), true);
  await realDirectory(path.join(automationDirectory(home), 'metadata'), true);
  const artifact = {
    schemaVersion: 1,
    owner: OWNER,
    daydreamId: run.daydreamId,
    project: run.project,
    agent: run.agentName,
    sessionId: run.sessionId,
    activityAt: run.activityAt,
    reason: run.reason,
    status: run.status,
    prompts: run.prompts,
    compactions: run.compactions,
    tokens: run.tokens,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
  await writeJson(artifactPath(daydreams, run.daydreamId), artifact, 0o600);
  await writeJson(metadataPath(daydreams, run.daydreamId), {
    schemaVersion: 1,
    owner: OWNER,
    id: run.daydreamId,
    status: 'tombstoned',
    artifact: path.join('automation', 'artifacts', `${run.daydreamId}.json`),
    tombstonedAt: run.updatedAt,
  }, 0o600);
}

function procPath(handle: FileHandle, ...parts: string[]): string {
  return path.join('/proc/self/fd', String(handle.fd), ...parts);
}
async function openDirectory(directory: string, optional = false): Promise<FileHandle | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isDirectory()) throw new Refusal('daydream retention refuses a non-directory');
    return handle;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof Refusal) throw error;
    throw new Refusal(`daydream retention refuses a directory or symlink: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function openChild(parent: FileHandle, name: string, optional = false): Promise<FileHandle | null> {
  return openDirectory(procPath(parent, name), optional);
}
async function assertRegularJsonEntries(directory: FileHandle, displayDirectory: string): Promise<void> {
  const entries = await fs.readdir(procPath(directory), { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.name.endsWith('.json')) continue;
    const stat = await fs.lstat(path.join(displayDirectory, entry.name));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Refusal('daydream retention refuses a non-regular JSON entry');
  }
}
async function readTombstone(
  daydreams: string,
  artifacts: FileHandle,
  metadataDirectory: FileHandle,
  file: string,
): Promise<Tombstone | null> {
  const metadataProc = procPath(metadataDirectory, file);
  const metadataIdentity = await identity(metadataProc);
  const metadata = path.join(daydreams, 'automation', 'metadata', file);
  let raw: unknown;
  try {
    raw = JSON.parse(await readBoundedFile(metadataProc, MAX_METADATA_BYTES));
  } catch (error) {
    throw new Refusal(`daydream tombstone metadata is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Refusal('daydream tombstone metadata is invalid');
  const value = raw as Record<string, unknown>;
  if (value.owner !== OWNER) return null;
  if (value.schemaVersion !== 1 || typeof value.id !== 'string' || !SAFE_ID.test(value.id)
    || typeof value.status !== 'string' || typeof value.artifact !== 'string') {
    throw new Refusal('Hive-owned daydream tombstone metadata is invalid');
  }
  if (value.status !== 'tombstoned') return null;
  const tombstonedAt = Date.parse(String(value.tombstonedAt));
  if (!Number.isFinite(tombstonedAt)) throw new Refusal('daydream tombstone timestamp is invalid');
  const expected = path.join('automation', 'artifacts', `${value.id}.json`);
  if (file !== `${value.id}.json` || value.artifact !== expected || path.isAbsolute(value.artifact)) {
    throw new Refusal('daydream tombstone points to a foreign path');
  }
  const artifact = artifactPath(daydreams, value.id);
  const resolved = path.resolve(daydreams, value.artifact);
  if (resolved !== artifact || !resolved.startsWith(`${path.resolve(daydreams)}${path.sep}`)) {
    throw new Refusal('daydream tombstone points outside .hive/daydreams');
  }
  const artifactProc = procPath(artifacts, `${value.id}.json`);
  return {
    id: value.id,
    artifact,
    metadata,
    artifactProc,
    metadataProc,
    tombstonedAt,
    artifactIdentity: await identity(artifactProc),
    metadataIdentity,
  };
}

function limit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) throw new Refusal(`daydream retention ${name} is invalid`);
  return result;
}

export async function pruneDaydreamArtifacts(
  root: string,
  project: string,
  options: DaydreamRetentionOptions = {},
): Promise<DaydreamRetentionResult> {
  const registered = (await readProjects(root)).projects.find((candidate) => candidate.name === project);
  if (!registered) throw new Refusal(`unknown project: ${project}`);
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) throw new Refusal('daydream retention timestamp is invalid');
  const maxAgeMs = limit(options.maxAgeMs, DEFAULT_MAX_AGE_MS, 'age cap');
  const maxCount = limit(options.maxCount, DEFAULT_MAX_COUNT, 'count cap');
  const result: DaydreamRetentionResult = { dryRun: options.dryRun === true, candidates: [], pruned: [] };
  const daydreams = hivePath(registered.home, 'daydreams');
  const handles: FileHandle[] = [];
  try {
    const rootHandle = await openDirectory(daydreams, true);
    if (!rootHandle) return result;
    handles.push(rootHandle);
    const automation = await openChild(rootHandle, 'automation', true);
    if (!automation) return result;
    handles.push(automation);
    const artifacts = await openChild(automation, 'artifacts', true);
    if (!artifacts) return result;
    handles.push(artifacts);
    const metadata = await openChild(automation, 'metadata', true);
    if (!metadata) return result;
    handles.push(metadata);
    await assertRegularJsonEntries(artifacts, path.join(daydreams, 'automation', 'artifacts'));
    await assertRegularJsonEntries(metadata, path.join(daydreams, 'automation', 'metadata'));

    const entries = await fs.readdir(procPath(metadata), { withFileTypes: true });
    const tombstones: Tombstone[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith('.json')) continue;
      const tombstone = await readTombstone(daydreams, artifacts, metadata, entry.name);
      if (tombstone) tombstones.push(tombstone);
    }
    tombstones.sort((a, b) => b.tombstonedAt - a.tombstonedAt || a.id.localeCompare(b.id));
    const selected = tombstones.filter((entry, index) => now - entry.tombstonedAt >= maxAgeMs || index >= maxCount);
    result.candidates = selected.flatMap((entry) => [entry.artifact, entry.metadata]);
    if (result.dryRun) return result;

    for (const entry of selected) {
      const artifactIdentity = await identity(entry.artifactProc);
      const metadataIdentity = await identity(entry.metadataProc);
      if (!sameIdentity(artifactIdentity, entry.artifactIdentity) || !sameIdentity(metadataIdentity, entry.metadataIdentity)) {
        throw new Refusal('daydream retention artifact changed during pruning');
      }
    }
    for (const entry of selected) {
      await fs.rm(entry.artifactProc);
      await fs.rm(entry.metadataProc);
      result.pruned.push(entry.artifact, entry.metadata);
    }
    return result;
  } finally {
    for (const handle of handles.reverse()) await handle.close();
  }
}
