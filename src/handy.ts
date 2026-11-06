import { execFile } from 'node:child_process';
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
  'TEMP', 'TMP', 'TMPDIR',
] as const;

export type HandyRunner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number },
) => Promise<string>;

type HandyOptions = {
  handyPath?: string;
  env?: NodeJS.ProcessEnv;
  runner?: HandyRunner;
};

type HandyServerOptions = HandyOptions & {
  origin: string;
  token: string;
  transcribe?: (audio: Buffer) => Promise<string>;
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
}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...options, shell: false, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
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
  tempRoot?: string;
} = {}): Promise<string> {
  validateWav(audio);
  const directory = await fs.mkdtemp(path.join(options.tempRoot ?? tmpdir(), 'hive-handy-'));
  const audioPath = path.join(directory, 'recording.wav');
  try {
    await fs.chmod(directory, 0o700);
    await fs.writeFile(audioPath, audio, { mode: 0o600, flag: 'wx' });
    const runner = options.runner ?? runProcess;
    const stdout = await runner(options.handyPath ?? 'handy', ['--transcribe-file', audioPath, '--json'], {
      env: cleanEnvironment(options.env ?? process.env),
      timeout: HANDY_TIMEOUT_MS,
      maxBuffer: HANDY_OUTPUT_CAP,
    });
    let result: unknown;
    try {
      result = JSON.parse(stdout);
    } catch {
      throw new Error('invalid Handy response');
    }
    const text = (result as { text?: unknown })?.text;
    if (typeof text !== 'string' || text.length > TRANSCRIPT_CAP) throw new Error('invalid Handy response');
    return text;
  } catch {
    throw new Error('Handy transcription failed');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function checkHandy(options: HandyOptions = {}): Promise<void> {
  try {
    const runner = options.runner ?? runProcess;
    const stdout = await runner(options.handyPath ?? 'handy', ['--list-models', '--json'], {
      env: cleanEnvironment(options.env ?? process.env),
      timeout: 15_000,
      maxBuffer: HANDY_OUTPUT_CAP,
    });
    const models = JSON.parse(stdout) as { is_downloaded?: unknown }[];
    if (!Array.isArray(models) || !models.some((model) => model.is_downloaded === true)) throw new Error('no model');
  } catch {
    throw new Error('Handy is unavailable');
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
  res.writeHead(status, origin ? responseHeaders(origin) : {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(value));
}

function checkRequest(req: http.IncomingMessage, server: http.Server, origin: string): void {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new BridgeError(403, 'cross-origin request');
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

export function createHandyServer(options: HandyServerOptions): http.Server {
  const parsedOrigin = new URL(options.origin);
  if (!['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.origin !== options.origin) {
    throw new Error('Handy bridge origin must be an exact HTTP origin without a path');
  }
  if (options.token.length < 32) throw new Error('Handy bridge token must contain at least 32 characters');
  const transcribe = options.transcribe ?? ((audio: Buffer) => transcribeWithHandy(audio, options));
  const check = options.check ?? (() => checkHandy(options));
  let busy = false;
  const server = http.createServer((req, res) => {
    void (async () => {
      checkRequest(req, server, options.origin);
      const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (req.method === 'OPTIONS') {
        if (!['/health', '/transcribe'].includes(pathname)) throw new BridgeError(404, 'not found');
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
      if (pathname !== '/transcribe') throw new BridgeError(404, 'not found');
      if (req.method !== 'POST') throw new BridgeError(405, 'POST only');
      if (busy) throw new BridgeError(429, 'another transcription is running');
      if (req.headers['content-type']?.split(';')[0].trim() !== 'audio/wav') {
        throw new BridgeError(415, 'audio/wav is required');
      }
      busy = true;
      try {
        const audio = await readAudio(req);
        const text = await transcribe(audio);
        if (text.length > TRANSCRIPT_CAP) throw new Error('transcript too long');
        send(res, 200, { ok: true, text }, options.origin);
      } finally {
        busy = false;
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
