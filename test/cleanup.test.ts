import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanupProject } from '../src/cleanup.js';
import { hivePath, manifestAdd, writeJson, hubPath } from '../src/state.js';

// No tmux records in these tests, but keep the socket pointed away from the
// user's server anyway.
process.env.HIVE_TMUX_SOCKET = `hive-test-${process.pid}`;

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
