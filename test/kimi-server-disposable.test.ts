import { describe, expect, it } from 'vitest';
import { runDisposableProbe } from '../tools/kimi-server-spike/probe.js';

const disposable = process.env.HIVE_KIMI_SERVER_DISPOSABLE === '1';
const describeDisposable = disposable ? describe : describe.skip;

describeDisposable('pinned Kimi Server 2.5.3 in a disposable home', () => {
  it('owns its isolated home and returns only fixed evidence', async () => {
    const binary = process.env.HIVE_KIMI_SERVER_BIN;
    if (binary !== '/usr/local/bin/kimi-real') {
      throw new Error('HIVE_KIMI_SERVER_BIN must be /usr/local/bin/kimi-real');
    }
    const previousSecret = process.env.MOONSHOT_API_KEY;
    process.env.MOONSHOT_API_KEY = 'synthetic-secret';
    try {
      const report = await runDisposableProbe({
        binary,
        optIn: process.env.HIVE_KIMI_SERVER_DISPOSABLE,
      });

      expect(report).toEqual({
        schemaVersion: 1,
        status: 'completed',
        version: '2.5.3',
        server: {
          origin: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
          openApiSchema: expect.stringMatching(/^3\.\d+\.\d+$/),
          openApiHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        generationRequests: 0,
        counts: { sessions: 0, messages: 0 },
        capabilities: { generation: 'generation-dependent-unverified' },
      });
      const exported = JSON.stringify(report);
      expect(exported).not.toContain('synthetic-secret');
      expect(exported).not.toContain(binary);
    } finally {
      if (previousSecret === undefined) delete process.env.MOONSHOT_API_KEY;
      else process.env.MOONSHOT_API_KEY = previousSecret;
    }
  }, 45_000);
});
