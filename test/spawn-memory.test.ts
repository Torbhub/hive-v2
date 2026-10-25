import { promises as fs, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const IDLE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'idle-empty-prompt.txt'),
  'utf8',
);

vi.mock('../src/tmux.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/tmux.js')>();
  return {
    ...orig,
    run: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    newWindow: vi.fn(async () => '%9'),
    paneIdentity: vi.fn(async () => ({ pid: 4242, started: 'later' })),
    paneIs: vi.fn(async () => true),
    capturePane: vi.fn(async () => IDLE),
    sendLiteral: vi.fn(async () => {}),
    sendEnter: vi.fn(async () => {}),
    sendArrow: vi.fn(async () => {}),
    killWindow: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
  };
});

const { blockFor } = vi.hoisted(() => ({ blockFor: vi.fn(async (): Promise<string | null> => null) }));

vi.mock('../src/memory.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/memory.js')>();
  return { ...orig, memoryBlockFor: blockFor };
});

import { spawnAgent } from '../src/spawn.js';
import { hubAdd, hubInit, hubTask } from '../src/hub.js';
import { appendTaskEvent, hivePath, writeJson } from '../src/state.js';

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'hive-spawn-mem-'));
  const home = path.join(root, 'demo');
  await fs.mkdir(home, { recursive: true });
  await hubInit(root);
  await hubAdd(root, 'demo', home);
  await writeJson(hivePath(home, 'team.json'), { agents: [] });
  return { root, home };
}

async function approvedTask(root: string, text: string): Promise<string> {
  const id = await hubTask(root, 'demo', text);
  await appendTaskEvent(root, {
    id, project: 'demo', event: 'plan', at: new Date().toISOString(), note: 'the plan',
    checkpoints: [{ id: 'c1', desc: 'the step', etaMin: 5 }],
  });
  await appendTaskEvent(root, {
    id, project: 'demo', event: 'answered', at: new Date().toISOString(), note: 'plan approved by owner',
  });
  return id;
}

describe('spawn memory recall', () => {
  beforeEach(() => {
    blockFor.mockReset();
    blockFor.mockResolvedValue(null);
  });

  it('appends the Memory block to the handoff when recall has hits', async () => {
    const { root, home } = await setup();
    const task = await approvedTask(root, 'wire the recall lane');
    blockFor.mockResolvedValue('## Memory\n\n- the gate needs a green run\n');
    await spawnAgent(root, 'demo', { agent: 'worker1', task });
    const handoff = await fs.readFile(hivePath(home, 'handoffs', 'worker1.md'), 'utf8');
    expect(handoff).toContain('## Memory\n\n- the gate needs a green run');
    expect(vi.mocked(blockFor).mock.calls[0].slice(0, 3)).toEqual([root, 'demo', task]);
  }, 20_000);

  it('spawns clean when memory has nothing or is down', async () => {
    const { root, home } = await setup();
    const task = await approvedTask(root, 'wire the recall lane');
    const pane = await spawnAgent(root, 'demo', { agent: 'worker1', task });
    expect(pane).toBe('%9');
    const handoff = await fs.readFile(hivePath(home, 'handoffs', 'worker1.md'), 'utf8');
    expect(handoff).not.toContain('## Memory');
  }, 20_000);

  it('does not touch memory for a spawn without a task', async () => {
    const { root } = await setup();
    await spawnAgent(root, 'demo', { agent: 'worker1' });
    expect(blockFor).not.toHaveBeenCalled();
  }, 20_000);
});
