import { promises as fs } from 'node:fs';

export type ProcessLeaseStatus = 'alive' | 'dead' | 'invalid';

export async function readProcessStartTime(pid: number): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid process id');
  const raw = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/);
  const startTime = fields[19];
  if (!startTime || !/^\d+$/.test(startTime)) throw new Error('invalid process start time');
  return startTime;
}

export async function processLeaseStatus(pid: unknown, startTime: unknown): Promise<ProcessLeaseStatus> {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0
    || typeof startTime !== 'string' || !/^\d+$/.test(startTime)) return 'invalid';
  try {
    return await readProcessStartTime(pid) === startTime ? 'alive' : 'invalid';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'dead' : 'invalid';
  }
}
