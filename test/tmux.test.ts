import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Tests run against private throwaway tmux servers only. The default socket
// (the user's sessions) is never touched: every tmux call carries -L.
const SOCK = `hive-test-${process.pid}`;
const DECOY_SOCK = `hive-decoy-${process.pid}`;
process.env.HIVE_TMUX_SOCKET = SOCK;

import {
  assertPane, capturePane, ensureHiveSession, killWindow, newWindow,
  paneExists, paneIdentity, sendEnter, sendEscape, sendLiteral,
  serverReachable, tmuxSocketPath,
} from '../src/tmux.js';

function raw(socket: string, args: string[]): string {
  return execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' });
}

let decoyPane = '';

beforeAll(async () => {
  await ensureHiveSession();
  // A stand-in for the user's own tmux server: a session hive-v2 must never see.
  raw(DECOY_SOCK, ['new-session', '-d', '-s', 'main', '-x', '220', '-y', '50', 'echo DECOY-CONTENT; exec sleep 600']);
  decoyPane = raw(DECOY_SOCK, ['display-message', '-p', '-t', 'main', '#{pane_id}']).trim();
}, 30_000);

afterAll(() => {
  for (const s of [SOCK, DECOY_SOCK]) {
    try {
      execFileSync('tmux', ['-L', s, 'kill-server'], { stdio: 'ignore' });
    } catch { /* already gone */ }
  }
});

describe('private socket', () => {
  it('creates the hive session on its own server only', () => {
    const sessions = raw(SOCK, ['list-sessions', '-F', '#{session_name}']).trim();
    expect(sessions).toBe('hive');
  });

  it('cannot see panes on another tmux server', async () => {
    // Same pane id or not, capture on our socket can never return the decoy's content.
    const seen = await capturePane(decoyPane);
    expect(seen === null || !seen.includes('DECOY-CONTENT')).toBe(true);
    const stillThere = raw(DECOY_SOCK, ['display-message', '-p', '-t', decoyPane, '#{pane_id}']).trim();
    expect(stillThere).toBe(decoyPane);
  });
});

describe('serverReachable', () => {
  it('sees a live server and refuses absent or stale sockets', async () => {
    expect(await serverReachable(tmuxSocketPath())).toBe(true);
    expect(await serverReachable(`/tmp/tmux-1000/no-such-${process.pid}`)).toBe(false);
    // A stale socket file (dead server) is not reachable.
    const stale = `/tmp/tmux-1000/hive-stale-${process.pid}`;
    execFileSync('touch', [stale]);
    expect(await serverReachable(stale)).toBe(false);
    execFileSync('rm', ['-f', stale]);
  });
});

describe('assertPane / killWindow', () => {
  it('killWindow refuses a stale identity and leaves the window alone', async () => {
    const pane = await newWindow('t:stale', '/tmp', 'exec sleep 600');
    const id = await paneIdentity(pane);
    expect(id).not.toBeNull();
    await expect(killWindow(pane, { pid: id!.pid + 100_000, started: 'bogus' }))
      .rejects.toThrow(/no longer the process/);
    expect(await paneExists(pane)).toBe(true);
    // The recorded identity still kills.
    await killWindow(pane, id!);
    expect(await paneExists(pane)).toBe(false);
  });

  it('refuses every mutation on a pane outside the hive session', async () => {
    raw(SOCK, ['new-session', '-d', '-s', 'not-hive', '-x', '220', '-y', '50', 'exec sleep 600']);
    const pane = raw(SOCK, ['display-message', '-p', '-t', 'not-hive', '#{pane_id}']).trim();
    const id = await paneIdentity(pane);
    expect(id).not.toBeNull();
    for (const act of [
      () => assertPane(pane),
      () => killWindow(pane, id!),
      () => sendLiteral(pane, 'x'),
      () => sendEnter(pane),
      () => sendEscape(pane),
    ]) {
      await expect(act()).rejects.toThrow(/not hive/);
    }
    // The foreign window survived.
    expect(raw(SOCK, ['display-message', '-p', '-t', pane, '#{pane_id}']).trim()).toBe(pane);
  });
});
