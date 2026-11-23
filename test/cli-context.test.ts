import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function cli(args: string[], cwd: string, hubRoot: string) {
  const tsx = path.join(repository, 'node_modules', '.bin', 'tsx');
  return spawnSync(tsx, [path.join(repository, 'src', 'cli.ts'), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HIVE_HUB_ROOT: hubRoot },
    timeout: 30_000,
  });
}

describe('cli hub context', () => {
  it('uses canonical HIVE_HUB_ROOT only for cleanup from a nested agent worktree', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hive-cli-context-'));
    const home = path.join(root, 'proj');
    const nested = path.join(home, 'lanes', 'agent', 'nested');
    await fs.mkdir(nested, { recursive: true });
    const initialized = cli(['hub', 'init'], root, root);
    expect(initialized.status).toBe(0);
    expect(await fs.stat(path.join(root, '.hive-hub', 'hub.json'))).toBeTruthy();
    await fs.writeFile(path.join(root, '.hive-hub', 'projects.json'), JSON.stringify({
      projects: [{ name: 'proj', home, repos: [{ folder: home }] }],
    }));

    const cleanup = cli(['cleanup', 'proj', '--dry-run'], nested, `${root}${path.sep}agent${path.sep}..`);
    expect(cleanup.status).toBe(0);
    expect(cleanup.stdout).toContain('nothing to clean for proj');

    const init = cli(['hub', 'init'], nested, root);
    expect(init.status).toBe(0);
    expect(init.stdout).toContain(`${nested}/.hive-hub`);
    expect(await fs.stat(path.join(nested, '.hive-hub', 'projects.json'))).toBeTruthy();

    const gate = cli(['gate', '--log', 'gate.log', '--', 'ok', 'true'], nested, root);
    expect(gate.status).toBe(0);
    expect(await fs.readFile(path.join(nested, 'gate.log'), 'utf8')).toContain('ok exit 0');
  });

  it('refuses cleanup from a handwritten Hub root without initialized identity', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hive-cli-uninitialized-'));
    const home = path.join(root, 'proj');
    const nested = path.join(home, 'lanes', 'agent');
    const manifest = path.join(home, '.hive', 'manifest.jsonl');
    await fs.mkdir(nested, { recursive: true });
    await fs.mkdir(path.join(root, '.hive-hub'), { recursive: true });
    await fs.writeFile(path.join(root, '.hive-hub', 'projects.json'), JSON.stringify({
      projects: [{ name: 'proj', home, repos: [{ folder: home }] }],
    }));
    await fs.mkdir(path.dirname(manifest), { recursive: true });
    const record = `${JSON.stringify({ kind: 'process', at: '2000-01-01T00:00:00.000Z', pid: 999999, started: 'old' })}\n`;
    await fs.writeFile(manifest, record);

    const cleanup = cli(['cleanup', 'proj'], nested, root);
    expect(cleanup.status).toBe(1);
    expect(cleanup.stderr).toMatch(/initialized Hub|Hub.*initialized|hub\.json/);
    expect(await fs.readFile(manifest, 'utf8')).toBe(record);
  });
});
