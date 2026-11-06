import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const checks = [
  't01_policy_checks.py',
  't01_runtime_checks.py',
  't01_workflow_checks.py',
  't01_health_broker_checks.py',
];

describe('T01 behavior regressions', () => {
  for (const check of checks) {
    it(check, () => {
      const script = fileURLToPath(new URL(`../test/${check}`, import.meta.url));
      const result = spawnSync('python3', [script], { encoding: 'utf8' });
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    });
  }

  it('keeps the unrelated spawn timeout at its original budget', () => {
    const path = fileURLToPath(new URL('../test/spawn.test.ts', import.meta.url));
    const source = readFileSync(path, 'utf8');
    const start = source.indexOf("describe('spawn parent'");
    const end = source.indexOf("describe('trust dialog", start);
    const block = source.slice(start, end);
    expect(block).toContain('}, 20_000);');
    expect(block).not.toContain('}, 30_000);');
  });
});
