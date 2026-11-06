import { createHash, createHmac } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

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

export function securityFile(root: string): string {
  return path.join(root, '.hive-hub', 'security.json');
}

export function registryItems(project = 'demo'): Record<string, unknown>[] {
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
      pk: `ACL#${project}#*#*`, sk: 'PRINCIPAL#user:alice', project, principal: 'user:alice',
      grantId: 'human-grant', actions, aclEpoch: 1, revokedAt: null,
    },
    {
      pk: `ACL#${project}#*#*`, sk: 'PRINCIPAL#agent:builder', project, principal: 'agent:builder',
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

export async function writeSecurity(root: string, items = registryItems()): Promise<void> {
  const file = securityFile(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ items }, null, 2));
}

export function configureSecurity(root: string, collaboration = true): void {
  if (collaboration) process.env.HIVE_COLLABORATION_ENABLED = '1';
  else delete process.env.HIVE_COLLABORATION_ENABLED;
  process.env.HIVE_REGISTRY_FILE = securityFile(root);
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
