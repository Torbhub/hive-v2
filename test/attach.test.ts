import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('../src/tmux.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/tmux.js')>();
  return { ...orig, assertPane: vi.fn() };
});

import { spawn } from 'node:child_process';
import { attachProject } from '../src/attach.js';
import { hivePath, hubPath, writeJson } from '../src/state.js';
import { assertPane, tmuxSocket } from '../src/tmux.js';

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'hive-attach-'));
  const home = path.join(root, 'demo');
  return { root, home };
}

async function register(root: string, home: string, identity = true) {
  await writeJson(hubPath(root, 'projects.json'), {
    projects: [{ name: 'demo', home, repos: [{ folder: home }] }],
  });
  await writeJson(hivePath(home, 'team.json'), {
    agents: [{
      name: 'demo-orchestrator', orchestrator: true, pane: '%15',
      ...(identity ? { pane_pid: 123, pane_started: 'now' } : {}),
    }],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(assertPane).mockResolvedValue(undefined);
});

describe('attachProject', () => {
  it('revalidates and attaches to the exact recorded pane without printing its id', async () => {
    const { root, home } = setup();
    await register(root, home);
    const child = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(child as never);

    const pending = attachProject(root, 'demo');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    expect(assertPane).toHaveBeenCalledWith('%15', { pid: 123, started: 'now' });
    expect(spawn).toHaveBeenCalledWith('tmux', [
      '-L', tmuxSocket(), 'attach-session', '-t', 'hive',
      ';', 'select-window', '-t', '%15',
      ';', 'select-pane', '-t', '%15',
    ], { stdio: ['inherit', 'inherit', 'pipe'] });
    child.emit('close', 0, null);
    await expect(pending).resolves.toBeUndefined();
  });

  it('refuses a changed identity before starting tmux', async () => {
    const { root, home } = setup();
    await register(root, home);
    vi.mocked(assertPane).mockRejectedValue(new Error('pane identity changed'));

    await expect(attachProject(root, 'demo')).rejects.toThrow(/identity/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('refuses a missing recorded identity before starting tmux', async () => {
    const { root, home } = setup();
    await register(root, home, false);

    await expect(attachProject(root, 'demo')).rejects.toThrow(/identity/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('masks a pane id written by tmux after the identity check', async () => {
    const { root, home } = setup();
    await register(root, home);
    const child = new EventEmitter() as EventEmitter & { stderr: PassThrough };
    child.stderr = new PassThrough();
    vi.mocked(spawn).mockReturnValue(child as never);

    const pending = attachProject(root, 'demo');
    const rejection = expect(pending).rejects.toThrow("tmux attach exited with 1: can't find window: ?");
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    child.emit('exit', 1, null);
    child.stderr.write("can't find window: %15\n");
    child.emit('close', 1, null);
    await rejection;
    await expect(pending).rejects.not.toThrow('%15');
  });

  it('reports a failed tmux exit', async () => {
    const { root, home } = setup();
    await register(root, home);
    const child = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(child as never);

    const pending = attachProject(root, 'demo');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    child.emit('close', 1, null);
    await expect(pending).rejects.toThrow(/exit/);
  });
});
