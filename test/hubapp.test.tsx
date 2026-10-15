import React from 'react';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/hub.js', () => ({
  buildStatus: vi.fn(async () => ({ hub: { root: '/r', name: 'hub' }, projects: [] })),
  listTasks: vi.fn(async () => []),
  readDialogFor: vi.fn(async () => null),
  answerDialog: vi.fn(),
  continueProject: vi.fn(),
  planAnswer: vi.fn(async () => ({ typed: '' })),
  wake: vi.fn(),
}));

import { HubApp } from '../src/ui/HubApp.js';
import { buildStatus, listTasks, planAnswer } from '../src/hub.js';

function fakeStreams() {
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
  stdout.columns = 80;
  stdout.rows = 24;
  // ink only attaches its input reader when stdin looks like a TTY.
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean; setRawMode: (m: boolean) => void; ref: () => unknown; unref: () => unknown;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return { stdout, stdin };
}

// ink writes styled frames; strip the escape codes before asserting on text.
function frameReader(stdout: PassThrough) {
  let out = '';
  stdout.on('data', (c) => {
    out += String(c);
  });
  return () => out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForFrame(frame: () => string, text: string) {
  for (let i = 0; i < 50 && !frame().includes(text); i++) await tick(50);
  expect(frame()).toContain(text);
}

const planTask = {
  id: 'demo-3', project: 'demo', asked: '2026-10-14T00:00:00Z', state: 'plan',
  updated: '2026-10-14T00:00:00Z', last_note: null, needs_owner: true,
};

beforeEach(() => {
  vi.mocked(buildStatus).mockClear();
  vi.mocked(listTasks).mockClear().mockResolvedValue([]);
  vi.mocked(planAnswer).mockClear().mockResolvedValue({ typed: '' });
});

afterEach(() => {
  vi.mocked(listTasks).mockResolvedValue([]);
});

describe('HubApp polling', () => {
  it('refreshes once on mount and then only on the interval', async () => {
    const { stdout, stdin } = fakeStreams();
    const inst = render(<HubApp root="/r" />, { stdout, stdin, debug: true, patchConsole: false });
    await tick(500);
    const afterMount = vi.mocked(buildStatus).mock.calls.length;
    expect(afterMount).toBe(1);
    await tick(1000);
    expect(vi.mocked(buildStatus).mock.calls.length).toBe(afterMount);
    inst.unmount();
  });
});

describe('HubApp plan actions', () => {
  it('a plan need shows the key hints', async () => {
    vi.mocked(listTasks).mockResolvedValue([planTask]);
    const { stdout, stdin } = fakeStreams();
    const frame = frameReader(stdout);
    const inst = render(<HubApp root="/r" />, { stdout, stdin, debug: true, patchConsole: false });
    await waitForFrame(frame, 'plan to approve');
    expect(frame()).toContain('a approve plan');
    expect(frame()).toContain('b send back');
    inst.unmount();
  });

  it('a approves the plan', async () => {
    vi.mocked(listTasks).mockResolvedValue([planTask]);
    const { stdout, stdin } = fakeStreams();
    const frame = frameReader(stdout);
    const inst = render(<HubApp root="/r" />, { stdout, stdin, debug: true, patchConsole: false });
    await waitForFrame(frame, 'a approve plan');
    await tick(200);
    stdin.write('a');
    await tick(300);
    expect(planAnswer).toHaveBeenCalledWith('/r', 'demo', 'demo-3', 'approve', undefined);
    inst.unmount();
  });

  it('b opens the feedback prompt and Enter sends the typed text', async () => {
    vi.mocked(listTasks).mockResolvedValue([planTask]);
    const { stdout, stdin } = fakeStreams();
    const frame = frameReader(stdout);
    const inst = render(<HubApp root="/r" />, { stdout, stdin, debug: true, patchConsole: false });
    await waitForFrame(frame, 'b send back');
    await tick(200);
    stdin.write('b');
    await waitForFrame(frame, 'what should change? (optional)');
    stdin.write('split it');
    await tick(200);
    stdin.write('\r');
    await tick(300);
    expect(planAnswer).toHaveBeenCalledWith('/r', 'demo', 'demo-3', 'sendback', 'split it');
    inst.unmount();
  });

  it('a refusal lands in the toast', async () => {
    vi.mocked(listTasks).mockResolvedValue([planTask]);
    vi.mocked(planAnswer).mockRejectedValue(new Error('the plan prompt is on its screen; answer it there'));
    const { stdout, stdin } = fakeStreams();
    const frame = frameReader(stdout);
    const inst = render(<HubApp root="/r" />, { stdout, stdin, debug: true, patchConsole: false });
    await waitForFrame(frame, 'a approve plan');
    await tick(200);
    stdin.write('a');
    await waitForFrame(frame, 'demo-3: the plan prompt is on its screen; answer it there');
    inst.unmount();
  });

  it('a and b are inert with no plan need on screen', async () => {
    const { stdout, stdin } = fakeStreams();
    const inst = render(<HubApp root="/r" />, { stdout, stdin, debug: true, patchConsole: false });
    await tick(500);
    stdin.write('a');
    stdin.write('b');
    await tick(300);
    expect(planAnswer).not.toHaveBeenCalled();
    inst.unmount();
  });
});
