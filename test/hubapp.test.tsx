import React from 'react';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/hub.js', () => ({
  buildStatus: vi.fn(async () => ({ hub: { root: '/r', name: 'hub' }, projects: [] })),
  listTasks: vi.fn(async () => []),
  readDialogFor: vi.fn(async () => null),
  answerDialog: vi.fn(),
  continueProject: vi.fn(),
  wake: vi.fn(),
}));

import { HubApp } from '../src/ui/HubApp.js';
import { buildStatus } from '../src/hub.js';

function fakeStreams() {
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
  stdout.columns = 80;
  stdout.rows = 24;
  return { stdout, stdin: new PassThrough() };
}

describe('HubApp polling', () => {
  it('refreshes once on mount and then only on the interval', async () => {
    const { stdout, stdin } = fakeStreams();
    const inst = render(<HubApp root="/r" />, { stdout, stdin, debug: true, patchConsole: false });
    await new Promise((r) => setTimeout(r, 500));
    const afterMount = vi.mocked(buildStatus).mock.calls.length;
    expect(afterMount).toBe(1);
    await new Promise((r) => setTimeout(r, 1000));
    expect(vi.mocked(buildStatus).mock.calls.length).toBe(afterMount);
    inst.unmount();
  });
});
