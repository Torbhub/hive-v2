import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PROJECT_NAME_RE } from './names.js';
import {
  hubPath, readPendingPane, readProjects, readTeam, Refusal, withHubLock, writeJson, writeProjects, type ProjectsFile,
} from './state.js';
import { APPROVALS_MODES, PROJECT_MODES } from './types.js';
import type { Approvals, ProjectMode } from './types.js';

// The web add path is stricter than hubAdd: the path must be absolute and
// hold a git repo (a .git directory, or a .git worktree pointer file).
export async function addProject(
  root: string,
  name: string,
  folder: string,
  opts: { mode?: string; approvals?: string } = {},
): Promise<void> {
  if (!PROJECT_NAME_RE.test(name)) {
    throw new Refusal(`a project name is lowercase letters, digits, '-': ${name}`);
  }
  if (opts.mode !== undefined && !(PROJECT_MODES as readonly string[]).includes(opts.mode)) {
    throw new Refusal(`a mode is ask|yolo|auto: ${opts.mode}`);
  }
  if (opts.approvals !== undefined && !(APPROVALS_MODES as readonly string[]).includes(opts.approvals)) {
    throw new Refusal(`approvals is manual|safe|smart: ${opts.approvals}`);
  }
  if (!path.isAbsolute(folder)) throw new Refusal(`the path must be absolute: ${folder}`);
  const home = path.resolve(folder);
  const st = await fs.stat(home).catch(() => null);
  if (!st?.isDirectory()) throw new Refusal(`not a folder: ${folder}`);
  if (!(await looksLikeGit(home))) throw new Refusal(`not a git repo: ${folder}`);
  const pf = await readProjects(root);
  if (pf.projects.some((p) => p.name === name)) throw new Refusal(`a project named ${name} exists`);
  const project: ProjectsFile['projects'][number] = { name, home, repos: [{ folder: home }] };
  if (opts.mode !== undefined) project.mode = opts.mode as ProjectMode;
  if (opts.approvals !== undefined) project.approvals = opts.approvals as Approvals;
  pf.projects.push(project);
  await writeProjects(root, pf);
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
): Promise<{ ok: true; name: string }> {
  const name = String(body.name ?? '');
  await addProject(root, name, String(body.path ?? ''), {
    mode: body.mode === undefined ? undefined : String(body.mode),
    approvals: body.approvals === undefined ? undefined : String(body.approvals),
  });
  return { ok: true, name };
}
