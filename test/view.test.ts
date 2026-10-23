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
}));

vi.mock('../src/state.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/state.js')>();
  return { ...orig, readDecisions: vi.fn(async () => []) };
});

import { buildStatus, listTasks } from '../src/hub.js';
import { readDecisions } from '../src/state.js';
import type { Decision } from '../src/types.js';
import { buildView, feedKeep } from '../src/view.js';

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
    // readDecisions answers newest first.
    vi.mocked(readDecisions).mockResolvedValueOnce([...noise, ...signal].reverse());
    const view = await buildView('/r');
    expect(view.decisions).toHaveLength(8);
    expect(view.decisions.every((d) => d.summary.startsWith('approved the plan'))).toBe(true);
    expect(view.decisions[0].summary).toBe('approved the plan 8');
    expect(vi.mocked(readDecisions).mock.calls[0][1]).toBeGreaterThan(8);
  });
});

describe('buildView', () => {
  it('assembles status + tasks + the dialogs map in one shot', async () => {
    const view = await buildView('/r');
    expect(view.hubName).toBe('hub');
    expect(view.projects).toHaveLength(1);
    expect(view.tasks).toHaveLength(1);
    expect(view.tasks[0].needs_owner).toBe(true);
    // orchestrator question → "demo", agent question → "demo/fixer"
    expect(Object.keys(view.dialogs).sort()).toEqual(['demo', 'demo/fixer']);
    expect(view.dialogs.demo.pane).toBe('%1');
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
