import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/hub.js', () => ({
  buildStatus: vi.fn(async () => ({
    hub: { root: '/r', name: 'hub' },
    projects: [{
      name: 'demo', home: '/r/demo', repos: [],
      orchestrator: { state: 'running', question: true },
      agents: [{ name: 'fixer', state: 'running', question: true, ref: 'fixer' }],
      open_tasks: 1,
    }],
  })),
  listTasks: vi.fn(async () => [{
    id: 'demo-1', project: 'demo', asked: 'a', state: 'plan', updated: 'b', last_note: null, needs_owner: true,
  }]),
  readDialogFor: vi.fn(async () => ({
    kind: 'numbered', text: 'dialog text', options: [], cursor: null, esc: true,
    fingerprint: 'fp', project: 'demo', session: 'demo-orchestrator', pane: '%1',
  })),
  redactDialog: <T>(dialog: T): T => dialog,
}));

vi.mock('../src/state.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/state.js')>();
  return { ...orig, readDecisions: vi.fn(async () => []) };
});

import { buildStatus, listTasks } from '../src/hub.js';
import { readDecisions } from '../src/state.js';
import type { Decision } from '../src/types.js';
import { buildView, displayLine, feedKeep, lastLine } from '../src/view.js';

const decision = (over: Partial<Decision>): Decision => ({
  at: '2026-10-13T11:00:00Z', project: 'demo', by: 'owner', summary: 'x', ...over,
});

describe('feedKeep', () => {
  it('drops tier-1 auto-approvals and "Approve once" owner rows', () => {
    expect(feedKeep(decision({ by: 'watch', summary: 'auto-approved "Approve once" for: $ ls' }))).toBe(false);
    expect(feedKeep(decision({ by: 'owner', summary: 'answered "Approve once" for: $ ls' }))).toBe(false);
  });
  it('keeps plan verdicts, send-backs, and non-trivial watch decisions', () => {
    expect(feedKeep(decision({ summary: 'approved the plan' }))).toBe(true);
    expect(feedKeep(decision({ summary: 'sent the plan back: no checkpoints' }))).toBe(true);
    expect(feedKeep(decision({ by: 'watch', summary: 'auto-approved "Yes, always allow" for: $ npm test' }))).toBe(true);
    expect(feedKeep(decision({ by: 'watch', summary: 'marked fixer wedged: frozen pane, restarting it' }))).toBe(true);
    expect(feedKeep(decision({ by: 'owner', summary: 'answered "No" for: $ rm -rf x' }))).toBe(true);
    expect(feedKeep(decision({ by: 'owner', summary: 'cancelled demo-1' }))).toBe(true);
  });
});

describe('buildView decisions feed', () => {
  it('filters noise and caps the feed at 8, scanning further back', async () => {
    const noise: Decision[] = Array.from({ length: 10 }, (_, i) => decision({
      at: `2026-10-13T11:${String(i).padStart(2, '0')}:00Z`,
      by: 'watch', summary: 'auto-approved "Approve once" for: $ ls',
    }));
    const signal: Decision[] = Array.from({ length: 9 }, (_, i) => decision({
      at: `2026-10-13T10:${String(i).padStart(2, '0')}:00Z`, summary: `approved the plan ${i}`,
    }));
    vi.mocked(readDecisions).mockResolvedValueOnce([...noise, ...signal].reverse());
    const view = await buildView('/r');
    expect(view.decisions).toHaveLength(8);
    expect(view.decisions.every((d) => d.summary.startsWith('approved the plan'))).toBe(true);
    expect(view.decisions[0].summary).toBe('approved the plan 8');
    expect(vi.mocked(readDecisions).mock.calls[0][1]).toBeGreaterThan(8);
  });

  it('keeps rendering and reports decision read failures', async () => {
    vi.mocked(readDecisions).mockRejectedValueOnce(new Error('corrupt JSONL in /r/.hive-hub/decisions.jsonl:2'));
    const view = await buildView('/r');
    expect(view.hubName).toBe('hub');
    expect(view.projects).toHaveLength(1);
    expect(view.decisions).toEqual([]);
    expect(view.error).toBe('decisions not read: corrupt JSONL in /r/.hive-hub/decisions.jsonl:2');
  });
});

describe('display text', () => {
  it('keeps raw error text for diagnostics and masks only display text', () => {
    expect(lastLine(new Error('hive: tmux failed for %9'))).toBe('tmux failed for %9');
    expect(displayLine(new Error('hive: tmux failed for %9'))).toBe('tmux failed for ?');
  });

  it('masks pane ids in legacy decisions without changing stored records', async () => {
    const stored = decision({ summary: 'wake returned %9 after %1 died' });
    vi.mocked(readDecisions).mockResolvedValueOnce([stored]);
    const view = await buildView('/r');
    expect(view.decisions[0].summary).toBe('wake returned ? after ? died');
    expect(stored.summary).toBe('wake returned %9 after %1 died');
  });

  it('preserves percent escapes and masks tmux targets in approved commands', async () => {
    const stored = decision({ by: 'watch', summary: 'auto-approved "Yes, always allow" for: $ echo pane %20' });
    const tmux = decision({ by: 'watch', summary: 'answered "Yes, always allow" for: $ tmux send-keys -t \'%7\' text && tmux send-keys -t "%8" other' });
    vi.mocked(readDecisions).mockResolvedValueOnce([stored, tmux]);
    const view = await buildView('/r');
    expect(view.decisions[0].summary).toBe(stored.summary);
    expect(view.decisions[1].summary).toBe('answered "Yes, always allow" for: $ tmux send-keys -t \'?\' text && tmux send-keys -t "?" other');
    expect(tmux.summary).toBe('answered "Yes, always allow" for: $ tmux send-keys -t \'%7\' text && tmux send-keys -t "%8" other');
  });

  it('preserves every line and prefix of a stored decision', async () => {
    const stored = decision({ summary: 'hive: first %9\nsecond %1' });
    vi.mocked(readDecisions).mockResolvedValueOnce([stored]);
    const view = await buildView('/r');
    expect(view.decisions[0].summary).toBe('hive: first ?\nsecond ?');
    expect(stored.summary).toBe('hive: first %9\nsecond %1');
  });

  it('masks a pane id before a command while preserving the command percent escape', async () => {
    const stored = decision({ summary: 'hive: wake returned %9\nanswered "Allow" for: $ echo %20' });
    vi.mocked(readDecisions).mockResolvedValueOnce([stored]);
    const view = await buildView('/r');
    expect(view.decisions[0].summary).toBe('hive: wake returned ?\nanswered "Allow" for: $ echo %20');
    expect(stored.summary).toBe('hive: wake returned %9\nanswered "Allow" for: $ echo %20');
  });
});

describe('buildView', () => {
  it('assembles status + tasks + the dialogs map in one shot', async () => {
    const view = await buildView('/r');
    expect(view.hubName).toBe('hub');
    expect(view.projects).toHaveLength(1);
    expect(view.tasks).toHaveLength(1);
    expect(view.tasks[0].needs_owner).toBe(true);
    expect(Object.keys(view.dialogs).sort()).toEqual(['demo', 'demo/fixer']);
    expect(view.dialogs.demo).toHaveProperty('pane', '%1');
    expect(view.questions).toEqual([]);
    expect(view.updatedAt).toBeGreaterThan(0);
    expect(view.error).toBe('');
  });

  it('status failure: updatedAt 0 and the error line, so callers keep old data', async () => {
    vi.mocked(buildStatus).mockRejectedValueOnce(new Error('tmux is gone\nlast line'));
    const view = await buildView('/r');
    expect(view.updatedAt).toBe(0);
    expect(view.projects).toEqual([]);
    expect(view.error).toBe('last line');
  });

  it('tasks failure: projects still render, error names the tasks read', async () => {
    vi.mocked(listTasks).mockRejectedValueOnce(new Error('corrupt ledger'));
    const view = await buildView('/r');
    expect(view.updatedAt).toBeGreaterThan(0);
    expect(view.projects).toHaveLength(1);
    expect(view.tasks).toEqual([]);
    expect(view.error).toBe('tasks not read: corrupt ledger');
  });
});
