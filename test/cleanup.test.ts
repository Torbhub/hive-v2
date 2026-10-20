import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// No real tmux server in these tests: pane liveness, identity, and kills are
// stubbed; git (run) stays real for the worktree cases.
process.env.HIVE_TMUX_SOCKET = `hive-test-${process.pid}`;

vi.mock('../src/tmux.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/tmux.js')>();
  return {
    ...orig,
    paneExists: vi.fn(async () => true),
    paneIs: vi.fn(async () => true),
    killWindow: vi.fn(async () => {}),
  };
});

import { cleanupProject } from '../src/cleanup.js';
import { hivePath, manifestAdd, readTeam, writeJson, hubPath } from '../src/state.js';
import { killWindow } from '../src/tmux.js';

beforeEach(() => {
  vi.clearAllMocks();
});

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'hive-clean-'));
  const home = path.join(root, 'proj');
  await fs.mkdir(home, { recursive: true });
  git(['init', '-q'], home);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], home);
  await writeJson(hubPath(root, 'projects.json'), {
    projects: [{ name: 'proj', home, repos: [{ folder: home }] }],
  });
  return { root, home };
}

describe('cleanupProject worktree records', () => {
  it('refuses to trash a directory outside the project home', async () => {
    const { root, home } = await setup();
    const outsider = path.join(root, 'not-hives');
    await fs.mkdir(outsider);
    await fs.writeFile(path.join(outsider, 'keep.txt'), 'precious');
    await manifestAdd(home, { kind: 'worktree', at: new Date().toISOString(), path: outsider });

    const actions = await cleanupProject(root, 'proj');
    expect(actions).toHaveLength(1);
    expect(actions[0].acted).toBe(false);
    expect(actions[0].action).toMatch(/left worktree/);
    expect(await fs.readFile(path.join(outsider, 'keep.txt'), 'utf8')).toBe('precious');
  });

  it('refuses a path inside the home that git does not list as a worktree', async () => {
    const { root, home } = await setup();
    const plain = path.join(home, 'just-a-dir');
    await fs.mkdir(plain);
    await manifestAdd(home, { kind: 'worktree', at: new Date().toISOString(), path: plain });

    const actions = await cleanupProject(root, 'proj');
    expect(actions[0].acted).toBe(false);
    expect(await fs.stat(plain)).toBeTruthy();
  });

  it('trashes a real registered worktree under the home', async () => {
    const { root, home } = await setup();
    const wt = path.join(home, 'wt-agent');
    git(['worktree', 'add', '-q', '-b', 'proj/agent', wt, 'HEAD'], home);
    await manifestAdd(home, { kind: 'worktree', at: new Date().toISOString(), path: wt, branch: 'proj/agent' });

    const actions = await cleanupProject(root, 'proj');
    expect(actions).toHaveLength(1);
    expect(actions[0].acted).toBe(true);
    expect(actions[0].action).toMatch(/trash worktree/);
    expect(await fs.stat(wt).catch(() => null)).toBeNull();
    const trashed = path.join(hivePath(home, 'trash'), new Date().toISOString().slice(0, 10), 'wt-agent');
    expect(await fs.stat(trashed)).toBeTruthy();
    expect((await fs.readFile(hivePath(home, 'manifest.jsonl'), 'utf8')).trim()).toBe('');
  });
});

describe('cleanupProject tmux records', () => {
  const tmuxRecord = {
    kind: 'tmux' as const, at: new Date().toISOString(), pane: '%1', window: 'proj:builder',
    pane_pid: 11, pane_started: 'a',
  };

  async function setupTmux() {
    const { root, home } = await setup();
    await manifestAdd(home, tmuxRecord);
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'builder', pane: '%1', pane_pid: 11, pane_started: 'a' }],
    });
    return { root, home };
  }

  it('stamps the team entry closed before killing the window', async () => {
    const { root, home } = await setupTmux();
    const actions = await cleanupProject(root, 'proj');
    expect(actions[0]).toMatchObject({ acted: true });
    expect(killWindow).toHaveBeenCalledWith('%1', { pid: 11, started: 'a' });
    const team = await readTeam(home);
    expect(team.agents[0].closed_at).toBeTruthy();
  });

  it('a dry run stamps nothing and kills nothing', async () => {
    const { root, home } = await setupTmux();
    const actions = await cleanupProject(root, 'proj', { dryRun: true });
    expect(actions[0].acted).toBe(false);
    expect(killWindow).not.toHaveBeenCalled();
    const team = await readTeam(home);
    expect(team.agents[0].closed_at).toBeUndefined();
  });
});
