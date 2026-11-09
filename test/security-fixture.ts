import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DynamoCliRegistry, type DelegatedApprovalRequest, type Registry, type RegistryRow, type WakeSubscription,
} from '../src/registry.js';

export const ASSERTION_KEYS = {
  current: 'new',
  keys: {
    old: {
      secret: 'old-test-secret-with-at-least-32-characters',
      retireAt: Math.floor(Date.now() / 1000) + 600,
    },
    new: { secret: 'new-test-secret-with-at-least-32-characters' },
  },
};
export const CREDENTIAL_ID = '0123456789abcdef';
export const AGENT_CREDENTIAL = `hva1.builder.${CREDENTIAL_ID}.test-agent-secret-with-high-entropy`;
const SALT = 'test-only-salt';

export class MemoryRegistry implements Registry {
  private readonly broker?: DynamoCliRegistry;

  constructor(readonly items: RegistryRow[], brokerUrl?: string) {
    if (brokerUrl) this.broker = new DynamoCliRegistry('unused', brokerUrl);
  }

  async get(pk: string, sk: string): Promise<RegistryRow | undefined> {
    return this.items.find((row) => row.pk === pk && row.sk === sk);
  }

  async currentAccount(subject: string, credential: string): Promise<RegistryRow | undefined> {
    return this.broker ? this.broker.currentAccount(subject, credential) : this.get(`SUBJECT#${subject}`, 'PROFILE');
  }

  async delegatedApprovalAccount(agentId: string, credential: string,
    request: DelegatedApprovalRequest): Promise<RegistryRow | undefined> {
    return this.broker!.delegatedApprovalAccount(agentId, credential, request);
  }

  async createWakeSubscription(agentId: string, credential: string,
    executionGrantId: string): Promise<WakeSubscription> {
    return this.broker!.createWakeSubscription(agentId, credential, executionGrantId);
  }

  async revokeWakeSubscription(agentId: string, credential: string, subscriptionId: string): Promise<void> {
    return this.broker!.revokeWakeSubscription(agentId, credential, subscriptionId);
  }

  async query(pk: string, skPrefix: string): Promise<RegistryRow[]> {
    return this.items.filter((row) => row.pk === pk && row.sk.startsWith(skPrefix));
  }
}

export function registryItems(project = 'demo'): RegistryRow[] {
  const actions = ['read', 'write', 'execute', 'admin'];
  const rows = [
    { pk: 'SUBJECT#user:alice', sk: 'PROFILE', subject: 'user:alice', accountStatus: 'active', accountEpoch: 1 },
    { pk: 'SUBJECT#user:bob', sk: 'PROFILE', subject: 'user:bob', accountStatus: 'active', accountEpoch: 1 },
    {
      pk: 'AGENT#builder', sk: 'PROFILE', agentId: 'builder', ownerSubject: 'user:alice', project,
      revokedAt: null, aclEpoch: 1, credentialEpoch: 1, ownerExecutionGrantId: 'owner:builder',
    },
    {
      pk: 'AGENT#builder', sk: `CRED#${CREDENTIAL_ID}`, credentialId: CREDENTIAL_ID,
      salt: SALT, credentialHash: createHash('sha256').update(`${SALT}:test-agent-secret-with-high-entropy`).digest('hex'),
      expiresAt: 0, revokedAt: null, credentialEpoch: 1,
    },
    {
      pk: `ACL#${project}#demo-1#*`, sk: 'PRINCIPAL#user:alice', project, task: 'demo-1', principal: 'user:alice',
      grantId: 'human-grant', actions, aclEpoch: 1, revokedAt: null,
    },
    {
      pk: `ACL#${project}#demo-1#*`, sk: 'PRINCIPAL#agent:builder', project, task: 'demo-1', principal: 'agent:builder',
      grantId: 'agent-grant', actions, aclEpoch: 1, revokedAt: null,
    },
  ];
  const validationProjects = [
    'other', 'nope', 'newproj', 'autoapi', 'wtproj', 'plainproj', 'not-there', 'projects',
    'badcombo', 'enumproj', 'relproj', 'goneproj', 'emptyproj', 'bogusproj',
  ];
  for (const name of validationProjects) {
    rows.push({
      pk: `ACL#${name}#*#*`, sk: 'PRINCIPAL#user:alice', project: name, principal: 'user:alice',
      grantId: `human-${name}`, actions, aclEpoch: 1, revokedAt: null,
    });
  }
  return rows;
}

export async function startTestRegistry(items = registryItems()): Promise<{ broker: http.Server; registry: MemoryRegistry }> {
  const broker = http.createServer((req, res) => {
    void (async () => {
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = text ? JSON.parse(text) : {};
      let status = 200;
      let result: Record<string, unknown> = {};
      if (req.url === '/api/hive/broker/account-status') {
        const credential = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
        let subject = '';
        if (credential.startsWith('hva1.')) {
          const agentId = credential.split('.')[1];
          subject = String(items.find((row) => row.pk === `AGENT#${agentId}` && row.sk === 'PROFILE')?.ownerSubject ?? '');
        } else {
          try {
            subject = JSON.parse(Buffer.from(credential.split('.')[1], 'base64url').toString('utf8')).sub;
          } catch {}
        }
        const account = items.find((row) => row.pk === `SUBJECT#${subject}` && row.sk === 'PROFILE');
        if (!account) status = 401;
        else {
          result = {
            subject, accountStatus: account.accountStatus,
            accountEpoch: account.accountEpoch, expiresAt: account.expiresAt ?? null,
          };
        }
      } else if (req.url === '/api/hive/broker/delegated-approval') {
        const account = items.find((row) => row.pk === `SUBJECT#${body.approverSubject}` && row.sk === 'PROFILE');
        if (account?.accountStatus !== 'active') status = 401;
        else {
          result = {
            subject: body.approverSubject, accountStatus: 'active', accountEpoch: account.accountEpoch,
            ...(account.expiresAt === undefined ? {} : { expiresAt: account.expiresAt }),
          };
        }
      } else if (req.url === '/api/hive/broker/wake-subscriptions') {
        if (body.agentId !== 'builder' || body.executionGrantId === 'bob-write') status = 404;
        else {
          result = {
            subscriptionId: 'wake-test', agentId: body.agentId, executionGrantId: body.executionGrantId,
            createdBy: 'user:alice', createdAt: 1, revokedAt: null, aclEpoch: 1,
          };
        }
      } else if (req.url === '/api/hive/broker/wake-subscriptions/revoke') {
        result = { ok: true };
      } else {
        status = 404;
      }
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    })().catch(() => {
      res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => broker.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(broker.address() as AddressInfo).port}`;
  return { broker, registry: new MemoryRegistry(items, url) };
}

export function configureSecurity(collaboration = true): void {
  if (collaboration) {
    process.env.HIVE_COLLABORATION_ENABLED = '1';
    process.env.HIVE_WAKE_SUBSCRIPTION_WRITES_ENABLED = '1';
  } else {
    delete process.env.HIVE_COLLABORATION_ENABLED;
    delete process.env.HIVE_WAKE_SUBSCRIPTION_WRITES_ENABLED;
  }
  process.env.HIVE_ASSERTION_KEYS_JSON = JSON.stringify(ASSERTION_KEYS);
}

export function assertion(subject = 'user:alice', overrides: Record<string, unknown> = {}, kid = 'new'): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT', kid });
  const now = Math.floor(Date.now() / 1000);
  const payload = encode({
    iss: 'nexus.dexima.ai', aud: 'hive', sub: subject, accountStatus: 'active', accountEpoch: 1,
    iat: now, exp: now + 120, ...overrides,
  });
  const key = (ASSERTION_KEYS.keys as Record<string, { secret: string }>)[kid]?.secret ?? 'unknown-test-secret-with-at-least-32-characters';
  const signature = createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export function authHeaders(subject = 'user:alice'): Record<string, string> {
  return { authorization: `Bearer ${assertion(subject)}` };
}

export function agentHeaders(credential = AGENT_CREDENTIAL): Record<string, string> {
  return { authorization: `Bearer ${credential}` };
}

export function agentEnv(root: string): NodeJS.ProcessEnv {
  return {
    HIVE_HUB_ROOT: root,
    HIVE_AGENT_CREDENTIAL: AGENT_CREDENTIAL,
    HIVE_AGENT: 'client-selected-agent',
    HIVE_PROJECT: 'client-selected-project',
  };
}
