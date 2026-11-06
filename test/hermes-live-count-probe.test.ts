import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const probe = fileURLToPath(new URL('../tools/hermes-live/count-probe.mjs', import.meta.url));
const runner = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
const requestBody = await readFile(new URL('../tools/hermes-live/fixtures/count-request.json', import.meta.url));
const counts = {
  inputTokens: 10, baseInputTokens: 2, cacheReadInputTokens: 3,
  cacheCreationInputTokens: 5, cacheCreation5mInputTokens: 1, cacheCreation1hInputTokens: 4,
};
const closers: (() => Promise<void>)[] = [];

async function runProbe(countStatus = 200) {
  const routes: string[] = [];
  let credential: Record<string, unknown> | undefined;
  const revokedAt = 1760000001000;
  const proof = 'a'.repeat(64);
  const server = http.createServer((request, response) => {
    routes.push(`${request.method} ${request.url}`);
    if (request.url === '/teamkimi/smoke/status') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        enabled: true, admissionAllowed: true, blockedReason: null,
        totals: { admissions: 0 }, reservations: [], credentials: credential ? [credential] : [],
      }));
      return;
    }
    if (request.url === '/teamkimi/smoke/credentials') {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        expect(JSON.parse(body)).toEqual({ scope: 'count-only' });
        credential = {
          id: '1123456789abcdef0123456789abcdef', scope: 'count-only', issuedAt: 1760000000000,
          expiresAt: 1760000900000, revokedAt: null, revocationProof: null,
        };
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ...credential, credential: 'tcc-synthetic-only' }));
      });
      return;
    }
    if (request.url === '/teamkimi/smoke/count-tokens') {
      expect(request.headers['x-api-key']).toBe('tcc-synthetic-only');
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        expect(body).toBe(requestBody.toString('utf8'));
        response.writeHead(countStatus, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          model: 'kimi-code/k3.1-pro', requestHash: createHash('sha256').update(requestBody).digest('hex'),
          counts: countStatus === 200 ? counts : null,
          status: countStatus === 200 ? 'counted' : 'provider_input_accounting_unverified', timestamp: 1760000000000,
        }));
      });
      return;
    }
    if (request.url === '/teamkimi/smoke/revoke') {
      credential = { ...credential, revokedAt, revocationProof: proof };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ revoked: [{ id: credential.id, revokedAt, proof }] }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(8765, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const root = await mkdtemp(join(tmpdir(), 't01-count-probe-'));
  const output = join(root, 'count.json');
  const child = spawn(runner, [probe, output], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const status = await new Promise<number | null>((resolve) => child.on('close', resolve));
  return { status, stdout, stderr, routes, output, revokedAt, proof };
}

afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

describe('T01 count-only probe', () => {
  it('mints, counts once, proves zero generation, revokes, and exports no credential', async () => {
    const result = await runProbe();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.routes.filter((route) => route.endsWith('/teamkimi/smoke/count-tokens'))).toHaveLength(1);
    expect(result.routes.some((route) => route.endsWith('/v1/messages'))).toBe(false);
    const evidence = JSON.parse(await readFile(result.output, 'utf8'));
    expect(evidence.counts).toEqual(counts);
    expect(evidence.generationRequests).toBe(0);
    expect(evidence.revocation).toEqual({ id: '1123456789abcdef0123456789abcdef', revokedAt: result.revokedAt, proof: result.proof });
    expect(JSON.stringify(evidence)).not.toContain('tcc-synthetic-only');
  });

  it('revokes in finally after provider count failure', async () => {
    const result = await runProbe(503);
    expect(result.status).not.toBe(0);
    expect(result.routes.some((route) => route.endsWith('/teamkimi/smoke/revoke'))).toBe(true);
    expect(result.routes.some((route) => route.endsWith('/v1/messages'))).toBe(false);
    const evidence = JSON.parse(await readFile(result.output, 'utf8'));
    expect(evidence.status).toBe('failed');
    expect(evidence.counts).toBeNull();
    expect(evidence.revocation.proof).toBe(result.proof);
    expect(JSON.stringify(evidence)).not.toContain('tcc-synthetic-only');
  });
});
