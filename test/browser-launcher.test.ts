import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chromeArguments, launchChrome } from './browser-launcher.js';

const roots: string[] = [];
const children: { kill: () => void }[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'chrome-launcher-test-'));
  roots.push(directory);
  return directory;
}

describe('Chrome launcher', () => {
  it('disables unused GPU initialization in the test browser', () => {
    expect(chromeArguments('/tmp/profile')).toContain('--disable-gpu');
  });

  it('fails immediately with sanitized stderr when the browser exits before DevTools starts', async () => {
    const directory = await root();
    const script = path.join(directory, 'fail.mjs');
    await fs.writeFile(script, `console.error('startup failed for ${directory}'); process.exit(23);`);
    const started = Date.now();
    await expect(launchChrome(process.execPath, directory, script)).rejects.toThrow(/exit code 23/);
    expect(Date.now() - started).toBeLessThan(2_000);
    await expect(launchChrome(process.execPath, directory, script)).rejects.toThrow('<profile>');
    await expect(launchChrome(process.execPath, directory, script)).rejects.not.toThrow(directory);
  });

  it('allows DevTools to become ready after 30 seconds', async () => {
    const realNow = Date.now.bind(Date);
    const started = realNow();
    const clock = vi.spyOn(Date, 'now').mockImplementation(
      () => started + (realNow() - started) * 50,
    );
    try {
      const directory = await root();
      const script = path.join(directory, 'slow.mjs');
      await fs.writeFile(script, `
        import fs from 'node:fs';
        import path from 'node:path';
        const profile = path.dirname(process.argv[1]);
        setTimeout(() => {
          fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), '12345\\n');
        }, 800);
        setInterval(() => {}, 1000);
      `);
      const launched = await launchChrome(process.execPath, directory, script);
      children.push(launched.browser);
      expect(launched.activePort).toBe(12345);
    } finally {
      clock.mockRestore();
    }
  });

  it('returns the active DevTools port after a valid startup', async () => {
    const directory = await root();
    const script = path.join(directory, 'ready.mjs');
    await fs.writeFile(script, `
      import fs from 'node:fs';
      import path from 'node:path';
      const profile = path.dirname(process.argv[1]);
      fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), '12345\\n');
      setInterval(() => {}, 1000);
    `);
    const launched = await launchChrome(process.execPath, directory, script);
    children.push(launched.browser);
    expect(launched.activePort).toBe(12345);
  });
});
