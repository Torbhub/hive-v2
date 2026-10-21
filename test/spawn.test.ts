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

import { closeAgent, launchCommand, respawnAgent, spawnAgent, wakeAgent } from '../src/spawn.js';
import { hubAdd, hubInit } from '../src/hub.js';
import { hivePath, manifestRead, readTeam, writeJson } from '../src/state.js';
import { killWindow, newWindow, paneIs, run } from '../src/tmux.js';

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

  it('rejects a bad recorded model before killing the live pane', async () => {
    const { root } = await setup({
      name: 'builder', pane: '%1', pane_pid: 111, pane_started: 'earlier', worktree: '', model: 'bad model',
    });
    const kills = vi.mocked(killWindow).mock.calls.length;
    await expect(respawnAgent(root, 'demo', 'builder')).rejects.toThrow(/model alias/);
    expect(vi.mocked(killWindow).mock.calls).toHaveLength(kills);
  }, 20_000);

  it('rejects an empty recorded model instead of dropping it', async () => {
    const { root } = await setup({
      name: 'builder', pane: '%1', pane_pid: 111, pane_started: 'earlier', worktree: '', model: '',
    });
    await expect(respawnAgent(root, 'demo', 'builder')).rejects.toThrow(/model alias/);
  }, 20_000);
});

describe('spawnAgent', () => {
  it('rejects a bad --model before any side effect', async () => {
    const { root } = await setup({ name: 'builder' });
    const runs = vi.mocked(run).mock.calls.length;
    await expect(spawnAgent(root, 'demo', { agent: 'builder2', model: 'bad model' })).rejects.toThrow(/model alias/);
    expect(vi.mocked(run).mock.calls).toHaveLength(runs);
  }, 20_000);

  it('lanes into a jj workspace when jj root answers in the project home', async () => {
    const { root, home } = await setup({ name: 'builder' });
    await spawnAgent(root, 'demo', { agent: 'builder2', worktree: 'lane' });
    const add = vi.mocked(run).mock.calls.find((c) => c[0] === 'jj' && c[1].includes('add'));
    expect(add?.[1]).toEqual(['-R', home, 'workspace', 'add', path.join(home, 'lane'), '-r', 'main@origin']);
    const recs = (await manifestRead(home)).filter((r) => r.kind === 'jj-workspace');
    expect(recs).toHaveLength(1);
    expect(recs[0].path).toBe(path.join(home, 'lane'));
    expect(recs[0].branch).toBeUndefined();
    expect(vi.mocked(run).mock.calls.some((c) => c[0] === 'git' && c[1][0] === 'worktree')).toBe(false);
  }, 20_000);

  it('falls back to a git worktree when the jj probe fails', async () => {
    const { root, home } = await setup({ name: 'builder' });
    vi.mocked(run).mockImplementation(async (cmd) => cmd === 'jj'
      ? { code: 1, stdout: '', stderr: 'no jj here' }
      : { code: 0, stdout: '', stderr: '' });
    try {
      await spawnAgent(root, 'demo', { agent: 'builder2', worktree: 'lane' });
    } finally {
      vi.mocked(run).mockImplementation(async () => ({ code: 0, stdout: '', stderr: '' }));
    }
    const add = vi.mocked(run).mock.calls.find((c) => c[0] === 'git' && c[1][0] === 'worktree');
    expect(add?.[1]).toEqual(['worktree', 'add', '-q', '-b', 'demo/builder2', path.join(home, 'lane'), 'HEAD']);
    const recs = (await manifestRead(home)).filter((r) => r.kind === 'worktree');
    expect(recs).toHaveLength(1);
    expect(recs[0].branch).toBe('demo/builder2');
  }, 20_000);

  it('forgets the jj workspace when the launch fails after it was made', async () => {
    const { root, home } = await setup({ name: 'builder' });
    vi.mocked(newWindow).mockRejectedValueOnce(new Error('tmux down'));
    await expect(spawnAgent(root, 'demo', { agent: 'builder2', worktree: 'lane' })).rejects.toThrow('tmux down');
    const forget = vi.mocked(run).mock.calls.find((c) => c[0] === 'jj' && c[1].includes('forget'));
    expect(forget?.[1]).toEqual(['-R', home, 'workspace', 'forget', 'lane']);
    expect(await fs.stat(path.join(home, 'lane')).catch(() => null)).toBeNull();
  }, 20_000);

  it('rolls back a workspace that jj registered despite a failed add', async () => {
    const { root, home } = await setup({ name: 'builder' });
    const wt = path.join(home, 'lane');
    vi.mocked(run).mockImplementation(async (cmd, args) => {
      if (cmd === 'jj' && args[2] === 'workspace' && args[3] === 'add') {
        await fs.mkdir(args[4], { recursive: true });
        return { code: 1, stdout: '', stderr: 'add blew up' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    try {
      await expect(spawnAgent(root, 'demo', { agent: 'builder2', worktree: 'lane' })).rejects.toThrow(/jj workspace add failed/);
    } finally {
      vi.mocked(run).mockImplementation(async () => ({ code: 0, stdout: '', stderr: '' }));
    }
    const forget = vi.mocked(run).mock.calls.find((c) => c[0] === 'jj' && c[1].includes('forget'));
    expect(forget?.[1]).toEqual(['-R', home, 'workspace', 'forget', 'lane']);
    expect(await fs.stat(wt).catch(() => null)).toBeNull();
    expect((await manifestRead(home)).filter((r) => r.kind === 'jj-workspace')).toHaveLength(0);
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
    expect(() => launchCommand(undefined, 'ask', '')).toThrow(/model alias/);
  });
});
