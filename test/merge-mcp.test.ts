import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCRIPT = fileURLToPath(new URL('../infra/merge-mcp.mjs', import.meta.url));

function run(file: string): void {
  execFileSync(process.execPath, [SCRIPT, file], { stdio: 'pipe' });
}

function tmp(name: string): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'hive-merge-mcp-')), name);
}

describe('merge-mcp', () => {
  it('creates a missing file and parent with only the hive server', () => {
    const file = tmp('nested/dir/mcp.json');
    run(file);
    const config = JSON.parse(readFileSync(file, 'utf8'));
    expect(config.mcpServers['hive-operator']).toEqual({
      command: '/usr/local/bin/hive', args: ['mcp'], toolTimeoutMs: 604800000,
    });
  });

  it('replaces a stale hive entry and preserves every other field', () => {
    const file = tmp('mcp.json');
    writeFileSync(file, JSON.stringify({
      theme: 'dark',
      mcpServers: {
        'chrome-devtools': { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] },
        'hive-operator': { command: '/old/hive', args: ['mcp'] },
      },
    }));
    run(file);
    const config = JSON.parse(readFileSync(file, 'utf8'));
    expect(config.theme).toBe('dark');
    expect(config.mcpServers['chrome-devtools'].command).toBe('npx');
    expect(config.mcpServers['hive-operator'].command).toBe('/usr/local/bin/hive');
    expect(config.mcpServers['hive-operator'].toolTimeoutMs).toBe(604800000);
  });

  it('a second run is byte-identical', () => {
    const file = tmp('mcp.json');
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
    run(file);
    const once = readFileSync(file, 'utf8');
    run(file);
    expect(readFileSync(file, 'utf8')).toBe(once);
  });

  it('malformed JSON fails without writing', () => {
    const file = tmp('mcp.json');
    writeFileSync(file, '{broken');
    expect(() => run(file)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('{broken');
  });

  it('a non-object mcpServers fails without writing', () => {
    const file = tmp('mcp.json');
    writeFileSync(file, '{"mcpServers": []}');
    expect(() => run(file)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('{"mcpServers": []}');
  });

  it('a symlinked config is refused and the target stays untouched', () => {
    const file = tmp('mcp.json');
    const real = tmp('real.json');
    writeFileSync(real, '{"mcpServers":{}}');
    symlinkSync(real, file);
    expect(() => run(file)).toThrow();
    expect(readFileSync(real, 'utf8')).toBe('{"mcpServers":{}}');
  });

  it('a malformed config error never echoes the source', () => {
    const file = tmp('mcp.json');
    writeFileSync(file, '{"key":"SECRET123", broken');
    try {
      run(file);
      expect.unreachable('the merge must fail');
    } catch (e) {
      const output = String((e as { stderr?: Buffer }).stderr ?? e);
      expect(output).not.toContain('SECRET123');
    }
    expect(readFileSync(file, 'utf8')).toBe('{"key":"SECRET123", broken');
  });

  it('a null mcpServers fails without writing', () => {
    const file = tmp('mcp.json');
    writeFileSync(file, '{"mcpServers": null}');
    expect(() => run(file)).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('{"mcpServers": null}');
  });

  it('the existing file mode survives the process umask', () => {
    const file = tmp('mcp.json');
    writeFileSync(file, '{"mcpServers":{}}', { mode: 0o666 });
    chmodSync(file, 0o666);
    run(file);
    expect(statSync(file).mode & 0o777).toBe(0o666);
  });

  it('a missing argument fails instead of writing somewhere unexpected', () => {
    expect(() => execFileSync(process.execPath, [SCRIPT], { stdio: 'pipe' })).toThrow();
    expect(existsSync(path.join(process.cwd(), 'undefined'))).toBe(false);
  });
});
