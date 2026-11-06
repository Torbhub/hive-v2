import { describe, expect, it } from 'vitest';
import { smokeAttestation, smokePolicyHash } from '../tools/hermes-live/policy.js';
import { attestation, policyHash } from './hermes-live-fixtures.js';

function mutated(path: string[], value: unknown) {
  const changed = structuredClone(attestation);
  let target = changed;
  for (const key of path.slice(0, -1)) target = target[key];
  target[path.at(-1)!] = value;
  return changed;
}

describe('T01 attestation contract', () => {
  it('accepts the reviewed attestation and safe-integer boundary with a canonical hash', () => {
    expect(smokePolicyHash(attestation)).toBe(policyHash);
    expect(() => smokeAttestation(mutated(['rates', 'inputMicrosPerToken'], Number.MAX_SAFE_INTEGER))).not.toThrow();
  });

  it.each([
    ['boolean contract version', ['contractVersion'], true],
    ['unsafe-integer rate', ['rates', 'inputMicrosPerToken'], Number.MAX_SAFE_INTEGER + 1],
    ['negative rate', ['rates', 'outputMicrosPerToken'], -1],
    ['wrong model', ['model'], 'other'],
    ['invented semantics', ['providerSemantics', 'thinking'], 'invented'],
  ])('rejects %s', (_name, path, value) => {
    expect(() => smokeAttestation(mutated(path, value))).toThrow();
  });
});
