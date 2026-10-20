import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSteps, pushByHash, verifyCommits, verifyLog } from '../src/gate.js';

const SHA = 'a'.repeat(40);
const VITEST_OK = ' Test Files  1 passed (1)\n      Tests  3 passed (3)\n';

function log(lines: string[], steps: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'hive-gate-'));
  const file = path.join(dir, 'gate.log');
  writeFileSync(file, lines.join('\n') + '\n');
  mkdirSync(`${file}.d`, { recursive: true });
  for (const [name, out] of Object.entries(steps)) writeFileSync(path.join(`${file}.d`, `${name}.log`), out);
  return file;
}

describe('parseSteps', () => {
  it('pairs names and commands', () => {
    expect(parseSteps(['build', 'npm run build', 'test', 'npm test'])).toEqual([
      { name: 'build', cmd: 'npm run build' },
      { name: 'test', cmd: 'npm test' },
    ]);
  });
  it('rejects duplicates, bad names, and odd counts', () => {
    expect(() => parseSteps(['a', 'x', 'a', 'y'])).toThrow(/twice/);
    expect(() => parseSteps(['a..b', 'x'])).toThrow(/step name/);
    expect(() => parseSteps(['a'])).toThrow(/pairs/);
  });
});

describe('verifyLog', () => {
  it('GREEN on a full clean log', async () => {
    const file = log(
      [`# hive-gate steps: build,test head=${SHA} dirty=0`, 'build exit 0', 'test exit 0'],
      { test: VITEST_OK },
    );
    const r = await verifyLog(file);
    expect(r.green).toBe(true);
    expect(r.out).toBe('GREEN (2 steps)');
    expect(r.note).toMatch(/not checked against a commit/);
  });

  it('RED when a green test step ran zero tests — exit 0 is not evidence', async () => {
    const empty = log(
      [`# hive-gate steps: test head=${SHA} dirty=0`, 'test exit 0'],
      { test: 'No test files found, exiting with code 0\n' },
    );
    const r = await verifyLog(empty);
    expect(r.green).toBe(false);
    expect(r.out).toContain('test: zero passing tests');
    const skipped = log(
      [`# hive-gate steps: test head=${SHA} dirty=0`, 'test exit 0'],
      { test: ' Test Files  1 passed (1)\n      Tests  3 skipped (3)\n' },
    );
    expect((await verifyLog(skipped)).out).toContain('test: zero passing tests');
  });

  it('RED when a green test step shows errors or no output log', async () => {
    const errors = log(
      [`# hive-gate steps: test head=${SHA} dirty=0`, 'test exit 0'],
      { test: ' Test Files  1 passed (1)\n      Tests  3 passed (3)\n     Errors  1 error\n' },
    );
    expect((await verifyLog(errors)).out).toContain('test: 1 error(s)');
    const noOut = log([`# hive-gate steps: test head=${SHA} dirty=0`, 'test exit 0']);
    expect((await verifyLog(noOut)).out).toContain('test: no step output');
  });

  it('RED when a green test step recorded failures — the exit code was masked', async () => {
    const masked = log(
      [`# hive-gate steps: test head=${SHA} dirty=0`, 'test exit 0'],
      { test: ' Test Files  1 failed (1)\n      Tests  1 failed | 9 passed (10)\n' },
    );
    const r = await verifyLog(masked);
    expect(r.green).toBe(false);
    expect(r.out).toContain('test: 1 failed test(s)');
  });

  it('RED when a step failed, and later steps still count', async () => {
    const file = log([`# hive-gate steps: build,test head=${SHA} dirty=0`, 'build exit 1', 'test exit 0']);
    const r = await verifyLog(file);
    expect(r.green).toBe(false);
    expect(r.out).toContain('build exit 1');
  });

  it('RED with no step lines — never vacuously green', async () => {
    const file = log([`# hive-gate steps: build head=${SHA} dirty=0`]);
    expect((await verifyLog(file)).out).toBe(`RED: no steps in ${file}`);
  });

  it('RED on missing, duplicated, or unexpected-vs-header steps', async () => {
    const missing = log([`# hive-gate steps: build,test head=${SHA} dirty=0`, 'build exit 0']);
    expect((await verifyLog(missing)).out).toContain('missing: test');
    const twice = log([`# hive-gate steps: build,test head=${SHA} dirty=0`, 'build exit 0', 'test exit 0', 'test exit 0']);
    expect((await verifyLog(twice)).out).toContain('twice: test');
  });

  it('RED when the header names another commit or a dirty tree', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hive-gate-git-'));
    git(dir, ['init', '-q']);
    git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const tip = git(dir, ['rev-parse', 'HEAD']).trim();
    const wrong = log([`# hive-gate steps: build head=${SHA} dirty=0`, 'build exit 0']);
    expect((await verifyLog(wrong, { commit: tip }, dir)).out).toContain(`the gate ran on ${'a'.repeat(40)}, not ${tip}`);
    const dirty = log([`# hive-gate steps: build head=${tip} dirty=1`, 'build exit 0']);
    expect((await verifyLog(dirty, { commit: tip }, dir)).out).toContain('dirty tree');
    const clean = log([`# hive-gate steps: build head=${tip} dirty=0`, 'build exit 0']);
    expect((await verifyLog(clean, { commit: tip }, dir)).green).toBe(true);
  });

  it('needs --expect when there is no header', async () => {
    const file = log(['build exit 0']);
    expect((await verifyLog(file)).out).toContain('no hive-gate header');
    expect((await verifyLog(file, { expect: ['build'] })).green).toBe(true);
  });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

describe('verifyCommits', () => {
  function repo(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'hive-vc-'));
    git(dir, ['init', '-q']);
    return dir;
  }
  function commit(dir: string, msg: string, file: string, content: string): void {
    writeFileSync(path.join(dir, file), content);
    git(dir, ['add', file]);
    git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', msg]);
  }
  const opts = { maxFiles: 5, style: 'conventional' as const, attribution: 'deny' as const };

  it('OK on a clean conventional range', async () => {
    const dir = repo();
    commit(dir, 'feat: one', 'a.txt', '1');
    const base = git(dir, ['rev-parse', 'HEAD']).trim();
    commit(dir, 'fix: two', 'b.txt', '2');
    const tip = git(dir, ['rev-parse', 'HEAD']).trim();
    const r = await verifyCommits(`${base}..${tip}`, opts, dir);
    expect(r.green).toBe(true);
    expect(r.out).toBe('OK (1 commits)');
  });

  it('RED on empty range, bad subject, too many files, attribution', async () => {
    const dir = repo();
    commit(dir, 'feat: one', 'a.txt', '1');
    const base = git(dir, ['rev-parse', 'HEAD']).trim();
    expect((await verifyCommits(`${base}..${base}`, opts, dir)).out).toContain('RED: no commits');
    commit(dir, 'bad subject', 'b.txt', '2');
    let tip = git(dir, ['rev-parse', 'HEAD']).trim();
    expect((await verifyCommits(`${base}..${tip}`, opts, dir)).out).toContain('not conventional');
    commit(dir, 'feat: with attribution\n\nCo-authored-by: x <x@x>', 'c.txt', '3');
    tip = git(dir, ['rev-parse', 'HEAD']).trim();
    expect((await verifyCommits(`${base}..${tip}`, opts, dir)).out).toContain('attribution');
    expect((await verifyCommits(`${base}..${tip}`, { ...opts, maxFiles: 0 }, dir)).out).toContain('more than 0');
  });

  it('rejects a range with more than one ..', async () => {
    const dir = repo();
    commit(dir, 'feat: one', 'a.txt', '1');
    await expect(verifyCommits('a..b..c', opts, dir)).rejects.toThrow(/not a range/);
  });
});

describe('pushByHash', () => {
  it('refuses a remote that looks like a flag', async () => {
    await expect(pushByHash('--upload-pack=x', SHA, 'main', '/tmp')).rejects.toThrow(/remote/);
  });
});
