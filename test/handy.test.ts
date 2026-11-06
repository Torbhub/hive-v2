import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHandyServer,
  HANDY_MAX_WAV_BYTES,
  transcribeWithHandy,
} from '../src/handy.js';

const ORIGIN = 'https://nexus.dexima.ai';
const TOKEN = 'test-pairing-token-with-32-bytes';
const WAV_HEADER_BYTES = 44;

function wav(seconds = 1): Buffer {
  const samples = Math.round(seconds * 16_000);
  const dataBytes = samples * 2;
  const out = Buffer.alloc(WAV_HEADER_BYTES + dataBytes);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + dataBytes, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16_000, 24);
  out.writeUInt32LE(32_000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(dataBytes, 40);
  return out;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

async function bridge(overrides: {
  transcribe?: (audio: Buffer) => Promise<string>;
  check?: () => Promise<void>;
} = {}) {
  const server = createHandyServer({
    origin: ORIGIN,
    token: TOKEN,
    transcribe: overrides.transcribe ?? (async () => 'fake transcript'),
    check: overrides.check ?? (async () => {}),
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, server };
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { origin: ORIGIN, authorization: `Bearer ${TOKEN}`, ...extra };
}

describe('Handy loopback bridge', () => {
  it('allows only the configured origin and a valid bearer token', async () => {
    const { base } = await bridge();
    const ok = await fetch(`${base}/health`, { headers: headers() });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(ok.headers.get('cache-control')).toBe('no-store');

    const cross = await fetch(`${base}/health`, { headers: headers({ origin: 'https://evil.example' }) });
    expect(cross.status).toBe(403);
    expect(cross.headers.get('access-control-allow-origin')).toBeNull();
    expect((await cross.json()).detail).toBe('cross-origin request');

    const wrongToken = await fetch(`${base}/health`, {
      headers: headers({ authorization: 'Bearer wrong-token' }),
    });
    expect(wrongToken.status).toBe(401);
    expect((await wrongToken.json()).detail).toBe('authentication failed');
  });

  it('answers private-network preflight only for the configured origin', async () => {
    const { base } = await bridge();
    const preflight = await fetch(`${base}/transcribe`, {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
        'access-control-request-private-network': 'true',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(preflight.headers.get('access-control-allow-private-network')).toBe('true');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization');

    const cross = await fetch(`${base}/transcribe`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(cross.status).toBe(403);
  });

  it('transcribes a valid WAV through the fake engine without retaining a request body', async () => {
    const transcribe = vi.fn(async (audio: Buffer) => {
      expect(audio.equals(wav())).toBe(true);
      return 'operator review required';
    });
    const { base } = await bridge({ transcribe });
    const response = await fetch(`${base}/transcribe`, {
      method: 'POST',
      headers: headers({ 'content-type': 'audio/wav' }),
      body: wav(),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, text: 'operator review required' });
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it('rejects wrong content, malformed WAV, and oversized audio', async () => {
    const transcribe = vi.fn(async () => 'must not run');
    const { base } = await bridge({ transcribe });
    const wrongType = await fetch(`${base}/transcribe`, {
      method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: '{}',
    });
    expect(wrongType.status).toBe(415);

    const malformed = await fetch(`${base}/transcribe`, {
      method: 'POST', headers: headers({ 'content-type': 'audio/wav' }), body: Buffer.from('not a wav'),
    });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).detail).toBe('invalid WAV audio');

    const tooLarge = Buffer.alloc(HANDY_MAX_WAV_BYTES + 1);
    const oversized = await fetch(`${base}/transcribe`, {
      method: 'POST', headers: headers({ 'content-type': 'audio/wav' }), body: tooLarge,
    });
    expect(oversized.status).toBe(413);
    expect((await oversized.json()).detail).toBe('audio exceeds the size limit');
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('accepts 60 seconds and rejects audio over 60 seconds', async () => {
    const { base } = await bridge();
    const accepted = await fetch(`${base}/transcribe`, {
      method: 'POST', headers: headers({ 'content-type': 'audio/wav' }), body: wav(60),
    });
    expect(accepted.status).toBe(200);
    const rejected = await fetch(`${base}/transcribe`, {
      method: 'POST', headers: headers({ 'content-type': 'audio/wav' }), body: wav(61),
    });
    expect(rejected.status).toBe(413);
  });

  it('runs one transcription at a time', async () => {
    let release: ((text: string) => void) | undefined;
    const transcribe = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    const { base } = await bridge({ transcribe });
    const request = () => fetch(`${base}/transcribe`, {
      method: 'POST', headers: headers({ 'content-type': 'audio/wav' }), body: wav(),
    });
    const first = request();
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    const second = await request();
    expect(second.status).toBe(429);
    expect((await second.json()).detail).toBe('another transcription is running');
    release!('first result');
    expect((await first).status).toBe(200);
  });

  it('returns generic unavailable and failure responses without engine details', async () => {
    const unavailable = await bridge({ check: async () => { throw new Error('/private/handy path'); } });
    const health = await fetch(`${unavailable.base}/health`, { headers: headers() });
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({ ok: false, detail: 'Handy is unavailable' });

    const failure = await bridge({ transcribe: async () => { throw new Error('sensitive transcript and path'); } });
    const response = await fetch(`${failure.base}/transcribe`, {
      method: 'POST', headers: headers({ 'content-type': 'audio/wav' }), body: wav(),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, detail: 'Handy transcription failed' });
  });
});

describe('Handy CLI adapter', () => {
  it('uses the headless JSON CLI, strips ambient credentials, and removes temporary audio', async () => {
    const tempRoot = await fs.mkdtemp(path.join(tmpdir(), 'hive-handy-test-'));
    let audioPath = '';
    const runner = vi.fn(async (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      expect(command).toBe('/opt/handy/handy');
      audioPath = args[1];
      expect(args).toEqual(['--transcribe-file', audioPath, '--json']);
      expect((await fs.readFile(audioPath)).equals(wav())).toBe(true);
      expect(options.env.PATH).toBe('/usr/bin');
      expect(options.env.HOME).not.toBe('/home/operator');
      expect(options.env.RUST_LOG).toBe('off');
      expect(options.env.HANDY_TRANSCRIBE_WORKER_LOG).toBe('off');
      expect(options.env.XDG_CONFIG_HOME).toContain('hive-handy-');
      expect(options.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(options.env.HIVE_WEB_SECRET).toBeUndefined();
      expect(options.env.NEXUS_PUSH_TOKEN).toBeUndefined();
      return JSON.stringify({ text: 'fake engine output', audio_secs: 1 });
    });
    const text = await transcribeWithHandy(wav(), {
      handyPath: '/opt/handy/handy',
      tempRoot,
      runner,
      env: {
        PATH: '/usr/bin', HOME: '/home/operator', AWS_SECRET_ACCESS_KEY: 'secret',
        HIVE_WEB_SECRET: 'secret', NEXUS_PUSH_TOKEN: 'secret',
      },
    });
    expect(text).toBe('fake engine output');
    expect(audioPath).not.toBe('');
    await expect(fs.stat(audioPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(tempRoot))).toEqual([]);
    await fs.rm(tempRoot, { recursive: true });
  });

  it('cleans temporary audio after an engine failure and never returns stderr', async () => {
    const tempRoot = await fs.mkdtemp(path.join(tmpdir(), 'hive-handy-test-'));
    let audioPath = '';
    const runner = vi.fn(async (_command: string, args: string[]) => {
      audioPath = args[1];
      throw new Error('stderr with sensitive transcript');
    });
    await expect(transcribeWithHandy(wav(), {
      handyPath: '/opt/handy/handy', tempRoot, runner, env: {},
    })).rejects.toThrow('Handy transcription failed');
    await expect(fs.stat(audioPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(tempRoot))).toEqual([]);
    await fs.rm(tempRoot, { recursive: true });
  });
});
