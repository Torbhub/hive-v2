import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const testRun = vi.hoisted(() => ({ actualRun: null as unknown as typeof import('../src/tmux.js').run }));
vi.mock('../src/tmux.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/tmux.js')>();
  testRun.actualRun = orig.run;
  return {
    ...orig,
    run: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    newWindow: vi.fn(async () => '%9'),
    killWindow: vi.fn(async () => {}),
    paneIdentity: vi.fn(async () => ({ pid: 4242, started: 'later' })),
    paneExists: vi.fn(async () => true),
    paneIs: vi.fn(async () => true),
    capturePane: vi.fn(async () => IDLE),
    sendLiteral: vi.fn(async () => {}),
    sendEnter: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
  };
});

vi.mock('../src/admission.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/admission.js')>();
  return { ...original, completeTmuxLaunch: vi.fn(original.completeTmuxLaunch) };
});

import { completeTmuxLaunch } from '../src/admission.js';
import { evaluateTaskPredicate, hubAdd, hubInit, hubResolve, hubTask, recordTaskEvidence, recordTaskReceipt } from '../src/hub.js';
import { respawnAgent, spawnAgent, wakeAgent } from '../src/spawn.js';
import { hivePath, hubPath, readTaskEvents, readTeam, writeJson } from '../src/state.js';
import { killWindow, newWindow, paneIs, run } from '../src/tmux.js';
import { approveContract, taskContract } from './task-contract.js';
import { gitRepo, IDLE, jjRepo } from './scope-fixture.js';

async function realSpawn(
  kind: 'git' | 'jj', beforeSpawn?: (repository: string) => Promise<void>, beforeWindow?: (worktree: string) => Promise<void>,
) {
  const { repository, base } = kind === 'jj' ? await jjRepo() : await gitRepo();
  await hubInit(repository);
  await hubAdd(repository, 'demo', repository);
  await beforeSpawn?.(repository);
  const output = 'Return the named artifact and verification evidence to the orchestrator.';
  const contract = {
    ...taskContract(repository, ['src', '.hive/handoffs'], output),
    provenance: { repository, base_revision: base, artifact_revision: base },
  };
  const id = await hubTask(repository, 'demo', 'bounded worker setup');
  await approveContract(repository, id, contract);
  vi.mocked(run).mockImplementation(async (command, args, cwd, env, timeout) => {
    if (command === 'teamkimi') return { code: 0, stdout: '', stderr: '' };
    return testRun.actualRun(command, args, cwd, env, timeout);
  });
  if (beforeWindow) {
    vi.mocked(newWindow).mockImplementationOnce(async () => {
      await beforeWindow(path.join(repository, '.hive', 'lanes', 'builder'));
      return '%9';
    });
  }
  await spawnAgent(repository, 'demo', {
    agent: 'builder', task: id,
    assignment: 'Complete the bounded scope assignment in the requested files.',
    deliverable: output,
  });
  const entry = (await readTeam(repository)).agents.find((agent) => agent.name === 'builder')!;
  return { repository, base, id, entry, worktree: entry.worktree! };
}

async function evaluateScope(repository: string, id: string, leaseId: string, base: string, artifactRevision: string) {
  return evaluateTaskPredicate(repository, id, 'git_diff_scope', {
    lease_id: leaseId, base_revision: base, artifact_revision: artifactRevision,
  });
}

describe('spawn launch fencing', () => {
  it('does not rebase immediate role and hub tampering during initial spawn', async () => {
    const { repository, base, id, entry } = await realSpawn('jj', undefined, async (worktree) => {
      await fs.appendFile(hivePath(worktree, 'team', 'builder', 'role.md'), '\nimmediate tamper\n');
      await fs.appendFile(hubPath(worktree, 'hub.json'), 'immediate tamper\n');
    });
    await expect(evaluateScope(repository, id, entry.lease_id!, base, base)).resolves.toBe(false);
  }, 20_000);

  it.each(['respawn', 'wake'] as const)('does not rebase immediate role tampering during %s', async (operation) => {
    const { repository, base, id, entry, worktree } = await realSpawn('jj');
    if (operation === 'wake') {
      const team = await readTeam(repository);
      await writeJson(hivePath(repository, 'team.json'), {
        agents: team.agents.map((agent) => agent.lease_id === entry.lease_id ? { ...agent, session_id: 'session-old' } : agent),
      });
      vi.mocked(paneIs).mockResolvedValueOnce(false);
    }
    vi.mocked(newWindow).mockImplementationOnce(async () => {
      await fs.appendFile(hivePath(worktree, 'team', 'builder', 'role.md'), '\nimmediate relaunch tamper\n');
      return '%9';
    });
    if (operation === 'respawn') await respawnAgent(repository, 'demo', 'builder');
    else await wakeAgent(repository, 'demo', 'builder');
    const current = (await readTeam(repository)).agents.find((agent) => agent.name === 'builder')!;
    await expect(evaluateScope(repository, id, current.lease_id!, base, base)).resolves.toBe(false);
  }, 20_000);

  it('kills the exact new pane and fails the exact lease when initial completion fails', async () => {
    let repository = '';
    vi.mocked(completeTmuxLaunch).mockRejectedValueOnce(new Error('injected completion failure'));
    vi.mocked(killWindow).mockClear();
    await expect(realSpawn('jj', async (home) => { repository = home; })).rejects.toThrow('injected completion failure');
    const current = (await readTeam(repository)).agents.find((agent) => agent.name === 'builder')!;
    expect(current).toMatchObject({ admission_status: 'launch_failed', lease_revoked: true });
    expect(killWindow).toHaveBeenCalledTimes(1);
    expect(killWindow).toHaveBeenCalledWith('%9', { pid: 4242, started: 'later' });
  }, 20_000);

  it.each(['respawn', 'wake'] as const)('kills the exact new pane and fails the exact lease when %s completion fails', async (operation) => {
    const { repository, entry } = await realSpawn('jj');
    if (operation === 'wake') {
      const team = await readTeam(repository);
      await writeJson(hivePath(repository, 'team.json'), {
        agents: team.agents.map((agent) => agent.lease_id === entry.lease_id ? { ...agent, session_id: 'session-old' } : agent),
      });
      vi.mocked(paneIs).mockResolvedValueOnce(false);
    }
    vi.mocked(completeTmuxLaunch).mockRejectedValueOnce(new Error(`injected ${operation} completion failure`));
    vi.mocked(killWindow).mockClear();
    const action = operation === 'respawn' ? respawnAgent : wakeAgent;
    await expect(action(repository, 'demo', 'builder')).rejects.toThrow(`injected ${operation} completion failure`);
    const current = (await readTeam(repository)).agents.find((agent) => agent.name === 'builder')!;
    expect(current.lease_id).not.toBe(entry.lease_id);
    expect(current).toMatchObject({ admission_status: 'launch_failed', lease_revoked: true });
    expect(killWindow).toHaveBeenCalledTimes(operation === 'respawn' ? 2 : 1);
    expect(killWindow).toHaveBeenCalledWith('%9', { pid: 4242, started: 'later' });
  }, 20_000);

  it('kills the new pane and fails the exact lease when cancellation races completion', async () => {
    let repository = '';
    vi.mocked(completeTmuxLaunch).mockImplementationOnce(async () => {
      await hubResolve(repository, 'demo', 'demo-1', 'cancel', 'cancellation raced completion');
      throw new Error('completion lost its current grant');
    });
    vi.mocked(killWindow).mockClear();
    await expect(realSpawn('jj', async (home) => { repository = home; })).rejects.toThrow('completion lost its current grant');
    const current = (await readTeam(repository)).agents.find((agent) => agent.name === 'builder')!;
    expect(current).toMatchObject({ admission_status: 'launch_failed', lease_revoked: true });
    expect(killWindow).toHaveBeenCalledWith('%9', { pid: 4242, started: 'later' });
  }, 20_000);

  it.each(['modify', 'delete'] as const)('refuses pre-completion claim %s and cleans up the exact launch', async (operation) => {
    let repository = '';
    vi.mocked(killWindow).mockClear();
    await expect(realSpawn('jj', async (home) => { repository = home; }, async (worktree) => {
      const claims = await fs.readdir(hubPath(worktree, 'launches'));
      const claim = claims.find((name) => name.startsWith('demo:'))!;
      if (operation === 'modify') await fs.appendFile(hubPath(worktree, 'launches', claim), 'tampered\n');
      else await fs.rm(hubPath(worktree, 'launches', claim));
    })).rejects.toThrow(/claim|completion/);
    const current = (await readTeam(repository)).agents.find((agent) => agent.name === 'builder')!;
    expect(current).toMatchObject({ admission_status: 'launch_failed', lease_revoked: true });
    expect(killWindow).toHaveBeenCalledWith('%9', { pid: 4242, started: 'later' });
  }, 20_000);
});
