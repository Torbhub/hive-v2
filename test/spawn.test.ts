import { existsSync, promises as fs, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const IDLE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'idle-empty-prompt.txt'),
  'utf8',
);
const TRUST_MENU = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dialog-trust-menu.txt'),
  'utf8',
);
const PERMISSION = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dialog-permission.txt'),
  'utf8',
);

// The trust menu with "Trust this folder" as the second option, cursor on the first.
const TRUST_MENU_2 = [
  'teamkimi run',
  ' ────────────────────────────',
  '  Trust this folder?',
  '  ↑↓ navigate · Enter select · Esc exit',
  '',
  '  /tmp',
  '',
  '  Project-level MCP servers are disabled until you explicitly choose Trust.',
  '',
  '   ❯ Ask again later',
  '     nothing is remembered',
  '',
  '     Trust this folder',
  '     Enable project MCP servers. Remembered for this folder.',
  ' ────────────────────────────',
  '',
].join('\n');

vi.mock('../src/tmux.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/tmux.js')>();
  return {
    ...orig,
    run: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    newWindow: vi.fn(async () => '%9'),
    paneIdentity: vi.fn(async () => ({ pid: 4242, started: 'later' })),
    paneIs: vi.fn(async () => true),
    capturePane: vi.fn(async () => IDLE),
    paneExists: vi.fn(async () => true),
    sendLiteral: vi.fn(async () => {}),
    sendEnter: vi.fn(async () => {}),
    sendArrow: vi.fn(async () => {}),
    killWindow: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
  };
});

import { closeAgent, effectiveOrchestratorMode, launchCommand, respawnAgent, spawnAgent, wakeAgent } from '../src/spawn.js';
import { hubAdd, hubInit, hubTask, setProjectApprovals, setProjectMode } from '../src/hub.js';
import { removeProject } from '../src/project.js';
import { appendTaskEvent, hivePath, manifestRead, readProjects, readTeam, writeJson, writeProjects } from '../src/state.js';
import { capturePane, killWindow, newWindow, paneIs, run, sendArrow, sendEnter } from '../src/tmux.js';

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

  it('places a default jj lane under .hive/lanes instead of the repo root', async () => {
    const { root, home } = await setup({ name: 'builder' });
    const wt = hivePath(home, 'lanes', 'builder2');
    await spawnAgent(root, 'demo', { agent: 'builder2' });
    const add = vi.mocked(run).mock.calls.find((c) => c[0] === 'jj' && c[2] === home && c[1].includes('add'));
    expect(add?.[1]).toEqual(['-R', home, 'workspace', 'add', wt, '-r', 'main@origin']);
    const recs = (await manifestRead(home)).filter((r) => r.kind === 'jj-workspace');
    expect(recs).toHaveLength(1);
    expect(recs[0].path).toBe(wt);
    expect((await readTeam(home)).agents.find((a) => a.name === 'builder2')?.worktree).toBe(wt);
  }, 20_000);

  it('places a default git lane under .hive/lanes instead of the repo root', async () => {
    const { root, home } = await setup({ name: 'builder' });
    const wt = hivePath(home, 'lanes', 'builder2');
    vi.mocked(run).mockImplementation(async (cmd) => cmd === 'jj'
      ? { code: 1, stdout: '', stderr: 'no jj here' }
      : { code: 0, stdout: '', stderr: '' });
    try {
      await spawnAgent(root, 'demo', { agent: 'builder2' });
    } finally {
      vi.mocked(run).mockImplementation(async () => ({ code: 0, stdout: '', stderr: '' }));
    }
    const add = vi.mocked(run).mock.calls.find((c) => c[0] === 'git' && c[2] === home && c[1][0] === 'worktree');
    expect(add?.[1]).toEqual(['worktree', 'add', '-q', '-b', 'demo/builder2', wt, 'HEAD']);
    expect((await readTeam(home)).agents.find((a) => a.name === 'builder2')?.worktree).toBe(wt);
  }, 20_000);

  it('launches a plain default lane when neither VCS probe finds a repo', async () => {
    const { root, home } = await setup({ name: 'builder' });
    const wt = hivePath(home, 'lanes', 'builder2');
    vi.mocked(run).mockImplementation(async (cmd) => cmd === 'jj' || cmd === 'git'
      ? { code: 1, stdout: '', stderr: 'no repository here' }
      : { code: 0, stdout: '', stderr: '' });
    try {
      await spawnAgent(root, 'demo', { agent: 'builder2' });
    } finally {
      vi.mocked(run).mockImplementation(async () => ({ code: 0, stdout: '', stderr: '' }));
    }
    expect((await fs.stat(wt)).isDirectory()).toBe(true);
    expect(vi.mocked(newWindow).mock.calls.at(-1)?.[1]).toBe(wt);
    expect((await readTeam(home)).agents.find((a) => a.name === 'builder2')?.worktree).toBe(wt);
    const recs = (await manifestRead(home)).filter((r) => r.kind === 'worktree' || r.kind === 'jj-workspace');
    expect(recs).toEqual([]);
  }, 20_000);

  it('preserves an absolute --worktree path', async () => {
    const { root, home } = await setup({ name: 'builder' });
    const wt = path.join(root, 'absolute-lane');
    await spawnAgent(root, 'demo', { agent: 'builder2', worktree: wt });
    const add = vi.mocked(run).mock.calls.find((c) => c[0] === 'jj' && c[2] === home && c[1].includes('add'));
    expect(add?.[1]).toEqual(['-R', home, 'workspace', 'add', wt, '-r', 'main@origin']);
    expect((await readTeam(home)).agents.find((a) => a.name === 'builder2')?.worktree).toBe(wt);
  }, 20_000);

  it('lanes into a jj workspace when jj root answers in the project home', async () => {
    const { root, home } = await setup({ name: 'builder' });
    await spawnAgent(root, 'demo', { agent: 'builder2', worktree: 'lane' });
    const add = vi.mocked(run).mock.calls.find((c) => c[0] === 'jj' && c[2] === home && c[1].includes('add'));
    expect(add?.[1]).toEqual(['-R', home, 'workspace', 'add', path.join(home, 'lane'), '-r', 'main@origin']);
    const recs = (await manifestRead(home)).filter((r) => r.kind === 'jj-workspace');
    expect(recs).toHaveLength(1);
    expect(recs[0].path).toBe(path.join(home, 'lane'));
    expect(recs[0].branch).toBeUndefined();
    expect(vi.mocked(run).mock.calls.some((c) => c[0] === 'git' && c[2] === home && c[1][0] === 'worktree')).toBe(false);
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
    const add = vi.mocked(run).mock.calls.find((c) => c[0] === 'git' && c[2] === home && c[1][0] === 'worktree');
    expect(add?.[1]).toEqual(['worktree', 'add', '-q', '-b', 'demo/builder2', path.join(home, 'lane'), 'HEAD']);
    const recs = (await manifestRead(home)).filter((r) => r.kind === 'worktree');
    expect(recs).toHaveLength(1);
    expect(recs[0].branch).toBe('demo/builder2');
  }, 20_000);

  it('creates missing parent dirs for a nested --worktree path', async () => {
    const { root, home } = await setup({ name: 'builder' });
    // jj workspace add fails when the target's parent does not exist.
    vi.mocked(run).mockImplementation(async (cmd, args) => {
      if (cmd === 'jj' && args[2] === 'workspace' && args[3] === 'add' && !existsSync(path.dirname(args[4]))) {
        return { code: 1, stdout: '', stderr: 'Cannot create workspace: No such file or directory (os error 2)' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    try {
      await spawnAgent(root, 'demo', { agent: 'builder2', worktree: 'lanes/chunk-1' });
    } finally {
      vi.mocked(run).mockImplementation(async () => ({ code: 0, stdout: '', stderr: '' }));
    }
    const add = vi.mocked(run).mock.calls.find((c) => c[0] === 'jj' && c[1][4] === path.join(home, 'lanes', 'chunk-1'));
    expect(add?.[1]).toEqual(['-R', home, 'workspace', 'add', path.join(home, 'lanes', 'chunk-1'), '-r', 'main@origin']);
    const recs = (await manifestRead(home)).filter((r) => r.kind === 'jj-workspace');
    expect(recs).toHaveLength(1);
    expect(recs[0].path).toBe(path.join(home, 'lanes', 'chunk-1'));
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
    const forget = vi.mocked(run).mock.calls.find((c) => c[0] === 'jj' && c[1][1] === home && c[1].includes('forget'));
    expect(forget?.[1]).toEqual(['-R', home, 'workspace', 'forget', 'lane']);
    expect(await fs.stat(wt).catch(() => null)).toBeNull();
    expect((await manifestRead(home)).filter((r) => r.kind === 'jj-workspace')).toHaveLength(0);
  }, 20_000);

  it('delete refuses an active worker launch claim', async () => {
    const { root, home } = await setup({ name: 'builder' });
    await writeJson(hivePath(home, 'team.json'), { agents: [] });
    let markWindow!: () => void;
    let releaseWindow!: () => void;
    const entered = new Promise<void>((resolve) => { markWindow = resolve; });
    const release = new Promise<void>((resolve) => { releaseWindow = resolve; });
    vi.mocked(newWindow).mockImplementationOnce(async () => {
      markWindow();
      await release;
      return '%9';
    });
    const spawning = spawnAgent(root, 'demo', { agent: 'builder2' });
    try {
      await entered;
      await expect(removeProject(root, 'demo')).rejects.toThrow(/launch is pending/);
      expect((await readProjects(root)).projects.map((p) => p.name)).toEqual(['demo']);
    } finally {
      releaseWindow();
      await spawning;
    }
  }, 20_000);

  it('does not register a worker after the project leaves the registry', async () => {
    const { root, home } = await setup({ name: 'builder' });
    await writeJson(hivePath(home, 'team.json'), { agents: [] });
    let markWindow!: () => void;
    let releaseWindow!: () => void;
    const entered = new Promise<void>((resolve) => { markWindow = resolve; });
    const release = new Promise<void>((resolve) => { releaseWindow = resolve; });
    vi.mocked(newWindow).mockImplementationOnce(async () => {
      markWindow();
      await release;
      return '%9';
    });
    const spawning = spawnAgent(root, 'demo', { agent: 'builder2' });
    try {
      await entered;
      await writeProjects(root, { projects: [] });
      releaseWindow();
      await expect(spawning).rejects.toThrow(/unknown project/);
      expect((await readTeam(home)).agents.some((a) => a.name === 'builder2')).toBe(false);
    } finally {
      releaseWindow();
      await spawning.catch(() => {});
    }
  }, 20_000);
});

describe('respawn racing a cascade kill', () => {
  it('a cascade mid-respawn stops the re-registering upsert and the fresh pane dies', async () => {
    const { root, home } = await setup({ name: 'builder', pane: '%1', pane_pid: 111, pane_started: 'earlier' });
    const before = vi.mocked(killWindow).mock.calls.length;
    // The cascade's drop lands while the respawn's new window comes up.
    vi.mocked(killWindow).mockImplementation(async (pane) => {
      if (pane === '%1') await writeJson(hivePath(home, 'team.json'), { agents: [] });
    });
    try {
      await expect(respawnAgent(root, 'demo', 'builder')).rejects.toThrow(/killed while its new pane came up/);
    } finally {
      vi.mocked(killWindow).mockImplementation(async () => {});
    }
    expect(vi.mocked(killWindow).mock.calls.slice(before).map((c) => c[0])).toEqual(['%1', '%9']);
    expect((await readTeam(home)).agents).toEqual([]);
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
      `HIVE_AGENT=builder HIVE_PROJECT=demo HIVE_HUB_ROOT='${root}' KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run -- --session session_b -m 'kimi-code/k3.1-pro'`,
    );
    const team = await readTeam(home);
    expect(team.agents[0]).toMatchObject({ pane: '%9', session_id: 'session_b', model: 'kimi-code/k3.1-pro' });
    expect(team.agents[0].closed_at).toBeUndefined();
  }, 20_000);

  it('shell-quotes a hub root containing spaces and a quote', async () => {
    const root = path.join(mkdtempSync(path.join(tmpdir(), 'hive-spawn-')), "root with ' quote");
    const home = path.join(root, 'demo');
    await fs.mkdir(home, { recursive: true });
    await hubInit(root);
    await hubAdd(root, 'demo', home);
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'builder', pane: '%1', pane_pid: 111, pane_started: 'earlier', session_id: 'session_b' }],
    });
    vi.mocked(paneIs).mockResolvedValueOnce(false);
    await wakeAgent(root, 'demo', 'builder');
    const cmd = vi.mocked(newWindow).mock.calls.at(-1)?.[2];
    expect(cmd).toContain(`HIVE_HUB_ROOT='${root.replaceAll("'", `'\\''`)}'`);
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
  it('builds the teamkimi run line per mode, resume included, K3.1 Pro by default', () => {
    expect(launchCommand(undefined, 'ask')).toBe("KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run -- -m 'kimi-code/k3.1-pro'");
    expect(launchCommand(undefined, 'yolo')).toBe("KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run -- -y -m 'kimi-code/k3.1-pro'");
    expect(launchCommand(undefined, 'auto')).toBe("KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run -- -y -m 'kimi-code/k3.1-pro'");
    expect(launchCommand(undefined, 'supervised-auto')).toBe("KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run -- --auto -m 'kimi-code/k3.1-pro'");
    expect(launchCommand('session_abc', 'ask')).toBe("KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run -- --session session_abc -m 'kimi-code/k3.1-pro'");
    expect(launchCommand('session_abc', 'yolo')).toBe("KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run -- --session session_abc -y -m 'kimi-code/k3.1-pro'");
    expect(launchCommand('session_abc', 'auto')).toBe("KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run -- --session session_abc -y -m 'kimi-code/k3.1-pro'");
  });

  it('a per-agent model overrides the default, combined with session and mode', () => {
    expect(launchCommand(undefined, 'ask', 'kimi-k2')).toBe("KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run -- -m 'kimi-k2'");
    expect(launchCommand('session_abc', 'yolo', 'kimi-code/k3')).toBe("KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run -- --session session_abc -y -m 'kimi-code/k3'");
    expect(launchCommand(undefined, 'ask', 'k3[1m]')).toBe("KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run -- -m 'k3[1m]'");
  });

  it('sets KIMI_CODE_SESSION_LOCK=0 so a wedged session never prompts for take-over', () => {
    expect(launchCommand(undefined, 'ask')).toContain('KIMI_CODE_SESSION_LOCK=0');
    expect(launchCommand('session_abc', 'yolo')).toContain('KIMI_CODE_SESSION_LOCK=0');
  });

  it('rejects a model alias outside the safe charset', () => {
    expect(() => launchCommand(undefined, 'ask', "k3'; rm -rf ~;'")).toThrow(/model alias/);
    expect(() => launchCommand(undefined, 'ask', 'k3 $(whoami)')).toThrow(/model alias/);
    expect(() => launchCommand(undefined, 'ask', '')).toThrow(/model alias/);
  });
});

describe('effectiveOrchestratorMode', () => {
  it('upgrades ask to supervised auto only when the watch answers dialogs', () => {
    expect(effectiveOrchestratorMode('ask', 'smart')).toBe('supervised-auto');
    expect(effectiveOrchestratorMode('ask', 'safe')).toBe('supervised-auto');
    expect(effectiveOrchestratorMode('ask', 'manual')).toBe('ask');
    expect(effectiveOrchestratorMode('ask', undefined)).toBe('ask');
    expect(effectiveOrchestratorMode('yolo', 'smart')).toBe('yolo');
    expect(effectiveOrchestratorMode('auto', 'manual')).toBe('auto');
  });
});

describe('orchestrator respawn mode', () => {
  it('keeps supervised --auto when mode is ask and approvals smart', async () => {
    const { root } = await setup({
      name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 111, pane_started: 'earlier',
    });
    await setProjectMode(root, 'demo', 'ask');
    await setProjectApprovals(root, 'demo', 'smart');
    await respawnAgent(root, 'demo', 'demo-orchestrator');
    expect(vi.mocked(newWindow).mock.calls.at(-1)?.[2]).toContain('--auto');
  }, 20_000);

  it('keeps ask when approvals is manual', async () => {
    const { root } = await setup({
      name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 111, pane_started: 'earlier',
    });
    await setProjectMode(root, 'demo', 'ask');
    await setProjectApprovals(root, 'demo', 'manual');
    await respawnAgent(root, 'demo', 'demo-orchestrator');
    expect(vi.mocked(newWindow).mock.calls.at(-1)?.[2]).toBe(`HIVE_AGENT=demo-orchestrator HIVE_PROJECT=demo HIVE_HUB_ROOT='${root}' KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run -- -m 'kimi-code/k3.1-pro'`);
  }, 20_000);

  it('leaves a yolo orchestrator on -y', async () => {
    const { root } = await setup({
      name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 111, pane_started: 'earlier',
    });
    await setProjectMode(root, 'demo', 'yolo');
    await setProjectApprovals(root, 'demo', 'smart');
    await respawnAgent(root, 'demo', 'demo-orchestrator');
    const cmd = vi.mocked(newWindow).mock.calls.at(-1)?.[2];
    expect(cmd).toContain('-y');
    expect(cmd).not.toContain('--auto');
  }, 20_000);

  it('never upgrades a plain agent under ask+smart', async () => {
    const { root } = await setup({ name: 'builder', pane: '%1', pane_pid: 111, pane_started: 'earlier' });
    await setProjectMode(root, 'demo', 'ask');
    await setProjectApprovals(root, 'demo', 'smart');
    await respawnAgent(root, 'demo', 'builder');
    expect(vi.mocked(newWindow).mock.calls.at(-1)?.[2]).toBe(`HIVE_AGENT=builder HIVE_PROJECT=demo HIVE_HUB_ROOT='${root}' KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run -- -m 'kimi-code/k3.1-pro'`);
  }, 20_000);

  it('relaunches a plain agent with -y in auto mode', async () => {
    const { root } = await setup({ name: 'builder', pane: '%1', pane_pid: 111, pane_started: 'earlier' });
    await setProjectMode(root, 'demo', 'auto');
    await respawnAgent(root, 'demo', 'builder');
    const cmd = vi.mocked(newWindow).mock.calls.at(-1)?.[2];
    expect(cmd).toContain('-y');
    expect(cmd).not.toContain('--auto');
  }, 20_000);
});

async function approvePlan(root: string, id: string): Promise<void> {
  await appendTaskEvent(root, {
    id, project: 'demo', event: 'plan', at: new Date().toISOString(), note: 'the plan',
    checkpoints: [{ id: 'c1', desc: 'the step', etaMin: 5 }],
  });
  await appendTaskEvent(root, {
    id, project: 'demo', event: 'answered', at: new Date().toISOString(), note: 'plan approved by owner',
  });
}

describe('spawn gate', () => {
  it('refuses a worker spawn on a task with no approved plan, before any side effect', async () => {
    const { root, home } = await setup({ name: 'builder' });
    const id = await hubTask(root, 'demo', 'do it');
    const windows = vi.mocked(newWindow).mock.calls.length;
    await expect(spawnAgent(root, 'demo', { agent: 'worker1', task: id })).rejects.toThrow(/no approved plan/);
    expect(vi.mocked(newWindow).mock.calls).toHaveLength(windows);
    expect((await readTeam(home)).agents.some((a) => a.name === 'worker1')).toBe(false);
  });

  it('lets a worker spawn once the owner approved the plan', async () => {
    const { root } = await setup({ name: 'builder' });
    const id = await hubTask(root, 'demo', 'do it');
    await approvePlan(root, id);
    const pane = await spawnAgent(root, 'demo', { agent: 'worker1', task: id });
    expect(pane).toBe('%9');
  }, 20_000);

  it('respawn and wake of a task worker obey the same gate', async () => {
    const { root } = await setup({
      name: 'builder', pane: '%1', pane_pid: 111, pane_started: 'earlier', session_id: 'session_b', task: 'demo-1',
    });
    await hubTask(root, 'demo', 'do it');
    const kills = vi.mocked(killWindow).mock.calls.length;
    await expect(respawnAgent(root, 'demo', 'builder')).rejects.toThrow(/no approved plan/);
    expect(vi.mocked(killWindow).mock.calls).toHaveLength(kills);
    await expect(wakeAgent(root, 'demo', 'builder')).rejects.toThrow(/no approved plan/);
  });
});

describe('spawn parent', () => {
  it('stamps opts.parent, else the pane env, else nothing', async () => {
    const { root, home } = await setup({ name: 'builder' });
    await spawnAgent(root, 'demo', { agent: 'w1', parent: 'demo-orchestrator' });
    vi.stubEnv('HIVE_AGENT', 'demo-orchestrator');
    try {
      await spawnAgent(root, 'demo', { agent: 'w2' });
    } finally {
      vi.unstubAllEnvs();
    }
    await spawnAgent(root, 'demo', { agent: 'w3' });
    const team = await readTeam(home);
    expect(team.agents.find((a) => a.name === 'w1')?.parent).toBe('demo-orchestrator');
    expect(team.agents.find((a) => a.name === 'w2')?.parent).toBe('demo-orchestrator');
    expect(team.agents.find((a) => a.name === 'w3')?.parent).toBeUndefined();
  }, 20_000);
});

describe('trust dialog at spawn', () => {
  it('answers the folder-trust menu once, then finishes the spawn', async () => {
    const { root } = await setup({ name: 'builder' });
    let calls = 0;
    vi.mocked(capturePane).mockImplementation(async () => (++calls <= 2 ? TRUST_MENU : IDLE));
    try {
      const pane = await spawnAgent(root, 'demo', { agent: 'builder2' });
      expect(pane).toBe('%9');
      expect(vi.mocked(sendArrow).mock.calls).toEqual([]);
      expect(vi.mocked(sendEnter).mock.calls.length).toBeGreaterThanOrEqual(1);
    } finally {
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('walks the menu when Trust is not under the cursor', async () => {
    const { root } = await setup({ name: 'builder' });
    let calls = 0;
    vi.mocked(capturePane).mockImplementation(async () => (++calls <= 2 ? TRUST_MENU_2 : IDLE));
    vi.mocked(sendArrow).mockClear();
    try {
      await spawnAgent(root, 'demo', { agent: 'builder2' });
      expect(vi.mocked(sendArrow).mock.calls).toEqual([['%9', 'Down']]);
    } finally {
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('any other dialog still throws', async () => {
    const { root } = await setup({ name: 'builder' });
    vi.mocked(capturePane).mockImplementation(async () => PERMISSION);
    try {
      await expect(spawnAgent(root, 'demo', { agent: 'builder2' })).rejects.toThrow(/answer it in the pane, then respawn/);
    } finally {
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);
});
