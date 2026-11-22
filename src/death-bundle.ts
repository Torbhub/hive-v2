import { constants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hubPath } from './state.js';
import { run, tmux, tmuxSocket } from './tmux.js';
import type { TeamEntry } from './types.js';
import { lastLine } from './view.js';

const HIVE_V2_DIST = '/home/ubuntu/hive-v2/dist/src/cli.js';
const PROBE_TIMEOUT_MS = 10_000;
const DEPLOY_WINDOW_MS = 10 * 60_000;
const WIRE_TAIL_BYTES = 64 * 1024;
const WIRE_EVENT_COUNT = 5;
const SECTION_LINES = 40;

export type DeathProbePaths = { home?: string; distFile?: string };

function cap(text: string, lines = SECTION_LINES): string {
  const all = text.trimEnd().split('\n');
  return all.length <= lines ? all.join('\n') : all.slice(-lines).join('\n');
}

async function isolated(name: string, fn: () => Promise<string>): Promise<string> {
  try {
    const out = (await fn()).trimEnd();
    return out || `${name}: no output`;
  } catch (e) {
    return `${name}: unavailable (${lastLine(e)})`;
  }
}

async function probeRun(name: string, cmd: string, args: string[]): Promise<string> {
  return isolated(name, async () => {
    const r = await run(cmd, args, undefined, undefined, PROBE_TIMEOUT_MS);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `exit code ${r.code}`);
    return r.stdout;
  });
}

export async function readTailBytes(file: string, bytes: number): Promise<string> {
  const st = await fs.stat(file);
  const size = Math.min(bytes, st.size);
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(size);
    await fh.read(buf, 0, size, st.size - size);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

export class SessionNotFoundError extends Error {}

async function lstatIfExists(file: string) {
  return await fs.lstat(file).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
}

async function readStateCwd(file: string): Promise<string | null> {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await fs.open(file, flags).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) return null;
      offset += bytesRead;
    }
    try {
      const state = JSON.parse(buffer.toString('utf8')) as { cwd?: unknown };
      return state && typeof state === 'object' && typeof state.cwd === 'string' ? state.cwd : null;
    } catch {
      return null;
    }
  } finally {
    await handle.close();
  }
}

export type SessionLocation = { path: string; dev: number; ino: number };

export async function findSessionLocation(home: string, sessionId: string, cwd: string): Promise<SessionLocation> {
  const base = path.join(home, '.kimi-code', 'sessions');
  const dirName = sessionId.startsWith('session_') ? sessionId : `session_${sessionId}`;
  const workdirs = await fs.readdir(base).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
  const candidates: SessionLocation[] = [];
  for (const workdir of workdirs) {
    const workdirPath = path.join(base, workdir);
    if (!(await lstatIfExists(workdirPath))?.isDirectory()) continue;
    const candidate = path.join(workdirPath, dirName);
    const stat = await lstatIfExists(candidate);
    if (stat?.isDirectory()) candidates.push({ path: candidate, dev: stat.dev, ino: stat.ino });
  }
  if (candidates.length !== 1 || await readStateCwd(path.join(candidates[0].path, 'state.json')) !== cwd) {
    throw new SessionNotFoundError(`no unique ${dirName} for the recorded worktree`);
  }
  return candidates[0];
}

export async function findSessionDir(home: string, sessionId: string, cwd?: string): Promise<string> {
  if (cwd !== undefined) return (await findSessionLocation(home, sessionId, cwd)).path;
  const base = path.join(home, '.kimi-code', 'sessions');
  const dirName = sessionId.startsWith('session_') ? sessionId : `session_${sessionId}`;
  const workdirs = await fs.readdir(base).catch((e: unknown) => {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  });
  for (const wd of workdirs) {
    const dir = path.join(base, wd, dirName);
    const st = await fs.stat(dir).catch((e: unknown) => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    });
    if (st?.isDirectory()) return dir;
  }
  throw new SessionNotFoundError(`no ${dirName} under ${base}`);
}

async function findWireLog(sessionDir: string): Promise<string> {
  const agentsDir = path.join(sessionDir, 'agents');
  const agents = (await fs.readdir(agentsDir)).sort((a, b) => (
    a === 'main' ? -1 : b === 'main' ? 1 : a.localeCompare(b)
  ));
  for (const a of agents) {
    const file = path.join(agentsDir, a, 'wire.jsonl');
    const st = await fs.stat(file).catch(() => null);
    if (st?.isFile()) return file;
  }
  throw new Error(`no wire.jsonl under ${agentsDir}`);
}

export async function wireLogMtime(home: string, sessionId: string): Promise<number | null> {
  try {
    return (await fs.stat(await findWireLog(await findSessionDir(home, sessionId)))).mtimeMs;
  } catch {
    return null;
  }
}

const ACTIVITY_EVENTS = new Set(['turn.ended', 'agent.turn.ended', 'full_compaction.complete']);
const WIRE_ACTIVITY_CHUNK_BYTES = 64 * 1024;

export async function wireActivityAt(home: string, sessionId: string): Promise<number | null> {
  try {
    const file = await findWireLog(await findSessionDir(home, sessionId));
    const stat = await fs.stat(file);
    const handle = await fs.open(file, 'r');
    try {
      let end = stat.size;
      let carry = '';
      while (end > 0) {
        const start = Math.max(0, end - WIRE_ACTIVITY_CHUNK_BYTES);
        const buffer = Buffer.alloc(end - start);
        await handle.read(buffer, 0, buffer.length, start);
        const parts = (buffer.toString('utf8') + carry).split('\n');
        carry = parts[0];
        const complete = start === 0 ? parts : parts.slice(1);
        for (let i = complete.length - 1; i >= 0; i--) {
          if (!complete[i].trim()) continue;
          try {
            const event = JSON.parse(complete[i]) as { type?: unknown; time?: unknown };
            if (typeof event.type === 'string' && ACTIVITY_EVENTS.has(event.type)
              && typeof event.time === 'number' && Number.isFinite(event.time)) return event.time;
          } catch {
            continue;
          }
        }
        end = start;
      }
      return null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function wireTail(home: string, sessionId: string): Promise<string> {
  const file = await findWireLog(await findSessionDir(home, sessionId));
  const events: { type: string; at: string }[] = [];
  for (const line of (await readTailBytes(file, WIRE_TAIL_BYTES)).split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as { type?: unknown; time?: unknown };
      if (typeof ev.type === 'string' && /step|end/.test(ev.type)) {
        events.push({
          type: ev.type,
          at: typeof ev.time === 'number' ? new Date(ev.time).toISOString() : '?',
        });
      }
    } catch {
      continue;
    }
  }
  const last = events.slice(-WIRE_EVENT_COUNT);
  const lines = [`path: ${file}`];
  if (last.length === 0) lines.push('no step/end events in the tail');
  for (const ev of last) lines.push(`${ev.at} ${ev.type}`);
  return lines.join('\n');
}

function parseSystemdTimestamp(value: string): number | null {
  const t = Date.parse(value.replace(/^\w+ /, ''));
  return Number.isNaN(t) ? null : t;
}

async function deploySection(distFile: string, deathAt: Date): Promise<string> {
  const stamp = await probeRun('systemctl', 'systemctl', ['show', 'hive-v2-web', '-p', 'ActiveEnterTimestamp']);
  const mtime = await isolated('dist-mtime', async () => (
    (await fs.stat(distFile)).mtime.toISOString()
  ));
  const candidates: number[] = [];
  const m = stamp.match(/ActiveEnterTimestamp=(.+)/);
  if (m) {
    const t = parseSystemdTimestamp(m[1].trim());
    if (t !== null) candidates.push(t);
  }
  const mt = Date.parse(mtime);
  if (!Number.isNaN(mt)) candidates.push(mt);
  const recent = candidates.some((t) => t <= deathAt.getTime() && deathAt.getTime() - t <= DEPLOY_WINDOW_MS);
  const verdict = recent ? 'yes' : candidates.length ? 'no' : 'unknown';
  return [
    `hive-v2-web ActiveEnterTimestamp: ${stamp}`,
    `box rebuild stamp (${distFile}): ${mtime}`,
    `deploy within 10 minutes before death: ${verdict}`,
  ].join('\n');
}

export async function captureDeathBundle(
  root: string,
  project: string,
  agent: TeamEntry,
  paths: DeathProbePaths = {},
  deathAt: Date = new Date(),
): Promise<string> {
  const home = paths.home ?? os.homedir();
  const distFile = paths.distFile ?? HIVE_V2_DIST;
  const panes = await isolated('tmux-list-panes', async () => {
    const r = await tmux(['list-panes', '-a'], PROBE_TIMEOUT_MS);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `exit code ${r.code}`);
    return r.stdout;
  });
  const ps = await isolated('ps', async () => {
    const r = await run('ps', ['-o', 'pid,stat,etime,cmd', '-p', String(agent.pane_pid)], undefined, undefined, PROBE_TIMEOUT_MS);
    return r.code === 0 && r.stdout.trim().split('\n').length > 1
      ? r.stdout
      : `no process with pid ${agent.pane_pid} (confirmed gone)`;
  });
  const dmesg = cap(await probeRun('dmesg', 'sudo', ['-n', 'dmesg']), 20);
  const free = await probeRun('free', 'free', ['-m']);
  const sessionId = agent.session_id;
  const wire = sessionId
    ? await isolated('wire-log', () => wireTail(home, sessionId))
    : 'wire-log: unavailable (no session_id in the team entry)';
  const deploy = await isolated('deploy-correlation', () => deploySection(distFile, deathAt));

  const bundle = [
    `hive-v2 pane death bundle`,
    `project: ${project}`,
    `agent: ${agent.name}`,
    `at: ${deathAt.toISOString()}`,
    ``,
    `== watchdog record ==`,
    `pane: ${agent.pane ?? '?'}`,
    `pid: ${agent.pane_pid ?? '?'}`,
    `started: ${agent.pane_started ?? '?'}`,
    `session_id: ${agent.session_id ?? '?'}`,
    ``,
    `== tmux server (socket ${tmuxSocket()}) ==`,
    cap(panes),
    ``,
    `== dead process evidence ==`,
    `ps -p ${agent.pane_pid ?? '?'}:`,
    cap(ps),
    `dmesg (last 20 lines):`,
    dmesg,
    `free -m:`,
    cap(free),
    ``,
    `== kimi wire log tail ==`,
    cap(wire),
    ``,
    `== deploy correlation ==`,
    deploy,
    ``,
    `== exit evidence ==`,
    `remain-on-exit pane output: unavailable (the pane is already gone)`,
    ``,
  ].join('\n');

  const file = hubPath(root, 'deaths', `${project}-${agent.name}-${Math.floor(deathAt.getTime() / 1000)}.log`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bundle);
  return file;
}
