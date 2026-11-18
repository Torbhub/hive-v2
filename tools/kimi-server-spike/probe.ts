import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const MAX_KIMI_RESPONSE_BYTES = 1024 * 1024;

const DIRECT_BINARY = '/usr/local/bin/kimi-real';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

interface ProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface DisposableProbeOptions {
  binary: string;
  optIn: string | undefined;
}

function loopbackOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('loopback-required');
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === ''
    || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== ''
    || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('loopback-required');
  }
  return url.origin;
}

export function createProbeEvidence(server: {
  origin: string;
  openApiSchema: string;
  openApiHash: string;
}) {
  return {
    schemaVersion: 1,
    status: 'completed',
    version: '2.5.3',
    server,
    generationRequests: 0,
    counts: { sessions: 0, messages: 0 },
    capabilities: { generation: 'generation-dependent-unverified' },
  };
}

export function parseKimiServerReadyOutput(output: string): { origin: string; token: string } {
  const match = /^[ \t]*Local:[ \t]+(http:\/\/127\.0\.0\.1:\d+)\/#token=([A-Za-z0-9_-]{43})[ \t]*$/m.exec(output);
  if (!match || !TOKEN.test(match[2]!)) throw new Error('kimi-server-ready-not-found');
  return { origin: loopbackOrigin(match[1]!), token: match[2]! };
}

export function parseOpenApiDocument(source: string): { schema: string } {
  if (Buffer.byteLength(source, 'utf8') > MAX_KIMI_RESPONSE_BYTES) throw new Error('oversized-openapi');
  let document: unknown;
  try {
    document = JSON.parse(source);
  } catch {
    throw new Error('malformed-openapi');
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)
    || !('openapi' in document) || typeof document.openapi !== 'string'
    || !/^3\.\d+\.\d+$/.test(document.openapi) || !('paths' in document)
    || typeof document.paths !== 'object' || document.paths === null || Array.isArray(document.paths)) {
    throw new Error('malformed-openapi');
  }
  return { schema: document.openapi };
}

async function readLimitedText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_KIMI_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('oversized-openapi');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export async function fetchOpenApiDocument(
  origin: string,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<{ schema: string; openApiHash: string }> {
  if (!TOKEN.test(token)) throw new Error('kimi-server-token-required');
  let response: Response;
  try {
    response = await fetcher(`${loopbackOrigin(origin)}/openapi.json`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error('openapi-fetch-failed');
  }
  if (response.status >= 300 && response.status < 400) throw new Error('openapi-redirect');
  if (!response.ok) throw new Error('openapi-http-failure');
  let source: string;
  try {
    source = await readLimitedText(response);
  } catch (error) {
    if (error instanceof Error && error.message === 'oversized-openapi') throw error;
    throw new Error('malformed-openapi');
  }
  return {
    ...parseOpenApiDocument(source),
    openApiHash: createHash('sha256').update(source).digest('hex'),
  };
}

export function createDisposableEnvironment(
  home: string,
  optIn: string | undefined,
  inherited: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  if (optIn !== '1') throw new Error('disposable-opt-in-required');
  const isolated = resolve(home);
  if (dirname(isolated) !== resolve(tmpdir()) || !basename(isolated).startsWith('kimi-server-spike-')) {
    throw new Error('isolated-home-required');
  }
  return {
    HOME: isolated,
    KIMI_CODE_HOME: isolated,
    PATH: inherited.PATH ?? '/usr/local/bin:/usr/bin:/bin',
  };
}

export function spawnProcessGroup(command: string, args: string[], options: ProcessOptions): ChildProcess {
  return spawn(command, args, {
    ...options,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

export async function waitForProcessExit(child: ChildProcess, waitDeadlineMs = 5000): Promise<void> {
  if (!Number.isFinite(waitDeadlineMs) || waitDeadlineMs <= 0) throw new Error('invalid-process-deadline');
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onExit = () => { cleanup(); resolveExit(); };
    const onError = () => { cleanup(); reject(new Error('kimi-process-failed')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('process-exit-timeout')); }, waitDeadlineMs);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function processGroupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw new Error('process-group-liveness-failed');
  }
}

async function waitForProcessGroupExit(pgid: number, waitDeadlineMs: number): Promise<void> {
  if (!Number.isFinite(waitDeadlineMs) || waitDeadlineMs <= 0) throw new Error('invalid-process-deadline');
  const deadline = Date.now() + waitDeadlineMs;
  while (processGroupExists(pgid)) {
    if (Date.now() >= deadline) throw new Error('process-exit-timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) throw new Error('process-signal-failed');
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('process-signal-failed');
  }
}

export async function stopProcessGroup(
  child: ChildProcess,
  options: { termGraceMs?: number; waitDeadlineMs?: number } = {},
): Promise<void> {
  const termGraceMs = options.termGraceMs ?? 1000;
  const waitDeadlineMs = options.waitDeadlineMs ?? 5000;
  try {
    if (process.platform !== 'win32') {
      if (child.pid === undefined || !processGroupExists(child.pid)) return;
      signalProcessGroup(child, 'SIGTERM');
      try {
        await waitForProcessGroupExit(child.pid, termGraceMs);
        return;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'process-exit-timeout') throw error;
      }
      signalProcessGroup(child, 'SIGKILL');
      await waitForProcessGroupExit(child.pid, waitDeadlineMs);
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    signalProcessGroup(child, 'SIGTERM');
    try {
      await waitForProcessExit(child, termGraceMs);
      return;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'process-exit-timeout') throw error;
    }
    signalProcessGroup(child, 'SIGKILL');
    await waitForProcessExit(child, waitDeadlineMs);
  } catch {
    throw new Error('process-cleanup-failed');
  }
}

export async function checkVersion(binary: string, home: string, env: NodeJS.ProcessEnv): Promise<void> {
  const child = spawnProcessGroup(binary, ['--version'], { cwd: home, env });
  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    if (output.length < 4096) output += chunk;
  });
  try {
    await waitForProcessExit(child, 10000);
    if (child.exitCode !== 0 || output.trim() !== '2.5.3') throw new Error('kimi-version-mismatch');
  } finally {
    await stopProcessGroup(child);
  }
}

export async function launchServer(binary: string, home: string, env: NodeJS.ProcessEnv) {
  const child = spawnProcessGroup(binary, ['web', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    cwd: home, env,
  });
  let output = '';
  try {
    const server = await new Promise<{ origin: string; token: string }>((resolveReady, reject) => {
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        child.off('exit', onExit);
        child.off('error', onError);
        child.stdout?.off('data', onOutput);
      };
      const onExit = () => { cleanup(); reject(new Error('kimi-server-startup-failed')); };
      const onError = () => { cleanup(); reject(new Error('kimi-process-failed')); };
      const onOutput = (chunk: Buffer) => {
        output = `${output}${chunk.toString('utf8')}`.slice(-65536);
        let parsed: { origin: string; token: string };
        try {
          parsed = parseKimiServerReadyOutput(output);
        } catch {
          return;
        }
        cleanup();
        child.stdout?.resume();
        resolveReady(parsed);
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error('kimi-server-startup-timeout')); }, 15000);
      child.once('exit', onExit);
      child.once('error', onError);
      child.stdout?.on('data', onOutput);
    });
    return { child, ...server };
  } catch (error) {
    await stopProcessGroup(child);
    throw error;
  }
}

async function assertOwnedHome(home: string, requireEmpty: boolean): Promise<void> {
  if (dirname(home) !== resolve(tmpdir()) || !basename(home).startsWith('kimi-server-spike-')) {
    throw new Error('isolated-home-required');
  }
  const details = await lstat(home).catch(() => { throw new Error('isolated-home-required'); });
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('isolated-home-required');
  if (requireEmpty && (await readdir(home)).length !== 0) throw new Error('isolated-home-required');
}

export async function runDisposableProbe(options: DisposableProbeOptions) {
  if (options.optIn !== '1') throw new Error('disposable-opt-in-required');
  if (options.binary !== DIRECT_BINARY) throw new Error('direct-kimi-binary-required');
  const home = await mkdtemp(join(tmpdir(), 'kimi-server-spike-'));
  let processCleanupFailed = false;
  try {
    await assertOwnedHome(home, true);
    const env = createDisposableEnvironment(home, options.optIn, process.env);
    await checkVersion(options.binary, home, env);
    await assertOwnedHome(home, false);
    const server = await launchServer(options.binary, home, env);
    try {
      const openApi = await fetchOpenApiDocument(server.origin, server.token);
      return createProbeEvidence({
        origin: server.origin,
        openApiSchema: openApi.schema,
        openApiHash: openApi.openApiHash,
      });
    } finally {
      await stopProcessGroup(server.child);
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'process-cleanup-failed') processCleanupFailed = true;
    throw error;
  } finally {
    if (!processCleanupFailed) {
      await assertOwnedHome(home, false);
      await rm(home, { recursive: true, force: true });
    }
  }
}
