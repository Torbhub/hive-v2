import { execFile } from 'node:child_process';

export const HIVE_SESSION = 'hive';

export type RunResult = { code: number; stdout: string; stderr: string };

export function run(cmd: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function tmux(args: string[]): Promise<RunResult> {
  return run('tmux', args);
}

export async function ensureHiveSession(): Promise<void> {
  const probe = await tmux(['has-session', '-t', HIVE_SESSION]);
  if (probe.code !== 0) {
    const made = await tmux(['new-session', '-d', '-s', HIVE_SESSION, '-n', 'hive', '-x', '220', '-y', '50']);
    if (made.code !== 0) throw new Error(`tmux: cannot create session ${HIVE_SESSION}: ${made.stderr.trim()}`);
  }
}

export function windowName(project: string, agent: string): string {
  return `${project}:${agent}`;
}

export async function newWindow(name: string, cwd: string, shellCommand: string): Promise<string> {
  await ensureHiveSession();
  const r = await tmux([
    'new-window', '-t', HIVE_SESSION, '-n', name, '-c', cwd,
    '-P', '-F', '#{pane_id}', shellCommand,
  ]);
  if (r.code !== 0) throw new Error(`tmux: cannot open window ${name}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

export async function killWindow(pane: string): Promise<void> {
  await tmux(['kill-window', '-t', pane]);
}

export async function paneExists(pane: string): Promise<boolean> {
  const r = await tmux(['display-message', '-p', '-t', pane, '#{pane_id}']);
  return r.code === 0 && r.stdout.trim() === pane;
}

export async function capturePane(pane: string, ansi = false): Promise<string | null> {
  const args = ['capture-pane', '-p'];
  if (ansi) args.push('-e');
  args.push('-t', pane);
  const r = await tmux(args);
  return r.code === 0 ? r.stdout : null;
}

export type PaneIdentity = { pid: number; started: string };

export async function paneIdentity(pane: string): Promise<PaneIdentity | null> {
  const r = await tmux(['display-message', '-p', '-t', pane, '#{pane_pid}']);
  const pid = Number(r.stdout.trim());
  if (r.code !== 0 || !pid) return null;
  const started = await processStartTime(pid);
  return started ? { pid, started } : null;
}

export async function paneIs(pane: string, id: PaneIdentity | null | undefined): Promise<boolean> {
  if (!id) return false;
  const cur = await paneIdentity(pane);
  return cur !== null && cur.pid === id.pid && cur.started === id.started;
}

// LC_ALL=C pins the ps date format so a stored start time compares byte-for-byte.
export async function processStartTime(pid: number): Promise<string | null> {
  const r = await run('ps', ['-o', 'lstart=', '-p', String(pid)], undefined, { ...process.env, LC_ALL: 'C' });
  const started = r.stdout.trim();
  return r.code === 0 && started ? started : null;
}

export async function sendLiteral(pane: string, text: string): Promise<void> {
  const r = await tmux(['send-keys', '-t', pane, '-l', text]);
  if (r.code !== 0) throw new Error(`tmux: cannot type into ${pane}: ${r.stderr.trim()}`);
}

export async function sendEnter(pane: string): Promise<void> {
  await tmux(['send-keys', '-t', pane, 'Enter']);
}

export async function sendEscape(pane: string): Promise<void> {
  await tmux(['send-keys', '-t', pane, 'Escape']);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
