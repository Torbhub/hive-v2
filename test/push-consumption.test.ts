import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  answerQuestionBatch, consumePushApproval, createQuestionBatch, readQuestionBatch,
} from '../src/questions.js';
import { appendTaskEvent, hivePath, hubPath, writeJson, writeProjects } from '../src/state.js';
import type { QuestionBatch } from '../src/types.js';
import {
  AGENT_CREDENTIAL, ASSERTION_KEYS, MemoryRegistry, configureSecurity, registryItems, startTestRegistry,
} from './security-fixture.js';

const brokers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(brokers.splice(0).map((broker) => new Promise<void>((resolve) => broker.close(() => resolve()))));
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'hive-push-consume-'));
  const remote = path.join(root, 'remote.git');
  const home = path.join(root, 'work');
  git(root, 'init', '--bare', remote);
  git(root, 'init', '-b', 'main', home);
  git(home, 'config', 'user.email', 'test@example.invalid');
  git(home, 'config', 'user.name', 'Test');
  await writeFile(path.join(home, 'a.txt'), 'base\n');
  git(home, 'add', 'a.txt');
  git(home, 'commit', '-m', 'feat: base');
  git(home, 'remote', 'add', 'origin', remote);
  git(home, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(home, 'checkout', '-b', 'feat/t16');
  await writeFile(path.join(home, 'b.txt'), 'change\n');
  git(home, 'add', 'b.txt');
  git(home, 'commit', '-m', 'feat: change');
  const commit = git(home, 'rev-parse', 'HEAD');
  await writeProjects(root, { projects: [{ name: 'demo', home, repos: [] }] });
  await writeJson(hivePath(home, 'team.json'), {
    agents: [{ name: 'builder', worktree: home, task: 'demo-1' }],
  });
  await appendTaskEvent(root, { id: 'demo-1', project: 'demo', event: 'asked', at: new Date().toISOString() });
  const values = registryItems();
  values.find((row) => row.sk === 'PRINCIPAL#user:alice')!.aclEpoch = 2;
  const { broker, registry } = await startTestRegistry(values);
  brokers.push(broker);
  configureSecurity();
  await writeFile(path.join(root, 'credential.env'), `HIVE_AGENT_CREDENTIAL='${AGENT_CREDENTIAL}'\n`, { mode: 0o600 });
  return { root, remote, home, commit, registry };
}

async function approved(root: string, commit: string,
  approverSubject = 'user:alice', approverGrantId = 'human-grant'): Promise<QuestionBatch> {
  const batch = await createQuestionBatch(root, { project: 'demo', agent: `builder@${path.join(root, 'work')}` }, {
    context: 'Publish the reviewed change.',
    questions: [{
      priority: 1,
      decision: {
        action: 'push', repository: 'attacker/other', branch: 'feat/t16', commit,
        diffSummary: '1 file changed', destination: 'origin/feat/t16', reason: 'Reviewed.',
      },
    }],
  });
  return answerQuestionBatch(root, batch.id, [{ question: 'q1', choice: 'c2' }], {
    task: 'demo-1', consumerGrantId: 'agent-grant', consumerAclEpoch: 1,
    approverSubject, approverGrantId, approverAclEpoch: 2,
  });
}

function environment(root: string, home: string): NodeJS.ProcessEnv {
  return {
    HIVE_HUB_ROOT: root, HIVE_PROJECT: 'demo', HIVE_COLLABORATION_ENABLED: '1',
    HIVE_AGENT_CREDENTIAL_FILE: path.join(root, 'credential.env'),
    HIVE_AGENT_REF: `builder@${home}`,
    HIVE_ASSERTION_KEYS_JSON: JSON.stringify(ASSERTION_KEYS),
  };
}

function contractEnvironment(root: string, home: string): NodeJS.ProcessEnv {
  return { ...environment(root, home), HIVE_COLLABORATION_ENABLED: '0' };
}

describe('authenticated push consumption', () => {
  it('binds and consumes a valid approval without running a push', async () => {
    const { root, remote, home, commit, registry } = await setup();
    const batch = await approved(root, commit);
    expect(batch.answers![0].decision?.grant).toMatchObject({
      agent: `builder@${home}`, task: 'demo-1', grantId: 'agent-grant', profileAclEpoch: 1,
      approverSubject: 'user:alice', approverGrantId: 'human-grant', approverAclEpoch: 2,
    });
    const url = await consumePushApproval(
      root, { project: 'demo', batch: batch.id, question: 'q1' },
      'origin', commit, 'feat/t16', home, Date.now(), environment(root, home), registry);
    expect(url).toBe(remote);
    expect((await readQuestionBatch(root, batch.id)).answers![0].decision?.grant?.consumedAt).toBeTruthy();
  });

  it('enforces delegated approver expiry before recording consumption', async () => {
    const { root, remote, home, commit, registry } = await setup();
    registry.items.push({
      pk: 'ACL#demo#demo-1#*', sk: 'PRINCIPAL#user:bob', project: 'demo', task: 'demo-1', principal: 'user:bob',
      grantId: 'bob-grant', actions: ['execute'], aclEpoch: 2, revokedAt: null,
    });
    const account = registry.items.find((row) => row.pk === 'SUBJECT#user:bob')!;
    const now = Math.floor(Date.now() / 1000);
    for (const [expiresAt, valid] of [
      [now - 1, false], ['invalid', false], [undefined, true], [null, true], [0, true], [now + 60, true],
    ] as const) {
      if (expiresAt === undefined) delete account.expiresAt;
      else account.expiresAt = expiresAt;
      const batch = await approved(root, commit, 'user:bob', 'bob-grant');
      const result = consumePushApproval(
        root, { project: 'demo', batch: batch.id, question: 'q1' },
        'origin', commit, 'feat/t16', home, Date.now(), environment(root, home), registry,
      );
      if (valid) await expect(result).resolves.toBe(remote);
      else await expect(result).rejects.toThrow(/approver account|delegated approval/);
      const stored = await readQuestionBatch(root, batch.id);
      expect(Boolean(stored.answers![0].decision?.grant?.consumedAt)).toBe(valid);
    }
  });

  it('rejects a revoked consuming credential', async () => {
    const { root, home, commit, registry } = await setup();
    const batch = await approved(root, commit);
    const values = registry.items;
    values.find((row) => row.pk === 'AGENT#builder' && row.sk === 'PROFILE')!.revokedAt = 1;
    await expect(consumePushApproval(
      root, { project: 'demo', batch: batch.id, question: 'q1' },
      'origin', commit, 'feat/t16', home, Date.now(), environment(root, home), registry,
    )).rejects.toThrow(/invalid agent credential/);
  });

  it('rejects a revoked current execute grant', async () => {
    const { root, home, commit, registry } = await setup();
    const batch = await approved(root, commit);
    const values = registry.items;
    values.find((row) => row.sk === 'PRINCIPAL#agent:builder')!.revokedAt = 1;
    await expect(consumePushApproval(
      root, { project: 'demo', batch: batch.id, question: 'q1' },
      'origin', commit, 'feat/t16', home, Date.now(), environment(root, home), registry,
    )).rejects.toThrow(/not found/);
  });

  it('rejects an other-name agent reference', async () => {
    const { root, home, commit, registry } = await setup();
    const batch = await approved(root, commit);
    const env = { ...environment(root, home), HIVE_AGENT_REF: `mallory@${home}` };
    await expect(consumePushApproval(
      root, { project: 'demo', batch: batch.id, question: 'q1' },
      'origin', commit, 'feat/t16', home, Date.now(), env, registry,
    )).rejects.toThrow(/agent|not found/);
  });

  it('rejects consumption from a different task', async () => {
    const { root, home, commit, registry } = await setup();
    const batch = await approved(root, commit);
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'builder', worktree: home, task: 'demo-2' }],
    });
    await appendTaskEvent(root, { id: 'demo-2', project: 'demo', event: 'asked', at: new Date().toISOString() });
    await expect(consumePushApproval(
      root, { project: 'demo', batch: batch.id, question: 'q1' },
      'origin', commit, 'feat/t16', home, Date.now(), environment(root, home), registry,
    )).rejects.toThrow(/task/);
  });

  it('rejects a project grant replaced by a task grant with the same row-local epoch', async () => {
    const { root, home, commit, registry } = await setup();
    const batch = await approved(root, commit);
    const values = registry.items;
    const index = values.findIndex((row) => row.sk === 'PRINCIPAL#agent:builder');
    values.splice(index, 1, {
      pk: 'ACL#demo#demo-1#*', sk: 'PRINCIPAL#agent:builder', project: 'demo', task: 'demo-1',
      principal: 'agent:builder', grantId: 'task-grant', actions: ['execute'], aclEpoch: 1, revokedAt: null,
    });
    await expect(consumePushApproval(
      root, { project: 'demo', batch: batch.id, question: 'q1' },
      'origin', commit, 'feat/t16', home, Date.now(), environment(root, home), registry,
    )).rejects.toThrow(/grant identity/);
  });

  it('rejects an agent ACL change that advances the profile epoch', async () => {
    const { root, home, commit, registry } = await setup();
    const batch = await approved(root, commit);
    const values = registry.items;
    values.find((row) => row.pk === 'AGENT#builder' && row.sk === 'PROFILE')!.aclEpoch = 2;
    await expect(consumePushApproval(
      root, { project: 'demo', batch: batch.id, question: 'q1' },
      'origin', commit, 'feat/t16', home, Date.now(), environment(root, home), registry,
    )).rejects.toThrow(/profile ACL epoch/);
  });

  it('rejects a substituted execute grant identity', async () => {
    const { root, home, commit, registry } = await setup();
    const batch = await approved(root, commit);
    const values = registry.items;
    values.find((row) => row.sk === 'PRINCIPAL#agent:builder')!.grantId = 'different-grant';
    await expect(consumePushApproval(
      root, { project: 'demo', batch: batch.id, question: 'q1' },
      'origin', commit, 'feat/t16', home, Date.now(), environment(root, home), registry,
    )).rejects.toThrow(/grant identity/);
  });

  it('rejects a revoked human approver grant', async () => {
    const { root, home, commit, registry } = await setup();
    const batch = await approved(root, commit);
    const values = registry.items;
    values.find((row) => row.sk === 'PRINCIPAL#user:alice')!.revokedAt = 1;
    await expect(consumePushApproval(
      root, { project: 'demo', batch: batch.id, question: 'q1' },
      'origin', commit, 'feat/t16', home, Date.now(), environment(root, home), registry,
    )).rejects.toThrow(/approver|not found/);
  });

  it('rejects a disabled human approver account even with a valid ACL grant', async () => {
    const { root, home, commit, registry } = await setup();
    const batch = await approved(root, commit);
    const values = registry.items;
    values.find((row) => row.pk === 'AGENT#builder' && row.sk === 'PROFILE')!.ownerSubject = 'user:bob';
    values.find((row) => row.pk === 'SUBJECT#user:alice')!.accountStatus = 'disabled';
    await expect(consumePushApproval(
      root, { project: 'demo', batch: batch.id, question: 'q1' },
      'origin', commit, 'feat/t16', home, Date.now(), environment(root, home), registry,
    )).rejects.toMatchObject({ status: 401 });
  });

  it('allows a different authorized human approver without returning the agent owner account', async () => {
    const { root, remote, home, commit, registry } = await setup();
    const values = registry.items;
    values.push({
      pk: 'ACL#demo#demo-1#*', sk: 'PRINCIPAL#user:bob', project: 'demo', task: 'demo-1', principal: 'user:bob',
      grantId: 'bob-grant', actions: ['execute'], aclEpoch: 2, revokedAt: null,
    });
    const batch = await approved(root, commit, 'user:bob', 'bob-grant');
    const url = await consumePushApproval(
      root, { project: 'demo', batch: batch.id, question: 'q1' },
      'origin', commit, 'feat/t16', home, Date.now(), environment(root, home), registry);
    expect(url).toBe(remote);
  });

  it('rejects a disabled different human approver', async () => {
    const { root, home, commit, registry } = await setup();
    const values = registry.items;
    values.push({
      pk: 'ACL#demo#demo-1#*', sk: 'PRINCIPAL#user:bob', project: 'demo', task: 'demo-1', principal: 'user:bob',
      grantId: 'bob-grant', actions: ['execute'], aclEpoch: 2, revokedAt: null,
    });
    const batch = await approved(root, commit, 'user:bob', 'bob-grant');
    values.find((row) => row.pk === 'SUBJECT#user:bob')!.accountStatus = 'disabled';
    await expect(consumePushApproval(
      root, { project: 'demo', batch: batch.id, question: 'q1' },
      'origin', commit, 'feat/t16', home, Date.now(), environment(root, home), registry,
    )).rejects.toMatchObject({ status: 401 });
  });

  it('rejects an arbitrary approver subject', async () => {
    const { root, home, commit, registry } = await setup();
    const batch = await approved(root, commit, 'user:charlie', 'charlie-grant');
    await expect(consumePushApproval(
      root, { project: 'demo', batch: batch.id, question: 'q1' },
      'origin', commit, 'feat/t16', home, Date.now(), environment(root, home), registry,
    )).rejects.toThrow(/approver|not found/);
  });

  it('rejects an approver grant from the wrong task', async () => {
    const { root, home, commit, registry } = await setup();
    const values = registry.items;
    values.push({
      pk: 'ACL#demo#*#*', sk: 'PRINCIPAL#user:bob', project: 'demo', principal: 'user:bob',
      grantId: 'bob-grant', actions: ['execute'], aclEpoch: 2, revokedAt: null,
    });
    const batch = await approved(root, commit, 'user:bob', 'bob-grant');
    values.find((row) => row.sk === 'PRINCIPAL#user:bob')!.pk = 'ACL#demo#demo-2#*';
    await expect(consumePushApproval(
      root, { project: 'demo', batch: batch.id, question: 'q1' },
      'origin', commit, 'feat/t16', home, Date.now(), environment(root, home), registry,
    )).rejects.toThrow(/approver authorization changed/);
  });

  it('rejects project-only delegated grants for a task', async () => {
    const { root, home, commit, registry } = await setup();
    const values = registry.items;
    for (const subject of ['agent:builder', 'user:alice']) {
      const grant = values.find((row) => row.sk === `PRINCIPAL#${subject}`)!;
      grant.pk = 'ACL#demo#*#*';
      grant.task = null;
    }
    const batch = await approved(root, commit);
    await expect(consumePushApproval(
      root, { project: 'demo', batch: batch.id, question: 'q1' },
      'origin', commit, 'feat/t16', home, Date.now(), environment(root, home), registry,
    )).rejects.toThrow(/not found/);
  });

  it('rejects a consumer project-only grant before the delegated proof call', async () => {
    const { root, home, commit, registry } = await setup();
    const values = registry.items;
    const consumer = values.find((row) => row.sk === 'PRINCIPAL#agent:builder')!;
    consumer.pk = 'ACL#demo#*#*';
    consumer.task = null;
    const batch = await approved(root, commit);
    const delegated = vi.spyOn(MemoryRegistry.prototype, 'delegatedApprovalAccount');
    try {
      await expect(consumePushApproval(
        root, { project: 'demo', batch: batch.id, question: 'q1' },
        'origin', commit, 'feat/t16', home, Date.now(), environment(root, home), registry,
      )).rejects.toThrow(/execute grant identity|not found/);
      expect(delegated).not.toHaveBeenCalled();
    } finally {
      delegated.mockRestore();
    }
  });

  it('rejects a persisted legacy agent approval during consumption', async () => {
    const { root, home, commit, registry } = await setup();
    const batch = await approved(root, commit);
    const grant = batch.answers![0].decision!.grant!;
    grant.approverSubject = 'agent:builder';
    grant.approverGrantId = 'agent-grant';
    grant.approverAclEpoch = 1;
    await writeJson(path.join(root, '.hive-hub', 'questions', 'closed', `${batch.id}.json`), batch);
    await expect(consumePushApproval(
      root, { project: 'demo', batch: batch.id, question: 'q1' },
      'origin', commit, 'feat/t16', home, Date.now(), environment(root, home), registry,
    )).rejects.toThrow(/human approver/);
  });

  it('rejects an agent principal when creating an execution approval', async () => {
    const { root, commit } = await setup();
    await expect(approved(root, commit, 'agent:builder', 'agent-grant'))
      .rejects.toThrow(/human approver/);
  });
});

async function bindContract(root: string, home: string, commit: string, wallSeconds?: number) {
  const { contractDigest, valueDigest } = await import('../src/state.js');
  const base = git(home, 'rev-parse', 'HEAD^');
  const contract = {
    schema_version: 1, objective: 'Publish the bounded change.', consumer: 'demo-orchestrator',
    deliverable: 'the reviewed commit', kind: 'build',
    acceptance: [{
      id: 'receipt', predicate_id: 'task_receipt', version: 1, configuration: {}, required_evidence: ['receipt'],
    }],
    provenance: { repository: home, base_revision: base, artifact_revision: commit },
    write_scope: ['a.txt', 'b.txt'], action_scope: ['push'],
    budget: { depth: 1, active_children: 2, active_project_records: 2, attempts: 2, wall_seconds: wallSeconds },
    delegation: { output_claims: ['the reviewed commit'], adapters: ['tmux'] },
  } satisfies import('../src/types.js').RootContract;
  const planDigest = contractDigest(contract);
  const at = new Date().toISOString();
  await appendTaskEvent(root, {
    id: 'demo-1', project: 'demo', event: 'plan', at,
    checkpoints: [{ id: 'publish', desc: 'push the reviewed commit', etaMin: 1 }],
    contract, plan_digest: planDigest,
  });
  await appendTaskEvent(root, { id: 'demo-1', project: 'demo', event: 'answered', at, plan_digest: planDigest });
  const admission: import('../src/types.js').TmuxAdmission = {
    task: 'demo-1', project: 'demo', agent: 'builder', parent_id: 'demo-1', plan_digest: planDigest,
    root_lease_epoch: 1, lease_id: 'lease-push-1', lease_epoch: 1, lease_revoked: false,
    output_claim: 'the reviewed commit', acceptance_ids: ['receipt'], provenance: { ...contract.provenance },
    provenance_digest: valueDigest(contract.provenance), write_scope: ['a.txt', 'b.txt'], adapter: 'tmux',
    lineage_id: 'builder', attempts_used: 1, status: 'running',
  };
  await appendTaskEvent(root, { id: 'demo-1', project: 'demo', event: 'admission', at, admission });
  await writeJson(hivePath(home, 'team.json'), {
    agents: [{
      name: 'builder', worktree: home, task: 'demo-1', parent_id: 'demo-1', plan_digest: planDigest,
      root_lease_epoch: 1, lease_id: admission.lease_id, lease_epoch: 1, lease_revoked: false,
      output_claim: admission.output_claim, acceptance_ids: ['receipt'], provenance: { ...contract.provenance },
      provenance_digest: admission.provenance_digest, write_scope: ['a.txt', 'b.txt'], adapter: 'tmux',
      lineage_id: 'builder', attempts_used: 1, admission_status: 'running',
    }],
  });
  return { contract, planDigest, admission };
}

function operationApproval(batch: QuestionBatch, root: string) {
  const grant = batch.answers![0].decision!.grant!;
  return {
    root, project: 'demo', batch: batch.id, question: 'q1',
    operationId: grant.operationId!, idempotencyKey: grant.idempotencyKey!,
  };
}

function runCli(home: string, root: string, batch: QuestionBatch, commit: string, operation = true) {
  const repository = path.resolve(new URL('..', import.meta.url).pathname);
  const grant = batch.answers![0].decision!.grant!;
  const args = [
    path.join(repository, 'src', 'cli.ts'), 'push', 'origin', commit, 'feat/t16',
    '--approval', `${batch.id}/q1`,
    ...(operation ? ['--operation', grant.operationId!, '--idempotency-key', grant.idempotencyKey!] : []),
  ];
  return spawnSync(path.join(repository, 'node_modules', '.bin', 'tsx'), args, {
    cwd: home, encoding: 'utf8', env: { ...process.env, ...contractEnvironment(root, home) },
  });
}

async function countPushes(remote: string): Promise<number> {
  const content = await readFile(path.join(remote, 'push-count'), 'utf8').catch(() => '');
  return content.split('\n').filter(Boolean).length;
}

describe('contract-bound push operations', () => {
  it('binds plan, scope, budget, lease, repository, and operation identity', async () => {
    const { root, home, commit, registry } = await setup();
    const { planDigest } = await bindContract(root, home, commit);
    const batch = await approved(root, commit);
    expect(batch.answers![0].decision?.grant).toMatchObject({
      planDigest, actionScope: ['push'], leaseId: 'lease-push-1', leaseEpoch: 1, rootLeaseEpoch: 1,
      repositoryFingerprint: batch.questions[0].decision!.facts.repositoryFingerprint,
      commit, branch: 'feat/t16', operationId: expect.any(String), idempotencyKey: expect.any(String),
      scopeHash: expect.stringMatching(/^[0-9a-f]{64}$/), budgetVersion: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const { consumePushOperation } = await import('../src/questions.js');
    const consumed = await consumePushOperation(
      root, operationApproval(batch, root), 'origin', commit, 'feat/t16', home,
      Date.now(), environment(root, home), registry,
    );
    expect(consumed).toMatchObject({ status: 'pending', operation: { status: 'pending' } });
  });

  it('pushes through the real CLI once and reconciles the same operation', async () => {
    const { root, remote, home, commit } = await setup();
    await bindContract(root, home, commit);
    await writeFile(path.join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nprintf "push\\n" >> "$GIT_DIR/push-count"\n');
    await chmod(path.join(remote, 'hooks', 'pre-receive'), 0o755);
    const batch = await approved(root, commit);
    const first = runCli(home, root, batch, commit);
    expect({ status: first.status, stderr: first.stderr }).toEqual({ status: 0, stderr: '' });
    expect(git(remote, 'rev-parse', 'refs/heads/feat/t16')).toBe(commit);
    expect(await countPushes(remote)).toBe(1);

    const second = runCli(home, root, batch, commit);
    expect({ status: second.status, stderr: second.stderr }).toEqual({ status: 0, stderr: '' });
    expect(await countPushes(remote)).toBe(1);
    const stored = await readQuestionBatch(root, batch.id);
    expect(stored.answers![0].decision?.grant).toMatchObject({ operationStatus: 'succeeded' });
    expect(stored.answers![0].decision?.grant?.operationResult).toEqual({ remote_tip: commit });
    const { foldTasks, readTaskEvents } = await import('../src/state.js');
    expect(foldTasks(await readTaskEvents(root))[0].operations?.at(-1)).toMatchObject({
      operation_id: stored.answers![0].decision!.grant!.operationId, status: 'succeeded',
    });

    const { pushByHash } = await import('../src/gate.js');
    await expect(pushByHash('origin', commit, 'feat/t16', home, {
      ...operationApproval(batch, root), operationId: 'changed-operation',
    }, contractEnvironment(root, home))).rejects.toThrow(/operation|identity/);
    expect(await countPushes(remote)).toBe(1);
  });

  it('rejects a changed binding and a stale team grant without a write', async () => {
    for (const binding of ['scopeHash', 'leaseEpoch', 'team'] as const) {
      const { root, home, commit } = await setup();
      await bindContract(root, home, commit);
      const batch = await approved(root, commit);
      const grant = batch.answers![0].decision!.grant!;
      if (binding === 'scopeHash') grant.scopeHash = '0'.repeat(64);
      else if (binding === 'leaseEpoch') grant.leaseEpoch = 2;
      else {
        const { readTeam } = await import('../src/state.js');
        const team = await readTeam(home);
        team.agents[0].lease_epoch = 2;
        await writeJson(hivePath(home, 'team.json'), team);
      }
      await writeJson(path.join(root, '.hive-hub', 'questions', 'closed', `${batch.id}.json`), batch);
      const { pushByHash } = await import('../src/gate.js');
      await expect(pushByHash(
        'origin', commit, 'feat/t16', home, operationApproval(batch, root), contractEnvironment(root, home),
      )).rejects.toThrow(/binding|scope|lease/);
      expect(git(home, 'ls-remote', '--heads', 'origin', 'feat/t16')).toBe('');
    }
  });

  it('never blind-retries an ambiguous operation', async () => {
    const { root, remote, home, commit } = await setup();
    await bindContract(root, home, commit);
    await writeFile(path.join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nprintf "push\\n" >> "$GIT_DIR/push-count"\n');
    await chmod(path.join(remote, 'hooks', 'pre-receive'), 0o755);
    const batch = await approved(root, commit);
    const grant = batch.answers![0].decision!.grant!;
    grant.consumedAt = new Date().toISOString();
    grant.operationStatus = 'ambiguous';
    await writeJson(path.join(root, '.hive-hub', 'questions', 'closed', `${batch.id}.json`), batch);
    const { pushByHash } = await import('../src/gate.js');
    await expect(pushByHash(
      'origin', commit, 'feat/t16', home, operationApproval(batch, root), contractEnvironment(root, home),
    )).rejects.toThrow(/ambiguous|reconcile/);
    expect(await countPushes(remote)).toBe(0);
    expect(git(home, 'ls-remote', '--heads', 'origin', 'feat/t16')).toBe('');
  });

  it('gives non-push authority no executor through the real CLI', async () => {
    const { root, home, commit } = await setup();
    await bindContract(root, home, commit);
    const batch = await createQuestionBatch(root, { project: 'demo', agent: `builder@${home}` }, {
      context: 'Create a pull request.',
      questions: [{
        priority: 1,
        decision: { action: 'pr', branch: 'feat/t16', commit, destination: 'origin/main', reason: 'Reviewed.' },
      }],
    });
    const answered = await answerQuestionBatch(root, batch.id, [{ question: 'q1', choice: 'c2' }], {
      task: 'demo-1', consumerGrantId: 'agent-grant', consumerAclEpoch: 1,
      approverSubject: 'user:alice', approverGrantId: 'human-grant', approverAclEpoch: 2,
    });
    expect(answered.answers![0].decision?.grant?.executionAuthority).toBe('none');
    const result = runCli(home, root, answered, commit, false);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/push execution authority|push approval/);
    expect(git(home, 'ls-remote', '--heads', 'origin', 'feat/t16')).toBe('');
  });

  it.each(['failed', 'unknown', 'cancelled'] as const)('rejects grant issuance and first dispatch after %s', async (state) => {
    const { root, home, commit } = await setup();
    await bindContract(root, home, commit);
    const batch = await approved(root, commit);
    await appendTaskEvent(root, { id: 'demo-1', project: 'demo', event: state, at: new Date().toISOString() } as never);
    const result = runCli(home, root, batch, commit);
    expect(result.status).not.toBe(0);
    expect(git(home, 'ls-remote', '--heads', 'origin', 'feat/t16')).toBe('');
    await expect(approved(root, commit)).rejects.toThrow(/closed|terminal|cancelled|failed|unknown/);
  });

  it('reconciles a consumed operation after closure without another push', async () => {
    const { root, remote, home, commit } = await setup();
    await bindContract(root, home, commit);
    await writeFile(path.join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nprintf "push\\n" >> "$GIT_DIR/push-count"\n');
    await chmod(path.join(remote, 'hooks', 'pre-receive'), 0o755);
    const batch = await approved(root, commit);
    expect(runCli(home, root, batch, commit).status).toBe(0);
    expect(await countPushes(remote)).toBe(1);
    await appendTaskEvent(root, { id: 'demo-1', project: 'demo', event: 'cancelled', at: new Date().toISOString() });
    expect(runCli(home, root, batch, commit).status).toBe(0);
    expect(await countPushes(remote)).toBe(1);
  });

  it('reconciles a pending crash through the operation registry without a second receive', async () => {
    const { root, remote, home, commit } = await setup();
    await bindContract(root, home, commit);
    await writeFile(path.join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nprintf "push\\n" >> "$GIT_DIR/push-count"\n');
    await chmod(path.join(remote, 'hooks', 'pre-receive'), 0o755);
    const batch = await approved(root, commit);
    const grant = batch.answers![0].decision!.grant!;
    grant.consumedAt = new Date().toISOString();
    grant.operationStatus = 'pending';
    await writeJson(path.join(root, '.hive-hub', 'questions', 'closed', `${batch.id}.json`), batch);
    git(home, 'push', 'origin', `${commit}:refs/heads/feat/t16`);
    expect(await countPushes(remote)).toBe(1);
    const { OPERATION_REGISTRY } = await import('../src/evidence.js');
    await expect(OPERATION_REGISTRY.push.dispatch(
      'origin', commit, 'feat/t16', home, operationApproval(batch, root), contractEnvironment(root, home),
    )).resolves.toBeUndefined();
    expect(await countPushes(remote)).toBe(1);
    expect((await readQuestionBatch(root, batch.id)).answers![0].decision?.grant?.operationStatus).toBe('succeeded');
  });

  it('keeps a missing remote tip ambiguous and rejects a changed recorded result', async () => {
    const { root, home, commit } = await setup();
    await bindContract(root, home, commit);
    const batch = await approved(root, commit);
    const grant = batch.answers![0].decision!.grant!;
    grant.consumedAt = new Date().toISOString();
    grant.operationStatus = 'pending';
    await writeJson(path.join(root, '.hive-hub', 'questions', 'closed', `${batch.id}.json`), batch);
    const { OPERATION_REGISTRY } = await import('../src/evidence.js');
    await expect(OPERATION_REGISTRY.push.dispatch(
      'origin', commit, 'feat/t16', home, operationApproval(batch, root), contractEnvironment(root, home),
    )).rejects.toThrow(/ambiguous/);
    expect((await readQuestionBatch(root, batch.id)).answers![0].decision?.grant?.operationStatus).toBe('ambiguous');
    grant.operationStatus = 'succeeded';
    grant.operationResult = { remote_tip: '0'.repeat(40) };
    await writeJson(path.join(root, '.hive-hub', 'questions', 'closed', `${batch.id}.json`), batch);
    await expect(OPERATION_REGISTRY.push.dispatch(
      'origin', commit, 'feat/t16', home, operationApproval(batch, root), contractEnvironment(root, home),
    )).rejects.toThrow(/tip|result|operation/);
  });

  it('keeps pre-push cancellation ambiguous and rechecks authority immediately before push', async () => {
    for (const blocker of ['cancel'] as const) {
      const { root, remote, home, commit } = await setup();
      await bindContract(root, home, commit);
      await writeFile(path.join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nprintf "push\\n" >> "$GIT_DIR/push-count"\n');
      await chmod(path.join(remote, 'hooks', 'pre-receive'), 0o755);
      const batch = await approved(root, commit);
      const tmux = await import('../src/tmux.js');
      const original = tmux.run;
      vi.spyOn(tmux, 'run').mockImplementation(async (command: string, args: string[], cwd?: string) => {
        if (command === 'git' && args[0] === 'push') {
          const { hubResolve } = await import('../src/hub.js');
          await hubResolve(root, 'demo', 'demo-1', 'cancel', 'cancel before push');
        }
        return original(command, args, cwd);
      });
      const { OPERATION_REGISTRY } = await import('../src/evidence.js');
      await expect(OPERATION_REGISTRY.push.dispatch(
        'origin', commit, 'feat/t16', home, operationApproval(batch, root), contractEnvironment(root, home),
      )).rejects.toThrow(/ambiguous|external|disabled|paused/);
      expect(await countPushes(remote)).toBe(0);
      const { foldTasks, readTaskEvents } = await import('../src/state.js');
      expect(foldTasks(await readTaskEvents(root))[0].state).not.toBe('cancelled');
      vi.restoreAllMocks();
    }
  });

  it('leaves a queued batch and audit unchanged when execution revalidation fails', async () => {
    const { root, home, commit } = await setup();
    await bindContract(root, home, commit);
    const batch = await createQuestionBatch(root, { project: 'demo', agent: `builder@${home}` }, {
      context: 'Publish the reviewed change.',
      questions: [{
        priority: 1,
        decision: { action: 'push', branch: 'feat/t16', commit, reason: 'Reviewed.' },
      }],
    });
    await expect(answerQuestionBatch(root, batch.id, [{ question: 'q1', choice: 'c2' }], {
      task: 'demo-1', consumerGrantId: 'agent-grant', consumerAclEpoch: 1,
      approverSubject: 'user:alice', approverGrantId: 'human-grant', approverAclEpoch: 2,
    }, async () => { throw new Error('execute grant revoked'); })).rejects.toThrow(/revoked/);
    expect((await readQuestionBatch(root, batch.id)).status).toBe('open');
    expect((await readQuestionBatch(root, batch.id)).answers).toBeUndefined();
    await expect(readFile(path.join(root, '.hive-hub', 'decisions.jsonl'), 'utf8').catch(() => '')).resolves.toBe('');
  });

  it('rejects project-execution-disabled consumption without a write', async () => {
    const { root, home, commit, registry } = await setup();
    await bindContract(root, home, commit);
    const batch = await approved(root, commit);
    const { disableExecution } = await import('../src/rollout.js');
    await disableExecution(root, 'demo');
    const { consumePushOperation } = await import('../src/questions.js');
    await expect(consumePushOperation(
      root, operationApproval(batch, root), 'origin', commit, 'feat/t16', home,
      Date.now(), environment(root, home), registry,
    )).rejects.toThrow(/paused|disabled/);
    expect(git(home, 'ls-remote', '--heads', 'origin', 'feat/t16')).toBe('');
  });

  it('leaves batch and audit unchanged when the approver grant is revoked during authorized close', async () => {
    const { root, home, commit, registry } = await setup();
    await bindContract(root, home, commit);
    const batch = await createQuestionBatch(root, { project: 'demo', agent: `builder@${home}` }, {
      context: 'Publish the reviewed change.',
      questions: [{
        priority: 1,
        decision: { action: 'push', branch: 'feat/t16', commit, reason: 'Reviewed.' },
      }],
    });
    const grant = registry.items.find((row) => row.sk === 'PRINCIPAL#user:alice')!;
    const original = registry.currentAccount.bind(registry);
    let authentications = 0;
    registry.currentAccount = async (subject, assertion) => {
      if (subject === 'user:alice' && !assertion.startsWith('hva1.') && ++authentications === 2) grant.revokedAt = 1;
      return original(subject, assertion);
    };
    const { createServer } = await import('../web/server.js');
    const server = createServer(root, registry);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { authHeaders } = await import('./security-fixture.js');
      const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/questions/answer`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ id: batch.id, answers: [{ question: 'q1', choice: 'c2' }] }),
      });
      expect(response.status).toBe(404);
      expect((await readQuestionBatch(root, batch.id)).status).toBe('open');
      expect((await readQuestionBatch(root, batch.id)).answers).toBeUndefined();
      await expect(readFile(path.join(root, '.hive-hub', 'decisions.jsonl'), 'utf8').catch(() => '')).resolves.toBe('');
    } finally {
      server.close();
    }
  });

  it('does not expose operation completion to public consumers', async () => {
    const { root, home, commit, registry } = await setup();
    await bindContract(root, home, commit);
    const batch = await approved(root, commit);
    const questions = await import('../src/questions.js');
    const consumed = await questions.consumePushOperation(
      root, operationApproval(batch, root), 'origin', commit, 'feat/t16', home,
      Date.now(), environment(root, home), registry,
    );
    expect('consumePushOperationExecutor' in questions).toBe(false);
    expect((consumed as { complete?: unknown }).complete).toBeUndefined();
    expect((await readQuestionBatch(root, batch.id)).answers![0].decision?.grant?.operationStatus).toBe('pending');
  });

  it('keeps rebrief fenced at the push boundary without resetting plan or lease', async () => {
    const { root, remote, home, commit } = await setup();
    const { planDigest } = await bindContract(root, home, commit);
    await writeFile(path.join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nprintf "push\\n" >> "$GIT_DIR/push-count"\n');
    await chmod(path.join(remote, 'hooks', 'pre-receive'), 0o755);
    const batch = await approved(root, commit);
    const tmux = await import('../src/tmux.js');
    const original = tmux.run;
    vi.spyOn(tmux, 'run').mockImplementation(async (command: string, args: string[], cwd?: string) => {
      if (command === 'git' && args[0] === 'push') {
        const { hubResolve } = await import('../src/hub.js');
        await hubResolve(root, 'demo', 'demo-1', 'rebrief', 'changed scope');
      }
      return original(command, args, cwd);
    });
    const { OPERATION_REGISTRY } = await import('../src/evidence.js');
    await expect(OPERATION_REGISTRY.push.dispatch(
      'origin', commit, 'feat/t16', home, operationApproval(batch, root), contractEnvironment(root, home),
    )).rejects.toThrow(/ambiguous|external/);
    expect(await countPushes(remote)).toBe(0);
    const { foldTasks, readTaskEvents } = await import('../src/state.js');
    const task = foldTasks(await readTaskEvents(root))[0];
    expect(task).toMatchObject({ plan_digest: planDigest, lease_epoch: 1 });
    expect(task.state).not.toBe('asked');
    expect((await readQuestionBatch(root, batch.id)).answers![0].decision?.grant?.operationStatus).not.toBe('succeeded');
  });

  it('fences a queued approved push when its worker lease is revoked', async () => {
    const { root, remote, home, commit } = await setup();
    const { planDigest, admission } = await bindContract(root, home, commit);
    await writeFile(path.join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nprintf "push\\n" >> "$GIT_DIR/push-count"\n');
    await chmod(path.join(remote, 'hooks', 'pre-receive'), 0o755);
    const batch = await approved(root, commit);
    await appendTaskEvent(root, {
      id: 'demo-1', project: 'demo', event: 'admission', at: new Date().toISOString(),
      admission: { ...admission, status: 'revoked', lease_revoked: true },
    });
    const team = await import('../src/state.js').then(({ readTeam }) => readTeam(home));
    team.agents[0].lease_revoked = true;
    await writeJson(hivePath(home, 'team.json'), team);
    const { OPERATION_REGISTRY } = await import('../src/evidence.js');
    await expect(OPERATION_REGISTRY.push.dispatch(
      'origin', commit, 'feat/t16', home, operationApproval(batch, root), contractEnvironment(root, home),
    )).rejects.toThrow(/lease|revoked|current/);
    expect(await countPushes(remote)).toBe(0);
    const { foldTasks, readTaskEvents } = await import('../src/state.js');
    expect(foldTasks(await readTaskEvents(root))[0].plan_digest).toBe(planDigest);
  });

  it('fences lease-less orchestrator dispatch after wall expiry and preserves remote reconciliation', async () => {
    const { root, remote, home, commit } = await setup();
    await bindContract(root, home, commit, 60);
    await writeFile(path.join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nprintf "push\\n" >> "$GIT_DIR/push-count"\n');
    await chmod(path.join(remote, 'hooks', 'pre-receive'), 0o755);
    const team = await import('../src/state.js').then(({ readTeam }) => readTeam(home));
    team.agents[0].orchestrator = true;
    await writeJson(hivePath(home, 'team.json'), team);
    const batch = await approved(root, commit);
    const events = await import('../src/state.js').then(({ readTaskEvents }) => readTaskEvents(root));
    const aged = events.map((event) => ['plan', 'answered'].includes(event.event)
      ? { ...event, at: '2000-01-01T00:00:00.000Z' }
      : event);
    await writeFile(hubPath(root, 'tasks.jsonl'), `${aged.map((event) => JSON.stringify(event)).join('\n')}\n`);
    const before = runCli(home, root, batch, commit);
    expect(before.status).not.toBe(0);
    expect(await countPushes(remote)).toBe(0);
    const { foldTasks, readTaskEvents } = await import('../src/state.js');
    const expired = foldTasks(await readTaskEvents(root))[0];
    const { reconcileTaskBudgets } = await import('../src/admission.js');
    await reconcileTaskBudgets(root, Date.parse(expired.expires_at!) + 1);
    const after = runCli(home, root, batch, commit);
    expect(after.status).not.toBe(0);
    expect(await countPushes(remote)).toBe(0);

    const retained = await setup();
    await bindContract(retained.root, retained.home, retained.commit, 60);
    await writeFile(path.join(retained.remote, 'hooks', 'pre-receive'), '#!/bin/sh\nprintf "push\\n" >> "$GIT_DIR/push-count"\n');
    await chmod(path.join(retained.remote, 'hooks', 'pre-receive'), 0o755);
    const retainedTeam = await import('../src/state.js').then(({ readTeam }) => readTeam(retained.home));
    retainedTeam.agents[0].orchestrator = true;
    await writeJson(hivePath(retained.home, 'team.json'), retainedTeam);
    const retainedBatch = await approved(retained.root, retained.commit);
    expect(runCli(retained.home, retained.root, retainedBatch, retained.commit).status).toBe(0);
    expect(await countPushes(retained.remote)).toBe(1);
    const retainedEvents = await import('../src/state.js').then(({ readTaskEvents }) => readTaskEvents(retained.root));
    const retainedAged = retainedEvents.map((event) => ['plan', 'answered'].includes(event.event)
      ? { ...event, at: '2000-01-01T00:00:00.000Z' }
      : event);
    await writeFile(hubPath(retained.root, 'tasks.jsonl'), `${retainedAged.map((event) => JSON.stringify(event)).join('\n')}\n`);
    const retainedExpired = foldTasks(await readTaskEvents(retained.root))[0];
    await reconcileTaskBudgets(retained.root, Date.parse(retainedExpired.expires_at!) + 1);
    expect(runCli(retained.home, retained.root, retainedBatch, retained.commit).status).toBe(0);
    expect(await countPushes(retained.remote)).toBe(1);
  });
});
