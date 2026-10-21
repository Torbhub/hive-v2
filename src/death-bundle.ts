import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hubPath } from './state.js';
import { run, tmux, tmuxSocket } from './tmux.js';
import type { TeamEntry } from './types.js';
import { lastLine } from './view.js';

// Rebuild stamp left by infra/ deploy on the box; the box is committed state in infra/.
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

// Every probe is isolated: a failure is one recorded line, never a lost bundle.
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

async function readTailBytes(file: string, bytes: number): Promise<string> {
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

async function findSessionDir(home: string, sessionId: string): Promise<string> {
  const base = path.join(home, '.kimi-code', 'sessions');
  const dirName = sessionId.startsWith('session_') ? sessionId : `session_${sessionId}`;
  for (const wd of await fs.readdir(base)) {
    const dir = path.join(base, wd, dirName);
    const st = await fs.stat(dir).catch(() => null);
    if (st?.isDirectory()) return dir;
  }
  throw new Error(`no ${dirName} under ${base}`);
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

// The wedge judge's liveness signal: when the session last wrote a wire event.
export async function wireLogMtime(home: string, sessionId: string): Promise<number | null> {
  try {
    return (await fs.stat(await findWireLog(await findSessionDir(home, sessionId)))).mtimeMs;
  } catch {
    return null;
  }
}

// Only type and timestamp leave this function; payloads never enter the bundle.
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
