import { execFile } from 'node:child_process';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import type http from 'node:http';
import { RegistryUnavailable, registryFromEnv, type Registry, type RegistryRow } from './registry.js';

const execFileAsync = promisify(execFile);
const ISSUER = 'nexus.dexima.ai';
const AUDIENCE = 'hive';
const LIFETIME_SECONDS = 120;
const ACTIONS = new Set(['read', 'write', 'execute', 'admin']);

export type Principal = {
  kind: 'human' | 'agent';
  subject: string;
  ownerSubject?: string;
  agentId?: string;
  project?: string;
  credentialEpoch?: number;
  aclEpoch: number;
};

export class AuthenticationError extends Error {}
export class AuthorizationError extends Error {}

async function keyRingFromEnv(env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  let raw = env.HIVE_ASSERTION_KEYS_JSON;
  if (!raw) {
    try {
      const { stdout } = await execFileAsync('aws', [
        'secretsmanager', 'get-secret-value', '--secret-id',
        env.HIVE_ASSERTION_KEYS_SECRET ?? 'citadel/hive/assertion-keys', '--query', 'SecretString', '--output', 'text',
      ], { maxBuffer: 64 * 1024, timeout: 5000 });
      raw = stdout.trim();
    } catch {
      throw new RegistryUnavailable('assertion key read failed');
    }
  }
  try {
    const ring = JSON.parse(raw) as Record<string, unknown>;
    if (!ring || typeof ring !== 'object' || !ring.keys || typeof ring.keys !== 'object') throw new Error();
    return ring;
  } catch {
    throw new RegistryUnavailable('assertion key read failed');
  }
}

function decode(part: string): Record<string, unknown> {
  const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuthenticationError('invalid assertion');
  return value as Record<string, unknown>;
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

async function verifyAssertion(assertion: string, env: NodeJS.ProcessEnv, now: number): Promise<Record<string, unknown>> {
  try {
    const [headerPart, payloadPart, signaturePart, extra] = assertion.split('.');
    if (extra !== undefined || !signaturePart) throw new AuthenticationError('invalid assertion');
    const header = decode(headerPart);
    const payload = decode(payloadPart);
    if (header.alg !== 'HS256' || header.typ !== 'JWT' || typeof header.kid !== 'string') {
      throw new AuthenticationError('invalid assertion');
    }
    const ring = await keyRingFromEnv(env);
    const keys = ring.keys as Record<string, { secret?: unknown; notBefore?: unknown; retireAt?: unknown }>;
    const key = keys[header.kid];
    if (!key || typeof key.secret !== 'string' || key.secret.length < 32) throw new AuthenticationError('invalid assertion');
    if (key.notBefore !== undefined && !integer(key.notBefore)) throw new AuthenticationError('invalid assertion');
    if (key.retireAt !== undefined && !integer(key.retireAt)) throw new AuthenticationError('invalid assertion');
    if (header.kid !== ring.current && key.retireAt === undefined) throw new AuthenticationError('invalid assertion');
    const notBefore = integer(key.notBefore) ? key.notBefore : 0;
    const retireAt = integer(key.retireAt) ? key.retireAt : undefined;
    if (retireAt !== undefined && (retireAt <= notBefore || retireAt - now > 900)) {
      throw new AuthenticationError('invalid assertion');
    }
    if (now < notBefore || retireAt !== undefined && now >= retireAt) {
      throw new AuthenticationError('invalid assertion');
    }
    const expected = createHmac('sha256', key.secret).update(`${headerPart}.${payloadPart}`).digest();
    const supplied = Buffer.from(signaturePart, 'base64url');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new AuthenticationError('invalid assertion');
    }
    if (payload.iss !== ISSUER || payload.aud !== AUDIENCE || payload.accountStatus !== 'active') {
      throw new AuthenticationError('invalid assertion');
    }
    if (typeof payload.sub !== 'string' || !/^user:[A-Za-z0-9_.@-]{1,128}$/.test(payload.sub)) {
      throw new AuthenticationError('invalid assertion');
    }
    if (!integer(payload.accountEpoch) || payload.accountEpoch < 0
      || !integer(payload.iat) || !integer(payload.exp)
      || payload.exp !== payload.iat + LIFETIME_SECONDS
      || payload.iat > now + 30 || now < payload.iat - 30 || now >= payload.exp) {
      throw new AuthenticationError('invalid assertion');
    }
    return payload;
  } catch (error) {
    if (error instanceof RegistryUnavailable) throw error;
    throw new AuthenticationError('invalid assertion');
  }
}

function number(row: RegistryRow, field: string, fallback = 0): number {
  return integer(row[field]) ? row[field] as number : fallback;
}

export async function revoked(registry: Registry, row: RegistryRow): Promise<boolean> {
  if (row.revokedAt !== null && row.revokedAt !== undefined) return true;
  if (await registry.get(`REVOCATION#${row.pk}`, row.sk)) return true;
  if (row.sk.startsWith('CRED#') || row.sk.startsWith('WAKE#')) {
    return Boolean(await registry.get(`REVOCATION#${row.pk}`, 'PROFILE'));
  }
  return false;
}

function validExpiry(row: RegistryRow, now: number): boolean {
  const value = row.expiresAt;
  if (value === undefined) return true;
  return integer(value) && value >= 0 && (value === 0 || value > now);
}

function accountActive(account: RegistryRow | undefined, now: number): account is RegistryRow {
  return Boolean(account && account.accountStatus === 'active' && validExpiry(account, now));
}

async function authenticateAgent(credential: string, registry: Registry, now: number): Promise<Principal> {
  const match = /^hva1\.([a-z][a-z0-9-]{1,62})\.([0-9a-f]{16})\.([A-Za-z0-9_-]{32,256})$/.exec(credential);
  if (!match) throw new AuthenticationError('invalid agent credential');
  const [, agentId, credentialId, secret] = match;
  const [profile, row] = await Promise.all([
    registry.get(`AGENT#${agentId}`, 'PROFILE'), registry.get(`AGENT#${agentId}`, `CRED#${credentialId}`),
  ]);
  if (!profile || !row || typeof profile.ownerSubject !== 'string' || typeof profile.project !== 'string') {
    throw new AuthenticationError('invalid agent credential');
  }
  const owner = await registry.currentAccount(profile.ownerSubject, credential);
  const expected = createHash('sha256').update(`${String(row.salt ?? '')}:${secret}`).digest('hex');
  const supplied = Buffer.from(String(row.credentialHash ?? ''), 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (!accountActive(owner, now) || await revoked(registry, profile) || await revoked(registry, row)
    || !validExpiry(row, now)
    || supplied.length !== expectedBuffer.length || !timingSafeEqual(supplied, expectedBuffer)) {
    throw new AuthenticationError('invalid agent credential');
  }
  return {
    kind: 'agent', subject: `agent:${agentId}`, agentId, ownerSubject: profile.ownerSubject,
    project: profile.project, aclEpoch: number(profile, 'aclEpoch', 1),
    credentialEpoch: number(profile, 'credentialEpoch', 1),
  };
}

export async function authenticateBearer(bearer: string, registry: Registry,
  env: NodeJS.ProcessEnv = process.env, now = Math.floor(Date.now() / 1000)): Promise<Principal> {
  if (bearer.startsWith('hva1.')) return authenticateAgent(bearer, registry, now);
  const payload = await verifyAssertion(bearer, env, now);
  const subject = payload.sub as string;
  const account = await registry.currentAccount(subject, bearer);
  if (!accountActive(account, now) || number(account, 'accountEpoch', -1) !== payload.accountEpoch) {
    throw new AuthenticationError('invalid assertion');
  }
  return { kind: 'human', subject, aclEpoch: number(account, 'accountEpoch') };
}

export function bearerFromRequest(req: http.IncomingMessage): string {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ') || header.length <= 7) {
    throw new AuthenticationError('authentication required');
  }
  return header.slice(7);
}

export async function authenticateRequest(req: http.IncomingMessage, registry = registryFromEnv()): Promise<Principal> {
  return authenticateBearer(bearerFromRequest(req), registry);
}

export async function currentGrant(registry: Registry, project: string, subject: string,
  task?: string, thread?: string): Promise<RegistryRow | undefined> {
  const candidates = [[task, thread], [task, undefined], [undefined, thread], [undefined, undefined]] as const;
  for (const [taskId, threadId] of candidates) {
    const pk = `ACL#${project}#${taskId ?? '*'}#${threadId ?? '*'}`;
    const sk = `PRINCIPAL#${subject}`;
    if (await registry.get(`REVOCATION#${pk}`, sk)) return undefined;
    const row = await registry.get(pk, sk);
    if (row) return row.revokedAt !== null && row.revokedAt !== undefined ? undefined : row;
  }
  return undefined;
}

export async function exactGrant(registry: Registry, project: string, subject: string,
  task?: string, thread?: string): Promise<RegistryRow | undefined> {
  const pk = `ACL#${project}#${task ?? '*'}#${thread ?? '*'}`;
  const sk = `PRINCIPAL#${subject}`;
  if (await registry.get(`REVOCATION#${pk}`, sk)) return undefined;
  const row = await registry.get(pk, sk);
  return row?.revokedAt === null || row?.revokedAt === undefined ? row : undefined;
}

export async function authorizeExact(principal: Principal, registry: Registry, action: string,
  scope: { project: string; task?: string; thread?: string }): Promise<RegistryRow> {
  if (!ACTIONS.has(action) || (principal.kind === 'agent' && principal.project !== scope.project)) {
    throw new AuthorizationError('not found');
  }
  const grant = await exactGrant(registry, scope.project, principal.subject, scope.task, scope.thread);
  if (!grant || !Array.isArray(grant.actions) || !grant.actions.includes(action)) {
    throw new AuthorizationError('not found');
  }
  return grant;
}

export async function authorize(principal: Principal, registry: Registry, action: string,
  scope: { project: string; task?: string; thread?: string }): Promise<RegistryRow> {
  if (!ACTIONS.has(action) || (principal.kind === 'agent' && principal.project !== scope.project)) {
    throw new AuthorizationError('not found');
  }
  const grant = await currentGrant(registry, scope.project, principal.subject, scope.task, scope.thread);
  if (!grant || !Array.isArray(grant.actions) || !grant.actions.includes(action)) {
    throw new AuthorizationError('not found');
  }
  return grant;
}

export async function createWakeSubscription(registry: Registry, principal: Principal,
  agentId: string, executionGrantId: string, credential: string): Promise<RegistryRow> {
  const profile = await registry.get(`AGENT#${agentId}`, 'PROFILE');
  if (!profile || await revoked(registry, profile) || typeof profile.project !== 'string' || typeof profile.ownerSubject !== 'string') {
    throw new AuthorizationError('not found');
  }
  if (principal.kind === 'agent' && principal.project !== profile.project) {
    throw new AuthorizationError('not found');
  }
  const owner = principal.kind === 'human' && principal.subject === profile.ownerSubject
    && executionGrantId === profile.ownerExecutionGrantId;
  if (!owner) {
    const grant = await currentGrant(registry, profile.project, principal.subject);
    if (!grant || grant.grantId !== executionGrantId || !Array.isArray(grant.actions) || !grant.actions.includes('execute')) {
      throw new AuthorizationError('not found');
    }
  }
  const subscriptionId = randomBytes(16).toString('hex');
  const row: RegistryRow = {
    pk: `AGENT#${agentId}`, sk: `WAKE#${subscriptionId}`, subscriptionId, agentId,
    executionGrantId, createdBy: principal.subject, createdAt: Math.floor(Date.now() / 1000),
    revokedAt: null, aclEpoch: number(profile, 'aclEpoch', 1),
  };
  return registry.put(row, credential);
}

export async function revokeWakeSubscription(registry: Registry, principal: Principal,
  agentId: string, subscriptionId: string, credential: string): Promise<void> {
  const profile = await registry.get(`AGENT#${agentId}`, 'PROFILE');
  const row = await registry.get(`AGENT#${agentId}`, `WAKE#${subscriptionId}`);
  if (!profile || !row || await revoked(registry, profile) || await revoked(registry, row)) throw new AuthorizationError('not found');
  if (principal.kind === 'agent' && principal.project !== profile.project) {
    throw new AuthorizationError('not found');
  }
  const owner = principal.kind === 'human' && principal.subject === profile.ownerSubject;
  if (!owner) {
    const grant = await currentGrant(registry, String(profile.project), principal.subject);
    if (!grant || grant.grantId !== row.executionGrantId
      || !Array.isArray(grant.actions) || !grant.actions.includes('execute')) {
      throw new AuthorizationError('not found');
    }
  }
  await registry.put({
    ...row, revokedAt: Math.floor(Date.now() / 1000), aclEpoch: number(row, 'aclEpoch') + 1,
  }, credential);
}

export function publicAgentIdentity(principal: Principal): Record<string, unknown> {
  if (principal.kind !== 'agent') throw new AuthorizationError('not found');
  return {
    agentId: principal.agentId, ownerSubject: principal.ownerSubject, project: principal.project,
    aclEpoch: principal.aclEpoch, credentialEpoch: principal.credentialEpoch,
  };
}
