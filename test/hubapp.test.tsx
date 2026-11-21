import React from 'react';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/hub.js', () => ({
  buildStatus: vi.fn(async () => ({
    hub: { root: '/r', name: 'hub' },
    projects: [{
      name: 'demo', home: '/r/demo', repos: [], agents: [], open_tasks: 1,
      orchestrator: { state: 'running' as const, question: false },
    }],
  })),
  listTasks: vi.fn(async () => []),
  readDialogFor: vi.fn(async () => null),
  answerDialog: vi.fn(),
  continueProject: vi.fn(),
  planAnswer: vi.fn(async () => ({ typed: '' })),
  wake: vi.fn(),
}));

import { HubApp } from '../src/ui/HubApp.js';
import { buildStatus, listTasks, planAnswer } from '../src/hub.js';
import { taskContract } from './task-contract.js';

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

  it('shows the actual contract and stored digest before the approval controls', async () => {
    const base = taskContract('/r/demo', ['src'], 'Return the bounded artifact.');
    const contract: ReturnType<typeof taskContract> = {
      ...base,
      provenance: {
        kind: 'code', repository: '/r/demo', base_revision: '0'.repeat(40), artifact_revision: '1'.repeat(40),
      },
      acceptance: [{
        ...base.acceptance[0],
        configuration: { scope: { paths: ['src'], review: { required: true, tiers: ['owner', 'peer'] } } },
      }],
    };
    const digest = 'a'.repeat(64);
    vi.mocked(listTasks).mockResolvedValue([{ ...planTask, contract, plan_digest: digest }]);
    const { stdout, stdin } = fakeStreams();
    stdout.columns = 200;
    const frame = frameReader(stdout);
    const inst = render(<HubApp root="/r" />, { stdout, stdin, debug: true, patchConsole: false });
    await waitForFrame(frame, 'Root contract');
    for (const text of [
      `Plan digest: ${digest}`, 'Schema: 1', 'Kind: build', 'Objective: Complete the bounded task.',
      'Consumer: demo-orchestrator', 'Deliverable: Return the bounded artifact.',
      'Acceptance diff: git_diff_scope v1', 'Required: true', 'Evidence: diff-evidence',
      'Configuration: {', '      "scope": {', '        "review": {', '          "required": true',
      'Provenance kind: code', 'Repository: /r/demo',
      `Base revision: ${'0'.repeat(40)}`, `Artifact revision: ${'1'.repeat(40)}`,
      'Write scope: src', 'Action scope: (none)',
      'Budget: depth=1, active_children=8, active_project_records=16, attempts=3',
      'Delegated output claims: Return the bounded artifact.', 'Delegated adapters: tmux',
    ]) expect(frame()).toContain(text);
    expect(frame().indexOf(`Plan digest: ${digest}`)).toBeLessThan(frame().indexOf('a approve plan'));
    inst.unmount();
  });

  it('marks a legacy plan with no contract before the approval controls', async () => {
    vi.mocked(listTasks).mockResolvedValue([{ ...planTask, plan_digest: 'b'.repeat(64) }]);
    const { stdout, stdin } = fakeStreams();
    stdout.columns = 200;
    const frame = frameReader(stdout);
    const inst = render(<HubApp root="/r" />, { stdout, stdin, debug: true, patchConsole: false });
    await waitForFrame(frame, 'No root contract is recorded.');
    expect(frame()).toContain(`Plan digest: ${'b'.repeat(64)}`);
    expect(frame().indexOf('No root contract is recorded.')).toBeLessThan(frame().indexOf('a approve plan'));
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
    await waitForFrame(frame, 'feedback: split it');
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

  async function openPrompt() {
    vi.mocked(listTasks).mockResolvedValue([planTask]);
    const { stdout, stdin } = fakeStreams();
    const frame = frameReader(stdout);
    const inst = render(<HubApp root="/r" />, { stdout, stdin, debug: true, patchConsole: false });
    await waitForFrame(frame, 'b send back');
    await tick(200);
    stdin.write('b');
    await waitForFrame(frame, 'what should change? (optional)');
    return { frame, stdin, inst };
  }

  it('with the prompt open, a and b type into it and Esc closes it with no call', async () => {
    const { frame, stdin, inst } = await openPrompt();
    stdin.write('ab');
    await waitForFrame(frame, 'feedback: ab');
    expect(planAnswer).not.toHaveBeenCalled();
    const mark = frame().length;
    stdin.write('\x1b');
    await waitForFrame(() => frame().slice(mark), 'a approve plan');
    expect(planAnswer).not.toHaveBeenCalled();
    inst.unmount();
  });

  it('Enter with the prompt open sends the verdict; it never presses the focused button', async () => {
    const { stdin, inst } = await openPrompt();
    stdin.write('\r');
    await tick(300);
    expect(planAnswer).toHaveBeenCalledTimes(1);
    expect(planAnswer).toHaveBeenCalledWith('/r', 'demo', 'demo-3', 'sendback', undefined);
    inst.unmount();
  });

  it('keys in the same burst as b cannot fire a hotkey while the prompt opens', async () => {
    vi.mocked(listTasks).mockResolvedValue([planTask]);
    const { stdout, stdin } = fakeStreams();
    const frame = frameReader(stdout);
    const inst = render(<HubApp root="/r" />, { stdout, stdin, debug: true, patchConsole: false });
    await waitForFrame(frame, 'a approve plan');
    await tick(200);
    // One burst, delivered a char at a time before React can re-render: b
    // opens the prompt and the a in "change" must not approve.
    for (const ch of 'b change it') {
      stdin.write(ch);
      await new Promise((r) => process.nextTick(r));
    }
    await waitForFrame(frame, 'what should change? (optional)');
    expect(planAnswer).not.toHaveBeenCalled();
    inst.unmount();
  });
});
