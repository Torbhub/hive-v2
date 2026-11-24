import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = path.join(ROOT, 'infra', 'question-guard.mjs');
const MERGE = path.join(ROOT, 'infra', 'merge-question-hook.py');

describe('Hive question guard', () => {
  it('blocks native questions only for Hive agents', () => {
    expect(spawnSync(GUARD, {
      env: { ...process.env, HIVE_AGENT: 'builder' }, stdio: 'pipe',
    }).status).toBe(2);
    expect(execFileSync(GUARD, { env: { ...process.env, HIVE_AGENT: '' }, stdio: 'pipe' })).toHaveLength(0);
  });

  it('blocks local ffmpeg commands only for Hive agents', () => {
    const runBash = (command: string, agent = 'builder') => spawnSync(GUARD, {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      env: { ...process.env, HIVE_AGENT: agent }, stdio: 'pipe',
    });
    for (const command of [
      'ffmpeg -i input.mov output.mp4',
      'sudo /usr/bin/ffmpeg -i input.mov output.mp4',
      'printf start && ffmpeg -i input.mov output.mp4',
      'printf start\nffmpeg -i input.mov output.mp4',
      "bash -lc 'ffmpeg -i input.mov output.mp4'",
    ]) {
      const result = runBash(command);
      expect(result.status).toBe(2);
      expect(result.stderr.toString()).toContain('Rent a compute machine');
    }
    expect(runBash('printf ok').status).toBe(0);
    expect(runBash('ffmpeg -i input.mov output.mp4', '').status).toBe(0);
  });
});

describe('question hook provisioning', () => {
  it('preserves existing config and is idempotent', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hive-question-hook-'));
    const file = path.join(root, 'config.toml');
    const original = 'default_model = "kimi-code/k3.1-pro"\n\n[[permission.rules]]\ndecision = "allow"\npattern = "Read"\n';
    writeFileSync(file, original);
    execFileSync(MERGE, [file]);
    const merged = readFileSync(file, 'utf8');
    expect(merged).toContain(original);
    expect(merged).toContain('matcher = "AskUserQuestion"');
    expect(merged).toContain('matcher = "Bash"');
    expect(merged).toContain('command = "/opt/node22/bin/node /opt/hive-v2/question-guard.mjs"');
    execFileSync(MERGE, [file]);
    expect(readFileSync(file, 'utf8')).toBe(merged);
  });

  it('refuses inline hooks arrays without making config invalid', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hive-question-hook-inline-'));
    const file = path.join(root, 'config.toml');
    writeFileSync(file, 'hooks = []\n');
    expect(() => execFileSync(MERGE, [file], { stdio: 'pipe' })).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('hooks = []\n');
  });

  it('refuses malformed config without changing it', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hive-question-hook-bad-'));
    const file = path.join(root, 'config.toml');
    writeFileSync(file, 'not = [valid\n');
    expect(() => execFileSync(MERGE, [file], { stdio: 'pipe' })).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('not = [valid\n');
  });
});
