import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { run, serverReachable, tmuxSocketPath, type RunResult } from './tmux.js';
import { HUB_DIR } from './state.js';

export type CheckResult = { ok: boolean; fix: string; detail: string };

export type Deps = {
  run: (cmd: string, args: string[]) => Promise<RunResult>;
  socketPath: string;
  reachable: (socket: string) => Promise<boolean>;
  nodeVersion: string;
  root: string;
};

export type Check = { name: string; fn: (deps: Deps) => Promise<CheckResult> };

const ok = (detail: string): CheckResult => ({ ok: true, fix: '', detail });
const bad = (fix: string, detail: string): CheckResult => ({ ok: false, fix, detail });

const UNITS = ['hive-v2-watch', 'hive-v2-web', 'hive-v2-tmux'];
const MIN_NODE_MAJOR = 20;
// A wedged command (teamkimi status) must not hang the preflight.
const RUN_TIMEOUT_MS = 15_000;

async function checkTmux(deps: Deps): Promise<CheckResult> {
  const r = await deps.run('tmux', ['-V']);
  if (r.code !== 0) {
    return bad('install tmux (sudo apt install tmux), then re-run `hive doctor`.', r.stderr.trim());
  }
  return ok(r.stdout.trim());
}

async function checkGit(deps: Deps): Promise<CheckResult> {
  const r = await deps.run('git', ['--version']);
  if (r.code !== 0) {
    return bad('install git (sudo apt install git), then re-run `hive doctor`.', r.stderr.trim());
  }
  return ok(r.stdout.trim());
}

async function checkKimi(deps: Deps): Promise<CheckResult> {
  const r = await deps.run('kimi', ['--version']);
  if (r.code !== 0) {
    return bad('install the kimi CLI and put `kimi` on PATH, then re-run `hive doctor`.', r.stderr.trim());
  }
  return ok(r.stdout.trim() || 'kimi on PATH');
}

async function checkProxy(deps: Deps): Promise<CheckResult> {
  const r = await deps.run('teamkimi', ['status']);
  if (r.code !== 0) {
    return bad(
      'the teamkimi proxy is down. Start it (teamkimi server), then re-run `hive doctor`. hive spawns nothing without it.',
      r.stderr.trim(),
    );
  }
  return ok('teamkimi proxy answering');
}

async function checkNode(deps: Deps): Promise<CheckResult> {
  const major = Number(deps.nodeVersion.replace(/^v/, '').split('.')[0]);
  if (!Number.isInteger(major) || major < MIN_NODE_MAJOR) {
    return bad(
      `install Node ${MIN_NODE_MAJOR} or newer (the build needs 22), then re-run \`hive doctor\`.`,
      `node is ${deps.nodeVersion}`,
    );
  }
  return ok(`node ${deps.nodeVersion}`);
}

async function checkSocket(deps: Deps): Promise<CheckResult> {
  if (await deps.reachable(deps.socketPath)) return ok(`server answering on ${deps.socketPath}`);
  const unit = await deps.run('systemctl', ['is-active', 'hive-v2-tmux']);
  const state = unit.stdout.trim() || `systemctl failed: ${unit.stderr.trim()}`;
  return bad(
    'start the tmux server through its unit: sudo systemctl restart hive-v2-tmux (sudoers provisioned), then re-run `hive doctor`. A server born outside the unit dies with the next deploy.',
    `no server on ${deps.socketPath}. hive-v2-tmux is ${state}.`,
  );
}

async function checkHubRoot(deps: Deps): Promise<CheckResult> {
  const hubDir = path.join(deps.root, HUB_DIR);
  try {
    await fs.access(hubDir, constants.W_OK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return bad('record this folder as your hub root: run `hive hub init` here, then re-run `hive doctor`.', `no ${hubDir}`);
    }
    return bad(`make ${hubDir} writable for this user, then re-run \`hive doctor\`.`, String(e));
  }
  return ok(`${hubDir} writable`);
}

async function checkUnits(deps: Deps): Promise<CheckResult> {
  const states: string[] = [];
  const down: string[] = [];
  for (const unit of UNITS) {
    const r = await deps.run('systemctl', ['is-active', unit]);
    // is-active exits 3/4 for inactive/failed/missing units while still
    // printing the state on stdout — only an empty stdout means no answer.
    const state = r.stdout.trim() || `unknown (${r.stderr.trim() || 'systemctl failed'})`;
    states.push(`${unit}=${state}`);
    if (state !== 'active') down.push(unit);
  }
  if (down.length > 0) {
    return bad(
      `restart the inactive units: sudo systemctl restart ${down.join(' ')}, then re-run \`hive doctor\`. The units are provisioned by infra/provision-box.sh.`,
      states.join(', '),
    );
  }
  return ok(states.join(', '));
}

export const CHECKS: Check[] = [
  { name: 'tmux_present', fn: checkTmux },
  { name: 'git_present', fn: checkGit },
  { name: 'kimi_present', fn: checkKimi },
  { name: 'teamkimi_proxy', fn: checkProxy },
  { name: 'node_version', fn: checkNode },
  { name: 'tmux_socket', fn: checkSocket },
  { name: 'hub_root_writable', fn: checkHubRoot },
  { name: 'systemd_units', fn: checkUnits },
];

// One failing check never aborts the loop: any throw becomes a precise FAIL.
async function runCheck(check: Check, deps: Deps): Promise<CheckResult> {
  try {
    return await check.fn(deps);
  } catch (e) {
    return bad(
      `${check.name}: unexpected error. Read the detail, fix the cause, then re-run \`hive doctor\`.`,
      e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 200) : String(e).slice(0, 200),
    );
  }
}

export async function runAll(deps: Deps): Promise<[string, CheckResult][]> {
  const out: [string, CheckResult][] = [];
  for (const check of CHECKS) out.push([check.name, await runCheck(check, deps)]);
  return out;
}

export function formatSummary(results: [string, CheckResult][]): string {
  const width = Math.max('CHECK'.length, ...results.map(([name]) => name.length));
  const lines = ['', 'doctor summary', '='.repeat(width + 30), `${'CHECK'.padEnd(width)}  RESULT`, `${'-'.repeat(width)}  ------`];
  let passed = 0;
  for (const [name, res] of results) {
    if (res.ok) passed++;
    lines.push(`${name.padEnd(width)}  ${res.ok ? 'PASS' : 'FAIL'}`);
  }
  lines.push('');
  for (const [name, res] of results) {
    if (res.ok) continue;
    lines.push(`[FAIL] ${name}`);
    if (res.fix) lines.push(`       FIX: ${res.fix}`);
    if (res.detail) lines.push(`       detail: ${res.detail}`);
  }
  lines.push('', `${passed}/${results.length} checks passed.`);
  return lines.join('\n');
}

export function makeDeps(root: string): Deps {
  return {
    run: (cmd, args) => run(cmd, args, undefined, undefined, RUN_TIMEOUT_MS),
    socketPath: tmuxSocketPath(),
    reachable: serverReachable,
    nodeVersion: process.version,
    root,
  };
}

export async function doctor(root: string, deps: Deps = makeDeps(root)): Promise<number> {
  const results = await runAll(deps);
  console.log(formatSummary(results));
  return results.every(([, res]) => res.ok) ? 0 : 1;
}
