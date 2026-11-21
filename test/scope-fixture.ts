import { execFileSync } from 'node:child_process';
import { promises as fs, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitTmux } from '../src/admission.js';
import { evaluateTaskPredicate, hubAdd, hubInit, hubTask } from '../src/hub.js';
import { taskScope } from '../src/scope.js';
import { spawnAgent } from '../src/spawn.js';
import { appendTaskEvent, contractDigest, hivePath, hubPath } from '../src/state.js';
import { approveContract, taskContract } from './task-contract.js';

export const IDLE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'idle-empty-prompt.txt'),
  'utf8',
);

export function spawn(root: string, opts: Parameters<typeof spawnAgent>[2]): Promise<string> {
  return spawnAgent(root, 'demo', {
    assignment: 'Complete the bounded scope assignment in the requested files.',
    deliverable: 'Return the named artifact and verification evidence to the orchestrator.',
    ...opts,
  });
}

export function brief(scope: string | null): string {
  const fm = '---\ntitle: "x"\nstatus: ready\ndeps: []\nmax_diff_lines: 300\n---\n\n## Goal\nx\n';
  return fm + (scope === null ? '' : `\n## Files to touch\n${scope}\n`);
}

export async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'hive-scope-'));
  const home = path.join(root, 'demo');
  await fs.mkdir(home, { recursive: true });
  await hubInit(root);
  await hubAdd(root, 'demo', home);
  return { root, home };
}

export async function writeTask(root: string, id: string, text: string) {
  await fs.writeFile(hubPath(root, 'tasks', `${id}.md`), text);
  const project = id.replace(/-\d+$/, '');
  await appendTaskEvent(root, { id, project, event: 'asked', at: new Date().toISOString() });
  const scope = taskScope(text);
  const writeScope = scope.kind === 'claim' ? [...scope.paths] : [];
  await approveContract(root, id, taskContract(
    path.join(root, 'demo'), writeScope, 'Return the named artifact and verification evidence to the orchestrator.',
  ));
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

export async function gitRepo() {
  const repository = await fs.mkdtemp(path.join(tmpdir(), 'hive-git-scope-'));
  git(repository, ['init', '-q']);
  git(repository, ['config', 'user.email', 'hive@example.invalid']);
  git(repository, ['config', 'user.name', 'Hive Test']);
  await fs.mkdir(path.join(repository, 'src'));
  await fs.writeFile(path.join(repository, '.gitignore'), 'ignored.txt\n');
  await fs.writeFile(path.join(repository, 'src', 'a.txt'), 'base\n');
  await fs.writeFile(path.join(repository, 'outside.txt'), 'base\n');
  git(repository, ['add', '.']);
  git(repository, ['commit', '-qm', 'base']);
  const base = git(repository, ['rev-parse', 'HEAD']);
  return { repository, base };
}

export async function artifact(repository: string): Promise<string> {
  git(repository, ['add', '-A']);
  if (git(repository, ['status', '--porcelain'])) git(repository, ['commit', '-qm', 'artifact']);
  return git(repository, ['rev-parse', 'HEAD']);
}

export async function admitted(repository: string, base: string, artifactRevision: string, agent = 'builder', useWorktree = true) {
  await hubInit(repository);
  await hubAdd(repository, 'demo', repository);
  const output = 'Return the named artifact and verification evidence to the orchestrator.';
  const contract = {
    ...taskContract(repository, ['src'], output),
    provenance: { repository, base_revision: base, artifact_revision: artifactRevision },
  };
  const id = await hubTask(repository, 'demo', 'bounded Git work');
  await approveContract(repository, id, contract);
  const worktree = useWorktree ? `${repository}-lane-${agent}` : repository;
  if (useWorktree) git(repository, ['worktree', 'add', '-q', '--detach', worktree, artifactRevision]);
  const admission = await admitTmux(repository, repository, id, agent, {
    parent_id: id,
    plan_digest: contractDigest(contract),
    output_claim: output,
    acceptance_ids: ['diff'],
    provenance: contract.provenance,
    write_scope: ['src'],
    adapter: 'tmux',
  }, { worktree });
  return { id, admission, contract, worktree };
}

export async function evaluateScope(repository: string, id: string, leaseId: string, base: string, artifactRevision: string) {
  return evaluateTaskPredicate(repository, id, 'git_diff_scope', {
    lease_id: leaseId, base_revision: base, artifact_revision: artifactRevision,
  });
}

export async function jjRepo() {
  const repository = await fs.mkdtemp(path.join(tmpdir(), 'hive-jj-scope-'));
  execFileSync('jj', ['git', 'init', repository]);
  execFileSync('jj', ['config', 'set', '--repo', 'user.email', 'hive@example.invalid'], { cwd: repository });
  execFileSync('jj', ['config', 'set', '--repo', 'user.name', 'Hive Test'], { cwd: repository });
  await fs.mkdir(path.join(repository, 'src'));
  await fs.writeFile(path.join(repository, 'src', 'a.txt'), 'base\n');
  await fs.writeFile(path.join(repository, 'outside.txt'), 'base\n');
  await fs.writeFile(path.join(repository, '.gitignore'), 'ignored.txt\n');
  execFileSync('jj', ['new', '-m', 'base'], { cwd: repository });
  const base = execFileSync('jj', ['log', '-r', '@-', '-T', 'commit_id', '--no-graph'], { cwd: repository, encoding: 'utf8' }).trim();
  return { repository, base };
}
