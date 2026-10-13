import { promises as fs, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const DIALOG = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dialog-permission.txt'),
  'utf8',
);

vi.mock('../src/tmux.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/tmux.js')>();
  return {
    ...orig,
    paneExists: vi.fn(async () => true),
    capturePane: vi.fn(async () => DIALOG),
  };
});

import { hubAdd, hubInit, hubTask, readDialogFor, startProject } from '../src/hub.js';
import { writeJson, hivePath } from '../src/state.js';

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'hive-hub-'));
  const home = path.join(root, 'demo');
  await fs.mkdir(home, { recursive: true });
  await hubInit(root);
  await hubAdd(root, 'demo', home);
  return { root, home };
}

describe('hubTask', () => {
  it('allocates distinct ids under a concurrent storm', async () => {
    const { root } = await setup();
    const ids = await Promise.all([
      hubTask(root, 'demo', 'first'),
      hubTask(root, 'demo', 'second'),
      hubTask(root, 'demo', 'third'),
    ]);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^demo-\d+$/);
  });
});

describe('startProject task id', () => {
  it('rejects a traversal-shaped id before anything runs', async () => {
    const { root } = await setup();
    await expect(startProject(root, 'demo', '../../x')).rejects.toThrow(/task id/);
    await expect(startProject(root, 'demo', 'other-1')).rejects.toThrow(/task id/);
  });
  it('rejects a well-formed id with no task file', async () => {
    const { root } = await setup();
    await expect(startProject(root, 'demo', 'demo-99')).rejects.toThrow(/no task file/);
  });
});

describe('readDialogFor same-named agents', () => {
  async function setupTwins() {
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [
        { name: 'builder', pane: '%1', pane_pid: 11, pane_started: 'a', worktree: '/wt/a' },
        { name: 'builder', pane: '%2', pane_pid: 22, pane_started: 'b', worktree: '/wt/b' },
      ],
    });
    return root;
  }

  it('a bare name that matches two agents is an error, never a guess', async () => {
    const root = await setupTwins();
    await expect(readDialogFor(root, 'demo', 'builder')).rejects.toThrow(/say which/);
  });

  it('the @worktree form reads the matching pane', async () => {
    const root = await setupTwins();
    const d = await readDialogFor(root, 'demo', 'builder@/wt/b');
    expect(d).not.toBeNull();
    expect(d!.pane).toBe('%2');
    expect(d!.kind).toBe('numbered');
  });
});
