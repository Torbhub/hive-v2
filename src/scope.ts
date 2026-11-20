import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Refusal, valueDigest } from './state.js';

const FRONTMATTER = /^---\n([\s\S]*?)\n---(?:\n|$)/;
const FILES_SECTION = /^## Files to touch\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m;
const BULLET = /^\s*-\s/;
const BULLET_PATH = /^\s*-\s+(?:NEW\s+)?`?([^\s`()]+)`?(\s+[—(].*)?\s*$/;
const REVISION = /^[0-9a-f]{40}$/i;
const PROTECTED_EXACT = new Set([
  '.hive/team.json', 'scripts/discipline-gate.mjs',
  'src/admission.ts', 'src/scope.ts', 'src/state.ts', 'src/types.ts', 'src/taskgate.ts',
  'src/evidence.ts', 'src/questions.ts', 'src/gate.ts', 'src/push-cli.ts',
  'src/spawn.ts', 'src/watch.ts', 'src/kill.ts', 'src/launch.ts', 'src/compact.ts',
  'src/cleanup.ts', 'src/daydream-automation.ts', 'web/actions.ts', 'web/taskactions.ts',
]);
const PROTECTED_PREFIXES = ['.hive/team/', '.hive/handoffs/', '.hive-hub/', '.github/', 'roles/', 'rules/', 'skills/'];

export type Scope =
  | { kind: 'none' }
  | { kind: 'invalid'; why: string }
  | { kind: 'claim'; paths: Set<string> };

export function taskScope(text: string): Scope {
  if (text.startsWith('---') && !FRONTMATTER.test(text)) {
    return { kind: 'invalid', why: 'the frontmatter never closes' };
  }
  const match = text.match(FILES_SECTION);
  if (!match) return { kind: 'none' };
  const paths = new Set<string>();
  for (const line of match[1].split('\n')) {
    if (!BULLET.test(line)) continue;
    const bullet = line.match(BULLET_PATH);
    if (!bullet || bullet[1].startsWith('—') || bullet[1] === 'NEW') {
      return { kind: 'invalid', why: `a Files to touch bullet has no path: ${line.trim()}` };
    }
    paths.add(bullet[1]);
  }
  if (paths.size === 0) return { kind: 'invalid', why: 'the Files to touch section is empty' };
  return { kind: 'claim', paths };
}

function canonicalClaim(claim: string): string {
  if (!claim || claim !== claim.trim() || claim.includes('\0') || claim.includes('\\')) {
    throw new Refusal(`scope path is empty or ambiguous: ${JSON.stringify(claim)}`);
  }
  if (path.isAbsolute(claim) || path.posix.isAbsolute(claim) || /^[A-Za-z]:[\\/]|^\\\\/.test(claim)) {
    throw new Refusal(`scope path must be repository-relative: ${claim}`);
  }
  if (claim.split('/').includes('..') || [...'*?[]{}'].some((character) => claim.includes(character))) {
    throw new Refusal(`scope path escapes the repository or is ambiguous: ${claim}`);
  }
  const normalized = path.posix.normalize(claim);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new Refusal(`scope path escapes the repository root: ${claim}`);
  }
  return normalized;
}

export function protectedClaim(claim: string): boolean {
  return PROTECTED_EXACT.has(claim) || PROTECTED_PREFIXES.some((prefix) => claim.startsWith(prefix));
}

async function canonicalRepositoryClaim(root: string, claim: string): Promise<string> {
  const normalized = canonicalClaim(claim);
  const suffix: string[] = [];
  let current = normalized;
  for (;;) {
    const absolute = path.join(root, current);
    const stat = await fs.lstat(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat) {
      if (suffix.length && !(await fs.stat(absolute)).isDirectory()) {
        throw new Refusal(`scope path crosses a file: ${claim}`);
      }
      const real = await fs.realpath(absolute);
      if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
        throw new Refusal(`scope path leaves the repository through a symlink: ${claim}`);
      }
      const relative = path.relative(root, real).split(path.sep).join('/');
      return path.posix.join(relative || '.', ...suffix);
    }
    if (current === '.') throw new Refusal(`scope path has no existing repository ancestor: ${claim}`);
    suffix.unshift(path.posix.basename(current));
    current = path.posix.dirname(current);
  }
}

export async function normalizeScope(repositoryRoot: string, claims: string[]): Promise<string[]> {
  const root = await fs.realpath(repositoryRoot).catch(() => null);
  const stat = root ? await fs.stat(root).catch(() => null) : null;
  if (!root || !stat?.isDirectory()) throw new Refusal(`unresolved repository root: ${repositoryRoot}`);
  if (!Array.isArray(claims)) throw new Refusal('write scope must be an array');
  const canonical = await Promise.all(claims.map((claim) => canonicalRepositoryClaim(root, claim)));
  return [...new Set(canonical)].sort();
}

function prefixContains(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

export function scopesOverlap(left: string[], right: string[]): boolean {
  return left.some((leftPath) => right.some((rightPath) =>
    prefixContains(leftPath, rightPath) || prefixContains(rightPath, leftPath)));
}

export function pathsWithinScope(paths: string[], scope: string[]): boolean {
  return paths.every((candidate) => scope.some((claimed) => prefixContains(claimed, candidate)));
}

type GitResult = { stdout: string; stderr: string };

function git(repository: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repository, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Refusal(`git_diff_scope adapter failed: ${String(stderr).trim() || error.message}`));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

type DiffChange = { status: string; paths: string[] };
type RepositoryKind = 'git' | 'jj';

async function repositoryKind(repository: string): Promise<RepositoryKind> {
  return await fs.stat(path.join(repository, '.jj')).catch(() => null) ? 'jj' : 'git';
}

function jj(repository: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile('jj', ['-R', repository, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Refusal(`git_diff_scope JJ adapter failed: ${String(stderr).trim() || error.message}`));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export async function repositoryIdentity(repository: string): Promise<string> {
  const root = await fs.realpath(repository);
  if (await repositoryKind(root) === 'jj') {
    const result = await jj(root, ['git', 'root']);
    return fs.realpath(result.stdout.trim());
  }
  try {
    const result = await git(root, ['rev-parse', '--git-common-dir']);
    return fs.realpath(path.resolve(root, result.stdout.trim()));
  } catch {
    return root;
  }
}

async function assertRepositoryRoot(repository: string): Promise<string> {
  const root = await fs.realpath(repository).catch(() => null);
  if (!root) throw new Refusal(`unresolved repository root: ${repository}`);
  if (await repositoryKind(root) === 'jj') {
    const result = await jj(root, ['root']);
    const reported = await fs.realpath(result.stdout.trim()).catch(() => null);
    if (!reported || reported !== root) throw new Refusal(`repository root does not match: ${repository}`);
    return root;
  }
  const result = await git(root, ['rev-parse', '--show-toplevel']);
  const reported = await fs.realpath(result.stdout.trim()).catch(() => null);
  if (!reported || reported !== root) throw new Refusal(`repository root does not match: ${repository}`);
  return root;
}

async function assertExactRevision(repository: string, revision: string): Promise<void> {
  if (!REVISION.test(revision)) throw new Refusal(`an exact 40-character revision is required: ${revision}`);
  const result = await repositoryKind(repository) === 'jj'
    ? await jj(repository, ['log', '-r', revision, '-T', 'commit_id', '--no-graph', '--limit', '1'])
    : await git(repository, ['rev-parse', '--verify', `${revision}^{commit}`]);
  if (result.stdout.trim().toLowerCase() !== revision.toLowerCase()) {
    throw new Refusal(`revision does not match the requested commit: ${revision}`);
  }
}

function parseNameStatus(output: string): DiffChange[] {
  if (!output) return [];
  const tokens = output.split('\0');
  if (tokens.pop() !== '') throw new Refusal('git_diff_scope returned malformed output');
  const changes: DiffChange[] = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!/^[ACDMRTUXB][0-9]{0,3}$/.test(status)) throw new Refusal('git_diff_scope returned malformed output');
    const pathCount = status[0] === 'R' || status[0] === 'C' ? 2 : 1;
    const paths = tokens.slice(index, index + pathCount);
    index += pathCount;
    if (paths.length !== pathCount || paths.some((claim) => !claim || claim.includes('\0'))) {
      throw new Refusal('git_diff_scope returned malformed output');
    }
    changes.push({ status, paths: paths.map(canonicalClaim) });
  }
  return changes;
}

function parseUntracked(output: string): DiffChange[] {
  if (!output) return [];
  const tokens = output.split('\0');
  if (tokens.pop() !== '') throw new Refusal('git_diff_scope returned malformed output');
  return tokens.map((claim) => ({ status: '?', paths: [canonicalClaim(claim)] }));
}

function parseGitPatch(output: string): DiffChange[] {
  const changes: DiffChange[] = [];
  let current: DiffChange | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (!match || match[1].startsWith('"') || match[2].startsWith('"')) {
        throw new Refusal('git_diff_scope returned malformed output');
      }
      current = { status: 'M', paths: [...new Set([match[1], match[2]])].map(canonicalClaim) };
      changes.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('new file mode')) current.status = 'A';
    if (line.startsWith('deleted file mode')) current.status = 'D';
    if (line.startsWith('rename from ') || line.startsWith('rename to ')) current.status = 'R';
    if (line.startsWith('copy from ') || line.startsWith('copy to ')) current.status = 'C';
  }
  return changes;
}

async function workspaceFiles(root: string, relative = ''): Promise<string[]> {
  const directory = path.join(root, relative);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === '.jj' || entry.name === '.git') continue;
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await workspaceFiles(root, child));
    else if (entry.isFile() || entry.isSymbolicLink()) files.push(child);
  }
  return files;
}

async function jjUntracked(repository: string, artifact: string): Promise<DiffChange[]> {
  const tracked = new Set((await jj(repository, ['file', 'list', '-r', artifact, '-T', 'path ++ "\\n"']))
    .stdout.split('\n').filter(Boolean).map(canonicalClaim));
  return (await workspaceFiles(repository)).filter((file) => !tracked.has(file))
    .map((file) => ({ status: '?', paths: [file] }));
}

export type RuntimeScopeEvidence = {
  files?: Record<string, string>;
  team_state_hash?: string;
  handoff_path?: string;
  handoff_digest?: string;
  launch_claim_path?: string;
  launch_claim_digest?: string;
  launch_claim_completed?: boolean;
  output_claim: string;
};

export type GitDiffScopeInput = {
  repository: string;
  base_revision: string;
  artifact_revision: string;
  write_scope: string[];
  runtime?: RuntimeScopeEvidence;
};

async function unchangedLaunchClaim(repository: string, runtime: RuntimeScopeEvidence): Promise<boolean> {
  const content = await fs.readFile(path.join(repository, runtime.launch_claim_path!), 'utf8').catch(() => null);
  if (content === null) return runtime.launch_claim_completed === true;
  return runtime.launch_claim_digest !== undefined && valueDigest(content) === runtime.launch_claim_digest;
}

async function unchangedRuntimeFile(repository: string, claim: string, runtime?: RuntimeScopeEvidence): Promise<boolean> {
  if (claim === '.hive/team.json' && runtime?.team_state_hash) {
    const content = await fs.readFile(path.join(repository, claim), 'utf8').catch(() => null);
    return content !== null && valueDigest(content) === runtime.team_state_hash;
  }
  if (claim === runtime?.launch_claim_path) return unchangedLaunchClaim(repository, runtime);
  const expected = runtime?.files?.[claim];
  if (!expected) return false;
  const content = await fs.readFile(path.join(repository, claim), 'utf8').catch(() => null);
  return content !== null && valueDigest(content) === expected;
}

function declaredHandoff(claim: string, scope: string[], runtime?: RuntimeScopeEvidence): boolean {
  return Boolean(runtime?.handoff_path && runtime.handoff_path === claim && runtime.output_claim
    && pathsWithinScope([claim], scope));
}

export async function gitDiffScope(input: GitDiffScopeInput) {
  const repository = await assertRepositoryRoot(input.repository);
  await assertExactRevision(repository, input.base_revision);
  await assertExactRevision(repository, input.artifact_revision);
  const scope = await normalizeScope(repository, input.write_scope);
  const kind = await repositoryKind(repository);
  let committed: GitResult;
  let working: GitResult;
  let untracked: GitResult;
  let ignored: GitResult;
  let changes: DiffChange[];
  if (kind === 'jj') {
    committed = await jj(repository, ['diff', '--from', input.base_revision, '--to', input.artifact_revision, '--git']);
    working = await jj(repository, ['diff', '--from', input.artifact_revision, '--git']);
    const extra = await jjUntracked(repository, input.artifact_revision);
    untracked = { stdout: '', stderr: '' };
    ignored = { stdout: '', stderr: '' };
    changes = [...parseGitPatch(committed.stdout), ...parseGitPatch(working.stdout), ...extra];
  } else {
    committed = await git(repository, [
      'diff', '--name-status', '-z', '--find-renames', input.base_revision, input.artifact_revision, '--',
    ]);
    working = await git(repository, ['diff', '--name-status', '-z', '--find-renames', input.artifact_revision, '--']);
    untracked = await git(repository, ['ls-files', '--others', '--exclude-standard', '-z', '--']);
    ignored = await git(repository, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--']);
    changes = [
      ...parseNameStatus(committed.stdout), ...parseNameStatus(working.stdout),
      ...parseUntracked(untracked.stdout), ...parseUntracked(ignored.stdout),
    ];
  }
  // The evaluator holds this lock while it reads the repository.
  changes = changes.flatMap((change) => {
    const paths = change.paths.filter((claim) => !claim.startsWith('.hive/team.json.lock/'));
    return paths.length ? [{ ...change, paths }] : [];
  });
  const rawPaths = [...new Set(changes.flatMap((change) => change.paths))];
  const paths = (await normalizeScope(repository, rawPaths)).sort();
  const outOfScope = new Set<string>();
  for (const claim of Object.keys(input.runtime?.files ?? {})) {
    if (claim.startsWith('.hive-hub/launches/') && !await unchangedRuntimeFile(repository, claim, input.runtime)) {
      outOfScope.add(claim);
    }
  }
  if (input.runtime?.launch_claim_path && !await unchangedLaunchClaim(repository, input.runtime)) {
    outOfScope.add(input.runtime.launch_claim_path);
  }
  for (const candidate of paths) {
    if (await unchangedRuntimeFile(repository, candidate, input.runtime)) continue;
    if (declaredHandoff(candidate, scope, input.runtime)) continue;
    if (protectedClaim(candidate) || !pathsWithinScope([candidate], scope)) outOfScope.add(candidate);
  }
  const passed = outOfScope.size === 0;
  return {
    predicate_id: 'git_diff_scope' as const,
    outcome: passed ? 'passed' as const : 'failed' as const,
    passed,
    base_revision: input.base_revision,
    artifact_revision: input.artifact_revision,
    changes,
    paths,
    out_of_scope: [...outOfScope],
    artifact_digest: valueDigest({ base: input.base_revision, artifact: input.artifact_revision, changes }),
    evidence_hash: valueDigest({
      committed: committed.stdout, working: working.stdout, untracked: untracked.stdout, ignored: ignored.stdout,
      runtime: input.runtime,
    }),
  };
}

export const git_diff_scope = gitDiffScope;
