import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { TeamKimiAdapter } from '../tools/hermes-live/broker.js';
import { EXPECTED_MODEL } from '../tools/hermes-live/runner.js';
import { attestation, controls, counted, policyHash, usage } from './hermes-live-fixtures.js';

const closers: (() => Promise<void>)[] = [];

async function fixture() {
  let reservation: Record<string, unknown> | undefined;
  let blockedReason: string | null = null;
  let generationCalls = 0;
  let revocationMode = 'valid';
  const credential = {
    id: '0123456789abcdef0123456789abcdef', scope: 'generation', issuedAt: Date.now() - 1000,
    expiresAt: Date.now() + 60000, revokedAt: null as number | null, revocationProof: null as string | null,
  };
  const server = http.createServer((request, response) => {
    if (request.url === '/teamkimi/smoke/status') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        enabled: true, admissionAllowed: blockedReason === null, blockedReason, policyHash,
        pricingVerified: true, model: EXPECTED_MODEL,
        ceilings: {
          scenario: { inputTokens: 16000, outputTokens: 2000, reasoningTokens: 4000, totalTokens: 22000, costMicros: 500000 },
          matrix: { admissions: 12, inputTokens: 96000, outputTokens: 12000, reasoningTokens: 24000, totalTokens: 132000, costMicros: 5000000 },
        },
        totals: {
          admissions: reservation ? 1 : 0,
          inputTokens: reservation ? usage.inputTokens : 0, outputTokens: reservation ? usage.outputTokens : 0,
          reasoningTokens: reservation ? usage.reasoningTokens : 0, totalTokens: reservation ? usage.totalTokens : 0,
          costMicros: reservation ? usage.costMicros : 0,
        },
        credentials: [credential], reservations: reservation ? [reservation] : [],
      }));
      return;
    }
    if (request.url === '/teamkimi/smoke/revoke') {
      if (revocationMode === 'older') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ revoked: [{ id: '1123456789abcdef0123456789abcdef', revokedAt: 1, proof: 'b'.repeat(64) }] }));
        return;
      }
      credential.revokedAt = 1;
      credential.revocationProof = revocationMode === 'wrong-proof' ? '0'.repeat(64) : 'a'.repeat(64);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ revoked: [{ id: credential.id, revokedAt: 1, proof: 'a'.repeat(64) }] }));
      return;
    }
    if (request.url === '/v1/messages') {
      generationCalls++;
      reservation = {
        admissionId: credential.id, scenarioId: 'P01', state: 'reconciled',
        createdAt: Date.now(), reconciledAt: Date.now(), httpStatus: null, ambiguousReason: null,
        inputVerified: true, reserved: usage, actual: usage,
      };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ usage: {} }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('missing-port');
  const adapter = new TeamKimiAdapter({
    baseUrl: `http://127.0.0.1:${address.port}`,
    credential: 'tcs-synthetic', credentialId: credential.id, controls: controls(), attestation, expectedPolicyHash: policyHash,
  });
  await adapter.start();
  closers.push(async () => {
    await adapter.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    adapter,
    generationCalls: () => generationCalls,
    setRevocationMode(value: string) { revocationMode = value; },
    setReservation(value: Record<string, unknown> | undefined) { reservation = value; },
    setBlocked(reason: string | null) { blockedReason = reason; },
  };
}

afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

describe('T01 paid attestation and receipt fences', () => {
  it('requires the exact expected policy hash and provider semantics', async () => {
    const wire = await fixture();
    const readiness = await wire.adapter.readiness();
    expect(readiness.enforcement.policyHash).toBe(policyHash);
    expect(readiness.enforcement.providerSemantics).toEqual(attestation.providerSemantics);
    expect(() => new TeamKimiAdapter({
      baseUrl: 'http://127.0.0.1:8765', credential: 'tcs-synthetic', credentialId: '0123456789abcdef0123456789abcdef', controls: controls(),
      attestation, expectedPolicyHash: '0'.repeat(64),
    })).toThrow('policy-hash-mismatch');
    expect(() => new TeamKimiAdapter({
      baseUrl: 'http://127.0.0.1:8765', credential: 'tcs-synthetic', credentialId: '0123456789abcdef0123456789abcdef', controls: controls(),
      attestation: { ...attestation, providerSemantics: { ...attestation.providerSemantics, thinking: 'invented-semantics' } },
      expectedPolicyHash: policyHash,
    })).toThrow('provider-semantics-mismatch');
  });

  it('returns full cache, TTL, reasoning, and counted-input evidence', async () => {
    const wire = await fixture();
    const admission = await wire.adapter.admit({ scenarioId: 'P01', generation: 1, routeHash: 'a'.repeat(64), policyHash: 'b'.repeat(64) });
    await fetch(`${admission.endpoint}/v1/messages`, { method: 'POST', body: JSON.stringify({ messages: [] }) });
    const receipt = await wire.adapter.receipt(admission.admissionId);
    expect(receipt.status).toBe('completed');
    expect(receipt.policyHash).toBe(policyHash);
    expect(receipt.countedInput).toEqual(counted);
    expect(receipt.usage).toEqual(usage);
  });

  it.each([
    ['cache TTL', { ...usage, cacheCreation5mInputTokens: 2 }],
    ['reasoning', { ...usage, reasoningTokens: undefined }],
    ['total', { ...usage, totalTokens: 61 }],
    ['counted input', { ...usage, baseInputTokens: 3 }],
    ['cost', { ...usage, costMicros: 140 }],
  ])('fails closed for a %s mismatch', async (_name, actual) => {
    const wire = await fixture();
    const admission = await wire.adapter.admit({ scenarioId: 'P01', generation: 1, routeHash: 'a'.repeat(64), policyHash: 'b'.repeat(64) });
    wire.setReservation({
      admissionId: '0123456789abcdef0123456789abcdef', scenarioId: 'P01', state: 'reconciled',
      createdAt: Date.now(), reconciledAt: Date.now(), httpStatus: null, ambiguousReason: null,
      inputVerified: true, reserved: usage, actual,
    });
    const receipt = await wire.adapter.receipt(admission.admissionId);
    expect(receipt.status).toBe('conflicting');
    expect(receipt.errorCategory).toBe('provider_accounting_unverified');
  });

  it.each(['older', 'wrong-proof'])('rejects a %s revocation result', async (mode) => {
    const wire = await fixture();
    wire.setRevocationMode(mode);
    await expect(wire.adapter.revoke()).rejects.toThrow();
  });

  it('accepts only the exact generation credential revocation and final proof', async () => {
    const wire = await fixture();
    const revoked = await wire.adapter.revoke();
    expect(revoked).toMatchObject({
      revoked: true, receiptId: '0123456789abcdef0123456789abcdef',
      credentialId: '0123456789abcdef0123456789abcdef', revokedAt: 1,
      proof: 'a'.repeat(64), scope: 'generation', verified: true,
    });
  });

  it('prevents forwarding when cancellation happens before the request', async () => {
    const wire = await fixture();
    const admission = await wire.adapter.admit({ scenarioId: 'P01', generation: 1, routeHash: 'a'.repeat(64), policyHash: 'b'.repeat(64) });
    await wire.adapter.cancel(admission.admissionId, 1);
    await fetch(`${admission.endpoint}/v1/messages`, { method: 'POST', body: JSON.stringify({ messages: [] }) });
    expect(wire.generationCalls()).toBe(0);
  });

  it('prevents forwarding after a client disconnects during upload', async () => {
    const wire = await fixture();
    const admission = await wire.adapter.admit({ scenarioId: 'P01', generation: 1, routeHash: 'a'.repeat(64), policyHash: 'b'.repeat(64) });
    const request = http.request(`${admission.endpoint}/v1/messages`, { method: 'POST' });
    request.on('error', () => undefined);
    request.end(JSON.stringify({ messages: [] }));
    request.abort();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(wire.generationCalls()).toBe(0);
  });

  it('blocks an unapproved admission alongside an active ceiling reservation', async () => {
    const wire = await fixture();
    wire.setReservation({
      admissionId: '0123456789abcdef0123456789abcdef', scenarioId: 'P11', state: 'reserved',
      createdAt: Date.now(), reconciledAt: null, httpStatus: null, ambiguousReason: null,
      inputVerified: true, reserved: usage, actual: null,
    });
    await expect(wire.adapter.admit({ scenarioId: 'P02', generation: 1, routeHash: 'a'.repeat(64), policyHash: 'b'.repeat(64) })).rejects.toThrow('concurrent-admission-not-approved');
  });

  it('locks later admissions after an ambiguous reservation', async () => {
    const wire = await fixture();
    const admission = await wire.adapter.admit({ scenarioId: 'P01', generation: 1, routeHash: 'a'.repeat(64), policyHash: 'b'.repeat(64) });
    wire.setReservation({
      admissionId: '0123456789abcdef0123456789abcdef', scenarioId: 'P01', state: 'ambiguous',
      createdAt: Date.now(), reconciledAt: Date.now(), httpStatus: null,
      ambiguousReason: 'upstream_outcome_ambiguous', inputVerified: true, reserved: usage, actual: null,
    });
    wire.setBlocked('upstream_outcome_ambiguous');
    expect((await wire.adapter.receipt(admission.admissionId)).status).toBe('conflicting');
    await expect(wire.adapter.admit({ scenarioId: 'P02', generation: 1, routeHash: 'a'.repeat(64), policyHash: 'b'.repeat(64) })).rejects.toThrow('ambiguous-reservation-lock');
  });
});
