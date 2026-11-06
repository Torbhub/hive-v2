import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const HANDY_PORT = 7685;
export const HANDY_MAX_SECONDS = 60;
export const HANDY_MAX_WAV_BYTES = 44 + HANDY_MAX_SECONDS * 16_000 * 2;

const HANDY_TIMEOUT_MS = 120_000;
const HANDY_OUTPUT_CAP = 64 * 1024;
const TRANSCRIPT_CAP = 16_000;
const ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'CUDA_PATH', 'VULKAN_SDK',
  'SYSTEMROOT', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'TEMP', 'TMP', 'TMPDIR', 'HF_HOME',
] as const;

export type HandyRunner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; signal?: AbortSignal },
) => Promise<string>;

type HandyOptions = {
  handyPath?: string;
  env?: NodeJS.ProcessEnv;
  runner?: HandyRunner;
  tempRoot?: string;
  remove?: (directory: string) => Promise<void>;
};

class HandyTerminationError extends Error {}

class HandyCleanupError extends Error {}

type HandyServerOptions = HandyOptions & {
  origin: string;
  token: string;
  transcribe?: (audio: Buffer, signal: AbortSignal) => Promise<string>;
  check?: () => Promise<void>;
};

class BridgeError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(detail);
  }
}

function cleanEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(ENV_ALLOWLIST.flatMap((name) => {
    const value = env[name];
    return value === undefined ? [] : [[name, value]];
  }));
}

function runProcess(command: string, args: string[], options: {
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
  signal?: AbortSignal;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: options.env, shell: false, windowsHide: true });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let processError: Error | null = null;
    const abort = () => { child.kill(); };
    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, options.timeout);
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > options.maxBuffer) {
        outputExceeded = true;
        abort();
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > options.maxBuffer) {
        outputExceeded = true;
        abort();
      }
    });
    child.once('error', (error) => {
      processError = error;
      if (child.pid === undefined) {
        cleanup();
        reject(error);
      }
    });
    child.once('close', (code) => {
      cleanup();
      if (processError || options.signal?.aborted || timedOut || outputExceeded || code !== 0) {
        reject(processError ?? new Error('Handy process failed'));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

type HandySandbox = { directory: string; env: NodeJS.ProcessEnv };

async function removeSandbox(directory: string, options: HandyOptions): Promise<void> {
  const remove = options.remove ?? ((target: string) => fs.rm(target, { recursive: true, force: true }));
  try {
    await remove(directory);
  } catch {
    throw new HandyCleanupError('Handy cleanup failed');
  }
}

async function resolveExecutable(command: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (command.includes('/') || command.includes('\\')) return fs.realpath(command).catch(() => null);
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const directory of (env.PATH ?? '').split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (await fs.access(candidate).then(() => true).catch(() => false)) return fs.realpath(candidate).catch(() => null);
    }
  }
  return null;
}

async function rejectPortableHandy(options: HandyOptions): Promise<void> {
  const executable = await resolveExecutable(options.handyPath ?? 'handy', options.env ?? process.env);
  if (!executable) return;
  const executableDirectory = path.dirname(executable);
  const markerPath = path.join(executableDirectory, 'portable');
  const marker = await fs.readFile(markerPath, 'utf8').catch(() => '');
  const markerExists = await fs.stat(markerPath).then(() => true).catch(() => false);
  const legacy = markerExists && await fs.stat(path.join(executableDirectory, 'Data')).then(() => true).catch(() => false);
  if (marker.trimStart().startsWith('Handy Portable Mode') || legacy) {
    throw new Error('portable Handy installations are not supported by Hive');
  }
}

function insideRepository(repository: string, candidate: string): boolean {
  const relative = path.relative(repository, candidate);
  return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function copyModelEntry(source: string, target: string, repository: string): Promise<void> {
  await fs.mkdir(target, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const sourceEntry = path.join(source, entry.name);
    const targetEntry = path.join(target, entry.name);
    if (entry.isSymbolicLink()) {
      const resolved = await fs.realpath(sourceEntry);
      if (!insideRepository(repository, resolved)) throw new Error('HF model symlink escapes its repository');
      const stat = await fs.stat(resolved);
      const copiedTarget = path.join(target, path.relative(repository, resolved));
      if (stat.isDirectory()) await copyModelEntry(resolved, copiedTarget, repository);
      else if (stat.isFile()) {
        await fs.mkdir(path.dirname(copiedTarget), { recursive: true });
        await fs.copyFile(resolved, copiedTarget);
      } else {
        throw new Error('unsupported HF model link');
      }
      await fs.symlink(path.relative(path.dirname(targetEntry), copiedTarget), targetEntry,
        process.platform === 'win32' ? (stat.isDirectory() ? 'junction' : 'file') : undefined);
    } else if (entry.isDirectory()) {
      await copyModelEntry(sourceEntry, targetEntry, repository);
    } else if (entry.isFile()) {
      await fs.copyFile(sourceEntry, targetEntry);
    } else {
      throw new Error('unsupported HF model entry');
    }
  }
}

async function copyHuggingFaceCache(directory: string, sourceEnv: NodeJS.ProcessEnv, sourceHome: string, env: NodeJS.ProcessEnv): Promise<void> {
  const source = sourceEnv.HF_HOME ?? (sourceHome ? path.join(sourceHome, '.cache', 'huggingface') : '');
  env.HF_HOME = path.join(directory, 'hf');
  if (!source) return;
  const actualHub = path.join(source, 'hub');
  const temporaryHub = path.join(env.HF_HOME, 'hub');
  await fs.mkdir(temporaryHub, { recursive: true });
  const entries = await fs.readdir(actualHub, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.name.startsWith('models--') || !entry.isDirectory()) continue;
    const repository = await fs.realpath(path.join(actualHub, entry.name));
    await copyModelEntry(repository, path.join(temporaryHub, entry.name), repository);
  }
}

async function createHandySandbox(options: HandyOptions): Promise<HandySandbox> {
  await rejectPortableHandy(options);
  const sourceEnv = options.env ?? process.env;
  const sourceHome = sourceEnv.HOME ?? '';
  const directory = await fs.mkdtemp(path.join(options.tempRoot ?? tmpdir(), 'hive-handy-'));
  try {
    const home = path.join(directory, 'home');
    const directories: { actual: string; temporary: string; variable?: string }[] = [];
    if (process.platform === 'win32') {
      directories.push(
        { actual: sourceEnv.APPDATA ?? path.join(sourceHome, 'AppData', 'Roaming'), temporary: path.join(directory, 'roaming'), variable: 'APPDATA' },
        { actual: sourceEnv.LOCALAPPDATA ?? path.join(sourceHome, 'AppData', 'Local'), temporary: path.join(directory, 'local'), variable: 'LOCALAPPDATA' },
      );
    } else if (process.platform === 'darwin') {
      directories.push({ actual: path.join(sourceHome, 'Library', 'Application Support'), temporary: path.join(home, 'Library', 'Application Support') });
    } else {
      directories.push(
        { actual: sourceEnv.XDG_CONFIG_HOME ?? path.join(sourceHome, '.config'), temporary: path.join(directory, 'config'), variable: 'XDG_CONFIG_HOME' },
        { actual: sourceEnv.XDG_DATA_HOME ?? path.join(sourceHome, '.local', 'share'), temporary: path.join(directory, 'data'), variable: 'XDG_DATA_HOME' },
      );
    }
    const env = cleanEnvironment(sourceEnv);
    env.HOME = home;
    env.RUST_LOG = 'off';
    env.HANDY_TRANSCRIBE_WORKER_LOG = 'off';
    env.TEMP = directory;
    env.TMP = directory;
    env.TMPDIR = directory;
    for (const item of directories) {
      if (item.variable) env[item.variable] = item.temporary;
      const actualApp = path.join(item.actual, 'com.pais.handy');
      const temporaryApp = path.join(item.temporary, 'com.pais.handy');
      await fs.mkdir(temporaryApp, { recursive: true });
      const models = path.join(actualApp, 'models');
      if (await fs.stat(models).then((stat) => stat.isDirectory()).catch(() => false)) {
        await fs.symlink(models, path.join(temporaryApp, 'models'), process.platform === 'win32' ? 'junction' : 'dir');
      }
      const settings = path.join(actualApp, 'settings_store.json');
      if (await fs.stat(settings).then((stat) => stat.isFile()).catch(() => false)) {
        await fs.copyFile(settings, path.join(temporaryApp, 'settings_store.json'));
        await fs.chmod(path.join(temporaryApp, 'settings_store.json'), 0o600);
      }
    }
    await copyHuggingFaceCache(directory, sourceEnv, sourceHome, env);
    if (process.platform === 'linux') env.XDG_CACHE_HOME = path.join(directory, 'cache');
    await fs.mkdir(home, { recursive: true });
    return { directory, env };
  } catch (error) {
    await removeSandbox(directory, options);
    throw error;
  }
}

function validateWav(audio: Buffer): void {
  if (audio.length > HANDY_MAX_WAV_BYTES) throw new BridgeError(413, 'audio exceeds the size limit');
  if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
    throw new BridgeError(400, 'invalid WAV audio');
  }
  let format = false;
  let samples = 0;
  let offset = 12;
  while (offset + 8 <= audio.length) {
    const chunkSize = audio.readUInt32LE(offset + 4);
    const body = offset + 8;
    const end = body + chunkSize;
    if (end > audio.length) throw new BridgeError(400, 'invalid WAV audio');
    const kind = audio.toString('ascii', offset, offset + 4);
    if (kind === 'fmt ') {
      if (chunkSize < 16 || audio.readUInt16LE(body) !== 1 || audio.readUInt16LE(body + 2) !== 1
        || audio.readUInt32LE(body + 4) !== 16_000 || audio.readUInt16LE(body + 14) !== 16) {
        throw new BridgeError(400, 'invalid WAV audio');
      }
      format = true;
    }
    if (kind === 'data') samples = chunkSize / 2;
    offset = end + (chunkSize % 2);
  }
  if (!format || !Number.isInteger(samples) || samples <= 0 || samples > HANDY_MAX_SECONDS * 16_000) {
    throw new BridgeError(samples > HANDY_MAX_SECONDS * 16_000 ? 413 : 400,
      samples > HANDY_MAX_SECONDS * 16_000 ? 'audio exceeds the duration limit' : 'invalid WAV audio');
  }
}

export async function transcribeWithHandy(audio: Buffer, options: HandyOptions & {
  signal?: AbortSignal;
} = {}): Promise<string> {
  validateWav(audio);
  const sandbox = await createHandySandbox(options);
  const audioPath = path.join(sandbox.directory, 'recording.wav');
  try {
    await fs.chmod(sandbox.directory, 0o700);
    await fs.writeFile(audioPath, audio, { mode: 0o600, flag: 'wx' });
    const runner = options.runner ?? runProcess;
    const stdout = await runner(options.handyPath ?? 'handy', ['--transcribe-file', audioPath, '--json'], {
      env: sandbox.env,
      timeout: HANDY_TIMEOUT_MS,
      maxBuffer: HANDY_OUTPUT_CAP,
      signal: options.signal,
    });
    if (options.signal?.aborted) throw new HandyTerminationError('Handy returned after cancellation');
    let result: unknown;
    try {
      result = JSON.parse(stdout);
    } catch {
      throw new Error('invalid Handy response');
    }
    const text = (result as { text?: unknown })?.text;
    if (typeof text !== 'string' || text.length > TRANSCRIPT_CAP) throw new Error('invalid Handy response');
    return text;
  } catch (error) {
    if (error instanceof HandyTerminationError || error instanceof HandyCleanupError) throw error;
    throw new Error('Handy transcription failed');
  } finally {
    await removeSandbox(sandbox.directory, options);
  }
}

async function checkHandy(options: HandyOptions = {}): Promise<void> {
  const sandbox = await createHandySandbox(options);
  try {
    const runner = options.runner ?? runProcess;
    const stdout = await runner(options.handyPath ?? 'handy', ['--list-models', '--json'], {
      env: sandbox.env,
      timeout: 15_000,
      maxBuffer: HANDY_OUTPUT_CAP,
    });
    const models = JSON.parse(stdout) as { is_downloaded?: unknown }[];
    if (!Array.isArray(models) || !models.some((model) => model.is_downloaded === true)) throw new Error('no model');
  } catch {
    throw new Error('Handy is unavailable');
  } finally {
    await removeSandbox(sandbox.directory, options);
  }
}

function authorized(header: string | undefined, token: string): boolean {
  const expected = `Bearer ${token}`;
  if (header === undefined || header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

function responseHeaders(origin: string): Record<string, string> {
  return {
    'access-control-allow-origin': origin,
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'vary': 'Origin',
    'x-content-type-options': 'nosniff',
  };
}

function send(res: http.ServerResponse, status: number, value: unknown, origin?: string): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, origin ? responseHeaders(origin) : {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(value));
}

function checkRequest(req: http.IncomingMessage, server: http.Server, origin: string): void {
  if (req.headers.origin !== origin) throw new BridgeError(403, 'cross-origin request');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new BridgeError(503, 'bridge is not listening');
  try {
    const host = new URL(`http://${req.headers.host ?? ''}`);
    if (!['127.0.0.1', 'localhost'].includes(host.hostname) || host.port !== String(address.port)) throw new Error();
  } catch {
    throw new BridgeError(403, 'invalid loopback host');
  }
}

async function readAudio(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > HANDY_MAX_WAV_BYTES) throw new BridgeError(413, 'audio exceeds the size limit');
    chunks.push(buffer);
  }
  const audio = Buffer.concat(chunks);
  validateWav(audio);
  return audio;
}

function watchDisconnect(req: http.IncomingMessage, res: http.ServerResponse, controller: AbortController): () => void {
  let finished = false;
  const abort = () => { if (!finished) controller.abort(); };
  const finish = () => { finished = true; };
  req.once('aborted', abort);
  res.once('finish', finish);
  res.once('close', abort);
  return () => {
    req.removeListener('aborted', abort);
    res.removeListener('finish', finish);
    res.removeListener('close', abort);
  };
}

export function createHandyServer(options: HandyServerOptions): http.Server {
  const parsedOrigin = new URL(options.origin);
  if (!['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.origin !== options.origin) {
    throw new Error('Handy bridge origin must be an exact HTTP origin without a path');
  }
  if (options.token.length < 32) throw new Error('Handy bridge token must contain at least 32 characters');
  const transcribe = options.transcribe ?? ((audio: Buffer, signal: AbortSignal) => transcribeWithHandy(audio, { ...options, signal }));
  const check = options.check ?? (() => checkHandy(options));
  let activeJob: { controller: AbortController; done: Promise<boolean>; cleanupFailed: boolean } | null = null;
  const server = http.createServer((req, res) => {
    void (async () => {
      checkRequest(req, server, options.origin);
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (req.method === 'OPTIONS') {
        if (!['/health', '/transcribe', '/cancel'].includes(pathname)) throw new BridgeError(404, 'not found');
        res.writeHead(204, {
          ...responseHeaders(options.origin),
          'access-control-allow-headers': 'authorization, content-type',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-max-age': '0',
          ...(req.headers['access-control-request-private-network'] === 'true'
            ? { 'access-control-allow-private-network': 'true' } : {}),
        });
        res.end();
        return;
      }
      if (!authorized(req.headers.authorization, options.token)) throw new BridgeError(401, 'authentication failed');
      if (pathname === '/health' && req.method === 'GET') {
        await check();
        send(res, 200, { ok: true }, options.origin);
        return;
      }
      if (pathname === '/cancel' && req.method === 'POST') {
        const job = activeJob;
        if (job) {
          job.controller.abort();
          if (await job.done) {
            send(res, 500, { ok: false, detail: 'Handy cleanup failed' }, options.origin);
            return;
          }
        }
        send(res, 200, { ok: true }, options.origin);
        return;
      }
      if (pathname !== '/transcribe') throw new BridgeError(404, 'not found');
      if (req.method !== 'POST') throw new BridgeError(405, 'POST only');
      if (activeJob) throw new BridgeError(429, 'another transcription is running');
      if (req.headers['content-type']?.split(';')[0].trim() !== 'audio/wav') {
        throw new BridgeError(415, 'audio/wav is required');
      }
      const controller = new AbortController();
      let finishJob!: (cleanupFailed: boolean) => void;
      const done = new Promise<boolean>((resolve) => { finishJob = resolve; });
      const job = { controller, done, cleanupFailed: false };
      activeJob = job;
      const stopWatching = watchDisconnect(req, res, controller);
      try {
        const audio = await readAudio(req);
        const text = await transcribe(audio, controller.signal);
        if (text.length > TRANSCRIPT_CAP) throw new Error('transcript too long');
        if (controller.signal.aborted) throw new HandyTerminationError('job completed after cancellation');
        send(res, 200, { ok: true, text }, options.origin);
      } catch (error) {
        if (error instanceof HandyTerminationError || error instanceof HandyCleanupError) job.cleanupFailed = true;
        throw error;
      } finally {
        stopWatching();
        if (!job.cleanupFailed && activeJob === job) activeJob = null;
        finishJob(job.cleanupFailed);
      }
    })().catch((error: unknown) => {
      if (error instanceof BridgeError) {
        send(res, error.status, { ok: false, detail: error.detail },
          req.headers.origin === options.origin ? options.origin : undefined);
        return;
      }
      const health = req.url === '/health';
      send(res, health ? 503 : 500,
        { ok: false, detail: health ? 'Handy is unavailable' : 'Handy transcription failed' },
        req.headers.origin === options.origin ? options.origin : undefined);
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.timeout = HANDY_TIMEOUT_MS + 10_000;
  return server;
}

function newHandyToken(): string {
  return randomBytes(32).toString('hex');
}

function listenHandyBridge(options: HandyServerOptions): Promise<http.Server> {
  const server = createHandyServer(options);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(HANDY_PORT, '127.0.0.1', () => resolve(server));
  });
}

export async function handyBridgeCommand(args: string[]): Promise<void> {
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--origin' || args[1].startsWith('--'))) {
    throw new Error('usage: hive handy-bridge [--origin URL]');
  }
  const origin = args[1] ?? 'http://127.0.0.1:7684';
  const generated = process.env.HIVE_HANDY_TOKEN === undefined;
  const token = process.env.HIVE_HANDY_TOKEN ?? newHandyToken();
  await listenHandyBridge({ origin, token, handyPath: process.env.HANDY_BIN });
  console.log(`hive: Handy bridge on http://127.0.0.1:${HANDY_PORT} for ${origin}`);
  if (generated) console.log(`hive: pairing token: ${token}`);
}
