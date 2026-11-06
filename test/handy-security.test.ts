import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHandyServer, transcribeWithHandy } from '../src/handy.js';

const ORIGIN = 'https://nexus.dexima.ai';
const TOKEN = 'test-pairing-token-with-32-bytes';
const TRANSCRIPT_MARKER = 'full transcript must not survive';
const servers: Server[] = [];
const temporaryRoots: string[] = [];

function wav(): Buffer {
  const out = Buffer.alloc(44 + 32_000);
  out.write('RIFF', 0);
  out.writeUInt32LE(out.length - 8, 4);
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
  out.writeUInt32LE(out.length - 44, 40);
  return out;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { origin: ORIGIN, authorization: `Bearer ${TOKEN}`, ...extra };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'hive-handy-security-'));
  temporaryRoots.push(root);
  return root;
}

async function bridge(transcribe: (audio: Buffer, signal: AbortSignal) => Promise<string>) {
  const server = createHandyServer({ origin: ORIGIN, token: TOKEN, transcribe });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function transcribeRequest(base: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`${base}/transcribe`, {
    method: 'POST',
    headers: headers({ 'content-type': 'audio/wav', 'sec-fetch-site': 'cross-site' }),
    body: wav(),
    signal,
  });
}

describe('Nexus cross-site loopback policy', () => {
  it('allows exact-origin private-network preflight and actual requests with cross-site fetch metadata', async () => {
    const base = await bridge(async () => 'safe transcript');
    const preflight = await fetch(`${base}/transcribe`, {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'sec-fetch-site': 'cross-site',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
        'access-control-request-private-network': 'true',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(preflight.headers.get('access-control-allow-private-network')).toBe('true');

    const response = await transcribeRequest(base);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, text: 'safe transcript' });
  });

  it('still rejects a mismatched origin with cross-site metadata', async () => {
    const base = await bridge(async () => 'must not run');
    const response = await fetch(`${base}/transcribe`, {
      method: 'POST',
      headers: headers({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }),
      body: wav(),
    });
    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('transcription cancellation', () => {
  it('aborts a premature disconnect, waits for cleanup, and permits the next job', async () => {
    let firstSignal: AbortSignal | undefined;
    let cleaned = false;
    let calls = 0;
    const base = await bridge((_audio, signal) => {
      calls += 1;
      if (calls > 1) return Promise.resolve('second job');
      firstSignal = signal;
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          cleaned = true;
          reject(new Error('engine aborted'));
        }, { once: true });
      });
    });
    const client = new AbortController();
    const pending = transcribeRequest(base, client.signal);
    await vi.waitFor(() => expect(firstSignal).toBeDefined());
    client.abort();
    await expect(pending).rejects.toThrow();

    const cancelled = await fetch(`${base}/cancel`, {
      method: 'POST',
      headers: headers({ 'sec-fetch-site': 'cross-site' }),
    });
    expect(cancelled.status).toBe(200);
    expect(firstSignal!.aborted).toBe(true);
    expect(cleaned).toBe(true);

    const second = await transcribeRequest(base);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, text: 'second job' });
  });

  it('does not abort the engine after normal request completion', async () => {
    let engineSignal: AbortSignal | undefined;
    const base = await bridge((_audio, signal) => {
      engineSignal = signal;
      return Promise.resolve('complete');
    });
    const response = await transcribeRequest(base);
    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(engineSignal!.aborted).toBe(false);
  });
});

describe('Handy process and log containment', () => {
  it('deletes debug transcript logs and release metadata logs while preserving model access', async () => {
    const root = await temporaryRoot();
    const home = path.join(root, 'operator-home');
    const config = path.join(home, '.config', 'com.pais.handy');
    const data = path.join(home, '.local', 'share', 'com.pais.handy');
    await fs.mkdir(path.join(config, 'models'), { recursive: true });
    await fs.mkdir(path.join(data, 'models'), { recursive: true });
    await fs.writeFile(path.join(config, 'models', 'model.bin'), 'model');
    await fs.writeFile(path.join(data, 'models', 'model.bin'), 'model');
    await fs.writeFile(path.join(config, 'settings_store.json'), '{"selected_model":"fake"}');
    await fs.writeFile(path.join(data, 'settings_store.json'), '{"selected_model":"fake"}');
    const script = path.join(root, 'fake-handy.mjs');
    await fs.writeFile(script, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
for (const base of [process.env.XDG_CONFIG_HOME, process.env.XDG_DATA_HOME]) {
  const app = path.join(base, 'com.pais.handy');
  fs.readFileSync(path.join(app, 'settings_store.json'), 'utf8');
  fs.readFileSync(path.join(app, 'models', 'model.bin'), 'utf8');
  fs.mkdirSync(path.join(app, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(app, 'logs', 'handy.log'), '${TRANSCRIPT_MARKER}');
  fs.writeFileSync(path.join(app, 'settings_store.json'), 'changed only in sandbox');
}
console.log(JSON.stringify({ text: '${TRANSCRIPT_MARKER}' }));
`, { mode: 0o755 });

    const text = await transcribeWithHandy(wav(), {
      handyPath: script,
      tempRoot: root,
      env: { HOME: home, PATH: process.env.PATH },
    });
    expect(text).toBe(TRANSCRIPT_MARKER);
    expect(await fs.readFile(path.join(config, 'settings_store.json'), 'utf8')).toBe('{"selected_model":"fake"}');
    expect(await fs.readFile(path.join(data, 'settings_store.json'), 'utf8')).toBe('{"selected_model":"fake"}');
    expect((await fs.readdir(root)).filter((name) => name.startsWith('hive-handy-'))).toEqual([]);
  });

  it('terminates a real fake child on cancellation and removes its WAV and logs', async () => {
    const root = await temporaryRoot();
    const script = path.join(root, 'fake-handy-wait.mjs');
    await fs.writeFile(script, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const audio = process.argv[3];
const job = path.dirname(audio);
const root = path.dirname(job);
const name = path.basename(job);
process.on('SIGTERM', () => {
  fs.writeFileSync(path.join(root, name + '.terminated'), '1');
  process.exit(0);
});
fs.mkdirSync(path.join(process.env.XDG_CONFIG_HOME, 'com.pais.handy', 'logs'), { recursive: true });
fs.writeFileSync(path.join(process.env.XDG_CONFIG_HOME, 'com.pais.handy', 'logs', 'handy.log'), '${TRANSCRIPT_MARKER}');
fs.writeFileSync(path.join(root, name + '.started'), String(process.pid));
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    const controller = new AbortController();
    const pending = transcribeWithHandy(wav(), {
      handyPath: script,
      tempRoot: root,
      env: { HOME: path.join(root, 'home'), PATH: process.env.PATH },
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toThrow('Handy transcription failed');
    let started: string | undefined;
    await vi.waitFor(async () => {
      const files = await fs.readdir(root);
      started = files.find((file) => file.endsWith('.started'));
      expect(started).toBeDefined();
    });
    controller.abort();
    await rejected;
    const job = started!.slice(0, -'.started'.length);
    const pid = Number(await fs.readFile(path.join(root, `${job}.started`), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(fs.stat(path.join(root, job))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(root)).some((file) => file.endsWith('.wav'))).toBe(false);
  });
});
