import { promises as fs, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SOCK = `hive-test-${process.pid}`;
process.env.HIVE_TMUX_SOCKET = SOCK;

import { capturePane, ensureHiveSession, newWindow, paneExists, paneIdentity, sleep } from '../src/tmux.js';
import { hivePath, hubPath, readDecisions, writeJson } from '../src/state.js';
import { watchCycle } from '../src/watch.js';
import { cleanupTmuxServers } from './tmux-cleanup.js';

const DECOY_SH = `#!/bin/bash
set -euo pipefail
clear
cat "$1"
IFS= read -rsn1 ch || true
printf '%s' "$ch" > "$2"
`;

const KIMI_STUB_SH = `#!/bin/bash
printf '%s\\n' "$*" >> "\${KIMI_STUB_LOG:?}"
case "$*" in
  *deploy-prod*) echo ASK ;;
  *) echo "APPROVE decoy stub" ;;
esac
`;

function dialogText(command: string): string {
  return `────────────────────────────────────────────────────────────
  ▶ Run this command?

  cwd: /tmp
  $ ${command}

  ▶ 1. Approve once
    2. Approve for this session
    3. Reject
    4. Reject with feedback

  ↑/↓ select · 1/2/3/4 choose · ↵ confirm
────────────────────────────────────────────────────────────
`;
}

let bin = '';
let decoy = '';
let seq = 0;

beforeAll(async () => {
  await ensureHiveSession();
  bin = mkdtempSync(path.join(tmpdir(), 'hive-kimi-stub-'));
  await fs.writeFile(path.join(bin, 'kimi'), KIMI_STUB_SH, { mode: 0o755 });
  decoy = path.join(bin, 'decoy.sh');
  await fs.writeFile(decoy, DECOY_SH, { mode: 0o755 });
}, 30_000);

afterAll(() => {
  cleanupTmuxServers([SOCK]);
});

async function setupDecoy(command: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'hive-e2e-'));
  const home = path.join(root, 'demo');
  const dialog = path.join(root, 'dialog.txt');
  const answer = path.join(root, 'answer.txt');
  const stubLog = path.join(root, 'kimi-calls.log');
  await fs.mkdir(hivePath(home), { recursive: true });
  await fs.writeFile(dialog, dialogText(command));
  const pane = await newWindow(`demo:e2e-${++seq}`, root, `bash ${decoy} ${dialog} ${answer}`);
  const id = await paneIdentity(pane);
  expect(id).not.toBeNull();
  await writeJson(hubPath(root, 'projects.json'), {
    projects: [{ name: 'demo', home, repos: [], approvals: 'smart' }],
  });
  await writeJson(hivePath(home, 'team.json'), {
    agents: [{
      name: 'demo-orchestrator', orchestrator: true, pane, pane_pid: id!.pid, pane_started: id!.started,
      launch_mode: 'ask', launch_scoped_auto: false,
    }],
  });
  for (let i = 0; i < 50; i++) {
    if ((await capturePane(pane))?.includes('Run this command?')) break;
    if (i === 49) throw new Error('the decoy pane never showed the dialog');
    await sleep(100);
  }
  const env = { PATH: `${bin}:${process.env.PATH ?? ''}`, KIMI_STUB_LOG: stubLog };
  return { root, pane, answer, stubLog, env };
}

describe('smart approvals against a decoy pane', () => {
  it('approves a command the classifier approves, end to end', async () => {
    const { root, answer, stubLog, env } = await setupDecoy('python3 render_docs.py');
    await watchCycle(root, env);
    expect(await fs.readFile(answer, 'utf8')).toBe('1');
    expect(await fs.readFile(stubLog, 'utf8')).toContain('python3 render_docs.py');
    const decisions = await readDecisions(root);
    const auto = decisions.find((d) => d.by === 'watch');
    expect(auto?.summary).toContain('auto-approved "Approve once"');
    expect(auto?.summary).toContain('python3 render_docs.py');
  }, 30_000);

  it('withholds a command the classifier says ASK about', async () => {
    const { root, pane, answer, stubLog, env } = await setupDecoy('python3 deploy-prod.py');
    await watchCycle(root, env);
    expect(await fs.readFile(stubLog, 'utf8')).toContain('deploy-prod');
    expect(existsSync(answer)).toBe(false);
    expect(await paneExists(pane)).toBe(true);
    expect(await capturePane(pane)).toContain('Run this command?');
    const decisions = await readDecisions(root);
    expect(decisions.some((d) => d.summary.includes('auto-approved'))).toBe(false);
  }, 30_000);

  it('never sends a destructive command to the classifier at all', async () => {
    const { root, pane, answer, stubLog, env } = await setupDecoy('git push --force origin main');
    await watchCycle(root, env);
    expect(existsSync(stubLog)).toBe(false);
    expect(existsSync(answer)).toBe(false);
    expect(await paneExists(pane)).toBe(true);
    expect(await capturePane(pane)).toContain('Run this command?');
  }, 30_000);
});
