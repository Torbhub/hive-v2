import { promises as fs, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const IDLE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'idle-empty-prompt.txt'),
  'utf8',
);

vi.mock('../src/tmux.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/tmux.js')>();
  return {
    ...orig,
    run: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    newWindow: vi.fn(async () => '%9'),
    paneIdentity: vi.fn(async () => ({ pid: 4242, started: 'later' })),
    paneIs: vi.fn(async () => true),
    capturePane: vi.fn(async () => IDLE),
    sendLiteral: vi.fn(async () => {}),
    sendEnter: vi.fn(async () => {}),
    killWindow: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
  };
});

import { closeAgent, respawnAgent } from '../src/spawn.js';
import { hubAdd, hubInit } from '../src/hub.js';
import { hivePath, manifestRead, writeJson } from '../src/state.js';

async function setup(teamEntry: Record<string, unknown>) {
  const root = mkdtempSync(path.join(tmpdir(), 'hive-spawn-'));
  const home = path.join(root, 'demo');
  await fs.mkdir(home, { recursive: true });
  await hubInit(root);
  await hubAdd(root, 'demo', home);
  await writeJson(hivePath(home, 'team.json'), { agents: [teamEntry] });
  return { root, home };
}

describe('respawnAgent', () => {
  it('records the new window on the manifest with its identity', async () => {
    const { root, home } = await setup({
      name: 'builder', pane: '%1', pane_pid: 111, pane_started: 'earlier', worktree: '',
    });
    const pane = await respawnAgent(root, 'demo', 'builder');
    expect(pane).toBe('%9');
    const tmuxRecs = (await manifestRead(home)).filter((r) => r.kind === 'tmux');
    expect(tmuxRecs).toHaveLength(1);
    expect(tmuxRecs[0].pane).toBe('%9');
    expect(tmuxRecs[0].pane_pid).toBe(4242);
    expect(tmuxRecs[0].pane_started).toBe('later');
  }, 20_000);
});

describe('closeAgent', () => {
  it('refuses to kill a pane whose identity was never recorded', async () => {
    const { root } = await setup({ name: 'builder', pane: '%1' });
    await expect(closeAgent(root, 'demo', 'builder')).rejects.toThrow(/no recorded pane identity/);
  });
});
