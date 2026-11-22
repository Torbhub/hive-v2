import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findSessionDir } from '../src/death-bundle.js';
import { readAgentLog } from '../src/logview.js';
import { hivePath, hubPath, Refusal, writeJson } from '../src/state.js';
import type { TeamEntry } from '../src/types.js';
import { createServer } from '../web/server.js';
import { configureSecurity } from './security-fixture.js';

const ORCH: TeamEntry = { name: 'demo-orchestrator', orchestrator: true, session_id: 'session_abc' };

async function setup(
  wires: Record<string, string[]>,
  sessionId = 'session_abc',
): Promise<{ root: string; home: string }> {
  const root = mkdtempSync(path.join(tmpdir(), 'hive-session-log-root-'));
  const home = mkdtempSync(path.join(tmpdir(), 'hive-session-log-home-'));
  const projectHome = path.join(root, 'demo');
  await writeJson(hubPath(root, 'projects.json'), { projects: [{ name: 'demo', home: projectHome, repos: [] }] });
  await writeJson(hivePath(projectHome, 'team.json'), { agents: [ORCH] });
  for (const [agentId, lines] of Object.entries(wires)) {
    const dir = path.join(home, '.kimi-code', 'sessions', 'wd_demo', sessionId, 'agents', agentId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'wire.jsonl'), `${lines.join('\n')}\n`);
  }
  return { root, home };
}

function failure(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('session discovery errors', () => {
  it('reports absence after every candidate is missing', async () => {
    const { home } = await setup({ main: [] }, 'session_other');
    await expect(findSessionDir(home, 'session_abc')).rejects.toThrow(/no session_abc/);
  });

  it.each(['EACCES', 'EIO'])('preserves a candidate %s failure', async (code) => {
    const { home } = await setup({ main: [] });
    const error = failure(code, `candidate ${code}`);
    vi.spyOn(fs, 'stat').mockRejectedValueOnce(error);
    await expect(findSessionDir(home, 'session_abc')).rejects.toBe(error);
  });
});

describe('session log errors', () => {
  it('refuses a genuinely absent session', async () => {
    const { root, home } = await setup({ main: [] }, 'session_other');
    await expect(readAgentLog(root, 'demo', undefined, home)).rejects.toThrow(Refusal);
  });

  it('does not relabel a discovery permission failure as absence', async () => {
    const { root, home } = await setup({ main: [] });
    const error = failure('EACCES', 'candidate permission denied');
    vi.spyOn(fs, 'stat').mockRejectedValueOnce(error);
    await expect(readAgentLog(root, 'demo', undefined, home)).rejects.toBe(error);
  });

  it.each(['EACCES', 'EIO'])('preserves a wire-open %s failure', async (code) => {
    const { root, home } = await setup({ main: [] });
    const error = failure(code, `wire open ${code}`);
    vi.spyOn(fs, 'open').mockRejectedValueOnce(error);
    await expect(readAgentLog(root, 'demo', undefined, home)).rejects.toBe(error);
  });

  it('returns an empty page for a valid empty wire log', async () => {
    const { root, home } = await setup({ main: [] });
    const file = path.join(
      home, '.kimi-code', 'sessions', 'wd_demo', 'session_abc', 'agents', 'main', 'wire.jsonl',
    );
    await fs.truncate(file);
    const log = await readAgentLog(root, 'demo', undefined, home);
    expect(log.agents).toEqual([]);
    expect(log.fileGeneration).toMatch(/^[0-9a-f]{16}$/);
    expect(log.hasOlder).toBe(false);
    expect(log.olderCursor).toBeNull();
  });
});

describe('session log web errors', () => {
  it('returns a generic path-free 500 for an injected discovery I/O failure', async () => {
    const { root, home } = await setup({});
    const error = failure('EIO', `cannot read ${path.join(home, 'private-sessions')}`);
    vi.spyOn(fs, 'readdir').mockRejectedValueOnce(error);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    configureSecurity(false);
    const server = createServer(root);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const response = await fetch(`${url}/api/log?project=demo`);
      const text = await response.text();
      expect(response.status).toBe(500);
      expect(JSON.parse(text)).toEqual({ ok: false, detail: 'internal error' });
      expect(text).not.toContain(home);
    } finally {
      await close(server);
    }
  });
});
