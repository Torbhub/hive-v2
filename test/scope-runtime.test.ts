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

describe('spawn runtime evidence', () => {
  it.each(['git', 'jj'] as const)('passes a clean real %s spawn and stores an unverified authenticated receipt', async (kind) => {
    const { repository, base, id, entry } = await realSpawn(kind);
    expect(entry.runtime_files).toBeDefined();
    const evaluation = await evaluateScope(repository, id, entry.lease_id!, base, base).catch((error: unknown) => error);
    expect(evaluation).not.toBeInstanceOf(Error);
    const passed = evaluation as boolean;
    const evidence = (await readTaskEvents(repository)).findLast((event) => event.evidence)?.evidence!;
    expect(evidence.content).toMatchObject({ out_of_scope: [] });
    expect(passed).toBe(true);
    expect(evidence.actor).toBe('agent:builder');
    const receiptEvidence = await recordTaskEvidence(repository, id, {
      actor: 'agent:builder', plan_digest: evidence.plan_digest, epoch: evidence.epoch, lease_id: entry.lease_id,
      outcome: 'passed', artifact: { check: 'spawn' }, content: { status: 'passed' },
    });
    await recordTaskReceipt(repository, id, {
      actor: 'agent:builder', plan_digest: evidence.plan_digest, epoch: evidence.epoch, sequence: 1,
      lease_id: entry.lease_id, artifact_digest: receiptEvidence.artifact_digest,
      counters: {}, external_ids: {}, evidence_hashes: [receiptEvidence.evidence_hash], state: 'reconciling',
    });
    await expect(evaluateTaskPredicate(repository, id, 'task_receipt', {
      plan_digest: evidence.plan_digest, artifact_digest: receiptEvidence.artifact_digest, lease_id: entry.lease_id,
    })).resolves.toBe(false);
  }, 20_000);

  it('releases the lease when a role changes after a clean spawn', async () => {
    const { repository, base, id, entry, worktree } = await realSpawn('git');
    await expect(evaluateScope(repository, id, entry.lease_id!, base, base)).resolves.toBe(true);
    await fs.appendFile(hivePath(worktree, 'team', 'builder', 'role.md'), '\nworker edit\n');
    await expect(evaluateScope(repository, id, entry.lease_id!, base, base)).resolves.toBe(false);
    expect((await readTeam(repository)).agents.find((agent) => agent.lease_id === entry.lease_id)).toMatchObject({
      lease_revoked: true, admission_status: 'released',
    });
  }, 20_000);

  it('releases the lease for added team state and an undeclared handoff', async () => {
    const { repository, base, id, entry, worktree } = await realSpawn('git');
    await writeJson(hivePath(worktree, 'team.json'), { agents: [] });
    await expect(evaluateScope(repository, id, entry.lease_id!, base, base)).resolves.toBe(false);
    expect((await readTeam(repository)).agents.find((agent) => agent.lease_id === entry.lease_id)?.lease_revoked).toBe(true);
  }, 20_000);

  it('releases the lease for an undeclared handoff', async () => {
    const { repository, base, id, entry, worktree } = await realSpawn('git');
    await fs.writeFile(hivePath(worktree, 'handoffs', 'other.md'), 'not the deliverable\n');
    await expect(evaluateScope(repository, id, entry.lease_id!, base, base)).resolves.toBe(false);
    expect((await readTeam(repository)).agents.find((agent) => agent.lease_id === entry.lease_id)?.lease_revoked).toBe(true);
  }, 20_000);

  it('records claim completion and stays clean through spawn and respawn', async () => {
    const { repository, base, id, entry, worktree } = await realSpawn('jj');
    const firstClaim = entry.launch_claim_path!;
    expect(firstClaim).toMatch(/^\.hive-hub\/launches\/demo:/);
    await expect(fs.stat(path.join(worktree, firstClaim))).rejects.toThrow();
    await expect(evaluateScope(repository, id, entry.lease_id!, base, base)).resolves.toBe(true);
    const firstEvents = (await readTaskEvents(repository)).filter((event) => event.admission?.lease_id === entry.lease_id);
    expect(firstEvents.at(-1)?.admission?.launch_claim_completed).toBe(true);

    await respawnAgent(repository, 'demo', 'builder');
    const respawned = (await readTeam(repository)).agents.find((agent) => agent.name === 'builder')!;
    expect(respawned.lease_id).not.toBe(entry.lease_id);
    expect(respawned.launch_claim_path).toBeDefined();
    expect(respawned.launch_claim_path).not.toBe(firstClaim);
    expect(Object.keys(respawned.runtime_files!).filter((file) => file.startsWith('.hive-hub/launches/'))).toEqual([]);
    await expect(evaluateScope(repository, id, respawned.lease_id!, base, base)).resolves.toBe(true);
    const secondEvents = (await readTaskEvents(repository)).filter((event) => event.admission?.lease_id === respawned.lease_id);
    expect(secondEvents.at(-1)?.admission?.launch_claim_completed).toBe(true);
  }, 20_000);

  it.each(['create', 'modify'] as const)('rejects %s launch-claim tampering', async (operation) => {
    const { repository, base, id, entry, worktree } = await realSpawn('jj');
    await expect(evaluateScope(repository, id, entry.lease_id!, base, base)).resolves.toBe(true);
    if (operation === 'create') {
      await writeJson(hubPath(worktree, 'launches', 'demo:unallocated.json'), { project: 'demo' });
    } else {
      await fs.writeFile(path.join(worktree, entry.launch_claim_path!), 'tampered\n');
    }
    await expect(evaluateScope(repository, id, entry.lease_id!, base, base)).resolves.toBe(false);
    expect((await readTeam(repository)).agents.find((agent) => agent.lease_id === entry.lease_id)).toMatchObject({
      lease_revoked: true, admission_status: 'released',
    });
  }, 20_000);

  it('rejects a preexisting unallocated launch claim while binding only the current operation', async () => {
    const { repository, base, id, entry } = await realSpawn('jj', async (home) => {
      await writeJson(hubPath(home, 'launches', 'unallocated.json'), { project: 'demo' });
    });
    expect(entry.launch_claim_path).toMatch(/^\.hive-hub\/launches\/demo:/);
    expect(Object.keys(entry.runtime_files!).filter((file) => file.startsWith('.hive-hub/launches/'))).toEqual([]);
    await expect(evaluateScope(repository, id, entry.lease_id!, base, base)).resolves.toBe(false);
  }, 20_000);

  it('handles JJ working-copy, untracked, and ignored out-of-scope changes', async () => {
    const { repository, base, id, entry, worktree } = await realSpawn('jj');
    await expect(evaluateScope(repository, id, entry.lease_id!, base, base)).resolves.toBe(true);
    await fs.writeFile(path.join(worktree, 'ignored.txt'), 'ignored escape\n');
    await expect(evaluateScope(repository, id, entry.lease_id!, base, base)).resolves.toBe(false);
    expect((await readTeam(repository)).agents.find((agent) => agent.lease_id === entry.lease_id)?.lease_revoked).toBe(true);
  }, 20_000);
});
