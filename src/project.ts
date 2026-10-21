import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Refusal } from './hub.js';
import { readProjects, writeProjects, type ProjectsFile } from './state.js';
import { APPROVALS_MODES, PROJECT_MODES } from './types.js';
import type { Approvals, ProjectMode } from './types.js';

// The web add path is stricter than hubAdd: the path must be absolute and
// hold a git repo (a .git directory, or a .git file for a worktree).
export async function addProject(
  root: string,
  name: string,
  folder: string,
  opts: { mode?: string; approvals?: string } = {},
): Promise<void> {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) {
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
  const gitDir = await fs.stat(path.join(home, '.git')).catch(() => null);
  if (!gitDir) throw new Refusal(`not a git repo: ${folder}`);
  const pf = await readProjects(root);
  if (pf.projects.some((p) => p.name === name)) throw new Refusal(`a project named ${name} exists`);
  const project: ProjectsFile['projects'][number] = { name, home, repos: [{ folder: home }] };
  if (opts.mode !== undefined) project.mode = opts.mode as ProjectMode;
  if (opts.approvals !== undefined) project.approvals = opts.approvals as Approvals;
  pf.projects.push(project);
  await writeProjects(root, pf);
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
