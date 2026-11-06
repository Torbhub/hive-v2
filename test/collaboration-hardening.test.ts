import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { serveMcp } from '../src/mcp.js';
import { createQuestionBatch, listOpenQuestionBatches } from '../src/questions.js';
import { appendTaskEvent, hivePath, hubPath, writeJson } from '../src/state.js';
import { createServer } from '../web/server.js';
import {
  AGENT_CREDENTIAL, ASSERTION_KEYS, agentEnv, agentHeaders, assertion, authHeaders,
  configureSecurity, registryItems, securityFile, writeSecurity,
} from './security-fixture.js';

const servers: Server[] = [];

async function fixture(collaboration = true) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'hive-hardening-'));
  const home = path.join(root, 'demo');
  await writeJson(hubPath(root, 'projects.json'), {
    projects: [{ name: 'demo', home, repos: [{ folder: home }] }],
  });
  await writeJson(hubPath(root, 'hub.json'), { name: 'hub' });
  await appendTaskEvent(root, { id: 'demo-1', project: 'demo', event: 'asked', at: new Date().toISOString() });
  await appendTaskEvent(root, { id: 'demo-2', project: 'demo', event: 'asked', at: new Date().toISOString() });
  await writeSecurity(root);
  configureSecurity(root);
  if (!collaboration) delete process.env.HIVE_COLLABORATION_ENABLED;
  const server = createServer(root);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { root, home, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function rows(root: string): Promise<Record<string, unknown>[]> {
  return JSON.parse(await fs.readFile(securityFile(root), 'utf8')).items;
}

async function replaceRows(root: string, values: Record<string, unknown>[]): Promise<void> {
  await fs.writeFile(securityFile(root), JSON.stringify({ items: values }, null, 2));
}

async function post(base: string, pathname: string, body: unknown, headers: Record<string, string>) {
  return fetch(base + pathname, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
}

function taskGrant(task = 'demo-1', actions = ['read', 'write']) {
  return {
    pk: `ACL#demo#${task}#*`, sk: 'PRINCIPAL#agent:builder', project: 'demo', task,
    principal: 'agent:builder', grantId: `task-${task}`, actions, aclEpoch: 2, revokedAt: null,
  };
}

function removeAgentProjectGrant(values: Record<string, unknown>[], replacement?: Record<string, unknown>) {
  const index = values.findIndex((row) => row.sk === 'PRINCIPAL#agent:builder');
  if (replacement) values[index] = replacement;
  else values.splice(index, 1);
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  delete process.env.HIVE_COLLABORATION_ENABLED;
  delete process.env.HIVE_REGISTRY_FILE;
  delete process.env.HIVE_ASSERTION_KEYS_JSON;
});

describe('default-off compatibility', () => {
  it('keeps legacy web, health-check, daily-scan, and MCP callers working without new credentials', async () => {
    const { root, base } = await fixture(false);
    process.env.HIVE_WEB_SECRET = 'legacy-secret';
    try {
      expect((await fetch(`${base}/api/view`, { headers: { 'x-hive-auth': 'legacy-secret' } })).status).toBe(200);
      expect((await fetch(`${base}/api/agent/identity`, { headers: { 'x-hive-auth': 'legacy-secret' } })).status).toBe(404);
      expect((await post(base, '/api/task', { project: 'demo', text: 'legacy task' }, { 'x-hive-auth': 'legacy-secret' })).status).toBe(200);

      const input = new PassThrough();
      let output = '';
      const mcp = serveMcp({ input, output: new Writable({ write(chunk, _encoding, callback) {
        output += chunk.toString(); callback();
      } }), env: { HIVE_HUB_ROOT: root, HIVE_PROJECT: 'demo', HIVE_AGENT: 'legacy-agent' }, pollMs: 5 });
      input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'ask_operator', arguments: { context: 'legacy', questions: [{
          question: 'Continue?', context: 'legacy', priority: 1, recommended: 'c1',
          choices: [{ label: 'Yes', description: 'continue' }, { label: 'No', description: 'stop' }],
        }] },
      } }) + '\n');
      const deadline = Date.now() + 2000;
      while ((await listOpenQuestionBatches(root)).length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const batches = await listOpenQuestionBatches(root);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toMatchObject({ project: 'demo', agent: 'legacy-agent' });
      mcp.close();
    } finally {
      delete process.env.HIVE_WEB_SECRET;
    }
  });
});

describe('stored-target authorization', () => {
  it('allows task-only reads and includes their project without a project-wide grant', async () => {
    const { root, base } = await fixture();
    const values = await rows(root);
    removeAgentProjectGrant(values, taskGrant());
    await replaceRows(root, values);
    const view = await (await fetch(`${base}/api/view`, { headers: agentHeaders() })).json();
    expect(view.projects.map((project: { name: string }) => project.name)).toEqual(['demo']);
    expect(view.tasks.map((task: { id: string }) => task.id)).toEqual(['demo-1']);
  });

  it('requires project administration for task creation and execute for dialog answers', async () => {
    const { root, base } = await fixture();
    const values = await rows(root);
    removeAgentProjectGrant(values, taskGrant('demo-1', ['read', 'write']));
    await replaceRows(root, values);
    expect((await post(base, '/api/task', { project: 'demo', text: 'not task-granted' }, agentHeaders())).status).toBe(404);
    expect((await post(base, '/api/answer', { project: 'demo', choice: '1', fingerprint: 'x' }, agentHeaders())).status).toBe(404);
  });

  it('derives scope from the stored task and rejects caller thread substitution or an unknown task', async () => {
    const { root, base } = await fixture();
    const values = await rows(root);
    removeAgentProjectGrant(values, taskGrant());
    await replaceRows(root, values);
    expect((await post(base, '/api/progress', {
      project: 'demo', task: 'demo-1', checkpoint: 'a', status: 'ok', thread: 'other',
    }, agentHeaders())).status).toBe(404);
    expect((await post(base, '/api/progress', {
      project: 'demo', task: 'demo-99', checkpoint: 'a', status: 'ok',
    }, agentHeaders())).status).toBe(404);
  });

  it('uses the stored log target task before reading and filters decisions and questions by that task', async () => {
    const { root, home, base } = await fixture();
    await writeJson(hivePath(home, 'team.json'), { agents: [{ name: 'builder', task: 'demo-1' }] });
    await createQuestionBatch(root, { project: 'demo', agent: 'builder' }, {
      context: 'task-scoped', questions: [{
        question: 'Continue?', context: 'task', priority: 1, recommended: 'c1',
        choices: [{ label: 'Yes', description: 'continue' }, { label: 'No', description: 'stop' }],
      }],
    });
    const values = await rows(root);
    removeAgentProjectGrant(values, taskGrant());
    await replaceRows(root, values);
    const view = await (await fetch(`${base}/api/view`, { headers: agentHeaders() })).json();
    expect(view.questions).toHaveLength(1);
    expect((await fetch(`${base}/api/log?project=demo&agent=builder`, { headers: agentHeaders() })).status).not.toBe(404);
  });
});

describe('wake write boundaries and key/expiry validation', () => {
  it('rejects an agent managing a subscription outside its registered project', async () => {
    const { root, base } = await fixture();
    const values = await rows(root);
    values.push({
      pk: 'AGENT#other', sk: 'PROFILE', agentId: 'other', ownerSubject: 'user:bob', project: 'other',
      revokedAt: null, aclEpoch: 1, credentialEpoch: 1, ownerExecutionGrantId: 'owner:other',
    });
    await replaceRows(root, values);
    expect((await post(base, '/api/wake-subscriptions', {
      agentId: 'other', executionGrantId: 'agent-grant',
    }, agentHeaders())).status).toBe(404);
  });

  it('requires finite bounded key retirement and rejects malformed account expiry', async () => {
    const { root, base } = await fixture();
    process.env.HIVE_ASSERTION_KEYS_JSON = JSON.stringify({
      current: 'new',
      keys: { new: ASSERTION_KEYS.keys.new, old: { secret: ASSERTION_KEYS.keys.old.secret } },
    });
    const old = assertion('user:alice', {}, 'old');
    expect((await fetch(`${base}/api/view`, { headers: { authorization: `Bearer ${old}` } })).status).toBe(401);
    const values = await rows(root);
    const account = values.find((row) => row.pk === 'SUBJECT#user:alice')!;
    account.expiresAt = 'invalid';
    await replaceRows(root, values);
    expect((await fetch(`${base}/api/view`, { headers: authHeaders() })).status).toBe(401);
  });
});

describe('MCP cancellation fences', () => {
  it('does not create a batch or emit a late answer when cancelled during authentication', async () => {
    const { root } = await fixture();
    const input = new PassThrough();
    let output = '';
    const mcp = serveMcp({ input, output: new Writable({ write(chunk, _encoding, callback) {
      output += chunk.toString(); callback();
    } }), env: agentEnv(root), pollMs: 5 });
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'ask_operator', arguments: { context: 'cancel me', questions: [{
        question: 'Continue?', context: 'cancel', priority: 1, recommended: 'c1',
        choices: [{ label: 'Yes', description: 'continue' }, { label: 'No', description: 'stop' }],
      }] },
    } }) + '\n');
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }) + '\n');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await listOpenQuestionBatches(root)).toEqual([]);
    expect(output).toBe('');
    mcp.close();
  });
});
