import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { admissionEvidenceHash, policyAdmissionHash } from './runner.js';
import {
  MATRIX_CEILING, SCENARIO_CEILING, countedInput, providerSemantics, sameCountedInput,
  smokeAttestation, smokePolicyHash, usageCostMicros, usageEvidence,
} from './policy.js';
import type {
  BrokerActivity, BrokerAdmission, BrokerReadiness, BrokerReceipt, SessionEvidence,
  T01Broker, UsageCeiling, UsageEvidence,
} from './runner.js';

const MODEL = 'kimi-code/k3.1-pro';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_STATUS_BYTES = 64 * 1024;
const BLOCKED_REASONS = new Set([
  'pricing_unverified', 'policy_mismatch', 'provider_accounting_unverified', 'provider_input_accounting_unverified',
  'provider_event_malformed', 'provider_terminal_evidence_conflict', 'provider_terminal_evidence_missing',
  'scenario_ceiling_exceeded', 'matrix_ceiling_exceeded', 'upstream_outcome_ambiguous', 'client_detached',
  'ledger_unavailable', 'smoke_internal_error',
]);

export type HiveControlEvidence = Pick<BrokerReadiness, 'credential' | 'isolation' | 'egress'>;

type AdmissionRecord = {
  admission: BrokerAdmission;
  admissionId: string;
  requestHash: string;
  endpoint: string;
  server: http.Server;
  controller?: AbortController;
  bodyHash?: string;
  cancelRequested: boolean;
  activities: BrokerActivity[];
};
type TeamKimiReservation = {
  admissionId: string;
  scenarioId: string;
  state: 'reserved' | 'reconciled' | 'failed' | 'ambiguous';
  createdAt: number;
  reconciledAt: number | null;
  httpStatus: number | null;
  ambiguousReason: string | null;
  inputVerified: boolean;
  reserved: UsageEvidence;
  actual: UsageEvidence | null;
};
type TeamKimiStatus = {
  enabled: true;
  admissionAllowed: boolean;
  blockedReason: string | null;
  policyHash: string;
  pricingVerified: boolean;
  model: string;
  ceilings: { scenario: UsageCeiling; matrix: UsageCeiling & { admissions: number } };
  totals: (UsageCeiling & { admissions: number }) | null;
  credentials: { id: string; scope: 'generation' | 'count-only'; issuedAt: number; expiresAt: number; revokedAt: number | null; revocationProof: string | null }[];
  reservations: TeamKimiReservation[];
};

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const id = (value: unknown) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,256}$/.test(value)) throw new Error('invalid-identifier');
  return value;
};
const hash64 = (value: unknown) => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid-hash');
  return value;
};
const integer = (value: unknown) => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('invalid-integer');
  return value as number;
};
const nullableInteger = (value: unknown) => value === null ? null : integer(value);
const boolean = (value: unknown) => {
  if (typeof value !== 'boolean') throw new Error('invalid-boolean');
  return value;
};
const nullableHash = (value: unknown) => value === null ? null : hash64(value);

function object(value: unknown, keys: readonly string[]) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid-object');
  const record = value as Record<string, unknown>;
  const expected = new Set(keys);
  if (Object.keys(record).some((key) => !expected.has(key))) throw new Error('unexpected-object-field');
  return record;
}

function ceilingUsage(value: unknown): UsageCeiling {
  const input = object(value, ['inputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens', 'costMicros']);
  const result = {
    inputTokens: integer(input.inputTokens), outputTokens: integer(input.outputTokens),
    reasoningTokens: integer(input.reasoningTokens), totalTokens: integer(input.totalTokens), costMicros: integer(input.costMicros),
  };
  if (result.totalTokens !== result.inputTokens + result.outputTokens + result.reasoningTokens) throw new Error('inexact-usage');
  return result;
}

function matrixUsage(value: unknown) {
  const input = object(value, ['admissions', 'inputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens', 'costMicros']);
  return {
    admissions: integer(input.admissions),
    ...ceilingUsage({
      inputTokens: input.inputTokens, outputTokens: input.outputTokens, reasoningTokens: input.reasoningTokens,
      totalTokens: input.totalTokens, costMicros: input.costMicros,
    }),
  };
}

function reservation(value: unknown): TeamKimiReservation {
  const input = object(value, [
    'admissionId', 'scenarioId', 'state', 'createdAt', 'reconciledAt', 'httpStatus', 'ambiguousReason', 'inputVerified', 'reserved', 'actual',
  ]);
  const state = input.state;
  if (!['reserved', 'reconciled', 'failed', 'ambiguous'].includes(String(state))) throw new Error('invalid-reservation-state');
  const ambiguousReason = input.ambiguousReason;
  if (ambiguousReason !== null && !BLOCKED_REASONS.has(String(ambiguousReason))) throw new Error('invalid-ambiguous-reason');
  const httpStatus = nullableInteger(input.httpStatus);
  if (httpStatus !== null && (httpStatus < 100 || httpStatus > 599)) throw new Error('invalid-http-status');
  return {
    admissionId: id(input.admissionId), scenarioId: id(input.scenarioId), state: state as TeamKimiReservation['state'],
    createdAt: integer(input.createdAt), reconciledAt: nullableInteger(input.reconciledAt), httpStatus,
    ambiguousReason: ambiguousReason as string | null, inputVerified: boolean(input.inputVerified),
    reserved: usageEvidence(input.reserved), actual: input.actual === null ? null : usageEvidence(input.actual),
  };
}

function status(value: unknown): TeamKimiStatus {
  const input = object(value, [
    'enabled', 'admissionAllowed', 'blockedReason', 'policyHash', 'pricingVerified', 'model', 'ceilings',
    'totals', 'credentials', 'reservations',
  ]);
  if (input.enabled !== true || input.model !== MODEL
    || input.blockedReason !== null && !BLOCKED_REASONS.has(String(input.blockedReason))) throw new Error('invalid-status');
  const ceilings = object(input.ceilings, ['scenario', 'matrix']);
  if (!Array.isArray(input.credentials) || input.credentials.length > 64 || !Array.isArray(input.reservations) || input.reservations.length > 12) throw new Error('invalid-status-collections');
  return {
    enabled: true,
    admissionAllowed: boolean(input.admissionAllowed), blockedReason: input.blockedReason as string | null,
    policyHash: hash64(input.policyHash), pricingVerified: boolean(input.pricingVerified), model: MODEL,
    ceilings: { scenario: ceilingUsage(ceilings.scenario), matrix: matrixUsage(ceilings.matrix) },
    totals: input.totals === null ? null : matrixUsage(input.totals),
    credentials: input.credentials.map((entry) => {
      const credential = object(entry, ['id', 'scope', 'issuedAt', 'expiresAt', 'revokedAt', 'revocationProof']);
      if (credential.scope !== 'generation' && credential.scope !== 'count-only') throw new Error('invalid-credential-scope');
      return {
        id: id(credential.id), scope: credential.scope, issuedAt: integer(credential.issuedAt), expiresAt: integer(credential.expiresAt),
        revokedAt: nullableInteger(credential.revokedAt), revocationProof: nullableHash(credential.revocationProof),
      };
    }),
    reservations: input.reservations.map(reservation),
  };
}

function trueFields(value: unknown, keys: readonly string[]) {
  const input = object(value, keys);
  for (const key of keys) if (input[key] !== true) throw new Error('control-not-verified');
}

export function validateControls(controls: HiveControlEvidence) {
  trueFields(controls.credential, ['smokeOnly', 'shortLived', 'isolatedFromHermes']);
  trueFields(controls.isolation, [
    'disposable', 'readOnlyFixtures', 'confinedWorkingDirectories', 'noPrivilegedMode', 'noHostNetwork', 'noHostPid',
    'noContainerSockets', 'noCredentialMounts', 'noWritableHostPaths', 'noOnDemandInstalls', 'coreDumpsDisabled', 'debuggingDisabled',
  ]);
  trueFields(controls.egress, [
    'defaultDeny', 'approvedDestination', 'directIpDenied', 'unapprovedDnsDenied', 'redirectDenied', 'ipv6Denied',
    'alternatePortDenied', 'metadataDenied',
  ]);
}

export function canonicalAnthropicBody(parsed: Record<string, unknown>) {
  if (!Array.isArray(parsed.messages)) throw new Error('invalid-anthropic-request');
  const canonical: Record<string, unknown> = {
    ...parsed,
    model: MODEL,
    max_tokens: 2000,
    thinking: { type: 'enabled', budget_tokens: 4000 },
  };
  delete canonical.adaptive;
  delete canonical.adaptive_thinking;
  delete canonical.thinking_budget;
  delete canonical.reasoning_effort;
  delete canonical.output_config;
  return canonical;
}

function activities(value: BrokerActivity[]) {
  if (!Array.isArray(value) || value.length > 128) throw new Error('invalid-activities');
  return value.map((entry) => ({
    id: id(entry.id), sequence: integer(entry.sequence), durationMs: integer(entry.durationMs), status: id(entry.status),
    ...(entry.errorCategory === undefined ? {} : { errorCategory: id(entry.errorCategory) }),
    ...(entry.resultSha256 === undefined ? {} : { resultSha256: hash64(entry.resultSha256) }),
  }));
}

async function readBounded(response: Response, maximum: number) {
  if (!response.body) throw new Error('empty-response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maximum) {
      await reader.cancel();
      throw new Error('response-too-large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function requestSmokeJson(baseUrl: string, method: string, path: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    method, headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('teamkimi-status-failed');
  const bytes = await readBounded(response, MAX_STATUS_BYTES);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function attemptCredentialId(value: unknown) {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) throw new Error('invalid-attempt-credential-id');
  return value;
}

function secretCredential(value: unknown) {
  const input = object(value, ['id', 'credential', 'scope', 'issuedAt', 'expiresAt']);
  if (input.scope !== 'generation' || typeof input.credential !== 'string' || !input.credential.startsWith('tcs-')) {
    throw new Error('invalid-generation-credential');
  }
  const issuedAt = integer(input.issuedAt);
  const expiresAt = integer(input.expiresAt);
  if (expiresAt <= issuedAt || expiresAt - issuedAt > 15 * 60 * 1000) throw new Error('credential-lifetime-not-ready');
  return { id: attemptCredentialId(input.id), credential: input.credential };
}

function publicAttempt(value: unknown) {
  const input = object(value, ['state', 'credentialId', 'credentialStatus', 'issuedAt', 'expiresAt', 'revokedAt']);
  if (input.state !== 'minted' || !['active', 'expired', 'revoked'].includes(String(input.credentialStatus))) {
    throw new Error('invalid-credential-attempt');
  }
  const issuedAt = integer(input.issuedAt);
  const expiresAt = integer(input.expiresAt);
  const revokedAt = nullableInteger(input.revokedAt);
  if (expiresAt <= issuedAt || expiresAt - issuedAt > 15 * 60 * 1000) throw new Error('credential-lifetime-not-ready');
  if (input.credentialStatus === 'revoked' !== (revokedAt !== null)) throw new Error('invalid-credential-attempt-status');
  return {
    credentialId: attemptCredentialId(input.credentialId), credentialStatus: input.credentialStatus as 'active' | 'expired' | 'revoked',
    issuedAt, expiresAt, revokedAt,
  };
}

function pendingAttempt(value: unknown) {
  if (object(value, ['state']).state !== 'pending') throw new Error('invalid-credential-attempt-pending');
}

function attemptError(value: unknown, code: string) {
  const input = object(value, ['type', 'error']);
  const detail = object(input.error, ['type', 'code', 'message']);
  if (input.type !== 'error' || detail.type !== 'invalid_request_error' || detail.code !== code || detail.message !== code) {
    throw new Error('invalid-credential-attempt-error');
  }
}

async function requestAttemptJson(baseUrl: string, method: string, path: string, attemptKey: string, proxyApiKey: string, body?: unknown) {
  if (!/^[a-f0-9]{64}$/.test(attemptKey) || !proxyApiKey) throw new Error('invalid-credential-attempt-control');
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      accept: 'application/json', 'x-api-key': proxyApiKey,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  const bytes = await readBounded(response, MAX_STATUS_BYTES);
  return { httpStatus: response.status, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown };
}

export async function issueGenerationCredential(baseUrl: string, attemptKey: string, proxyApiKey: string) {
  const deadline = Date.now() + 15_000;
  let recovered: ReturnType<typeof publicAttempt> | undefined;
  for (let attempt = 0; attempt < 5 && Date.now() < deadline && !recovered; attempt++) {
    try {
      const mint = await requestAttemptJson(baseUrl, 'POST', '/teamkimi/smoke/credentials', attemptKey, proxyApiKey, {
        scope: 'generation', attemptKey,
      });
      if (mint.httpStatus === 201) return secretCredential(mint.value);
      if (mint.httpStatus === 200) recovered = publicAttempt(mint.value);
      else if (mint.httpStatus === 202) pendingAttempt(mint.value);
      else if (mint.httpStatus === 401) throw new Error('credential-attempt-authentication-failed');
      else if (mint.httpStatus === 409) {
        attemptError(mint.value, 'credential_attempt_conflict');
        throw new Error('credential-attempt-conflict');
      } else throw new Error('invalid-credential-mint-status');
    } catch (error) {
      if (error instanceof Error && ['credential-attempt-authentication-failed', 'credential-attempt-conflict'].includes(error.message)) throw error;
    }
    if (recovered) break;
    try {
      const current = await requestAttemptJson(
        baseUrl, 'GET', `/teamkimi/smoke/credential-attempts/${attemptKey}`, attemptKey, proxyApiKey,
      );
      if (current.httpStatus === 200) recovered = publicAttempt(current.value);
      else if (current.httpStatus === 202) pendingAttempt(current.value);
      else if (current.httpStatus === 404) attemptError(current.value, 'credential_attempt_not_found');
      else throw new Error('invalid-credential-attempt-status');
    } catch {
      // Same-attempt replay is safe when status is unavailable or not found.
    }
    if (!recovered) await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  if (!recovered) throw new Error('credential-attempt-recovery-failed');
  await revokeAndVerifySmokeCredential(baseUrl, recovered.credentialId, attemptKey, proxyApiKey);
  throw new Error('credential-attempt-recovered-without-secret');
}

export async function revokeAndVerifySmokeCredential(baseUrl: string, credentialId: string, attemptKey?: string, proxyApiKey?: string) {
  if (attemptKey) {
    attemptCredentialId(credentialId);
    const before = status(await requestSmokeJson(baseUrl, 'GET', '/teamkimi/smoke/status'));
    const candidate = before.credentials.find((entry) => entry.id === credentialId);
    if (!candidate || candidate.scope !== 'generation') throw new Error('generation-credential-attempt-mismatch');
  }
  const returned = new Map<string, { revokedAt: number; proof: string }>();
  if (attemptKey) {
    const response = await requestAttemptJson(
      baseUrl, 'POST', `/teamkimi/smoke/credentials/${credentialId}/revoke`, attemptKey, proxyApiKey ?? '', { attemptKey },
    );
    if (response.httpStatus !== 200) throw new Error('generation-revocation-failed');
    const proof = object(response.value, ['id', 'revokedAt', 'proof']);
    returned.set(attemptCredentialId(proof.id), { revokedAt: integer(proof.revokedAt), proof: hash64(proof.proof) });
  } else {
    const value = object(await requestSmokeJson(baseUrl, 'POST', '/teamkimi/smoke/revoke'), ['revoked']);
    if (!Array.isArray(value.revoked) || value.revoked.length > 64) throw new Error('invalid-revocation');
    for (const entry of value.revoked) {
      const proof = object(entry, ['id', 'revokedAt', 'proof']);
      returned.set(id(proof.id), { revokedAt: integer(proof.revokedAt), proof: hash64(proof.proof) });
    }
  }
  const current = status(await requestSmokeJson(baseUrl, 'GET', '/teamkimi/smoke/status'));
  const credential = current.credentials.find((entry) => entry.id === credentialId);
  if (!credential || credential.scope !== 'generation' || credential.revokedAt === null || !credential.revocationProof) {
    throw new Error('generation-revocation-not-proven');
  }
  const returnedProof = returned.get(credentialId);
  if (attemptKey && !returnedProof || returnedProof && (returnedProof.revokedAt !== credential.revokedAt || returnedProof.proof !== credential.revocationProof)) {
    throw new Error('revocation-proof-mismatch');
  }
  if (attemptKey) {
    const response = await requestAttemptJson(
      baseUrl, 'GET', `/teamkimi/smoke/credential-attempts/${attemptKey}`, attemptKey, proxyApiKey ?? '',
    );
    if (response.httpStatus !== 200) throw new Error('generation-revocation-not-proven');
    const attempt = publicAttempt(response.value);
    if (attempt.credentialId !== credentialId || attempt.credentialStatus !== 'revoked'
      || attempt.issuedAt !== credential.issuedAt || attempt.expiresAt !== credential.expiresAt
      || attempt.revokedAt !== credential.revokedAt) throw new Error('generation-revocation-not-proven');
  }
  return {
    revoked: true as const, receiptId: credential.id, credentialId: credential.id,
    revokedAt: credential.revokedAt, proof: credential.revocationProof,
    scope: 'generation' as const, verified: true as const,
  };
}

export async function withSmokeRevocation<T>(options: { baseUrl: string; credentialId: string }, operation: () => Promise<T>) {
  try {
    return await operation();
  } finally {
    await revokeAndVerifySmokeCredential(options.baseUrl, options.credentialId);
  }
}

export class TeamKimiAdapter implements T01Broker {
  private readonly baseUrl: string;
  private readonly credential: string;
  private readonly credentialId: string;
  private readonly attemptKey?: string;
  private readonly proxyApiKey?: string;
  private readonly controls: HiveControlEvidence;
  private readonly attestation: Record<string, unknown>;
  private readonly expectedPolicyHash: string;
  private readonly admissions = new Map<string, AdmissionRecord>();
  private readonly sessions = new Map<string, SessionEvidence>();
  private started = false;

  constructor(options: { baseUrl: string; credential: string; credentialId: string; attemptKey?: string; proxyApiKey?: string; controls: HiveControlEvidence; attestation: unknown; expectedPolicyHash: string }) {
    const parsed = new URL(options.baseUrl);
    const loopback = ['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname);
    if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback))
      || parsed.username || parsed.password || parsed.search || parsed.hash || !options.credential) throw new Error('invalid-broker-configuration');
    validateControls(options.controls);
    this.credentialId = id(options.credentialId);
    this.attemptKey = options.attemptKey;
    this.proxyApiKey = options.proxyApiKey;
    if (smokePolicyHash(options.attestation) !== hash64(options.expectedPolicyHash)) throw new Error('policy-hash-mismatch');
    this.attestation = smokeAttestation(options.attestation);
    this.expectedPolicyHash = options.expectedPolicyHash;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.credential = options.credential;
    this.controls = options.controls;
  }

  async start() {
    this.started = true;
  }

  async close() {
    if (!this.started) return;
    this.started = false;
    for (const record of this.admissions.values()) {
      record.controller?.abort();
      record.server.closeAllConnections();
      await new Promise<void>((resolve) => record.server.close(() => resolve()));
    }
    this.admissions.clear();
  }

  async readiness(): Promise<BrokerReadiness> {
    smokeAttestation(this.attestation, Date.now());
    const current = status(await this.requestJson('GET', '/teamkimi/smoke/status'));
    if (!current.admissionAllowed || current.blockedReason !== null || !current.pricingVerified || current.model !== MODEL
      || current.policyHash !== this.expectedPolicyHash
      || JSON.stringify(current.ceilings.scenario) !== JSON.stringify(SCENARIO_CEILING)
      || JSON.stringify(current.ceilings.matrix) !== JSON.stringify(MATRIX_CEILING) || !current.totals
      || Object.values(current.totals).some((value) => value !== 0) || current.reservations.length !== 0) throw new Error('teamkimi-not-ready');
    const activeCredentials = current.credentials.filter((entry) => entry.revokedAt === null && entry.scope === 'generation' && entry.id === this.credentialId);
    if (activeCredentials.length !== 1) throw new Error('credential-scope-not-ready');
    const credential = activeCredentials[0];
    if (credential.expiresAt <= Date.now() || credential.expiresAt - credential.issuedAt > 15 * 60 * 1000) throw new Error('credential-lifetime-not-ready');
    return {
      provider: 'TeamKimi', model: MODEL,
      credential: { ...this.controls.credential }, isolation: { ...this.controls.isolation }, egress: { ...this.controls.egress },
      enforcement: {
        atomicReservations: true, sharedLedger: true, modelCeiling: true, tokenCeiling: true, dollarCeiling: true,
        pricingVerified: true, policyHash: current.policyHash, providerSemantics: providerSemantics(this.attestation.providerSemantics),
        admissionAllowed: true, blockedReason: null,
      },
      ceilings: { scenario: { ...current.ceilings.scenario }, matrix: { ...current.ceilings.matrix } },
    };
  }

  async admit(admission: BrokerAdmission) {
    if (!this.started || [...this.admissions.values()].some((entry) => entry.admission.scenarioId === admission.scenarioId)) throw new Error('duplicate-scenario');
    const current = status(await this.requestJson('GET', '/teamkimi/smoke/status'));
    if (current.reservations.some((entry) => entry.state === 'ambiguous') || current.blockedReason !== null) throw new Error('ambiguous-reservation-lock');
    if (current.policyHash !== this.expectedPolicyHash) throw new Error('policy-hash-mismatch');
    if (!current.admissionAllowed || current.reservations.length >= MATRIX_CEILING.admissions || !current.totals
      || current.totals.admissions !== current.reservations.length) throw new Error('matrix-ceiling-exceeded');
    const active = current.reservations.filter((entry) => entry.state === 'reserved');
    if (active.length >= 2 || active.some((entry) => !['P11', 'P12'].includes(entry.scenarioId))
      || !['P11', 'P12'].includes(admission.scenarioId) && active.length > 0) throw new Error('concurrent-admission-not-approved');
    const rates = this.attestation.rates as Record<string, number>;
    const inputRate = Math.max(rates.inputMicrosPerToken, rates.cacheReadMicrosPerToken, rates.cacheCreation5mMicrosPerToken, rates.cacheCreation1hMicrosPerToken);
    const projected = {
      admissions: current.totals.admissions + 1,
      inputTokens: current.totals.inputTokens + SCENARIO_CEILING.inputTokens,
      outputTokens: current.totals.outputTokens + SCENARIO_CEILING.outputTokens,
      reasoningTokens: current.totals.reasoningTokens + SCENARIO_CEILING.reasoningTokens,
      totalTokens: current.totals.totalTokens + SCENARIO_CEILING.totalTokens,
      costMicros: current.totals.costMicros + SCENARIO_CEILING.inputTokens * inputRate
        + SCENARIO_CEILING.outputTokens * rates.outputMicrosPerToken + SCENARIO_CEILING.reasoningTokens * rates.reasoningMicrosPerToken,
    };
    if (Object.entries(projected).some(([key, value]) => !Number.isSafeInteger(value) || value > MATRIX_CEILING[key as keyof typeof MATRIX_CEILING])) {
      throw new Error('matrix-ceiling-exceeded');
    }
    const admissionId = randomBytes(16).toString('hex');
    const requestHash = policyAdmissionHash(admission);
    let record: AdmissionRecord;
    const server = http.createServer((request, response) => { void this.forward(record, request, response); });
    record = { admission, admissionId, requestHash, endpoint: '', server, controller: new AbortController(), cancelRequested: false, activities: [] };
    const port = await new Promise<number>((resolve) => record.server.listen(0, '127.0.0.1', () => {
      const address = record.server.address();
      if (typeof address === 'object' && address) resolve(address.port);
    }));
    record.endpoint = `http://127.0.0.1:${port}`;
    this.admissions.set(admissionId, record);
    return { admissionId, requestHash, endpoint: record.endpoint };
  }

  async receipt(admissionId: string): Promise<BrokerReceipt> {
    const record = this.admissions.get(admissionId);
    if (!record) return { status: 'missing' };
    try {
      const current = status(await this.requestJson('GET', '/teamkimi/smoke/status'));
      const reservation = current.reservations.find((entry) => entry.scenarioId === record.admission.scenarioId);
      if (!reservation) return { status: 'missing' };
      const input = countedInput(reservation.reserved);
      const countedMismatch = reservation.actual !== null && !sameCountedInput(input, reservation.actual);
      const costMismatch = [reservation.reserved, ...(reservation.actual ? [reservation.actual] : [])]
        .some((entry) => usageCostMicros(entry, this.attestation.rates) !== entry.costMicros);
      const mapped = current.policyHash !== this.expectedPolicyHash || countedMismatch || costMismatch
        || current.blockedReason !== null && reservation.state !== 'ambiguous'
        ? 'conflicting'
        : reservation.state === 'reserved' ? 'running'
          : reservation.state === 'reconciled' ? 'completed'
            : reservation.state === 'failed' ? 'failed'
              : reservation.ambiguousReason === 'client_detached' && record.cancelRequested ? 'interrupted' : 'conflicting';
      return {
        status: mapped,
        receiptId: reservation.admissionId,
        model: MODEL,
        inputVerified: reservation.inputVerified,
        countedInput: input,
        usage: reservation.actual ?? undefined,
        policyHash: current.policyHash,
        requestHash: record.bodyHash,
        admissionRequestHash: record.bodyHash ? admissionEvidenceHash(record.admission, record.bodyHash) : undefined,
        errorCategory: countedMismatch || costMismatch ? 'provider_accounting_unverified'
          : current.policyHash !== this.expectedPolicyHash ? 'policy_mismatch'
            : reservation.ambiguousReason ?? (reservation.httpStatus && reservation.httpStatus >= 400 ? 'provider' : undefined),
        activities: activities(record.activities),
      };
    } catch {
      return { status: 'conflicting', errorCategory: 'provider_accounting_unverified', activities: activities(record.activities) };
    }
  }

  async cancel(admissionId: string, generation: number) {
    const record = this.admissions.get(admissionId);
    if (!record || record.admission.generation !== generation) throw new Error('cancellation-generation-mismatch');
    record.cancelRequested = true;
    record.controller?.abort();
  }

  async recordActivities(admissionId: string, value: BrokerActivity[]) {
    const record = this.admissions.get(admissionId);
    if (!record) throw new Error('unknown-admission');
    record.activities = activities(value);
  }

  async recordSession(value: SessionEvidence) {
    if (!value.sessionId || value.status !== 'present') throw new Error('invalid-session-record');
    this.sessions.set(value.sessionId, value);
  }

  async sessionEvidence(sessionId: string): Promise<SessionEvidence> {
    return this.sessions.get(sessionId) ?? { status: 'missing' };
  }

  async revoke() {
    return revokeAndVerifySmokeCredential(this.baseUrl, this.credentialId, this.attemptKey, this.proxyApiKey);
  }

  private async requestJson(method: string, path: string) {
    return requestSmokeJson(this.baseUrl, method, path);
  }

  private async forward(record: AdmissionRecord, request: http.IncomingMessage, response: http.ServerResponse) {
    if (request.method !== 'POST' || request.url !== '/v1/messages') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Not found' } }));
      return;
    }
    const controller = record.controller ??= new AbortController();
    const detach = () => {
      record.cancelRequested = true;
      controller.abort();
    };
    request.on('aborted', detach);
    response.on('close', () => {
      if (!response.writableEnded) detach();
    });
    if (record.cancelRequested || request.aborted || response.destroyed) {
      if (!response.destroyed) response.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'cancelled_error', message: 'client_detached' } }));
      return;
    }
    try {
      const body = await readRequest(request);
      if (record.cancelRequested) throw new Error('client-detached');
      const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      const canonicalBody = Buffer.from(JSON.stringify(canonicalAnthropicBody(parsed)), 'utf8');
      record.bodyHash = sha256(canonicalBody);
      if (record.cancelRequested) throw new Error('client-detached');
      const upstream = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.credential,
          'x-teamkimi-smoke-scenario': record.admission.scenarioId,
          'anthropic-version': typeof request.headers['anthropic-version'] === 'string' ? request.headers['anthropic-version'] : '2023-06-01',
          accept: typeof request.headers.accept === 'string' ? request.headers.accept : 'application/json',
        },
        body: canonicalBody,
        redirect: 'error',
        signal: controller.signal,
      });
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      if (upstream.status >= 400) {
        response.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'TeamKimi request failed' } }));
        return;
      }
      if (!upstream.body) throw new Error('empty-upstream-response');
      const reader = upstream.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writeWithBackpressure(response, value);
      }
      response.end();
    } catch {
      if (response.destroyed) return;
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
      if (!response.writableEnded) response.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'TeamKimi request failed' } }));
    }
  }
}

async function writeWithBackpressure(response: http.ServerResponse, value: Uint8Array) {
  if (response.destroyed || response.writableEnded) throw new Error('client-detached');
  if (response.write(value)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', onDrain);
      response.off('close', onClose);
      response.off('error', onError);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('client-detached')); };
    const onError = () => { cleanup(); reject(new Error('client-detached')); };
    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('error', onError);
    if (response.destroyed || response.writableEnded) {
      cleanup();
      reject(new Error('client-detached'));
    }
  });
}

async function readRequest(request: http.IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new Error('request-too-large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
