import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compactionScreenGuard } from '../src/compact.js';
import { typeLine } from '../src/spawn.js';

vi.mock('../src/tmux.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/tmux.js')>();
  return {
    ...orig,
    capturePane: vi.fn(async () => '⠼ thinking…\n'),
    paneIs: vi.fn(async () => true),
    sendLiteral: vi.fn(async () => {}),
    sendEnter: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
  };
});

import { capturePane, sendEnter, sendLiteral } from '../src/tmux.js';

const IDENTITY = { pid: 22, started: 'start' };
const COMMAND = '/compact fixed directive';
const DIALOG = 'Run this command?\n▶ 1. Approve once';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(capturePane).mockResolvedValue('⠼ thinking…\n');
});

describe('compaction input screen guard', () => {
  it('refuses a dialog after literal input and before the first Enter', async () => {
    vi.mocked(capturePane).mockResolvedValue(DIALOG);

    await expect(typeLine('%2', COMMAND, IDENTITY, (raw) => compactionScreenGuard('%2', raw))).rejects.toThrow('dialog');

    expect(sendLiteral).toHaveBeenCalledOnce();
    expect(sendEnter).not.toHaveBeenCalled();
  });

  it('rejects dialog controls even when a compact prompt is visible', async () => {
    vi.mocked(capturePane).mockResolvedValue(`Press Enter to continue\n│ > ${COMMAND}`);

    await expect(typeLine('%2', COMMAND, IDENTITY, (raw) => compactionScreenGuard('%2', raw))).rejects.toThrow('dialog');

    expect(sendEnter).not.toHaveBeenCalled();
  });

  it('rejects a native question with a compact prompt in scrollback', async () => {
    const native = readFileSync(path.join(import.meta.dirname, 'fixtures', 'dialog-ask-user-question.txt'), 'utf8');
    vi.mocked(capturePane).mockResolvedValue(`│ > ${COMMAND}\n${native}`);

    await expect(typeLine('%2', COMMAND, IDENTITY, (raw) => compactionScreenGuard('%2', raw))).rejects.toThrow('dialog');

    expect(sendEnter).not.toHaveBeenCalled();
  });

  it('allows the exact non-empty compact prompt before the first Enter', async () => {
    vi.mocked(capturePane)
      .mockResolvedValueOnce(`│ > ${COMMAND}`)
      .mockResolvedValueOnce('done\n│ > \n');

    await typeLine('%2', COMMAND, IDENTITY, (raw) => compactionScreenGuard('%2', raw));

    expect(sendEnter).toHaveBeenCalledTimes(1);
  });

  it('refuses a dialog before a retry Enter', async () => {
    const prompt = `⠼ thinking…\n│ > ${COMMAND}`;
    vi.mocked(capturePane)
      .mockResolvedValueOnce(prompt)
      .mockResolvedValueOnce(prompt)
      .mockResolvedValueOnce(DIALOG);

    await expect(typeLine('%2', COMMAND, IDENTITY, (raw) => compactionScreenGuard('%2', raw))).rejects.toThrow('dialog');

    expect(sendEnter).toHaveBeenCalledTimes(1);
  });

  it('refuses a dialog after the first Enter and treats delivery as unconfirmed', async () => {
    vi.mocked(capturePane)
      .mockResolvedValueOnce('⠼ thinking…\n')
      .mockResolvedValueOnce(DIALOG);

    await expect(typeLine('%2', COMMAND, IDENTITY, (raw) => compactionScreenGuard('%2', raw))).rejects.toThrow('dialog');

    expect(sendEnter).toHaveBeenCalledTimes(1);
  });
});
