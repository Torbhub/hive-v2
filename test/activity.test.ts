import { mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { wireActivityAt } from '../src/death-bundle.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'wire-activity.jsonl');

describe('wire activity', () => {
  it('uses completed turns and compactions, not passive writes or file mtime', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'hive-wire-activity-'));
    const dir = path.join(home, '.kimi-code', 'sessions', 'wd_test', 'session_real', 'agents', 'main');
    await fs.mkdir(dir, { recursive: true });
    const wire = path.join(dir, 'wire.jsonl');
    await fs.copyFile(FIXTURE, wire);
    const mtime = new Date('2026-11-06T12:00:00Z');
    await fs.utimes(wire, mtime, mtime);

    expect((await fs.stat(wire)).mtimeMs).toBe(mtime.getTime());
    expect(await wireActivityAt(home, 'session_real')).toBe(1760000006000);
  });

  it('finds real activity beyond the old 256 KiB tail', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'hive-wire-long-tail-'));
    const dir = path.join(home, '.kimi-code', 'sessions', 'wd_test', 'session_long', 'agents', 'main');
    await fs.mkdir(dir, { recursive: true });
    const original = await fs.readFile(FIXTURE, 'utf8');
    const passive = '{"type":"task.waitDelivered","time":1760000007000}\n';
    await fs.writeFile(path.join(dir, 'wire.jsonl'), original + passive.repeat(6000));

    expect(await wireActivityAt(home, 'session_long')).toBe(1760000006000);
  });

  it('returns null when only passive events exist', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'hive-wire-passive-'));
    const dir = path.join(home, '.kimi-code', 'sessions', 'wd_test', 'session_passive', 'agents', 'main');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'wire.jsonl'), [
      '{"type":"turn.prompt","time":1760000000000,"origin":{"kind":"cron_job"}}',
      '{"type":"task.waitDelivered","time":1760000001000}',
      '{"type":"permission.record_approval_result","time":1760000002000}',
      '',
    ].join('\n'));

    expect(await wireActivityAt(home, 'session_passive')).toBeNull();
  });
});
