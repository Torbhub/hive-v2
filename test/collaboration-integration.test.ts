import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDecision } from '../src/decisions.js';
import { createQuestionBatch, readQuestionBatch } from '../src/questions.js';
import { disableExecution } from '../src/rollout.js';
import { appendTaskEvent, hivePath, hubPath, writeJson } from '../src/state.js';
import type { QuestionBatch } from '../src/types.js';
import { createServer } from '../web/server.js';
import {
  AGENT_CREDENTIAL, agentHeaders, configureSecurity, registryItems, startTestRegistry,
} from './security-fixture.js';

const servers: Server[] = [];

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'hive-integration-'));
  const home = path.join(root, 'demo');
  await writeJson(hubPath(root, 'projects.json'), {
    projects: [{ name: 'demo', home, repos: [{ folder: home }] }],
  });
  await writeJson(hubPath(root, 'hub.json'), { name: 'hub' });
  await appendTaskEvent(root, { id: 'demo-1', project: 'demo', event: 'asked', at: new Date().toISOString() });
  await appendTaskEvent(root, { id: 'demo-2', project: 'demo', event: 'asked', at: new Date().toISOString() });
  const items = registryItems();
  for (const row of items) {
    if (row.pk === 'ACL#demo#demo-1#*') {
      row.pk = 'ACL#demo#*#*';
      row.task = null;
    }
  }
  const { broker, registry } = await startTestRegistry(items);
  servers.push(broker);
  configureSecurity();
  const server = createServer(root, registry);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { root, home, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, items };
}

async function post(base: string, pathname: string, body: unknown) {
  return fetch(base + pathname, {
    method: 'POST', headers: { 'content-type': 'application/json', ...agentHeaders() }, body: JSON.stringify(body),
  });
}

function team(home: string) {
  return writeJson(hivePath(home, 'team.json'), { agents: [
    { name: 'demo-orchestrator', orchestrator: true },
    { name: 'builder', task: 'demo-1', worktree: 'one' },
    { name: 'other', task: 'demo-2', worktree: 'two' },
  ] });
}

function pushBatch(root: string): Promise<QuestionBatch> {
  const now = Date.now();
  const batch: QuestionBatch = {
    id: randomUUID(), project: 'demo', agent: 'builder@one', context: 'Review the push.',
    questions: [{
      id: 'q1', priority: 1,
      ...buildDecision({
        action: 'push', repository: 'origin', branch: 'feat/t16', commit: 'a'.repeat(40),
        diffSummary: '1 file changed', destination: 'origin/feat/t16', reason: 'Reviewed.',
        verifiedAt: new Date(now).toISOString(), validUntil: new Date(now + 60_000).toISOString(),
      }, 'test decision', now),
    }],
    status: 'open', createdAt: new Date(now).toISOString(),
  };
  return writeJson(hubPath(root, 'questions', `${batch.id}.json`), batch).then(() => batch);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  delete process.env.HIVE_COLLABORATION_ENABLED;
  delete process.env.HIVE_ASSERTION_KEYS_JSON;
});

describe('integration authorization and revocation', () => {
  it('redacts project metadata when a narrower task grant is revoked despite project read', async () => {
    const { root, home, base, items } = await fixture();
    await team(home);
    const values = items;
    values.push({
      pk: 'ACL#demo#demo-1#*', sk: 'PRINCIPAL#agent:builder', project: 'demo', task: 'demo-1',
      principal: 'agent:builder', grantId: 'revoked-task', actions: ['read'], aclEpoch: 2, revokedAt: 1,
    }, {
      pk: 'REVOCATION#ACL#demo#demo-1#*', sk: 'PRINCIPAL#agent:builder', epoch: 2, revokedAt: 1,
    });
    const view = await (await fetch(`${base}/api/view`, { headers: agentHeaders() })).json();
    expect(view.tasks.map((task: { id: string }) => task.id)).toEqual(['demo-2']);
    expect(view.projects).toHaveLength(1);
    expect(view.projects[0].home).toBe('');
    expect(view.projects[0].repos).toEqual([]);
    expect(view.projects[0].open_tasks).toBe(1);
    expect(view.projects[0].agents.map((agent: { name: string }) => agent.name)).toEqual(['other']);
    expect(view.projects[0].orchestrator.state).toBe('unregistered');
  });

  it('filters wake rows with independent ledger tombstones', async () => {
    const { base, items } = await fixture();
    const values = items;
    values.push({
      pk: 'AGENT#builder', sk: 'WAKE#abc', subscriptionId: 'abc', agentId: 'builder',
      executionGrantId: 'agent-grant', createdBy: 'agent:builder', createdAt: 1, revokedAt: null, aclEpoch: 1,
    }, {
      pk: 'REVOCATION#AGENT#builder', sk: 'WAKE#abc', epoch: 2, revokedAt: 2,
    });
    const response = await fetch(`${base}/api/wake-subscriptions?agentId=builder`, { headers: agentHeaders() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it('requires execute only for execution-granting push approvals', async () => {
    const { root, home, base, items } = await fixture();
    const { authHeaders } = await import('./security-fixture.js');
    const postAsOwner = (id: string, answers: unknown) => fetch(`${base}/api/questions/answer`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ id, answers }),
    });
    await team(home);
    const batch = await pushBatch(root);
    const values = items;
    for (const subject of ['user:alice', 'agent:builder']) {
      const row = values.find((candidate) => candidate.sk === `PRINCIPAL#${subject}`)!;
      row.pk = 'ACL#demo#demo-1#*';
      row.task = 'demo-1';
    }
    const grant = values.find((row) => row.sk === 'PRINCIPAL#user:alice')!;
    grant.actions = ['read', 'write'];
    expect((await postAsOwner(batch.id, [{ question: 'q1', choice: 'c2' }])).status).toBe(404);

    const general = await createQuestionBatch(root, { project: 'demo', agent: 'builder@one' }, {
      context: 'Choose a direction.', questions: [{
        question: 'Continue?', context: 'General answer.', priority: 1, recommended: 'c1',
        choices: [{ label: 'Yes', description: 'Continue.' }, { label: 'No', description: 'Stop.' }],
      }],
    });
    expect((await postAsOwner(
      general.id, [{ question: 'q1', choice: 'other', text: 'Use the other path.' }],
    )).status).toBe(200);

    grant.actions = ['read', 'write', 'execute'];
    const approved = await postAsOwner(batch.id, [{ question: 'q1', choice: 'c2' }]);
    expect(approved.status).toBe(200);
    const body = await approved.json();
    expect(body.batch.answers[0].decision.grant).toMatchObject({
      executionAuthority: 'push', agent: 'builder@one', task: 'demo-1',
      grantId: 'agent-grant', profileAclEpoch: 1,
      approverSubject: 'user:alice', approverGrantId: 'human-grant', approverAclEpoch: 1,
    });
    expect(JSON.stringify(body)).not.toContain(AGENT_CREDENTIAL);
  });

  it('rejects a project-only consumer grant during execution approval creation', async () => {
    const { root, home, base, items } = await fixture();
    const { authHeaders } = await import('./security-fixture.js');
    await team(home);
    const batch = await pushBatch(root);
    const values = items;
    const approver = values.find((row) => row.sk === 'PRINCIPAL#user:alice')!;
    approver.pk = 'ACL#demo#demo-1#*';
    approver.task = 'demo-1';
    const response = await fetch(`${base}/api/questions/answer`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ id: batch.id, answers: [{ question: 'q1', choice: 'c2' }] }),
    });
    expect(response.status).toBe(404);
    expect((await readQuestionBatch(root, batch.id)).status).toBe('open');
  });

  it('rejects a project-only approver grant during execution approval creation', async () => {
    const { root, home, base, items } = await fixture();
    const { authHeaders } = await import('./security-fixture.js');
    await team(home);
    const batch = await pushBatch(root);
    const values = items;
    const consumer = values.find((row) => row.sk === 'PRINCIPAL#agent:builder')!;
    consumer.pk = 'ACL#demo#demo-1#*';
    consumer.task = 'demo-1';
    const response = await fetch(`${base}/api/questions/answer`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ id: batch.id, answers: [{ question: 'q1', choice: 'c2' }] }),
    });
    expect(response.status).toBe(404);
    expect((await readQuestionBatch(root, batch.id)).status).toBe('open');
  });

  it('rejects an agent principal for an execution approval', async () => {
    const { root, home, base, items } = await fixture();
    await team(home);
    const batch = await pushBatch(root);
    const values = items;
    const approver = values.find((row) => row.sk === 'PRINCIPAL#agent:builder')!;
    approver.pk = 'ACL#demo#demo-1#*';
    approver.task = 'demo-1';
    expect((await post(base, '/api/questions/answer', {
      id: batch.id, answers: [{ question: 'q1', choice: 'c2' }],
    })).status).toBe(400);
    expect((await readQuestionBatch(root, batch.id)).status).toBe('open');
  });

  it('blocks project fallback and redacts metadata for a restored ledger-only task revocation', async () => {
    const { root, home, base, items } = await fixture();
    await team(home);
    const values = items;
    values.push({
      pk: 'REVOCATION#ACL#demo#demo-1#*', sk: 'PRINCIPAL#agent:builder', epoch: 2, revokedAt: 1,
    });
    const view = await (await fetch(`${base}/api/view`, { headers: agentHeaders() })).json();
    expect(view.tasks.map((task: { id: string }) => task.id)).toEqual(['demo-2']);
    expect(view.projects[0].home).toBe('');
    expect(view.projects[0].repos).toEqual([]);
    expect(view.projects[0].agents.map((agent: { name: string }) => agent.name)).toEqual(['other']);
    expect(view.projects[0].open_tasks).toBe(1);
  });

  it('redacts metadata for an active narrower grant that denies read', async () => {
    const { root, home, base, items } = await fixture();
    await team(home);
    const values = items;
    values.push({
      pk: 'ACL#demo#demo-1#*', sk: 'PRINCIPAL#agent:builder', project: 'demo', task: 'demo-1',
      principal: 'agent:builder', grantId: 'write-only-task', actions: ['write'], aclEpoch: 1, revokedAt: null,
    });
    const view = await (await fetch(`${base}/api/view`, { headers: agentHeaders() })).json();
    expect(view.tasks.map((task: { id: string }) => task.id)).toEqual(['demo-2']);
    expect(view.projects[0].home).toBe('');
    expect(view.projects[0].repos).toEqual([]);
    expect(view.projects[0].agents.map((agent: { name: string }) => agent.name)).toEqual(['other']);
    expect(view.projects[0].open_tasks).toBe(1);
  });

  it('preserves ordinary execute endpoints without question-batch approval binding', async () => {
    const { root, home, base } = await fixture();
    await team(home);
    const hub = await import('../src/hub.js');
    vi.spyOn(hub, 'wake').mockResolvedValue('%1');
    vi.spyOn(hub, 'continueProject').mockResolvedValue('%2');
    vi.spyOn(hub, 'startProject').mockResolvedValue('%3');
    vi.spyOn(hub, 'answerDialog').mockResolvedValue({
      answered: true, option: '1', choice: '1', session: 'builder', dialog_gone: true,
    });
    const interrupt = await import('../src/interrupt.js');
    vi.spyOn(interrupt, 'interruptAgent').mockResolvedValue({ target: 'builder', pane: '%1' });
    const kill = await import('../src/kill.js');
    vi.spyOn(kill, 'killAgent').mockResolvedValue({ target: 'builder', killed: ['builder'], summary: 'killed builder' });
    for (const [pathname, body] of [
      ['/api/wake', { project: 'demo', task: 'demo-1' }],
      ['/api/continue', { project: 'demo', task: 'demo-1' }],
      ['/api/start', { project: 'demo', task: 'demo-1' }],
      ['/api/interrupt', { project: 'demo', agent: 'builder@one' }],
      ['/api/kill', { project: 'demo', agent: 'builder@one' }],
      ['/api/answer', { project: 'demo', agent: 'builder@one', choice: '1', fingerprint: 'x' }],
    ] as const) {
      expect((await post(base, pathname, body)).status).toBe(200);
    }
  });

  it('returns 409 for paused execution and preserves non-execution controls', async () => {
    const { root, home, base } = await fixture();
    await team(home);
    const interrupt = await import('../src/interrupt.js');
    vi.spyOn(interrupt, 'interruptAgent').mockResolvedValue({ target: 'builder', pane: '%1' });
    const kill = await import('../src/kill.js');
    vi.spyOn(kill, 'killAgent').mockResolvedValue({ target: 'builder', killed: ['builder'], summary: 'killed builder' });
    await disableExecution(root, 'demo');

    const { authHeaders } = await import('./security-fixture.js');
    const denied = await fetch(`${base}/api/wake`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders('user:bob') },
      body: JSON.stringify({ project: 'demo' }),
    });
    expect(denied.status).toBe(404);
    for (const [pathname, body] of [
      ['/api/wake', { project: 'demo' }],
      ['/api/continue', { project: 'demo' }],
      ['/api/start', { project: 'demo', task: 'demo-1' }],
      ['/api/answer', { project: 'demo', agent: 'builder@one', choice: '1', fingerprint: 'x' }],
    ] as const) {
      const response = await post(base, pathname, body);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ ok: false, detail: 'rollout paused for demo' });
    }
    expect((await fetch(`${base}/api/view`, { headers: agentHeaders() })).status).toBe(200);
    await appendTaskEvent(root, {
      id: 'demo-1', project: 'demo', event: 'plan', at: new Date().toISOString(),
      checkpoints: [{ id: 'a', desc: 'bounded work', etaMin: 5 }],
    });
    expect((await post(base, '/api/progress', {
      project: 'demo', task: 'demo-1', checkpoint: 'a', status: 'started',
    })).status).toBe(200);
    expect((await post(base, '/api/interrupt', { project: 'demo', agent: 'builder@one' })).status).toBe(200);
    expect((await post(base, '/api/kill', { project: 'demo', agent: 'builder@one' })).status).toBe(200);

    const general = await createQuestionBatch(root, { project: 'demo', agent: 'builder@one' }, {
      context: 'Choose a direction.', questions: [{
        question: 'Continue?', context: 'General answer.', priority: 1, recommended: 'c1',
        choices: [{ label: 'Yes', description: 'Continue.' }, { label: 'No', description: 'Stop.' }],
      }],
    });
    expect((await post(base, '/api/questions/answer', {
      id: general.id, answers: [{ question: 'q1', choice: 'c1' }],
    })).status).toBe(200);
    const cancellable = await createQuestionBatch(root, { project: 'demo', agent: 'builder@one' }, {
      context: 'Cancel this question.', questions: [{
        question: 'Continue?', context: 'Cancellation.', priority: 1, recommended: 'c1',
        choices: [{ label: 'Yes', description: 'Continue.' }, { label: 'No', description: 'Stop.' }],
      }],
    });
    expect((await post(base, '/api/questions/cancel', { id: cancellable.id })).status).toBe(200);
  });

  it('blocks execution-granting answers without closing the question', async () => {
    const { root, home, base, items } = await fixture();
    await team(home);
    for (const subject of ['user:alice', 'agent:builder']) {
      const row = items.find((candidate) => candidate.sk === `PRINCIPAL#${subject}`)!;
      row.pk = 'ACL#demo#demo-1#*';
      row.task = 'demo-1';
    }
    const batch = await pushBatch(root);
    await disableExecution(root, 'demo');
    const { authHeaders } = await import('./security-fixture.js');
    const response = await fetch(`${base}/api/questions/answer`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ id: batch.id, answers: [{ question: 'q1', choice: 'c2' }] }),
    });
    expect(response.status).toBe(409);
    expect((await readQuestionBatch(root, batch.id)).status).toBe('open');
  });

  it('normalizes missing and corrupt project config for scoped dialog execution', async () => {
    for (const contents of [null, '{"projects": [', '{}', '{"projects":null}']) {
      const { root, home, base } = await fixture();
      await team(home);
      if (contents === null) await fs.rm(hubPath(root, 'projects.json'));
      else await fs.writeFile(hubPath(root, 'projects.json'), contents);
      const response = await post(base, '/api/answer', {
        project: 'demo', agent: 'builder@one', choice: '1', fingerprint: 'x',
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ ok: false, detail: 'rollout paused for demo' });
    }

    const { home, base } = await fixture();
    await team(home);
    expect((await post(base, '/api/answer', {
      project: 'demo', agent: 'ghost', choice: '1', fingerprint: 'x',
    })).status).toBe(404);
  });

  it('normalizes corrupt scope config for execution-granting answers only', async () => {
    for (const contents of ['{"projects": [', '{}', '{"projects":null}']) {
      const { root, home, base, items } = await fixture();
      await team(home);
      for (const subject of ['user:alice', 'agent:builder']) {
        const row = items.find((candidate) => candidate.sk === `PRINCIPAL#${subject}`)!;
        row.pk = 'ACL#demo#demo-1#*';
        row.task = 'demo-1';
      }
      const batch = await pushBatch(root);
      await fs.writeFile(hubPath(root, 'projects.json'), contents);
      const { authHeaders } = await import('./security-fixture.js');
      const response = await fetch(`${base}/api/questions/answer`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ id: batch.id, answers: [{ question: 'q1', choice: 'c2' }] }),
      });
      expect(response.status).toBe(409);
      expect((await readQuestionBatch(root, batch.id)).status).toBe('open');
    }
  });
});
