import { execFileSync } from 'node:child_process';
import { promises as fs, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Decoy-pane e2e: a real tmux pane plays a fake approval dialog,
// the real watchCycle detects it, calls the classifier, and answers the pane.
// Only the `kimi` binary is a stub on PATH — dialog scraping, classification
// plumbing, and the pane answer are the shipping code.
const SOCK = `hive-test-${process.pid}`;
process.env.HIVE_TMUX_SOCKET = SOCK;

import { capturePane, ensureHiveSession, newWindow, paneExists, paneIdentity, sleep } from '../src/tmux.js';
import { hivePath, hubPath, readDecisions, writeJson } from '../src/state.js';
import { watchCycle } from '../src/watch.js';

// The decoy shows the dialog, waits for one key, records it, and exits —
// an answered dialog's pane closes, an unanswered one keeps waiting on read.
const DECOY_SH = `#!/bin/bash
set -euo pipefail
clear
cat "$1"
IFS= read -rsn1 ch || true
printf '%s' "$ch" > "$2"
`;

// Answers ASK to anything that looks like a deploy, APPROVE to the rest.
// Every call is logged so tests can prove the classifier was (not) invoked.
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
  try {
    execFileSync('tmux', ['-L', SOCK, 'kill-server'], { stdio: 'ignore' });
  } catch { /* already gone */ }
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
    agents: [{ name: 'demo-orchestrator', orchestrator: true, pane, pane_pid: id!.pid, pane_started: id!.started }],
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
    const { root, answer, stubLog, env } = await setupDecoy('make docs');
    await watchCycle(root, env);
    expect(await fs.readFile(answer, 'utf8')).toBe('1');
    expect(await fs.readFile(stubLog, 'utf8')).toContain('make docs');
    const decisions = await readDecisions(root);
    const auto = decisions.find((d) => d.by === 'watch');
    expect(auto?.summary).toContain('auto-approved "Approve once"');
    expect(auto?.summary).toContain('make docs');
  }, 30_000);

  it('withholds a command the classifier says ASK about', async () => {
    const { root, pane, answer, stubLog, env } = await setupDecoy('make deploy-prod');
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
