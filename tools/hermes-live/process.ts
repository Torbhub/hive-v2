import { spawn } from 'node:child_process';
import { open, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { BrokerActivity, ProcessIdentity, ProcessObservation, ProcessRequest, ProcessSupervisor } from './runner.js';

const MAX_CAPTURE_BYTES = 64 * 1024;
const REAP_DEADLINE_MS = 5_000;

export async function processIdentity(pid: number, reader: (path: string) => Promise<string> = (path) => readFile(path, 'utf8')): Promise<ProcessIdentity> {
  const value = await reader(`/proc/${pid}/stat`);
  const fields = value.slice(value.lastIndexOf(')') + 2).split(' ');
  const pgid = Number(fields[2]);
  const startTimeTicks = Number(fields[19]);
  if (!Number.isSafeInteger(pgid) || !Number.isSafeInteger(startTimeTicks)) throw new Error('invalid-process-identity');
  return { pid, pgid, startTimeTicks };
}

async function verifyIdentity(identity: ProcessIdentity) {
  const current = await processIdentity(identity.pid);
  if (current.pgid !== identity.pgid || current.startTimeTicks !== identity.startTimeTicks) throw new Error('stale-process-identity');
}

export async function groupIsGone(pgid: number, identityReader = processIdentity) {
  const entries = await readdir('/proc');
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const identity = await identityReader(Number(entry));
      if (identity.pgid === pgid) return false;
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      if (code !== 'ENOENT' && code !== 'ESRCH') throw error;
    }
  }
  return true;
}

async function readActivities(path: string): Promise<BrokerActivity[]> {
  let handle;
  try { handle = await open(path, 'r'); } catch { return []; }
  try {
    const buffer = Buffer.alloc(MAX_CAPTURE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CAPTURE_BYTES) throw new Error('activity-file-too-large');
    const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    if (!Array.isArray(value) || value.length > 128) throw new Error('invalid-activities');
    return value.map((entry) => {
      if (typeof entry !== 'object' || entry === null || typeof entry.id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(entry.id)
        || !Number.isSafeInteger(entry.sequence) || entry.sequence < 0 || !Number.isSafeInteger(entry.durationMs) || entry.durationMs < 0
        || typeof entry.status !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(entry.status)
        || (entry.errorCategory !== undefined && (typeof entry.errorCategory !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(entry.errorCategory)))
        || (entry.resultSha256 !== undefined && (typeof entry.resultSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.resultSha256)))) throw new Error('invalid-activity');
      return {
        id: entry.id, sequence: entry.sequence, durationMs: entry.durationMs, status: entry.status,
        ...(entry.errorCategory === undefined ? {} : { errorCategory: entry.errorCategory }),
        ...(entry.resultSha256 === undefined ? {} : { resultSha256: entry.resultSha256 }),
      };
    });
  } finally {
    await handle.close();
  }
}

export class HermesProcessSupervisor implements ProcessSupervisor {
  async capture(request: ProcessRequest) {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd, env: request.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const kill = () => {
      overflow = true;
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_CAPTURE_BYTES) kill();
      else if (!overflow) stdout += stdoutDecoder.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_CAPTURE_BYTES) kill();
      else if (!overflow) stderr += stderrDecoder.write(chunk);
    });
    const timeout = setTimeout(kill, 10_000);
    const code = await new Promise<number>((resolve) => {
      child.on('error', () => resolve(1));
      child.on('close', (exitCode) => resolve(exitCode ?? 1));
    }).finally(() => clearTimeout(timeout));
    if (!overflow) {
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
    }
    return { code: overflow ? 1 : code, stdout, stderr: overflow ? '' : stderr };
  }

  async start(request: ProcessRequest, observer: (observation: ProcessObservation) => void) {
    const child = spawn(request.command, request.args, {
      cwd: request.cwd, env: request.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!child.pid) throw new Error('missing-process-identity');
    const identity = await processIdentity(child.pid);
    child.stdout.on('data', (chunk: Buffer) => observer({ type: 'stdout', bytes: new Uint8Array(chunk) }));
    child.stderr.on('data', (chunk: Buffer) => observer({ type: 'stderr', bytes: new Uint8Array(chunk) }));
    child.stdout.on('end', () => observer({ type: 'eof' }));
    child.on('error', () => {
      observer({ type: 'eof' });
      observer({ type: 'exit', code: 1 });
    });
    child.on('close', (code, signal) => {
      observer({ type: 'exit', code: code ?? 1, signal: signal ?? undefined });
    });
    return {
      identity,
      signal: async (signal: 'SIGINT' | 'SIGKILL') => {
        await verifyIdentity(identity);
        process.kill(-identity.pgid, signal);
      },
      reap: async () => {
        const killAt = Date.now() + REAP_DEADLINE_MS;
        const finalDeadline = killAt + REAP_DEADLINE_MS;
        let killed = false;
        while (!(await groupIsGone(identity.pgid))) {
          if (!killed && Date.now() >= killAt) {
            process.kill(-identity.pgid, 'SIGKILL');
            killed = true;
          }
          if (Date.now() >= finalDeadline) throw new Error('process-group-reap-timeout');
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }
      },
      activities: () => readActivities(join(request.env.HERMES_HOME, 't01-activities.json')),
    };
  }
}
