import { promises as fs, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/tmux.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/tmux.js')>();
  return {
    ...orig,
    paneExists: vi.fn(async () => true),
    paneIdentity: vi.fn(async () => ({ pid: 9, started: 'z' })),
    paneIs: vi.fn(async () => true),
    sendEscape: vi.fn(async () => {}),
  };
});

import { interruptAgent, interruptLine } from '../src/interrupt.js';
import { hivePath, hubPath, readDecisions, writeJson, writePendingPane } from '../src/state.js';
import { paneExists, paneIdentity, paneIs, sendEscape } from '../src/tmux.js';

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'hive-interrupt-'));
  const home = path.join(root, 'demo');
  await fs.mkdir(home, { recursive: true });
  await writeJson(hubPath(root, 'projects.json'), {
    projects: [{ name: 'demo', home, repos: [{ folder: home }] }],
  });
  return { root, home };
}

async function setupTeam() {
  const { root, home } = await setup();
  await writeJson(hivePath(home, 'team.json'), {
    agents: [
      { name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 1, pane_started: 'x' },
      { name: 'builder', pane: '%2', pane_pid: 2, pane_started: 'y' },
    ],
  });
  return root;
}

beforeEach(() => {
  vi.mocked(paneExists).mockClear().mockImplementation(async () => true);
  vi.mocked(paneIdentity).mockClear().mockImplementation(async () => ({ pid: 9, started: 'z' }));
  vi.mocked(paneIs).mockClear().mockImplementation(async () => true);
  vi.mocked(sendEscape).mockClear();
});

describe('interruptAgent', () => {
  it('targets the orchestrator by default and verifies identity before the key lands', async () => {
    const root = await setupTeam();
    const events: string[] = [];
    vi.mocked(paneIs).mockImplementation(async () => {
      events.push('check');
      return true;
    });
    vi.mocked(sendEscape).mockImplementation(async () => {
      events.push('escape');
    });
    const r = await interruptAgent(root, 'demo');
    expect(r).toEqual({ target: 'demo-orchestrator', pane: '%1' });
    expect(vi.mocked(paneIs).mock.calls).toEqual([['%1', { pid: 1, started: 'x' }]]);
    expect(vi.mocked(sendEscape).mock.calls).toEqual([['%1', { pid: 1, started: 'x' }]]);
    expect(events).toEqual(['check', 'escape']);
  });

  it('a named agent interrupts its own pane', async () => {
    const root = await setupTeam();
    const r = await interruptAgent(root, 'demo', 'builder');
    expect(r).toEqual({ target: 'builder', pane: '%2' });
    expect(vi.mocked(sendEscape).mock.calls).toEqual([['%2', { pid: 2, started: 'y' }]]);
  });

  it('a bare name matching two agents refuses, never guesses', async () => {
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [
        { name: 'builder', pane: '%1', pane_pid: 1, pane_started: 'x', worktree: '/wt/a' },
        { name: 'builder', pane: '%2', pane_pid: 2, pane_started: 'y', worktree: '/wt/b' },
      ],
    });
    await expect(interruptAgent(root, 'demo', 'builder')).rejects.toThrow(/say which/);
    const r = await interruptAgent(root, 'demo', 'builder@/wt/b');
    expect(r.pane).toBe('%2');
  });

  it('logs an owner decision', async () => {
    const root = await setupTeam();
    await interruptAgent(root, 'demo', 'builder');
    const decisions = await readDecisions(root);
    expect(decisions[0]).toMatchObject({ by: 'owner', project: 'demo', summary: 'interrupted builder' });
  });

  it('refuses an unknown project', async () => {
    const root = await setupTeam();
    await expect(interruptAgent(root, 'nope')).rejects.toThrow(/unknown project/);
  });

  it('refuses an unknown agent', async () => {
    const root = await setupTeam();
    await expect(interruptAgent(root, 'demo', 'ghost')).rejects.toThrow(/no agent named ghost/);
  });

  it('refuses a dead pane before any key is sent', async () => {
    const root = await setupTeam();
    vi.mocked(paneExists).mockImplementation(async () => false);
    await expect(interruptAgent(root, 'demo')).rejects.toThrow(/no live pane/);
    expect(vi.mocked(paneIs).mock.calls).toEqual([]);
    expect(vi.mocked(sendEscape).mock.calls).toEqual([]);
  });

  it('refuses a pane whose identity changed', async () => {
    const root = await setupTeam();
    vi.mocked(paneIs).mockImplementation(async () => false);
    await expect(interruptAgent(root, 'demo')).rejects.toThrow(/no longer the recorded session/);
    expect(vi.mocked(sendEscape).mock.calls).toEqual([]);
  });

  it('a starting orchestrator is reached through its pending pane', async () => {
    const { root } = await setup();
    await writePendingPane(root, 'demo', { pane: '%5', kind: 'start', at: new Date().toISOString() });
    const r = await interruptAgent(root, 'demo');
    expect(r).toEqual({ target: 'demo-orchestrator', pane: '%5' });
    // A pending pane carries no recorded identity, so the live one is read.
    expect(vi.mocked(paneIdentity).mock.calls).toEqual([['%5']]);
    expect(vi.mocked(sendEscape).mock.calls).toEqual([['%5', { pid: 9, started: 'z' }]]);
  });
});

describe('interruptLine', () => {
  it('prints one line for the CLI', async () => {
    const root = await setupTeam();
    expect(await interruptLine(root, 'demo')).toBe('hive: interrupted demo-orchestrator (pane %1)');
  });
});
