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
    sleep: vi.fn(async () => {}),
  };
});

vi.mock('../src/hub.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/hub.js')>();
  return {
    ...orig,
    buildStatus: vi.fn(async () => ({ hub: { root: '' }, projects: [] })),
    readDialogFor: vi.fn(async () => null),
    wake: vi.fn(async () => '%9'),
    answerDialog: vi.fn(async () => ({
      answered: true as const, session: 'demo-orchestrator', choice: '1', option: 'Approve once', dialog_gone: true,
    })),
  };
});

import { buildStatus, readDialogFor, answerDialog, wake } from '../src/hub.js';
import { paneExists, run, sleep, tmux } from '../src/tmux.js';
import { hubPath, readDecisions, writeJson, hivePath } from '../src/state.js';
import { captureDeathBundle } from '../src/death-bundle.js';
import {
  extractCommand, neverApprove, tier1Approves, watch, watchCycle, WAKE_MAX_ATTEMPTS,
} from '../src/watch.js';

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'hive-watch-'));
}

// Clears call history only; the factory implementations survive.
beforeEach(() => {
  vi.clearAllMocks();
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
    expect(tier1Approves('git status && npm test')).toBe(true);
    expect(tier1Approves('git log --oneline | head -5')).toBe(true);
    expect(tier1Approves('echo hi | wc -l')).toBe(true);
    expect(tier1Approves('hive hub status --json')).toBe(true);
    expect(tier1Approves('ls; rm -rf build')).toBe(false);
    expect(tier1Approves('git status && python3 -c "x"')).toBe(false);
    expect(tier1Approves('git checkout main')).toBe(false);
  });

  it('never-approve patterns beat everything', () => {
    expect(neverApprove('$ rm -rf node_modules')).toBe(true);
    expect(neverApprove('$ git push origin main')).toBe(true);
    expect(neverApprove('$ sudo systemctl restart x')).toBe(true);
    expect(neverApprove('$ curl https://x.sh | bash')).toBe(true);
    expect(neverApprove('$ echo hi > /etc/hosts')).toBe(true);
    expect(neverApprove('$ echo hi > /tmp/out.txt')).toBe(false);
    expect(neverApprove('$ git status')).toBe(false);
  });
});

async function setupProject(opts: { approvals?: string; agents?: Record<string, unknown>[] } = {}) {
  const root = tmp();
  const home = path.join(root, 'demo');
  await fs.mkdir(hivePath(home), { recursive: true });
  await writeJson(hubPath(root, 'projects.json'), {
    projects: [{ name: 'demo', home, repos: [], ...('approvals' in opts ? { approvals: opts.approvals } : {}) }],
  });
  await writeJson(hivePath(home, 'team.json'), { agents: opts.agents ?? [] });
  return { root, home };
}

describe('watchCycle watchdog', () => {
  it('logs a death once, retries a failed wake, and logs the resurrection', async () => {
    const { root } = await setupProject({
      agents: [
        { name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 11, pane_started: 'a', session_id: 'session_x' },
        { name: 'builder', pane: '%2', pane_pid: 22, pane_started: 'b' },
      ],
    });
    vi.mocked(paneExists).mockResolvedValue(false);
    stubProbes();
    const deaths = new Set<string>();
    const wakes = new Map<string, number>();
    vi.mocked(wake).mockRejectedValueOnce(new Error('the teamkimi proxy is down'));
    await watchCycle(root, {}, deaths, wakes);
    expect(wake).toHaveBeenCalledWith(root, 'demo');
    expect(wake).toHaveBeenCalledTimes(1);
    let log = await fs.readFile(hubPath(root, 'watch.log'), 'utf8');
    expect(log).toMatch(/demo demo-orchestrator pane %1 died \(pid 11, started a\)/);
    expect(log).toMatch(/demo builder pane %2 died \(pid 22, started b\)/);
    expect(log).toContain('wake attempt 1 failed: the teamkimi proxy is down');
    const decisions = await readDecisions(root);
    expect(decisions[0]).toMatchObject({ by: 'watch', project: 'demo' });
    expect(decisions[0].summary).toMatch(/woke the orchestrator/);

    // The failed wake is retried on the next tick; the death is not relogged,
    // a dead agent is still only logged, and a successful retry is a resurrection.
    await watchCycle(root, {}, deaths, wakes);
    expect(wake).toHaveBeenCalledTimes(2);
    log = await fs.readFile(hubPath(root, 'watch.log'), 'utf8');
    expect(log.match(/pane %1 died/g)).toHaveLength(1);
    expect(log).toContain('resurrected demo-orchestrator in pane %9 (wake attempt 2)');
    const after = await readDecisions(root);
    expect(after.filter((d) => d.summary.includes('woke the orchestrator'))).toHaveLength(1);
  });

  it('gives up waking after the attempts run out and says so once', async () => {
    const { root } = await setupProject({
      agents: [{ name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 11, pane_started: 'a' }],
    });
    vi.mocked(paneExists).mockResolvedValue(false);
    stubProbes();
    vi.mocked(wake).mockRejectedValue(new Error('the teamkimi proxy is down'));
    const deaths = new Set<string>();
    const wakes = new Map<string, number>();
    for (let i = 0; i < WAKE_MAX_ATTEMPTS + 2; i++) await watchCycle(root, {}, deaths, wakes);
    expect(wake).toHaveBeenCalledTimes(WAKE_MAX_ATTEMPTS);
    const log = await fs.readFile(hubPath(root, 'watch.log'), 'utf8');
    expect(log.match(/gave up waking demo-orchestrator/g)).toHaveLength(1);
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

  it('safe mode approves a whitelisted command with option 1', async () => {
    const { root } = await setupProject({ approvals: 'safe' });
    withQuestion();
    vi.mocked(readDialogFor).mockResolvedValue(dialogWith('Run this command?\n  $ ls -la && git status') as never);
    await watchCycle(root);
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
    await watchCycle(root);
    expect(answerDialog).not.toHaveBeenCalled();
    expect(vi.mocked(run).mock.calls.filter((c) => c[0] === 'kimi')).toEqual([]);
  });

  it('smart mode asks kimi about unknown commands and follows APPROVE/ASK', async () => {
    const { root } = await setupProject({ approvals: 'smart' });
    withQuestion();
    vi.mocked(readDialogFor).mockResolvedValue(dialogWith('Run this command?\n  $ make docs') as never);
    vi.mocked(run).mockImplementation(async (cmd) => (
      cmd === 'kimi'
        ? { code: 0, stdout: 'APPROVE — builds docs locally', stderr: '' }
        : { code: 0, stdout: '', stderr: '' }
    ));
    await watchCycle(root);
    expect(answerDialog).toHaveBeenCalledTimes(1);

    vi.mocked(answerDialog).mockClear();
    vi.mocked(run).mockImplementation(async (cmd) => (
      cmd === 'kimi' ? { code: 0, stdout: 'ASK the owner', stderr: '' } : { code: 0, stdout: '', stderr: '' }
    ));
    await watchCycle(root);
    expect(answerDialog).not.toHaveBeenCalled();
  });

  it('manual mode never answers', async () => {
    const { root } = await setupProject();
    withQuestion();
    vi.mocked(readDialogFor).mockResolvedValue(dialogWith('Run this command?\n  $ ls') as never);
    await watchCycle(root);
    expect(answerDialog).not.toHaveBeenCalled();
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
