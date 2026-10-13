import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkName } from '../src/names.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('checkName', () => {
  it('accepts plain project/agent names', () => {
    for (const ok of ['demo', 'Demo', 'a1', 'my-project-2']) {
      expect(checkName('project', ok)).toBe(ok);
    }
  });
  it('rejects tmux target syntax and path traversal', () => {
    for (const bad of ['../etc', 'a;b', '-t', 'main:%1', 'a b', 'a/b', '.hidden', '']) {
      expect(() => checkName('project', bad)).toThrow(/name is/);
    }
  });
});

describe('cli boundary', () => {
  function cli(args: string[]) {
    const tsx = path.join(root, 'node_modules', '.bin', 'tsx');
    return spawnSync(tsx, [path.join(root, 'src', 'cli.ts'), ...args], { encoding: 'utf8', cwd: root });
  }

  it('rejects a bad project name before doing anything', () => {
    const r = cli(['hub', 'wake', '../evil']);
    expect(r.status).toBe(64);
    expect(r.stderr).toMatch(/project name is/);
  });

  it('rejects a bad agent name', () => {
    const r = cli(['spawn', 'demo', '--agent', 'a;b']);
    expect(r.status).toBe(64);
    expect(r.stderr).toMatch(/agent name is/);
  });

  it('rejects a non-numeric --max-files', () => {
    const r = cli(['gate-verify', 'commits', 'a..b', '--max-files', 'lots', '--style', 'free', '--attribution', 'allow']);
    expect(r.status).toBe(64);
    expect(r.stderr).toMatch(/--max-files is a non-negative integer/);
  });

  it('a value flag never eats the next flag as its value', () => {
    const r = cli(['hub', 'answer', 'demo', '--choice', '--seen', 'x']);
    expect(r.status).toBe(64);
    expect(r.stderr).toMatch(/--choice needs a value/);
  });
});
