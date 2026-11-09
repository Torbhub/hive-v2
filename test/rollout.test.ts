import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hivePath, hubPath, readProjects, writeJson } from '../src/state.js';
import { disableExecution } from '../src/rollout.js';

const tmux = await import('../src/tmux.js');
const { launchWindow, respawnAgent, spawnAgent } = await import('../src/spawn.js');
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.HIVE_COLLABORATION_ENABLED;
});

async function projectRoot() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'hive-rollout-'));
  const home = path.join(root, 'demo');
  await fs.mkdir(home, { recursive: true });
  await writeJson(hubPath(root, 'projects.json'), {
    projects: [{ name: 'demo', home, repos: [{ folder: home }] }],
  });
  return { root, home };
}

function cli(root: string, args: string[]) {
  const tsx = path.join(repository, 'node_modules', '.bin', 'tsx');
  return spawnSync(tsx, [path.join(repository, 'src', 'cli.ts'), ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
}

describe('project execution rollout control', () => {
  it('turns execution off once, reports status, and offers no on command', async () => {
    const { root } = await projectRoot();
    const first = cli(root, ['hub', 'execution', 'demo', 'off']);
    expect(first.status).toBe(0);
    expect(first.stdout).toMatch(/demo execution disabled at /);
    const disabledAt = (await readProjects(root)).projects[0].collaboration_execution_disabled_at;
    expect(disabledAt).toEqual(expect.any(String));

    const second = cli(root, ['hub', 'execution', 'demo', 'off']);
    expect(second.status).toBe(0);
    expect((await readProjects(root)).projects[0].collaboration_execution_disabled_at).toBe(disabledAt);

    const status = cli(root, ['hub', 'execution', 'demo', 'status']);
    expect(status.status).toBe(0);
    expect(status.stdout).toContain(disabledAt);
    expect(cli(root, ['hub', 'execution', 'demo', 'on']).status).toBe(64);
  });

  it('stops only the paused project before its agent profile or a new pane', async () => {
    const { root, home } = await projectRoot();
    await disableExecution(root, 'demo');
    process.env.HIVE_COLLABORATION_ENABLED = '1';
    const newWindow = vi.spyOn(tmux, 'newWindow');
    await expect(launchWindow(root, 'demo', 'builder', home)).rejects.toThrow('rollout paused for demo');
    expect(newWindow).not.toHaveBeenCalled();
    expect(await fs.stat(hivePath(home, 'team', 'builder', 'agent.md')).catch(() => null)).toBeNull();

    const otherHome = path.join(root, 'other');
    const credentialFile = hivePath(otherHome, 'team', 'builder', 'credential.env');
    await fs.mkdir(path.dirname(credentialFile), { recursive: true });
    await fs.writeFile(credentialFile, "HIVE_AGENT_CREDENTIAL='hva1.builder.fedcba9876543210.test-secret-with-high-entropy'\n", { mode: 0o600 });
    const pf = await readProjects(root);
    await writeJson(hubPath(root, 'projects.json'), {
      projects: [...pf.projects, { name: 'other', home: otherHome, repos: [{ folder: otherHome }] }],
    });
    newWindow.mockResolvedValue('%2');
    vi.spyOn(tmux, 'paneIdentity').mockResolvedValue({ pid: 2, started: 'now' });
    await expect(launchWindow(root, 'other', 'builder', otherHome)).resolves.toEqual({
      pane: '%2', identity: { pid: 2, started: 'now' },
    });
  });

  it('fails closed for missing or corrupt enabled config but not for legacy config', async () => {
    for (const contents of [null, '{"projects": [']) {
      const root = await fs.mkdtemp(path.join(tmpdir(), 'hive-rollout-config-'));
      const home = path.join(root, 'demo');
      await fs.mkdir(home, { recursive: true });
      if (contents !== null) {
        await fs.mkdir(hubPath(root), { recursive: true });
        await fs.writeFile(hubPath(root, 'projects.json'), contents);
      }
      process.env.HIVE_COLLABORATION_ENABLED = '1';
      const newWindow = vi.spyOn(tmux, 'newWindow');
      await expect(launchWindow(root, 'demo', 'builder', home)).rejects.toThrow('rollout paused for demo');
      expect(newWindow).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }

    const root = await fs.mkdtemp(path.join(tmpdir(), 'hive-rollout-legacy-'));
    const home = path.join(root, 'demo');
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(hubPath(root), { recursive: true });
    await fs.writeFile(hubPath(root, 'projects.json'), '{"projects": [');
    delete process.env.HIVE_COLLABORATION_ENABLED;
    vi.spyOn(tmux, 'newWindow').mockResolvedValue('%1');
    vi.spyOn(tmux, 'paneIdentity').mockResolvedValue({ pid: 1, started: 'now' });
    await expect(launchWindow(root, 'demo', 'builder', home)).resolves.toEqual({
      pane: '%1', identity: { pid: 1, started: 'now' },
    });
  });

  it('stops paused spawn and respawn before preflight or killing the old pane', async () => {
    const { root, home } = await projectRoot();
    const handoff = hivePath(home, 'handoffs', 'builder.md');
    await fs.mkdir(path.dirname(handoff), { recursive: true });
    await fs.writeFile(handoff, '# builder\n\n## START HERE\n### Assignment\nComplete the bounded rollout assignment.\n\n### Deliverable\nReturn the bounded rollout evidence.\n');
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'builder', pane: '%1', pane_pid: 1, pane_started: 'now', worktree: home, handoff }],
    });
    await disableExecution(root, 'demo');
    process.env.HIVE_COLLABORATION_ENABLED = '1';
    const run = vi.spyOn(tmux, 'run').mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    const killWindow = vi.spyOn(tmux, 'killWindow').mockResolvedValue();
    await expect(spawnAgent(root, 'demo', {
      agent: 'builder2',
      assignment: 'Complete the bounded rollout test assignment.',
      deliverable: 'Return evidence that preflight never ran.',
    })).rejects.toThrow('rollout paused for demo');
    expect(run).not.toHaveBeenCalled();

    await expect(respawnAgent(root, 'demo', 'builder')).rejects.toThrow('rollout paused for demo');
    expect(run).not.toHaveBeenCalled();
    expect(killWindow).not.toHaveBeenCalled();
  });

  it('rechecks the pause at launch when off lands during preflight', async () => {
    const { root, home } = await projectRoot();
    process.env.HIVE_COLLABORATION_ENABLED = '1';
    vi.spyOn(tmux, 'run').mockImplementation(async (command) => {
      if (command === 'teamkimi') {
        await disableExecution(root, 'demo');
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: '' };
    });
    const newWindow = vi.spyOn(tmux, 'newWindow');
    await expect(spawnAgent(root, 'demo', {
      agent: 'builder',
      assignment: 'Complete the bounded rollout test assignment.',
      deliverable: 'Return evidence that no pane launched after the pause.',
    })).rejects.toThrow('rollout paused for demo');
    expect(newWindow).not.toHaveBeenCalled();
    expect(await fs.stat(hivePath(home, 'lanes', 'builder', '.hive', 'team', 'builder', 'agent.md')).catch(() => null)).toBeNull();
  });

  it('rechecks immediately before newWindow when credential validation pauses the project', async () => {
    const { root, home } = await projectRoot();
    const credentialFile = hivePath(home, 'team', 'builder', 'credential.env');
    await fs.mkdir(path.dirname(credentialFile), { recursive: true });
    await fs.writeFile(credentialFile, "HIVE_AGENT_CREDENTIAL='hva1.builder.fedcba9876543210.test-secret-with-high-entropy'\n", { mode: 0o600 });
    process.env.HIVE_COLLABORATION_ENABLED = '1';
    const credentials = await import('../src/collaboration-credentials.js');
    const validate = credentials.requireAgentCredential;
    vi.spyOn(credentials, 'requireAgentCredential').mockImplementation(async (cwd, project, agent) => {
      await disableExecution(root, 'demo');
      return validate(cwd, project, agent);
    });
    const newWindow = vi.spyOn(tmux, 'newWindow').mockResolvedValue('%1');
    await expect(launchWindow(root, 'demo', 'builder', home)).rejects.toThrow('rollout paused for demo');
    expect(newWindow).not.toHaveBeenCalled();
  });

  it('rechecks after respawn preflight before stamping closed or killing the old pane', async () => {
    const { root, home } = await projectRoot();
    const handoff = hivePath(home, 'handoffs', 'builder.md');
    await fs.mkdir(path.dirname(handoff), { recursive: true });
    await fs.writeFile(handoff, '# builder\n\n## START HERE\n### Assignment\nComplete the bounded rollout assignment.\n\n### Deliverable\nReturn the bounded rollout evidence.\n');
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'builder', pane: '%1', pane_pid: 1, pane_started: 'now', worktree: home, handoff }],
    });
    process.env.HIVE_COLLABORATION_ENABLED = '1';
    vi.spyOn(tmux, 'run').mockImplementation(async (command) => {
      if (command === 'teamkimi') await disableExecution(root, 'demo');
      return { code: 0, stdout: '', stderr: '' };
    });
    const killWindow = vi.spyOn(tmux, 'killWindow').mockResolvedValue();
    await expect(respawnAgent(root, 'demo', 'builder')).rejects.toThrow('rollout paused for demo');
    expect(killWindow).not.toHaveBeenCalled();
    const team = await (await import('../src/state.js')).readTeam(home);
    expect(team.agents[0].closed_at).toBeUndefined();
  });

  it('rechecks worker spawn after waitIdleForMode before typing', async () => {
    const { root } = await projectRoot();
    const idle = await fs.readFile(path.join(repository, 'test', 'fixtures', 'idle-empty-prompt.txt'), 'utf8');
    process.env.HIVE_COLLABORATION_ENABLED = '1';
    vi.useFakeTimers();
    const credentials = await import('../src/collaboration-credentials.js');
    vi.spyOn(credentials, 'requireAgentCredential').mockResolvedValue();
    vi.spyOn(tmux, 'run').mockImplementation(async (command) => ({
      code: command === 'teamkimi' ? 0 : 1, stdout: '', stderr: '',
    }));
    vi.spyOn(tmux, 'newWindow').mockResolvedValue('%9');
    vi.spyOn(tmux, 'paneIdentity').mockResolvedValue({ pid: 1, started: 'now' });
    vi.spyOn(tmux, 'paneIs').mockResolvedValue(true);
    vi.spyOn(tmux, 'sleep').mockImplementation((ms) => vi.advanceTimersByTimeAsync(ms));
    vi.spyOn(tmux, 'capturePane').mockImplementation(async () => {
      await disableExecution(root, 'demo');
      return idle;
    });
    vi.spyOn(tmux, 'sendEnter').mockResolvedValue();
    const sendLiteral = vi.spyOn(tmux, 'sendLiteral').mockResolvedValue();
    await expect(spawnAgent(root, 'demo', {
      agent: 'builder',
      assignment: 'Complete the bounded rollout test assignment.',
      deliverable: 'Return evidence that no input followed the pause.',
    })).rejects.toThrow('rollout paused for demo');
    expect(sendLiteral).not.toHaveBeenCalled();
  });

  it('rechecks respawn after waitIdleForMode before typing', async () => {
    const { root, home } = await projectRoot();
    const idle = await fs.readFile(path.join(repository, 'test', 'fixtures', 'idle-empty-prompt.txt'), 'utf8');
    const handoff = hivePath(home, 'handoffs', 'builder.md');
    await fs.mkdir(path.dirname(handoff), { recursive: true });
    await fs.writeFile(handoff, '# builder\n\n## START HERE\n### Assignment\nComplete the bounded rollout assignment.\n\n### Deliverable\nReturn the bounded rollout evidence.\n');
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'builder', pane: '%1', pane_pid: 1, pane_started: 'now', worktree: home, handoff }],
    });
    process.env.HIVE_COLLABORATION_ENABLED = '1';
    vi.useFakeTimers();
    const credentials = await import('../src/collaboration-credentials.js');
    vi.spyOn(credentials, 'requireAgentCredential').mockResolvedValue();
    vi.spyOn(tmux, 'run').mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    vi.spyOn(tmux, 'killWindow').mockResolvedValue();
    vi.spyOn(tmux, 'newWindow').mockResolvedValue('%9');
    vi.spyOn(tmux, 'paneIdentity').mockResolvedValue({ pid: 1, started: 'now' });
    vi.spyOn(tmux, 'paneIs').mockResolvedValue(true);
    vi.spyOn(tmux, 'sleep').mockImplementation((ms) => vi.advanceTimersByTimeAsync(ms));
    vi.spyOn(tmux, 'capturePane').mockImplementation(async () => {
      await disableExecution(root, 'demo');
      return idle;
    });
    vi.spyOn(tmux, 'sendEnter').mockResolvedValue();
    const sendLiteral = vi.spyOn(tmux, 'sendLiteral').mockResolvedValue();
    await expect(respawnAgent(root, 'demo', 'builder')).rejects.toThrow('rollout paused for demo');
    expect(sendLiteral).not.toHaveBeenCalled();
  });

  it('fails closed on malformed pause markers in status and repeated off', async () => {
    for (const marker of ['', 'not-a-timestamp']) {
      const { root } = await projectRoot();
      const pf = await readProjects(root);
      await writeJson(hubPath(root, 'projects.json'), {
        projects: [{ ...pf.projects[0], collaboration_execution_disabled_at: marker }],
      });
      for (const action of ['status', 'off']) {
        const result = cli(root, ['hub', 'execution', 'demo', action]);
        expect(result.status).toBe(1);
        expect(result.stdout).not.toContain('execution enabled');
        expect(result.stderr).toContain('rollout paused for demo');
      }
      expect((await readProjects(root)).projects[0].collaboration_execution_disabled_at).toBe(marker);
    }
  });

  it('preserves a pause across interleaved project config writes', async () => {
    const state = await import('../src/state.js');
    const { hubInit, setProjectApprovals, setProjectMode } = await import('../src/hub.js');
    for (const action of ['mode', 'approvals', 'init'] as const) {
      const { root } = await projectRoot();
      const actualRead = state.readProjects;
      const actualWrite = state.writeProjects;
      let releaseRead!: () => void;
      let markRead!: () => void;
      let markPauseWritten!: () => void;
      const readEntered = new Promise<void>((resolve) => { markRead = resolve; });
      const pauseWritten = new Promise<void>((resolve) => { markPauseWritten = resolve; });
      const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
      let first = true;
      vi.spyOn(state, 'readProjects').mockImplementation(async (root) => {
        const pf = await actualRead(root);
        if (first) {
          first = false;
          markRead();
          await readGate;
        }
        return pf;
      });
      vi.spyOn(state, 'writeProjects').mockImplementation(async (root, pf) => {
        await actualWrite(root, pf);
        if (pf.projects.some((project) => project.collaboration_execution_disabled_at !== undefined)) markPauseWritten();
      });
      const changing = action === 'mode' ? setProjectMode(root, 'demo', 'yolo')
        : action === 'approvals' ? setProjectApprovals(root, 'demo', 'safe') : hubInit(root);
      await readEntered;
      const pausing = disableExecution(root, 'demo');
      await Promise.race([pauseWritten, new Promise((resolve) => setImmediate(resolve))]);
      releaseRead();
      await Promise.all([changing, pausing]);
      const project = (await actualRead(root)).projects[0];
      expect(project.collaboration_execution_disabled_at).toEqual(expect.any(String));
      if (action === 'mode') expect(project.mode).toBe('yolo');
      if (action === 'approvals') expect(project.approvals).toBe('safe');
      vi.restoreAllMocks();
    }
  });
});
