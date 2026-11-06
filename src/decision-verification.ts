import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { containsInternalContent } from './decisions.js';
import type { DecisionAction, DecisionFacts } from './decisions.js';
import { readProjects, readTeam } from './state.js';
import { run } from './tmux.js';

const VERIFY_TTL_MS = 15 * 60_000;
const REPO_ACTIONS = new Set<DecisionAction>(['push', 'pr', 'merge', 'deploy']);

function safeBranch(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) || value.includes('..') || value.includes('//') || value.includes('@{')) {
    throw new Error('a safe Git branch is required');
  }
  return value;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await run('git', args, cwd, undefined, 10_000);
  if (result.code !== 0) throw new Error(`Git verification failed: ${args[0]}`);
  return result.stdout.trim();
}

async function optionalGit(cwd: string, args: string[]): Promise<string | null> {
  const result = await run('git', args, cwd, undefined, 10_000);
  return result.code === 0 ? result.stdout.trim() : null;
}

export function repositoryName(remote: string): string {
  const normalized = remote.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '');
  if (containsInternalContent(normalized)) throw new Error('unsafe repository name');
  return normalized
    .replace(/\/\/[^/@\s]+@/, '//')
    .replace(/^[^/@\s]+@/, '')
    .replace(/\.git$/, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 240);
}

async function singlePushUrl(cwd: string): Promise<string> {
  const urls = (await git(cwd, ['remote', 'get-url', '--push', '--all', 'origin'])).split('\n').filter(Boolean);
  if (urls.length !== 1) throw new Error('exactly one push URL is required');
  return urls[0];
}

export function repositoryFingerprint(remote: string): string {
  return createHash('sha256').update(remote).digest('hex');
}

function safeDiffText(value: string, max: number): string {
  const normalized = value.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '');
  if (containsInternalContent(normalized)) throw new Error('unsafe repository text');
  const clean = normalized.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (containsInternalContent(clean)) throw new Error('unsafe repository text');
  return clean.slice(0, max);
}

async function worktree(root: string, project: string, agent: string): Promise<string> {
  const registered = (await readProjects(root)).projects.find((entry) => entry.name === project);
  if (!registered) throw new Error('unknown project');
  const team = await readTeam(registered.home);
  const entry = team.agents.find((candidate) => candidate.name === agent);
  if (!entry && agent !== `${project}-orchestrator`) throw new Error('unknown agent worktree');
  return fs.realpath(entry?.worktree || registered.home);
}

export async function verifyExecutionRepository(
  root: string,
  meta: { project: string; agent: string },
  cwd: string,
): Promise<string> {
  const [expected, actual] = await Promise.all([worktree(root, meta.project, meta.agent), fs.realpath(cwd)]);
  if (expected !== actual) throw new Error('execution worktree does not match the approved project');
  return singlePushUrl(actual);
}

async function verifiedBranch(home: string, requested: string | undefined, head: string): Promise<string> {
  const current = (await git(home, ['branch', '--show-current'])) || null;
  if (current) {
    if (requested && requested !== current) throw new Error('requested branch does not match the worktree');
    return safeBranch(current);
  }
  if (!requested) throw new Error('a branch is required for a detached worktree');
  const branch = safeBranch(requested);
  const tip = await git(home, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${branch}^{commit}`]);
  if (tip !== head) throw new Error('requested branch does not point at HEAD');
  return branch;
}

async function baseRef(home: string, destination: string, action: DecisionAction): Promise<string> {
  const destinationBranch = destination.slice('origin/'.length);
  if (action !== 'push') {
    if (await optionalGit(home, ['rev-parse', '--verify', '--end-of-options', `refs/remotes/origin/${destinationBranch}^{commit}`])) {
      return `origin/${destinationBranch}`;
    }
    if (await optionalGit(home, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${destinationBranch}^{commit}`])) {
      return destinationBranch;
    }
  }
  if (await optionalGit(home, ['rev-parse', '--verify', '--end-of-options', 'refs/remotes/origin/main^{commit}'])) return 'origin/main';
  if (await optionalGit(home, ['rev-parse', '--verify', '--end-of-options', 'refs/heads/main^{commit}'])) return 'main';
  throw new Error('no verified diff base');
}

export async function verifyDecisionFacts(
  root: string,
  meta: { project: string; agent: string },
  requested: DecisionFacts & { action: DecisionAction },
  now = Date.now(),
): Promise<DecisionFacts> {
  const verifiedAt = new Date(now).toISOString();
  const validUntil = new Date(now + VERIFY_TTL_MS).toISOString();
  const base: DecisionFacts = {
    action: requested.action,
    reason: requested.reason,
    scope: requested.scope,
    budget: requested.budget,
    destination: requested.destination,
    verifiedAt,
    validUntil,
  };
  if (!REPO_ACTIONS.has(requested.action)) return base;
  const home = await worktree(root, meta.project, meta.agent);
  const head = await git(home, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}']);
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error('a canonical 40-character commit is required');
  if (requested.commit !== undefined) {
    if (!/^[0-9a-f]{40}$/i.test(requested.commit) || requested.commit.toLowerCase() !== head) {
      throw new Error('requested commit does not match canonical HEAD');
    }
  }
  const branch = await verifiedBranch(home, requested.branch, head);
  const destination = requested.action === 'push' ? `origin/${branch}` : requested.destination || 'origin/main';
  if (!destination.startsWith('origin/')) throw new Error('destination must be an origin branch');
  safeBranch(destination.slice('origin/'.length));
  const remote = await singlePushUrl(home);
  const baseBranch = await baseRef(home, destination, requested.action);
  const [diffSummary, names] = await Promise.all([
    git(home, ['diff', '--stat', '--no-renames', '--no-color', `${baseBranch}...${head}`]),
    git(home, ['diff', '--name-only', '--no-renames', `${baseBranch}...${head}`]),
  ]);
  return {
    ...base,
    repository: repositoryName(remote),
    repositoryFingerprint: repositoryFingerprint(remote),
    branch,
    commit: head,
    destination,
    diffSummary: safeDiffText(diffSummary || 'No changed files', 2000),
    files: names.split('\n').filter(Boolean).slice(0, 20).map((file) => safeDiffText(file, 200)),
  };
}

export function decisionFingerprint(facts: DecisionFacts): string {
  const stable = { ...facts } as Record<string, unknown>;
  delete stable.verifiedAt;
  delete stable.validUntil;
  const canonical = Object.fromEntries(Object.keys(stable).sort().map((key) => [key, stable[key]]));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
