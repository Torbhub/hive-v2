import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.HIVE_TMUX_SOCKET = `hive-test-${process.pid}`;

vi.mock('../src/tmux.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/tmux.js')>();
  return {
    ...orig,
    run: vi.fn(orig.run),
    paneExists: vi.fn(async () => true),
    paneIs: vi.fn(async () => true),
    killWindow: vi.fn(async () => {}),
  };
});

import { cleanupProject } from '../src/cleanup.js';
import { killAgent } from '../src/kill.js';
import { removeProject } from '../src/project.js';
import { hivePath, manifestAdd, manifestRead, manifestUpdate, readTeam, writeJson, hubPath } from '../src/state.js';
import * as tmux from '../src/tmux.js';
import { killWindow, processStartTime, run } from '../src/tmux.js';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.mocked(run).mockImplementation(actualRun);
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

type LaneKind = 'worktree' | 'jj-workspace';

const actualRun = vi.mocked(run).getMockImplementation()!;

function publishBranch(home: string, branch: string): void {
  const remote = `${home}-remote.git`;
  git(['init', '-q', '--bare', remote], home);
  git(['remote', 'add', 'origin', remote], home);
  git(['push', '-q', '-u', 'origin', branch], home);
}

function mockJjWorkspace(wt: string, scenario = 'clean'): void {
  let forgotten = false;
  vi.mocked(run).mockImplementation(async (command, args) => {
    if (args.includes('workspace') && args.includes('list')) {
      return { code: 0, stdout: forgotten ? '' : `${path.basename(wt)}\t${wt}\n`, stderr: '' };
    }
    if (args.includes('workspace') && args.includes('forget')) {
      forgotten = true;
      return { code: 0, stdout: '', stderr: '' };
    }
    if (scenario === 'failed-probe' || scenario === 'ambiguous' || scenario === 'unborn') {
      return { code: 1, stdout: '', stderr: scenario };
    }
    if (scenario === 'no-remote' && (args.includes('log') || args.includes('remote'))) {
      return { code: 1, stdout: '', stderr: 'no remote bookmark' };
    }
    if (scenario === 'unpublished' && args.includes('log')) {
      return { code: 0, stdout: 'local-only-change\n', stderr: '' };
    }
    if ((args.includes('status') || args.includes('diff')) && (scenario === 'dirty' || scenario === 'untracked')) {
      return { code: 0, stdout: scenario === 'dirty' ? 'M tracked.txt\n' : '?? new.txt\n', stderr: '' };
    }
    if (command === 'jj' && args.includes('--no-graph')) {
      return { code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
    }
    if (command === 'git' && args.includes('rev-parse')) {
      return { code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
    }
    if (command === 'git' && args.includes('remote')) {
      return { code: 0, stdout: 'origin\n', stderr: '' };
    }
    if (command === 'git' && args.includes('ls-remote')) {
      return { code: 0, stdout: `${'a'.repeat(40)}\trefs/heads/main\n`, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  });
}

async function setupLane(kind: LaneKind, published = true) {
  const { root, home } = await setup();
  const name = kind === 'worktree' ? 'wt-agent' : 'lane-agent';
  const wt = path.join(home, name);
  const branch = `proj/${name}`;
  if (kind === 'worktree') {
    await fs.writeFile(path.join(home, 'tracked.txt'), 'base');
    git(['add', 'tracked.txt'], home);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base'], home);
    git(['worktree', 'add', '-q', '-b', branch, wt, 'HEAD'], home);
    if (published) publishBranch(home, branch);
  } else {
    await fs.mkdir(wt);
    await fs.writeFile(path.join(wt, 'tracked.txt'), 'base');
    mockJjWorkspace(wt);
  }
  const record = { kind, at: new Date().toISOString(), path: wt, branch };
  await manifestAdd(home, record);
  return { root, home, wt, branch, record };
}

function mockFailedGitProbe(wt: string, scenario: string): void {
  vi.mocked(run).mockImplementation(async (command, args, cwd, env, timeout) => {
    if (args[0] === 'worktree' && args[1] === 'list') {
      return { code: 0, stdout: `worktree ${wt}\n`, stderr: '' };
    }
    if (scenario === 'unborn') return { code: 128, stdout: '', stderr: 'unborn HEAD' };
    return { code: 1, stdout: '', stderr: scenario };
  });
}

function mockFailedDeregistration(kind: LaneKind, wt: string): void {
  const previous = vi.mocked(run).getMockImplementation()!;
  vi.mocked(run).mockImplementation(async (command, args, cwd, env, timeout) => {
    if (kind === 'worktree' && args[0] === 'worktree' && args[1] === 'prune') {
      return { code: 9, stdout: '', stderr: 'worktree prune failed' };
    }
    if (kind === 'jj-workspace' && args.includes('workspace') && args.includes('forget')) {
      return { code: 9, stdout: '', stderr: 'workspace forget failed' };
    }
    return previous(command, args, cwd, env, timeout);
  });
}

async function expectRetainedLane(home: string, wt: string, action: string): Promise<void> {
  expect(action).toMatch(/left|refus|blocked|retain|failed/i);
  expect(await fs.lstat(wt)).toBeTruthy();
  expect(await manifestRead(home)).toEqual([expect.objectContaining({ path: wt })]);
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
    publishBranch(home, 'proj/agent');
    await manifestAdd(home, { kind: 'worktree', at: new Date().toISOString(), path: wt, branch: 'proj/agent' });

    const actions = await cleanupProject(root, 'proj');
    expect(actions).toHaveLength(1);
    expect(actions[0].acted).toBe(true);
    expect(actions[0].action).toMatch(/trash worktree/);
    expect(await fs.stat(wt).catch(() => null)).toBeNull();
    const trashed = path.join(hivePath(home, 'trash'), new Date().toISOString().slice(0, 10), 'wt-agent');
    expect(await fs.stat(trashed)).toBeTruthy();
    expect(await manifestRead(home)).toEqual([expect.objectContaining({
      path: wt, quarantine_path: trashed, quarantined_at: expect.any(String),
      quarantine_expires_at: expect.any(String), quarantine_files: expect.any(Array),
    })]);
  });

  it('retains a locked renamed worktree until prune really deregisters it', async () => {
    const { root, home, wt } = await setupLane('worktree');
    const retained = path.join(home, 'retained-worktree');
    await fs.writeFile(path.join(wt, 'keep.txt'), 'precious');
    git(['worktree', 'lock', wt], home);
    const before = await manifestRead(home);
    await fs.rename(wt, retained);

    const failed = await cleanupProject(root, 'proj');

    expect(failed).toEqual([expect.objectContaining({ acted: false })]);
    expect(failed[0].action).toMatch(/registered|prune|failed|retry/i);
    expect(await manifestRead(home)).toEqual(before);
    expect(await fs.readFile(path.join(retained, 'keep.txt'), 'utf8')).toBe('precious');

    git(['worktree', 'unlock', wt], home);
    await cleanupProject(root, 'proj');
    expect(await manifestRead(home)).toEqual([]);
    expect(await fs.readFile(path.join(retained, 'keep.txt'), 'utf8')).toBe('precious');
  });
});

describe('cleanupProject jj-workspace records', () => {
  it('drops a pathless record without trying to deregister it', async () => {
    const { root, home } = await setup();
    await manifestAdd(home, { kind: 'jj-workspace', at: new Date().toISOString(), path: undefined });

    const actions = await cleanupProject(root, 'proj');

    expect(actions).toEqual([]);
    expect(await manifestRead(home)).toEqual([]);
    expect(vi.mocked(run).mock.calls.some((call) => call[1].includes('forget'))).toBe(false);
  });

  it('trashes a workspace jj lists and forgets it', async () => {
    const { root, home } = await setup();
    const wt = path.join(home, 'lane-agent');
    await fs.mkdir(wt);
    await manifestAdd(home, { kind: 'jj-workspace', at: new Date().toISOString(), path: wt });
    mockJjWorkspace(wt);

    const actions = await cleanupProject(root, 'proj');
    expect(actions).toHaveLength(1);
    expect(actions[0].acted).toBe(true);
    expect(actions[0].action).toMatch(/trash jj workspace/);
    expect(await fs.stat(wt).catch(() => null)).toBeNull();
    const trashed = path.join(hivePath(home, 'trash'), new Date().toISOString().slice(0, 10), 'lane-agent');
    expect(await fs.stat(trashed)).toBeTruthy();
    expect(vi.mocked(run).mock.calls.map((c) => c[1])).toContainEqual(
      ['-R', home, 'workspace', 'forget', 'lane-agent'],
    );
    expect(await manifestRead(home)).toEqual([expect.objectContaining({
      path: wt, quarantine_path: trashed, quarantined_at: expect.any(String),
      quarantine_expires_at: expect.any(String), quarantine_files: expect.any(Array),
    })]);
  });

  it('leaves a path alone that jj does not list as a workspace', async () => {
    const { root, home } = await setup();
    const plain = path.join(home, 'just-a-dir');
    await fs.mkdir(plain);
    await manifestAdd(home, { kind: 'jj-workspace', at: new Date().toISOString(), path: plain });
    vi.mocked(run).mockImplementationOnce(async () => ({ code: 0, stdout: '', stderr: '' }));

    const actions = await cleanupProject(root, 'proj');
    expect(actions[0].acted).toBe(false);
    expect(actions[0].action).toMatch(/left jj workspace/);
    expect(await fs.stat(plain)).toBeTruthy();
    expect(vi.mocked(run).mock.calls.some((c) => c[1].includes('forget'))).toBe(false);
  });
});

describe.each([{ kind: 'worktree' as const }, { kind: 'jj-workspace' as const }])(
  'cleanupProject $kind safety and recovery',
  ({ kind }) => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it.each(['dirty', 'untracked', 'unpublished', 'failed-probe', 'ambiguous', 'live/shared-referenced'])(
      'retains a %s lane without moving it',
      async (scenario) => {
        const { root, home, wt } = await setupLane(kind);
        if (scenario === 'dirty') await fs.writeFile(path.join(wt, 'tracked.txt'), 'dirty');
        if (scenario === 'untracked') await fs.writeFile(path.join(wt, 'new.txt'), 'new');
        if (scenario === 'unpublished' && kind === 'worktree') {
          await fs.writeFile(path.join(wt, 'tracked.txt'), 'local only');
          git(['add', 'tracked.txt'], wt);
          git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'local only'], wt);
        }
        if (kind === 'jj-workspace' && ['dirty', 'untracked', 'unpublished'].includes(scenario)) {
          mockJjWorkspace(wt, scenario);
        }
        if (scenario === 'failed-probe' || scenario === 'ambiguous') {
          if (kind === 'worktree') mockFailedGitProbe(wt, scenario);
          else mockJjWorkspace(wt, scenario);
        }
        if (scenario === 'live/shared-referenced') {
          await writeJson(hivePath(home, 'team.json'), {
            agents: [{ name: 'builder', worktree: wt }, { name: 'reviewer', worktree: wt }],
          });
        }

        const actions = await cleanupProject(root, 'proj');
        expect(actions).toHaveLength(1);
        expect(actions[0].acted).toBe(false);
        await expectRetainedLane(home, wt, actions[0].action);
      },
    );

    it.each(['no-remote', 'unborn'])('reports an actionable %s blocker', async (scenario) => {
      const { root, home, wt } = await setupLane(kind, scenario === 'unborn');
      if (kind === 'worktree') {
        if (scenario === 'unborn') mockFailedGitProbe(wt, scenario);
      } else {
        mockJjWorkspace(wt, scenario);
      }

      const actions = await cleanupProject(root, 'proj');
      expect(actions).toHaveLength(1);
      expect(actions[0].acted).toBe(false);
      expect(actions[0].action).toMatch(scenario === 'no-remote'
        ? /no remote|unpublished|publish/i
        : /unborn|initial commit/i);
      await expectRetainedLane(home, wt, actions[0].action);
    });

    it('quarantines an explicitly registered external lane recoverably', async () => {
      const { root, home } = await setup();
      const wt = path.join(root, `external-${kind}`);
      const branch = 'proj/external';
      if (kind === 'worktree') {
        git(['worktree', 'add', '-q', '-b', branch, wt, 'HEAD'], home);
        publishBranch(home, branch);
      } else {
        await fs.mkdir(wt);
        mockJjWorkspace(wt);
      }
      await manifestAdd(home, { kind, at: new Date().toISOString(), path: wt, branch });

      const actions = await cleanupProject(root, 'proj');
      const dest = path.join(hivePath(home, 'trash'), new Date().toISOString().slice(0, 10), path.basename(wt));
      expect(actions).toEqual([expect.objectContaining({ acted: true })]);
      expect(actions[0].action).toContain(`${wt} -> ${dest}`);
      expect(await fs.stat(wt).catch(() => null)).toBeNull();
      expect(await fs.stat(dest)).toBeTruthy();
      expect(await manifestRead(home)).toEqual([expect.objectContaining({ path: wt, quarantine_path: dest })]);
    });

    it('reports failed deregistration after quarantine and retains retry metadata', async () => {
      const { root, home, wt } = await setupLane(kind);
      mockFailedDeregistration(kind, wt);
      const dest = path.join(hivePath(home, 'trash'), new Date().toISOString().slice(0, 10), path.basename(wt));

      const actions = await cleanupProject(root, 'proj');
      expect(actions).toHaveLength(1);
      expect(actions[0].acted).toBe(false);
      expect(actions[0].action).toMatch(/failed|retry|deregister/i);
      expect(actions[0].action).toContain(wt);
      expect(actions[0].action).toContain(dest);
      expect(await fs.stat(wt).catch(() => null)).toBeNull();
      expect(await fs.stat(dest)).toBeTruthy();
      expect(await manifestRead(home)).toEqual([expect.objectContaining({ path: wt, quarantine_path: dest })]);
    });

    it('retains a missing lane record when deregistration fails', async () => {
      const { root, home, wt } = await setupLane(kind);
      const retained = path.join(home, `retained-${kind}`);
      await fs.rename(wt, retained);
      mockFailedDeregistration(kind, wt);

      const actions = await cleanupProject(root, 'proj');

      expect(actions).toEqual([expect.objectContaining({ acted: false })]);
      expect(actions[0].action).toMatch(/failed|retry|deregister/i);
      expect(await manifestRead(home)).toEqual([expect.objectContaining({ path: wt })]);
      expect(await fs.stat(retained)).toBeTruthy();
    });

    it('refuses a destination collision without disturbing either path', async () => {
      const { root, home, wt } = await setupLane(kind);
      const dest = path.join(hivePath(home, 'trash'), new Date().toISOString().slice(0, 10), path.basename(wt));
      await fs.mkdir(dest, { recursive: true });
      await fs.writeFile(path.join(dest, 'keep.txt'), 'existing quarantine');

      const actions = await cleanupProject(root, 'proj');
      expect(actions[0].acted).toBe(false);
      expect(actions[0].action).toMatch(/collision|exists|retain/i);
      expect(actions[0].action).toContain(dest);
      expect(await fs.readFile(path.join(dest, 'keep.txt'), 'utf8')).toBe('existing quarantine');
      await expectRetainedLane(home, wt, actions[0].action);
    });

    it('refuses a symlink replacement and preserves its target', async () => {
      const { root, home, wt } = await setupLane(kind);
      const target = path.join(root, 'replacement-target');
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, 'keep.txt'), 'precious');
      await fs.rm(wt, { recursive: true });
      await fs.symlink(target, wt, 'dir');

      const actions = await cleanupProject(root, 'proj');
      expect(actions[0].acted).toBe(false);
      expect(actions[0].action).toMatch(/symlink|replacement|identity/i);
      expect((await fs.lstat(wt)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(path.join(target, 'keep.txt'), 'utf8')).toBe('precious');
      await expectRetainedLane(home, wt, actions[0].action);
    });

    it('reports a rename failure and leaves the source recoverable', async () => {
      const { root, home, wt } = await setupLane(kind);
      const rename = fs.rename;
      vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
        if (String(oldPath) === wt) throw Object.assign(new Error('rename failed'), { code: 'EIO' });
        return rename(oldPath, newPath);
      });

      const actions = await cleanupProject(root, 'proj');
      expect(actions[0].acted).toBe(false);
      expect(actions[0].action).toMatch(/rename failed|quarantine failed|retain/i);
      await expectRetainedLane(home, wt, actions[0].action);
    });
  },
);

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

  it('revokes a tasked lease without clearing compaction or lineage', async () => {
    const { root, home } = await setupTmux();
    const compaction = { session_id: 'session_b', status: 'submitted' as const, at: '2026-11-20T00:00:00Z', attempts: 1 };
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{
        name: 'builder', task: 'demo-1', pane: '%1', pane_pid: 11, pane_started: 'a',
        lease_id: 'lease-1', lease_epoch: 1, lineage_id: 'lineage-1', attempts_used: 2, compaction,
      }],
    });
    await cleanupProject(root, 'proj');
    expect((await readTeam(home)).agents[0]).toMatchObject({
      lease_revoked: true, admission_status: 'revoked', lease_id: 'lease-1',
      lineage_id: 'lineage-1', attempts_used: 2, compaction,
    });
  });

  it('a dry run stamps nothing and kills nothing', async () => {
    const { root, home } = await setupTmux();
    const actions = await cleanupProject(root, 'proj', { dryRun: true });
    expect(actions[0].acted).toBe(false);
    expect(killWindow).not.toHaveBeenCalled();
    const team = await readTeam(home);
    expect(team.agents[0].closed_at).toBeUndefined();
  });

  it('unstamps only the failed target when the kill fails', async () => {
    const { root, home } = await setupTmux();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [
        { name: 'proj-orchestrator', orchestrator: true, pane: '%9', pane_pid: 99, pane_started: 'other' },
        { name: 'builder', pane: '%1', pane_pid: 11, pane_started: 'a' },
      ],
    });
    vi.mocked(killWindow).mockRejectedValueOnce(new Error('tmux down'));
    await expect(cleanupProject(root, 'proj')).rejects.toThrow('tmux down');
    const team = await readTeam(home);
    expect(team.agents[0].closed_at).toBeUndefined();
    expect(team.agents[1].closed_at).toBeUndefined();
  });

  it('releases a pending claim during cleanup so close and project deletion can finish', async () => {
    const { root, home } = await setupTmux();
    const claim = '.hive-hub/launches/proj:pending.json';
    await writeJson(hubPath(root, 'launches', 'proj:pending.json'), { project: 'proj' });
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{
        name: 'builder', pane: '%1', pane_pid: 11, pane_started: 'a', worktree: home,
        launch_pending: {
          at: new Date().toISOString(), agent: 'builder', pane: '%1', pane_pid: 11, pane_started: 'a',
          worktree: home, launch_claim_path: claim, launch_claim_digest: 'digest', dialog: 'dialog', fingerprint: 'fp',
        },
      }],
    });
    await cleanupProject(root, 'proj');
    expect(await fs.stat(path.join(root, claim)).catch(() => null)).toBeNull();
    await killAgent(root, 'proj', 'builder');
    await expect(removeProject(root, 'proj')).resolves.toEqual({ ok: true, name: 'proj' });
  });
});

describe('cleanupProject process records', () => {
  async function setupProcess() {
    const { root, home } = await setup();
    const record = {
      kind: 'process' as const,
      at: new Date().toISOString(),
      pid: process.pid,
      started: await processStartTime(process.pid),
    };
    await manifestAdd(home, record);
    return { root, home, record };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('removes the process record after SIGTERM and a verified exit', async () => {
    const { root, home, record } = await setupProcess();
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (signal === 0) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      return true;
    });
    vi.spyOn(tmux, 'processStartTime')
      .mockResolvedValueOnce(record.started as string)
      .mockResolvedValueOnce(null);

    const actions = await cleanupProject(root, 'proj');
    expect(actions).toEqual([{ record, action: `terminate process ${process.pid}`, acted: true }]);
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(process.pid, 0);
    expect(await fs.readFile(hivePath(home, 'manifest.jsonl'), 'utf8')).toBe('');
  });

  it('retains the process record when SIGTERM has no verified exit', async () => {
    const { root, home, record } = await setupProcess();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.spyOn(tmux, 'processStartTime').mockResolvedValue(record.started as string);

    const actions = await cleanupProject(root, 'proj');
    expect(actions).toEqual([expect.objectContaining({ record, acted: false })]);
    expect(actions[0].action).toMatch(/SIGTERM|exit|retain/i);
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(kill).not.toHaveBeenCalledWith(process.pid, 'SIGKILL');
    expect(await manifestRead(home)).toEqual([record]);
  });

  it('retains a failed post-SIGTERM probe until a later probe proves absence', async () => {
    const { root, home, record } = await setupProcess();
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (signal === 0) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      return true;
    });
    vi.spyOn(tmux, 'processStartTime')
      .mockResolvedValueOnce(record.started as string)
      .mockRejectedValueOnce(new Error('process probe failed'))
      .mockResolvedValueOnce(null);

    const actions = await cleanupProject(root, 'proj');
    expect(actions).toEqual([expect.objectContaining({ record, acted: false })]);
    expect(actions[0].action).toMatch(/probe|exit|retain/i);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(await manifestRead(home)).toEqual([record]);

    await cleanupProject(root, 'proj');
    expect(await manifestRead(home)).toEqual([]);
  });

  it('retains null process identity after SIGTERM when liveness still succeeds', async () => {
    const { root, home, record } = await setupProcess();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.spyOn(tmux, 'processStartTime')
      .mockResolvedValueOnce(record.started as string)
      .mockResolvedValueOnce(null);

    const actions = await cleanupProject(root, 'proj');
    expect(actions).toEqual([expect.objectContaining({ record, acted: false })]);
    expect(actions[0].action).toMatch(/probe|exit|retain/i);
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(process.pid, 0);
    expect(await manifestRead(home)).toEqual([record]);
  });

  it('never signals a reused PID, including with SIGKILL', async () => {
    const { root, home } = await setup();
    await manifestAdd(home, {
      kind: 'process', at: new Date().toISOString(), pid: process.pid, started: 'original-process',
    });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    vi.spyOn(tmux, 'processStartTime').mockResolvedValue('replacement-process');

    await cleanupProject(root, 'proj');
    expect(kill).not.toHaveBeenCalled();
  });

  it('removes the process record when SIGTERM reports ESRCH', async () => {
    const { root, home, record } = await setupProcess();
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });

    const actions = await cleanupProject(root, 'proj');
    expect(actions).toEqual([{ record, action: `terminate process ${process.pid}`, acted: true }]);
    expect(await fs.readFile(hivePath(home, 'manifest.jsonl'), 'utf8')).toBe('');
  });

  it('surfaces EPERM and preserves the process record', async () => {
    const { root, home, record } = await setupProcess();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });

    await expect(cleanupProject(root, 'proj')).rejects.toMatchObject({ code: 'EPERM' });
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    expect(await fs.readFile(hivePath(home, 'manifest.jsonl'), 'utf8')).toBe(JSON.stringify(record) + '\n');
  });

  it('surfaces an unexpected SIGTERM error and preserves the process record', async () => {
    const { root, home, record } = await setupProcess();
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('signal failed'), { code: 'EIO' });
    });

    await expect(cleanupProject(root, 'proj')).rejects.toMatchObject({ code: 'EIO', message: 'signal failed' });
    expect(await fs.readFile(hivePath(home, 'manifest.jsonl'), 'utf8')).toBe(JSON.stringify(record) + '\n');
  });

  it('does not rewrite the manifest when SIGTERM fails', async () => {
    const { root, home } = await setupProcess();
    const manifestPath = hivePath(home, 'manifest.jsonl');
    const before = await fs.readFile(manifestPath, 'utf8');
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    });

    await expect(cleanupProject(root, 'proj')).rejects.toMatchObject({ code: 'EPERM' });
    expect(await fs.readFile(manifestPath, 'utf8')).toBe(before);
  });

  it('does not signal or rewrite the manifest during a dry run', async () => {
    const { root, home, record } = await setupProcess();
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const actions = await cleanupProject(root, 'proj', { dryRun: true });
    expect(actions).toEqual([{ record, action: `terminate process ${process.pid}`, acted: false }]);
    expect(kill).not.toHaveBeenCalled();
    expect(await fs.readFile(hivePath(home, 'manifest.jsonl'), 'utf8')).toBe(JSON.stringify(record) + '\n');
  });
});

function diskUsageKb(dir: string): number {
  return Number(execFileSync('du', ['-sk', dir], { encoding: 'utf8' }).split(/\s+/)[0]);
}

async function setupQuarantine(expiresAt = '2000-01-02T00:00:00.000Z') {
  const { root, home } = await setup();
  const source = path.join(home, 'wt-agent');
  const trash = hivePath(home, 'trash');
  const dest = path.join(trash, '2000-01-01', 'wt-agent');
  const payload = Buffer.alloc(256 * 1024, 7);
  await fs.mkdir(dest, { recursive: true });
  await fs.writeFile(path.join(dest, 'payload.bin'), payload);
  const record = {
    kind: 'worktree' as const,
    at: '2000-01-01T00:00:00.000Z',
    path: source,
    quarantine_path: dest,
    quarantined_at: '2000-01-01T00:00:00.000Z',
    quarantine_expires_at: expiresAt,
    quarantine_files: [{
      path: 'payload.bin',
      size: payload.length,
      sha256: createHash('sha256').update(payload).digest('hex'),
    }],
  };
  await manifestAdd(home, record);
  return { root, home, trash, source, dest, payload, record };
}

describe('cleanupProject trash reclamation', () => {
  it('is dry-run-first and owner-approved, then reclaims verified expired bytes', async () => {
    const { root, home, trash, dest, record } = await setupQuarantine();
    const historical = path.join(trash, '1999-01-01', 'historical');
    await fs.mkdir(historical, { recursive: true });
    await fs.writeFile(path.join(historical, 'keep.bin'), Buffer.alloc(64 * 1024, 3));
    const before = diskUsageKb(trash);

    const dryRun = await cleanupProject(root, 'proj', { dryRun: true, reclaimTrash: true, ownerApproved: true });
    expect(dryRun).toEqual([expect.objectContaining({ record, acted: false })]);
    expect(dryRun[0].action).toMatch(/reclaim|purge/i);
    expect(diskUsageKb(trash)).toBe(before);

    const unapproved = await cleanupProject(root, 'proj', { reclaimTrash: true });
    expect(unapproved).toEqual([expect.objectContaining({ record, acted: false })]);
    expect(unapproved[0].action).toMatch(/owner|approval/i);
    expect(diskUsageKb(trash)).toBe(before);

    const reclaimed = await cleanupProject(root, 'proj', { reclaimTrash: true, ownerApproved: true });
    expect(reclaimed).toEqual([expect.objectContaining({ record, acted: true })]);
    expect(diskUsageKb(trash)).toBeLessThanOrEqual(before - 256);
    expect(await fs.stat(dest).catch(() => null)).toBeNull();
    expect(await fs.stat(path.join(historical, 'keep.bin'))).toBeTruthy();
    expect(await manifestRead(home)).toEqual([]);
  });

  it.each(['sentinel', 'changed-content', 'unexpired'])('refuses reclamation with %s', async (scenario) => {
    const { root, home, dest, payload, record } = await setupQuarantine(
      scenario === 'unexpired' ? '2999-01-01T00:00:00.000Z' : undefined,
    );
    if (scenario === 'sentinel') await fs.writeFile(path.join(dest, 'added-after-quarantine.txt'), 'stop');
    if (scenario === 'changed-content') await fs.writeFile(path.join(dest, 'payload.bin'), Buffer.alloc(payload.length, 9));

    const actions = await cleanupProject(root, 'proj', { reclaimTrash: true, ownerApproved: true });
    expect(actions).toEqual([expect.objectContaining({ record, acted: false })]);
    expect(actions[0].action).toMatch(/sentinel|changed|ambiguous|identity|expiry|expired|retain/i);
    expect(await fs.stat(dest)).toBeTruthy();
    expect(await manifestRead(home)).toEqual([record]);
  });

  it('retains historical trash that has no verified quarantine record', async () => {
    const { root, home } = await setup();
    const historical = path.join(hivePath(home, 'trash'), '1999-01-01', 'historical', 'keep.txt');
    await fs.mkdir(path.dirname(historical), { recursive: true });
    await fs.writeFile(historical, 'unverified');

    const actions = await cleanupProject(root, 'proj', { reclaimTrash: true, ownerApproved: true });
    expect(actions.every((action) => !action.acted)).toBe(true);
    expect(await fs.readFile(historical, 'utf8')).toBe('unverified');
  });
});


function jj(args: string[], cwd: string): string {
  return execFileSync('jj', [
    '--no-pager', '--config', 'user.name=t', '--config', 'user.email=t', ...args,
  ], { cwd, encoding: 'utf8' });
}

async function setupRealJjWorkspace(name: string, destinationName: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'hive-clean-real-jj-'));
  const home = path.join(root, 'proj');
  await fs.mkdir(home, { recursive: true });
  jj(['git', 'init'], home);
  await fs.writeFile(path.join(home, 'published.txt'), 'published parent');
  jj(['commit', '-m', 'published parent'], home);
  jj(['bookmark', 'set', 'main', '-r', '@-'], home);
  const remote = path.join(root, 'remote.git');
  git(['init', '-q', '--bare', remote], root);
  jj(['git', 'remote', 'add', 'origin', remote], home);
  jj(['git', 'push', '--bookmark', 'main'], home);
  const wt = path.join(home, destinationName);
  jj(['workspace', 'add', '--name', name, '-r', 'main', wt], home);
  await writeJson(hubPath(root, 'projects.json'), {
    projects: [{ name: 'proj', home, repos: [{ folder: home }] }],
  });
  await manifestAdd(home, { kind: 'jj-workspace', at: new Date().toISOString(), path: wt });
  return { root, home, wt };
}

describe('cleanupProject confirmed reviewer regressions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('real JJ quarantines a clean empty working copy when its parent is published', async () => {
    const { root, home, wt } = await setupRealJjWorkspace('lane-agent', 'lane-agent');

    const actions = await cleanupProject(root, 'proj');
    expect(actions).toEqual([expect.objectContaining({ acted: true })]);
    expect(await fs.stat(wt).catch(() => null)).toBeNull();
    expect(await manifestRead(home)).toEqual([expect.objectContaining({
      path: wt, quarantine_deregistered: true,
    })]);
  });

  it('real JJ dry-run does not let a stale empty-root registration block a valid workspace', async () => {
    const { root, home, wt } = await setupRealJjWorkspace('lane-agent', 'lane-agent');
    const stale = path.join(home, 'stale-lane');
    jj(['workspace', 'add', '--name', 'stale-lane', '-r', 'main', stale], home);
    await fs.rename(stale, path.join(root, 'retained-stale'));
    expect(jj(['workspace', 'list', '-T', 'name ++ "\\t" ++ root ++ "\\n"'], home)).toContain('stale-lane\t');
    vi.mocked(run).mockImplementation(async (command, args, cwd, env, timeout) => {
      const result = await actualRun(command, args, cwd, env, timeout);
      if (command === 'jj' && args.includes('workspace') && args.includes('list')) {
        return { ...result, stdout: result.stdout.replace(`stale-lane\t${stale}\n`, 'stale-lane\t\n') };
      }
      return result;
    });

    const actions = await cleanupProject(root, 'proj', { dryRun: true });

    expect(actions).toEqual([expect.objectContaining({
      acted: false,
      action: expect.stringContaining(`trash jj workspace ${wt} ->`),
    })]);
    expect(await fs.stat(wt)).toBeTruthy();
    expect(jj(['workspace', 'list'], home)).toContain('stale-lane:');
    expect(await manifestRead(home)).toEqual([expect.objectContaining({ path: wt })]);
  });

  it('real JJ retains a post-rename deregistration failure for retry', async () => {
    const { root, home, wt } = await setupRealJjWorkspace('lane-agent', 'lane-agent');
    const trashed = path.join(hivePath(home, 'trash'), new Date().toISOString().slice(0, 10), 'lane-agent');
    mockFailedDeregistration('jj-workspace', wt);

    const failed = await cleanupProject(root, 'proj');

    expect(failed).toEqual([expect.objectContaining({
      acted: false,
      action: expect.stringContaining('deregistration failed after quarantine'),
    })]);
    expect(await manifestRead(home)).toEqual([expect.objectContaining({
      path: wt, quarantine_deregistered: false, quarantine_pending: false,
    })]);
    expect(jj(['workspace', 'list'], home)).toContain('lane-agent:');
    expect(await fs.stat(trashed)).toBeTruthy();

    vi.mocked(run).mockImplementation(actualRun);
    const retried = await cleanupProject(root, 'proj');

    expect(retried).toEqual([expect.objectContaining({
      acted: true, action: expect.stringContaining('deregistered quarantined'),
    })]);
    expect(jj(['workspace', 'list'], home)).not.toContain('lane-agent:');
    expect(await manifestRead(home)).toEqual([expect.objectContaining({ quarantine_deregistered: true })]);
    expect(await fs.stat(trashed)).toBeTruthy();
  });

  it('real JJ retains a named registration when forget reports success without forgetting it', async () => {
    const { root, home, wt } = await setupRealJjWorkspace('internal-lane-name', 'public-basename');
    const retained = path.join(root, 'retained-lane');
    await fs.writeFile(path.join(wt, 'keep.txt'), 'precious');
    await manifestUpdate(home, (current) => current.map((record) => ({ ...record, workspace_name: 'internal-lane-name' })));
    const before = await manifestRead(home);
    await fs.rename(wt, retained);
    vi.mocked(run).mockImplementation(async (command, args, cwd, env, timeout) => {
      if (args.includes('workspace') && args.includes('forget')) return { code: 0, stdout: '', stderr: '' };
      return actualRun(command, args, cwd, env, timeout);
    });

    const failed = await cleanupProject(root, 'proj');

    expect(failed).toEqual([expect.objectContaining({ acted: false })]);
    expect(failed[0].action).toMatch(/registered|failed|retry/i);
    expect(await manifestRead(home)).toEqual(before);
    expect(jj(['workspace', 'list'], home)).toContain('internal-lane-name:');
    expect(await fs.readFile(path.join(retained, 'keep.txt'), 'utf8')).toBe('precious');

    vi.mocked(run).mockImplementation(actualRun);
    await cleanupProject(root, 'proj');
    expect(await manifestRead(home)).toEqual([]);
    expect(jj(['workspace', 'list'], home)).not.toContain('internal-lane-name:');
    expect(await fs.readFile(path.join(retained, 'keep.txt'), 'utf8')).toBe('precious');
  });

  it('real JJ refuses a stale recorded name after a workspace rename', async () => {
    const { root, home, wt } = await setupRealJjWorkspace('internal-lane-name', 'public-basename');
    const retained = path.join(root, 'retained-lane');
    await fs.writeFile(path.join(wt, 'keep.txt'), 'precious');
    jj(['workspace', 'rename', 'new-name'], wt);
    await manifestUpdate(home, (current) => current.map((record) => ({ ...record, workspace_name: 'old-name' })));
    const before = await manifestRead(home);
    await fs.rename(wt, retained);
    vi.mocked(run).mockImplementation(async (command, args, cwd, env, timeout) => {
      if (args.includes('workspace') && args.includes('forget')) return { code: 0, stdout: '', stderr: '' };
      return actualRun(command, args, cwd, env, timeout);
    });

    const failed = await cleanupProject(root, 'proj');

    expect(failed).toEqual([expect.objectContaining({ acted: false })]);
    expect(failed[0].action).toMatch(/stale|ambiguous|registered|retry/i);
    expect(await manifestRead(home)).toEqual(before);
    expect(jj(['workspace', 'list'], home)).toContain('new-name:');
    expect(vi.mocked(run).mock.calls.some((call) => call[1].includes('forget'))).toBe(false);
    expect(await fs.readFile(path.join(retained, 'keep.txt'), 'utf8')).toBe('precious');

    vi.mocked(run).mockImplementation(actualRun);
    jj(['workspace', 'forget', 'new-name'], home);
    await cleanupProject(root, 'proj');
    expect(await manifestRead(home)).toEqual([]);
    expect(await fs.readFile(path.join(retained, 'keep.txt'), 'utf8')).toBe('precious');
  });

  it('real JJ refuses a recorded name reused for a different workspace', async () => {
    const { root, home, wt } = await setupRealJjWorkspace('internal-lane-name', 'public-basename');
    const retained = path.join(root, 'retained-lane');
    const replacement = path.join(root, 'replacement-lane');
    await fs.writeFile(path.join(wt, 'keep.txt'), 'precious');
    jj(['workspace', 'forget', 'internal-lane-name'], home);
    jj(['workspace', 'add', '--name', 'internal-lane-name', '-r', 'main', replacement], home);
    await manifestUpdate(home, (current) => current.map((record) => ({ ...record, workspace_name: 'internal-lane-name' })));
    const before = await manifestRead(home);
    await fs.rename(wt, retained);

    const failed = await cleanupProject(root, 'proj');

    expect(failed).toEqual([expect.objectContaining({ acted: false })]);
    expect(failed[0].action).toMatch(/different|root|registered|retry/i);
    expect(await manifestRead(home)).toEqual(before);
    expect(jj(['workspace', 'list'], home)).toContain('internal-lane-name:');
    expect(vi.mocked(run).mock.calls.some((call) => call[1].includes('forget'))).toBe(false);
    expect(await fs.readFile(path.join(retained, 'keep.txt'), 'utf8')).toBe('precious');

    jj(['workspace', 'forget', 'internal-lane-name'], home);
    await cleanupProject(root, 'proj');
    expect(await manifestRead(home)).toEqual([]);
    expect(await fs.readFile(path.join(retained, 'keep.txt'), 'utf8')).toBe('precious');
  });

  it('real JJ keeps a legacy nameless record until the operator forgets the registration', async () => {
    const { root, home, wt } = await setupRealJjWorkspace('internal-lane-name', 'public-basename');
    const retained = path.join(root, 'retained-lane');
    await fs.writeFile(path.join(wt, 'keep.txt'), 'precious');
    const before = await manifestRead(home);
    await fs.rename(wt, retained);
    mockFailedDeregistration('jj-workspace', wt);

    const failed = await cleanupProject(root, 'proj');

    expect(failed).toEqual([expect.objectContaining({ acted: false })]);
    expect(failed[0].action).toMatch(/registered|failed|ambiguous|retry/i);
    expect(await manifestRead(home)).toEqual(before);
    expect(jj(['workspace', 'list'], home)).toContain('internal-lane-name:');
    expect(await fs.readFile(path.join(retained, 'keep.txt'), 'utf8')).toBe('precious');

    vi.mocked(run).mockImplementation(async (command, args, cwd, env, timeout) => {
      const result = await actualRun(command, args, cwd, env, timeout);
      if (command === 'jj' && args.includes('workspace') && args.includes('list')) {
        return { ...result, stdout: result.stdout.replace(`internal-lane-name\t${wt}\n`, 'internal-lane-name\t\n') };
      }
      return result;
    });
    const stillBlocked = await cleanupProject(root, 'proj');
    expect(stillBlocked).toEqual([expect.objectContaining({ acted: false })]);
    expect(await manifestRead(home)).toEqual(before);
    jj(['workspace', 'forget', 'internal-lane-name'], home);
    await cleanupProject(root, 'proj');
    expect(await manifestRead(home)).toEqual([]);
    expect(await fs.readFile(path.join(retained, 'keep.txt'), 'utf8')).toBe('precious');
  });

  it('real JJ forgets the listed workspace name instead of its destination basename', async () => {
    const { root, home, wt } = await setupRealJjWorkspace('internal-lane-name', 'public-basename');

    const actions = await cleanupProject(root, 'proj');
    expect(actions).toEqual([expect.objectContaining({ acted: true })]);
    expect(jj(['workspace', 'list'], home)).not.toContain('internal-lane-name:');
    expect(await manifestRead(home)).toEqual([expect.objectContaining({
      path: wt, quarantine_deregistered: true,
    })]);
  });

  it('real JJ retains an ignored file that has no publication backup', async () => {
    const { root, home, wt } = await setupRealJjWorkspace('lane-agent', 'lane-agent');
    await fs.writeFile(path.join(wt, '.gitignore'), 'ignored.txt\n');
    jj(['commit', '-m', 'ignore local output'], wt);
    jj(['bookmark', 'set', 'main', '-r', '@-'], wt);
    jj(['git', 'push', '--bookmark', 'main'], wt);
    await fs.writeFile(path.join(wt, 'ignored.txt'), 'not backed up');

    const actions = await cleanupProject(root, 'proj');
    expect(actions).toEqual([expect.objectContaining({ acted: false })]);
    expect(actions[0].action).toMatch(/ignored|backed up|retained|left/i);
    expect(await fs.readFile(path.join(wt, 'ignored.txt'), 'utf8')).toBe('not backed up');
    expect(await manifestRead(home)).toEqual([expect.objectContaining({ path: wt })]);
  });

  it('real JJ retains stale remote proof without fetching or changing refs', async () => {
    const { root, home, wt } = await setupRealJjWorkspace('lane-agent', 'lane-agent');
    const trackingRef = 'refs/remotes/origin/main';
    const readTracking = () => execFileSync('git', ['rev-parse', trackingRef], { cwd: wt, encoding: 'utf8' });
    const before = readTracking();
    git(['update-ref', '-d', 'refs/heads/main'], path.join(root, 'remote.git'));

    const dryRun = await cleanupProject(root, 'proj', { dryRun: true });
    expect(dryRun).toEqual([expect.objectContaining({ acted: false })]);
    expect(dryRun[0].action).toMatch(/remote|stale|publish|left|retained/i);
    expect(readTracking()).toBe(before);
    expect(await fs.stat(wt)).toBeTruthy();

    const actions = await cleanupProject(root, 'proj');
    expect(actions).toEqual([expect.objectContaining({ acted: false })]);
    expect(actions[0].action).toMatch(/remote|stale|publish|left|retained/i);
    expect(readTracking()).toBe(before);
    expect(await fs.stat(wt)).toBeTruthy();
    expect(await manifestRead(home)).toEqual([expect.objectContaining({ path: wt })]);
  });

  it('keeps a reconcilable pending record when a crash follows rename', async () => {
    const { root, home, wt } = await setupLane('jj-workspace');
    const manifest = hivePath(home, 'manifest.jsonl');
    const dest = path.join(hivePath(home, 'trash'), new Date().toISOString().slice(0, 10), path.basename(wt));
    const rename = fs.rename;
    const writeFile = fs.writeFile;
    let moved = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
      if (String(oldPath) === wt && String(newPath) === dest) moved = true;
      if (String(newPath) === manifest && moved) throw new Error('crash before metadata completion');
      if (String(oldPath) === dest && String(newPath) === wt) throw new Error('crash prevents rollback');
      return rename(oldPath, newPath);
    });
    vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
      if (String(file) === manifest && moved) throw new Error('crash before metadata completion');
      return writeFile(file, data, options);
    });

    await expect(cleanupProject(root, 'proj')).rejects.toThrow();
    expect(await manifestRead(home)).toEqual([expect.objectContaining({
      path: wt, quarantine_path: dest,
    })]);
    expect(await fs.stat(dest)).toBeTruthy();
  });

  it('treats an already-forgotten JJ workspace as a successful retry', async () => {
    const { root, home } = await setup();
    const source = path.join(home, 'lane-agent');
    const dest = path.join(hivePath(home, 'trash'), '2000-01-01', 'lane-agent');
    await fs.mkdir(dest, { recursive: true });
    await manifestAdd(home, {
      kind: 'jj-workspace', at: '2000-01-01T00:00:00.000Z', path: source,
      quarantine_path: dest, quarantine_deregistered: false,
      quarantine_files: [], quarantine_directories: [],
    });
    vi.mocked(run).mockImplementation(async (_command, args) => {
      if (args.includes('workspace') && args.includes('list')) {
        return { code: 0, stdout: `default\t${home}\n`, stderr: '' };
      }
      if (args.includes('workspace') && args.includes('forget')) {
        return { code: 1, stdout: '', stderr: 'workspace lane-agent not found' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    const actions = await cleanupProject(root, 'proj');
    expect(actions).toEqual([expect.objectContaining({ acted: true })]);
    expect(await manifestRead(home)).toEqual([expect.objectContaining({
      quarantine_path: dest, quarantine_deregistered: true,
    })]);
  });

  it('preserves workspace_name when reconciling a pending quarantine', async () => {
    const { root, home } = await setup();
    const source = path.join(home, 'lane-agent');
    await fs.mkdir(source);
    const dest = path.join(hivePath(home, 'trash'), '2000-01-01', 'lane-agent');
    await manifestAdd(home, {
      kind: 'jj-workspace', at: '2000-01-01T00:00:00.000Z', path: source, workspace_name: 'internal-lane-name',
      quarantine_path: dest, quarantine_pending: true, quarantine_deregistered: false,
      quarantine_files: [], quarantine_directories: [],
    });

    const actions = await cleanupProject(root, 'proj');

    expect(actions).toEqual([expect.objectContaining({ acted: true })]);
    const reconciled = await manifestRead(home);
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].workspace_name).toBe('internal-lane-name');
    expect(reconciled[0].quarantine_path).toBeUndefined();
  });

  it('does not lose a concurrent manifestAdd during quarantine', async () => {
    const { root, home, wt } = await setupLane('jj-workspace');
    const added = {
      kind: 'process' as const, at: new Date().toISOString(), pid: 987654, started: 'added-during-cleanup',
    };
    const rename = fs.rename;
    let addedOnce = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
      if (!addedOnce && String(oldPath) === wt) {
        addedOnce = true;
        await manifestAdd(home, added);
      }
      return rename(oldPath, newPath);
    });

    await cleanupProject(root, 'proj');
    expect(await manifestRead(home)).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: wt, quarantine_deregistered: true }),
      expect.objectContaining({ pid: added.pid, started: added.started }),
    ]));
  });

  it('uses same-directory atomic replacement for manifest metadata', async () => {
    const { root, home } = await setupLane('jj-workspace');
    const manifest = hivePath(home, 'manifest.jsonl');
    const writeFile = fs.writeFile;
    const rename = fs.rename;
    const directWrites: string[] = [];
    let atomicReplacement = false;
    vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
      if (String(file) === manifest) directWrites.push(String(file));
      return writeFile(file, data, options);
    });
    vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
      if (String(newPath) === manifest && String(oldPath) !== manifest
        && path.dirname(String(oldPath)) === path.dirname(manifest)) atomicReplacement = true;
      return rename(oldPath, newPath);
    });

    await cleanupProject(root, 'proj');
    expect(directWrites).toEqual([]);
    expect(atomicReplacement).toBe(true);
  });

  it('real JJ refuses purge after VCS-only metadata changes', async () => {
    const { root, home } = await setupRealJjWorkspace('lane-agent', 'lane-agent');
    const quarantined = await cleanupProject(root, 'proj');
    expect(quarantined).toEqual([expect.objectContaining({ acted: true })]);
    const [record] = await manifestRead(home);
    const dest = String(record.quarantine_path);
    const metadata = path.join(dest, '.jj');
    const metadataStat = await fs.lstat(metadata);
    if (metadataStat.isDirectory()) {
      await fs.writeFile(path.join(metadata, 'unpublished-change'), 'new unpublished operation');
    } else {
      await fs.writeFile(metadata, `${await fs.readFile(metadata, 'utf8')}\nnew unpublished operation`);
    }
    expect(await fs.readFile(path.join(dest, 'published.txt'), 'utf8')).toBe('published parent');
    const expired = { ...record, quarantine_expires_at: '2000-01-02T00:00:00.000Z' };
    await manifestUpdate(home, () => [expired]);

    const actions = await cleanupProject(root, 'proj', { reclaimTrash: true, ownerApproved: true });
    expect(actions).toEqual([expect.objectContaining({ record: expired, acted: false })]);
    expect(actions[0].action).toMatch(/metadata|changed|identity|retained/i);
    expect(await fs.stat(dest)).toBeTruthy();
    expect(await manifestRead(home)).toEqual([expired]);
  });

  it('retains the actual stage path when staged restoration fails', async () => {
    const { root, home, dest, record } = await setupQuarantine();
    const rename = fs.rename;
    const rm = fs.rm;
    let stage = '';
    vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
      if (String(oldPath) === dest && String(newPath) !== dest) {
        stage = String(newPath);
        return rename(oldPath, newPath);
      }
      if (stage && String(oldPath) === stage && String(newPath) === dest) {
        throw new Error('staged restoration failed');
      }
      return rename(oldPath, newPath);
    });
    vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (stage && String(target) === stage) throw new Error('staged deletion failed');
      return rm(target, options);
    });

    const actions = await cleanupProject(root, 'proj', { reclaimTrash: true, ownerApproved: true });
    expect(stage).not.toBe('');
    expect(actions).toEqual([expect.objectContaining({ acted: false })]);
    expect(actions[0].action).toContain(dest);
    expect(actions[0].action).toContain(stage);
    expect(await manifestRead(home)).toEqual([expect.objectContaining({
      ...record, quarantine_path: stage,
    })]);
    expect(await fs.stat(dest).catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(stage, 'payload.bin'))).toEqual(Buffer.alloc(256 * 1024, 7));
  });

  it('retains the stage when inventory mismatches and restoration fails', async () => {
    const { root, home, dest, record } = await setupQuarantine();
    const rename = fs.rename;
    let stage = '';
    const changed = Buffer.alloc(256 * 1024, 9);
    vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
      if (String(oldPath) === dest && String(newPath) !== dest) {
        stage = String(newPath);
        const result = await rename(oldPath, newPath);
        await fs.writeFile(path.join(stage, 'payload.bin'), changed);
        return result;
      }
      if (stage && String(oldPath) === stage && String(newPath) === dest) {
        throw new Error('staged restoration failed');
      }
      return rename(oldPath, newPath);
    });

    const actions = await cleanupProject(root, 'proj', { reclaimTrash: true, ownerApproved: true });
    expect(stage).not.toBe('');
    expect(actions).toEqual([expect.objectContaining({ acted: false })]);
    expect(actions[0].action).toContain(dest);
    expect(actions[0].action).toContain(stage);
    expect(await manifestRead(home)).toEqual([expect.objectContaining({
      ...record, quarantine_path: stage,
    })]);
    expect(await fs.stat(dest).catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(stage, 'payload.bin'))).toEqual(changed);
  });

  it('refuses reclamation through a symlinked ancestor inside trash', async () => {
    const { root, home, dest, record } = await setupQuarantine();
    const dateDir = path.dirname(dest);
    const actual = path.join(root, 'actual-quarantine');
    await fs.rename(dateDir, actual);
    await fs.symlink(actual, dateDir, 'dir');

    const actions = await cleanupProject(root, 'proj', { reclaimTrash: true, ownerApproved: true });
    expect(actions).toEqual([expect.objectContaining({ record, acted: false })]);
    expect(actions[0].action).toMatch(/symlink|ancestor|identity|retain/i);
    expect(await fs.readFile(path.join(actual, path.basename(dest), 'payload.bin'))).toEqual(
      Buffer.alloc(256 * 1024, 7),
    );
    expect(await manifestRead(home)).toEqual([record]);
  });

  it('retains a replacement introduced between reclamation inventory and deletion', async () => {
    const { root, home, dest } = await setupQuarantine();
    const replacement = path.join(dest, 'replacement.txt');
    const rm = fs.rm;
    const rename = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementation(async (oldPath, newPath) => {
      const result = await rename(oldPath, newPath);
      if (String(oldPath) === dest && String(newPath) !== dest) {
        await fs.mkdir(dest, { recursive: true });
        await fs.writeFile(replacement, 'replacement survives');
      }
      return result;
    });
    vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (String(target) === dest) {
        await rename(dest, path.join(root, 'inventoried-quarantine'));
        await fs.mkdir(dest, { recursive: true });
        await fs.writeFile(replacement, 'replacement survives');
      }
      return rm(target, options);
    });

    await cleanupProject(root, 'proj', { reclaimTrash: true, ownerApproved: true });
    expect(await fs.readFile(replacement, 'utf8')).toBe('replacement survives');
  });

  it('retains an ignored file that has no publication backup', async () => {
    const { root, home, wt } = await setupLane('worktree');
    await fs.writeFile(path.join(wt, '.gitignore'), 'ignored.txt\n');
    git(['add', '.gitignore'], wt);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'ignore local output'], wt);
    git(['push', '-q'], wt);
    await fs.writeFile(path.join(wt, 'ignored.txt'), 'not backed up');

    const actions = await cleanupProject(root, 'proj');
    expect(actions).toEqual([expect.objectContaining({ acted: false })]);
    expect(actions[0].action).toMatch(/ignored|backed up|retained|left/i);
    expect(await fs.readFile(path.join(wt, 'ignored.txt'), 'utf8')).toBe('not backed up');
    expect(await manifestRead(home)).toEqual([expect.objectContaining({ path: wt })]);
  });

  it('refuses stale remote-tracking proof after the remote branch disappears', async () => {
    const { root, home, wt, branch } = await setupLane('worktree');
    git(['update-ref', '-d', `refs/heads/${branch}`], `${home}-remote.git`);

    const actions = await cleanupProject(root, 'proj');
    expect(actions).toEqual([expect.objectContaining({ acted: false })]);
    expect(actions[0].action).toMatch(/remote|stale|publish|left/i);
    expect(await fs.stat(wt)).toBeTruthy();
    expect(await manifestRead(home)).toEqual([expect.objectContaining({ path: wt })]);
  });

  it('refuses content introduced after publication probing but before rename', async () => {
    const { root, home, wt } = await setupLane('worktree');
    const readFile = fs.readFile;
    let introduced = false;
    vi.spyOn(fs, 'readFile').mockImplementation(async (file, options) => {
      if (!introduced && path.resolve(String(file)).startsWith(`${wt}${path.sep}`)) {
        introduced = true;
        await fs.writeFile(path.join(wt, 'late.txt'), 'late unverified content');
      }
      return readFile(file, options);
    });

    const actions = await cleanupProject(root, 'proj');
    expect(introduced).toBe(true);
    expect(actions).toEqual([expect.objectContaining({ acted: false })]);
    expect(actions[0].action).toMatch(/changed|mutation|retry|left|retained/i);
    expect(await fs.readFile(path.join(wt, 'late.txt'), 'utf8')).toBe('late unverified content');
    expect(await manifestRead(home)).toEqual([expect.objectContaining({ path: wt })]);
  });
});
