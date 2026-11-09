import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalAnthropicBody, TeamKimiAdapter } from '../tools/hermes-live/broker.js';
import { admissionEvidenceHash } from '../tools/hermes-live/runner.js';
import { usageCostMicros } from '../tools/hermes-live/policy.js';
import { attestation, controls, policyHash, wireCounted, wireUsage } from './hermes-live-fixtures.js';

const source = process.env.TEAMKIMI_SMOKE_SOURCE;
const TESTED_TEAMKIMI_COMMIT = '935104a1936a603467c91e14acc1aa0b6715c2f3';
const attemptKey = 'a'.repeat(64);
const proxyApiKey = 'ordinary-proxy-key';
const describeWire = source ? describe : describe.skip;
const closers: (() => Promise<void>)[] = [];

function listen(server: http.Server) {
  return new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (typeof address === 'object' && address) resolve(address.port);
  }));
}

function close(server: http.Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

async function request(port: number, path: string, options: { method?: string; credential?: string; scenario?: string; body?: unknown } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.credential ? { 'x-api-key': options.credential } : {}),
      ...(options.scenario ? { 'x-teamkimi-smoke-scenario': options.scenario } : {}),
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json() };
}

async function receiptUntil(adapter: TeamKimiAdapter, admissionId: string, expected: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const receipt = await adapter.receipt(admissionId);
    if (receipt.status === expected) return receipt;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return adapter.receipt(admissionId);
}

async function fixture(responseStatus = 200, mode: 'json' | 'malformed-sse' | 'slow-sse' | 'missing-usage-sse' = 'json') {
  if (!source) throw new Error('missing TeamKimi source');
  expect(execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(TESTED_TEAMKIMI_COMMIT);
  const contract = JSON.parse(await readFile(join(source, 'test/fixtures/hermes-smoke-http.json'), 'utf8'));
  const serverModule = await import(pathToFileURL(join(source, 'src/server.js')).href) as {
    createProxyServer(accounts: unknown, config: Record<string, unknown>): http.Server;
  };
  const accountModule = await import(pathToFileURL(join(source, 'src/account-manager.js')).href) as {
    AccountManager: new (accounts: unknown[]) => unknown;
  };
  const upstreamRequests: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const upstream = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      upstreamRequests.push({ url: request.url ?? '', headers: request.headers, body });
      if (request.url === '/v1/messages/count_tokens') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(contract.countTokens.response));
        return;
      }
      if (mode === 'malformed-sse') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: {"type":\n');
        return;
      }
      if (mode === 'missing-usage-sse') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end([
          'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
          '',
          'data: {"type":"message_stop"}',
          '',
          '',
        ].join('\n'));
        return;
      }
      if (mode === 'slow-sse') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n');
        setTimeout(() => response.end(), 60);
        return;
      }
      response.writeHead(responseStatus, { 'content-type': 'application/json' });
      response.end(JSON.stringify(responseStatus === 200
        ? contract.message.response
        : { error: { type: 'permission_error', message: 'synthetic provider denial' } }));
    });
  });
  const upstreamPort = await listen(upstream);
  const directory = await mkdtemp(join(tmpdir(), 'hive-t01-wire-'));
  const accounts = new accountModule.AccountManager([
    { name: 'a', type: 'oauth', accessToken: 'wire-broker-account', expiresAt: Date.now() + 3600_000 },
  ]);
  const proxy = serverModule.createProxyServer(accounts, {
    proxy: { apiKey: 'ordinary-proxy-key' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    smoke: { enabled: true, statePath: join(directory, 'ledger.json'), pricing: { attestation } },
  });
  const proxyPort = await listen(proxy);
  closers.push(async () => {
    await close(proxy);
    await close(upstream);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    await rm(directory, { recursive: true, force: true });
  });
  return { proxyPort, upstreamRequests, messageBody: contract.message.body };
}

afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

describe('Anthropic canonicalization', () => {
  it('replaces adaptive defaults and removes adaptive-only fields', () => {
    expect(canonicalAnthropicBody({
      model: 'other', max_tokens: 128000, thinking: { type: 'adaptive' },
      adaptive: true, adaptive_thinking: {}, thinking_budget: 999, reasoning_effort: 'max',
      output_config: { effort: 'max' }, messages: [],
    })).toEqual({
      model: 'kimi-code/k3.1-pro', max_tokens: 2000,
      thinking: { type: 'enabled', budget_tokens: 4000 }, messages: [],
    });
  });

  it('computes the wire fixture cost even when live integration is skipped', () => {
    expect([usageCostMicros(wireUsage, attestation.rates), wireUsage.costMicros]).toEqual([140, 140]);
  });
});

describeWire('TeamKimi PR19 no-paid HTTP wire contract', () => {
  it('injects credentials, forwards the exact Anthropic request, and maps usage and revocation', async () => {
    const wire = await fixture();
    const issued = await request(wire.proxyPort, '/teamkimi/smoke/credentials', {
      method: 'POST', credential: proxyApiKey, body: { scope: 'generation', attemptKey },
    });
    expect(issued.status).toBe(201);
    const adapter = new TeamKimiAdapter({
      baseUrl: `http://127.0.0.1:${wire.proxyPort}`,
      credential: issued.body.credential, credentialId: issued.body.id, attemptKey, proxyApiKey,
      controls: controls(), attestation, expectedPolicyHash: policyHash,
    });
    await adapter.start();
    closers.push(adapter.close.bind(adapter));
    const readiness = await adapter.readiness();
    expect(readiness.model).toBe('kimi-code/k3.1-pro');
    expect(readiness.enforcement.pricingVerified).toBe(true);
    const policy = { scenarioId: 'P01' as const, generation: 1, routeHash: 'a'.repeat(64), policyHash: 'b'.repeat(64) };
    const admission = await adapter.admit(policy);
    const response = await fetch(`${admission.endpoint}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'hermes-placeholder' },
      body: JSON.stringify({
        ...wire.messageBody, max_tokens: 128000, thinking: { type: 'adaptive' }, reasoning_effort: 'max',
        output_config: { effort: 'max' },
      }),
    });
    expect(response.status).toBe(200);
    const receipt = await adapter.receipt(admission.admissionId);
    expect(receipt.status).toBe('completed');
    expect(receipt.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.admissionRequestHash).toBe(admissionEvidenceHash(policy, receipt.requestHash!));
    expect(receipt.usage).toEqual(wireUsage);
    expect(receipt.countedInput).toEqual(wireCounted);
    expect(receipt.policyHash).toBe(policyHash);
    expect(receipt.inputVerified).toBe(true);
    expect(wire.upstreamRequests.map((entry) => entry.url)).toEqual(['/v1/messages/count_tokens', '/v1/messages']);
    const upstream = wire.upstreamRequests[1];
    expect(upstream.headers.authorization).toBe('Bearer wire-broker-account');
    expect(upstream.headers['x-api-key']).toBeUndefined();
    expect(JSON.parse(upstream.body)).toMatchObject({
      model: 'k3.1-pro', max_tokens: 2000,
      thinking: { type: 'enabled', budget_tokens: 4000 },
    });
    expect(JSON.parse(upstream.body).output_config).toBeUndefined();
    const revoked = await adapter.revoke();
    expect(revoked.revoked).toBe(true);
    expect(revoked.proof).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify({ readiness, receipt, revoked })).not.toContain(issued.body.credential);
  });

  it('maps a provider error without exporting raw error content', async () => {
    const wire = await fixture(403);
    const issued = await request(wire.proxyPort, '/teamkimi/smoke/credentials', {
      method: 'POST', credential: proxyApiKey, body: { scope: 'generation', attemptKey },
    });
    const adapter = new TeamKimiAdapter({
      baseUrl: `http://127.0.0.1:${wire.proxyPort}`,
      credential: issued.body.credential, credentialId: issued.body.id, attemptKey, proxyApiKey,
      controls: controls(), attestation, expectedPolicyHash: policyHash,
    });
    await adapter.start();
    closers.push(adapter.close.bind(adapter));
    const admission = await adapter.admit({ scenarioId: 'P07', generation: 1, routeHash: 'a'.repeat(64), policyHash: 'b'.repeat(64) });
    const response = await fetch(`${admission.endpoint}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(wire.messageBody),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await response.json())).not.toContain('synthetic provider denial');
    const receipt = await adapter.receipt(admission.admissionId);
    expect(receipt.status).toBe('failed');
    expect(receipt.errorCategory).toBe('provider');
    expect(receipt.inputVerified).toBe(true);
    expect(receipt.usage).toEqual({ ...wireUsage, outputTokens: 2000, reasoningTokens: 4000, totalTokens: 6010, costMicros: 16010 });
    expect(JSON.stringify(receipt)).not.toContain('synthetic provider denial');
  });

  it('maps malformed SSE to conflicting evidence', async () => {
    const wire = await fixture(200, 'malformed-sse');
    const issued = await request(wire.proxyPort, '/teamkimi/smoke/credentials', {
      method: 'POST', credential: proxyApiKey, body: { scope: 'generation', attemptKey },
    });
    const adapter = new TeamKimiAdapter({ baseUrl: `http://127.0.0.1:${wire.proxyPort}`, credential: issued.body.credential, credentialId: issued.body.id, attemptKey, proxyApiKey, controls: controls(), attestation, expectedPolicyHash: policyHash });
    await adapter.start();
    closers.push(adapter.close.bind(adapter));
    const admission = await adapter.admit({ scenarioId: 'P02', generation: 1, routeHash: 'a'.repeat(64), policyHash: 'b'.repeat(64) });
    const response = await fetch(`${admission.endpoint}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(wire.messageBody),
    });
    expect(response.status).toBe(200);
    const receipt = await receiptUntil(adapter, admission.admissionId, 'conflicting');
    expect(receipt.status).toBe('conflicting');
    expect(receipt.errorCategory).toBe('provider_event_malformed');
  });

  it('rejects a terminal SSE without final usage', async () => {
    const wire = await fixture(200, 'missing-usage-sse');
    const issued = await request(wire.proxyPort, '/teamkimi/smoke/credentials', {
      method: 'POST', credential: proxyApiKey, body: { scope: 'generation', attemptKey },
    });
    const adapter = new TeamKimiAdapter({ baseUrl: `http://127.0.0.1:${wire.proxyPort}`, credential: issued.body.credential, credentialId: issued.body.id, attemptKey, proxyApiKey, controls: controls(), attestation, expectedPolicyHash: policyHash });
    await adapter.start();
    closers.push(adapter.close.bind(adapter));
    const admission = await adapter.admit({ scenarioId: 'P03', generation: 1, routeHash: 'a'.repeat(64), policyHash: 'b'.repeat(64) });
    const response = await fetch(`${admission.endpoint}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(wire.messageBody),
    });
    expect([200, 502]).toContain(response.status);
    const receipt = await receiptUntil(adapter, admission.admissionId, 'conflicting');
    expect(receipt.status).toBe('conflicting');
    expect(receipt.errorCategory).toBe('provider_accounting_unverified');
    expect(receipt.usage).toBeUndefined();
  });

  it('maps genuine detachment to interrupted and closes pending responses', async () => {
    const wire = await fixture(200, 'slow-sse');
    const issued = await request(wire.proxyPort, '/teamkimi/smoke/credentials', {
      method: 'POST', credential: proxyApiKey, body: { scope: 'generation', attemptKey },
    });
    const adapter = new TeamKimiAdapter({ baseUrl: `http://127.0.0.1:${wire.proxyPort}`, credential: issued.body.credential, credentialId: issued.body.id, attemptKey, proxyApiKey, controls: controls(), attestation, expectedPolicyHash: policyHash });
    await adapter.start();
    closers.push(adapter.close.bind(adapter));
    const admission = await adapter.admit({ scenarioId: 'P09', generation: 1, routeHash: 'a'.repeat(64), policyHash: 'b'.repeat(64) });
    const pending = fetch(`${admission.endpoint}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(wire.messageBody),
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    await adapter.cancel(admission.admissionId, 1);
    const response = await pending;
    expect([200, 502]).toContain(response.status);
    const receipt = await receiptUntil(adapter, admission.admissionId, 'interrupted');
    expect(receipt.status).toBe('interrupted');
    expect(receipt.errorCategory).toBe('client_detached');
    await adapter.close();
  });
});
