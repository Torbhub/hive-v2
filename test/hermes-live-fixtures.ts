import { smokePolicyHash } from '../tools/hermes-live/policy.js';
import type { HiveControlEvidence } from '../tools/hermes-live/broker.js';

export const attestation = {
  contractVersion: 1,
  route: 'teamkimi',
  messagesPath: '/v1/messages',
  model: 'kimi-code/k3.1-pro',
  source: 'synthetic-only',
  effectiveAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2030-01-01T00:00:00.000Z',
  evidenceHash: 'c'.repeat(64),
  rates: {
    inputMicrosPerToken: 1, outputMicrosPerToken: 2, reasoningMicrosPerToken: 3,
    cacheReadMicrosPerToken: 1, cacheCreation5mMicrosPerToken: 2, cacheCreation1hMicrosPerToken: 3,
  },
  providerSemantics: {
    maxTokens: 'independent-output-ceiling',
    thinking: 'independent-reasoning-ceiling',
    usage: 'messages-total-input-output-reasoning-v1',
  },
};
export const policyHash = smokePolicyHash(attestation);
export const counted = {
  inputTokens: 10, baseInputTokens: 2, cacheReadInputTokens: 3,
  cacheCreationInputTokens: 5, cacheCreation5mInputTokens: 1, cacheCreation1hInputTokens: 4,
};
export const usage = { ...counted, outputTokens: 20, reasoningTokens: 30, totalTokens: 60, costMicros: 149 };
export const wireCounted = {
  inputTokens: 10, baseInputTokens: 10, cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0, cacheCreation5mInputTokens: 0, cacheCreation1hInputTokens: 0,
};
export const wireUsage = { ...wireCounted, outputTokens: 20, reasoningTokens: 30, totalTokens: 60, costMicros: 140 };
export const matrixUsage = {
  inputTokens: 3, baseInputTokens: 1, cacheReadInputTokens: 1,
  cacheCreationInputTokens: 1, cacheCreation5mInputTokens: 1, cacheCreation1hInputTokens: 0,
  outputTokens: 2, reasoningTokens: 1, totalTokens: 6, costMicros: 11,
};

export function controls(): HiveControlEvidence {
  return {
    credential: { smokeOnly: true, shortLived: true, isolatedFromHermes: true },
    isolation: {
      disposable: true, readOnlyFixtures: true, confinedWorkingDirectories: true,
      noPrivilegedMode: true, noHostNetwork: true, noHostPid: true,
      noContainerSockets: true, noCredentialMounts: true, noWritableHostPaths: true,
      noOnDemandInstalls: true, coreDumpsDisabled: true, debuggingDisabled: true,
    },
    egress: {
      defaultDeny: true, approvedDestination: true, directIpDenied: true,
      unapprovedDnsDenied: true, redirectDenied: true, ipv6Denied: true,
      alternatePortDenied: true, metadataDenied: true,
    },
  };
}
