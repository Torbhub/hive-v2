import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLOSED_STATES } from '../src/types.js';

const dailyScan = readFileSync(fileURLToPath(new URL('../infra/box/daily-scan.sh', import.meta.url)), 'utf8');

function runDailyScan(state: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'hive-daily-scan-'));
  const bin = path.join(root, 'bin');
  const tasks = path.join(root, 'tasks');
  const calls = path.join(root, 'curl-calls');
  mkdirSync(bin);
  mkdirSync(tasks);
  writeFileSync(path.join(tasks, 'hivev2-1.md'), 'daily-scan 2026-01-02\n');
  writeFileSync(calls, '');

  const stubs = {
    date: '#!/bin/bash\nprintf \'%s\\n\' 2026-01-02\n',
    curl: `#!/bin/bash
printf '%s\\n' "$*" >> "$CURL_LOG"
case "$*" in
  *"/api/view"*)
    printf '{"tasks":[{"id":"hivev2-1","state":"%s"}]}\\n' "$TASK_STATE"
    ;;
  *"/api/start"*)
    printf '{}\\n200\\n'
    ;;
  *) exit 1 ;;
esac
`,
  };
  for (const [name, source] of Object.entries(stubs)) {
    const file = path.join(bin, name);
    writeFileSync(file, source);
    chmodSync(file, 0o755);
  }

  const script = dailyScan.replace(
    'TASKS_DIR=/home/ubuntu/hive-work/.hive-hub/tasks',
    'TASKS_DIR=$TEST_TASKS_DIR',
  );
  const result = spawnSync('bash', ['-c', script], {
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HIVE_WEB_SECRET: 'test-secret',
      TEST_TASKS_DIR: tasks,
      TASK_STATE: state,
      CURL_LOG: calls,
    },
    encoding: 'utf8',
  });
  return { result, calls: readFileSync(calls, 'utf8') };
}

describe('daily scan existing task', () => {
  it.each([...CLOSED_STATES])('keeps %s closed without restart or nudge', (state) => {
    const { result, calls } = runDailyScan(state);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('already posted and closed (hivev2-1)');
    expect(calls).toContain('/api/view');
    expect(calls).not.toContain('/api/start');
    expect(calls).not.toContain('/api/message');
  });

  it('retries the start for a nonterminal task', () => {
    const { result, calls } = runDailyScan('running');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('started: hivev2-1');
    expect(calls).toContain('/api/start');
  });
});
