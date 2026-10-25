import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECKS, doctor, formatSummary, runAll, type Deps } from '../src/doctor.js';
import type { RunResult } from '../src/tmux.js';

function fakeRun(responses: Record<string, Partial<RunResult>>): Deps['run'] {
  return async (cmd, args) => {
    const r = responses[`${cmd} ${args.join(' ')}`] ?? {};
    return { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
}

async function tmpRoot(withHub: boolean): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hive-doctor-'));
  if (withHub) await fs.mkdir(path.join(root, '.hive-hub'));
  return root;
}

function allGreenDeps(root: string): Deps {
  return {
    run: fakeRun({
      'tmux -V': { stdout: 'tmux 3.4\n' },
      'git --version': { stdout: 'git version 2.43.0\n' },
      'kimi --version': { stdout: 'kimi 1.0.0\n' },
      'teamkimi status': { stdout: 'up\n' },
      'systemctl is-active hive-v2-watch': { stdout: 'active\n' },
      'systemctl is-active hive-v2-web': { stdout: 'active\n' },
      'systemctl is-active hive-v2-tmux': { stdout: 'active\n' },
    }),
    socketPath: '/tmp/tmux-1000/hive-v2',
    reachable: async () => true,
    nodeVersion: 'v22.1.0',
    root,
  };
}

describe('runAll', () => {
  it('passes every check on a healthy box', async () => {
    const results = await runAll(allGreenDeps(await tmpRoot(true)));
    expect(results.map(([name]) => name)).toEqual(CHECKS.map((c) => c.name));
    for (const [, res] of results) expect(res.ok).toBe(true);
  });

  it('keeps running when a check throws, and reports it as a failure', async () => {
    const deps = allGreenDeps(await tmpRoot(true));
    deps.run = async (cmd) => {
      if (cmd === 'git') throw new Error('spawn git ENOENT');
      return { code: 0, stdout: 'active\n', stderr: '' };
    };
    const results = await runAll(deps);
    const git = results.find(([name]) => name === 'git_present')![1];
    expect(git.ok).toBe(false);
    expect(git.fix).toContain('git_present');
    expect(git.detail).toContain('ENOENT');
    for (const [name, res] of results) {
      if (name !== 'git_present') expect(res.ok).toBe(true);
    }
  });

  it('fails node_version below 20 with an install fix', async () => {
    const deps = allGreenDeps(await tmpRoot(true));
    deps.nodeVersion = 'v18.19.0';
    const node = (await runAll(deps)).find(([name]) => name === 'node_version')![1];
    expect(node.ok).toBe(false);
    expect(node.fix).toContain('Node 20');
    expect(node.detail).toContain('v18.19.0');
  });

  it('fails teamkimi_proxy when the proxy is down and names the fix', async () => {
    const deps = allGreenDeps(await tmpRoot(true));
    deps.run = fakeRun({ 'teamkimi status': { code: 1, stderr: 'connection refused\n' } });
    const proxy = (await runAll(deps)).find(([name]) => name === 'teamkimi_proxy')![1];
    expect(proxy.ok).toBe(false);
    expect(proxy.fix).toContain('teamkimi server');
    expect(proxy.detail).toContain('connection refused');
  });

  it('fails tmux_socket when nothing answers and reports the unit state', async () => {
    const deps = allGreenDeps(await tmpRoot(true));
    deps.reachable = async () => false;
    const socket = (await runAll(deps)).find(([name]) => name === 'tmux_socket')![1];
    expect(socket.ok).toBe(false);
    expect(socket.fix).toContain('sudo systemctl restart hive-v2-tmux');
    expect(socket.detail).toContain('hive-v2-tmux is active');
  });

  it('fails hub_root_writable without .hive-hub and points at hub init', async () => {
    const results = await runAll(allGreenDeps(await tmpRoot(false)));
    const hub = results.find(([name]) => name === 'hub_root_writable')![1];
    expect(hub.ok).toBe(false);
    expect(hub.fix).toContain('hive hub init');
  });

  it('fails systemd_units per unit and names only the inactive ones in the fix', async () => {
    const deps = allGreenDeps(await tmpRoot(true));
    // is-active exits non-zero for non-active units but still prints the state.
    deps.run = fakeRun({
      'systemctl is-active hive-v2-watch': { stdout: 'active\n' },
      'systemctl is-active hive-v2-web': { code: 3, stdout: 'failed\n' },
      'systemctl is-active hive-v2-tmux': { code: 4, stdout: 'inactive\n' },
    });
    const units = (await runAll(deps)).find(([name]) => name === 'systemd_units')![1];
    expect(units.ok).toBe(false);
    expect(units.fix).toContain('restart hive-v2-web hive-v2-tmux');
    expect(units.fix).not.toContain('hive-v2-watch ');
    expect(units.detail).toContain('hive-v2-web=failed');
    expect(units.detail).toContain('hive-v2-tmux=inactive');
    expect(units.detail).not.toContain('unknown');
  });
});

describe('formatSummary / doctor', () => {
  it('prints PASS/FAIL per check plus FIX lines, and counts the passes', () => {
    const out = formatSummary([
      ['alpha', { ok: true, fix: '', detail: 'fine' }],
      ['beta', { ok: false, fix: 'do the thing', detail: 'it broke' }],
    ]);
    expect(out).toContain('alpha  PASS');
    expect(out).toContain('beta   FAIL');
    expect(out).toContain('FIX: do the thing');
    expect(out).toContain('detail: it broke');
    expect(out).toContain('1/2 checks passed.');
  });

  it('exits 1 when any check fails and 0 when all pass', async () => {
    const good = allGreenDeps(await tmpRoot(true));
    expect(await doctor(good.root, good)).toBe(0);
    const sick = allGreenDeps(await tmpRoot(false));
    expect(await doctor(sick.root, sick)).toBe(1);
  });
});
