import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  answerQuestionBatch, consumePushApproval, createQuestionBatch, readQuestionBatch,
} from '../src/questions.js';
import { appendTaskEvent, hivePath, writeJson, writeProjects } from '../src/state.js';
import type { QuestionBatch } from '../src/types.js';
import {
  AGENT_CREDENTIAL, ASSERTION_KEYS, configureSecurity, registryItems, securityFile, writeSecurity,
} from './security-fixture.js';

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
  await writeSecurity(root, values);
  configureSecurity(root);
  await writeFile(path.join(root, 'credential.env'), `HIVE_AGENT_CREDENTIAL='${AGENT_CREDENTIAL}'\n`, { mode: 0o600 });
  return { root, remote, home, commit };
}

async function approved(root: string, commit: string): Promise<QuestionBatch> {
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
    approverSubject: 'user:alice', approverGrantId: 'human-grant', approverAclEpoch: 2,
  });
}

function environment(root: string, home: string): NodeJS.ProcessEnv {
  return {
    HIVE_HUB_ROOT: root, HIVE_PROJECT: 'demo', HIVE_COLLABORATION_ENABLED: '1',
    HIVE_AGENT_CREDENTIAL_FILE: path.join(root, 'credential.env'),
    HIVE_AGENT_REF: `builder@${home}`, HIVE_REGISTRY_FILE: securityFile(root),
    HIVE_ASSERTION_KEYS_JSON: JSON.stringify(ASSERTION_KEYS),
  };
}

async function rows(root: string): Promise<Record<string, unknown>[]> {
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile(securityFile(root), 'utf8')).items;
}

async function replaceRows(root: string, values: Record<string, unknown>[]): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(securityFile(root), JSON.stringify({ items: values }, null, 2));
}

describe('authenticated push consumption', () => {
  it('binds and consumes a valid approval without running a push', async () => {
    const { root, remote, home, commit } = await setup();
    const batch = await approved(root, commit);
    expect(batch.answers![0].decision?.grant).toMatchObject({
      agent: `builder@${home}`, task: 'demo-1', grantId: 'agent-grant', profileAclEpoch: 1,
      approverSubject: 'user:alice', approverGrantId: 'human-grant', approverAclEpoch: 2,
    });
    const url = await consumePushApproval(
      root, { project: 'demo', batch: batch.id, question: 'q1' },
      'origin', commit, 'feat/t16', home, Date.now(), environment(root, home));
    expect(url).toBe(remote);
    expect((await readQuestionBatch(root, batch.id)).answers![0].decision?.grant?.consumedAt).toBeTruthy();
  });

  it('rejects a revoked consuming credential', async () => {
    const { root, home, commit } = await setup();
    const batch = await approved(root, commit);
    const values = await rows(root);
    values.find((row) => row.pk === 'AGENT#builder' && row.sk === 'PROFILE')!.revokedAt = 1;
    await replaceRows(root, values);
    await expect(consumePushApproval(
      root, { project: 'demo', batch: batch.id, question: 'q1' },
      'origin', commit, 'feat/t16', home, Date.now(), environment(root, home),
    )).rejects.toThrow(/invalid agent credential/);
  });

  it('rejects a revoked current execute grant', async () => {
    const { root, home, commit } = await setup();
    const batch = await approved(root, commit);
    const values = await rows(root);
    values.find((row) => row.sk === 'PRINCIPAL#agent:builder')!.revokedAt = 1;
    await replaceRows(root, values);
    await expect(consumePushApproval(
      root, { project: 'demo', batch: batch.id, question: 'q1' },
      'origin', commit, 'feat/t16', home, Date.now(), environment(root, home),
    )).rejects.toThrow(/not found/);
  });

  it('rejects an other-name agent reference', async () => {
    const { root, home, commit } = await setup();
    const batch = await approved(root, commit);
    const env = { ...environment(root, home), HIVE_AGENT_REF: `mallory@${home}` };
    await expect(consumePushApproval(
      root, { project: 'demo', batch: batch.id, question: 'q1' },
      'origin', commit, 'feat/t16', home, Date.now(), env,
    )).rejects.toThrow(/agent|not found/);
  });

  it('rejects consumption from a different task', async () => {
    const { root, home, commit } = await setup();
    const batch = await approved(root, commit);
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'builder', worktree: home, task: 'demo-2' }],
    });
    await appendTaskEvent(root, { id: 'demo-2', project: 'demo', event: 'asked', at: new Date().toISOString() });
    await expect(consumePushApproval(
      root, { project: 'demo', batch: batch.id, question: 'q1' },
      'origin', commit, 'feat/t16', home, Date.now(), environment(root, home),
    )).rejects.toThrow(/task/);
  });

  it('rejects a project grant replaced by a task grant with the same row-local epoch', async () => {
    const { root, home, commit } = await setup();
    const batch = await approved(root, commit);
    const values = await rows(root);
    const index = values.findIndex((row) => row.sk === 'PRINCIPAL#agent:builder');
    values.splice(index, 1, {
      pk: 'ACL#demo#demo-1#*', sk: 'PRINCIPAL#agent:builder', project: 'demo', task: 'demo-1',
      principal: 'agent:builder', grantId: 'task-grant', actions: ['execute'], aclEpoch: 1, revokedAt: null,
    });
    await replaceRows(root, values);
    await expect(consumePushApproval(
      root, { project: 'demo', batch: batch.id, question: 'q1' },
      'origin', commit, 'feat/t16', home, Date.now(), environment(root, home),
    )).rejects.toThrow(/grant identity/);
  });

  it('rejects an agent ACL change that advances the profile epoch', async () => {
    const { root, home, commit } = await setup();
    const batch = await approved(root, commit);
    const values = await rows(root);
    values.find((row) => row.pk === 'AGENT#builder' && row.sk === 'PROFILE')!.aclEpoch = 2;
    await replaceRows(root, values);
    await expect(consumePushApproval(
      root, { project: 'demo', batch: batch.id, question: 'q1' },
      'origin', commit, 'feat/t16', home, Date.now(), environment(root, home),
    )).rejects.toThrow(/profile ACL epoch/);
  });

  it('rejects a substituted execute grant identity', async () => {
    const { root, home, commit } = await setup();
    const batch = await approved(root, commit);
    const values = await rows(root);
    values.find((row) => row.sk === 'PRINCIPAL#agent:builder')!.grantId = 'different-grant';
    await replaceRows(root, values);
    await expect(consumePushApproval(
      root, { project: 'demo', batch: batch.id, question: 'q1' },
      'origin', commit, 'feat/t16', home, Date.now(), environment(root, home),
    )).rejects.toThrow(/grant identity/);
  });

  it('rejects a revoked human approver grant', async () => {
    const { root, home, commit } = await setup();
    const batch = await approved(root, commit);
    const values = await rows(root);
    values.find((row) => row.sk === 'PRINCIPAL#user:alice')!.revokedAt = 1;
    await replaceRows(root, values);
    await expect(consumePushApproval(
      root, { project: 'demo', batch: batch.id, question: 'q1' },
      'origin', commit, 'feat/t16', home, Date.now(), environment(root, home),
    )).rejects.toThrow(/approver|not found/);
  });

  it('rejects a disabled human approver account even with a valid ACL grant', async () => {
    const { root, home, commit } = await setup();
    const batch = await approved(root, commit);
    const values = await rows(root);
    values.find((row) => row.pk === 'AGENT#builder' && row.sk === 'PROFILE')!.ownerSubject = 'user:bob';
    values.find((row) => row.pk === 'SUBJECT#user:alice')!.accountStatus = 'disabled';
    await replaceRows(root, values);
    await expect(consumePushApproval(
      root, { project: 'demo', batch: batch.id, question: 'q1' },
      'origin', commit, 'feat/t16', home, Date.now(), environment(root, home),
    )).rejects.toThrow(/approver account/);
  });
});
