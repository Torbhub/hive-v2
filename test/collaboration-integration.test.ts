import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDecision } from '../src/decisions.js';
import { createQuestionBatch } from '../src/questions.js';
import { appendTaskEvent, hivePath, hubPath, writeJson } from '../src/state.js';
import type { QuestionBatch } from '../src/types.js';
import { createServer } from '../web/server.js';
import {
  AGENT_CREDENTIAL, agentHeaders, configureSecurity, registryItems, securityFile, writeSecurity,
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
  await writeSecurity(root);
  configureSecurity(root);
  const server = createServer(root);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { root, home, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function rows(root: string): Promise<Record<string, unknown>[]> {
  return JSON.parse(await fs.readFile(securityFile(root), 'utf8')).items;
}

async function replaceRows(root: string, values: Record<string, unknown>[]): Promise<void> {
  await fs.writeFile(securityFile(root), JSON.stringify({ items: values }, null, 2));
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
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  delete process.env.HIVE_COLLABORATION_ENABLED;
  delete process.env.HIVE_REGISTRY_FILE;
  delete process.env.HIVE_ASSERTION_KEYS_JSON;
});

describe('integration authorization and revocation', () => {
  it('redacts project metadata when a narrower task grant is revoked despite project read', async () => {
    const { root, home, base } = await fixture();
    await team(home);
    const values = await rows(root);
    values.push({
      pk: 'ACL#demo#demo-1#*', sk: 'PRINCIPAL#agent:builder', project: 'demo', task: 'demo-1',
      principal: 'agent:builder', grantId: 'revoked-task', actions: ['read'], aclEpoch: 2, revokedAt: 1,
    }, {
      pk: 'REVOCATION#ACL#demo#demo-1#*', sk: 'PRINCIPAL#agent:builder', epoch: 2, revokedAt: 1,
    });
    await replaceRows(root, values);
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
    const { root, base } = await fixture();
    const values = await rows(root);
    values.push({
      pk: 'AGENT#builder', sk: 'WAKE#abc', subscriptionId: 'abc', agentId: 'builder',
      executionGrantId: 'agent-grant', createdBy: 'agent:builder', createdAt: 1, revokedAt: null, aclEpoch: 1,
    }, {
      pk: 'REVOCATION#AGENT#builder', sk: 'WAKE#abc', epoch: 2, revokedAt: 2,
    });
    await replaceRows(root, values);
    const response = await fetch(`${base}/api/wake-subscriptions?agentId=builder`, { headers: agentHeaders() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it('requires execute only for execution-granting push approvals', async () => {
    const { root, home, base } = await fixture();
    await team(home);
    const batch = await pushBatch(root);
    const values = await rows(root);
    const grant = values.find((row) => row.sk === 'PRINCIPAL#agent:builder')!;
    grant.actions = ['read', 'write'];
    await replaceRows(root, values);
    expect((await post(base, '/api/questions/answer', {
      id: batch.id, answers: [{ question: 'q1', choice: 'c2' }],
    })).status).toBe(404);

    const general = await createQuestionBatch(root, { project: 'demo', agent: 'builder@one' }, {
      context: 'Choose a direction.', questions: [{
        question: 'Continue?', context: 'General answer.', priority: 1, recommended: 'c1',
        choices: [{ label: 'Yes', description: 'Continue.' }, { label: 'No', description: 'Stop.' }],
      }],
    });
    expect((await post(base, '/api/questions/answer', {
      id: general.id, answers: [{ question: 'q1', choice: 'other', text: 'Use the other path.' }],
    })).status).toBe(200);

    grant.actions = ['read', 'write', 'execute'];
    await replaceRows(root, values);
    const approved = await post(base, '/api/questions/answer', {
      id: batch.id, answers: [{ question: 'q1', choice: 'c2' }],
    });
    expect(approved.status).toBe(200);
    const body = await approved.json();
    expect(body.batch.answers[0].decision.grant.executionAuthority).toBe('push');
    expect(JSON.stringify(body)).not.toContain(AGENT_CREDENTIAL);
  });
});
