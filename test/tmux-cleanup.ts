import { execFileSync } from 'node:child_process';

type KillServer = (socket: string) => void;

function killServer(socket: string): void {
  execFileSync('tmux', ['-L', socket, 'kill-server'], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

function isAbsentServer(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('status' in error) || error.status !== 1 || !('stderr' in error)) {
    return false;
  }
  const stderr = String(error.stderr).trim();
  return /^no server running on .+$/.test(stderr)
    || /^error connecting to .+ \(No such file or directory\)$/.test(stderr);
}

export function cleanupTmuxServers(sockets: string[], kill: KillServer = killServer): void {
  for (const socket of sockets) {
    try {
      kill(socket);
    } catch (error) {
      if (isAbsentServer(error)) continue;
      console.error(`tmux cleanup failed for private socket ${socket}`, error);
    }
  }
}
