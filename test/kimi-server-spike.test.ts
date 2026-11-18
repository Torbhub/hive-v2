import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_KIMI_RESPONSE_BYTES,
  createDisposableEnvironment,
  createProbeEvidence,
  fetchOpenApiDocument,
  parseKimiServerReadyOutput,
  parseOpenApiDocument,
  runDisposableProbe,
  spawnProcessGroup,
  stopProcessGroup,
  waitForProcessExit,
} from '../tools/kimi-server-spike/probe.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

async function waitForText(read: () => string, expected: string) {
  const deadline = Date.now() + 1000;
  while (!read().includes(expected)) {
    if (Date.now() > deadline) throw new Error('process-output-timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function spawnLeaderWithDescendant(leaderBehavior: string) {
  const descendant = `
    process.on('SIGTERM', () => {});
    process.stdout.write('descendant-ready\\n');
    setTimeout(() => process.exit(0), 2000);
  `;
  return spawnProcessGroup(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'inherit', 'ignore'] });
    ${leaderBehavior}
    process.stdout.write('leader-ready\\n');
  `], { cwd: tmpdir(), env: { PATH: process.env.PATH ?? '' } });
}

function groupExists(pid: number) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function killGroup(pid: number) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function waitForGroupExit(pid: number) {
  const deadline = Date.now() + 500;
  while (groupExists(pid)) {
    if (Date.now() > deadline) throw new Error('process-group-still-running');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('Kimi Server 2.5.3 disposable preflight', () => {
  it('returns only the fixed evidence literal', () => {
    const openApiHash = 'a'.repeat(64);
    expect(createProbeEvidence({
      origin: 'http://127.0.0.1:58627',
      openApiSchema: '3.1.0',
      openApiHash,
    })).toEqual({
      schemaVersion: 1,
      status: 'completed',
      version: '2.5.3',
      server: {
        origin: 'http://127.0.0.1:58627',
        openApiSchema: '3.1.0',
        openApiHash,
      },
      generationRequests: 0,
      counts: { sessions: 0, messages: 0 },
      capabilities: { generation: 'generation-dependent-unverified' },
    });
  });

  it('returns only the OpenAPI schema version', () => {
    expect(parseOpenApiDocument(JSON.stringify({
      openapi: '3.1.0',
      paths: { '/api/v1/healthz': { get: {} } },
    }))).toEqual({ schema: '3.1.0' });
  });

  it('rejects malformed OpenAPI JSON', () => {
    expect(() => parseOpenApiDocument('{not json')).toThrow(/malformed-openapi/);
  });

  it('rejects oversized OpenAPI JSON before parsing it', () => {
    expect(() => parseOpenApiDocument('x'.repeat(MAX_KIMI_RESPONSE_BYTES + 1))).toThrow(/oversized-openapi/);
  });

  it('parses the actual 2.5.3 Local ready line with a strict token', () => {
    const token = 'a'.repeat(43);
    const output = [
      'Kimi server ready 2.5.3',
      `Local:    http://127.0.0.1:61234/#token=${token}`,
      'Network: off',
      `Token: ${token}`,
    ].join('\n');

    expect(parseKimiServerReadyOutput(output)).toEqual({
      origin: 'http://127.0.0.1:61234',
      token,
    });
  });

  it('rejects redirects in the actual OpenAPI fetch helper', async () => {
    let init: RequestInit | undefined;
    const fetcher: typeof fetch = async (_input, requestInit) => {
      init = requestInit;
      return new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1:58628/openapi.json' },
      });
    };

    await expect(fetchOpenApiDocument(
      'http://127.0.0.1:58627',
      'a'.repeat(43),
      fetcher,
    )).rejects.toThrow(/openapi-redirect/);
    expect(init?.redirect).toBe('error');
  });

  it('rejects the TeamKimi wrapper before launch', async () => {
    await expect(runDisposableProbe({
      binary: '/usr/local/bin/kimi',
      optIn: '1',
    })).rejects.toThrow(/direct-kimi-binary-required/);
  });

  it('requires explicit opt-in before launch', async () => {
    await expect(runDisposableProbe({
      binary: '/usr/local/bin/kimi-real',
      optIn: undefined,
    })).rejects.toThrow(/disposable-opt-in-required/);
  });

  it('scrubs inherited environment values and isolates both home variables', () => {
    const home = join(tmpdir(), 'kimi-server-spike-fixture');
    expect(createDisposableEnvironment(home, '1', {
      PATH: '/usr/bin:/bin',
      HOME: '/production-home',
      KIMI_CODE_HOME: '/production-home',
      MOONSHOT_API_KEY: 'synthetic-secret',
    })).toEqual({
      HOME: home,
      KIMI_CODE_HOME: home,
      PATH: '/usr/bin:/bin',
    });
  });
});

describePosix('Kimi Server disposable process-group supervision', () => {
  it('uses a detached group and escalates from SIGTERM to SIGKILL', async () => {
    const child = spawnProcessGroup(process.execPath, ['-e', `
      process.stdout.write('ready\\n');
      process.on('SIGTERM', () => process.stdout.write('term\\n'));
      setInterval(() => {}, 1000);
    `], { cwd: tmpdir(), env: { PATH: process.env.PATH ?? '' } });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    try {
      await waitForText(() => output, 'ready');
      expect(process.kill(-child.pid!, 0)).toBe(true);
      await stopProcessGroup(child, { termGraceMs: 20, waitDeadlineMs: 500 });
      await waitForText(() => output, 'term');
      expect(child.signalCode).toBe('SIGKILL');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        await stopProcessGroup(child, { termGraceMs: 1, waitDeadlineMs: 100 }).catch(() => undefined);
      }
    }
  });

  it('escalates when the leader exits on SIGTERM but a descendant survives', async () => {
    const child = spawnLeaderWithDescendant(`
      process.on('SIGTERM', () => process.exit(0));
      setInterval(() => {}, 1000);
    `);
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    try {
      await waitForText(() => output, 'descendant-ready');
      await stopProcessGroup(child, { termGraceMs: 20, waitDeadlineMs: 500 });
      await waitForGroupExit(child.pid!);
    } finally {
      killGroup(child.pid!);
      await waitForGroupExit(child.pid!);
    }
  });

  it('cleans the detached group when the leader already exited', async () => {
    const child = spawnLeaderWithDescendant('setTimeout(() => process.exit(0), 20);');
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    try {
      await waitForText(() => output, 'descendant-ready');
      await waitForProcessExit(child, 500);
      expect(groupExists(child.pid!)).toBe(true);
      await stopProcessGroup(child, { termGraceMs: 20, waitDeadlineMs: 500 });
      await waitForGroupExit(child.pid!);
    } finally {
      killGroup(child.pid!);
      await waitForGroupExit(child.pid!);
    }
  });

  it('enforces the final process wait deadline', async () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    child.exitCode = null;
    child.signalCode = null;

    await expect(waitForProcessExit(child, 5)).rejects.toThrow(/process-exit-timeout/);
  });

  it('waits for process exit instead of inherited stdout closure', async () => {
    const child = spawnProcessGroup(process.execPath, ['-e', `
      const { spawn } = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 250)'], { stdio: 'inherit' });
      grandchild.unref();
      setTimeout(() => process.exit(0), 20);
    `], { cwd: tmpdir(), env: { PATH: process.env.PATH ?? '' } });

    await waitForProcessExit(child, 1000);
    expect(child.exitCode).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
});
