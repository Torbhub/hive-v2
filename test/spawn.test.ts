import { existsSync, promises as fs, mkdtempSync, readFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  const homedir = vi.fn(() => '/tmp/hive-spawn-test-empty-home');
  return { ...orig, default: { ...orig.default, homedir }, homedir };
});

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
    sendEscape: vi.fn(async () => {}),
    killWindow: vi.fn(async () => {}),
    sleep: vi.fn((ms: number) => vi.advanceTimersByTimeAsync(ms)),
  };
});

vi.mock('../src/admission.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/admission.js')>();
  return { ...orig, completeTmuxLaunch: vi.fn(orig.completeTmuxLaunch) };
});

vi.mock('../src/state.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/state.js')>();
  return { ...orig, compareAndSwapTeamEntry: vi.fn(orig.compareAndSwapTeamEntry) };
});

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

import { closeAgent, effectiveOrchestratorMode, findLatestSession, launchCommand, respawnAgent, spawnAgent, waitIdle, wakeAgent } from '../src/spawn.js';
import { answerDialog, hubAdd, hubInit, hubResolve, hubTask, readDialogFor, redactDialog, setProjectApprovals, setProjectMode, startProject } from '../src/hub.js';
import { removeProject } from '../src/project.js';
import { killAgent } from '../src/kill.js';
import { completeTmuxLaunch } from '../src/admission.js';
import { appendTaskEvent, compareAndSwapTeamEntry, hivePath, manifestRead, readDecisions, readProjects, readTeam, valueDigest, writeJson, writeProjects } from '../src/state.js';
import { capturePane, killWindow, newWindow, paneIdentity, paneIs, run, sendArrow, sendEnter, sendEscape, sendLiteral, sleep } from '../src/tmux.js';
import { watchCycle } from '../src/watch.js';
import { approveContract, taskContract } from './task-contract.js';

function spawn(root: string, opts: Parameters<typeof spawnAgent>[2]): Promise<string> {
  return spawnAgent(root, 'demo', {
    assignment: 'Complete the bounded test assignment in the requested files.',
    deliverable: 'Return the named artifact and its verification evidence to the orchestrator.',
    ...opts,
  });
}

async function setup(teamEntry: Record<string, unknown>) {
  const root = mkdtempSync(path.join(tmpdir(), 'hive-spawn-'));
  const home = path.join(root, 'demo');
  await fs.mkdir(home, { recursive: true });
  await hubInit(root);
  await hubAdd(root, 'demo', home);
  const entry = { ...teamEntry };
  if (!entry.orchestrator) {
    entry.handoff = entry.handoff === true || entry.handoff === undefined
      ? hivePath(home, 'handoffs', `${String(entry.name)}.md`)
      : entry.handoff;
    await fs.mkdir(path.dirname(String(entry.handoff)), { recursive: true });
    await fs.writeFile(String(entry.handoff), '# worker handoff\n\n## START HERE\n### Assignment\nComplete the bounded test assignment in the requested files.\n\n### Deliverable\nReturn the named artifact and verification evidence to the orchestrator.\n');
  }
  await writeJson(hivePath(home, 'team.json'), { agents: [entry] });
  return { root, home };
}

describe('findLatestSession', () => {
  it('uses an isolated session home', async () => {
    const defaultHome = os.homedir();
    const testHome = mkdtempSync(path.join(tmpdir(), 'hive-spawn-test-home-'));
    vi.mocked(os.homedir).mockReturnValue(testHome);
    try {
      const dir = path.join(testHome, '.kimi-code', 'sessions', 'wd_controlled', 'session_controlled');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ cwd: '/controlled-worktree', updatedAt: 1 }));
      expect(await findLatestSession('/controlled-worktree')).toBe('session_controlled');
    } finally {
      vi.mocked(os.homedir).mockReturnValue(defaultHome);
    }
  });
});

describe('waitIdle', () => {
  it('yields to the event loop while waiting for a still pane', async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 1);
    try {
      await waitIdle('%1', { stillMs: 50 });
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
  });
});

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
  it('types the absolute hub decisions path into the worker pickup', async () => {
    const { root } = await setup({ name: 'builder' });
    await spawn(root, { agent: 'builder2' });
    const typed = vi.mocked(sendLiteral).mock.calls.at(-1)?.[1];
    expect(typed).toContain(`Decisions so far: read ${path.join(root, '.hive-hub', 'decisions.jsonl')} — they are permanent.`);
    expect(typed).not.toContain('read .hive-hub/decisions.jsonl');
  }, 20_000);

  it('rejects a bad --model before any side effect', async () => {
    const { root } = await setup({ name: 'builder' });
    const runs = vi.mocked(run).mock.calls.length;
    await expect(spawn(root, { agent: 'builder2', model: 'bad model' })).rejects.toThrow(/model alias/);
    expect(vi.mocked(run).mock.calls).toHaveLength(runs);
  }, 20_000);

  it('places a default jj lane under .hive/lanes instead of the repo root', async () => {
    const { root, home } = await setup({ name: 'builder' });
    const wt = hivePath(home, 'lanes', 'builder2');
    await spawn(root, { agent: 'builder2' });
    const add = vi.mocked(run).mock.calls.find((c) => c[0] === 'jj' && c[2] === home && c[1].includes('add'));
    expect(add?.[1]).toEqual(['-R', home, 'workspace', 'add', wt, '-r', 'main@origin']);
    const recs = (await manifestRead(home)).filter((r) => r.kind === 'jj-workspace');
    expect(recs).toHaveLength(1);
    expect(recs[0].path).toBe(wt);
    expect((await readTeam(home)).agents.find((a) => a.name === 'builder2')?.worktree).toBe(wt);
  }, 20_000);

  it('launches and warns when jj lane hook installation fails', async () => {
    const { root, home } = await setup({ name: 'builder' });
    const wt = path.join(home, 'lane');
    await fs.mkdir(path.join(wt, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(wt, 'scripts', 'install-git-hooks.sh'), '#!/bin/sh\n');
    vi.mocked(run).mockImplementation(async (cmd) => cmd === 'bash'
      ? { code: 1, stdout: '', stderr: 'fatal: not a git repository' }
      : { code: 0, stdout: '', stderr: '' });
    try {
      await expect(spawn(root, { agent: 'builder2', worktree: 'lane' })).resolves.toBe('%9');
    } finally {
      vi.mocked(run).mockImplementation(async () => ({ code: 0, stdout: '', stderr: '' }));
    }
    expect(vi.mocked(newWindow).mock.calls.at(-1)?.[1]).toBe(wt);
    expect((await readTeam(home)).agents.some((a) => a.name === 'builder2' && a.pane === '%9')).toBe(true);
    expect((await readDecisions(root))[0]).toMatchObject({
      project: 'demo', by: 'orchestrator',
      summary: 'WARNING: worker builder2 started without push hooks; repair push hooks before pushing',
    });
    expect(vi.mocked(run).mock.calls.some((c) => c[0] === 'jj' && c[1].includes('forget'))).toBe(false);
    expect(await fs.stat(wt)).toBeTruthy();
  }, 20_000);

  it('keeps the launched worker and jj lane when the hook warning cannot be logged', async () => {
    const { root, home } = await setup({ name: 'builder' });
    const wt = path.join(home, 'lane');
    await fs.mkdir(path.join(wt, 'scripts'), { recursive: true });
    await fs.writeFile(path.join(wt, 'scripts', 'install-git-hooks.sh'), '#!/bin/sh\n');
    await fs.mkdir(path.join(root, '.hive-hub', 'decisions.jsonl'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(run).mockImplementation(async (cmd) => cmd === 'bash'
      ? { code: 1, stdout: '', stderr: 'fatal: not a git repository' }
      : { code: 0, stdout: '', stderr: '' });
    try {
      await expect(spawn(root, { agent: 'builder2', worktree: 'lane' })).resolves.toBe('%9');
      expect(error).toHaveBeenCalledWith(expect.stringContaining('hive: the decision was not logged:'));
    } finally {
      vi.mocked(run).mockImplementation(async () => ({ code: 0, stdout: '', stderr: '' }));
      error.mockRestore();
    }
    expect((await readTeam(home)).agents.some((a) => a.name === 'builder2' && a.pane === '%9')).toBe(true);
    expect((await manifestRead(home)).some((r) => r.kind === 'jj-workspace' && r.path === wt)).toBe(true);
    expect(await fs.stat(wt)).toBeTruthy();
    expect(vi.mocked(run).mock.calls.some((c) => c[0] === 'jj' && c[1].includes('forget'))).toBe(false);
  }, 20_000);

  it('places a default git lane under .hive/lanes instead of the repo root', async () => {
    const { root, home } = await setup({ name: 'builder' });
    const wt = hivePath(home, 'lanes', 'builder2');
    vi.mocked(run).mockImplementation(async (cmd) => cmd === 'jj'
      ? { code: 1, stdout: '', stderr: 'no jj here' }
      : { code: 0, stdout: '', stderr: '' });
    try {
      await spawn(root, { agent: 'builder2' });
    } finally {
      vi.mocked(run).mockImplementation(async () => ({ code: 0, stdout: '', stderr: '' }));
    }
    const add = vi.mocked(run).mock.calls.find((c) => c[0] === 'git' && c[2] === home && c[1][0] === 'worktree');
    expect(add?.[1]).toEqual(['worktree', 'add', '-q', '-b', 'demo/builder2', wt, 'HEAD']);
    expect((await readTeam(home)).agents.find((a) => a.name === 'builder2')?.worktree).toBe(wt);
  }, 20_000);

  it('creates an orphan worktree when a git repository has no commits', async () => {
    const { root, home } = await setup({ name: 'builder' });
    const wt = hivePath(home, 'lanes', 'builder2');
    vi.mocked(run).mockImplementation(async (cmd, args) => {
      if (cmd === 'jj') return { code: 1, stdout: '', stderr: 'no jj here' };
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--verify') {
        return { code: 1, stdout: '', stderr: 'unknown revision' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    try {
      await spawn(root, { agent: 'builder2' });
    } finally {
      vi.mocked(run).mockImplementation(async () => ({ code: 0, stdout: '', stderr: '' }));
    }
    const add = vi.mocked(run).mock.calls.find((c) => c[0] === 'git' && c[2] === home && c[1][0] === 'worktree');
    expect(add?.[1]).toEqual(['worktree', 'add', '-q', '--orphan', '-b', 'demo/builder2', wt]);
    expect((await readTeam(home)).agents.find((a) => a.name === 'builder2')?.worktree).toBe(wt);
  }, 20_000);

  it('refuses a fatal HEAD lookup instead of treating it as an empty repository', async () => {
    const { root, home } = await setup({ name: 'builder' });
    vi.mocked(run).mockImplementation(async (cmd, args) => {
      if (cmd === 'jj') return { code: 1, stdout: '', stderr: 'no jj here' };
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--verify') {
        return { code: 128, stdout: '', stderr: 'corrupt metadata' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    try {
      await expect(spawn(root, { agent: 'builder2' })).rejects.toThrow('HEAD lookup failed: corrupt metadata');
    } finally {
      vi.mocked(run).mockImplementation(async () => ({ code: 0, stdout: '', stderr: '' }));
    }
    expect(vi.mocked(run).mock.calls.some((c) => c[0] === 'git' && c[2] === home && c[1][0] === 'worktree')).toBe(false);
  }, 20_000);

  it('launches a plain default lane when neither VCS probe finds a repo', async () => {
    const { root, home } = await setup({ name: 'builder' });
    const wt = hivePath(home, 'lanes', 'builder2');
    vi.mocked(run).mockImplementation(async (cmd) => cmd === 'jj' || cmd === 'git'
      ? { code: 1, stdout: '', stderr: 'no repository here' }
      : { code: 0, stdout: '', stderr: '' });
    try {
      await spawn(root, { agent: 'builder2' });
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
    await spawn(root, { agent: 'builder2', worktree: wt });
    const add = vi.mocked(run).mock.calls.find((c) => c[0] === 'jj' && c[2] === home && c[1].includes('add'));
    expect(add?.[1]).toEqual(['-R', home, 'workspace', 'add', wt, '-r', 'main@origin']);
    expect((await readTeam(home)).agents.find((a) => a.name === 'builder2')?.worktree).toBe(wt);
  }, 20_000);

  it('lanes into a jj workspace when jj root answers in the project home', async () => {
    const { root, home } = await setup({ name: 'builder' });
    await spawn(root, { agent: 'builder2', worktree: 'lane' });
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
      await spawn(root, { agent: 'builder2', worktree: 'lane' });
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
      await spawn(root, { agent: 'builder2', worktree: 'lanes/chunk-1' });
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
    await expect(spawn(root, { agent: 'builder2', worktree: 'lane' })).rejects.toThrow('tmux down');
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
      await expect(spawn(root, { agent: 'builder2', worktree: 'lane' })).rejects.toThrow(/jj workspace add failed/);
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
    const spawning = spawn(root, { agent: 'builder2' });
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
    const spawning = spawn(root, { agent: 'builder2' });
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
    const handoff = hivePath(home, 'handoffs', 'builder.md');
    await fs.mkdir(path.dirname(handoff), { recursive: true });
    await fs.writeFile(handoff, '# worker handoff\n\n## START HERE\n### Assignment\nComplete the bounded test assignment in the requested files.\n\n### Deliverable\nReturn the named artifact and verification evidence to the orchestrator.\n');
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'builder', pane: '%1', pane_pid: 111, pane_started: 'earlier', session_id: 'session_b', handoff }],
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

describe('worker contract edge cases', () => {
  const contract = {
    assignment: 'Audit\nand keep the second line intact.',
    deliverable: 'Write\nand include verification evidence.',
  };

  it('round-trips multiline contracts through respawn', async () => {
    const { root } = await setup({ name: 'builder' });
    await spawn(root, { agent: 'builder2', ...contract });
    await expect(respawnAgent(root, 'demo', 'builder2')).resolves.toBe('%9');
  }, 20_000);

  it('repairs the recorded path without erasing progress or memory', async () => {
    const { root, home } = await setup({
      name: 'builder', pane: '%1', pane_pid: 111, pane_started: 'earlier', session_id: 'session_b', worktree: '',
    });
    const handoff = path.join(root, 'custom-handoff.md');
    await fs.writeFile(handoff, '# builder\n\n## START HERE\nWait for a message.\n\nProgress: keep this note.\n\n## Memory\n\n- keep this lesson\n');
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'builder', pane: '%1', pane_pid: 111, pane_started: 'earlier', session_id: 'session_b', worktree: '', handoff }],
    });
    await respawnAgent(root, 'demo', 'builder', contract);
    const text = await fs.readFile(handoff, 'utf8');
    expect(text).toContain('Progress: keep this note.');
    expect(text).toContain('## Memory\n\n- keep this lesson');
    expect(text).toContain(contract.assignment);
    const team = await readTeam(home);
    team.agents[0].session_id = 'session_b';
    await writeJson(hivePath(home, 'team.json'), team);
    vi.mocked(paneIs).mockResolvedValueOnce(false);
    await expect(wakeAgent(root, 'demo', 'builder')).resolves.toBe('%9');
    expect(vi.mocked(sendLiteral).mock.calls.at(-1)?.[1]).toContain(handoff);
  }, 20_000);

  it('does not rewrite the handoff when preflight rejects respawn', async () => {
    const { root, home } = await setup({
      name: 'builder', pane: '%1', pane_pid: 111, pane_started: 'earlier', handoff: true,
    });
    const file = hivePath(home, 'handoffs', 'builder.md');
    const original = '# builder\n\n## START HERE\nWait for a message.\n\n## Memory\n\n- keep this\n';
    await fs.writeFile(file, original);
    vi.mocked(run).mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'proxy down' });
    await expect(respawnAgent(root, 'demo', 'builder', contract)).rejects.toThrow(/proxy is down/);
    expect(await fs.readFile(file, 'utf8')).toBe(original);
  });

  it('refuses a handoff symlink instead of overwriting its target', async () => {
    const { root, home } = await setup({ name: 'builder' });
    const worktree = path.join(home, 'lane');
    const file = hivePath(worktree, 'handoffs', 'builder2.md');
    const outside = path.join(root, 'outside.md');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(outside, 'do not overwrite\n');
    await fs.symlink(outside, file);
    await expect(spawn(root, { agent: 'builder2', worktree: 'lane', ...contract })).rejects.toThrow(/symlink|follow/);
    expect(await fs.readFile(outside, 'utf8')).toBe('do not overwrite\n');
  });

  it('rejects headings inside contract values before launch', async () => {
    const { root } = await setup({ name: 'builder' });
    await expect(spawn(root, {
      agent: 'builder2',
      assignment: 'Do this\n\n### Notes\nContinue with the bounded implementation',
      deliverable: 'Return the cited artifact and verification evidence.',
    })).rejects.toThrow(/heading/);
  });

  it('refuses parent-directory symlinks before creating any agent files', async () => {
    const { root, home } = await setup({ name: 'builder' });
    const worktree = path.join(home, 'lane');
    const outside = path.join(root, 'outside');
    await fs.mkdir(worktree, { recursive: true });
    await fs.mkdir(outside);
    await fs.symlink(outside, hivePath(worktree));
    await expect(spawn(root, { agent: 'builder2', worktree: 'lane', ...contract })).rejects.toThrow(/symlink|follow/);
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('leaves ambiguous legacy progress untouched instead of replacing it', async () => {
    const { root, home } = await setup({
      name: 'builder', pane: '%1', pane_pid: 111, pane_started: 'earlier', handoff: true,
    });
    const file = hivePath(home, 'handoffs', 'builder.md');
    const original = '# builder\n\n## START HERE\n### Assignment\nOld assignment text.\n\n### Deliverable\nOld deliverable text.\n\nProgress: keep this note.\n';
    await fs.writeFile(file, original);
    await expect(respawnAgent(root, 'demo', 'builder', contract)).rejects.toThrow(/Progress/);
    expect(await fs.readFile(file, 'utf8')).toBe(original);
  });

  it('leaves legacy progress after Assignment untouched too', async () => {
    const { root, home } = await setup({
      name: 'builder', pane: '%1', pane_pid: 111, pane_started: 'earlier', handoff: true,
    });
    const file = hivePath(home, 'handoffs', 'builder.md');
    const original = '# builder\n\n## START HERE\n### Assignment\nOld assignment text.\n\nProgress: keep this note.\n\n### Deliverable\nOld deliverable text.\n';
    await fs.writeFile(file, original);
    await expect(respawnAgent(root, 'demo', 'builder', contract)).rejects.toThrow(/Progress/);
    expect(await fs.readFile(file, 'utf8')).toBe(original);
  });
});

describe('Hive agent question policy', () => {
  it('writes a profile that denies native questions and launches fresh sessions with it', async () => {
    const { root, home } = await setup({ name: 'builder' });
    await spawn(root, { agent: 'builder2' });
    const worktree = hivePath(home, 'lanes', 'builder2');
    const profile = hivePath(worktree, 'team', 'builder2', 'agent.md');
    const text = await fs.readFile(profile, 'utf8');
    expect(text).toContain('name: hive-builder2');
    expect(text).toContain('  - AskUserQuestion');
    expect(text).toContain('${base_prompt}');
    expect(text).toContain('mcp__hive-operator__ask_operator');
    expect(vi.mocked(newWindow).mock.calls.at(-1)?.[2]).toContain(`--agent-file '${profile}'`);
  }, 20_000);

  it('resumes the bound profile without incompatible agent-file flags', () => {
    const fresh = launchCommand(undefined, 'ask', 'kimi-code/k3.1-pro', '/tmp/hive agent.md');
    expect(fresh).toContain("--agent-file '/tmp/hive agent.md'");
    const resumed = launchCommand('session_abc', 'ask', 'kimi-code/k3.1-pro', '/tmp/hive agent.md');
    expect(resumed).not.toContain('--agent-file');
    expect(launchCommand(undefined, 'ask')).not.toContain('--agent-file');
  });
});

describe('launchCommand', () => {
  it('builds the teamkimi run line per mode, resume included, K3.1 Pro by default', () => {
    expect(launchCommand(undefined, 'ask')).toBe("KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run -- -m 'kimi-code/k3.1-pro'");
    expect(launchCommand(undefined, 'yolo')).toBe("KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run -- -y -m 'kimi-code/k3.1-pro'");
    expect(launchCommand(undefined, 'auto')).toBe("KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run -- -m 'kimi-code/k3.1-pro'");
    expect(launchCommand(undefined, 'supervised-auto')).toBe("KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run -- --auto -m 'kimi-code/k3.1-pro'");
    expect(launchCommand('session_abc', 'ask')).toBe("KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run -- --session session_abc -m 'kimi-code/k3.1-pro'");
    expect(launchCommand('session_abc', 'yolo')).toBe("KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run -- --session session_abc -y -m 'kimi-code/k3.1-pro'");
    expect(launchCommand('session_abc', 'auto')).toBe("KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run -- --session session_abc -m 'kimi-code/k3.1-pro'");
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
    expect(vi.mocked(newWindow).mock.calls.at(-1)?.[2]).toBe(`HIVE_AGENT=demo-orchestrator HIVE_PROJECT=demo HIVE_HUB_ROOT='${root}' KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run -- --agent-file '${root}/demo/.hive/team/demo-orchestrator/agent.md' -m 'kimi-code/k3.1-pro'`);
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
    expect(vi.mocked(newWindow).mock.calls.at(-1)?.[2]).toBe(`HIVE_AGENT=builder HIVE_PROJECT=demo HIVE_HUB_ROOT='${root}' KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run -- --agent-file '${root}/demo/.hive/team/builder/agent.md' -m 'kimi-code/k3.1-pro'`);
  }, 20_000);

  it('relaunches a plain agent without -y in auto mode and clears its migration fence', async () => {
    const { root, home } = await setup({
      name: 'builder', pane: '%1', pane_pid: 111, pane_started: 'earlier',
      launch_mode: 'auto', migration_state: 'legacy_auto_blocked', watch_authority_revoked_at: '2026-11-20T00:00:00Z',
    });
    await setProjectMode(root, 'demo', 'auto');
    await respawnAgent(root, 'demo', 'builder');
    const cmd = vi.mocked(newWindow).mock.calls.at(-1)?.[2];
    expect(cmd).not.toContain(' -y ');
    expect(cmd).not.toContain('--auto');
    expect((await readTeam(home)).agents[0]).toMatchObject({ launch_mode: 'auto', launch_scoped_auto: true });
    expect((await readTeam(home)).agents[0].migration_state).toBeUndefined();
    expect((await readTeam(home)).agents[0].watch_authority_revoked_at).toBeUndefined();
  }, 20_000);
});

async function approvePlan(root: string, id: string): Promise<void> {
  await approveContract(root, id, taskContract(
    path.join(root, 'demo'), [], 'Return the named artifact and its verification evidence to the orchestrator.',
  ));
}

describe('worker output contracts', () => {
  const contract = {
    assignment: 'Audit cleanup queues and dead-code candidates in the citadel repo.',
    deliverable: 'Write .hive/citadel-audit.md with cited findings and report it to the orchestrator.',
  };

  it('rejects a missing contract before preflight, registration, worktrees, or panes', async () => {
    const { root, home } = await setup({ name: 'builder' });
    const runs = vi.mocked(run).mock.calls.length;
    const windows = vi.mocked(newWindow).mock.calls.length;
    await expect(spawnAgent(root, 'demo', { agent: 'builder2' })).rejects.toThrow(/assignment and deliverable/);
    expect(vi.mocked(run).mock.calls).toHaveLength(runs);
    expect(vi.mocked(newWindow).mock.calls).toHaveLength(windows);
    expect((await readTeam(home)).agents.some((a) => a.name === 'builder2')).toBe(false);
    expect(existsSync(hivePath(home, 'lanes', 'builder2'))).toBe(false);
  });

  it('persists the contract and starts the worker from it instead of waiting for a brief', async () => {
    const { root, home } = await setup({ name: 'builder' });
    await spawn(root, { agent: 'builder2', ...contract });
    const handoff = await fs.readFile(hivePath(hivePath(home, 'lanes', 'builder2'), 'handoffs', 'builder2.md'), 'utf8');
    expect(handoff).toContain(`### Assignment\n${contract.assignment}`);
    expect(handoff).toContain(`### Deliverable\n${contract.deliverable}`);
    const typed = vi.mocked(sendLiteral).mock.calls.at(-1)?.[1];
    expect(typed).toContain('Start with the Assignment and Deliverable');
    expect(typed).not.toContain('wait for its first message');
  }, 20_000);

  it('refuses to respawn a generic legacy handoff before killing the pane', async () => {
    const { root, home } = await setup({
      name: 'builder', pane: '%1', pane_pid: 111, pane_started: 'earlier',
      handoff: true,
    });
    await fs.writeFile(hivePath(home, 'handoffs', 'builder.md'), '# builder handoff\n\n## START HERE\nYou were just spawned. Wait for the first message.\n');
    const kills = vi.mocked(killWindow).mock.calls.length;
    await expect(respawnAgent(root, 'demo', 'builder')).rejects.toThrow(/Assignment and Deliverable/);
    expect(vi.mocked(killWindow).mock.calls).toHaveLength(kills);
  });

  it('repairs a legacy handoff on explicit respawn and retains it for later wakes', async () => {
    const { root, home } = await setup({
      name: 'builder', pane: '%1', pane_pid: 111, pane_started: 'earlier',
      handoff: true, session_id: 'session_b',
    });
    await fs.writeFile(hivePath(home, 'handoffs', 'builder.md'), '# builder handoff\n\n## START HERE\nWait for a message.\n');
    await respawnAgent(root, 'demo', 'builder', contract);
    const handoff = await fs.readFile(hivePath(home, 'handoffs', 'builder.md'), 'utf8');
    expect(handoff).toContain(`### Assignment\n${contract.assignment}`);
    expect(handoff).toContain(`### Deliverable\n${contract.deliverable}`);
  }, 20_000);

  it('refuses to wake a worker whose persisted contract is invalid', async () => {
    const { root, home } = await setup({
      name: 'builder', pane: '%1', pane_pid: 111, pane_started: 'earlier', session_id: 'session_b',
      handoff: true,
    });
    await fs.writeFile(hivePath(home, 'handoffs', 'builder.md'), '# builder handoff\n\n## START HERE\nWait for a message.\n');
    const windows = vi.mocked(newWindow).mock.calls.length;
    await expect(wakeAgent(root, 'demo', 'builder')).rejects.toThrow(/Assignment and Deliverable/);
    expect(vi.mocked(newWindow).mock.calls).toHaveLength(windows);
  });
});

describe('spawn gate', () => {
  it('refuses a worker spawn on a task with no approved plan, before any side effect', async () => {
    const { root, home } = await setup({ name: 'builder' });
    const id = await hubTask(root, 'demo', 'do it');
    const windows = vi.mocked(newWindow).mock.calls.length;
    await expect(spawn(root, { agent: 'worker1', task: id })).rejects.toThrow(/no approved plan/);
    expect(vi.mocked(newWindow).mock.calls).toHaveLength(windows);
    expect((await readTeam(home)).agents.some((a) => a.name === 'worker1')).toBe(false);
  });

  it('lets a worker spawn once the owner approved the plan', async () => {
    const { root } = await setup({ name: 'builder' });
    const id = await hubTask(root, 'demo', 'do it');
    await approvePlan(root, id);
    const pane = await spawn(root, { agent: 'worker1', task: id });
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

  it('keeps a reconcilable revoked reservation when launch fails', async () => {
    const { root, home } = await setup({ name: 'builder' });
    const id = await hubTask(root, 'demo', 'do it');
    await approvePlan(root, id);
    vi.mocked(newWindow).mockRejectedValueOnce(new Error('tmux launch failed'));
    await expect(spawn(root, { agent: 'worker1', task: id })).rejects.toThrow('tmux launch failed');
    expect((await readTeam(home)).agents.find((agent) => agent.name === 'worker1')).toMatchObject({
      task: id, lease_epoch: 1, lease_revoked: true, admission_status: 'launch_failed',
      launch_error: 'tmux launch failed', attempts_used: 1,
    });
  });

  it('refuses registration and typing after the root grant changes post-launch', async () => {
    const { root, home } = await setup({ name: 'builder' });
    const id = await hubTask(root, 'demo', 'do it');
    await approvePlan(root, id);
    const typed = vi.mocked(sendLiteral).mock.calls.length;
    vi.mocked(newWindow).mockImplementationOnce(async () => {
      await appendTaskEvent(root, { id, project: 'demo', event: 'asked', at: new Date().toISOString() });
      return '%9';
    });
    await expect(spawn(root, { agent: 'worker1', task: id })).rejects.toThrow(/no approved plan|root contract grant|current digest/);
    expect(vi.mocked(sendLiteral).mock.calls.slice(typed)).toHaveLength(0);
    expect((await readTeam(home)).agents.find((agent) => agent.name === 'worker1')).toMatchObject({
      lease_revoked: true, admission_status: 'launch_failed',
    });
  });

  it('re-wakes a tasked worker through replacement lineage', async () => {
    const { root, home } = await setup({ name: 'builder' });
    const id = await hubTask(root, 'demo', 'do it');
    await approvePlan(root, id);
    await spawn(root, { agent: 'worker1', task: id });
    const team = await readTeam(home);
    const worker = team.agents.find((agent) => agent.name === 'worker1')!;
    await writeJson(hivePath(home, 'team.json'), {
      agents: team.agents.map((agent) => agent.name === worker.name ? { ...agent, session_id: 'session_worker' } : agent),
    });
    vi.mocked(paneIs).mockResolvedValueOnce(false);
    await wakeAgent(root, 'demo', 'worker1');
    expect((await readTeam(home)).agents.find((agent) => agent.name === 'worker1')).toMatchObject({
      lease_epoch: 1, attempts_used: 2, retry_of: 'worker1', lineage_id: 'worker1',
    });
  }, 20_000);
});

describe('launchWindow identity cleanup', () => {
  beforeEach(() => {
    vi.mocked(killWindow).mockClear();
    vi.mocked(paneIdentity).mockImplementation(async () => ({ pid: 4242, started: 'later' }));
    vi.mocked(paneIs).mockImplementation(async () => true);
  });
  afterEach(() => {
    vi.mocked(paneIdentity).mockImplementation(async () => ({ pid: 4242, started: 'later' }));
  });
  it('kills a fresh spawn pane when identity never arrives', async () => {
    const { root } = await setup({ name: 'builder' });
    vi.mocked(paneIdentity).mockResolvedValue(null);
    await expect(spawn(root, { agent: 'builder2' })).rejects.toThrow(/never got a process identity/);
    expect(killWindow).toHaveBeenCalledWith('%9');
  });

  it('kills a respawn pane when identity query fails', async () => {
    const { root } = await setup({ name: 'builder', pane: '%1', pane_pid: 1, pane_started: 'old' });
    vi.mocked(paneIdentity).mockRejectedValueOnce(new Error('identity query failed'));
    await expect(respawnAgent(root, 'demo', 'builder')).rejects.toThrow('identity query failed');
    expect(killWindow).toHaveBeenCalledWith('%9', undefined);
  });

  it('kills a wake pane when identity never arrives', async () => {
    const { root } = await setup({ name: 'builder', pane: '%1', pane_pid: 1, pane_started: 'old', session_id: 'session_b' });
    vi.mocked(paneIs).mockResolvedValueOnce(false);
    vi.mocked(paneIdentity).mockResolvedValue(null);
    await expect(wakeAgent(root, 'demo', 'builder')).rejects.toThrow(/never got a process identity/);
    expect(killWindow).toHaveBeenCalledWith('%9');
  });

  it('kills an orchestrator pane when identity never arrives', async () => {
    const { root } = await setup({ name: 'builder' });
    const id = await hubTask(root, 'demo', 'start the orchestrator');
    vi.mocked(paneIdentity).mockResolvedValue(null);
    await expect(startProject(root, 'demo', id)).rejects.toThrow(/never got a process identity/);
    expect(killWindow).toHaveBeenCalledWith('%9');
  });
});

describe('tasked relaunch cleanup', () => {
  async function launchedWorker() {
    const { root, home } = await setup({ name: 'builder' });
    vi.mocked(sendLiteral).mockReset().mockImplementation(async () => {});
    vi.mocked(capturePane).mockReset().mockImplementation(async () => IDLE);
    vi.mocked(newWindow).mockReset().mockImplementation(async () => '%9');
    vi.mocked(killWindow).mockReset().mockImplementation(async () => {});
    vi.mocked(paneIdentity).mockReset().mockImplementation(async () => ({ pid: 4242, started: 'later' }));
    vi.mocked(paneIs).mockReset().mockImplementation(async () => true);
    const id = await hubTask(root, 'demo', 'do it');
    await approvePlan(root, id);
    await spawn(root, { agent: 'worker1', task: id });
    vi.mocked(killWindow).mockClear();
    return { root, home, id };
  }

  async function allowWake(home: string) {
    const team = await readTeam(home);
    await writeJson(hivePath(home, 'team.json'), {
      agents: team.agents.map((agent) => agent.name === 'worker1' ? { ...agent, session_id: 'session_worker' } : agent),
    });
    vi.mocked(paneIs).mockResolvedValueOnce(false);
  }

  it.each(['respawn', 'wake'])('preserves a dialog after %s registration and resumes the same replacement', async (kind) => {
    const { root, home } = await launchedWorker();
    const original = (await readTeam(home)).agents.find((agent) => agent.name === 'worker1')!;
    vi.mocked(capturePane).mockImplementation(async () => PERMISSION);
    if (kind === 'wake') await allowWake(home);
    const operation = kind === 'respawn' ? respawnAgent(root, 'demo', 'worker1') : wakeAgent(root, 'demo', 'worker1');
    await expect(operation).resolves.toBe('%9');
    const replacement = (await readTeam(home)).agents.find((agent) => agent.name === 'worker1')!;
    expect(replacement).toMatchObject({ attempts_used: 2, lease_revoked: false });
    expect(replacement.lease_id).not.toBe(original.lease_id);
    expect(replacement.launch_pending).toMatchObject({ pane: '%9', lease_id: replacement.lease_id });
    expect(replacement.worktree).toBe(original.worktree);
    expect(replacement.launch_pending?.worktree).toBe(original.worktree);
    const approval = redactDialog((await readDialogFor(root, 'demo', 'worker1'))!).fingerprint;
    let answered = false;
    vi.mocked(capturePane).mockImplementation(async () => answered ? IDLE : PERMISSION);
    vi.mocked(sendLiteral).mockImplementation(async (_pane, text) => {
      if (text === '1') answered = true;
    });
    await answerDialog(root, 'demo', 'worker1', '1', approval);
    const resumed = (await readTeam(home)).agents.find((agent) => agent.name === 'worker1')!;
    expect(resumed).toMatchObject({ attempts_used: 2, lease_id: replacement.lease_id });
    expect(resumed.launch_pending).toBeUndefined();
  });

  it.each(['respawn', 'wake'])('kills the new pane and revokes the replacement after %s startup timeout', async (kind) => {
    const { root, home } = await launchedWorker();
    vi.mocked(capturePane).mockImplementation(async () => 'starting');
    if (kind === 'wake') await allowWake(home);
    const operation = kind === 'respawn' ? respawnAgent(root, 'demo', 'worker1') : wakeAgent(root, 'demo', 'worker1');
    await expect(operation).rejects.toThrow(/never went idle/);
    expect(killWindow).toHaveBeenCalledWith('%9', { pid: 4242, started: 'later' });
    expect((await readTeam(home)).agents.find((agent) => agent.name === 'worker1')).toMatchObject({
      attempts_used: 2, lease_revoked: true, admission_status: 'launch_failed', closed_at: expect.any(String),
    });
  });

  it.each(['respawn', 'wake'])('kills the new pane when %s input fails', async (kind) => {
    const { root, home } = await launchedWorker();
    vi.mocked(sendLiteral).mockRejectedValueOnce(new Error('input failed'));
    if (kind === 'wake') await allowWake(home);
    const operation = kind === 'respawn' ? respawnAgent(root, 'demo', 'worker1') : wakeAgent(root, 'demo', 'worker1');
    await expect(operation).rejects.toThrow('input failed');
    expect(killWindow).toHaveBeenCalledWith('%9', { pid: 4242, started: 'later' });
    expect((await readTeam(home)).agents.find((agent) => agent.name === 'worker1')?.closed_at).toBeTruthy();
  });

  it('kills the new pane when cancellation lands during relaunch', async () => {
    const { root, home, id } = await launchedWorker();
    vi.mocked(newWindow).mockImplementationOnce(async () => {
      await hubResolve(root, 'demo', id, 'cancel', 'stop during relaunch');
      return '%9';
    });
    await expect(respawnAgent(root, 'demo', 'worker1')).rejects.toThrow(/root contract grant|current/);
    expect(killWindow).toHaveBeenCalledWith('%9', { pid: 4242, started: 'later' });
    expect((await readTeam(home)).agents.find((agent) => agent.name === 'worker1')?.closed_at).toBeTruthy();
  });

  it('surfaces new pane cleanup failure honestly', async () => {
    const { root, home } = await launchedWorker();
    await allowWake(home);
    vi.mocked(sendLiteral).mockRejectedValueOnce(new Error('input failed'));
    vi.mocked(killWindow).mockRejectedValueOnce(new Error('tmux cleanup failed'));
    await expect(wakeAgent(root, 'demo', 'worker1')).rejects.toThrow(/new pane cleanup failed: tmux cleanup failed/);
  });

  it('preserves credential content, path, and permissions across respawn and wake', async () => {
    const { root, home } = await launchedWorker();
    const worker = (await readTeam(home)).agents.find((agent) => agent.name === 'worker1')!;
    const credential = hivePath(worker.worktree!, 'team', 'worker1', 'credential.env');
    const secret = 'not-a-real-credential-value';
    await fs.mkdir(path.dirname(credential), { recursive: true });
    await fs.writeFile(credential, `HIVE_AGENT_CREDENTIAL='${secret}'\n`, { mode: 0o600 });
    await respawnAgent(root, 'demo', 'worker1');
    await allowWake(home);
    await wakeAgent(root, 'demo', 'worker1');
    expect(await fs.readFile(credential, 'utf8')).toBe(`HIVE_AGENT_CREDENTIAL='${secret}'\n`);
    expect((await fs.stat(credential)).mode & 0o777).toBe(0o600);
    expect(vi.mocked(newWindow).mock.calls.every((call) => !call[2].includes(secret))).toBe(true);
  }, 20_000);
});

describe('spawn parent', () => {
  it('stamps opts.parent, else the pane env, else nothing', async () => {
    const { root, home } = await setup({ name: 'builder' });
    await spawn(root, { agent: 'w1', parent: 'demo-orchestrator' });
    vi.stubEnv('HIVE_AGENT', 'demo-orchestrator');
    try {
      await spawn(root, { agent: 'w2' });
    } finally {
      vi.unstubAllEnvs();
    }
    await spawn(root, { agent: 'w3' });
    const team = await readTeam(home);
    expect(team.agents.find((a) => a.name === 'w1')?.parent).toBe('demo-orchestrator');
    expect(team.agents.find((a) => a.name === 'w2')?.parent).toBe('demo-orchestrator');
    expect(team.agents.find((a) => a.name === 'w3')?.parent).toBeUndefined();
  }, 20_000);
});

describe('trust dialog at spawn', () => {
  const trustAt = (folder: string, second = false) => (second ? TRUST_MENU_2 : TRUST_MENU).replaceAll('/tmp', folder);

  it('answers only an exact new-lane path with the known pane identity, then finishes', async () => {
    const { root, home } = await setup({ name: 'builder' });
    const worktree = hivePath(home, 'lanes', 'builder2');
    let calls = 0;
    vi.mocked(capturePane).mockImplementation(async () => (++calls <= 2 ? trustAt(worktree) : IDLE));
    try {
      const pane = await spawn(root, { agent: 'builder2' });
      expect(pane).toBe('%9');
      expect(vi.mocked(sendArrow).mock.calls).toEqual([]);
      expect(vi.mocked(sendEnter).mock.calls).toContainEqual(['%9', { pid: 4242, started: 'later' }]);
    } finally {
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('walks the exact new-lane menu with pane identity on every arrow', async () => {
    const { root, home } = await setup({ name: 'builder' });
    const worktree = hivePath(home, 'lanes', 'builder2');
    let calls = 0;
    vi.mocked(capturePane).mockImplementation(async () => (++calls <= 2 ? trustAt(worktree, true) : IDLE));
    vi.mocked(sendArrow).mockClear();
    try {
      await spawn(root, { agent: 'builder2' });
      expect(vi.mocked(sendArrow).mock.calls).toEqual([['%9', 'Down', { pid: 4242, started: 'later' }]]);
    } finally {
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('surfaces an undeclared startup dialog in managed auto mode without typing or killing', async () => {
    const { root } = await setup({ name: 'builder' });
    await setProjectMode(root, 'demo', 'auto');
    let calls = 0;
    const typed = vi.mocked(sendLiteral).mock.calls.length;
    const kills = vi.mocked(killWindow).mock.calls.length;
    vi.mocked(capturePane).mockImplementation(async () => PERMISSION);
    try {
      await expect(spawn(root, { agent: 'builder2' })).resolves.toBe('%9');
      expect(vi.mocked(sendLiteral).mock.calls.slice(typed)).toHaveLength(0);
      expect(vi.mocked(killWindow).mock.calls.slice(kills)).toHaveLength(0);
    } finally {
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('answers only the Hive-created folder trust menu in managed auto mode, then types once', async () => {
    const { root, home } = await setup({ name: 'builder' });
    const worktree = hivePath(home, 'lanes', 'builder2');
    await setProjectMode(root, 'demo', 'auto');
    let calls = 0;
    const typed = vi.mocked(sendLiteral).mock.calls.length;
    const entered = vi.mocked(sendEnter).mock.calls.length;
    vi.mocked(capturePane).mockImplementation(async () => (++calls <= 2 ? trustAt(worktree) : IDLE));
    try {
      await expect(spawn(root, { agent: 'builder2' })).resolves.toBe('%9');
      expect(vi.mocked(sendEnter).mock.calls.slice(entered)).toContainEqual(['%9', { pid: 4242, started: 'later' }]);
      expect(vi.mocked(sendLiteral).mock.calls.slice(typed)).toHaveLength(1);
    } finally {
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('resumes an undeclared dialog on managed auto relaunch with the same replacement', async () => {
    const { root, home } = await setup({ name: 'builder', pane: '%1', pane_pid: 111, pane_started: 'earlier' });
    await setProjectMode(root, 'demo', 'auto');
    const typed = vi.mocked(sendLiteral).mock.calls.length;
    const kills = vi.mocked(killWindow).mock.calls.length;
    vi.mocked(capturePane).mockImplementation(async () => PERMISSION);
    try {
      await expect(respawnAgent(root, 'demo', 'builder')).resolves.toBe('%9');
      expect(vi.mocked(sendLiteral).mock.calls.slice(typed)).toHaveLength(0);
      expect(vi.mocked(killWindow).mock.calls.slice(kills).filter((call) => call[0] === '%9')).toHaveLength(0);
      const replacement = (await readTeam(home)).agents.find((agent) => agent.name === 'builder')!;
      expect(replacement.launch_pending?.pane).toBe('%9');
      expect(replacement.launch_pending?.lease_id).toBe(replacement.lease_id);
      expect(replacement.worktree).toBe(home);
      expect(replacement.launch_pending?.worktree).toBe(home);
      const approval = redactDialog((await readDialogFor(root, 'demo', 'builder'))!).fingerprint;
      let answered = false;
      vi.mocked(capturePane).mockImplementation(async () => answered ? IDLE : PERMISSION);
      vi.mocked(sendLiteral).mockImplementation(async (_pane, text) => {
        if (text === '1') answered = true;
      });
      await answerDialog(root, 'demo', 'builder', '1', approval);
      expect(vi.mocked(sendLiteral).mock.calls.slice(typed).filter((call) => call[1].startsWith('You are builder'))).toHaveLength(1);
      expect((await readTeam(home)).agents.find((agent) => agent.name === 'builder')?.launch_pending).toBeUndefined();
    } finally {
      vi.mocked(sendLiteral).mockImplementation(async () => {});
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('never auto-trusts a caller-supplied existing worktree even when its path matches', async () => {
    const { root, home } = await setup({ name: 'builder' });
    const worktree = path.join(home, 'lane');
    await fs.mkdir(worktree, { recursive: true });
    await setProjectMode(root, 'demo', 'auto');
    vi.mocked(capturePane).mockImplementation(async () => trustAt(worktree));
    vi.mocked(sendArrow).mockClear();
    vi.mocked(sendEnter).mockClear();
    try {
      await expect(spawn(root, { agent: 'builder2', worktree: 'lane' })).resolves.toBe('%9');
      expect(sendArrow).not.toHaveBeenCalled();
      expect(sendEnter).not.toHaveBeenCalled();
    } finally {
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('never auto-trusts a mismatched displayed path', async () => {
    const { root } = await setup({ name: 'builder' });
    await setProjectMode(root, 'demo', 'auto');
    vi.mocked(capturePane).mockImplementation(async () => TRUST_MENU);
    vi.mocked(sendArrow).mockClear();
    vi.mocked(sendEnter).mockClear();
    try {
      await expect(spawn(root, { agent: 'builder2' })).resolves.toBe('%9');
      expect(sendArrow).not.toHaveBeenCalled();
      expect(sendEnter).not.toHaveBeenCalled();
    } finally {
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('never auto-trusts during relaunch', async () => {
    const { root, home } = await setup({ name: 'builder', pane: '%1', pane_pid: 111, pane_started: 'earlier' });
    await setProjectMode(root, 'demo', 'auto');
    vi.mocked(capturePane).mockImplementation(async () => trustAt(home));
    vi.mocked(sendArrow).mockClear();
    vi.mocked(sendEnter).mockClear();
    try {
      await expect(respawnAgent(root, 'demo', 'builder')).resolves.toBe('%9');
      expect(sendArrow).not.toHaveBeenCalled();
      expect(sendEnter).not.toHaveBeenCalled();
    } finally {
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('preserves a dialog launch with bounded evidence, its workspace, lease, and claim', async () => {
    const { root, home } = await setup({ name: 'builder' });
    await setProjectMode(root, 'demo', 'ask');
    const id = await hubTask(root, 'demo', 'do it');
    await approvePlan(root, id);
    const worktree = hivePath(home, 'lanes', 'worker1');
    const secret = 'launch-recovery-secret';
    const dialog = PERMISSION.replace(
      '   ↑/↓ select',
      `   api_key=${secret}\n   ${'x'.repeat(5000)}\n   ↑/↓ select`,
    );
    const typed = vi.mocked(sendLiteral).mock.calls.length;
    const kills = vi.mocked(killWindow).mock.calls.length;
    const runs = vi.mocked(run).mock.calls.length;
    vi.mocked(capturePane).mockImplementation(async () => dialog);
    try {
      await expect(spawn(root, { agent: 'worker1', task: id })).resolves.toBe('%9');
      expect(vi.mocked(sendLiteral).mock.calls.slice(typed)).toHaveLength(0);
      expect(vi.mocked(killWindow).mock.calls.slice(kills)).toHaveLength(0);
      const worker = (await readTeam(home)).agents.find((agent) => agent.name === 'worker1')!;
      expect(worker).toMatchObject({
        pane: '%9', worktree, lease_revoked: false, admission_status: 'admitted', attempts_used: 1,
      });
      expect(worker.launch_pending).toMatchObject({
        agent: 'worker1', pane: '%9', pane_pid: 4242, pane_started: 'later',
        lease_id: worker.lease_id, launch_claim_path: worker.launch_claim_path,
      });
      expect(worker.launch_pending!.dialog).toContain('api_key=[redacted]');
      expect(worker.launch_pending!.dialog).not.toContain(secret);
      expect(worker.launch_pending!.dialog.length).toBeLessThanOrEqual(4000);
      const external = redactDialog((await readDialogFor(root, 'demo', 'worker1'))!);
      expect(external.text).toContain('api_key=[redacted]');
      expect(external.text).not.toContain(secret);
      expect(worker.launch_pending!.fingerprint).toMatch(/^[0-9a-f]{40}$/);
      expect(await fs.stat(worktree)).toBeTruthy();
      expect(await fs.stat(path.join(root, worker.launch_claim_path!))).toBeTruthy();
      expect(vi.mocked(run).mock.calls.slice(runs).some((call) => call[0] === 'jj' && call[1].includes('forget'))).toBe(false);
    } finally {
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  async function pendingLaunch() {
    const { root, home } = await setup({ name: 'builder' });
    vi.mocked(capturePane).mockImplementation(async () => IDLE);
    const id = await hubTask(root, 'demo', 'do it');
    await approvePlan(root, id);
    try {
      vi.mocked(capturePane).mockImplementation(async () => PERMISSION);
      await spawn(root, { agent: 'worker1', task: id });
      const worker = (await readTeam(home)).agents.find((agent) => agent.name === 'worker1')!;
      const approval = redactDialog((await readDialogFor(root, 'demo', 'worker1'))!).fingerprint;
      return { root, home, id, worker, approval };
    } finally {
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }

  async function pendingPlainLaunch() {
    const { root, home } = await setup({ name: 'builder' });
    try {
      vi.mocked(capturePane).mockImplementation(async () => PERMISSION);
      await spawn(root, { agent: 'worker1' });
      const worker = (await readTeam(home)).agents.find((agent) => agent.name === 'worker1')!;
      const approval = redactDialog((await readDialogFor(root, 'demo', 'worker1'))!).fingerprint;
      return { root, home, worker, approval };
    } finally {
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }

  it('resumes the same pane and lease after a structured answer without another attempt', async () => {
    const { root, home, id, worker, approval } = await pendingLaunch();
    const windows = vi.mocked(newWindow).mock.calls.length;
    try {
      await expect(spawn(root, { agent: 'worker1', task: id })).rejects.toThrow(/already has an agent/);
      expect(vi.mocked(newWindow).mock.calls).toHaveLength(windows);
      expect((await readTeam(home)).agents.find((agent) => agent.name === 'worker1')?.attempts_used).toBe(1);

      let reads = 0;
      vi.mocked(capturePane).mockImplementation(async () => ++reads <= 2 ? PERMISSION : IDLE);
      const typed = vi.mocked(sendLiteral).mock.calls.length;
      await answerDialog(root, 'demo', 'worker1', '1', approval);
      const sent = vi.mocked(sendLiteral).mock.calls.slice(typed);
      expect(sent[0]).toEqual(['%9', '1', { pid: 4242, started: 'later' }]);
      expect(sent.filter((call) => call[1].startsWith('You are worker1'))).toHaveLength(1);
      expect(vi.mocked(newWindow).mock.calls).toHaveLength(windows);

      const resumed = (await readTeam(home)).agents.find((agent) => agent.name === 'worker1')!;
      expect(resumed).toMatchObject({
        pane: '%9', lease_id: worker.lease_id, attempts_used: 1,
        lease_revoked: false, admission_status: 'admitted',
      });
      expect(resumed.launch_pending).toBeUndefined();
      await expect(fs.stat(path.join(root, worker.launch_claim_path!))).rejects.toThrow();
    } finally {
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('registers non-task pending claim metadata when no prior claim exists', async () => {
    const { root, home, worker, approval } = await pendingPlainLaunch();
    expect(worker).toMatchObject({
      launch_claim_path: worker.launch_pending!.launch_claim_path,
      launch_claim_digest: worker.launch_pending!.launch_claim_digest,
      launch_claim_in_worktree: false,
      launch_claim_completed: false,
    });
    let answered = false;
    vi.mocked(capturePane).mockImplementation(async () => answered ? IDLE : PERMISSION);
    vi.mocked(sendLiteral).mockImplementation(async (_pane, text) => {
      if (text === '1') answered = true;
    });
    try {
      await answerDialog(root, 'demo', 'worker1', '1', approval);
      expect((await readTeam(home)).agents.find((agent) => agent.name === 'worker1')?.launch_pending).toBeUndefined();
    } finally {
      vi.mocked(sendLiteral).mockImplementation(async () => {});
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('replaces older non-task top-level claim metadata with the pending replacement claim', async () => {
    const { root, home, worker } = await pendingPlainLaunch();
    const olderClaim = '.hive-hub/launches/demo:older.json';
    await writeJson(hivePath(home, 'team.json'), {
      agents: (await readTeam(home)).agents.map((agent) => agent.name === 'worker1'
        ? { ...agent, launch_claim_path: olderClaim, launch_claim_digest: 'older-digest' } : agent),
    });
    vi.mocked(capturePane).mockImplementation(async () => PERMISSION);
    await respawnAgent(root, 'demo', 'worker1');
    const replacement = (await readTeam(home)).agents.find((agent) => agent.name === 'worker1')!;
    expect(replacement.launch_pending).toBeDefined();
    expect(replacement.launch_claim_path).toBe(replacement.launch_pending!.launch_claim_path);
    expect(replacement.launch_claim_digest).toBe(replacement.launch_pending!.launch_claim_digest);
    expect(replacement.launch_claim_path).not.toBe(olderClaim);
    expect(replacement.launch_claim_path).not.toBe(worker.launch_claim_path);
    const approval = redactDialog((await readDialogFor(root, 'demo', 'worker1'))!).fingerprint;
    let answered = false;
    vi.mocked(capturePane).mockImplementation(async () => answered ? IDLE : PERMISSION);
    vi.mocked(sendLiteral).mockImplementation(async (_pane, text) => {
      if (text === '1') answered = true;
    });
    try {
      await answerDialog(root, 'demo', 'worker1', '1', approval);
      expect((await readTeam(home)).agents.find((agent) => agent.name === 'worker1')?.launch_pending).toBeUndefined();
    } finally {
      vi.mocked(sendLiteral).mockImplementation(async () => {});
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('resumes only the selected worker@path when duplicate names have pending launches', async () => {
    const { root, home, worker } = await pendingPlainLaunch();
    const otherWorktree = path.join(home, 'other');
    await fs.mkdir(otherWorktree, { recursive: true });
    const otherClaim = '.hive-hub/launches/demo:other.json';
    await writeJson(path.join(root, otherClaim), { project: 'demo' });
    const other = {
      ...worker,
      pane: '%8', pane_pid: 4343, pane_started: 'other', worktree: otherWorktree,
      launch_claim_path: otherClaim, launch_claim_digest: 'other-digest',
      launch_pending: {
        ...worker.launch_pending!, pane: '%8', pane_pid: 4343, pane_started: 'other',
        worktree: otherWorktree, launch_claim_path: otherClaim, launch_claim_digest: 'other-digest',
      },
    };
    await writeJson(hivePath(home, 'team.json'), { agents: [worker, other] });
    vi.mocked(capturePane).mockImplementation(async () => PERMISSION);
    const ref = `worker1@${otherWorktree}`;
    const approval = redactDialog((await readDialogFor(root, 'demo', ref))!).fingerprint;
    let answered = false;
    vi.mocked(capturePane).mockImplementation(async () => answered ? IDLE : PERMISSION);
    vi.mocked(sendLiteral).mockClear();
    vi.mocked(sendLiteral).mockImplementation(async (_pane, text) => {
      if (text === '1') answered = true;
    });
    try {
      await answerDialog(root, 'demo', ref, '1', approval);
      const agents = (await readTeam(home)).agents;
      expect(agents.find((agent) => agent.pane === '%8')?.launch_pending).toBeUndefined();
      expect(agents.find((agent) => agent.pane === '%9')?.launch_pending).toBeDefined();
      expect(vi.mocked(sendLiteral).mock.calls.filter((call) => call[0] === '%8' && call[1].startsWith('You are worker1')))
        .toHaveLength(1);
      expect(vi.mocked(sendLiteral).mock.calls.filter((call) => call[0] === '%9' && call[1].startsWith('You are worker1')))
        .toHaveLength(0);
      expect(await fs.stat(path.join(root, otherClaim)).catch(() => null)).toBeNull();
      expect(await fs.stat(path.join(root, worker.launch_claim_path!))).toBeTruthy();
    } finally {
      vi.mocked(sendLiteral).mockImplementation(async () => {});
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('resumes after a crash immediately after the final dialog key without a second pickup', async () => {
    const { root, home, approval } = await pendingPlainLaunch();
    let answered = false;
    vi.mocked(capturePane).mockImplementation(async () => answered ? IDLE : PERMISSION);
    vi.mocked(sendLiteral).mockClear();
    vi.mocked(sendLiteral).mockImplementation(async (_pane, text) => {
      if (text === '1') answered = true;
    });
    const sleepImplementation = vi.mocked(sleep).getMockImplementation()!;
    vi.mocked(sleep).mockRejectedValueOnce(new Error('crash after delivery'));
    try {
      await expect(answerDialog(root, 'demo', 'worker1', '1', approval)).rejects.toThrow('crash after delivery');
      const delivered = (await readTeam(home)).agents.find((agent) => agent.name === 'worker1')!;
      expect(delivered.launch_pending?.dialog_delivered).toBe(true);
      expect(delivered.launch_pending?.pickup_typed).toBeUndefined();
      vi.mocked(sleep).mockImplementation(sleepImplementation);
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
      await answerDialog(root, 'demo', 'worker1', '1', approval);
      expect(vi.mocked(sendLiteral).mock.calls.filter((call) => call[1].startsWith('You are worker1'))).toHaveLength(1);
      expect((await readTeam(home)).agents.find((agent) => agent.name === 'worker1')?.launch_pending).toBeUndefined();
    } finally {
      vi.mocked(sleep).mockImplementation(sleepImplementation);
      vi.mocked(sendLiteral).mockImplementation(async () => {});
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('refuses a stale pane identity and retains the pending evidence and claim', async () => {
    const { root, home, worker, approval } = await pendingLaunch();
    const windows = vi.mocked(newWindow).mock.calls.length;
    vi.mocked(paneIs).mockResolvedValue(false);
    let reads = 0;
    vi.mocked(capturePane).mockImplementation(async () => ++reads <= 2 ? PERMISSION : IDLE);
    vi.mocked(sendLiteral).mockClear();
    vi.mocked(sendArrow).mockClear();
    vi.mocked(sendEnter).mockClear();
    vi.mocked(sendEscape).mockClear();
    try {
      await expect(answerDialog(root, 'demo', 'worker1', '1', approval))
        .rejects.toThrow(/identity|changed|no longer/);
      expect(vi.mocked(sendLiteral)).not.toHaveBeenCalled();
      expect(vi.mocked(sendArrow)).not.toHaveBeenCalled();
      expect(vi.mocked(sendEnter)).not.toHaveBeenCalled();
      expect(vi.mocked(sendEscape)).not.toHaveBeenCalled();
      expect(vi.mocked(newWindow).mock.calls).toHaveLength(windows);
      const pending = (await readTeam(home)).agents.find((agent) => agent.name === 'worker1')!;
      expect(pending.launch_pending).toEqual(worker.launch_pending);
      expect(await fs.stat(path.join(root, worker.launch_claim_path!))).toBeTruthy();
    } finally {
      vi.mocked(paneIs).mockResolvedValue(true);
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('refuses a substituted pending dialog without sending keys', async () => {
    const { root, home, worker, approval } = await pendingLaunch();
    await writeJson(hivePath(home, 'team.json'), {
      agents: (await readTeam(home)).agents.map((agent) => agent.name === 'worker1'
        ? { ...agent, launch_pending: { ...agent.launch_pending!, fingerprint: 'replacement' } } : agent),
    });
    vi.mocked(capturePane).mockImplementation(async () => PERMISSION);
    vi.mocked(sendLiteral).mockClear();
    try {
      await expect(answerDialog(root, 'demo', 'worker1', '1', approval))
        .rejects.toThrow(/dialog|pending/);
      expect(vi.mocked(sendLiteral)).not.toHaveBeenCalled();
    } finally {
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('records an answer before keys and refuses a conflicting answer without input', async () => {
    const { root, home, approval } = await pendingLaunch();
    const changed = PERMISSION.replace('Run this command?', 'Run this changed command?');
    let reads = 0;
    vi.mocked(capturePane).mockImplementation(async () => ++reads === 1 ? PERMISSION : changed);
    vi.mocked(sendLiteral).mockClear();
    try {
      await expect(answerDialog(root, 'demo', 'worker1', '1', approval)).rejects.toThrow(/changed/);
      const recorded = (await readTeam(home)).agents.find((agent) => agent.name === 'worker1')!.launch_pending!;
      expect(recorded).toMatchObject({ answer_choice: '1', answer_option: 'Approve once', approved: true });
      expect(recorded.pickup_typed).toBeUndefined();
      expect(recorded.dialog_delivered).toBeUndefined();
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
      await expect(answerDialog(root, 'demo', 'worker1', '1', approval)).rejects.toThrow(/delivery/);
      expect(vi.mocked(sendLiteral).mock.calls.filter((call) => call[1].startsWith('You are worker1'))).toHaveLength(0);
      vi.mocked(capturePane).mockImplementation(async () => PERMISSION);
      await expect(answerDialog(root, 'demo', 'worker1', '3', approval)).rejects.toThrow(/different recorded answer/);
      expect(vi.mocked(sendLiteral)).not.toHaveBeenCalled();
    } finally {
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it.each(['3', 'esc'])('denial %s revokes and cleans the pending launch without a pickup', async (choice) => {
    const { root, home, worker, approval } = await pendingLaunch();
    let reads = 0;
    vi.mocked(capturePane).mockImplementation(async () => ++reads <= 2 ? PERMISSION : IDLE);
    vi.mocked(sendLiteral).mockClear();
    vi.mocked(sendEscape).mockClear();
    const worktree = worker.worktree!;
    try {
      await expect(answerDialog(root, 'demo', 'worker1', choice, approval))
        .resolves.toMatchObject({ dialog_gone: true });
      const identity = { pid: 4242, started: 'later' };
      if (choice === 'esc') expect(vi.mocked(sendEscape)).toHaveBeenCalledWith('%9', identity);
      else expect(vi.mocked(sendLiteral)).toHaveBeenCalledWith('%9', '3', identity);
      expect(vi.mocked(sendLiteral).mock.calls.filter((call) => call[1].startsWith('You are worker1'))).toHaveLength(0);
      expect(vi.mocked(killWindow)).toHaveBeenCalledWith('%9', identity);
      const denied = (await readTeam(home)).agents.find((agent) => agent.name === 'worker1')!;
      expect(denied).toMatchObject({ admission_status: 'launch_failed', lease_revoked: true, closed_at: expect.any(String) });
      expect(denied.launch_error).toMatch(/denied/);
      expect(denied.launch_pending!.dialog).toContain('Run this command?');
      expect(await fs.stat(worktree).catch(() => null)).toBeNull();
      expect(await fs.stat(path.join(root, worker.launch_claim_path!)).catch(() => null)).toBeNull();
    } finally {
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('passes the recorded identity to every menu key before resuming', async () => {
    const { root, home } = await setup({ name: 'builder' });
    const id = await hubTask(root, 'demo', 'do it');
    await approvePlan(root, id);
    const worktree = path.join(home, 'lane');
    await fs.mkdir(worktree, { recursive: true });
    const menu = trustAt(worktree, true);
    vi.mocked(capturePane).mockImplementation(async () => menu);
    await spawn(root, { agent: 'worker1', task: id, worktree: 'lane' });
    const worker = (await readTeam(home)).agents.find((agent) => agent.name === 'worker1')!;
    const approval = redactDialog((await readDialogFor(root, 'demo', 'worker1'))!).fingerprint;
    let answered = false;
    vi.mocked(capturePane).mockImplementation(async () => answered ? IDLE : menu);
    vi.mocked(sendEnter).mockImplementation(async () => { answered = true; });
    vi.mocked(sendArrow).mockClear();
    vi.mocked(sendEnter).mockClear();
    try {
      await answerDialog(root, 'demo', 'worker1', '2', approval);
      const identity = { pid: 4242, started: 'later' };
      expect(vi.mocked(sendArrow)).toHaveBeenCalledWith('%9', 'Down', identity);
      expect(vi.mocked(sendEnter)).toHaveBeenCalledWith('%9', identity);
      expect((await readTeam(home)).agents.find((agent) => agent.name === 'worker1')?.launch_pending).toBeUndefined();
    } finally {
      vi.mocked(sendEnter).mockImplementation(async () => {});
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('resumes through the real watch auto-approval path without reacquiring its grant', async () => {
    const { root, home, worker, approval } = await pendingLaunch();
    await setProjectMode(root, 'demo', 'auto');
    vi.mocked(sendLiteral).mockClear();
    let answered = false;
    vi.mocked(capturePane).mockImplementation(async () => answered ? IDLE : PERMISSION);
    vi.mocked(sendLiteral).mockImplementation(async (_pane, text) => {
      if (text === '1') answered = true;
    });
    try {
      await watchCycle(root, {}, new Set(), new Map(), new Map(), { verdicts: new Map(), marks: new Set() });
      const resumed = (await readTeam(home)).agents.find((agent) => agent.name === 'worker1')!;
      expect(resumed).toMatchObject({ lease_id: worker.lease_id, attempts_used: 1 });
      expect(resumed.launch_pending).toBeUndefined();
      expect(vi.mocked(sendLiteral).mock.calls.filter((call) => call[1].startsWith('You are worker1'))).toHaveLength(1);
    } finally {
      vi.mocked(sendLiteral).mockImplementation(async () => {});
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('close releases the preserved claim so project delete can finish', async () => {
    const { root, home, worker, approval } = await pendingLaunch();
    await closeAgent(root, 'demo', 'worker1');
    await closeAgent(root, 'demo', 'builder');
    await closeAgent(root, 'demo', 'demo-orchestrator');
    expect(vi.mocked(killWindow)).toHaveBeenCalledWith('%9', { pid: 4242, started: 'later' });
    expect(await fs.stat(path.join(root, worker.launch_claim_path!)).catch(() => null)).toBeNull();
    await expect(removeProject(root, 'demo')).resolves.toEqual({ ok: true, name: 'demo' });
  }, 20_000);

  it('pending respawn releases the old claim and clears pending identity', async () => {
    const { root, home, worker, approval } = await pendingLaunch();
    vi.mocked(capturePane).mockImplementation(async () => IDLE);
    await respawnAgent(root, 'demo', 'worker1');
    const replacement = (await readTeam(home)).agents.find((agent) => agent.name === 'worker1')!;
    expect(replacement).toMatchObject({ attempts_used: 2 });
    expect(replacement.launch_pending).toBeUndefined();
    expect(replacement.lease_id).not.toBe(worker.lease_id);
    expect(await fs.stat(path.join(root, worker.launch_claim_path!)).catch(() => null)).toBeNull();
  }, 20_000);

  it.each(['pickup', 'finish'])('%s failure revokes and cleans the launch with dialog evidence', async (stage) => {
    const { root, home, worker, approval } = await pendingLaunch();
    let reads = 0;
    vi.mocked(capturePane).mockImplementation(async () => ++reads <= 2 ? PERMISSION : IDLE);
    if (stage === 'pickup') {
      vi.mocked(sendLiteral).mockImplementation(async (_pane, text) => {
        if (text.startsWith('You are worker1')) throw new Error('pickup failed');
      });
    } else {
      vi.mocked(completeTmuxLaunch).mockRejectedValueOnce(new Error('finish failed'));
    }
    try {
      await expect(answerDialog(root, 'demo', 'worker1', '1', approval))
        .rejects.toThrow(`${stage} failed`);
      const failed = (await readTeam(home)).agents.find((agent) => agent.name === 'worker1')!;
      expect(failed).toMatchObject({ admission_status: 'launch_failed', lease_revoked: true, closed_at: expect.any(String) });
      expect(failed.launch_error).toContain(`${stage} failed`);
      expect(failed.launch_error).toContain('Run this command?');
      expect(vi.mocked(killWindow)).toHaveBeenCalledWith('%9', { pid: 4242, started: 'later' });
      expect(await fs.stat(worker.worktree!).catch(() => null)).toBeNull();
      expect(await fs.stat(path.join(root, worker.launch_claim_path!)).catch(() => null)).toBeNull();
    } finally {
      vi.mocked(sendLiteral).mockImplementation(async () => {});
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('resumes after a session-record failure without another dialog or pickup', async () => {
    const { root, home, worker, approval } = await pendingLaunch();
    vi.mocked(sendLiteral).mockClear();
    const sessionHome = mkdtempSync(path.join(tmpdir(), 'hive-pending-session-'));
    const defaultHome = os.homedir();
    vi.mocked(os.homedir).mockReturnValue(sessionHome);
    const state = path.join(sessionHome, '.kimi-code', 'sessions', 'wd_test', 'session_worker', 'state.json');
    await fs.mkdir(path.dirname(state), { recursive: true });
    await fs.writeFile(state, JSON.stringify({ cwd: worker.worktree, updatedAt: 1, lastPrompt: 'You are worker1 of project demo.' }));
    const compare = vi.mocked(compareAndSwapTeamEntry).getMockImplementation()!;
    let failed = false;
    vi.mocked(compareAndSwapTeamEntry).mockImplementation(async (home, expected, update) => {
      if (!failed && update && update.session_id === 'session_worker') {
        failed = true;
        throw new Error('session failed');
      }
      return compare(home, expected, update);
    });
    let reads = 0;
    vi.mocked(capturePane).mockImplementation(async () => ++reads <= 2 ? PERMISSION : IDLE);
    try {
      await expect(answerDialog(root, 'demo', 'worker1', '1', approval))
        .rejects.toThrow('session failed');
      const pending = (await readTeam(home)).agents.find((agent) => agent.name === 'worker1')!;
      expect(pending.launch_pending?.pickup_typed).toBe(true);
      expect(pending.launch_pending?.resume_token).toBeUndefined();
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
      await answerDialog(root, 'demo', 'worker1', '1', approval);
      expect(vi.mocked(sendLiteral).mock.calls.filter((call) => call[1].startsWith('You are worker1'))).toHaveLength(1);
      const resumed = (await readTeam(home)).agents.find((agent) => agent.name === 'worker1')!;
      expect(resumed.session_id).toBe('session_worker');
      expect(resumed.launch_pending).toBeUndefined();
    } finally {
      vi.mocked(compareAndSwapTeamEntry).mockImplementation(compare);
      vi.mocked(os.homedir).mockReturnValue(defaultHome);
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('resumes a final-clear failure after finish without another dialog or pickup', async () => {
    const { root, home, worker, approval } = await pendingLaunch();
    vi.mocked(completeTmuxLaunch).mockClear();
    vi.mocked(sendLiteral).mockClear();
    const compare = vi.mocked(compareAndSwapTeamEntry).getMockImplementation()!;
    let failed = false;
    vi.mocked(compareAndSwapTeamEntry).mockImplementation(async (home, expected, update) => {
      if (!failed && update && 'launch_pending' in update && update.launch_pending === undefined
        && expected.launch_pending?.claim_completed) {
        failed = true;
        throw new Error('clear failed');
      }
      return compare(home, expected, update);
    });
    let reads = 0;
    vi.mocked(capturePane).mockImplementation(async () => ++reads <= 2 ? PERMISSION : IDLE);
    try {
      await expect(answerDialog(root, 'demo', 'worker1', '1', approval))
        .rejects.toThrow('clear failed');
      const pending = (await readTeam(home)).agents.find((agent) => agent.name === 'worker1')!;
      expect(pending.launch_pending).toMatchObject({ pickup_typed: true, claim_completed: true });
      expect(pending.launch_pending?.resume_token).toBeUndefined();
      expect(pending.lease_revoked).toBe(false);
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
      await answerDialog(root, 'demo', 'worker1', '1', approval);
      expect(vi.mocked(completeTmuxLaunch)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(sendLiteral).mock.calls.filter((call) => call[1].startsWith('You are worker1'))).toHaveLength(1);
      expect((await readTeam(home)).agents.find((agent) => agent.name === 'worker1')?.launch_pending).toBeUndefined();
    } finally {
      vi.mocked(compareAndSwapTeamEntry).mockImplementation(compare);
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('claims resume atomically before the first pickup so concurrent answers cannot inject twice', async () => {
    const { root, home, worker, approval } = await pendingLaunch();
    const screens = [PERMISSION, PERMISSION, IDLE, IDLE, IDLE, IDLE, IDLE, PERMISSION, IDLE];
    vi.mocked(capturePane).mockImplementation(async () => screens.shift() ?? IDLE);
    let pickups = 0;
    let entered!: () => void;
    let release!: () => void;
    const enteredPickup = new Promise<void>((resolve) => { entered = resolve; });
    const releasePickup = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(sendLiteral).mockImplementation(async (_pane, text) => {
      if (!text.startsWith('You are worker1')) return;
      pickups += 1;
      if (pickups === 1) {
        entered();
        await releasePickup;
      }
    });
    const first = answerDialog(root, 'demo', 'worker1', '1', approval);
    try {
      await enteredPickup;
      const claimed = (await readTeam(home)).agents.find((agent) => agent.name === 'worker1')!;
      expect(claimed.launch_pending?.resume_token).toEqual(expect.any(String));
      await expect(answerDialog(root, 'demo', 'worker1', '1', approval))
        .rejects.toThrow(/resuming|changed/);
      release();
      await first;
      expect(pickups).toBe(1);
      expect((await readTeam(home)).agents.find((agent) => agent.name === 'worker1')?.launch_pending).toBeUndefined();
    } finally {
      release();
      await first.catch(() => {});
      vi.mocked(sendLiteral).mockImplementation(async () => {});
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('releases a non-idle resume for a same-answer retry without duplicate pickup', async () => {
    const { root, home, approval } = await pendingLaunch();
    const screens = [PERMISSION, PERMISSION];
    let retry = false;
    vi.mocked(capturePane).mockImplementation(async () => retry ? IDLE : screens.shift() ?? 'starting');
    vi.mocked(sendLiteral).mockClear();
    vi.mocked(killWindow).mockClear();
    try {
      await expect(answerDialog(root, 'demo', 'worker1', '1', approval)).rejects.toThrow(/not idle/);
      const pending = (await readTeam(home)).agents.find((agent) => agent.name === 'worker1')!;
      expect(pending.launch_pending?.resume_token).toBeUndefined();
      expect(pending.launch_pending?.pickup_typed).toBeUndefined();
      expect(vi.mocked(killWindow)).not.toHaveBeenCalled();
      retry = true;
      await answerDialog(root, 'demo', 'worker1', '1', approval);
      expect(vi.mocked(sendLiteral).mock.calls.filter((call) => call[1].startsWith('You are worker1'))).toHaveLength(1);
      expect((await readTeam(home)).agents.find((agent) => agent.name === 'worker1')?.launch_pending).toBeUndefined();
    } finally {
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('rejects an approval replayed after the lease changes', async () => {
    const { root, home, worker, approval } = await pendingLaunch();
    expect(approval).not.toBe(worker.launch_pending!.fingerprint);
    await writeJson(hivePath(home, 'team.json'), {
      agents: (await readTeam(home)).agents.map((agent) => agent.name === 'worker1'
        ? { ...agent, lease_id: 'replacement-lease', launch_pending: { ...agent.launch_pending!, lease_id: 'replacement-lease' } }
        : agent),
    });
    vi.mocked(capturePane).mockImplementation(async () => PERMISSION);
    vi.mocked(sendLiteral).mockClear();
    try {
      await expect(answerDialog(root, 'demo', 'worker1', '1', approval)).rejects.toThrow(/changed|approval|pending/);
      expect(vi.mocked(sendLiteral)).not.toHaveBeenCalled();
    } finally {
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('stops before Enter when the menu changes after selection', async () => {
    const { root, home } = await setup({ name: 'builder' });
    const id = await hubTask(root, 'demo', 'do it');
    await approvePlan(root, id);
    const worktree = path.join(home, 'lane');
    await fs.mkdir(worktree, { recursive: true });
    const menu = trustAt(worktree, true);
    let screen = menu;
    vi.mocked(capturePane).mockImplementation(async () => screen);
    await spawn(root, { agent: 'worker1', task: id, worktree: 'lane' });
    const approval = redactDialog((await readDialogFor(root, 'demo', 'worker1'))!).fingerprint;
    vi.mocked(sendArrow).mockImplementation(async () => { screen = menu.replace('Trust this folder?', 'Trust this folder NOW?'); });
    vi.mocked(sendEnter).mockClear();
    vi.mocked(sendLiteral).mockClear();
    try {
      await expect(answerDialog(root, 'demo', 'worker1', '2', approval)).rejects.toThrow(/changed/);
      expect(vi.mocked(sendEnter)).not.toHaveBeenCalled();
      expect(vi.mocked(sendLiteral).mock.calls.filter((call) => call[1].startsWith('You are worker1'))).toHaveLength(0);
      expect((await readTeam(home)).agents.find((agent) => agent.name === 'worker1')?.launch_pending).toBeDefined();
    } finally {
      vi.mocked(sendArrow).mockImplementation(async () => {});
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('refuses a stale ordinary worker before sending any key', async () => {
    const { root, home } = await setup({ name: 'builder', pane: '%1', pane_pid: 111, pane_started: 'earlier' });
    vi.mocked(capturePane).mockImplementation(async () => PERMISSION);
    const dialog = (await readDialogFor(root, 'demo', 'builder'))!;
    expect(redactDialog(dialog).fingerprint).toBe(dialog.fingerprint);
    vi.mocked(paneIs).mockResolvedValue(false);
    vi.mocked(sendLiteral).mockClear();
    try {
      await expect(answerDialog(root, 'demo', 'builder', '1', dialog.fingerprint)).rejects.toThrow(/identity|no longer/);
      expect(vi.mocked(sendLiteral)).not.toHaveBeenCalled();
    } finally {
      vi.mocked(paneIs).mockResolvedValue(true);
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
    expect(home).toBeTruthy();
  }, 20_000);

  async function orphanedLaunch(stage: 'wait' | 'session', pickupTyped: boolean) {
    const pending = await pendingLaunch();
    await writeJson(hivePath(pending.home, 'team.json'), {
      agents: (await readTeam(pending.home)).agents.map((agent) => agent.name === 'worker1'
        ? {
          ...agent,
          launch_pending: {
            ...agent.launch_pending!, resume_token: 'orphaned-owner', resume_pid: process.pid,
            resume_started: 'dead-owner', pickup_started: stage !== 'wait', pickup_typed: pickupTyped,
            answer_choice: '1', answer_option: 'Approve once', approved: true, dialog_delivered: true,
          },
        }
        : agent),
    });
    vi.mocked(sendLiteral).mockClear();
    vi.mocked(capturePane).mockImplementation(async () => IDLE);
    return pending;
  }

  it('reclaims an orphaned token before pickup', async () => {
    const { root, home, approval } = await orphanedLaunch('wait', false);
    await answerDialog(root, 'demo', 'worker1', '1', approval);
    expect(vi.mocked(sendLiteral).mock.calls.filter((call) => call[1].startsWith('You are worker1'))).toHaveLength(1);
    expect((await readTeam(home)).agents.find((agent) => agent.name === 'worker1')?.launch_pending).toBeUndefined();
  }, 20_000);

  it('reclaims an orphaned token after pickup without repeating it', async () => {
    const { root, home, approval } = await orphanedLaunch('session', true);
    await answerDialog(root, 'demo', 'worker1', '1', approval);
    expect(vi.mocked(sendLiteral).mock.calls.filter((call) => call[1].startsWith('You are worker1'))).toHaveLength(0);
    expect((await readTeam(home)).agents.find((agent) => agent.name === 'worker1')?.launch_pending).toBeUndefined();
  }, 20_000);

  it('reconciles a token left behind when releaseResume itself fails', async () => {
    const { root, home, approval } = await pendingLaunch();
    vi.mocked(completeTmuxLaunch).mockClear();
    vi.mocked(sendLiteral).mockClear();
    const compare = vi.mocked(compareAndSwapTeamEntry).getMockImplementation()!;
    let clearFailed = false;
    let releaseFailed = false;
    vi.mocked(compareAndSwapTeamEntry).mockImplementation(async (home, expected, update) => {
      if (!clearFailed && update && 'launch_pending' in update && update.launch_pending === undefined
        && expected.launch_pending?.claim_completed) {
        clearFailed = true;
        throw new Error('clear failed');
      }
      if (!releaseFailed && update && expected.launch_pending?.resume_token && update.launch_pending?.resume_token === undefined) {
        releaseFailed = true;
        throw new Error('release failed');
      }
      return compare(home, expected, update);
    });
    let reads = 0;
    vi.mocked(capturePane).mockImplementation(async () => ++reads <= 2 ? PERMISSION : IDLE);
    try {
      await expect(answerDialog(root, 'demo', 'worker1', '1', approval)).rejects.toThrow('release failed');
      expect((await readTeam(home)).agents.find((agent) => agent.name === 'worker1')?.launch_pending?.resume_token)
        .toEqual(expect.any(String));
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
      await answerDialog(root, 'demo', 'worker1', '1', approval);
      expect(vi.mocked(completeTmuxLaunch)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(sendLiteral).mock.calls.filter((call) => call[1].startsWith('You are worker1'))).toHaveLength(1);
      expect((await readTeam(home)).agents.find((agent) => agent.name === 'worker1')?.launch_pending).toBeUndefined();
    } finally {
      vi.mocked(compareAndSwapTeamEntry).mockImplementation(compare);
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('reports rollback failure with the original error primary when the replacement is missing', async () => {
    const { root, home } = await pendingPlainLaunch();
    vi.mocked(newWindow).mockImplementationOnce(async () => {
      await writeJson(hivePath(home, 'team.json'), { agents: [] });
      throw new Error('replacement missing');
    });
    const error = await respawnAgent(root, 'demo', 'worker1').catch((cause: unknown) => cause as AggregateError) as AggregateError;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.message).toBe('replacement missing');
    expect(error.errors[0].message).toBe('replacement missing');
    expect(error.errors[1].message).toMatch(/rollback/);
  }, 20_000);

  it('reports rollback failure with the original error primary when rollback CAS fails', async () => {
    const { root, home } = await pendingPlainLaunch();
    const compare = vi.mocked(compareAndSwapTeamEntry).getMockImplementation()!;
    let failed = false;
    vi.mocked(compareAndSwapTeamEntry).mockImplementation(async (home, expected, update) => {
      if (!failed && update && update.launch_error?.includes('replacement CAS failed')) {
        failed = true;
        return undefined;
      }
      return compare(home, expected, update);
    });
    vi.mocked(capturePane).mockImplementation(async () => IDLE);
    vi.mocked(sendLiteral).mockImplementation(async (_pane, text) => {
      if (text.startsWith('You are worker1')) throw new Error('replacement CAS failed');
    });
    try {
      const error = await respawnAgent(root, 'demo', 'worker1').catch((cause: unknown) => cause as AggregateError) as AggregateError;
      expect(error).toBeInstanceOf(AggregateError);
      expect(error.message).toBe('replacement CAS failed');
      expect(error.errors[0].message).toBe('replacement CAS failed');
      expect(error.errors[1].message).toMatch(/rollback CAS failed/);
      expect(vi.mocked(killWindow)).toHaveBeenCalledWith('%9', { pid: 4242, started: 'later' });
      expect(home).toBeTruthy();
    } finally {
      vi.mocked(compareAndSwapTeamEntry).mockImplementation(compare);
      vi.mocked(sendLiteral).mockImplementation(async () => {});
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('leaves a terminal record when a non-task pending replacement fails after old-state release', async () => {
    const { root, home } = await setup({ name: 'builder' });
    vi.mocked(capturePane).mockImplementation(async () => PERMISSION);
    await spawn(root, { agent: 'worker1' });
    const worker = (await readTeam(home)).agents.find((agent) => agent.name === 'worker1')!;
    vi.mocked(newWindow).mockRejectedValueOnce(new Error('replacement failed'));
    vi.mocked(capturePane).mockImplementation(async () => IDLE);
    await expect(respawnAgent(root, 'demo', 'worker1')).rejects.toThrow('replacement failed');
    const failed = (await readTeam(home)).agents.find((agent) => agent.name === 'worker1')!;
    expect(failed.closed_at).toEqual(expect.any(String));
    expect(failed.launch_error).toContain('replacement failed');
    expect(await fs.stat(path.join(root, worker.launch_claim_path!)).catch(() => null)).toBeNull();
  }, 20_000);

  it('records launch_failed when non-task replacement input fails after registration', async () => {
    const { root, home } = await setup({ name: 'builder' });
    vi.mocked(capturePane).mockImplementation(async () => PERMISSION);
    await spawn(root, { agent: 'worker1' });
    const worker = (await readTeam(home)).agents.find((agent) => agent.name === 'worker1')!;
    vi.mocked(capturePane).mockImplementation(async () => IDLE);
    vi.mocked(sendLiteral).mockImplementation(async (_pane, text) => {
      if (text.startsWith('You are worker1')) throw new Error('replacement input failed');
    });
    try {
      await expect(respawnAgent(root, 'demo', 'worker1')).rejects.toThrow('replacement input failed');
      const failed = (await readTeam(home)).agents.find((agent) => agent.name === 'worker1')!;
      expect(failed).toMatchObject({ pane: '%9', admission_status: 'launch_failed' });
      expect(failed.launch_error).toContain('replacement input failed');
      expect(failed.closed_at).toEqual(expect.any(String));
      expect(vi.mocked(killWindow)).toHaveBeenCalledWith('%9', { pid: 4242, started: 'later' });
      expect(await fs.stat(path.join(root, worker.launch_claim_path!)).catch(() => null)).toBeNull();
    } finally {
      vi.mocked(sendLiteral).mockImplementation(async () => {});
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('cascade releases pending claims before project deletion', async () => {
    const { root, home, worker } = await pendingLaunch();
    await closeAgent(root, 'demo', 'builder');
    await writeJson(hivePath(home, 'team.json'), {
      agents: (await readTeam(home)).agents.map((agent) => agent.name === 'worker1'
        ? { ...agent, parent: 'demo-orchestrator' } : agent),
    });
    await killAgent(root, 'demo');
    expect(await fs.stat(path.join(root, worker.launch_claim_path!)).catch(() => null)).toBeNull();
    await expect(removeProject(root, 'demo')).resolves.toEqual({ ok: true, name: 'demo' });
  }, 20_000);

  it('uses raw dialog text for a declared SHA push and exact secret-bearing command digest', async () => {
    const { root, home } = await setup({ name: 'builder' });
    const secret = 'sk-rawcommandsecret';
    const command = `git push origin ${'a'.repeat(40)}:refs/heads/${secret}`;
    const output = 'Return the named artifact and its verification evidence to the orchestrator.';
    const contract = { ...taskContract(home, [], output), action_scope: [`command:${valueDigest(command)}`] };
    const id = await hubTask(root, 'demo', 'do it');
    await approveContract(root, id, contract);
    const dialog = PERMISSION.replace('   $ echo hive-calibration', `   $ ${command}`);
    vi.mocked(capturePane).mockImplementation(async () => dialog);
    await spawn(root, { agent: 'worker1', task: id });
    const raw = (await readDialogFor(root, 'demo', 'worker1'))!;
    expect(raw.text).toContain(command);
    expect(redactDialog(raw).text).not.toContain(secret);
    await setProjectMode(root, 'demo', 'auto');
    let answered = false;
    vi.mocked(capturePane).mockImplementation(async () => answered ? IDLE : dialog);
    vi.mocked(sendLiteral).mockImplementation(async (_pane, text) => {
      if (text === '1') answered = true;
    });
    try {
      await watchCycle(root, {}, new Set(), new Map(), new Map(), { verdicts: new Map(), marks: new Set() });
      expect((await readTeam(home)).agents.find((agent) => agent.name === 'worker1')?.launch_pending).toBeUndefined();
    } finally {
      vi.mocked(sendLiteral).mockImplementation(async () => {});
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);

  it('still kills the pane, forgets the workspace, and deletes the claim on timeout', async () => {
    const { root, home } = await setup({ name: 'builder' });
    vi.mocked(capturePane).mockImplementation(async () => IDLE);
    const id = await hubTask(root, 'demo', 'do it');
    await approvePlan(root, id);
    const worktree = hivePath(home, 'lanes', 'worker1');
    const kills = vi.mocked(killWindow).mock.calls.length;
    vi.mocked(capturePane).mockImplementation(async () => 'starting');
    try {
      await expect(spawn(root, { agent: 'worker1', task: id })).rejects.toThrow(/never went idle/);
      const worker = (await readTeam(home)).agents.find((agent) => agent.name === 'worker1')!;
      expect(worker).toMatchObject({ admission_status: 'launch_failed', lease_revoked: true });
      expect(worker.launch_pending).toBeUndefined();
      expect(vi.mocked(killWindow).mock.calls.slice(kills)).toContainEqual(['%9', { pid: 4242, started: 'later' }]);
      expect(await fs.stat(worktree).catch(() => null)).toBeNull();
      expect(await fs.stat(path.join(root, worker.launch_claim_path!)).catch(() => null)).toBeNull();
      expect(vi.mocked(run).mock.calls.some((call) => call[0] === 'jj' && call[1].includes('forget'))).toBe(true);
    } finally {
      vi.mocked(capturePane).mockImplementation(async () => IDLE);
    }
  }, 20_000);
});
