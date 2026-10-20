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

import { closeAgent, launchCommand, respawnAgent, wakeAgent } from '../src/spawn.js';
import { hubAdd, hubInit } from '../src/hub.js';
import { hivePath, manifestRead, readTeam, writeJson } from '../src/state.js';
import { newWindow, paneIs, killWindow } from '../src/tmux.js';

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

  it('clears the close stamp when the kill fails', async () => {
    const { root, home } = await setup({ name: 'builder', pane: '%1', pane_pid: 111, pane_started: 'earlier' });
    vi.mocked(killWindow).mockRejectedValueOnce(new Error('tmux down'));
    await expect(respawnAgent(root, 'demo', 'builder')).rejects.toThrow('tmux down');
    const team = await readTeam(home);
    expect(team.agents[0].closed_at).toBeUndefined();
  });

  it('relaunches on the model recorded in team.json', async () => {
    const { root } = await setup({
      name: 'builder', pane: '%1', pane_pid: 111, pane_started: 'earlier', worktree: '', model: 'kimi-k2',
    });
    await respawnAgent(root, 'demo', 'builder');
    expect(vi.mocked(newWindow).mock.calls.at(-1)?.[2]).toContain("-m 'kimi-k2'");
  }, 20_000);
});

describe('closeAgent', () => {
  it('refuses to kill a pane whose identity was never recorded', async () => {
    const { root } = await setup({ name: 'builder', pane: '%1' });
    await expect(closeAgent(root, 'demo', 'builder')).rejects.toThrow(/no recorded pane identity/);
  });

  it('clears the close stamp when the kill fails', async () => {
    const { root, home } = await setup({ name: 'builder', pane: '%1', pane_pid: 111, pane_started: 'earlier' });
    vi.mocked(killWindow).mockRejectedValueOnce(new Error('tmux down'));
    await expect(closeAgent(root, 'demo', 'builder')).rejects.toThrow('tmux down');
    const team = await readTeam(home);
    expect(team.agents[0].closed_at).toBeUndefined();
  });
});

describe('wakeAgent', () => {
  it('resumes the recorded session in a new window', async () => {
    const { root, home } = await setup({
      name: 'builder', pane: '%1', pane_pid: 111, pane_started: 'earlier', session_id: 'session_b',
    });
    vi.mocked(paneIs).mockResolvedValueOnce(false);
    const pane = await wakeAgent(root, 'demo', 'builder');
    expect(pane).toBe('%9');
    expect(newWindow).toHaveBeenCalledWith(
      'demo:builder', home,
      'KIMI_CODE_NO_AUTO_UPDATE=1 exec teamkimi run -- --session session_b',
    );
    const team = await readTeam(home);
    expect(team.agents[0]).toMatchObject({ pane: '%9', session_id: 'session_b' });
    expect(team.agents[0].closed_at).toBeUndefined();
  }, 20_000);

  it('never wakes a pane that was closed on purpose', async () => {
    const { root } = await setup({
      name: 'builder', pane: '%1', pane_pid: 111, pane_started: 'earlier',
      session_id: 'session_b', closed_at: new Date().toISOString(),
    });
    await expect(wakeAgent(root, 'demo', 'builder')).rejects.toThrow(/closed on purpose/);
  });

  it('refuses an agent with no recorded session', async () => {
    const { root } = await setup({ name: 'builder', pane: '%1', pane_pid: 111, pane_started: 'earlier' });
    await expect(wakeAgent(root, 'demo', 'builder')).rejects.toThrow(/no recorded session/);
  });

  it('refuses an agent whose pane is still the recorded process', async () => {
    const { root } = await setup({
      name: 'builder', pane: '%1', pane_pid: 111, pane_started: 'earlier', session_id: 'session_b',
    });
    await expect(wakeAgent(root, 'demo', 'builder')).rejects.toThrow(/already running/);
  });
});

describe('launchCommand', () => {
  it('builds the teamkimi run line per mode, resume included', () => {
    expect(launchCommand(undefined, 'ask')).toBe('KIMI_CODE_NO_AUTO_UPDATE=1 exec teamkimi run');
    expect(launchCommand(undefined, 'yolo')).toBe('KIMI_CODE_NO_AUTO_UPDATE=1 exec teamkimi run -- -y');
    expect(launchCommand(undefined, 'auto')).toBe('KIMI_CODE_NO_AUTO_UPDATE=1 exec teamkimi run -- --auto');
    expect(launchCommand('session_abc', 'ask')).toBe('KIMI_CODE_NO_AUTO_UPDATE=1 exec teamkimi run -- --session session_abc');
    expect(launchCommand('session_abc', 'yolo')).toBe('KIMI_CODE_NO_AUTO_UPDATE=1 exec teamkimi run -- --session session_abc -y');
    expect(launchCommand('session_abc', 'auto')).toBe('KIMI_CODE_NO_AUTO_UPDATE=1 exec teamkimi run -- --session session_abc --auto');
  });

  it('adds -m for a per-agent model, combined with session and mode', () => {
    expect(launchCommand(undefined, 'ask', 'kimi-k2')).toBe("KIMI_CODE_NO_AUTO_UPDATE=1 exec teamkimi run -- -m 'kimi-k2'");
    expect(launchCommand('session_abc', 'yolo', 'kimi-code/k3')).toBe("KIMI_CODE_NO_AUTO_UPDATE=1 exec teamkimi run -- --session session_abc -y -m 'kimi-code/k3'");
    expect(launchCommand(undefined, 'ask', 'k3[1m]')).toBe("KIMI_CODE_NO_AUTO_UPDATE=1 exec teamkimi run -- -m 'k3[1m]'");
  });

  it('rejects a model alias outside the safe charset', () => {
    expect(() => launchCommand(undefined, 'ask', "k3'; rm -rf ~;'")).toThrow(/model alias/);
    expect(() => launchCommand(undefined, 'ask', 'k3 $(whoami)')).toThrow(/model alias/);
  });
});
