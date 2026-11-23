import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { killWindow, paneExists, paneIs, processStartTime, run, type PaneIdentity, type RunResult } from './tmux.js';
import {
  canonicalJson, compareAndSwapTeamEntry, hivePath, manifestRead, manifestUpdate, readProjects, readTeam,
  type ManifestRecord,
} from './state.js';
import { revokeTmuxAdmission } from './admission.js';
import { releasePendingLaunchClaim } from './project.js';
import type { TeamEntry } from './types.js';

export type CleanupAction = { record: ManifestRecord; action: string; acted: boolean };
type CleanupOptions = { dryRun?: boolean; reclaimTrash?: boolean; ownerApproved?: boolean };
type LaneKind = 'worktree' | 'jj-workspace';
type QuarantineFile = { path: string; size: number; sha256: string };
type Inventory = { files: QuarantineFile[]; directories: string[] };
type StoreRecord = (current: ManifestRecord, replacement: ManifestRecord | null) => Promise<void>;
type JjWorkspace = { name: string; root: string };
type JjWorkspaceList = { code: number; stderr: string; entries: JjWorkspace[] | null };
type LaneCheck = { error?: string; workspaceName?: string };

const QUARANTINE_MS = 7 * 24 * 60 * 60 * 1000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function processIsAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function lstat(target: string) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function assertRealAncestors(target: string): Promise<void> {
  const abs = path.resolve(target);
  const root = path.parse(abs).root;
  let current = root;
  for (const part of path.relative(root, abs).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`symlinked ancestor or path at ${current}`);
    if (current !== abs && !stat.isDirectory()) throw new Error(`non-directory ancestor at ${current}`);
  }
}

function slashPath(target: string): string {
  return target.split(path.sep).join('/');
}

async function inventory(root: string, includeVcsMetadata = false): Promise<Inventory> {
  await assertRealAncestors(root);
  const files: QuarantineFile[] = [];
  const directories: string[] = [];
  async function visit(relative: string): Promise<void> {
    const absolute = relative ? path.join(root, relative) : root;
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`identity is ambiguous at ${absolute}`);
    const entries = await fs.readdir(absolute);
    for (const name of entries) {
      if (!includeVcsMetadata && !relative && (name === '.jj' || name === '.git')) continue;
      const childRelative = relative ? path.join(relative, name) : name;
      const child = path.join(root, childRelative);
      const before = await fs.lstat(child);
      if (before.isSymbolicLink()) throw new Error(`symlink or replacement at ${child}`);
      if (before.isDirectory()) {
        directories.push(slashPath(childRelative));
        await visit(childRelative);
        continue;
      }
      if (!before.isFile()) throw new Error(`unsupported file identity at ${child}`);
      const content = await fs.readFile(child);
      const after = await fs.lstat(child);
      if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size) {
        throw new Error(`content changed during the identity check at ${child}`);
      }
      files.push({
        path: slashPath(childRelative),
        size: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
      });
    }
  }
  await visit('');
  files.sort((a, b) => a.path.localeCompare(b.path));
  directories.sort();
  return { files, directories };
}

function validRelative(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0')
    && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value
    && value !== '..' && !value.startsWith('../');
}

function recordedFiles(value: unknown): QuarantineFile[] | null {
  if (!Array.isArray(value)) return null;
  const files: QuarantineFile[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const file = entry as Record<string, unknown>;
    if (!validRelative(file.path) || seen.has(file.path) || !Number.isInteger(file.size)
      || Number(file.size) < 0 || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) return null;
    seen.add(file.path);
    files.push({ path: file.path, size: Number(file.size), sha256: file.sha256 });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function recordedDirectories(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => !validRelative(entry))) return null;
  const directories = [...value].sort();
  return new Set(directories).size === directories.length ? directories : null;
}

function sameInventory(current: Inventory, files: QuarantineFile[], directories: string[]): boolean {
  return JSON.stringify(current.files) === JSON.stringify(files)
    && JSON.stringify(current.directories) === JSON.stringify(directories);
}

function userInventory(full: Inventory): Inventory {
  const vcsPath = (target: string) => target === '.jj' || target.startsWith('.jj/')
    || target === '.git' || target.startsWith('.git/');
  return {
    files: full.files.filter((file) => !vcsPath(file.path)),
    directories: full.directories.filter((directory) => !vcsPath(directory)),
  };
}

async function listJjWorkspaces(home: string): Promise<JjWorkspaceList> {
  const result = await run('jj', ['-R', home, 'workspace', 'list', '-T', 'name ++ "\\t" ++ root ++ "\\n"'], home);
  if (result.code !== 0) return { code: result.code, stderr: result.stderr, entries: null };
  const entries: JjWorkspace[] = [];
  for (const line of result.stdout.split('\n').filter(Boolean)) {
    const tab = line.indexOf('\t');
    if (tab <= 0) return { code: 0, stderr: 'workspace list output is ambiguous', entries: null };
    const name = line.slice(0, tab).trim();
    const root = line.slice(tab + 1).trim();
    if (!name) return { code: 0, stderr: 'workspace list output is ambiguous', entries: null };
    if (root && !path.isAbsolute(root)) return { code: 0, stderr: 'workspace list output is ambiguous', entries: null };
    entries.push({ name, root: root ? path.resolve(root) : '' });
  }
  return { code: 0, stderr: '', entries };
}

async function gitPublicationBlocker(home: string, abs: string): Promise<string | null> {
  const head = await run('git', ['-C', abs, 'rev-parse', '--verify', 'HEAD'], home);
  if (head.code !== 0) return 'unborn or ambiguous HEAD; create and publish the initial commit before cleanup';
  const upstream = await run('git', ['-C', abs, 'rev-parse', '--symbolic-full-name', '@{upstream}'], home);
  if (upstream.code !== 0 || !upstream.stdout.trim().startsWith('refs/remotes/')) {
    return 'no remote upstream is recorded; publish the branch before cleanup';
  }
  const unpublished = await run('git', ['-C', abs, 'rev-list', '--count', '@{upstream}..HEAD'], home);
  if (unpublished.code !== 0 || !/^\d+$/.test(unpublished.stdout.trim())) {
    return `publication probe failed or is ambiguous: ${unpublished.stderr.trim() || unpublished.stdout.trim()}`;
  }
  if (unpublished.stdout.trim() !== '0') return 'unpublished commits; push the branch before cleanup';
  const upstreamName = await run('git', ['-C', abs, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], home);
  const match = upstreamName.stdout.trim().match(/^([^/\s]+)\/(.+)$/);
  if (upstreamName.code !== 0 || !match) return 'the remote upstream is ambiguous; publish a named remote branch before cleanup';
  const [, remote, branch] = match;
  const tracked = await run('git', ['-C', abs, 'rev-parse', '--verify', '@{upstream}'], home);
  if (tracked.code !== 0 || !/^[a-f0-9]{40}$/.test(tracked.stdout.trim())) {
    return 'the local remote-tracking identity is unavailable or ambiguous';
  }
  const fresh = await run('git', ['-C', abs, 'ls-remote', '--heads', remote, `refs/heads/${branch}`], home);
  const lines = fresh.stdout.trim().split('\n').filter(Boolean);
  const fields = lines.length === 1 ? lines[0].split(/\s+/) : [];
  if (fresh.code !== 0 || fields.length !== 2 || fields[1] !== `refs/heads/${branch}`) {
    return `fresh remote publication proof is unavailable: ${fresh.stderr.trim() || 'remote branch is missing or ambiguous'}`;
  }
  if (fields[0] !== tracked.stdout.trim()) return 'the remote branch changed; fetch and review the fresh state before cleanup';
  return null;
}

async function jjFreshPublicationBlocker(home: string, abs: string): Promise<string | null> {
  const parentResult = await run('jj', ['-R', abs, 'log', '--no-graph', '-r', '@-', '-T', 'commit_id ++ "\\n"'], home);
  const parents = parentResult.stdout.trim().split('\n').filter(Boolean);
  if (parentResult.code !== 0 || parents.length === 0
    || parents.some((parent) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(parent))) {
    return 'committed parent identity is unavailable or ambiguous';
  }
  const remoteResult = await run('git', ['-C', abs, 'remote'], home);
  const remotes = remoteResult.stdout.trim().split('\n').filter(Boolean);
  if (remoteResult.code !== 0 || remotes.length === 0) return 'no Git remote is available for fresh publication proof';
  const freshHeads: string[] = [];
  for (const remote of remotes) {
    const fresh = await run('git', ['-C', abs, 'ls-remote', '--heads', '--exit-code', remote], home);
    if (fresh.code === 2) continue;
    if (fresh.code !== 0) return `fresh remote publication proof failed for ${remote}: ${fresh.stderr.trim() || `exit ${fresh.code}`}`;
    for (const line of fresh.stdout.split('\n').filter(Boolean)) {
      const [sha, ref] = line.split(/\s+/);
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha) || !ref?.startsWith('refs/heads/')) {
        return `fresh remote publication proof from ${remote} is ambiguous`;
      }
      freshHeads.push(sha);
    }
  }
  for (const parent of parents) {
    if (freshHeads.includes(parent)) continue;
    let contained = false;
    for (const head of new Set(freshHeads)) {
      const object = await run('git', ['-C', abs, 'cat-file', '-e', `${head}^{commit}`], home);
      if (object.code !== 0) continue;
      const ancestry = await run('git', ['-C', abs, 'merge-base', '--is-ancestor', parent, head], home);
      if (ancestry.code === 0) {
        contained = true;
        break;
      }
    }
    if (!contained) return 'fresh remote heads do not contain every published parent; fetch and review before cleanup';
  }
  return null;
}

async function laneCheck(
  home: string,
  rec: ManifestRecord,
  records: ManifestRecord[],
  team: { agents: TeamEntry[] },
): Promise<LaneCheck> {
  const kind = rec.kind as LaneKind;
  const abs = path.resolve(String(rec.path));
  let stat;
  try {
    await assertRealAncestors(abs);
    stat = await lstat(abs);
  } catch (error) {
    return { error: `identity probe failed: ${errorText(error)}` };
  }
  if (!stat) return {};
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { error: 'symlink or replacement detected; the original path is retained' };
  if (path.resolve(home) === abs) return { error: 'the project home is a shared reference; the lane is retained' };
  if (records.some((other) => other !== rec && !other.quarantine_path
    && (other.kind === 'worktree' || other.kind === 'jj-workspace')
    && other.path && path.resolve(String(other.path)) === abs)) {
    return { error: 'another manifest record shares this path; the lane is retained' };
  }
  if (team.agents.some((agent) => !agent.closed_at && agent.worktree && path.resolve(agent.worktree) === abs)) {
    return { error: 'a live team entry references this path; close the agent before cleanup' };
  }
  if (kind === 'worktree') {
    const listing = await run('git', ['worktree', 'list', '--porcelain'], home);
    if (listing.code !== 0) return { error: `worktree listing probe failed: ${listing.stderr.trim() || `exit ${listing.code}`}` };
    if (!listing.stdout.split('\n').some((line) => line === `worktree ${abs}`)) {
      return { error: 'not a registered worktree; the path is retained' };
    }
    const status = await run('git', ['-C', abs, 'status', '--porcelain=v1', '--untracked-files=all'], home);
    if (status.code !== 0) return { error: `status probe failed: ${status.stderr.trim() || `exit ${status.code}`}` };
    if (status.stdout.trim()) return { error: 'dirty or untracked content; commit and publish it before cleanup' };
    const ignored = await run('git', ['-C', abs, 'ls-files', '--others', '--ignored', '--exclude-standard'], home);
    if (ignored.code !== 0) return { error: `ignored-content probe failed: ${ignored.stderr.trim() || `exit ${ignored.code}`}` };
    if (ignored.stdout.trim()) return { error: 'ignored content is not backed up; preserve or publish it before cleanup' };
    const publication = await gitPublicationBlocker(home, abs);
    return publication ? { error: publication } : {};
  }
  const listing = await listJjWorkspaces(home);
  if (listing.code !== 0 || !listing.entries) {
    return { error: `jj workspace listing probe failed: ${listing.stderr.trim() || `exit ${listing.code}`}` };
  }
  const workspace = listing.entries.find((entry) => entry.root === abs);
  if (!workspace) return { error: 'not a registered jj workspace; the path is retained' };
  const diff = await run('jj', ['-R', abs, 'diff', '--summary'], home);
  if (diff.code !== 0) return { error: `content diff probe failed: ${diff.stderr.trim() || `exit ${diff.code}`}` };
  if (diff.stdout.trim()) return { error: 'dirty or untracked content; commit and publish it before cleanup' };
  let current: Inventory;
  try {
    current = await inventory(abs);
  } catch (error) {
    return { error: `user-content inventory probe failed: ${errorText(error)}` };
  }
  const userFiles = current.files.map((file) => file.path);
  const ignored = userFiles.length
    ? await run('git', ['-C', abs, 'check-ignore', '--', ...userFiles], home)
    : { code: 1, stdout: '', stderr: '' };
  if (ignored.code !== 0 && ignored.code !== 1) {
    return { error: `ignored-content probe failed: ${ignored.stderr.trim() || `exit ${ignored.code}`}` };
  }
  if (ignored.stdout.trim()) return { error: 'ignored content is not backed up; preserve or publish it before cleanup' };
  const unpublished = await run('jj', ['-R', abs, 'log', '-r', 'remote_bookmarks()..@-', '-T', 'change_id ++ "\\n"'], home);
  if (unpublished.code !== 0) return { error: `publication probe failed: ${unpublished.stderr.trim() || `exit ${unpublished.code}`}` };
  if (unpublished.stdout.trim()) return { error: 'unpublished parent changes; push the workspace before cleanup' };
  const fresh = await jjFreshPublicationBlocker(home, abs);
  return fresh ? { error: fresh } : { workspaceName: workspace.name };
}

async function deregister(home: string, rec: ManifestRecord): Promise<RunResult> {
  const abs = path.resolve(String(rec.path));
  if (rec.kind === 'worktree') return run('git', ['worktree', 'prune'], home);
  let name = typeof rec.workspace_name === 'string' ? rec.workspace_name : '';
  if (!name) {
    const listing = await listJjWorkspaces(home);
    if (listing.code !== 0 || !listing.entries) {
      return { code: 1, stdout: '', stderr: listing.stderr || 'workspace listing failed' };
    }
    name = listing.entries.find((entry) => entry.root === abs)?.name ?? '';
    if (!name) return { code: 0, stdout: 'workspace already forgotten', stderr: '' };
  }
  const result = await run('jj', ['-R', home, 'workspace', 'forget', name], home);
  if (result.code === 0) return result;
  const listing = await listJjWorkspaces(home);
  if (listing.entries && !listing.entries.some((entry) => entry.name === name || entry.root === abs)) {
    return { code: 0, stdout: 'workspace already forgotten', stderr: '' };
  }
  return result;
}

function withoutQuarantine(rec: ManifestRecord): ManifestRecord {
  const original = { ...rec };
  for (const key of [
    'quarantine_path', 'quarantined_at', 'quarantine_expires_at', 'quarantine_files',
    'quarantine_directories', 'quarantine_deregistered', 'quarantine_pending', 'workspace_name',
  ]) delete original[key];
  return original;
}

async function quarantineLane(
  home: string,
  rec: ManifestRecord,
  records: ManifestRecord[],
  team: { agents: TeamEntry[] },
  trashDir: string,
  dryRun: boolean,
  store: StoreRecord,
): Promise<CleanupAction> {
  const kind = rec.kind as LaneKind;
  const label = kind === 'worktree' ? 'worktree' : 'jj workspace';
  const abs = path.resolve(String(rec.path));
  const check = await laneCheck(home, rec, records, team);
  if (check.error) return { record: rec, action: `left ${label} ${abs} alone: ${check.error}`, acted: false };
  const dest = path.join(trashDir, path.basename(abs));
  try {
    await assertRealAncestors(dest);
  } catch (error) {
    return { record: rec, action: `left ${label} ${abs} alone: ${errorText(error)}; the source is retained`, acted: false };
  }
  if (await lstat(dest)) {
    return { record: rec, action: `left ${label} ${abs} alone: destination collision at ${dest}; both paths are retained`, acted: false };
  }
  let snapshot: Inventory;
  try {
    snapshot = await inventory(abs);
  } catch (error) {
    return { record: rec, action: `left ${label} ${abs} alone: ${errorText(error)}; the source is retained`, acted: false };
  }
  if (dryRun) return { record: rec, action: `trash ${label} ${abs} -> ${dest}`, acted: false };
  await fs.mkdir(trashDir, { recursive: true });
  const at = new Date();
  const pending: ManifestRecord = {
    ...rec,
    path: abs,
    quarantine_path: dest,
    quarantined_at: at.toISOString(),
    quarantine_expires_at: new Date(at.getTime() + QUARANTINE_MS).toISOString(),
    quarantine_files: snapshot.files,
    quarantine_directories: snapshot.directories,
    quarantine_deregistered: false,
    quarantine_pending: true,
    ...(check.workspaceName ? { workspace_name: check.workspaceName } : {}),
  };
  await store(rec, pending);
  const secondCheck = await laneCheck(home, rec, records, team);
  const secondSnapshot = secondCheck.error ? null : await inventory(abs).catch(() => null);
  if (secondCheck.error || !secondSnapshot || !sameInventory(secondSnapshot, snapshot.files, snapshot.directories) || await lstat(dest)) {
    await store(pending, rec);
    const reason = secondCheck.error ?? 'content or destination changed before quarantine; retry cleanup';
    return { record: rec, action: `left ${label} ${abs} alone: ${reason}`, acted: false };
  }
  try {
    await fs.rename(abs, dest);
  } catch (error) {
    await store(pending, rec);
    return { record: rec, action: `quarantine failed for ${abs} -> ${dest}: ${errorText(error)}; the source is retained`, acted: false };
  }
  let quarantined: ManifestRecord;
  try {
    const movedSnapshot = await inventory(dest, true);
    if (!sameInventory(userInventory(movedSnapshot), snapshot.files, snapshot.directories)) {
      throw new Error('content changed during quarantine');
    }
    quarantined = {
      ...pending,
      quarantine_pending: false,
      quarantine_files: movedSnapshot.files,
      quarantine_directories: movedSnapshot.directories,
    };
    await store(pending, quarantined);
  } catch (error) {
    try {
      if (await lstat(abs)) throw new Error(`rollback destination is occupied: ${abs}`);
      await fs.rename(dest, abs);
      await store(pending, rec);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `quarantine completion failed and rollback failed for ${abs} -> ${dest}`);
    }
    throw error;
  }
  let result: RunResult;
  try {
    result = await deregister(home, quarantined);
  } catch (error) {
    return {
      record: quarantined,
      action: `deregistration failed after quarantine ${abs} -> ${dest}: ${errorText(error)}; retry cleanup`,
      acted: false,
    };
  }
  if (result.code !== 0) {
    return {
      record: quarantined,
      action: `deregistration failed after quarantine ${abs} -> ${dest}: ${result.stderr.trim() || `exit ${result.code}`}; retry cleanup`,
      acted: false,
    };
  }
  const completed = { ...quarantined, quarantine_deregistered: true };
  await store(quarantined, completed);
  return { record: completed, action: `trash ${label} ${abs} -> ${dest}`, acted: true };
}

async function retryQuarantine(
  home: string,
  rec: ManifestRecord,
  dryRun: boolean,
  store: StoreRecord,
): Promise<CleanupAction> {
  const source = path.resolve(String(rec.path));
  const dest = path.resolve(String(rec.quarantine_path));
  if (dryRun) return { record: rec, action: `retry deregistration for quarantined ${source} -> ${dest}`, acted: false };
  const [sourceStat, destStat] = await Promise.all([lstat(source), lstat(dest)]);
  if (sourceStat && !destStat) {
    const original = withoutQuarantine(rec);
    await store(rec, original);
    return { record: original, action: `reconciled pending quarantine; the source ${source} is retained`, acted: true };
  }
  if (!sourceStat && !destStat || sourceStat && destStat) {
    return { record: rec, action: `retained ambiguous quarantine ${source} -> ${dest}; inspect both paths before retry`, acted: false };
  }
  let ready = rec;
  if (rec.quarantine_pending) {
    const files = recordedFiles(rec.quarantine_files);
    const directories = recordedDirectories(rec.quarantine_directories);
    const current = await inventory(dest, true).catch(() => null);
    if (!files || !directories || !current || !sameInventory(userInventory(current), files, directories)) {
      return { record: rec, action: `retained pending quarantine ${dest}: content identity is ambiguous`, acted: false };
    }
    ready = {
      ...rec,
      quarantine_pending: false,
      quarantine_files: current.files,
      quarantine_directories: current.directories,
    };
    await store(rec, ready);
  }
  const result = await deregister(home, ready);
  if (result.code !== 0) {
    return {
      record: ready,
      action: `deregistration retry failed for ${source} -> ${dest}: ${result.stderr.trim() || `exit ${result.code}`}`,
      acted: false,
    };
  }
  const completed = { ...ready, quarantine_deregistered: true, quarantine_pending: false };
  await store(ready, completed);
  return { record: completed, action: `deregistered quarantined ${rec.kind} ${source} -> ${dest}`, acted: true };
}

async function reclaimQuarantine(
  home: string,
  rec: ManifestRecord,
  dryRun: boolean,
  ownerApproved: boolean,
  store: StoreRecord,
): Promise<CleanupAction> {
  const dest = path.resolve(String(rec.quarantine_path ?? ''));
  const trash = path.resolve(hivePath(home, 'trash'));
  const relative = path.relative(trash, dest);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { record: rec, action: `retained quarantine ${dest}: the path is outside the project trash`, acted: false };
  }
  if (rec.quarantine_deregistered === false) {
    return { record: rec, action: `retained quarantine ${dest}: deregistration is pending; retry cleanup first`, acted: false };
  }
  if (!ownerApproved && !dryRun) {
    return { record: rec, action: `retained quarantine ${dest}: owner approval is required for reclamation`, acted: false };
  }
  const expiresAt = Date.parse(String(rec.quarantine_expires_at ?? ''));
  if (!Number.isFinite(expiresAt) || expiresAt > Date.now()) {
    return { record: rec, action: `retained quarantine ${dest}: the expiry is invalid or has not passed`, acted: false };
  }
  const expectedFiles = recordedFiles(rec.quarantine_files);
  const expectedDirectories = recordedDirectories(rec.quarantine_directories);
  if (!expectedFiles || !expectedDirectories) {
    return { record: rec, action: `retained quarantine ${dest}: the recorded identity is ambiguous`, acted: false };
  }
  let current: Inventory;
  try {
    current = await inventory(dest, true);
  } catch (error) {
    return { record: rec, action: `retained quarantine ${dest}: ${errorText(error)}`, acted: false };
  }
  if (!sameInventory(current, expectedFiles, expectedDirectories)) {
    return { record: rec, action: `retained quarantine ${dest}: changed content, a sentinel, or an added path makes the identity ambiguous`, acted: false };
  }
  if (dryRun) return { record: rec, action: `reclaim verified expired quarantine ${dest}`, acted: false };
  const stage = path.join(path.dirname(dest), `.reclaim-${path.basename(dest)}-${process.pid}-${randomUUID()}`);
  try {
    await assertRealAncestors(stage);
  } catch (error) {
    return { record: rec, action: `retained quarantine ${dest}: ${errorText(error)}`, acted: false };
  }
  try {
    await fs.rename(dest, stage);
  } catch (error) {
    return { record: rec, action: `retained quarantine ${dest}: deletion staging failed: ${errorText(error)}`, acted: false };
  }
  const staged = await inventory(stage, true).catch(() => null);
  if (!staged || !sameInventory(staged, expectedFiles, expectedDirectories)) {
    if (!await lstat(dest)) {
      try {
        await fs.rename(stage, dest);
      } catch (error) {
        const retained = { ...rec, quarantine_path: stage };
        await store(rec, retained);
        return {
          record: retained,
          action: `retained quarantine ${dest} at staged recovery path ${stage}: restoration failed: ${errorText(error)}`,
          acted: false,
        };
      }
    } else {
      const retained = { ...rec, quarantine_path: stage };
      await store(rec, retained);
      return { record: retained, action: `retained replaced quarantine; verified content remains at ${stage}`, acted: false };
    }
    return { record: rec, action: `retained quarantine ${dest}: content changed during deletion staging`, acted: false };
  }
  try {
    await fs.rm(stage, { recursive: true, force: false });
  } catch (error) {
    if (!await lstat(dest)) {
      try {
        await fs.rename(stage, dest);
        return { record: rec, action: `retained quarantine ${dest}: reclamation failed: ${errorText(error)}`, acted: false };
      } catch (restoreError) {
        const retained = { ...rec, quarantine_path: stage };
        await store(rec, retained);
        return {
          record: retained,
          action: `retained quarantine ${dest} at staged recovery path ${stage}: ${errorText(error)}; restoration failed: ${errorText(restoreError)}`,
          acted: false,
        };
      }
    }
    const retained = { ...rec, quarantine_path: stage };
    await store(rec, retained);
    return { record: retained, action: `retained quarantine at ${stage}: reclamation failed: ${errorText(error)}`, acted: false };
  }
  await store(rec, null);
  return { record: rec, action: `reclaimed verified expired quarantine ${dest}`, acted: true };
}

export async function cleanupProject(
  root: string,
  project: string,
  { dryRun = false, reclaimTrash = false, ownerApproved = false }: CleanupOptions = {},
): Promise<CleanupAction[]> {
  const pf = await readProjects(root);
  const p = pf.projects.find((x) => x.name === project);
  if (!p) throw new Error(`unknown project: ${project}`);
  const records = await manifestRead(p.home);
  const actions: CleanupAction[] = [];
  const team = await readTeam(p.home);
  const trashDir = hivePath(p.home, 'trash', new Date().toISOString().slice(0, 10));
  const store: StoreRecord = async (old, replacement) => {
    await manifestUpdate(p.home, (current) => {
      const matches = current.filter((candidate) => canonicalJson(candidate) === canonicalJson(old));
      if (matches.length !== 1) throw new Error('the cleanup manifest record is missing or ambiguous');
      const index = current.indexOf(matches[0]);
      const next = [...current];
      if (replacement) next[index] = replacement;
      else next.splice(index, 1);
      return next;
    });
  };

  for (const rec of records) {
    if (rec.quarantine_path !== undefined) {
      if (reclaimTrash) {
        actions.push(await reclaimQuarantine(p.home, rec, dryRun, ownerApproved, store));
      } else if (rec.quarantine_deregistered === false) {
        actions.push(await retryQuarantine(p.home, rec, dryRun, store));
      }
      continue;
    }
    if (rec.kind === 'tmux') {
      const pane = String(rec.pane ?? '');
      if (!pane || !(await paneExists(pane))) {
        if (!dryRun) await store(rec, null);
        continue;
      }
      const pid = Number(rec.pane_pid ?? 0);
      const started = String(rec.pane_started ?? '');
      const identity: PaneIdentity | null = pid && started ? { pid, started } : null;
      if (!identity || !(await paneIs(pane, identity))) {
        actions.push({
          record: rec,
          action: `left tmux window ${rec.window ?? pane} (${pane}) alone: ${identity ? 'pane identity no longer matches the record' : 'record has no pane identity'}`,
          acted: false,
        });
        continue;
      }
      actions.push({ record: rec, action: `kill tmux window ${rec.window ?? pane} (${pane})`, acted: !dryRun });
      if (!dryRun) {
        const latestTeam = await readTeam(p.home);
        const stamped: TeamEntry[] = [];
        for (const entry of latestTeam.agents.filter((candidate) => candidate.pane === pane)) {
          const updated = await compareAndSwapTeamEntry(p.home, entry, {
            closed_at: new Date().toISOString(),
            ...(entry.task ? { lease_revoked: true, admission_status: 'revoked' as const } : {}),
          });
          if (updated) {
            stamped.push(updated);
            if (entry.task) await revokeTmuxAdmission(root, p.home, updated);
          }
        }
        try {
          await killWindow(pane, identity);
        } catch (error) {
          for (const entry of stamped) {
            const currentEntry = entry.lease_id === undefined ? entry
              : (await readTeam(p.home)).agents.find((candidate) => candidate.lease_id === entry.lease_id);
            if (currentEntry) await compareAndSwapTeamEntry(p.home, currentEntry, { closed_at: undefined });
          }
          throw error;
        }
        for (const entry of stamped) await releasePendingLaunchClaim(root, entry);
        await store(rec, null);
      }
      continue;
    }
    if (rec.kind === 'process') {
      const pid = Number(rec.pid ?? 0);
      let started: string | null;
      try {
        started = await processStartTime(pid);
      } catch (error) {
        actions.push({ record: rec, action: `process ${pid} retained: identity probe failed: ${errorText(error)}`, acted: false });
        continue;
      }
      if (pid && started && started === rec.started) {
        if (dryRun) {
          actions.push({ record: rec, action: `terminate process ${pid}`, acted: false });
          continue;
        }
        try {
          process.kill(pid, 'SIGTERM');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          actions.push({ record: rec, action: `terminate process ${pid}`, acted: true });
          await store(rec, null);
          continue;
        }
        let after: string | null;
        try {
          after = await processStartTime(pid);
        } catch (error) {
          actions.push({ record: rec, action: `process ${pid} retained after SIGTERM: exit probe failed: ${errorText(error)}`, acted: false });
          continue;
        }
        if (after === rec.started || after === null && !processIsAbsent(pid)) {
          actions.push({ record: rec, action: `process ${pid} retained after SIGTERM: exit is not verified`, acted: false });
          continue;
        }
        actions.push({ record: rec, action: `terminate process ${pid}`, acted: true });
        await store(rec, null);
      } else if (!dryRun) {
        if (pid && started === null && !processIsAbsent(pid)) {
          actions.push({ record: rec, action: `process ${pid} retained: absence is not verified`, acted: false });
          continue;
        }
        await store(rec, null);
      }
      continue;
    }
    if (rec.kind === 'worktree' || rec.kind === 'jj-workspace') {
      const abs = rec.path ? path.resolve(String(rec.path)) : '';
      if (!abs || !(await lstat(abs))) {
        if (!dryRun) await store(rec, null);
        continue;
      }
      actions.push(await quarantineLane(p.home, rec, records, team, trashDir, dryRun, store));
    }
  }

  return actions;
}
