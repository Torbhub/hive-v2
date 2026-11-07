import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQuestionBatch } from '../src/questions.js';
import { DynamoCliRegistry, RegistryUnavailable } from '../src/registry.js';
import { authenticateBearer } from '../src/security.js';
import { appendTaskEvent, hivePath, hubPath, writeJson } from '../src/state.js';
import { buildView } from '../src/view.js';
import { createServer } from '../web/server.js';
import {
  AGENT_CREDENTIAL, agentHeaders, authHeaders, configureSecurity, registryItems, startTestRegistry,
} from './security-fixture.js';

vi.mock('../src/view.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/view.js')>();
  return { ...actual, buildView: vi.fn(actual.buildView) };
});

const servers: Server[] = [];

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'hive-review2-'));
  const home = path.join(root, 'demo');
  await writeJson(hubPath(root, 'projects.json'), {
    projects: [{ name: 'demo', home, repos: [{ folder: home }] }],
  });
  await writeJson(hubPath(root, 'hub.json'), { name: 'hub' });
  await appendTaskEvent(root, { id: 'demo-1', project: 'demo', event: 'asked', at: new Date().toISOString() });
  await appendTaskEvent(root, { id: 'demo-2', project: 'demo', event: 'asked', at: new Date().toISOString() });
  const items = registryItems();
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

function taskGrant(task = 'demo-1') {
  return {
    pk: `ACL#demo#${task}#*`, sk: 'PRINCIPAL#agent:builder', project: 'demo', task,
    principal: 'agent:builder', grantId: 'task-grant', actions: ['read', 'write', 'execute', 'admin'],
    aclEpoch: 1, revokedAt: null,
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  delete process.env.HIVE_COLLABORATION_ENABLED;
  delete process.env.HIVE_ASSERTION_KEYS_JSON;
});

describe('project-level authority and metadata', () => {
  it('does not allow task-scoped grants for wake continue mode approvals or project deletion', async () => {
    const { base, items } = await fixture();
    const values = items;
    values.splice(values.findIndex((row) => row.sk === 'PRINCIPAL#agent:builder'), 1, taskGrant());
    for (const [pathname, body] of [
      ['/api/wake', { project: 'demo', task: 'demo-1' }],
      ['/api/continue', { project: 'demo', task: 'demo-1' }],
      ['/api/mode', { project: 'demo', task: 'demo-1', mode: 'ask' }],
      ['/api/approvals', { project: 'demo', task: 'demo-1', approvals: 'manual' }],
      ['/api/project-delete', { project: 'demo', task: 'demo-1' }],
    ] as const) {
      expect((await post(base, pathname, body)).status).toBe(404);
    }
  });

  it('filters other agents repo orchestrator and count metadata for task-only reads', async () => {
    const { root, home, base, items } = await fixture();
    await writeJson(hivePath(home, 'team.json'), { agents: [
      { name: 'demo-orchestrator', orchestrator: true },
      { name: 'builder', task: 'demo-1', worktree: 'one' },
      { name: 'builder', task: 'demo-2', worktree: 'two' },
      { name: 'other', task: 'demo-2' },
    ] });
    await createQuestionBatch(root, { project: 'demo', agent: 'builder@one' }, {
      context: 'task one', questions: [{
        question: 'Continue?', context: 'task', priority: 1, recommended: 'c1',
        choices: [{ label: 'Yes', description: 'continue' }, { label: 'No', description: 'stop' }],
      }],
    });
    const values = items;
    values.splice(values.findIndex((row) => row.sk === 'PRINCIPAL#agent:builder'), 1, taskGrant());
    const view = await (await fetch(`${base}/api/view`, { headers: agentHeaders() })).json();
    expect(view.tasks.map((task: { id: string }) => task.id)).toEqual(['demo-1']);
    expect(view.projects).toHaveLength(1);
    const project = view.projects[0];
    expect(project.home).toBe('');
    expect(project.repos).toEqual([]);
    expect(project.open_tasks).toBe(1);
    expect(project.agents.map((agent: { name: string }) => agent.name)).toEqual(['builder']);
    expect(project.orchestrator.state).toBe('unregistered');
  });

  it('rejects an ambiguous bare duplicate agent and honors an exact worktree', async () => {
    const { root, home, base, items } = await fixture();
    await writeJson(hivePath(home, 'team.json'), { agents: [
      { name: 'demo-orchestrator', orchestrator: true },
      { name: 'builder', task: 'demo-1', worktree: 'one' },
      { name: 'builder', task: 'demo-2', worktree: 'two' },
    ] });
    const values = items;
    values.splice(values.findIndex((row) => row.sk === 'PRINCIPAL#agent:builder'), 1, taskGrant());
    expect((await post(base, '/api/answer', {
      project: 'demo', agent: 'builder', choice: '1', fingerprint: 'x',
    })).status).toBe(404);
    expect((await post(base, '/api/answer', {
      project: 'demo', agent: 'builder@one', choice: '1', fingerprint: 'x',
    })).status).toBe(400);
  });

  it('keeps authorized orchestrator and worktree-qualified dialogs with duplicate names', async () => {
    const { root, home, base } = await fixture();
    await writeJson(hivePath(home, 'team.json'), { agents: [
      { name: 'demo-orchestrator', orchestrator: true, task: 'demo-1' },
      { name: 'builder', task: 'demo-2', worktree: '/wt/a' },
      { name: 'builder', task: 'demo-1', worktree: '/wt/b' },
    ] });
    const dialog = {
      kind: 'menu', text: 'Run this command?', options: [], cursor: null, esc: true,
      fingerprint: 'fp', project: 'demo', session: 'builder', pane: '%2',
    };
    vi.mocked(buildView).mockResolvedValueOnce({
      root, hubName: 'hub', projects: [], tasks: [], decisions: [], questions: [], questionsTotal: 0,
      dialogs: {
        demo: { ...dialog, session: 'demo-orchestrator', pane: '%1' },
        'demo/builder@/wt/b': dialog,
      },
      updatedAt: 1, error: '',
    } as never);
    const response = await fetch(`${base}/api/view`, { headers: agentHeaders() });
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(Object.keys(view.dialogs)).toEqual(['demo', 'demo/builder@/wt/b']);
  });
});

describe('independent revocation and broker status', () => {
  it('accepts null broker account expiry for human and agent authentication', async () => {
    const { base } = await fixture();
    expect((await fetch(`${base}/api/view`, { headers: authHeaders() })).status).toBe(200);
    expect((await fetch(`${base}/api/agent/identity`, { headers: agentHeaders() })).status).toBe(200);
  });

  it('denies credentials profiles ACLs and wakes with revocation records', async () => {
    const { base, items } = await fixture();
    const values = items;
    values.push({
      pk: 'REVOCATION#AGENT#builder', sk: 'PROFILE', epoch: 2, revokedAt: 1,
    });
    expect((await fetch(`${base}/api/agent/identity`, { headers: agentHeaders() })).status).toBe(401);
    values.push({
      pk: 'REVOCATION#ACL#demo#*#*', sk: 'PRINCIPAL#agent:builder', epoch: 2, revokedAt: 1,
    });
    expect((await post(base, '/api/wake-subscriptions', {
      agentId: 'builder', executionGrantId: 'agent-grant',
    })).status).toBe(401);
  });

  it('preserves broker 401 404 and 503 categories', async () => {
    const http = await import('node:http');
    const broker = http.createServer((req, res) => {
      const status = req.url === '/api/hive/broker/account-status' ? 401
        : req.url === '/api/hive/broker/wake-subscriptions/revoke' ? 404 : 500;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end('{}');
    });
    servers.push(broker);
    await new Promise<void>((resolve) => broker.listen(0, '127.0.0.1', resolve));
    const registry = new DynamoCliRegistry('unused', `http://127.0.0.1:${(broker.address() as AddressInfo).port}`);
    await expect(registry.currentAccount('user:alice', AGENT_CREDENTIAL)).rejects.toMatchObject({ status: 401 });
    await expect(registry.createWakeSubscription('builder', AGENT_CREDENTIAL, 'agent-grant'))
      .rejects.toMatchObject({ status: 500 });
    await expect(registry.revokeWakeSubscription('builder', AGENT_CREDENTIAL, 'abc'))
      .rejects.toMatchObject({ status: 404 });
  });
});
