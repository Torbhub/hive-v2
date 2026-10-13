import { promises as fs, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const DIALOG = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dialog-permission.txt'),
  'utf8',
);

vi.mock('../src/tmux.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/tmux.js')>();
  return {
    ...orig,
    paneExists: vi.fn(async () => true),
    capturePane: vi.fn(async () => DIALOG),
    sleep: vi.fn(async () => {}),
    sendEnter: vi.fn(async () => {}),
    sendEscape: vi.fn(async () => {}),
    sendArrow: vi.fn(async () => {}),
    sendLiteral: vi.fn(async () => {}),
  };
});

import { capturePane, sendArrow, sendEnter } from '../src/tmux.js';
import { answerDialog, hubAdd, hubInit, hubTask, menuKeys, readDialogFor, startProject } from '../src/hub.js';
import { lines, parseDialog } from '../src/screen.js';
import { writeJson, hivePath } from '../src/state.js';

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'hive-hub-'));
  const home = path.join(root, 'demo');
  await fs.mkdir(home, { recursive: true });
  await hubInit(root);
  await hubAdd(root, 'demo', home);
  return { root, home };
}

describe('hubTask', () => {
  it('allocates distinct ids under a concurrent storm', async () => {
    const { root } = await setup();
    const ids = await Promise.all([
      hubTask(root, 'demo', 'first'),
      hubTask(root, 'demo', 'second'),
      hubTask(root, 'demo', 'third'),
    ]);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^demo-\d+$/);
  });
});

describe('startProject task id', () => {
  it('rejects a traversal-shaped id before anything runs', async () => {
    const { root } = await setup();
    await expect(startProject(root, 'demo', '../../x')).rejects.toThrow(/task id/);
    await expect(startProject(root, 'demo', 'other-1')).rejects.toThrow(/task id/);
  });
  it('rejects a well-formed id with no task file', async () => {
    const { root } = await setup();
    await expect(startProject(root, 'demo', 'demo-99')).rejects.toThrow(/no task file/);
  });
});

describe('readDialogFor same-named agents', () => {
  async function setupTwins() {
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [
        { name: 'builder', pane: '%1', pane_pid: 11, pane_started: 'a', worktree: '/wt/a' },
        { name: 'builder', pane: '%2', pane_pid: 22, pane_started: 'b', worktree: '/wt/b' },
      ],
    });
    return root;
  }

  it('a bare name that matches two agents is an error, never a guess', async () => {
    const root = await setupTwins();
    await expect(readDialogFor(root, 'demo', 'builder')).rejects.toThrow(/say which/);
  });

  it('the @worktree form reads the matching pane', async () => {
    const root = await setupTwins();
    const d = await readDialogFor(root, 'demo', 'builder@/wt/b');
    expect(d).not.toBeNull();
    expect(d!.pane).toBe('%2');
    expect(d!.kind).toBe('numbered');
  });
});

const MENU = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dialog-trust-menu.txt'),
  'utf8',
);

// A three-option menu built on the trust menu's structure (cursor on 1).
const MENU3 = [
  'teamkimi run',
  ' ────────────────────────────',
  '  Pick one?',
  '  ↑↓ navigate · Enter select · Esc exit',
  '',
  '   ❯ Alpha',
  '     the first',
  '',
  '     Beta',
  '     the second',
  '',
  '     Gamma',
  '     the third',
  ' ────────────────────────────',
  '',
].join('\n');

describe('menuKeys', () => {
  it('computes the arrow walk from cursor to choice, then Enter', () => {
    expect(menuKeys(1, 1)).toEqual(['Enter']);
    expect(menuKeys(3, 1)).toEqual(['Down', 'Down', 'Enter']);
    expect(menuKeys(1, 3)).toEqual(['Up', 'Up', 'Enter']);
  });
});

describe('answerDialog on menus', () => {
  async function setupOrchestrator(screenText: string) {
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 1, pane_started: 'x' }],
    });
    vi.mocked(capturePane).mockImplementation(async () => screenText);
    vi.mocked(sendArrow).mockClear();
    vi.mocked(sendEnter).mockClear();
    return root;
  }

  it("answering '1' on the trust menu (cursor on 1) sends just Enter", async () => {
    const root = await setupOrchestrator(MENU);
    const fp = parseDialog(lines(MENU)).fingerprint;
    const r = await answerDialog(root, 'demo', undefined, '1', fp);
    expect(r.answered).toBe(true);
    expect(r.option).toBe('Trust this folder');
    expect(vi.mocked(sendArrow).mock.calls).toEqual([]);
    expect(vi.mocked(sendEnter).mock.calls).toEqual([['%1']]);
  });

  it("answering '3' with the cursor on 1 sends Down Down Enter", async () => {
    const root = await setupOrchestrator(MENU3);
    const events: string[] = [];
    vi.mocked(sendArrow).mockImplementation(async (_pane, key) => {
      events.push(key);
    });
    vi.mocked(sendEnter).mockImplementation(async () => {
      events.push('Enter');
    });
    const fp = parseDialog(lines(MENU3)).fingerprint;
    const r = await answerDialog(root, 'demo', undefined, '3', fp);
    expect(r.option).toBe('Gamma');
    expect(events).toEqual(['Down', 'Down', 'Enter']);
  });

  it('a stale fingerprint refuses before any key is sent', async () => {
    const root = await setupOrchestrator(MENU);
    await expect(answerDialog(root, 'demo', undefined, '1', 'bogus')).rejects.toThrow(/dialog changed/);
    expect(vi.mocked(sendArrow).mock.calls).toEqual([]);
    expect(vi.mocked(sendEnter).mock.calls).toEqual([]);
  });
});
