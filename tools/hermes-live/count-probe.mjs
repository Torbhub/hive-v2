import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { COUNTED_INPUT_FIELDS, countedInput } from './policy.js';

const BASE = 'http://127.0.0.1:8765';
const PROVIDER_COUNT_STATUSES = new Set(['provider_input_accounting_unverified']);
const PROVIDER_COUNT_ERROR_TYPES = new Set([
  'invalid_request_error', 'authentication_error', 'rate_limit_error', 'api_error', 'unknown',
]);
const output = process.argv[2];

function diagnose(error) {
  process.exitCode = 1;
  let category;
  let origin;
  if (/^provider-count-(?:http-\d{3}(?:-(?:invalid_request_error|authentication_error|rate_limit_error|api_error|unknown(?:-upstream-(?:0|[1-9]\d?|[1-5]\d{2}))?))?|status-(?:provider_input_accounting_unverified|unclassified)|model-mismatch|request-hash-mismatch|fields-invalid|arithmetic-mismatch)$/.test(error?.message)) {
    category = error.message;
    origin = 'count-provider:1';
  } else if (['count-revocation-failed', 'count-revocation-not-attested'].includes(error?.message)) {
    category = 'count-revocation-failed';
    origin = 'count-revocation:1';
  } else {
    return;
  }
  try {
    writeFileSync(join(dirname(output), 'bootstrap-category'), `${category}\n`, { mode: 0o600 });
    writeFileSync(join(dirname(output), 'bootstrap-origin'), `${origin}\n`, { mode: 0o600 });
  } catch {
    // paid.sh retains its generic fixed diagnostic when refinement is unavailable.
  }
}
process.on('uncaughtException', diagnose);
process.on('unhandledRejection', diagnose);
if (!output || !output.startsWith('/') || output.includes('..')) throw new Error('invalid-evidence-path');
const requestPath = new URL('./fixtures/count-request.json', import.meta.url);
const body = await readFile(requestPath);
const expectedRequest = {
  model: 'kimi-code/k3.1-pro',
  max_tokens: 6000,
  thinking: { type: 'enabled', budget_tokens: 4000 },
  messages: [{ role: 'user', content: 'Count tokens.' }],
};
if (JSON.stringify(JSON.parse(body.toString('utf8'))) !== JSON.stringify(expectedRequest)) throw new Error('count-request-not-frozen');
const requestHash = createHash('sha256').update(body).digest('hex');
let issued;
let counted;
let sanitizedCounts;

async function request(method, path, requestBody, credential) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(requestBody === undefined ? {} : { 'content-type': 'application/json' }),
      ...(credential === undefined ? {} : { 'x-api-key': credential }),
    },
    body: requestBody,
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 65_536) throw new Error('oversized-smoke-response');
  return { status: response.status, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
}

function validateCounts(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).length !== COUNTED_INPUT_FIELDS.length) {
    throw new Error('provider-count-fields-invalid');
  }
  try {
    return countedInput(value);
  } catch (error) {
    if (error?.message === 'counted-input-mismatch') throw new Error('provider-count-arithmetic-mismatch');
    throw new Error('provider-count-fields-invalid');
  }
}

async function status() {
  const result = await request('GET', '/teamkimi/smoke/status');
  if (result.status !== 200 || !result.value || !Array.isArray(result.value.reservations)
    || result.value.reservations.length !== 0 || result.value.totals?.admissions !== 0) {
    throw new Error('generation-evidence-not-zero');
  }
  return result.value;
}

try {
  const before = await status();
  if (before.credentials?.some((entry) => entry.revokedAt === null)) throw new Error('live-credential-before-count');
  const response = await request('POST', '/teamkimi/smoke/credentials', JSON.stringify({ scope: 'count-only' }));
  issued = response.value;
  if (response.status !== 201 || issued?.scope !== 'count-only' || typeof issued.credential !== 'string'
    || !issued.credential.startsWith('tcc-') || typeof issued.id !== 'string') throw new Error('count-credential-issue-failed');
  counted = await request('POST', '/teamkimi/smoke/count-tokens', body, issued.credential);
  if (counted.status !== 200) {
    const errorType = counted.value?.upstreamErrorType;
    const upstreamStatus = counted.value?.upstreamStatus;
    const suffix = PROVIDER_COUNT_ERROR_TYPES.has(errorType) ? `-${errorType}` : '';
    const upstreamSuffix = errorType === 'unknown' && Number.isInteger(upstreamStatus)
      && upstreamStatus >= 0 && upstreamStatus <= 599 ? `-upstream-${upstreamStatus}` : '';
    throw new Error(`provider-count-http-${counted.status}${suffix}${upstreamSuffix}`);
  }
  if (counted.value?.status !== 'counted') {
    const providerStatus = PROVIDER_COUNT_STATUSES.has(counted.value?.status) ? counted.value.status : 'unclassified';
    throw new Error(`provider-count-status-${providerStatus}`);
  }
  if (counted.value.model !== expectedRequest.model) throw new Error('provider-count-model-mismatch');
  if (counted.value.requestHash !== requestHash) throw new Error('provider-count-request-hash-mismatch');
  sanitizedCounts = validateCounts(counted.value.counts);
  await status();
} finally {
  if (issued) {
    const revoked = await request('POST', '/teamkimi/smoke/revoke');
    const proof = revoked.value?.revoked?.find((entry) => entry.id === issued.id);
    if (revoked.status !== 200 || !proof || !/^[a-f0-9]{64}$/.test(proof.proof)) throw new Error('count-revocation-failed');
    const finalStatus = await status();
    const record = finalStatus.credentials?.find((entry) => entry.id === issued.id);
    if (record?.scope !== 'count-only' || record.revokedAt !== proof.revokedAt || record.revocationProof !== proof.proof) {
      throw new Error('count-revocation-not-attested');
    }
    const evidence = {
      schemaVersion: 1,
      model: expectedRequest.model,
      requestHash,
      counts: sanitizedCounts ?? null,
      generationRequests: 0,
      status: sanitizedCounts ? 'counted' : 'failed',
      timestamp: Number.isSafeInteger(counted?.value?.timestamp) && counted.value.timestamp >= 0 ? counted.value.timestamp : null,
      revocation: { id: issued.id, revokedAt: proof.revokedAt, proof: proof.proof },
    };
    await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  }
}
