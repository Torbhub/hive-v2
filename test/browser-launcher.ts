import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const STARTUP_MS = 60_000;
const STDERR_CAP = 16_000;

export function chromeArguments(profile: string): string[] {
  return [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    'about:blank',
  ];
}

function sanitized(text: string, executable: string, profile: string): string {
  return text
    .replaceAll(profile, '<profile>')
    .replaceAll(executable, '<chrome>')
    .replaceAll(process.env.HOME ?? '', '<home>')
    .slice(0, STDERR_CAP);
}

export async function launchChrome(executable: string, profile: string, script?: string): Promise<{
  browser: ChildProcess;
  activePort: number;
}> {
  const browser = spawn(executable, script ? [script, ...chromeArguments(profile)] : chromeArguments(profile), {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let diagnostics = '';
  let processError: Error | undefined;
  browser.stderr?.on('data', (chunk: Buffer) => {
    diagnostics = `${diagnostics}${chunk.toString('utf8')}`.slice(0, STDERR_CAP);
  });
  browser.once('error', (error) => { processError = error; });
  const exited = once(browser, 'exit').then(([code, signal]) => ({ code, signal }));
  const failure = (code: number | null, signal: NodeJS.Signals | null, error?: Error) => new Error(
    `Chrome startup failed: ${error ? sanitized(error.message, executable, profile) : `exit code ${code}, signal ${signal}`}. ${sanitized(diagnostics, executable, profile)}`,
  );
  try {
    const deadline = Date.now() + STARTUP_MS;
    while (Date.now() < deadline) {
      const race = await Promise.race([
        fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => null),
        exited,
      ]);
      if (typeof race === 'object' && race !== null && 'code' in race) {
        throw failure(race.code, race.signal, processError);
      }
      if (processError) throw failure(null, null, processError);
      if (typeof race === 'string') {
        const activePort = Number(race.split('\n')[0]);
        if (Number.isInteger(activePort) && activePort > 0) return { browser, activePort };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw failure(null, null, processError);
  } catch (error) {
    if (browser.exitCode === null && browser.signalCode === null) browser.kill('SIGKILL');
    throw error;
  }
}
