import { promises as fs, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mineDaydream } from '../src/daydream.js';
import {
  hivePath, hubPath, manifestRead, readDecisions, readTaskEvents, writeJson,
} from '../src/state.js';
import type { DaydreamNativeClient, TaskEvent } from '../src/types.js';
import { loadProcessedKeys } from '../src/watch-persist.js';

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'hive-jsonl-'));
}

type ReaderCase = {
  name: string;
  file: (root: string) => string;
  read: (root: string) => Promise<unknown>;
  records: [Record<string, unknown>, Record<string, unknown>];
  empty: unknown;
  expected: unknown;
};

const readers: ReaderCase[] = [
  {
    name: 'task events',
    file: (root) => hubPath(root, 'tasks.jsonl'),
    read: readTaskEvents,
    records: [
      { id: 'task-1', project: 'demo', event: 'asked', at: '2026-11-19T12:00:00.000Z', note: 'first' },
      { id: 'task-1', project: 'demo', event: 'note', at: '2026-11-19T12:01:00.000Z', note: 'second' },
    ],
    empty: [],
    expected: [
      { id: 'task-1', project: 'demo', event: 'asked', at: '2026-11-19T12:00:00.000Z', note: 'first' },
      { id: 'task-1', project: 'demo', event: 'note', at: '2026-11-19T12:01:00.000Z', note: 'second' },
    ],
  },
  {
    name: 'cleanup manifest',
    file: (root) => hivePath(root, 'manifest.jsonl'),
    read: manifestRead,
    records: [
      { kind: 'tmux', at: 'first', pane: '%1' },
      { kind: 'tmux', at: 'second', pane: '%2' },
    ],
    empty: [],
    expected: [
      { kind: 'tmux', at: 'first', pane: '%1' },
      { kind: 'tmux', at: 'second', pane: '%2' },
    ],
  },
  {
    name: 'decision history',
    file: (root) => hubPath(root, 'decisions.jsonl'),
    read: (root) => readDecisions(root, Number.MAX_SAFE_INTEGER),
    records: [
      { project: 'demo', by: 'watch', summary: 'first', at: '2026-11-19T12:00:00.000Z' },
      { project: 'demo', by: 'watch', summary: 'second', at: '2026-11-19T12:01:00.000Z' },
    ],
    empty: [],
    expected: [
      { project: 'demo', by: 'watch', summary: 'second', at: '2026-11-19T12:01:00.000Z' },
      { project: 'demo', by: 'watch', summary: 'first', at: '2026-11-19T12:00:00.000Z' },
    ],
  },
  {
    name: 'watch processed keys',
    file: (root) => hubPath(root, 'watch-processed.jsonl'),
    read: loadProcessedKeys,
    records: [
      { key: 'first', at: '2026-11-19T12:00:00.000Z' },
      { key: 'second', at: '2026-11-19T12:01:00.000Z' },
    ],
    empty: new Set(),
    expected: new Set(['first', 'second']),
  },
];

describe.each(readers)('$name JSONL policy', ({ file, read, records, empty, expected }) => {
  it('returns the established empty result only for ENOENT', async () => {
    expect(await read(tmp())).toEqual(empty);
  });

  it('ignores a torn final record and preserves blanks and valid record order', async () => {
    const root = tmp();
    const target = file(root);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `\n${JSON.stringify(records[0])}\n\n${JSON.stringify(records[1])}\n{"torn":`);
    expect(await read(root)).toEqual(expected);
  });

  it('throws the path and line for a malformed interior record', async () => {
    const root = tmp();
    const target = file(root);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(records[0])}\n{\n${JSON.stringify(records[1])}\n`);
    await expect(read(root)).rejects.toThrow(`${target}:2`);
  });

  it('throws the path and line for a malformed newline-terminated final record', async () => {
    const root = tmp();
    const target = file(root);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(records[0])}\n{\n`);
    await expect(read(root)).rejects.toThrow(`${target}:2`);
  });

  it('propagates non-ENOENT read failures', async () => {
    const root = tmp();
    await fs.mkdir(file(root), { recursive: true });
    await expect(read(root)).rejects.toThrow();
  });
});

const NOW = '2026-11-19T12:00:00.000Z';
const daydreamEvents: TaskEvent[] = [
  { id: 'task-1', project: 'demo', event: 'asked', at: NOW, note: 'Investigate the cache boundary.' },
  { id: 'task-1', project: 'demo', event: 'plan', at: NOW, checkpoints: [{ id: 'cp1', desc: 'Identify cache facts', etaMin: 5 }] },
  { id: 'task-1', project: 'demo', event: 'answered', at: NOW, note: 'plan approved by owner' },
  { id: 'task-1', project: 'demo', event: 'progress', at: NOW, checkpoint: 'cp1', status: 'started', note: 'Start the checkpoint.' },
];

async function daydreamSetup() {
  const root = tmp();
  const home = path.join(root, 'demo');
  const handoff = hivePath(home, 'handoffs', 'builder.md');
  await fs.mkdir(path.dirname(handoff), { recursive: true });
  await fs.writeFile(handoff, 'Cache boundary notes.\n');
  await writeJson(hubPath(root, 'projects.json'), { projects: [{ name: 'demo', home, repos: [] }] });
  await writeJson(hivePath(home, 'team.json'), {
    agents: [{ name: 'builder', session_id: 'parent', task: 'task-1', worktree: home, handoff }],
  });
  return { root, file: hubPath(root, 'tasks.jsonl') };
}

function nativeSentinel() {
  return {
    getSession: vi.fn(async () => {
      throw new Error('native reached');
    }),
  } as unknown as DaydreamNativeClient;
}

function mine(root: string, native: DaydreamNativeClient) {
  return mineDaydream(
    { root, project: 'demo', agent: 'builder' },
    { checkpointId: 'cp1', question: 'Which cache facts survive compaction?' },
    native,
    { now: NOW },
  );
}

async function writeDaydreamEvents(file: string, lines: string[]) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.join('\n'));
}

beforeEach(() => {
  process.env.HIVE_DAYDREAM = '1';
  process.env.HIVE_NATIVE_BRANCHES = '1';
});

afterEach(() => {
  delete process.env.HIVE_DAYDREAM;
  delete process.env.HIVE_NATIVE_BRANCHES;
});

describe('daydream task event JSONL adapter', () => {
  it('treats an absent task log as empty evidence', async () => {
    const { root } = await daydreamSetup();
    await expect(mine(root, nativeSentinel())).rejects.toThrow(/approved task plan/);
  });

  it('ignores only a torn final record', async () => {
    const { root, file } = await daydreamSetup();
    await writeDaydreamEvents(file, [...daydreamEvents.map((event) => JSON.stringify(event)), '', '{"id":"']);
    await expect(mine(root, nativeSentinel())).rejects.toThrow('native reached');
  });

  it('throws the path and line for a malformed interior record', async () => {
    const { root, file } = await daydreamSetup();
    const lines = daydreamEvents.map((event) => JSON.stringify(event));
    await writeDaydreamEvents(file, [lines[0], '{', ...lines.slice(1), '']);
    await expect(mine(root, nativeSentinel())).rejects.toThrow(`${file}:2`);
  });

  it('throws the path and line for a malformed newline-terminated final record', async () => {
    const { root, file } = await daydreamSetup();
    await writeDaydreamEvents(file, [...daydreamEvents.map((event) => JSON.stringify(event)), '{', '']);
    await expect(mine(root, nativeSentinel())).rejects.toThrow(`${file}:5`);
  });

  it('preserves non-ENOENT failures and the bounded-file guard', async () => {
    const directory = await daydreamSetup();
    await fs.mkdir(directory.file, { recursive: true });
    await expect(mine(directory.root, nativeSentinel())).rejects.toThrow(/task evidence must be bounded and regular/);

    const oversized = await daydreamSetup();
    await fs.writeFile(oversized.file, ' '.repeat(256 * 1024 + 1));
    await expect(mine(oversized.root, nativeSentinel())).rejects.toThrow(/task evidence must be bounded and regular/);
  });
});
