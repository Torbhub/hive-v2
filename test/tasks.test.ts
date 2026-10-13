import { describe, expect, it } from 'vitest';
import { foldTasks } from '../src/state.js';
import type { TaskEvent } from '../src/types.js';

function ev(id: string, event: string, at: string, note?: string): TaskEvent {
  return { id, project: id.replace(/-\d+$/, ''), event, at, note };
}

describe('foldTasks', () => {
  it('state is the last non-note event', () => {
    const tasks = foldTasks([
      ev('demo-1', 'asked', '2026-10-13T01:00:00Z'),
      ev('demo-1', 'plan', '2026-10-13T02:00:00Z'),
      ev('demo-1', 'note', '2026-10-13T03:00:00Z', 'looks good'),
    ]);
    expect(tasks[0].state).toBe('plan');
    expect(tasks[0].last_note).toBe('looks good');
    expect(tasks[0].updated).toBe('2026-10-13T03:00:00Z');
    expect(tasks[0].needs_owner).toBe(true);
  });

  it('needs_owner only for plan/question/blocked', () => {
    const tasks = foldTasks([
      ev('a-1', 'asked', '2026-10-13T01:00:00Z'),
      ev('a-2', 'blocked', '2026-10-13T01:00:00Z'),
      ev('a-3', 'done', '2026-10-13T01:00:00Z'),
      ev('a-4', 'cancelled', '2026-10-13T01:00:00Z'),
    ]);
    expect(tasks.map((t) => t.needs_owner)).toEqual([false, true, false, false]);
  });

  it('collects decisions', () => {
    const tasks = foldTasks([
      ev('a-1', 'asked', '2026-10-13T01:00:00Z'),
      ev('a-1', 'decided', '2026-10-13T02:00:00Z', 'chose postgres'),
    ]);
    expect(tasks[0].decisions).toEqual([{ at: '2026-10-13T02:00:00Z', reason: 'chose postgres' }]);
  });

  it('sorts by asked and keeps the first event as asked', () => {
    const tasks = foldTasks([
      ev('b-1', 'asked', '2026-10-13T05:00:00Z'),
      ev('a-1', 'asked', '2026-10-13T01:00:00Z'),
      ev('b-1', 'handed', '2026-10-13T06:00:00Z'),
    ]);
    expect(tasks.map((t) => t.id)).toEqual(['a-1', 'b-1']);
    expect(tasks[1].state).toBe('handed');
  });
});
