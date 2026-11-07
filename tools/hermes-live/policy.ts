import { createHash } from 'node:crypto';

export const PROVIDER_SEMANTICS = Object.freeze({
  maxTokens: 'independent-output-ceiling',
  thinking: 'independent-reasoning-ceiling',
  usage: 'messages-total-input-output-reasoning-v1',
});
export const SCENARIO_CEILING = Object.freeze({ inputTokens: 16000, outputTokens: 2000, reasoningTokens: 4000, totalTokens: 22000, costMicros: 500000 });
export const MATRIX_CEILING = Object.freeze({ admissions: 12, inputTokens: 96000, outputTokens: 12000, reasoningTokens: 24000, totalTokens: 132000, costMicros: 5000000 });
export const COUNTED_INPUT_FIELDS = [
  'inputTokens', 'baseInputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens',
  'cacheCreation5mInputTokens', 'cacheCreation1hInputTokens',
] as const;

const RATE_FIELDS = [
  'inputMicrosPerToken', 'outputMicrosPerToken', 'reasoningMicrosPerToken',
  'cacheReadMicrosPerToken', 'cacheCreation5mMicrosPerToken', 'cacheCreation1hMicrosPerToken',
];

function exactObject(value: unknown, keys: readonly string[]) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid-policy-object');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) throw new Error('invalid-policy-fields');
  return record;
}

function integer(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('invalid-policy-integer');
  return value as number;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
}

export function providerSemantics(value: unknown) {
  const semantics = exactObject(value, ['maxTokens', 'thinking', 'usage']);
  if (semantics.maxTokens !== PROVIDER_SEMANTICS.maxTokens || semantics.thinking !== PROVIDER_SEMANTICS.thinking
    || semantics.usage !== PROVIDER_SEMANTICS.usage) throw new Error('provider-semantics-mismatch');
  return { ...PROVIDER_SEMANTICS };
}

export function smokeAttestation(value: unknown, now?: number) {
  const attestation = exactObject(value, [
    'contractVersion', 'route', 'messagesPath', 'model', 'source', 'effectiveAt', 'expiresAt',
    'evidenceHash', 'rates', 'providerSemantics',
  ]);
  if (attestation.contractVersion !== 1 || attestation.route !== 'teamkimi'
    || attestation.messagesPath !== '/v1/messages' || attestation.model !== 'kimi-code/k3.1-pro'
    || typeof attestation.source !== 'string' || !attestation.source || attestation.source.length > 256
    || !/^[a-f0-9]{64}$/.test(String(attestation.evidenceHash))) throw new Error('invalid-smoke-attestation');
  const effectiveAt = Date.parse(String(attestation.effectiveAt));
  const expiresAt = Date.parse(String(attestation.expiresAt));
  if (!Number.isSafeInteger(effectiveAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= effectiveAt
    || now !== undefined && (effectiveAt > now || expiresAt <= now)) throw new Error('smoke-attestation-not-current');
  const rates = exactObject(attestation.rates, RATE_FIELDS);
  const values = RATE_FIELDS.map((key) => integer(rates[key]));
  if (!values.some((rate) => rate > 0)) throw new Error('empty-smoke-rates');
  providerSemantics(attestation.providerSemantics);
  return attestation;
}

export function smokePolicyHash(value: unknown) {
  const attestation = smokeAttestation(value);
  return createHash('sha256').update(JSON.stringify(canonical({
    contractVersion: 1,
    model: 'kimi-code/k3.1-pro',
    scenario: SCENARIO_CEILING,
    matrix: MATRIX_CEILING,
    attestation,
  }))).digest('hex');
}

export function countedInput(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid-counted-input');
  const input = value as Record<string, unknown>;
  if (COUNTED_INPUT_FIELDS.some((key) => !Object.hasOwn(input, key))) throw new Error('invalid-counted-input-fields');
  const result = Object.fromEntries(COUNTED_INPUT_FIELDS.map((key) => [key, integer(input[key])]));
  if (result.cacheCreationInputTokens !== result.cacheCreation5mInputTokens + result.cacheCreation1hInputTokens
    || result.inputTokens !== result.baseInputTokens + result.cacheReadInputTokens + result.cacheCreationInputTokens) {
    throw new Error('counted-input-mismatch');
  }
  return result as Record<typeof COUNTED_INPUT_FIELDS[number], number>;
}

export function usageEvidence(value: unknown) {
  const usage = exactObject(value, [
    'inputTokens', 'baseInputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens',
    'cacheCreation5mInputTokens', 'cacheCreation1hInputTokens', 'outputTokens', 'reasoningTokens',
    'totalTokens', 'costMicros',
  ]);
  const result = {
    ...countedInput(usage), outputTokens: integer(usage.outputTokens), reasoningTokens: integer(usage.reasoningTokens),
    totalTokens: integer(usage.totalTokens), costMicros: integer(usage.costMicros),
  };
  if (result.totalTokens !== result.inputTokens + result.outputTokens + result.reasoningTokens) throw new Error('inexact-usage');
  return result;
}

export function sameCountedInput(left: unknown, right: unknown) {
  try {
    return JSON.stringify(countedInput(left)) === JSON.stringify(countedInput(right));
  } catch {
    return false;
  }
}

export function usageCostMicros(usage: unknown, rates: unknown) {
  const input = usageEvidence(usage);
  const prices = exactObject(rates, RATE_FIELDS);
  const cost = input.baseInputTokens * integer(prices.inputMicrosPerToken)
    + input.cacheReadInputTokens * integer(prices.cacheReadMicrosPerToken)
    + input.cacheCreation5mInputTokens * integer(prices.cacheCreation5mMicrosPerToken)
    + input.cacheCreation1hInputTokens * integer(prices.cacheCreation1hMicrosPerToken)
    + input.outputTokens * integer(prices.outputMicrosPerToken)
    + input.reasoningTokens * integer(prices.reasoningMicrosPerToken);
  if (!Number.isSafeInteger(cost)) throw new Error('usage-cost-overflow');
  return cost;
}
