import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureHiveSession, newWindow } from '../src/tmux.js';

const provision = readFileSync(fileURLToPath(new URL('../infra/provision-box.sh', import.meta.url)), 'utf8');
const provisionServices = provision.slice(
  provision.indexOf('systemctl enable hive-v2-tmux'),
  provision.indexOf('systemctl enable --now hive-v2-daily-scan.timer'),
).replace('/tmp/tmux-1000/hive-v2', '"$TEST_SOCKET"');
const roots: string[] = [];
const originalEnv = { ...process.env };
const envKeys = [
  'PATH', 'HIVE_TMUX_SOCKET', 'TMUX_TMPDIR', 'COMMAND_LOG', 'RUNUSER_LOG',
  'TMUX_LOG', 'SERVER_PID_LOG', 'TEST_SOCKET', 'RESTART_STATUS',
  'RESTART_REACHABLE', 'HAS_SESSION_STATUS', 'NEW_SESSION_STATUS',
];

if (!provisionServices.includes('"$TEST_SOCKET"')) throw new Error('provisioning socket substitution failed');

function harness() {
  const root = mkdtempSync(path.join(tmpdir(), 'hive-tmux-ownership-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const files = {
    commands: path.join(root, 'commands'),
    runuser: path.join(root, 'runuser'),
    tmux: path.join(root, 'tmux'),
    pids: path.join(root, 'pids'),
  };
  for (const file of Object.values(files)) writeFileSync(file, '');
  const stubs = {
    'start-server': `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const child = spawn(process.execPath, ['-e', \`
const net = require('node:net');
const server = net.createServer((socket) => socket.destroy());
server.listen(process.env.TEST_SOCKET, () => process.send('ready'));
\`], { detached: true, env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
child.once('error', (error) => { throw error; });
child.once('message', () => {
  fs.appendFileSync(process.env.SERVER_PID_LOG, String(child.pid) + '\\n');
  child.unref();
  child.disconnect();
});
`,
    sudo: `#!/bin/bash
printf '%s\\n' "$*" >> "$COMMAND_LOG"
if [ "$RESTART_REACHABLE" = yes ]; then
  start-server || exit 1
fi
exit "$RESTART_STATUS"
`,
    tmux: `#!/bin/bash
printf '%s\\n' "$*" >> "$TMUX_LOG"
case " $* " in
  *" has-session "*) exit "$HAS_SESSION_STATUS" ;;
  *" new-session "*) exit "$NEW_SESSION_STATUS" ;;
  *) exit 0 ;;
esac
`,
    systemctl: `#!/bin/bash
printf '%s\\n' "$*" >> "$COMMAND_LOG"
`,
    runuser: `#!/bin/bash
printf '%s\\n' "$*" >> "$RUNUSER_LOG"
case " $* " in
  *" display-message "*) printf '%s\\n' 4242 ;;
esac
`,
  };
  for (const [name, source] of Object.entries(stubs)) {
    const file = path.join(bin, name);
    writeFileSync(file, source);
    chmodSync(file, 0o755);
  }
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    COMMAND_LOG: files.commands,
    RUNUSER_LOG: files.runuser,
    TMUX_LOG: files.tmux,
    SERVER_PID_LOG: files.pids,
    TEST_SOCKET: path.join(root, 'hive-v2'),
    RESTART_STATUS: '0',
    RESTART_REACHABLE: 'no',
    HAS_SESSION_STATUS: '0',
    NEW_SESSION_STATUS: '0',
  };
  return { root, bin, files, env };
}

function activate(test: ReturnType<typeof harness>, socket = 'hive-v2') {
  Object.assign(process.env, test.env, {
    HIVE_TMUX_SOCKET: socket,
    TMUX_TMPDIR: test.root,
    TEST_SOCKET: path.join(test.root, socket),
  });
}

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots.splice(0)) {
    const pids = path.join(root, 'pids');
    if (existsSync(pids)) {
      for (const pid of read(pids).trim().split('\n').filter(Boolean)) {
        try {
          process.kill(Number(pid), 'SIGTERM');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe('production tmux ownership', () => {
  it('fails closed when the managed service restart fails', async () => {
    const test = harness();
    activate(test);
    process.env.RESTART_STATUS = '1';
    await expect(ensureHiveSession()).rejects.toThrow(/hive-v2-tmux/);
    await expect(newWindow('project:agent', '/tmp', 'exec sleep 1')).rejects.toThrow(/hive-v2-tmux/);
    expect(read(test.files.tmux)).toBe('');
  });

  it('fails closed when the restarted managed socket is unreachable', async () => {
    const test = harness();
    activate(test);
    await expect(ensureHiveSession()).rejects.toThrow(/unreachable after restart/);
    expect(read(test.files.tmux)).toBe('');
  });

  it('uses the managed socket when restart makes it reachable', async () => {
    const test = harness();
    activate(test);
    process.env.RESTART_REACHABLE = 'yes';
    await ensureHiveSession();
    expect(read(test.files.commands)).toContain('systemctl restart hive-v2-tmux');
    expect(read(test.files.tmux)).toContain('has-session -t hive');
    expect(read(test.files.tmux)).not.toContain('new-session');
  });

  it('keeps non-production sockets off systemd', async () => {
    const test = harness();
    activate(test, `hive-test-${process.pid}`);
    process.env.RESTART_STATUS = '1';
    process.env.HAS_SESSION_STATUS = '1';
    await ensureHiveSession();
    expect(read(test.files.commands)).toBe('');
    expect(read(test.files.tmux)).toContain('has-session -t hive');
    expect(read(test.files.tmux)).toContain('new-session -d -s hive');
  });
});

function serverCgroup(test: ReturnType<typeof harness>, service: string) {
  const directory = path.join(test.root, 'proc', '4242');
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'cgroup'), `0::/system.slice/${service}.service\n`);
}

function provisionWithLiveServer(test: ReturnType<typeof harness>) {
  const server = spawnSync(path.join(test.bin, 'start-server'), [], {
    env: test.env,
    encoding: 'utf8',
    timeout: 5_000,
  });
  expect(server.status, server.stderr).toBe(0);
  const script = provisionServices.replace('/proc/', `${test.root}/proc/`);
  return spawnSync('bash', ['-c', script], {
    env: test.env,
    encoding: 'utf8',
    timeout: 5_000,
  });
}

describe('provisioning tmux ownership', () => {
  it('keeps a managed live server and proceeds to web and watch restarts', () => {
    const test = harness();
    serverCgroup(test, 'hive-v2-tmux');
    const result = provisionWithLiveServer(test);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('managed server already up');
    expect(read(test.files.runuser)).toContain('display-message -p #{pid}');
    expect(read(test.files.commands)).toContain('restart hive-v2-web hive-v2-watch');
    expect(read(test.files.commands)).not.toContain('restart hive-v2-tmux');
  });

  it('stops before any restart when a foreign-owned server is live', () => {
    const test = harness();
    serverCgroup(test, 'hive-v2-web');
    const result = provisionWithLiveServer(test);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('foreign-owned');
    expect(result.stderr).toContain('rerun infra/provision-box.sh');
    expect(read(test.files.commands)).not.toMatch(/\brestart\b/);
    expect(read(test.files.runuser)).not.toMatch(/kill-server|new-session/);
  });
});
