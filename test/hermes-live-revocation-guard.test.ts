import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { issueGenerationCredential, revokeAndVerifySmokeCredential, withSmokeRevocation } from '../tools/hermes-live/broker.js';
import { EXPECTED_MODEL, runT01Matrix, type T01Broker } from '../tools/hermes-live/runner.js';
import { attestation, controls, policyHash } from './hermes-live-fixtures.js';

const credentialId = '0123456789abcdef0123456789abcdef';
const attemptKey = 'a'.repeat(64);
const proxyApiKey = 'ordinary-proxy-key';
const proof = 'a'.repeat(64);
const closers: (() => Promise<void>)[] = [];

async function revocationServer() {
  const calls: string[] = [];
  const server = http.createServer((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/teamkimi/smoke/credentials') {
      response.end(JSON.stringify({ id: credentialId, credential: 'tcs-synthetic', scope: 'generation', issuedAt: 0, expiresAt: 1 }));
      return;
    }
    if (request.url === '/teamkimi/smoke/revoke') {
      response.end(JSON.stringify({ revoked: [{ id: credentialId, revokedAt: 1, proof }] }));
      return;
    }
    if (request.url === '/teamkimi/smoke/status') {
      response.end(JSON.stringify({
        enabled: true, admissionAllowed: false, blockedReason: null, policyHash: 'a'.repeat(64),
        pricingVerified: true, model: EXPECTED_MODEL,
        ceilings: {
          scenario: { inputTokens: 16000, outputTokens: 2000, reasoningTokens: 4000, totalTokens: 22000, costMicros: 500000 },
          matrix: { admissions: 12, inputTokens: 96000, outputTokens: 12000, reasoningTokens: 24000, totalTokens: 132000, costMicros: 5000000 },
        },
        totals: { admissions: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, costMicros: 0 },
        credentials: [{ id: credentialId, scope: 'generation', issuedAt: 0, expiresAt: 1, revokedAt: 1, revocationProof: proof }],
        reservations: [],
      }));
      return;
    }
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('missing-port');
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { calls, baseUrl: `http://127.0.0.1:${address.port}` };
}

type AttemptMode = 'timeout' | 'malformed' | 'oversized' | 'pending' | 'pending-forever'
  | 'replay' | 'not-found-retry' | 'conflict' | 'wrong-id' | 'wrong-status' | 'secret-replay' | 'valid';

async function attemptServer(mode: AttemptMode) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const issuedAt = Date.now() - 1000;
  const expiresAt = Date.now() + 60_000;
  let minted = false;
  let revoked = false;
  let mintCalls = 0;
  let statusCalls = 0;
  const secretResponse = () => ({
    id: credentialId, credential: 'tcs-synthetic', scope: 'generation', issuedAt, expiresAt,
  });
  const publicAttempt = () => ({
    state: 'minted', credentialId: mode === 'wrong-id' ? '1'.repeat(32) : credentialId,
    credentialStatus: mode === 'wrong-status' ? 'unknown' : revoked ? 'revoked' : 'active',
    issuedAt, expiresAt, revokedAt: revoked ? 1 : null,
    ...(mode === 'secret-replay' ? { credential: 'tcs-must-not-appear' } : {}),
  });
  const server = http.createServer(async (request, response) => {
    calls.push(`${request.method} ${request.url}`);
    let text = '';
    for await (const chunk of request) text += chunk;
    bodies.push(text ? JSON.parse(text) : {});
    const write = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    const error = (status: number, code: string) => write(status, {
      type: 'error', error: { type: 'invalid_request_error', code, message: code },
    });
    if (request.headers['x-api-key'] !== proxyApiKey && request.url !== '/teamkimi/smoke/status'
      && request.url !== '/teamkimi/smoke/revoke') {
      error(401, 'invalid_credential');
      return;
    }
    if (request.url === '/teamkimi/smoke/credentials') {
      mintCalls++;
      if (mode === 'conflict') {
        error(409, 'credential_attempt_conflict');
        return;
      }
      if (mode === 'not-found-retry' && mintCalls === 1) {
        request.socket.destroy();
        return;
      }
      minted = true;
      if (mode === 'pending-forever' && mintCalls > 1) {
        write(202, { state: 'pending' });
        return;
      }
      if (mode === 'not-found-retry' && mintCalls === 2) {
        write(201, secretResponse());
        return;
      }
      if (mintCalls > 1) {
        write(200, publicAttempt());
        return;
      }
      if (mode === 'timeout') {
        setTimeout(() => write(201, secretResponse()), 10_100);
        return;
      }
      if (mode === 'malformed') {
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end('{');
        return;
      }
      if (mode === 'oversized') {
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end('x'.repeat(65_537));
        return;
      }
      if (mode === 'pending') {
        write(202, { state: 'pending' });
        return;
      }
      if (['replay', 'secret-replay', 'wrong-id', 'wrong-status', 'pending-forever'].includes(mode)) {
        request.socket.destroy();
        return;
      }
      write(201, secretResponse());
      return;
    }
    if (request.url === `/teamkimi/smoke/credential-attempts/${attemptKey}`) {
      statusCalls++;
      if ((mode === 'replay' || mode === 'not-found-retry') && mintCalls === 1) {
        error(404, 'credential_attempt_not_found');
        return;
      }
      if (mode === 'pending-forever' || mode === 'pending' && statusCalls === 1) {
        write(202, { state: 'pending' });
        return;
      }
      if (minted) {
        write(200, publicAttempt());
        return;
      }
      error(404, 'credential_attempt_not_found');
      return;
    }
    if (request.url === `/teamkimi/smoke/credentials/${credentialId}/revoke`) {
      revoked = true;
      write(200, { id: credentialId, revokedAt: 1, proof });
      return;
    }
    if (request.url === '/teamkimi/smoke/revoke') {
      revoked = true;
      write(200, { revoked: [{ id: credentialId, revokedAt: 1, proof }] });
      return;
    }
    if (request.url === '/teamkimi/smoke/status') {
      write(200, {
        enabled: true, admissionAllowed: false, blockedReason: null, policyHash: 'a'.repeat(64),
        pricingVerified: true, model: EXPECTED_MODEL,
        ceilings: {
          scenario: { inputTokens: 16000, outputTokens: 2000, reasoningTokens: 4000, totalTokens: 22000, costMicros: 500000 },
          matrix: { admissions: 12, inputTokens: 96000, outputTokens: 12000, reasoningTokens: 24000, totalTokens: 132000, costMicros: 5000000 },
        },
        totals: { admissions: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, costMicros: 0 },
        credentials: minted ? [{
          id: credentialId, scope: 'generation', issuedAt, expiresAt,
          revokedAt: revoked ? 1 : null, revocationProof: revoked ? proof : null,
        }] : [],
        reservations: [],
      });
      return;
    }
    error(404, 'credential_attempt_not_found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('missing-port');
  closers.push(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return {
    calls, bodies, baseUrl: `http://127.0.0.1:${address.port}`,
    mintCalls: () => mintCalls, statusCalls: () => statusCalls,
    revoked: () => revoked, activeCredentials: () => minted && !revoked ? 1 : 0,
  };
}

afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

describe('outer smoke revocation guard', () => {
  it.each(['json/config read', 'adapter construction', 'CLI start', 'runner workspace setup', 'later failure'])('revokes and verifies after %s', async (stage) => {
    const wire = await revocationServer();
    await expect(withSmokeRevocation({ baseUrl: wire.baseUrl, credentialId }, async () => {
      throw new Error(stage);
    })).rejects.toThrow(stage);
    expect(wire.calls).toEqual([
      'POST /teamkimi/smoke/revoke', 'GET /teamkimi/smoke/status',
    ]);
  });

  it('keeps the valid mint response and revokes the exact ID with a stable receipt', async () => {
    const wire = await attemptServer('valid');
    const cli = readFileSync(new URL('../tools/hermes-live/cli.ts', import.meta.url), 'utf8');
    expect(cli.indexOf('smokePolicyHash(attestation)')).toBeLessThan(cli.indexOf('issueGenerationCredential('));
    const issued = await issueGenerationCredential(wire.baseUrl, attemptKey, proxyApiKey);
    expect(issued).toEqual({ id: credentialId, credential: 'tcs-synthetic' });
    expect(wire.bodies[0]).toEqual({ scope: 'generation', attemptKey });
    const revoked = await revokeAndVerifySmokeCredential(wire.baseUrl, issued.id, attemptKey, proxyApiKey);
    const repeated = await revokeAndVerifySmokeCredential(wire.baseUrl, issued.id, attemptKey, proxyApiKey);
    expect(repeated).toEqual(revoked);
    expect(revoked).toMatchObject({ credentialId, scope: 'generation', verified: true, proof });
    expect(wire.bodies.filter((_, index) => wire.calls[index].endsWith('/revoke'))).toEqual([
      { attemptKey }, { attemptKey },
    ]);
    expect(wire.calls.some((call) => call === 'POST /teamkimi/smoke/revoke')).toBe(false);
    expect(wire.activeCredentials()).toBe(0);
  });

  it('revokes when runner workspace setup fails before preflight', async () => {
    let revocations = 0;
    const broker: T01Broker = {
      readiness: async () => { throw new Error('not reached'); },
      admit: async () => { throw new Error('not reached'); },
      receipt: async () => ({ status: 'missing' }),
      cancel: async () => undefined,
      recordActivities: async () => undefined,
      recordSession: async () => undefined,
      sessionEvidence: async () => ({ status: 'missing' }),
      revoke: async () => {
        revocations++;
        return { revoked: true, receiptId: credentialId, proof };
      },
    };
    await expect(runT01Matrix({
      process: {} as never, broker, brokerUrl: 'http://127.0.0.1:8765', model: EXPECTED_MODEL,
      workspace: '/dev/null/t01-workspace',
    })).rejects.toThrow();
    expect(revocations).toBe(1);
  });

  it.each([
    ['false', { ...controls(), isolation: { ...controls().isolation, disposable: false } }],
    ['malformed', { ...controls(), credential: { smokeOnly: true } }],
  ])('rejects %s nested controls without minting a credential', async (_name, value) => {
    const wire = await revocationServer();
    const root = fileURLToPath(new URL('..', import.meta.url));
    const directory = await mkdtemp(join(tmpdir(), 't01-invalid-controls-'));
    const controlsPath = join(directory, 'controls.json');
    const attestationPath = join(directory, 'attestation.json');
    await writeFile(controlsPath, JSON.stringify(value));
    await writeFile(attestationPath, JSON.stringify(attestation));
    const child = spawn(join(root, 'node_modules/.bin/tsx'), [
      join(root, 'tools/hermes-live/cli.ts'), 'run',
      '--artifacts', join(directory, 'artifacts'), '--controls', controlsPath,
      '--attestation', attestationPath, '--expected-policy-hash', policyHash,
      '--paid-admissions-authorized',
    ], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HIVE_T01_BROKER_URL: wire.baseUrl,
        HIVE_T01_PROXY_KEY: proxyApiKey,
        HIVE_T01_AUTHORIZE_PAID_ADMISSIONS: 'yes',
      },
      stdio: 'ignore',
    });
    const status = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(status).not.toBe(0);
    expect(wire.calls).toEqual([]);
  }, 10_000);

  it('uses one random attempt key through mint and every finally revocation', async () => {
    const wire = await attemptServer('valid');
    const root = fileURLToPath(new URL('..', import.meta.url));
    const directory = await mkdtemp(join(tmpdir(), 't01-attempt-cli-'));
    const controlsPath = join(directory, 'controls.json');
    const attestationPath = join(directory, 'attestation.json');
    await writeFile(controlsPath, JSON.stringify(controls()));
    await writeFile(attestationPath, JSON.stringify(attestation));
    const child = spawn(join(root, 'node_modules/.bin/tsx'), [
      join(root, 'tools/hermes-live/cli.ts'), 'run',
      '--artifacts', join(directory, 'artifacts'), '--controls', controlsPath,
      '--attestation', attestationPath, '--expected-policy-hash', policyHash,
      '--paid-admissions-authorized',
    ], {
      cwd: root,
      env: {
        PATH: process.env.PATH, HIVE_T01_BROKER_URL: wire.baseUrl,
        HIVE_T01_PROXY_KEY: proxyApiKey, HIVE_T01_AUTHORIZE_PAID_ADMISSIONS: 'yes',
      },
      stdio: 'ignore',
    });
    const status = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(status).not.toBe(0);
    const mint = wire.bodies[0] as { scope: string; attemptKey: string };
    expect(mint.scope).toBe('generation');
    expect(mint.attemptKey).toMatch(/^[a-f0-9]{64}$/);
    expect(mint.attemptKey).not.toBe(attemptKey);
    const revocations = wire.bodies.filter((_, index) => wire.calls[index].endsWith('/revoke'));
    expect(revocations).toEqual([{ attemptKey: mint.attemptKey }, { attemptKey: mint.attemptKey }]);
    expect(wire.calls).not.toContain('POST /teamkimi/smoke/revoke');
    expect(wire.activeCredentials()).toBe(0);
  }, 10_000);

  it.each(['timeout', 'malformed', 'oversized', 'pending', 'replay'] as const)('recovers and revokes after %s mint evidence', async (mode) => {
    const wire = await attemptServer(mode);
    await expect(issueGenerationCredential(wire.baseUrl, attemptKey, proxyApiKey)).rejects.toThrow();
    expect(wire.revoked()).toBe(true);
    expect(wire.activeCredentials()).toBe(0);
    expect(wire.statusCalls()).toBeGreaterThan(0);
    expect(wire.calls.filter((call) => call.endsWith('/revoke'))).toEqual([
      `POST /teamkimi/smoke/credentials/${credentialId}/revoke`,
    ]);
    expect(wire.calls).not.toContain('POST /teamkimi/smoke/revoke');
  }, 20_000);

  it('retries the same request after a 404 and preserves the returned secret', async () => {
    const wire = await attemptServer('not-found-retry');
    const issued = await issueGenerationCredential(wire.baseUrl, attemptKey, proxyApiKey);
    expect(issued).toEqual({ id: credentialId, credential: 'tcs-synthetic' });
    expect(wire.mintCalls()).toBe(2);
    expect(wire.bodies.filter((_, index) => wire.calls[index] === 'POST /teamkimi/smoke/credentials')).toEqual([
      { scope: 'generation', attemptKey }, { scope: 'generation', attemptKey },
    ]);
    await revokeAndVerifySmokeCredential(wire.baseUrl, issued.id, attemptKey, proxyApiKey);
    expect(wire.activeCredentials()).toBe(0);
  });

  it('rejects conflict and wrong-tenant attempts without revocation', async () => {
    const conflict = await attemptServer('conflict');
    await expect(issueGenerationCredential(conflict.baseUrl, attemptKey, proxyApiKey)).rejects.toThrow();
    expect(conflict.mintCalls()).toBe(1);
    expect(conflict.statusCalls()).toBe(0);
    expect(conflict.revoked()).toBe(false);
    const wrongTenant = await attemptServer('valid');
    await expect(issueGenerationCredential(wrongTenant.baseUrl, attemptKey, 'wrong-proxy-key')).rejects.toThrow();
    expect(wrongTenant.mintCalls()).toBe(0);
    expect(wrongTenant.calls).toEqual(['POST /teamkimi/smoke/credentials']);
    expect(wrongTenant.activeCredentials()).toBe(0);
  });

  it.each(['wrong-id', 'wrong-status', 'secret-replay'] as const)('fails closed for invalid public attempt evidence: %s', async (mode) => {
    const wire = await attemptServer(mode);
    const failure = await issueGenerationCredential(wire.baseUrl, attemptKey, proxyApiKey).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).not.toContain('tcs-must-not-appear');
    expect(wire.statusCalls()).toBeGreaterThan(0);
    expect(wire.revoked()).toBe(false);
    expect(wire.calls).not.toContain('POST /teamkimi/smoke/revoke');
    expect(wire.activeCredentials()).toBe(1);
  });

  it('bounds an unresolved pending recovery and retains the active credential', async () => {
    const wire = await attemptServer('pending-forever');
    await expect(issueGenerationCredential(wire.baseUrl, attemptKey, proxyApiKey)).rejects.toThrow();
    expect(wire.statusCalls()).toBeGreaterThan(1);
    expect(wire.statusCalls()).toBeLessThanOrEqual(5);
    expect(wire.revoked()).toBe(false);
    expect(wire.activeCredentials()).toBe(1);
  });
});
