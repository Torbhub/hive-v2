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

import { buildStatus, listTasks } from '../src/hub.js';
import { buildView } from '../src/view.js';

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
