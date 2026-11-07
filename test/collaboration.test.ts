import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { listOpenQuestionBatches } from '../src/questions.js';
import { serveMcp } from '../src/mcp.js';
import { createServer } from '../web/server.js';
import { writeJson } from '../src/state.js';
import {
  AGENT_CREDENTIAL, ASSERTION_KEYS, CREDENTIAL_ID, MemoryRegistry, agentEnv, agentHeaders, assertion, authHeaders,
  configureSecurity, registryItems, startTestRegistry,
} from './security-fixture.js';

const servers: Server[] = [];

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'hive-collaboration-'));
  const home = path.join(root, 'demo');
  await writeJson(path.join(root, '.hive-hub', 'projects.json'), {
    projects: [{ name: 'demo', home, repos: [{ folder: home }] }],
  });
  await writeJson(path.join(root, '.hive-hub', 'hub.json'), { name: 'hub' });
  const items = registryItems();
  const { broker, registry } = await startTestRegistry(items);
  servers.push(broker);
  configureSecurity();
  const server = createServer(root, registry);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { root, server, base, items, registry };
}

async function post(base: string, pathname: string, body: unknown, headers: Record<string, string>) {
  return fetch(base + pathname, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  delete process.env.HIVE_ASSERTION_KEYS_JSON;
});

describe('human assertion boundary', () => {
  it('rejects missing, proxy-only, shared-secret, tampered, expired, wrong issuer, and wrong audience identity', async () => {
    const { base } = await fixture();
    expect((await fetch(`${base}/api/view`)).status).toBe(401);
    expect((await fetch(`${base}/api/view`, { headers: { 'x-nexus-subject': 'user:alice' } })).status).toBe(401);
    expect((await fetch(`${base}/api/view`, { headers: { 'x-hive-auth': 'legacy-shared-secret' } })).status).toBe(401);
    const valid = assertion();
    for (const token of [
      `${valid.slice(0, valid.lastIndexOf('.') + 1)}${'A'.repeat(43)}`,
      assertion('user:alice', { exp: Math.floor(Date.now() / 1000) - 1 }),
      assertion('user:alice', { iss: 'other' }), assertion('user:alice', { aud: 'other' }),
      assertion('alice'),
    ]) {
      expect((await fetch(`${base}/api/view`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    }
    expect((await fetch(`${base}/api/view`, { headers: authHeaders() })).status).toBe(200);
  });

  it('checks current account status and epoch without a validation cache', async () => {
    const { base, items } = await fixture();
    const rows = items;
    const account = rows.find((row) => row.pk === 'SUBJECT#user:alice')!;
    account.accountStatus = 'disabled';
    account.accountEpoch = 2;
    expect((await fetch(`${base}/api/view`, { headers: authHeaders() })).status).toBe(401);
    account.accountStatus = 'active';
    expect((await fetch(`${base}/api/view`, { headers: authHeaders() })).status).toBe(401);
  });

  it('accepts current and overlap keys and rejects unknown and retired keys', async () => {
    const { base } = await fixture();
    expect((await fetch(`${base}/api/view`, { headers: { authorization: `Bearer ${assertion('user:alice', {}, 'old')}` } })).status).toBe(200);
    expect((await fetch(`${base}/api/view`, { headers: { authorization: `Bearer ${assertion('user:alice', {}, 'unknown')}` } })).status).toBe(401);
    process.env.HIVE_ASSERTION_KEYS_JSON = JSON.stringify({
      ...ASSERTION_KEYS,
      keys: { ...ASSERTION_KEYS.keys, old: { ...ASSERTION_KEYS.keys.old, retireAt: Math.floor(Date.now() / 1000) - 1 } },
    });
    expect((await fetch(`${base}/api/view`, { headers: { authorization: `Bearer ${assertion('user:alice', {}, 'old')}` } })).status).toBe(401);
  });
});

describe('agent credential and ACL matrix', () => {
  it('derives owner, agent, project, and epochs from the credential without returning its secret', async () => {
    const { base } = await fixture();
    const response = await fetch(`${base}/api/agent/identity`, {
      headers: { ...agentHeaders(), 'x-hive-agent': 'mallory', 'x-hive-project': 'other' },
    });
    expect(response.status).toBe(200);
    const identity = await response.json();
    expect(identity).toMatchObject({
      agentId: 'builder', ownerSubject: 'user:alice', project: 'demo', aclEpoch: 1, credentialEpoch: 1,
    });
    expect(JSON.stringify(identity)).not.toContain(AGENT_CREDENTIAL);
    expect(JSON.stringify(identity)).not.toContain('test-agent-secret-with-high-entropy');
  });

  it('rejects legacy secrets, unregistered, swapped, revoked, and cross-project agent access', async () => {
    const { base, items } = await fixture();
    for (const headers of [
      { 'x-hive-auth': AGENT_CREDENTIAL }, agentHeaders('hva1.ghost.0123456789abcdef.secret'),
      agentHeaders(AGENT_CREDENTIAL.replace('builder', 'other')),
    ]) {
      expect((await fetch(`${base}/api/agent/identity`, { headers })).status).toBe(401);
    }
    expect((await post(base, '/api/task', { project: 'other', text: 'foreign' }, agentHeaders())).status).toBe(404);
    const rows = items;
    rows.find((row) => row.sk === `CRED#${CREDENTIAL_ID}`)!.revokedAt = Math.floor(Date.now() / 1000);
    expect((await fetch(`${base}/api/agent/identity`, { headers: agentHeaders() })).status).toBe(401);
  });

  it('supports bounded rotation and rejects expired or revoked old credentials immediately', async () => {
    const { base, items } = await fixture();
    const rows = items;
    const old = rows.find((row) => row.sk === `CRED#${CREDENTIAL_ID}`)!;
    const secondId = 'fedcba9876543210';
    const secondSecret = 'second-agent-secret-with-high-entropy';
    const second = `hva1.builder.${secondId}.${secondSecret}`;
    old.expiresAt = Math.floor(Date.now() / 1000) + 60;
    rows.push({
      pk: 'AGENT#builder', sk: `CRED#${secondId}`, credentialId: secondId, salt: 'second-salt',
      credentialHash: createHash('sha256').update(`second-salt:${secondSecret}`).digest('hex'),
      expiresAt: 0, revokedAt: null, credentialEpoch: 2,
    });
    rows.find((row) => row.pk === 'AGENT#builder' && row.sk === 'PROFILE')!.credentialEpoch = 2;
    expect((await fetch(`${base}/api/agent/identity`, { headers: agentHeaders() })).status).toBe(200);
    expect((await fetch(`${base}/api/agent/identity`, { headers: agentHeaders(second) })).status).toBe(200);
    old.expiresAt = Math.floor(Date.now() / 1000) - 1;
    expect((await fetch(`${base}/api/agent/identity`, { headers: agentHeaders() })).status).toBe(401);
    old.expiresAt = 0;
    old.revokedAt = Math.floor(Date.now() / 1000);
    expect((await fetch(`${base}/api/agent/identity`, { headers: agentHeaders() })).status).toBe(401);
  });

  it('does not infer project administration, execution, or cross-task/thread access', async () => {
    const { base, items } = await fixture();
    const rows = items;
    rows.splice(rows.findIndex((row) => row.sk === 'PRINCIPAL#agent:builder'), 1, {
      pk: 'ACL#demo#demo-1#thread-1', sk: 'PRINCIPAL#agent:builder', project: 'demo', task: 'demo-1', thread: 'thread-1',
      principal: 'agent:builder', grantId: 'message-only', actions: ['read', 'write'], aclEpoch: 2, revokedAt: null,
    });
    expect((await post(base, '/api/task', { project: 'demo', text: 'scoped', task: 'demo-1', thread: 'thread-1' }, agentHeaders())).status).toBe(404);
    expect((await post(base, '/api/wake', { project: 'demo', task: 'demo-1', thread: 'thread-1' }, agentHeaders())).status).toBe(404);
    expect((await post(base, '/api/task', { project: 'demo', text: 'foreign', task: 'demo-2', thread: 'thread-1' }, agentHeaders())).status).toBe(404);
    expect((await post(base, '/api/task', { project: 'demo', text: 'foreign', task: 'demo-1', thread: 'other' }, agentHeaders())).status).toBe(404);
  });
});

describe('MCP identity and revocation', () => {
  function connect(root: string, env = agentEnv(root), registry?: MemoryRegistry) {
    const input = new PassThrough();
    let out = '';
    const output = new Writable({ write(chunk, _encoding, callback) { out += chunk.toString(); callback(); } });
    const server = serveMcp({ input, output, env, registry, pollMs: 5 });
    return {
      input, server,
      send(value: unknown) { input.write(JSON.stringify(value) + '\n'); },
      messages() { return out.split('\n').filter(Boolean).map((line) => JSON.parse(line)); },
      async wait() {
        const deadline = Date.now() + 3000;
        while (this.messages().length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
        return this.messages();
      },
    };
  }

  const batch = {
    context: 'Choose a database',
    questions: [{ question: 'Which store?', context: 'Pick one', priority: 1, recommended: 'c1', choices: [
      { label: 'DynamoDB', description: 'Managed' }, { label: 'JSON', description: 'Local' },
    ] }],
  };

  it('derives batch identity from the credential and terminates an active wait on revocation', async () => {
    const { root, items, registry } = await fixture();
    const { appendTaskEvent, hivePath } = await import('../src/state.js');
    const home = path.join(root, 'demo');
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'builder', worktree: home, task: 'demo-1' }],
    });
    await appendTaskEvent(root, { id: 'demo-1', project: 'demo', event: 'asked', at: new Date().toISOString() });
    const client = connect(root, agentEnv(root), registry);
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_operator', arguments: batch } });
    const deadline = Date.now() + 3000;
    let open = await listOpenQuestionBatches(root);
    while (open.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      open = await listOpenQuestionBatches(root);
    }
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ project: 'demo', agent: 'builder' });
    const rows = items;
    rows.find((row) => row.pk === 'AGENT#builder' && row.sk === 'PROFILE')!.revokedAt = Math.floor(Date.now() / 1000);
    const messages = await client.wait();
    expect(messages).toHaveLength(1);
    expect(messages[0].result.isError).toBe(true);
    expect(messages[0].result.content[0].text).toContain('authorization');
    expect(JSON.stringify(messages)).not.toContain(AGENT_CREDENTIAL);
    client.server.close();
  });

  it('rejects environment-only identity and the legacy shared web secret', async () => {
    const { root, registry } = await fixture();
    const client = connect(root, {
      HIVE_HUB_ROOT: root, HIVE_AGENT: 'builder', HIVE_PROJECT: 'demo', HIVE_WEB_SECRET: AGENT_CREDENTIAL,
    }, registry);
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_operator', arguments: batch } });
    const messages = await client.wait();
    expect(messages).toHaveLength(1);
    expect(messages[0].result.isError).toBe(true);
    expect(messages[0].result.content[0].text).toContain('HIVE_AGENT_CREDENTIAL');
    expect(await listOpenQuestionBatches(root)).toEqual([]);
    client.server.close();
  });
});

describe('wake subscription broker', () => {
  it('maps denials and returns the Citadel projection', async () => {
    const { base } = await fixture();
    expect((await post(base, '/api/wake-subscriptions', { agentId: 'builder', executionGrantId: 'bob-write' }, authHeaders('user:bob'))).status).toBe(404);
    const created = await post(base, '/api/wake-subscriptions', { agentId: 'builder', executionGrantId: 'owner:builder' }, authHeaders());
    expect(created.status).toBe(200);
    const subscription = await created.json();
    expect(subscription).toEqual({
      subscriptionId: 'wake-test', agentId: 'builder', executionGrantId: 'owner:builder',
      createdBy: 'user:alice', createdAt: 1, revokedAt: null, aclEpoch: 1,
    });
    expect(JSON.stringify(subscription)).not.toContain(AGENT_CREDENTIAL);

    const granted = await post(base, '/api/wake-subscriptions', { agentId: 'builder', executionGrantId: 'bob-execute' }, authHeaders('user:bob'));
    expect(granted.status).toBe(200);
    expect((await granted.json()).executionGrantId).toBe('bob-execute');
  });
});
