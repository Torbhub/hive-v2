import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHandyServer, transcribeWithHandy, type HandyRunner } from '../src/handy.js';

const ORIGIN = 'https://nexus.dexima.ai';
const TOKEN = 'test-pairing-token-with-32-bytes';
const servers: Server[] = [];
const roots: string[] = [];

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

function headers(): Record<string, string> {
  return { origin: ORIGIN, authorization: `Bearer ${TOKEN}`, 'sec-fetch-site': 'cross-site' };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'hive-handy-containment-'));
  roots.push(directory);
  return directory;
}

async function jobDirectories(root: string): Promise<string[]> {
  return (await fs.readdir(root)).filter((name) => name.startsWith('hive-handy-'));
}

async function bridge(options: {
  runner: HandyRunner;
  tempRoot: string;
  env?: NodeJS.ProcessEnv;
  remove?: (directory: string) => Promise<void>;
}): Promise<string> {
  const server = createHandyServer({ origin: ORIGIN, token: TOKEN, ...options });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function transcribeRequest(base: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`${base}/transcribe`, {
    method: 'POST', headers: { ...headers(), 'content-type': 'audio/wav' }, body: wav(), signal,
  });
}

describe('portable Handy rejection', () => {
  it('rejects before spawn without touching Data logs or migration-sensitive settings', async () => {
    const directory = await root();
    const executable = path.join(directory, 'real-handy');
    await fs.writeFile(executable, '#!/usr/bin/env node\n', { mode: 0o755 });
    await fs.writeFile(path.join(directory, 'portable'), 'Handy Portable Mode\n');
    const data = path.join(directory, 'Data');
    await fs.mkdir(path.join(data, 'logs'), { recursive: true });
    const settings = JSON.stringify({ settings: { post_process_api_keys: { provider: 'secret' }, log_level: 2 } });
    await fs.writeFile(path.join(data, 'settings_store.json'), settings);
    await fs.writeFile(path.join(data, 'logs', 'handy.log'), 'debug transcript');
    const link = path.join(directory, 'handy-link');
    await fs.symlink(executable, link);
    const runner = vi.fn<HandyRunner>();

    await expect(transcribeWithHandy(wav(), {
      handyPath: link, tempRoot: directory, runner, env: { HOME: path.join(directory, 'home') },
    })).rejects.toThrow('portable Handy');
    expect(runner).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(data, 'settings_store.json'), 'utf8')).toBe(settings);
    expect(await fs.readFile(path.join(data, 'logs', 'handy.log'), 'utf8')).toBe('debug transcript');
    expect(await jobDirectories(directory)).toEqual([]);
  });

  it.each(['', 'not a Handy marker'])('rejects legacy marker %j with Data before spawn and leaves Data unchanged', async (marker) => {
    const directory = await root();
    const executable = path.join(directory, 'handy');
    await fs.writeFile(executable, '#!/usr/bin/env node\n', { mode: 0o755 });
    await fs.writeFile(path.join(directory, 'portable'), marker);
    const data = path.join(directory, 'Data');
    await fs.mkdir(path.join(data, 'logs'), { recursive: true });
    await fs.writeFile(path.join(data, 'settings_store.json'), '{"settings":{"post_process_api_keys":{"provider":"secret"}}}');
    await fs.writeFile(path.join(data, 'logs', 'handy.log'), 'legacy debug transcript');
    const runner = vi.fn<HandyRunner>();

    await expect(transcribeWithHandy(wav(), {
      handyPath: executable, tempRoot: directory, runner, env: { HOME: path.join(directory, 'home') },
    })).rejects.toThrow('portable Handy');
    expect(runner).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(data, 'settings_store.json'), 'utf8')).toBe('{"settings":{"post_process_api_keys":{"provider":"secret"}}}');
    expect(await fs.readFile(path.join(data, 'logs', 'handy.log'), 'utf8')).toBe('legacy debug transcript');
    expect(await jobDirectories(directory)).toEqual([]);
  });
});

describe('sandbox setup and cleanup failures', () => {
  it('cleans the new sandbox when settings copying fails', async () => {
    const directory = await root();
    const home = path.join(directory, 'home');
    const app = path.join(home, '.config', 'com.pais.handy');
    await fs.mkdir(app, { recursive: true });
    await fs.writeFile(path.join(app, 'settings_store.json'), '{"post_process_api_keys":{"provider":"secret"}}', { mode: 0o000 });
    await expect(transcribeWithHandy(wav(), {
      handyPath: '/not/run', tempRoot: directory, env: { HOME: home },
    })).rejects.toThrow();
    expect(await jobDirectories(directory)).toEqual([]);
  });

  it('rejects cancel and blocks restart when a child reports success after abort', async () => {
    const directory = await root();
    let started = false;
    const runner: HandyRunner = (_command, _args, options) => new Promise((resolve) => {
      started = true;
      options.signal?.addEventListener('abort', () => resolve(JSON.stringify({ text: 'late success' })), { once: true });
    });
    const base = await bridge({ runner, tempRoot: directory, env: { HOME: path.join(directory, 'home') } });
    const client = new AbortController();
    const pending = transcribeRequest(base, client.signal);
    await vi.waitFor(() => expect(started).toBe(true));
    client.abort();
    await expect(pending).rejects.toThrow();
    const cancelled = await fetch(`${base}/cancel`, { method: 'POST', headers: headers() });
    expect(cancelled.status).toBe(500);
    expect((await cancelled.json()).detail).toBe('Handy cleanup failed');
    expect((await transcribeRequest(base)).status).toBe(429);
  });

  it('propagates deletion failure through cancel and keeps the active job closed to restart', async () => {
    const directory = await root();
    const remove = vi.fn(async () => { throw new Error('deletion failed'); });
    let started = false;
    const runner: HandyRunner = (_command, _args, options) => new Promise((_resolve, reject) => {
      started = true;
      options.signal?.addEventListener('abort', () => reject(new Error('child stopped')), { once: true });
    });
    const base = await bridge({ runner, tempRoot: directory, env: { HOME: path.join(directory, 'home') }, remove });
    const client = new AbortController();
    const pending = transcribeRequest(base, client.signal);
    await vi.waitFor(() => expect(started).toBe(true));
    client.abort();
    await expect(pending).rejects.toThrow();
    const cancelled = await fetch(`${base}/cancel`, { method: 'POST', headers: headers() });
    expect(cancelled.status).toBe(500);
    expect((await cancelled.json()).detail).toBe('Handy cleanup failed');
    expect(remove).toHaveBeenCalled();
    expect((await transcribeRequest(base)).status).toBe(429);
  });

  it('returns confirmed cancellation and permits restart only after cleanup succeeds', async () => {
    const directory = await root();
    let calls = 0;
    const runner: HandyRunner = (_command, _args, options) => {
      calls += 1;
      if (calls > 1) return Promise.resolve(JSON.stringify({ text: 'second job' }));
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('child stopped')), { once: true });
      });
    };
    const base = await bridge({ runner, tempRoot: directory, env: { HOME: path.join(directory, 'home') } });
    const client = new AbortController();
    const pending = transcribeRequest(base, client.signal);
    await vi.waitFor(() => expect(calls).toBe(1));
    client.abort();
    await expect(pending).rejects.toThrow();
    expect((await fetch(`${base}/cancel`, { method: 'POST', headers: headers() })).status).toBe(200);
    const second = await transcribeRequest(base);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true, text: 'second job' });
    expect(await jobDirectories(directory)).toEqual([]);
  });
});

describe('Hugging Face cache containment', () => {
  it('supports an HF-only model layout in health and transcription without exposing cache writes or unrelated data', async () => {
    const directory = await root();
    const hfHome = path.join(directory, 'hf-home');
    const repo = path.join(hfHome, 'hub', 'models--org--demo');
    await fs.mkdir(path.join(repo, 'refs'), { recursive: true });
    await fs.mkdir(path.join(repo, 'snapshots', 'sha'), { recursive: true });
    await fs.mkdir(path.join(repo, 'blobs'), { recursive: true });
    await fs.writeFile(path.join(repo, 'refs', 'main'), 'sha\n');
    await fs.writeFile(path.join(repo, 'snapshots', 'sha', 'model.bin'), 'original model');
    await fs.writeFile(path.join(repo, 'blobs', 'blob'), 'blob');
    await fs.mkdir(path.join(hfHome, 'hub', 'datasets--private'), { recursive: true });
    await fs.writeFile(path.join(hfHome, 'hub', 'datasets--private', 'secret.txt'), 'secret');
    const runner: HandyRunner = async (_command, args, options) => {
      const hf = options.env.HF_HOME!;
      const model = path.join(hf, 'hub', 'models--org--demo', 'snapshots', 'sha', 'model.bin');
      expect(await fs.readFile(model, 'utf8')).toBe('original model');
      await fs.writeFile(model, 'changed copy');
      await expect(fs.stat(path.join(hf, 'hub', 'datasets--private'))).rejects.toMatchObject({ code: 'ENOENT' });
      return args[0] === '--list-models'
        ? JSON.stringify([{ is_downloaded: true }])
        : JSON.stringify({ text: 'hf-only transcript' });
    };
    const base = await bridge({ runner, tempRoot: directory, env: { HOME: path.join(directory, 'home'), HF_HOME: hfHome } });
    expect((await fetch(`${base}/health`, { headers: headers() })).status).toBe(200);
    const response = await transcribeRequest(base);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, text: 'hf-only transcript' });
    expect(await fs.readFile(path.join(repo, 'snapshots', 'sha', 'model.bin'), 'utf8')).toBe('original model');
    expect(await fs.readFile(path.join(hfHome, 'hub', 'datasets--private', 'secret.txt'), 'utf8')).toBe('secret');
    expect(await jobDirectories(directory)).toEqual([]);
  });

  it('preserves a legitimate snapshot-to-blob symlink inside the model repository', async () => {
    const directory = await root();
    const hfHome = path.join(directory, 'hf-home');
    const repo = path.join(hfHome, 'hub', 'models--org--demo');
    await fs.mkdir(path.join(repo, 'snapshots', 'sha'), { recursive: true });
    await fs.mkdir(path.join(repo, 'blobs'), { recursive: true });
    await fs.writeFile(path.join(repo, 'blobs', 'blob'), 'original blob');
    await fs.symlink('../../blobs/blob', path.join(repo, 'snapshots', 'sha', 'model.bin'));
    const runner: HandyRunner = async (_command, args, options) => {
      const hf = options.env.HF_HOME!;
      const link = path.join(hf, 'hub', 'models--org--demo', 'snapshots', 'sha', 'model.bin');
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      expect((await fs.realpath(link)).startsWith(hf)).toBe(true);
      expect((await fs.realpath(link)).startsWith(hfHome)).toBe(false);
      expect(await fs.readFile(link, 'utf8')).toBe('original blob');
      await fs.writeFile(link, 'changed copy');
      return args[0] === '--list-models'
        ? JSON.stringify([{ is_downloaded: true }])
        : JSON.stringify({ text: 'linked model transcript' });
    };
    const base = await bridge({ runner, tempRoot: directory, env: { HOME: path.join(directory, 'home'), HF_HOME: hfHome } });
    expect((await fetch(`${base}/health`, { headers: headers() })).status).toBe(200);
    expect((await transcribeRequest(base)).status).toBe(200);
    expect(await fs.readFile(path.join(repo, 'blobs', 'blob'), 'utf8')).toBe('original blob');
    expect(await jobDirectories(directory)).toEqual([]);
  });

  it.each(['relative-dataset', 'absolute-outside'])('rejects HF symlink escape to %s and cleans the sandbox', async (kind) => {
    const directory = await root();
    const hfHome = path.join(directory, 'hf-home');
    const repo = path.join(hfHome, 'hub', 'models--org--demo');
    await fs.mkdir(path.join(repo, 'snapshots', 'sha'), { recursive: true });
    const secret = kind === 'relative-dataset'
      ? path.join(hfHome, 'hub', 'datasets--private', 'secret.txt')
      : path.join(directory, 'outside.txt');
    await fs.mkdir(path.dirname(secret), { recursive: true });
    await fs.writeFile(secret, 'must not be exposed');
    const target = kind === 'relative-dataset' ? '../../../datasets--private/secret.txt' : secret;
    await fs.symlink(target, path.join(repo, 'snapshots', 'sha', 'model.bin'));
    const runner = vi.fn<HandyRunner>();

    await expect(transcribeWithHandy(wav(), {
      handyPath: '/not/run', tempRoot: directory, runner,
      env: { HOME: path.join(directory, 'home'), HF_HOME: hfHome },
    })).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled();
    expect(await fs.readFile(secret, 'utf8')).toBe('must not be exposed');
    expect(await jobDirectories(directory)).toEqual([]);
  });
});
