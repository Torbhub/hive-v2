import http from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TeamKimiAdapter, type HiveControlEvidence } from '../tools/hermes-live/broker.js';
import { HermesProcessSupervisor } from '../tools/hermes-live/process.js';
import { EXPECTED_MODEL } from '../tools/hermes-live/runner.js';

const disposable = process.env.HIVE_T01_DISPOSABLE_HERMES === '1';
const describeDisposable = disposable ? describe : describe.skip;

function controls(): HiveControlEvidence {
  return {
    credential: { smokeOnly: true, shortLived: true, isolatedFromHermes: true },
    isolation: {
      disposable: true, readOnlyFixtures: true, confinedWorkingDirectories: true,
      noPrivilegedMode: true, noHostNetwork: true, noHostPid: true,
      noContainerSockets: true, noCredentialMounts: true, noWritableHostPaths: true,
      noOnDemandInstalls: true, coreDumpsDisabled: true, debuggingDisabled: true,
    },
    egress: {
      defaultDeny: true, approvedDestination: true, directIpDenied: true, unapprovedDnsDenied: true,
      redirectDenied: true, ipv6Denied: true, alternatePortDenied: true, metadataDenied: true,
    },
  };
}

function listen(server: http.Server) {
  return new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (typeof address === 'object' && address) resolve(address.port);
  }));
}

function close(server: http.Server) {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describeDisposable('pinned Hermes in the disposable environment', () => {
  it('canonicalizes the actual Hermes Anthropic request without a paid upstream', async () => {
    const hermes = process.env.HIVE_T01_HERMES_BIN;
    if (!hermes) throw new Error('HIVE_T01_HERMES_BIN is required');
    const workspace = await mkdtemp(join(tmpdir(), 't01-disposable-'));
    const bodies: string[] = [];
    let reservation: Record<string, unknown> | null = null;
    const upstream = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        if (request.url === '/teamkimi/smoke/status') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({
            enabled: true, admissionAllowed: true, blockedReason: null, policyHash: 'a'.repeat(64),
            pricingVerified: true, model: EXPECTED_MODEL,
            ceilings: {
              scenario: { inputTokens: 16000, outputTokens: 2000, reasoningTokens: 4000, totalTokens: 22000, costMicros: 500000 },
              matrix: { admissions: 12, inputTokens: 96000, outputTokens: 12000, reasoningTokens: 24000, totalTokens: 132000, costMicros: 5000000 },
            },
            totals: { admissions: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, costMicros: 0 },
            credentials: [{ id: '0123456789abcdef0123456789abcdef', issuedAt: Date.now() - 1000, expiresAt: Date.now() + 60000, revokedAt: null, revocationProof: null }],
            reservations: reservation ? [reservation] : [],
          }));
          return;
        }
        if (request.url === '/v1/messages') {
          bodies.push(body);
          reservation = {
            admissionId: '0123456789abcdef0123456789abcdef', scenarioId: 'P01', state: 'reconciled',
            createdAt: Date.now(), reconciledAt: Date.now(), httpStatus: null, ambiguousReason: null,
            inputVerified: true,
            reserved: { inputTokens: 10, outputTokens: 20, reasoningTokens: 30, totalTokens: 60, costMicros: 140 },
            actual: { inputTokens: 10, outputTokens: 20, reasoningTokens: 30, totalTokens: 60, costMicros: 140 },
          };
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({
            id: 'msg-t01', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'T01 fixture only.' }],
            model: EXPECTED_MODEL, stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 20, reasoning_tokens: 30, total_tokens: 60 },
          }));
          return;
        }
        response.writeHead(404).end();
      });
    });
    const upstreamPort = await listen(upstream);
    const adapter = new TeamKimiAdapter({ baseUrl: `http://127.0.0.1:${upstreamPort}`, credential: 'tcs-disposable-test', controls: controls() });
    await adapter.start();
    try {
      const admission = await adapter.admit({ scenarioId: 'P01', generation: 1, routeHash: 'a'.repeat(64), policyHash: 'b'.repeat(64) });
      const prompt = join(workspace, 'query.txt');
      await writeFile(prompt, 'Return the exact text: T01 fixture only.\n', { mode: 0o400 });
      const supervisor = new HermesProcessSupervisor();
      const handle = await supervisor.start({
        scenarioId: 'P01', command: hermes,
        args: [
          'chat', '--query-file', prompt, '--format', 'stream-json', '--model', EXPECTED_MODEL,
          '--provider', 'anthropic', '--base-url', admission.endpoint, '--api-key', 'hive-adapter-placeholder',
        ],
        cwd: workspace,
        env: {
          HOME: workspace, PATH: '/usr/local/bin:/usr/bin:/bin', HERMES_HOME: workspace,
          TEAMKIMI_OPENAI_COMPATIBLE_URL: admission.endpoint, TEAMKIMI_MODEL_ID: EXPECTED_MODEL,
        },
      }, () => undefined);
      await handle.reap();
      expect(bodies).toHaveLength(1);
      expect(JSON.parse(bodies[0])).toMatchObject({
        model: EXPECTED_MODEL, max_tokens: 2000,
        thinking: { type: 'enabled', budget_tokens: 4000 },
      });
      expect(JSON.parse(bodies[0]).reasoning_effort).toBeUndefined();
      expect(JSON.parse(bodies[0]).output_config).toBeUndefined();
      const receipt = await adapter.receipt(admission.admissionId);
      expect(receipt.status).toBe('completed');
      expect(receipt.inputVerified).toBe(true);
    } finally {
      await adapter.close();
      await close(upstream);
    }
  });
});
