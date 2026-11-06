import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { groupIsGone, HermesProcessSupervisor } from '../tools/hermes-live/process.js';

describe('real process-group containment', () => {
  it('kills descendants and returns only after the process group is empty', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 't01-process-'));
    const supervisor = new HermesProcessSupervisor();
    const handle = await supervisor.start({
      scenarioId: 'P08',
      command: '/bin/sh',
      args: ['-c', 'sleep 60 & wait'],
      cwd: workspace,
      env: {
        HOME: workspace,
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HERMES_HOME: workspace,
        TEAMKIMI_OPENAI_COMPATIBLE_URL: 'http://127.0.0.1',
        TEAMKIMI_MODEL_ID: 'kimi-code/k3.1-pro',
      },
    }, () => undefined);
    try {
      await handle.signal('SIGKILL');
      await handle.reap();
      expect(() => process.kill(-handle.identity.pgid, 0)).toThrow();
    } finally {
      await handle.reap();
    }
  });

  it('fails closed on a stat read error while a descendant is alive', async () => {
    const child = spawn('/bin/sh', ['-c', 'sleep 60'], { detached: true });
    try {
      await expect(groupIsGone(child.pid!, async () => {
        throw Object.assign(new Error('simulated I/O error'), { code: 'EIO' });
      })).rejects.toThrow('simulated I/O error');
      expect(process.kill(child.pid!, 0)).toBe(true);
    } finally {
      process.kill(-child.pid!, 'SIGKILL');
    }
  });
});
