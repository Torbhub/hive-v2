import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { COUNTED_INPUT_FIELDS, countedInput } from './policy.js';

const BASE = 'http://127.0.0.1:8765';
const output = process.argv[2];
if (!output || !output.startsWith('/') || output.includes('..')) throw new Error('invalid-evidence-path');
const requestPath = new URL('./fixtures/count-request.json', import.meta.url);
const body = await readFile(requestPath);
const expectedRequest = {
  model: 'kimi-code/k3.1-pro',
  max_tokens: 2000,
  thinking: { type: 'enabled', budget_tokens: 4000 },
  messages: [],
};
if (JSON.stringify(JSON.parse(body.toString('utf8'))) !== JSON.stringify(expectedRequest)) throw new Error('count-request-not-frozen');
const requestHash = createHash('sha256').update(body).digest('hex');
let issued;
let counted;

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

function validCounts(value) {
  try {
    return Object.keys(value).length === COUNTED_INPUT_FIELDS.length && countedInput(value) && true;
  } catch {
    return false;
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
  if (counted.status !== 200 || counted.value?.status !== 'counted' || counted.value.model !== expectedRequest.model
    || counted.value.requestHash !== requestHash || !validCounts(counted.value.counts)) {
    throw new Error('count-evidence-invalid');
  }
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
      counts: counted?.value?.counts ?? null,
      generationRequests: 0,
      status: counted?.status === 200 ? 'counted' : 'failed',
      timestamp: counted?.value?.timestamp ?? null,
      revocation: { id: issued.id, revokedAt: proof.revokedAt, proof: proof.proof },
    };
    await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  }
}
