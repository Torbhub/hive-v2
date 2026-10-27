import { promises as fs, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';

process.env.HIVE_TMUX_SOCKET = `hive-test-${process.pid}`;

vi.mock('../src/tmux.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/tmux.js')>();
  return {
    ...orig,
    run: vi.fn(orig.run),
    tmux: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'tmux not stubbed in test' })),
    paneExists: vi.fn(async () => true),
    paneIs: vi.fn(async () => true),
    capturePane: vi.fn(async () => null),
    killWindow: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
  };
});

vi.mock('../src/hub.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/hub.js')>();
  const state = await import('../src/state.js');
  return {
    ...orig,
    buildStatus: vi.fn(async () => ({ hub: { root: '' }, projects: [] })),
    continueProject: vi.fn(async () => '%1'),
    readDialogFor: vi.fn(async () => null),
    // A successful wake registers the new pane on the team entry, as the real
    // launchOrchestrator does; the watchdog checks before it logs resurrection.
    wake: vi.fn(async (root: string, project: string) => {
      const pf = await state.readProjects(root);
      const home = pf.projects.find((p) => p.name === project)?.home ?? '';
      await state.upsertTeamEntry(home, {
        name: `${project}-orchestrator`, pane: '%9', pane_pid: 99, pane_started: 'fresh',
      });
      return '%9';
    }),
    answerDialog: vi.fn(async () => ({
      answered: true as const, session: 'demo-orchestrator', choice: '1', option: 'Approve once', dialog_gone: true,
    })),
  };
});

vi.mock('../src/spawn.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/spawn.js')>();
  const state = await import('../src/state.js');
  return {
    ...orig,
    wakeAgent: vi.fn(async (root: string, project: string, agent: string) => {
      const pf = await state.readProjects(root);
      const home = pf.projects.find((p) => p.name === project)?.home ?? '';
      await state.upsertTeamEntry(home, {
        name: agent, pane: '%8', pane_pid: 88, pane_started: 'fresh',
      });
      return '%8';
    }),
  };
});

vi.mock('../src/death-bundle.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/death-bundle.js')>();
  return {
    ...orig,
    wireLogMtime: vi.fn(async () => Date.now()),
  };
});

import { buildStatus, continueProject, readDialogFor, answerDialog, wake } from '../src/hub.js';
import { wakeAgent } from '../src/spawn.js';
import { captureDeathBundle, wireLogMtime } from '../src/death-bundle.js';
import { capturePane, killWindow, paneExists, paneIs, run, sleep, tmux } from '../src/tmux.js';
import { withTimeout } from '../src/view.js';
import { hubPath, readDecisions, readTeam, upsertTeamEntry, writeJson, writePendingPane, hivePath } from '../src/state.js';
import { loadProcessedKeys } from '../src/watch-persist.js';
import {
  extractCommand, neverApprove, tier1Approves, watch, watchCycle, WAKE_MAX_ATTEMPTS,
} from '../src/watch.js';

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'hive-watch-'));
}

// Most factory implementations survive. Identity checks start fresh each test.
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(paneIs).mockImplementation(async () => true);
});

// Stubs every exec probe a death-bundle capture can fire; the suite never
// runs real tmux/ps/dmesg/free/systemctl.
function stubProbes(dmesgResult = { code: 0, stdout: 'killed process 11\noom line\n', stderr: '' }) {
  vi.mocked(tmux).mockResolvedValue({ code: 0, stdout: '%1: hive:1.0\n%2: hive:2.0\n', stderr: '' });
  vi.mocked(run).mockImplementation(async (cmd, args) => {
    if (cmd === 'ps') return { code: 1, stdout: '', stderr: '' };
    if (cmd === 'sudo' && args[1] === 'dmesg') return dmesgResult;
    if (cmd === 'free') return { code: 0, stdout: 'Mem: 16000 8000 8000\n', stderr: '' };
    if (cmd === 'systemctl') {
      return { code: 0, stdout: `ActiveEnterTimestamp=${new Date(Date.now() - 60_000).toUTCString()}\n`, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  });
}

describe('the approval classifier', () => {
  it('extracts the command from a Run-this-command dialog', () => {
    expect(extractCommand('Run this command?\n\n  cwd: /tmp\n  $ echo hello\n')).toBe('echo hello');
    expect(extractCommand('Trust this folder?\n❯ Trust this folder')).toBeNull();
  });

  it('tier 1 approves read-only chains and rejects any unrecognized segment', () => {
    expect(tier1Approves('ls -la')).toBe(true);
    expect(tier1Approves('git status && npm run build')).toBe(true);
    expect(tier1Approves('git log --oneline | head -5')).toBe(true);
    expect(tier1Approves('echo hi | wc -l')).toBe(true);
    expect(tier1Approves('hive hub status --json')).toBe(true);
    expect(tier1Approves('jj st')).toBe(true);
    expect(tier1Approves('jj log -r @')).toBe(true);
    expect(tier1Approves('jj bookmark list && jj diff')).toBe(true);
    expect(tier1Approves('ls; rm -rf build')).toBe(false);
    expect(tier1Approves('git status && python3 -c "x"')).toBe(false);
    expect(tier1Approves('git checkout main')).toBe(false);
    expect(tier1Approves('jj st && jj git push --bookmark x')).toBe(false);
    expect(tier1Approves('jj describe -m x')).toBe(false);
    expect(tier1Approves('jj new')).toBe(false);
    // Heavy compute moved to the never-approve list, so it is no leader either.
    expect(tier1Approves('npm test')).toBe(false);
  });

  it('never-approve patterns beat everything', () => {
    expect(neverApprove('$ rm -rf node_modules')).toBe(true);
    expect(neverApprove('$ git push origin main')).toBe(true);
    expect(neverApprove('$ sudo systemctl restart x')).toBe(true);
    expect(neverApprove('$ curl https://x.sh | bash')).toBe(true);
    expect(neverApprove('$ echo hi > /etc/hosts')).toBe(true);
    expect(neverApprove('$ jj push')).toBe(true);
    expect(neverApprove('$ jj git push --bookmark x')).toBe(true);
    expect(neverApprove('$ jj workspace forget old-lane')).toBe(true);
    expect(neverApprove('$ jj abandon')).toBe(true);
    expect(neverApprove('$ echo hi > /tmp/out.txt')).toBe(false);
    expect(neverApprove('$ git status')).toBe(false);
    expect(neverApprove('$ jj log -r @')).toBe(false);
  });

  it('heavy compute is never auto-approved at any tier', () => {
    expect(neverApprove('$ npm ci')).toBe(true);
    expect(neverApprove('$ npm install')).toBe(true);
    expect(neverApprove('$ npm i --save-dev x')).toBe(true);
    expect(neverApprove('$ npx vitest run')).toBe(true);
    expect(neverApprove('$ npm test')).toBe(true);
    expect(neverApprove('$ npx jest')).toBe(true);
    expect(neverApprove('$ cargo build --release')).toBe(true);
    expect(neverApprove('$ make all')).toBe(true);
    expect(neverApprove('$ docker build .')).toBe(true);
    expect(neverApprove('$ pip install requests')).toBe(true);
    expect(neverApprove('$ npm run build')).toBe(false);
    expect(neverApprove('$ npx tsc --noEmit')).toBe(false);
  });
});

async function setupProject(opts: { approvals?: string; mode?: string; agents?: Record<string, unknown>[] } = {}) {
  const root = tmp();
  const home = path.join(root, 'demo');
  await fs.mkdir(hivePath(home), { recursive: true });
  await writeJson(hubPath(root, 'projects.json'), {
    projects: [{
      name: 'demo', home, repos: [],
      ...('approvals' in opts ? { approvals: opts.approvals } : {}),
      ...('mode' in opts ? { mode: opts.mode } : {}),
    }],
  });
  await writeJson(hivePath(home, 'team.json'), { agents: opts.agents ?? [] });
  return { root, home };
}

describe('watchCycle watchdog', () => {
  it('logs a death once, backs off a failed wake, and logs a real resurrection', async () => {
    const { root } = await setupProject({
      agents: [
        { name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 11, pane_started: 'a', session_id: 'session_x' },
        { name: 'builder', pane: '%2', pane_pid: 22, pane_started: 'b' },
      ],
    });
    vi.mocked(paneExists).mockResolvedValue(false);
    stubProbes();
    const deaths = new Set<string>();
    const wakes = new Map<string, { attempts: number; nextAt: number }>();
    vi.mocked(wake).mockRejectedValueOnce(new Error('the teamkimi proxy is down'));
    await watchCycle(root, {}, deaths, wakes);
    expect(wake).toHaveBeenCalledWith(root, 'demo');
    expect(wake).toHaveBeenCalledTimes(1);
    let log = await fs.readFile(hubPath(root, 'watch.log'), 'utf8');
    expect(log).toMatch(/demo demo-orchestrator pane %1 died \(pid 11, started a\)/);
    expect(log).toMatch(/demo builder pane %2 died \(pid 22, started b\)/);
    expect(log).toContain('wake attempt 1 failed: the teamkimi proxy is down');
    // Nothing is recorded in DECISIONS before a wake actually succeeds.
    expect(await readDecisions(root)).toHaveLength(0);

    // The very next tick is inside the backoff window and does not retry.
    await watchCycle(root, {}, deaths, wakes);
    expect(wake).toHaveBeenCalledTimes(1);

    // After the backoff the retry runs, the death is not relogged, and the
    // resurrection is logged only after the new pane identity registers.
    for (const w of wakes.values()) w.nextAt = 0;
    await watchCycle(root, {}, deaths, wakes);
    expect(wake).toHaveBeenCalledTimes(2);
    log = await fs.readFile(hubPath(root, 'watch.log'), 'utf8');
    expect(log.match(/pane %1 died/g)).toHaveLength(1);
    expect(log).toContain('resurrected demo-orchestrator in pane %9 (wake attempt 2)');
    const after = await readDecisions(root);
    expect(after.filter((d) => d.summary.includes('woke the orchestrator'))).toHaveLength(1);
  });

  it('counts a wake that never registered its pane as a failed attempt', async () => {
    const { root, home } = await setupProject({
      agents: [{ name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 11, pane_started: 'a', session_id: 'session_x' }],
    });
    vi.mocked(paneExists).mockResolvedValue(false);
    stubProbes();
    // wake returns a pane but the team entry never moves (waitIdle timed out).
    vi.mocked(wake).mockResolvedValue('%9');
    const wakes = new Map<string, { attempts: number; nextAt: number }>();
    await watchCycle(root, {}, new Set(), wakes);
    const log = await fs.readFile(hubPath(root, 'watch.log'), 'utf8');
    expect(log).toContain('wake attempt 1 failed: wake returned %9 but the team entry still points at %1');
    expect(log).not.toContain('resurrected');
    expect(await readDecisions(root)).toHaveLength(0);
    expect((await readTeam(home)).agents[0].pane).toBe('%1');
  });

  it('rejects a stale process identity when a wake returns the same pane', async () => {
    const { root } = await setupProject({
      agents: [{ name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 11, pane_started: 'a', session_id: 'session_x' }],
    });
    vi.mocked(paneExists).mockResolvedValue(false);
    vi.mocked(paneIs).mockResolvedValue(false);
    stubProbes();
    vi.mocked(wake).mockResolvedValue('%1');
    await watchCycle(root, {}, new Set(), new Map());
    expect(paneIs).toHaveBeenCalledWith('%1', { pid: 11, started: 'a' });
    const log = await fs.readFile(hubPath(root, 'watch.log'), 'utf8');
    expect(log).toContain('wake attempt 1 failed: wake returned %1 but the team entry has a stale process identity');
    expect(log).not.toContain('resurrected');
    expect(await readDecisions(root)).toHaveLength(0);
  });

  it('accepts a fresh process identity when a wake returns the same pane', async () => {
    const { root, home } = await setupProject({
      agents: [{ name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 11, pane_started: 'a', session_id: 'session_x' }],
    });
    vi.mocked(paneExists).mockResolvedValue(false);
    vi.mocked(paneIs).mockResolvedValue(true);
    stubProbes();
    vi.mocked(wake).mockImplementation(async () => {
      await upsertTeamEntry(home, {
        name: 'demo-orchestrator', pane: '%1', pane_pid: 12, pane_started: 'fresh',
      });
      return '%1';
    });
    await watchCycle(root, {}, new Set(), new Map());
    expect(paneIs).toHaveBeenCalledWith('%1', { pid: 12, started: 'fresh' });
    const log = await fs.readFile(hubPath(root, 'watch.log'), 'utf8');
    expect(log).toContain('resurrected demo-orchestrator in pane %1');
    expect(await readDecisions(root)).toHaveLength(1);
  });

  it('gives up waking after the attempts run out and says so once', async () => {
    const { root } = await setupProject({
      agents: [{ name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 11, pane_started: 'a' }],
    });
    vi.mocked(paneExists).mockResolvedValue(false);
    stubProbes();
    vi.mocked(wake).mockRejectedValue(new Error('the teamkimi proxy is down'));
    const deaths = new Set<string>();
    const wakes = new Map<string, { attempts: number; nextAt: number }>();
    for (let i = 0; i < WAKE_MAX_ATTEMPTS + 2; i++) {
      await watchCycle(root, {}, deaths, wakes);
      for (const w of wakes.values()) w.nextAt = 0;
    }
    expect(wake).toHaveBeenCalledTimes(WAKE_MAX_ATTEMPTS);
    const log = await fs.readFile(hubPath(root, 'watch.log'), 'utf8');
    expect(log.match(/gave up waking demo-orchestrator/g)).toHaveLength(1);
  });

  it('never logs or wakes a pane that was closed on purpose', async () => {
    const { root } = await setupProject({
      agents: [{
        name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 11, pane_started: 'a',
        session_id: 'session_x', closed_at: new Date().toISOString(),
      }],
    });
    vi.mocked(paneExists).mockResolvedValue(false);
    stubProbes();
    await watchCycle(root, {}, new Set(), new Map());
    expect(wake).not.toHaveBeenCalled();
    const log = await fs.readFile(hubPath(root, 'watch.log'), 'utf8').catch(() => '');
    expect(log).not.toContain('died');
  });

  it('re-wakes a dead agent by its session id; one without a session is only logged', async () => {
    const { root } = await setupProject({
      agents: [
        { name: 'builder', pane: '%2', pane_pid: 22, pane_started: 'b', session_id: 'session_b' },
        { name: 'logger', pane: '%3', pane_pid: 33, pane_started: 'c' },
      ],
    });
    vi.mocked(paneExists).mockResolvedValue(false);
    stubProbes();
    await watchCycle(root, {}, new Set(), new Map());
    expect(wakeAgent).toHaveBeenCalledWith(root, 'demo', 'builder');
    expect(wakeAgent).toHaveBeenCalledTimes(1);
    expect(wake).not.toHaveBeenCalled();
    const log = await fs.readFile(hubPath(root, 'watch.log'), 'utf8');
    expect(log).toContain('resurrected builder in pane %8 (wake attempt 1)');
    expect(log).toMatch(/demo logger pane %3 died/);
    expect(log).not.toContain('resurrected logger');
    const decisions = await readDecisions(root);
    expect(decisions[0].summary).toBe('woke builder after pane %2 died');
  });

  it('records a death to disk; a restarted watch re-wakes it without re-logging or re-bundling', async () => {
    const { root, home } = await setupProject({
      agents: [{ name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 11, pane_started: 'a', session_id: 'session_x' }],
    });
    vi.mocked(paneExists).mockResolvedValue(false);
    stubProbes();
    // Implementations leak between tests (clearAllMocks keeps them), so the
    // success path is set here, not inherited from the hub mock factory.
    vi.mocked(wake)
      .mockRejectedValueOnce(new Error('the teamkimi proxy is down'))
      .mockImplementation(async () => {
        await upsertTeamEntry(home, {
          name: 'demo-orchestrator', pane: '%9', pane_pid: 99, pane_started: 'fresh',
        });
        return '%9';
      });
    await watchCycle(root, {}, new Set(), new Map());
    expect(wake).toHaveBeenCalledTimes(1);
    let log = await fs.readFile(hubPath(root, 'watch.log'), 'utf8');
    expect(log.match(/pane %1 died/g)).toHaveLength(1);

    // Restart: fresh in-memory state, the disk record carries the death over.
    // The wake is retried (fresh budget) but the death is not reported again.
    const restored = await loadProcessedKeys(root);
    expect(restored.has('%1:11')).toBe(true);
    await watchCycle(root, {}, restored, new Map());
    expect(wake).toHaveBeenCalledTimes(2);
    log = await fs.readFile(hubPath(root, 'watch.log'), 'utf8');
    expect(log.match(/pane %1 died/g)).toHaveLength(1);
    expect(log).toContain('resurrected demo-orchestrator in pane %9 (wake attempt 1)');
    expect(await fs.readdir(hubPath(root, 'deaths'))).toHaveLength(1);
  });
});

describe('watchCycle pending launch', () => {
  const pending = {
    pane: '%1', kind: 'start', at: new Date().toISOString(), typed: false, line: 'pick up the project',
  };

  function startingProject(name: string, starting: Record<string, unknown> = {}, question = false) {
    return {
      name, home: '', repos: [], open_tasks: 0,
      orchestrator: {
        state: 'none', question,
        starting: { pane: '%1', kind: 'start', at: pending.at, typed: false, question: false, ...starting },
      },
      agents: [],
    };
  }

  it('continues an untyped pending launch after its dialog clears', async () => {
    const { root } = await setupProject();
    await writePendingPane(root, 'demo', pending);
    vi.mocked(buildStatus).mockResolvedValue({
      hub: { root: '' }, projects: [startingProject('demo')],
    } as never);

    await watchCycle(root);

    expect(continueProject).toHaveBeenCalledTimes(1);
    expect(continueProject).toHaveBeenCalledWith(root, 'demo');
  });

  it('continues an orphaned sending claim even when status still says sending', async () => {
    const { root } = await setupProject();
    const staleAt = new Date(Date.now() - 11 * 60_000).toISOString();
    await writePendingPane(root, 'demo', { ...pending, at: staleAt, sending: true });
    vi.mocked(buildStatus).mockResolvedValue({
      hub: { root: '' }, projects: [startingProject('demo', { at: staleAt, sending: true })],
    } as never);

    await watchCycle(root);

    expect(continueProject).toHaveBeenCalledTimes(1);
    expect(continueProject).toHaveBeenCalledWith(root, 'demo');
  });

  it.each([
    { name: 'a starting dialog is present', starting: { question: true }, pending: 'pending', question: false },
    { name: 'an orchestrator dialog is present', starting: {}, pending: 'pending', question: true },
    { name: 'status says the first line was typed', starting: { typed: true }, pending: 'pending', question: false },
    { name: 'the fresh pending record says the first line was typed', starting: {}, pending: 'typed', question: false },
    { name: 'the fresh pending record has a recent sending claim', starting: { sending: true }, pending: 'sending', question: false },
    { name: 'no pending launch exists', starting: {}, pending: 'missing', question: false },
  ] as const)('does not continue when $name', async ({ starting, pending: pendingState, question }) => {
    const { root } = await setupProject();
    if (pendingState !== 'missing') {
      await writePendingPane(root, 'demo', {
        ...pending, at: new Date().toISOString(), typed: pendingState === 'typed', sending: pendingState === 'sending',
      });
    }
    vi.mocked(buildStatus).mockResolvedValue({
      hub: { root: '' }, projects: [startingProject('demo', starting, question)],
    } as never);

    await watchCycle(root);

    expect(continueProject).not.toHaveBeenCalled();
  });

  it('a failed continue does not skip another project', async () => {
    const { root, home } = await setupProject();
    const otherHome = path.join(root, 'other');
    await writeJson(hivePath(otherHome, 'team.json'), { agents: [] });
    await writeJson(hubPath(root, 'projects.json'), {
      projects: [{ name: 'demo', home, repos: [] }, { name: 'other', home: otherHome, repos: [] }],
    });
    await writePendingPane(root, 'demo', pending);
    await writePendingPane(root, 'other', pending);
    vi.mocked(buildStatus).mockResolvedValue({
      hub: { root: '' }, projects: [startingProject('demo'), startingProject('other')],
    } as never);
    vi.mocked(continueProject).mockImplementation(async (_root, project) => {
      if (project === 'demo') throw new Error('continue failed');
      return '%1';
    });

    await expect(watchCycle(root)).resolves.toBeUndefined();

    expect(continueProject).toHaveBeenCalledTimes(2);
    expect(continueProject).toHaveBeenCalledWith(root, 'demo');
    expect(continueProject).toHaveBeenCalledWith(root, 'other');
  });
});

describe('watch loop cycle timeout', () => {
  it('a cycle stuck on a never-resolving await times out and the loop continues', async () => {
    const { root } = await setupProject({
      agents: [{ name: 'builder', pane: '%1', pane_pid: 11, pane_started: 'a' }],
    });
    vi.mocked(run).mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    vi.mocked(paneExists).mockImplementation(() => new Promise(() => {}));
    let cycles = 0;
    vi.mocked(sleep).mockImplementation(async () => {
      cycles += 1;
      if (cycles >= 3) throw new Error('test: stop the loop');
    });
    await expect(watch(root, { intervalMs: 1, cycleTimeoutMs: 20 })).rejects.toThrow('test: stop the loop');
    const log = await fs.readFile(hubPath(root, 'watch.log'), 'utf8');
    const stalls = log.split('\n').filter((l) => l.includes('cycle error: watch cycle timed out'));
    expect(stalls).toHaveLength(3);
    const pulse = JSON.parse(await fs.readFile(hubPath(root, 'watch-status.json'), 'utf8')) as { cycles: number };
    expect(pulse.cycles).toBe(3);
  });
});

describe('watchCycle wedge detection', () => {
  const WORKING = 'line of work\n⠋ Working…\n';

  it('marks a frozen pane wedged, dumps its stack, then kills it for the death path', async () => {
    const { root, home } = await setupProject({
      agents: [{ name: 'builder', pane: '%2', pane_pid: 22, pane_started: 'b', session_id: 'session_b' }],
    });
    vi.mocked(paneExists).mockResolvedValue(true);
    vi.mocked(capturePane).mockResolvedValue(WORKING);
    vi.mocked(wireLogMtime).mockResolvedValue(Date.now() - 60 * 60_000);
    vi.mocked(run).mockResolvedValue({ code: 0, stdout: 'stack\n', stderr: '' });
    const stills = new Map();
    // The first sight only records stillness; the verdict lands on the next tick.
    await watchCycle(root, {}, new Set(), new Map(), stills, { wedgeStillMs: 0 });
    await watchCycle(root, {}, new Set(), new Map(), stills, { wedgeStillMs: 0 });
    const team = await readTeam(home);
    expect(team.agents[0].wedged_at).toBeTruthy();
    const log = await fs.readFile(hubPath(root, 'watch.log'), 'utf8');
    expect(log).toContain('builder looks wedged');
    expect(log).toMatch(/stack dump: .*wedges/);
    const dumps = await fs.readdir(hivePath(home, 'wedges'));
    expect(dumps).toHaveLength(1);
    const dump = await fs.readFile(path.join(hivePath(home, 'wedges'), dumps[0]), 'utf8');
    expect(dump).toContain('== pstack 22 ==');
    expect(killWindow).toHaveBeenCalledWith('%2', { pid: 22, started: 'b' });
    const pstackCall = vi.mocked(run).mock.calls.findIndex((c) => c[0] === 'sudo' && c[1]?.includes('pstack'));
    expect(pstackCall).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(run).mock.invocationCallOrder[pstackCall])
      .toBeLessThan(vi.mocked(killWindow).mock.invocationCallOrder[0]);
    const decisions = await readDecisions(root);
    expect(decisions[0].summary).toContain('marked builder wedged');

    // A further cycle with the mark set does not restamp, redump, or rekill.
    await watchCycle(root, {}, new Set(), new Map(), stills, { wedgeStillMs: 0 });
    expect(killWindow).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(hivePath(home, 'wedges'))).toHaveLength(1);
  });

  it('suppresses only a live MCP wait and resets stillness when the wait ends', async () => {
    const { root, home } = await setupProject({
      agents: [{ name: 'builder', pane: '%2', pane_pid: 22, pane_started: 'b', session_id: 'session_b' }],
    });
    const statusWithWait = (waiting: boolean) => ({
      hub: { root: '' },
      projects: [{
        name: 'demo', home, repos: [], open_tasks: 0,
        orchestrator: { state: 'running', question: false },
        agents: [{ name: 'builder', state: 'running', question: waiting, operator_question: waiting, operator_waiting: waiting, ref: 'builder' }],
      }],
    });
    vi.mocked(buildStatus).mockResolvedValue(statusWithWait(true));
    vi.mocked(paneExists).mockResolvedValue(true);
    vi.mocked(capturePane).mockResolvedValue(WORKING);
    vi.mocked(wireLogMtime).mockResolvedValue(Date.now() - 60 * 60_000);
    vi.mocked(run).mockResolvedValue({ code: 0, stdout: '  22     1 100\n', stderr: '' });
    const stills = new Map([['%2:22', { content: WORKING, since: Date.now() - 60 * 60_000, cpu: 100 }]]);

    await watchCycle(root, {}, new Set(), new Map(), stills, { wedgeStillMs: 0 });
    expect((await readTeam(home)).agents[0].wedged_at).toBeUndefined();
    expect(await readDecisions(root)).toEqual([]);
    expect(stills.has('%2:22')).toBe(false);

    vi.mocked(buildStatus).mockResolvedValue(statusWithWait(false));
    await watchCycle(root, {}, new Set(), new Map(), stills, { wedgeStillMs: 0 });
    expect((await readTeam(home)).agents[0].wedged_at).toBeUndefined();
    expect(killWindow).not.toHaveBeenCalled();
    expect((await readDecisions(root)).map((d) => d.summary)).toEqual(['stale: demo/builder no output for 60m']);
  });

  it('a frozen screen with an advancing CPU tree is working, not wedged', async () => {
    const { root, home } = await setupProject({
      agents: [{ name: 'builder', pane: '%2', pane_pid: 22, pane_started: 'b', session_id: 'session_b' }],
    });
    vi.mocked(paneExists).mockResolvedValue(true);
    vi.mocked(capturePane).mockResolvedValue(WORKING);
    vi.mocked(wireLogMtime).mockResolvedValue(Date.now() - 60 * 60_000);
    let times = 100;
    vi.mocked(run).mockImplementation(async (cmd, args) => {
      if (cmd === 'ps' && args?.includes('pid=,ppid=,times=')) {
        times += 5;
        return { code: 0, stdout: `  22     1 ${times}\n`, stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const stills = new Map();
    await watchCycle(root, {}, new Set(), new Map(), stills, { wedgeStillMs: 0 });
    await watchCycle(root, {}, new Set(), new Map(), stills, { wedgeStillMs: 0 });
    const team = await readTeam(home);
    expect(team.agents[0].wedged_at).toBeUndefined();
    expect(killWindow).not.toHaveBeenCalled();
  });

  it('a fresh wire log reads as working, not wedged', async () => {
    const { root, home } = await setupProject({
      agents: [{ name: 'builder', pane: '%2', pane_pid: 22, pane_started: 'b', session_id: 'session_b' }],
    });
    vi.mocked(paneExists).mockResolvedValue(true);
    vi.mocked(capturePane).mockResolvedValue(WORKING);
    vi.mocked(wireLogMtime).mockResolvedValue(Date.now() + 60_000);
    const stills = new Map();
    await watchCycle(root, {}, new Set(), new Map(), stills, { wedgeStillMs: 0 });
    await watchCycle(root, {}, new Set(), new Map(), stills, { wedgeStillMs: 0 });
    const team = await readTeam(home);
    expect(team.agents[0].wedged_at).toBeUndefined();
    expect(killWindow).not.toHaveBeenCalled();
  });

  it('marks a wedged agent with no session but leaves the pane for the owner', async () => {
    const { root, home } = await setupProject({
      agents: [{ name: 'helper', pane: '%3', pane_pid: 33, pane_started: 'c' }],
    });
    vi.mocked(paneExists).mockResolvedValue(true);
    vi.mocked(capturePane).mockResolvedValue(WORKING);
    vi.mocked(run).mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const stills = new Map();
    await watchCycle(root, {}, new Set(), new Map(), stills, { wedgeStillMs: 0 });
    await watchCycle(root, {}, new Set(), new Map(), stills, { wedgeStillMs: 0 });
    const team = await readTeam(home);
    expect(team.agents[0].wedged_at).toBeTruthy();
    expect(killWindow).not.toHaveBeenCalled();
    const decisions = await readDecisions(root);
    expect(decisions[0].summary).toContain('left for the owner');
  });

  it('clears the mark when the pane moves again', async () => {
    const { root, home } = await setupProject({
      agents: [{
        name: 'builder', pane: '%2', pane_pid: 22, pane_started: 'b',
        session_id: 'session_b', wedged_at: new Date().toISOString(),
      }],
    });
    vi.mocked(paneExists).mockResolvedValue(true);
    vi.mocked(capturePane).mockResolvedValue('all done\n│ > \n');
    await watchCycle(root, {}, new Set(), new Map(), new Map(), { wedgeStillMs: 0 });
    const team = await readTeam(home);
    expect(team.agents[0].wedged_at).toBeUndefined();
    const log = await fs.readFile(hubPath(root, 'watch.log'), 'utf8');
    expect(log).toContain('cleared the wedged mark');
  });
});

describe('watchCycle auto-approver', () => {
  const dialogWith = (text: string) => ({
    kind: 'numbered' as const, text, cursor: null, esc: true, fingerprint: 'fp',
    project: 'demo', session: 'demo-orchestrator', pane: '%1',
    options: [
      { n: 1, label: 'Approve once', detail: '', offered: true, saves_rule: false },
      { n: 2, label: 'Approve for this session', detail: '', offered: true, saves_rule: true },
    ],
  });

  function withQuestion() {
    vi.mocked(buildStatus).mockResolvedValue({
      hub: { root: '' },
      projects: [{
        name: 'demo', home: '', repos: [], open_tasks: 0,
        orchestrator: { state: 'running', question: true }, agents: [],
      }],
    } as never);
  }

  // Every test drives the approver with its own verdicts/marks, so no test
  // ever touches the module-level cache or the module-level in-flight guard.
  const freshApprover = () => ({ verdicts: new Map<string, true>(), marks: new Set<string>() });
  const cycle = (root: string, s: { verdicts: Map<string, true>; marks: Set<string> }, env: NodeJS.ProcessEnv = {}) =>
    watchCycle(root, env, new Set(), new Map(), new Map(), { verdicts: s.verdicts, marks: s.marks });

  it('safe mode approves a whitelisted command with option 1', async () => {
    const { root } = await setupProject({ approvals: 'safe' });
    withQuestion();
    vi.mocked(readDialogFor).mockResolvedValue(dialogWith('Run this command?\n  $ ls -la && git status') as never);
    await cycle(root, freshApprover());
    expect(answerDialog).toHaveBeenCalledWith(root, 'demo', undefined, '1', 'fp');
    const decisions = await readDecisions(root);
    expect(decisions[0]).toMatchObject({ by: 'watch', project: 'demo' });
    expect(decisions[0].summary).toContain('auto-approved "Approve once"');
  });

  it('destructive text is never approved, even in smart mode (no kimi call)', async () => {
    const { root } = await setupProject({ approvals: 'smart' });
    withQuestion();
    vi.mocked(readDialogFor).mockResolvedValue(dialogWith('Run this command?\n  $ rm -rf /tmp/x') as never);
    vi.mocked(run).mockClear();
    await cycle(root, freshApprover());
    expect(answerDialog).not.toHaveBeenCalled();
    expect(vi.mocked(run).mock.calls.filter((c) => c[0] === 'kimi')).toEqual([]);
  });

  it('smart mode asks kimi about unknown commands and follows APPROVE/ASK', async () => {
    const { root } = await setupProject({ approvals: 'smart' });
    withQuestion();
    vi.mocked(readDialogFor).mockResolvedValue(dialogWith('Run this command?\n  $ python3 render_docs.py') as never);
    vi.mocked(run).mockImplementation(async (cmd) => (
      cmd === 'kimi'
        ? { code: 0, stdout: 'APPROVE — builds docs locally', stderr: '' }
        : { code: 0, stdout: '', stderr: '' }
    ));
    const s = freshApprover();
    await cycle(root, s);
    expect(answerDialog).toHaveBeenCalledTimes(1);

    // A new command, so the cached APPROVE above cannot answer for it.
    vi.mocked(answerDialog).mockClear();
    vi.mocked(readDialogFor).mockResolvedValue(dialogWith('Run this command?\n  $ python3 check_two.py') as never);
    vi.mocked(run).mockImplementation(async (cmd) => (
      cmd === 'kimi' ? { code: 0, stdout: 'ASK the owner', stderr: '' } : { code: 0, stdout: '', stderr: '' }
    ));
    await cycle(root, s);
    expect(answerDialog).not.toHaveBeenCalled();
    expect(s.verdicts.has('python3 check_two.py')).toBe(false);
  });

  it.each([undefined, 'manual'] as const)('auto mode directly answers a command with %s stored approvals', async (approvals) => {
    const { root } = await setupProject({ mode: 'auto', approvals });
    withQuestion();
    vi.mocked(readDialogFor).mockResolvedValue(dialogWith('Run this command?\n  $ python3 auto_mode_probe.py') as never);
    vi.mocked(run).mockImplementation(async (cmd) => {
      if (cmd === 'kimi') throw new Error('Auto must not classify');
      return { code: 0, stdout: '', stderr: '' };
    });

    await cycle(root, freshApprover());

    expect(answerDialog).toHaveBeenCalledWith(root, 'demo', undefined, '1', 'fp');
  });

  it('auto mode answers folder trust but not unrelated dialogs', async () => {
    const { root } = await setupProject({ mode: 'auto', approvals: 'manual' });
    withQuestion();
    vi.mocked(readDialogFor).mockResolvedValue({
      ...dialogWith('Trust this folder?'), kind: 'menu', cursor: 1,
      options: [{ n: 1, label: 'Trust and continue', detail: '', offered: true, saves_rule: false }],
    } as never);

    await cycle(root, freshApprover());
    expect(answerDialog).toHaveBeenCalledWith(root, 'demo', undefined, '1', 'fp');

    vi.mocked(answerDialog).mockClear();
    vi.mocked(readDialogFor).mockResolvedValue(dialogWith('Compact context?\nChoose how to compact') as never);
    await cycle(root, freshApprover());
    expect(answerDialog).not.toHaveBeenCalled();
  });

  it('auto mode uses an offered non-saving option', async () => {
    const { root } = await setupProject({ mode: 'auto' });
    withQuestion();
    vi.mocked(readDialogFor).mockResolvedValue({
      ...dialogWith('Run this command?\n  $ python3 auto_mode_probe.py'),
      options: [
        { n: 1, label: 'Always allow', detail: '', offered: true, saves_rule: true },
        { n: 2, label: 'Approve once', detail: '', offered: true, saves_rule: false },
      ],
    } as never);

    await cycle(root, freshApprover());

    expect(answerDialog).toHaveBeenCalledWith(root, 'demo', undefined, '2', 'fp');
  });

  it('non-auto mode with manual approvals never answers', async () => {
    const { root } = await setupProject({ approvals: 'manual' });
    withQuestion();
    vi.mocked(readDialogFor).mockResolvedValue(dialogWith('Run this command?\n  $ python3 auto_mode_probe.py') as never);
    vi.mocked(run).mockImplementation(async (cmd) => (
      cmd === 'kimi' ? { code: 0, stdout: 'APPROVE ordinary command', stderr: '' } : { code: 0, stdout: '', stderr: '' }
    ));
    await cycle(root, freshApprover());
    expect(answerDialog).not.toHaveBeenCalled();
  });

  const kimiCalls = () => vi.mocked(run).mock.calls.filter((c) => c[0] === 'kimi');

  it('caches an APPROVE by command: one spawn, the next dialog answers from cache', async () => {
    const { root } = await setupProject({ approvals: 'smart' });
    withQuestion();
    vi.mocked(readDialogFor).mockResolvedValue(dialogWith('Run this command?\n  $ python3 cache_probe.py') as never);
    vi.mocked(run).mockImplementation(async (cmd) => (
      cmd === 'kimi' ? { code: 0, stdout: 'APPROVE cached probe', stderr: '' } : { code: 0, stdout: '', stderr: '' }
    ));
    const s = freshApprover();
    await cycle(root, s);
    expect(answerDialog).toHaveBeenCalledTimes(1);
    expect(kimiCalls()).toHaveLength(1);

    vi.mocked(answerDialog).mockClear();
    vi.mocked(readDialogFor).mockResolvedValue({
      ...dialogWith('Run this command?\n  $ python3 cache_probe.py'), fingerprint: 'fp2',
    } as never);
    await cycle(root, s);
    expect(answerDialog).toHaveBeenCalledWith(root, 'demo', undefined, '1', 'fp2');
    expect(kimiCalls()).toHaveLength(1);
  });

  it('the cache key collapses whitespace: `a  b` and `a b` share a verdict', async () => {
    const { root } = await setupProject({ approvals: 'smart' });
    withQuestion();
    vi.mocked(readDialogFor).mockResolvedValue(dialogWith('Run this command?\n  $ python3  space_probe.py  --fast') as never);
    vi.mocked(run).mockImplementation(async (cmd) => (
      cmd === 'kimi' ? { code: 0, stdout: 'APPROVE spaced probe', stderr: '' } : { code: 0, stdout: '', stderr: '' }
    ));
    const s = freshApprover();
    await cycle(root, s);
    expect(kimiCalls()).toHaveLength(1);
    expect(s.verdicts.has('python3 space_probe.py --fast')).toBe(true);

    vi.mocked(answerDialog).mockClear();
    vi.mocked(readDialogFor).mockResolvedValue({
      ...dialogWith('Run this command?\n  $ python3 space_probe.py --fast'), fingerprint: 'fp2',
    } as never);
    await cycle(root, s);
    expect(answerDialog).toHaveBeenCalledTimes(1);
    expect(kimiCalls()).toHaveLength(1);
  });

  it('never-approve beats a cached APPROVE', async () => {
    const { root } = await setupProject({ approvals: 'smart' });
    withQuestion();
    const s = freshApprover();
    s.verdicts.set('python3 cache_probe.py', true);
    vi.mocked(readDialogFor).mockResolvedValue(
      dialogWith('Run this command?\n  $ python3 cache_probe.py\n  note: this also runs rm -rf build') as never,
    );
    await cycle(root, s);
    expect(answerDialog).not.toHaveBeenCalled();
  });

  it('an ASK verdict is never cached: the next cycle re-classifies', async () => {
    const { root } = await setupProject({ approvals: 'smart' });
    withQuestion();
    vi.mocked(readDialogFor).mockResolvedValue(dialogWith('Run this command?\n  $ python3 ask_probe.py') as never);
    let verdict = 'ASK the owner';
    vi.mocked(run).mockImplementation(async (cmd) => (
      cmd === 'kimi' ? { code: 0, stdout: verdict, stderr: '' } : { code: 0, stdout: '', stderr: '' }
    ));
    const s = freshApprover();
    await cycle(root, s);
    expect(answerDialog).not.toHaveBeenCalled();
    expect(s.verdicts.has('python3 ask_probe.py')).toBe(false);
    verdict = 'APPROVE on the second look';
    await cycle(root, s);
    expect(answerDialog).toHaveBeenCalledTimes(1);
    expect(kimiCalls()).toHaveLength(2);
  });

  it('two overlapping cycles spawn one classifier for one dialog', async () => {
    const { root } = await setupProject({ approvals: 'smart' });
    withQuestion();
    vi.mocked(readDialogFor).mockResolvedValue(dialogWith('Run this command?\n  $ python3 inflight_probe.py') as never);
    let release!: (r: { code: number; stdout: string; stderr: string }) => void;
    let markParked!: () => void;
    const parked = new Promise<void>((r) => { markParked = r; });
    const latch = new Promise<{ code: number; stdout: string; stderr: string }>((r) => { release = r; });
    vi.mocked(run).mockImplementation(async (cmd) => {
      if (cmd !== 'kimi') return { code: 0, stdout: '', stderr: '' };
      markParked();
      return latch;
    });
    // Both cycles share one approver state: the guard under test is the seam.
    const s = freshApprover();
    const c1 = cycle(root, s);
    try {
      // The park is observed from inside the mock, not guessed by turns.
      await withTimeout(parked, 10_000, 'classifier park');
      // Cycle 2 runs to completion with the latch held: the guard must make
      // it skip the dialog, so no second spawn and no answer at all yet.
      await cycle(root, s);
      expect(kimiCalls()).toHaveLength(1);
      expect(answerDialog).not.toHaveBeenCalled();
    } finally {
      // Always release and drain cycle 1, so a failed assertion can never
      // abandon a parked cycle into later tests.
      release({ code: 0, stdout: 'APPROVE after the wait', stderr: '' });
      await c1;
    }
    expect(kimiCalls()).toHaveLength(1);
    expect(answerDialog).toHaveBeenCalledTimes(1);
  });

  it.each([
    'npm ci', 'npm install', 'npx vitest run', 'npm test', 'npx jest',
    'cargo build --release', 'make all', 'docker build .', 'pip install requests',
  ])('heavy compute waits for a human even in smart mode: %s', async (cmd) => {
    const { root } = await setupProject({ approvals: 'smart' });
    withQuestion();
    vi.mocked(readDialogFor).mockResolvedValue(dialogWith(`Run this command?\n  $ ${cmd}`) as never);
    await cycle(root, freshApprover());
    expect(answerDialog).not.toHaveBeenCalled();
    expect(kimiCalls()).toEqual([]);
  });

  it('applies blank-aware classifier model precedence', async () => {
    const { root } = await setupProject({ approvals: 'smart' });
    withQuestion();
    vi.mocked(readDialogFor).mockResolvedValue(dialogWith('Run this command?\n  $ python3 model_probe.py') as never);
    vi.mocked(run).mockImplementation(async (cmd) => (
      cmd === 'kimi' ? { code: 0, stdout: 'ASK the owner', stderr: '' } : { code: 0, stdout: '', stderr: '' }
    ));
    const s = freshApprover();
    process.env.HIVE_CLASSIFIER_MODEL = 'cheap-model';
    try {
      await cycle(root, s);
    } finally {
      delete process.env.HIVE_CLASSIFIER_MODEL;
    }
    await cycle(root, s);
    await cycle(root, s, { HIVE_CLASSIFIER_MODEL: '' });
    await cycle(root, s, { HIVE_CLASSIFIER_MODEL: ' \t ' });
    process.env.HIVE_CLASSIFIER_MODEL = ' \t ';
    try {
      await cycle(root, s);
    } finally {
      delete process.env.HIVE_CLASSIFIER_MODEL;
    }
    process.env.HIVE_CLASSIFIER_MODEL = ' process-model ';
    try {
      await cycle(root, s, { HIVE_CLASSIFIER_MODEL: '  ' });
    } finally {
      delete process.env.HIVE_CLASSIFIER_MODEL;
    }
    expect(kimiCalls()[0][1]).toEqual(['-m', 'cheap-model', '-p', expect.any(String)]);
    expect(kimiCalls().map((call) => call[1][1])).toEqual([
      'cheap-model', 'kimi-code/k3.1-pro', 'kimi-code/k3.1-pro',
      'kimi-code/k3.1-pro', 'kimi-code/k3.1-pro', ' process-model ',
    ]);
  });
});

describe('watchCycle stale-lane heartbeat', () => {
  const idlePane = 'all done\n│ > \n';

  it('a wire log silent for 15m raises one stale decision, not one per cycle', async () => {
    const { root } = await setupProject({
      agents: [{ name: 'builder', pane: '%2', pane_pid: 22, pane_started: 'b', session_id: 'session_b' }],
    });
    vi.mocked(paneExists).mockResolvedValue(true);
    vi.mocked(capturePane).mockResolvedValue(idlePane);
    vi.mocked(wireLogMtime).mockResolvedValue(Date.now() - 20 * 60_000);
    const deaths = new Set<string>();
    await watchCycle(root, {}, deaths);
    let decisions = await readDecisions(root);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ by: 'watch', project: 'demo' });
    expect(decisions[0].summary).toMatch(/^stale: demo\/builder no output for \d+m$/);

    await watchCycle(root, {}, deaths);
    decisions = await readDecisions(root);
    expect(decisions).toHaveLength(1);
  });

  it('the stale record survives a restart: same hour still silent', async () => {
    const { root } = await setupProject({
      agents: [{ name: 'builder', pane: '%2', pane_pid: 22, pane_started: 'b', session_id: 'session_b' }],
    });
    vi.mocked(paneExists).mockResolvedValue(true);
    vi.mocked(capturePane).mockResolvedValue(idlePane);
    vi.mocked(wireLogMtime).mockResolvedValue(Date.now() - 20 * 60_000);
    await watchCycle(root, {}, new Set());
    expect(await readDecisions(root)).toHaveLength(1);

    const restored = await loadProcessedKeys(root);
    await watchCycle(root, {}, restored);
    expect(await readDecisions(root)).toHaveLength(1);
  });

  it('a fresh wire log raises no stale flag', async () => {
    const { root } = await setupProject({
      agents: [{ name: 'builder', pane: '%2', pane_pid: 22, pane_started: 'b', session_id: 'session_b' }],
    });
    vi.mocked(paneExists).mockResolvedValue(true);
    vi.mocked(capturePane).mockResolvedValue(idlePane);
    vi.mocked(wireLogMtime).mockResolvedValue(Date.now());
    await watchCycle(root, {}, new Set());
    expect(await readDecisions(root)).toHaveLength(0);
  });
});

describe('death bundle capture', () => {
  const agent = {
    name: 'demo-orchestrator', orchestrator: true,
    pane: '%1', pane_pid: 11, pane_started: 'a', session_id: 'session_abc',
  };

  async function fakeWireLog(home: string): Promise<void> {
    const dir = path.join(home, '.kimi-code', 'sessions', 'wd_x', 'session_abc', 'agents', 'main');
    await fs.mkdir(dir, { recursive: true });
    const lines = [
      { type: 'turn.prompt', time: 1760000000000, prompt: 'secret prompt text' },
      { type: 'step.end', time: 1760000001000 },
      { type: 'turn.ended', time: 1760000002000 },
    ];
    await fs.writeFile(path.join(dir, 'wire.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  it('writes a bundle with every section, and wire types+times only', async () => {
    const root = tmp();
    const home = tmp();
    await fakeWireLog(home);
    const distFile = path.join(tmp(), 'cli.js');
    await fs.writeFile(distFile, 'x');
    stubProbes();
    const file = await captureDeathBundle(root, 'demo', agent, { home, distFile });
    expect(path.dirname(file)).toBe(hubPath(root, 'deaths'));
    expect(path.basename(file)).toMatch(/^demo-demo-orchestrator-\d+\.log$/);
    const text = await fs.readFile(file, 'utf8');
    for (const section of [
      '== watchdog record ==', '== tmux server (socket', '== dead process evidence ==',
      '== kimi wire log tail ==', '== deploy correlation ==', '== exit evidence ==',
    ]) {
      expect(text).toContain(section);
    }
    expect(text).toContain('pane: %1');
    expect(text).toContain('no process with pid 11 (confirmed gone)');
    expect(text).toContain('oom line');
    expect(text).toContain(`${new Date(1760000001000).toISOString()} step.end`);
    expect(text).toContain(`${new Date(1760000002000).toISOString()} turn.ended`);
    expect(text).not.toContain('secret prompt text');
    expect(text).toContain('deploy within 10 minutes before death: yes');
    expect(text).toContain('remain-on-exit pane output: unavailable (the pane is already gone)');
  });

  it('a failing dmesg probe is recorded and the bundle still ships', async () => {
    const root = tmp();
    const home = tmp();
    await fakeWireLog(home);
    const distFile = path.join(tmp(), 'cli.js');
    await fs.writeFile(distFile, 'x');
    stubProbes({ code: 1, stdout: '', stderr: 'dmesg: read kernel buffer failed: Operation not permitted' });
    const file = await captureDeathBundle(root, 'demo', agent, { home, distFile });
    const text = await fs.readFile(file, 'utf8');
    expect(text).toContain('dmesg: unavailable (dmesg: read kernel buffer failed: Operation not permitted)');
    expect(text).toContain('== kimi wire log tail ==');
    expect(text).toContain('== exit evidence ==');
  });

  it('watchCycle captures the bundle, logs its path, and still wakes the orchestrator', async () => {
    const { root } = await setupProject({
      agents: [{ name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 11, pane_started: 'a' }],
    });
    vi.mocked(paneExists).mockResolvedValue(false);
    stubProbes();
    await watchCycle(root, {}, new Set());
    const deathsDir = hubPath(root, 'deaths');
    const files = await fs.readdir(deathsDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^demo-demo-orchestrator-\d+\.log$/);
    const log = await fs.readFile(hubPath(root, 'watch.log'), 'utf8');
    expect(log).toContain(`death bundle: ${path.join(deathsDir, files[0])}`);
    expect(wake).toHaveBeenCalledWith(root, 'demo');
    const text = await fs.readFile(path.join(deathsDir, files[0]), 'utf8');
    expect(text).toContain('wire-log: unavailable (no session_id in the team entry)');
  });
});
