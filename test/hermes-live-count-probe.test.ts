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

async function runProbe(countStatus = 200, revokeStatus = 200, countResponse: Record<string, unknown> = {}) {
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
          diagnostic: countStatus === 200 ? undefined : 'raw-provider-response-secret',
          account: 'synthetic-account-name', error: 'raw-provider-error-text', ...countResponse,
        }));
      });
      return;
    }
    if (request.url === '/teamkimi/smoke/revoke') {
      if (revokeStatus === 200) credential = { ...credential, revokedAt, revocationProof: proof };
      response.writeHead(revokeStatus, { 'content-type': 'application/json' });
      response.end(JSON.stringify(revokeStatus === 200
        ? { revoked: [{ id: credential.id, revokedAt, proof }] }
        : { diagnostic: 'raw-revocation-response-secret' }));
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
  return { status, stdout, stderr, routes, root, output, revokedAt, proof };
}

afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

describe('T01 count-only probe', () => {
  it('preserves separate output and reasoning ceilings in a valid total budget', () => {
    const body = JSON.parse(requestBody.toString('utf8'));
    expect(body.max_tokens).toBe(6000);
    expect(body.thinking.budget_tokens).toBe(4000);
    expect(body.max_tokens - body.thinking.budget_tokens).toBe(2000);
  });

  it('mints, counts once, proves zero generation, revokes, and exports no credential', async () => {
    const result = await runProbe();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.routes.filter((route) => route.endsWith('/teamkimi/smoke/count-tokens'))).toHaveLength(1);
    expect(result.routes.some((route) => route.endsWith('/v1/messages'))).toBe(false);
    const evidence = JSON.parse(await readFile(result.output, 'utf8'));
    expect(Object.keys(evidence).sort()).toEqual([
      'counts', 'generationRequests', 'model', 'requestHash', 'revocation', 'schemaVersion', 'status', 'timestamp',
    ]);
    expect(evidence.counts).toEqual(counts);
    expect(evidence.generationRequests).toBe(0);
    expect(evidence.revocation).toEqual({ id: '1123456789abcdef0123456789abcdef', revokedAt: result.revokedAt, proof: result.proof });
    expect(JSON.stringify(evidence)).not.toContain('tcc-synthetic-only');
  });

  it.each([
    { name: 'non-200 HTTP', httpStatus: 400, category: 'provider-count-http-400' },
    {
      name: 'invalid request upstream error', httpStatus: 503,
      response: { upstreamStatus: 400, upstreamErrorType: 'invalid_request_error' },
      category: 'provider-count-http-503-invalid_request_error',
    },
    {
      name: 'authentication upstream error', httpStatus: 503,
      response: { upstreamStatus: 401, upstreamErrorType: 'authentication_error' },
      category: 'provider-count-http-503-authentication_error',
    },
    {
      name: 'rate limit upstream error', httpStatus: 503,
      response: { upstreamStatus: 429, upstreamErrorType: 'rate_limit_error' },
      category: 'provider-count-http-503-rate_limit_error',
    },
    {
      name: 'API upstream error', httpStatus: 503,
      response: { upstreamStatus: 500, upstreamErrorType: 'api_error' },
      category: 'provider-count-http-503-api_error',
    },
    {
      name: 'unknown upstream transport status', httpStatus: 503,
      response: { upstreamStatus: 0, upstreamErrorType: 'unknown' },
      category: 'provider-count-http-503-unknown-upstream-0',
    },
    {
      name: 'unknown upstream HTTP 200 receipt', httpStatus: 503,
      response: { upstreamStatus: 200, upstreamErrorType: 'unknown' },
      category: 'provider-count-http-503-unknown-upstream-200',
    },
    {
      name: 'explicit unknown upstream error', httpStatus: 503,
      response: { upstreamStatus: 502, upstreamErrorType: 'unknown' },
      category: 'provider-count-http-503-unknown-upstream-502',
    },
    {
      name: 'unknown upstream maximum status', httpStatus: 503,
      response: { upstreamStatus: 599, upstreamErrorType: 'unknown' },
      category: 'provider-count-http-503-unknown-upstream-599',
    },
    ...[-1, 600, 200.5, '200', undefined].map((upstreamStatus) => ({
      name: `invalid unknown upstream status ${String(upstreamStatus)}`, httpStatus: 503,
      response: { upstreamStatus, upstreamErrorType: 'unknown' },
      category: 'provider-count-http-503-unknown',
    })),
    {
      name: 'unrecognized upstream error type', httpStatus: 503,
      response: { upstreamStatus: 500, upstreamErrorType: 'raw-upstream-error-type-secret' },
      category: 'provider-count-http-503',
    },
    {
      name: 'missing upstream error type', httpStatus: 503,
      response: { upstreamStatus: 503 }, category: 'provider-count-http-503',
    },
    {
      name: 'allowlisted provider status', response: { status: 'provider_input_accounting_unverified' },
      category: 'provider-count-status-provider_input_accounting_unverified',
    },
    {
      name: 'unlisted provider status', response: { status: 'raw-provider-status-secret' },
      category: 'provider-count-status-unclassified',
    },
    {
      name: 'model mismatch', response: { model: 'raw-account-model' },
      category: 'provider-count-model-mismatch',
    },
    {
      name: 'request hash mismatch', response: { requestHash: '0'.repeat(64) },
      category: 'provider-count-request-hash-mismatch',
    },
    {
      name: 'missing count fields', response: { counts: { inputTokens: 10 } },
      category: 'provider-count-fields-invalid',
    },
    {
      name: 'invalid count fields', response: { counts: { ...counts, baseInputTokens: 'raw-count-field-secret' } },
      category: 'provider-count-fields-invalid',
    },
    {
      name: 'count arithmetic mismatch', response: { counts: { ...counts, baseInputTokens: 1 } },
      category: 'provider-count-arithmetic-mismatch',
    },
  ] as { name: string; httpStatus?: number; response?: Record<string, unknown>; category: string }[])(
    'revokes and reports $name with fixed sanitized diagnostics', async (testCase) => {
      const result = await runProbe(testCase.httpStatus ?? 200, 200, testCase.response);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      expect(result.routes.some((route) => route.endsWith('/teamkimi/smoke/revoke'))).toBe(true);
      expect(result.routes.some((route) => route.endsWith('/v1/messages'))).toBe(false);
      const evidence = JSON.parse(await readFile(result.output, 'utf8'));
      expect(evidence.status).toBe('failed');
      expect(evidence.counts).toBeNull();
      expect(evidence.revocation.proof).toBe(result.proof);
      const category = await readFile(join(result.root, 'bootstrap-category'), 'utf8');
      const origin = await readFile(join(result.root, 'bootstrap-origin'), 'utf8');
      expect(category).toBe(`${testCase.category}\n`);
      expect(origin).toBe('count-provider:1\n');
      const exposed = result.stdout + result.stderr + category + origin + JSON.stringify(evidence);
      for (const sentinel of [
        'tcc-synthetic-only', 'raw-provider-response-secret', 'synthetic-account-name', 'raw-provider-error-text',
        'raw-provider-status-secret', 'raw-account-model', 'raw-count-field-secret', 'raw-upstream-error-type-secret',
        result.root, probe,
      ]) {
        expect(exposed).not.toContain(sentinel);
      }
    });

  it('reports revocation failure without raw output or count evidence', async () => {
    const result = await runProbe(200, 503);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    await expect(readFile(result.output, 'utf8')).rejects.toThrow();
    const category = await readFile(join(result.root, 'bootstrap-category'), 'utf8');
    const origin = await readFile(join(result.root, 'bootstrap-origin'), 'utf8');
    expect(category).toBe('count-revocation-failed\n');
    expect(origin).toBe('count-revocation:1\n');
    const exposed = result.stdout + result.stderr + category + origin;
    for (const sentinel of ['tcc-synthetic-only', 'raw-revocation-response-secret', result.root, probe]) {
      expect(exposed).not.toContain(sentinel);
    }
  });
});
