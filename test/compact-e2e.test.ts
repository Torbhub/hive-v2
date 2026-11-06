import { execFileSync } from 'node:child_process';
import { mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const SOCKET = `hive-compact-test-${process.pid}`;
process.env.HIVE_TMUX_SOCKET = SOCKET;

vi.mock('../src/death-bundle.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/death-bundle.js')>();
  return { ...orig, wireActivityAt: vi.fn(async () => NOW - 30 * 60_000) };
});

import { maybeCompact } from '../src/compact.js';
import { hivePath, hubPath, readDecisions, readTeam, writeJson } from '../src/state.js';
import { capturePane, ensureHiveSession, newWindow, paneIdentity, sleep } from '../src/tmux.js';

async function waitForText(pane: string, text: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if ((await capturePane(pane))?.includes(text)) return;
    if (i === 49) throw new Error(`decoy never showed ${text}`);
    await sleep(100);
  }
}

const DECOY = `#!/bin/bash
set -euo pipefail
clear
cat "$1"
IFS= read -r line
printf '%s' "$line" > "$2"
clear
if [ "\${3:-}" = compact ]; then
  printf '⠼ Compacting context…\\nworking\\n'
else
  printf 'done\\n│ > \\n'
fi
sleep 30
`;

beforeAll(async () => {
  await ensureHiveSession();
}, 30_000);

afterAll(() => {
  try {
    execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' });
  } catch { /* already gone */ }
});

describe('auto-compaction against a decoy pane', () => {
  it('delivers one preservation command to a busy Hive worker', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hive-compact-e2e-'));
    const home = path.join(root, 'demo');
    const bin = path.join(root, 'bin');
    await fs.mkdir(hivePath(home), { recursive: true });
    await fs.mkdir(bin);
    const decoy = path.join(bin, 'decoy.sh');
    const initial = path.join(root, 'initial.txt');
    const output = path.join(root, 'command.txt');
    await fs.writeFile(decoy, DECOY, { mode: 0o755 });
    await fs.writeFile(initial, '⠼ thinking…\nworking\n');
    const pane = await newWindow('demo:compact-e2e', root, `bash ${decoy} ${initial} ${output}`);
    const identity = await paneIdentity(pane);
    expect(identity).not.toBeNull();
    await writeJson(hubPath(root, 'projects.json'), { projects: [{ name: 'demo', home, repos: [] }] });
    const agent = {
      name: 'builder', pane, pane_pid: identity!.pid, pane_started: identity!.started, session_id: 'session_e2e',
    };
    await writeJson(hivePath(home, 'team.json'), { agents: [agent] });
    await waitForText(pane, 'thinking');

    await maybeCompact(root, 'demo', agent, { now: NOW });

    expect(await fs.readFile(output, 'utf8')).toMatch(/^\/compact Preserve the active objective/);
    expect((await readTeam(home)).agents[0].compaction).toMatchObject({ status: 'queued', attempts: 1 });
    expect((await readDecisions(root)).some((d) => d.summary === 'queued auto-compaction for demo/builder')).toBe(true);
  }, 30_000);

  it('selects compact in the real Kimi 2.5.1 cursor dialog', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hive-cache-e2e-'));
    const home = path.join(root, 'demo');
    const bin = path.join(root, 'bin');
    await fs.mkdir(hivePath(home), { recursive: true });
    await fs.mkdir(bin);
    const decoy = path.join(bin, 'decoy.sh');
    const output = path.join(root, 'answer.txt');
    await fs.writeFile(decoy, DECOY, { mode: 0o755 });
    const initial = path.join(import.meta.dirname, 'fixtures', 'dialog-cache-expiry-2.5.1.txt');
    const pane = await newWindow('demo:cache-e2e', root, `bash ${decoy} ${initial} ${output} compact`);
    const identity = await paneIdentity(pane);
    expect(identity).not.toBeNull();
    await writeJson(hubPath(root, 'projects.json'), { projects: [{ name: 'demo', home, repos: [] }] });
    const agent = {
      name: 'builder', pane, pane_pid: identity!.pid, pane_started: identity!.started,
      session_id: 'session_cache', worktree: '/lane',
    };
    await writeJson(hivePath(home, 'team.json'), { agents: [agent] });
    await waitForText(pane, 'Cache expired');

    await maybeCompact(root, 'demo', agent, { now: NOW });

    expect(await fs.readFile(output, 'utf8')).toBe('');
    expect((await readTeam(home)).agents[0].compaction).toMatchObject({ status: 'submitted', attempts: 1 });
  }, 30_000);
});
