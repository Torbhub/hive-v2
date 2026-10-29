import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { PROJECT_NAME_RE } from './names.js';
import {
  hubPath, readPendingPane, readProjects, readTeam, Refusal, withHubLock, writeJson, writeProjects, type ProjectsFile,
} from './state.js';
import { APPROVALS_MODES, PROJECT_MODES } from './types.js';
import type { Approvals, ProjectMode } from './types.js';
import { run } from './tmux.js';

type AddOptions = { mode?: string; approvals?: string; source?: string; legacy?: boolean };
type Source = { home: string; kind: 'jj' | 'git' };
type AddResult = { ok: true; name: string; home: string };
type Identity = { dev: bigint; ino: bigint; birthtimeNs: bigint };
type Allocation = {
  home: string; identity: Identity | null; createCommand?: 'jj' | 'git'; workspaceName?: string;
};

const PROCESS_TIMEOUT_MS = 30_000;

function boundedRun(cmd: string, args: string[], cwd: string) {
  return run(cmd, args, cwd, undefined, PROCESS_TIMEOUT_MS);
}

function sameIdentity(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
}

async function directoryIdentity(home: string): Promise<Identity | null> {
  const st = await fs.lstat(home, { bigint: true }).catch(() => null);
  return st?.isDirectory() ? { dev: st.dev, ino: st.ino, birthtimeNs: st.birthtimeNs } : null;
}

async function assertIdentity(allocation: Allocation): Promise<void> {
  const current = await directoryIdentity(allocation.home);
  if (!allocation.identity || !current || !sameIdentity(current, allocation.identity)) {
    throw new Refusal(`the project home changed identity: ${allocation.home}`);
  }
}

async function canonicalHome(home: string): Promise<string> {
  return fs.realpath(home).catch(() => path.resolve(home));
}

async function commandRoot(home: string, output: string): Promise<string> {
  const reported = path.resolve(home, output.trim());
  return canonicalHome(reported);
}

async function sourceRepository(root: string, folder: string): Promise<Source> {
  const requested = path.resolve(root, folder);
  const home = await fs.realpath(requested).catch(() => null);
  const st = home ? await fs.stat(home).catch(() => null) : null;
  if (!home || !st?.isDirectory()) throw new Refusal(`not a folder: ${folder}`);
  const jj = await boundedRun('jj', ['-R', home, 'root'], home);
  if (jj.code === 0 && jj.stdout.trim() && await commandRoot(home, jj.stdout) === home) {
    return { home, kind: 'jj' };
  }
  const git = await boundedRun('git', ['-C', home, 'rev-parse', '--show-toplevel'], home);
  if (git.code === 0 && git.stdout.trim() && await commandRoot(home, git.stdout) === home) {
    return { home, kind: 'git' };
  }
  throw new Refusal(`the source must be a repository root: ${folder}`);
}

async function registeredHomes(pf: ProjectsFile): Promise<Set<string>> {
  return new Set(await Promise.all(pf.projects.map((p) => canonicalHome(p.home))));
}

async function allocateHome(root: string, name: string, registered: Set<string>): Promise<Allocation> {
  let suffix = '';
  for (;;) {
    const home = path.join(root, `${name}${suffix}`);
    if (!registered.has(await canonicalHome(home))) {
      try {
        await fs.mkdir(home);
        return { home, identity: await directoryIdentity(home) };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
    suffix = `-${randomBytes(4).toString('hex')}`;
  }
}

async function explicitHome(root: string, folder: string, legacy: boolean): Promise<Allocation> {
  const requested = path.resolve(root, folder);
  let home = await fs.realpath(requested).catch(() => null);
  if (!home && !legacy) {
    await fs.mkdir(requested, { recursive: true });
    home = await fs.realpath(requested).catch(() => null);
  }
  const identity = home ? await directoryIdentity(home) : null;
  if (!home || !identity) throw new Refusal(`not a folder: ${legacy ? requested : folder}`);
  return { home, identity };
}

async function jjBaseRev(home: string): Promise<string> {
  for (const rev of ['main@origin', 'main', '@']) {
    const probe = await boundedRun('jj', ['-R', home, 'log', '-r', rev, '-T', "''", '--no-graph', '--limit', '1'], home);
    if (probe.code === 0) return rev;
  }
  throw new Refusal(`jj: no base revision in ${home} (tried main@origin, main, @)`);
}

function commandError(command: string, result: { stderr: string }): string {
  return `${command} failed: ${result.stderr.trim() || 'command failed or timed out'}`;
}

async function createRepository(allocation: Allocation, source?: Source): Promise<void> {
  const { home } = allocation;
  if (!source) {
    const made = await boundedRun('git', ['init', '-q', home], home);
    await assertIdentity(allocation);
    if (made.code !== 0) throw new Refusal(commandError('git init', made));
    return;
  }
  let made;
  if (source.kind === 'jj') {
    const base = await jjBaseRev(source.home);
    allocation.createCommand = 'jj';
    allocation.workspaceName = `${path.basename(home)}-${randomUUID()}`;
    made = await boundedRun('jj', [
      '-R', source.home, 'workspace', 'add', home, '-r', base, '--name', allocation.workspaceName,
    ], source.home);
  } else {
    allocation.createCommand = 'git';
    made = await boundedRun('git', ['-C', source.home, 'worktree', 'add', '--detach', home, 'HEAD'], source.home);
  }
  await assertIdentity(allocation);
  if (made.code !== 0) {
    const command = source.kind === 'jj' ? 'jj workspace add' : 'git worktree add';
    throw new Refusal(commandError(command, made));
  }
}

async function cleanupAllocation(allocation: Allocation, source?: Source): Promise<string[]> {
  const errors: string[] = [];
  const { home } = allocation;
  if (source && allocation.createCommand === 'jj') {
    const forgotten = await boundedRun('jj', [
      '-R', source.home, 'workspace', 'forget', allocation.workspaceName!,
    ], source.home);
    if (forgotten.code !== 0) return [commandError('jj workspace forget', forgotten)];
  }
  if (source && allocation.createCommand === 'git' && allocation.identity) {
    const current = await directoryIdentity(home);
    if (!current || !sameIdentity(current, allocation.identity)) {
      errors.push(`cleanup left a changed path in place: ${home}`);
      return errors;
    }
    const gitMetadata = await fs.lstat(path.join(home, '.git')).catch(() => null);
    if (gitMetadata) {
      const removed = await boundedRun('git', ['-C', source.home, 'worktree', 'remove', '--force', home], source.home);
      if (removed.code !== 0) return [commandError('git worktree remove', removed)];
    }
  }
  const st = await fs.lstat(home, { bigint: true }).catch(() => null);
  if (!st) return errors;
  if (!st.isDirectory() || !allocation.identity || !sameIdentity(st, allocation.identity)) {
    errors.push(`cleanup left a changed path in place: ${home}`);
    return errors;
  }
  await fs.rm(home, { recursive: true, force: true });
  return errors;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function addProject(
  root: string,
  name: string,
  folder: string,
  opts: AddOptions = {},
): Promise<AddResult> {
  if (!PROJECT_NAME_RE.test(name)) {
    throw new Refusal(`a project name is lowercase letters, digits, '-': ${name}`);
  }
  if (opts.mode !== undefined && !(PROJECT_MODES as readonly string[]).includes(opts.mode)) {
    throw new Refusal(`a mode is ask|yolo|auto: ${opts.mode}`);
  }
  if (opts.approvals !== undefined && !(APPROVALS_MODES as readonly string[]).includes(opts.approvals)) {
    throw new Refusal(`approvals is manual|safe|smart: ${opts.approvals}`);
  }
  const automatic = folder.trim() === '';
  if (!automatic && opts.source) throw new Refusal('a source cannot be used with an explicit path');
  if (!automatic && !opts.legacy && !path.isAbsolute(folder)) {
    throw new Refusal(`the path must be absolute: ${folder}`);
  }

  return withHubLock(root, async () => {
    const pf = await readProjects(root);
    if (pf.projects.some((p) => p.name === name)) throw new Refusal(`a project named ${name} exists`);
    const source = opts.source ? await sourceRepository(root, opts.source) : undefined;
    const allocation = automatic
      ? await allocateHome(root, name, await registeredHomes(pf))
      : await explicitHome(root, folder, opts.legacy === true);
    if (!automatic && (await registeredHomes(pf)).has(allocation.home)) {
      throw new Refusal(`the project home is already registered: ${allocation.home}`);
    }
    try {
      if (automatic) {
        await createRepository(allocation, source);
        await assertIdentity(allocation);
        await fs.rm(path.join(allocation.home, '.hive'), { recursive: true, force: true });
      } else if (!opts.legacy && !(await looksLikeGit(allocation.home))) {
        if (await fs.lstat(path.join(allocation.home, '.git')).catch(() => null)) {
          throw new Refusal(`not a git repo: ${folder}`);
        }
        await createRepository(allocation);
      }
      await assertIdentity(allocation);
      const project: ProjectsFile['projects'][number] = {
        name, home: allocation.home, repos: [{ folder: allocation.home }],
      };
      if (opts.mode !== undefined) project.mode = opts.mode as ProjectMode;
      if (opts.approvals !== undefined) project.approvals = opts.approvals as Approvals;
      await writeProjects(root, { ...pf, projects: [...pf.projects, project] });
      return { ok: true, name, home: allocation.home };
    } catch (e) {
      if (automatic) {
        const cleanupErrors = await cleanupAllocation(allocation, source);
        if (cleanupErrors.length) {
          throw new Refusal(`${errorMessage(e)}. Cleanup failed: ${cleanupErrors.join('. ')}`);
        }
      }
      throw e;
    }
  });
}

// A .git directory, or a .git file holding a worktree pointer. lstat, so a
// symlink (even one pointing at a real repo) is refused.
async function looksLikeGit(home: string): Promise<boolean> {
  const gitPath = path.join(home, '.git');
  const st = await fs.lstat(gitPath).catch(() => null);
  if (st?.isDirectory()) return true;
  if (!st?.isFile()) return false;
  const content = await fs.readFile(gitPath, 'utf8').catch(() => '');
  return content.startsWith('gitdir:');
}

type ProjectEntry = ProjectsFile['projects'][number];

export async function withProjectLock<T>(
  root: string,
  name: string,
  fn: (project: ProjectEntry) => Promise<T>,
): Promise<T> {
  return withHubLock(root, async () => {
    const project = (await readProjects(root)).projects.find((p) => p.name === name);
    if (!project) throw new Refusal(`unknown project: ${name}`);
    return fn(project);
  });
}

async function hasLaunchClaim(root: string, name: string): Promise<boolean> {
  const claims = await fs.readdir(hubPath(root, 'launches')).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return [];
    throw e;
  });
  return claims.some((claim) => claim.startsWith(`${name}:`) && claim.endsWith('.json'));
}

export async function withLaunchClaim<T>(
  root: string,
  name: string,
  fn: (project: ProjectEntry) => Promise<T>,
): Promise<T> {
  const file = hubPath(root, 'launches', `${name}:${randomUUID()}.json`);
  const project = await withProjectLock(root, name, async (registered) => {
    await writeJson(file, { project: name, at: new Date().toISOString() });
    return registered;
  });
  try {
    return await fn(project);
  } finally {
    await fs.rm(file, { force: true });
  }
}

export async function removeProject(root: string, name: string): Promise<{ ok: true; name: string }> {
  return withHubLock(root, async () => {
    const pf = await readProjects(root);
    const project = pf.projects.find((p) => p.name === name);
    if (!project) throw new Refusal(`unknown project: ${name}`);
    if (await readPendingPane(root, name) || await hasLaunchClaim(root, name)) {
      throw new Refusal(`${name}'s launch is pending`);
    }
    if ((await readTeam(project.home)).agents.length > 0) {
      throw new Refusal(`${name}'s team is not empty`);
    }
    await writeProjects(root, { ...pf, projects: pf.projects.filter((p) => p.name !== name) });
    return { ok: true, name };
  });
}

export async function addProjectFromBody(
  root: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; name: string; home: string }> {
  return addProject(root, String(body.name ?? ''), String(body.path ?? ''), {
    mode: body.mode === undefined ? undefined : String(body.mode),
    approvals: body.approvals === undefined ? undefined : String(body.approvals),
    source: body.source === undefined ? undefined : String(body.source),
  });
}
