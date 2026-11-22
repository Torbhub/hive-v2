import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTmuxServers } from './tmux-cleanup.js';

function tmuxFailure(stderr: string): Error {
  return Object.assign(new Error(`Command failed: tmux\n${stderr}`), { status: 1, stderr });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cleanupTmuxServers', () => {
  it('ignores recognized absent-server results for main and decoy sockets', () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const kill = vi.fn((socket: string) => {
      const stderr = socket === 'hive-test-main'
        ? `no server running on /tmp/tmux-1000/${socket}`
        : `error connecting to /tmp/tmux-1000/${socket} (No such file or directory)`;
      throw tmuxFailure(stderr);
    });

    expect(() => cleanupTmuxServers(['hive-test-main', 'hive-test-decoy'], kill)).not.toThrow();

    expect(kill).toHaveBeenNthCalledWith(1, 'hive-test-main');
    expect(kill).toHaveBeenNthCalledWith(2, 'hive-test-decoy');
    expect(report).not.toHaveBeenCalled();
  });

  it.each([
    ['missing tmux binary', Object.assign(new Error('spawnSync tmux ENOENT'), { code: 'ENOENT' })],
    ['permission failure', tmuxFailure('error connecting to /tmp/tmux-1000/hive-test-main (Permission denied)')],
    ['unexpected failure', new Error('tmux cleanup exploded')],
  ])('reports a %s without throwing', (_name, failure) => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const kill = vi.fn(() => {
      throw failure;
    });

    expect(() => cleanupTmuxServers(['hive-test-main'], kill)).not.toThrow();

    expect(report).toHaveBeenCalledWith('tmux cleanup failed for private socket hive-test-main', failure);
  });

  it('keeps an earlier failure primary and continues to the decoy socket', () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const earlier = new Error('original assertion failed');
    const cleanupFailure = new Error('main cleanup failed');
    const kill = vi.fn((socket: string) => {
      if (socket === 'hive-test-main') throw cleanupFailure;
    });
    let thrown: unknown;

    try {
      try {
        throw earlier;
      } finally {
        cleanupTmuxServers(['hive-test-main', 'hive-test-decoy'], kill);
      }
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(earlier);
    expect(kill).toHaveBeenNthCalledWith(1, 'hive-test-main');
    expect(kill).toHaveBeenNthCalledWith(2, 'hive-test-decoy');
    expect(report).toHaveBeenCalledWith('tmux cleanup failed for private socket hive-test-main', cleanupFailure);
  });
});
