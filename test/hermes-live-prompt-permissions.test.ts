import { spawnSync } from 'node:child_process';
import { chown, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeScenarioPrompt } from '../tools/hermes-live/runner.js';

function asHermes(command: string, args: string[]) {
  return spawnSync('setpriv', ['--reuid=10000', '--regid=10000', '--clear-groups', command, ...args]);
}

describe('root-runner prompt permissions', () => {
  it('keeps root-created prompts root-owned with t01hermes group access', async () => {
    const source = await readFile(join(import.meta.dirname, '../tools/hermes-live/runner.ts'), 'utf8');
    expect(source).toContain('if (process.getuid?.() === 0) await chown(path, 0, 10000);');
  });

  it('creates an unlink-resistant group-readable prompt under umask 077', async () => {
    const previousUmask = process.umask(0o077);
    try {
      const workspace = await mkdtemp(join(tmpdir(), 't01-prompt-permissions-'));
      const prompt = await writeScenarioPrompt(workspace, 'P01', 'synthetic fixture');
      const metadata = await stat(prompt);
      expect(prompt).toBe(join(workspace, 'prompts', 'P01.prompt'));
      expect(metadata.mode & 0o777).toBe(0o440);
      expect(metadata.uid).toBe(process.getuid?.());
      expect(metadata.gid).toBe(process.getuid?.() === 0 ? 10000 : process.getgid?.());
      expect((await stat(join(workspace, 'prompts'))).mode & 0o777).toBe(0o555);
      expect(await readFile(prompt, 'utf8')).toBe('synthetic fixture');
    } finally {
      process.umask(previousUmask);
    }
  });

  const rootIt = process.getuid?.() === 0 ? it : it.skip;
  rootIt('lets UID 10000 read but not chmod, write, or unlink the prompt', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 't01-prompt-permissions-'));
    await chown(workspace, 10000, 10000);
    const prompt = await writeScenarioPrompt(workspace, 'P01', 'synthetic fixture');
    const metadata = await stat(prompt);
    expect(metadata.uid).toBe(0);
    expect(metadata.gid).toBe(10000);
    expect(metadata.mode & 0o777).toBe(0o440);
    expect(asHermes('test', ['-r', prompt]).status).toBe(0);
    expect(asHermes('chmod', ['600', prompt]).status).not.toBe(0);
    expect(asHermes('test', ['-w', prompt]).status).not.toBe(0);
    expect(asHermes('rm', ['-f', prompt]).status).not.toBe(0);
    expect((await stat(prompt)).mode & 0o777).toBe(0o440);
  });
});
