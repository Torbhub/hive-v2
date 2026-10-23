import { describe, expect, it } from 'vitest';
import { doneBlockers, foldTasks } from '../src/state.js';
import type { Checkpoint, TaskEvent } from '../src/types.js';

function ev(id: string, event: string, at: string, note?: string, extra?: Partial<TaskEvent>): TaskEvent {
  return { id, project: id.replace(/-\d+$/, ''), event, at, note, ...extra } as TaskEvent;
}

const CPS: Checkpoint[] = [
  { id: 'c1', desc: 'first', etaMin: 5 },
  { id: 'c2', desc: 'second', etaMin: 10 },
];

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

describe('progress folding', () => {
  const planned = [
    ev('demo-1', 'asked', '2026-10-20T01:00:00Z'),
    ev('demo-1', 'plan', '2026-10-20T02:00:00Z', 'the plan', { checkpoints: CPS }),
  ];

  it('progress events fill the trail and never rewrite the headline state', () => {
    const tasks = foldTasks([
      ...planned,
      ev('demo-1', 'progress', '2026-10-20T03:00:00Z', undefined, { checkpoint: 'c1', status: 'started' }),
      ev('demo-1', 'progress', '2026-10-20T04:00:00Z', 'done well', { checkpoint: 'c1', status: 'ok' }),
    ]);
    const t = tasks[0];
    expect(t.state).toBe('plan');
    expect(t.checkpoints).toEqual(CPS);
    expect(t.progress).toEqual({ c1: { status: 'ok', note: 'done well', at: '2026-10-20T04:00:00Z' } });
    expect(t.last_progress_at).toBe('2026-10-20T04:00:00Z');
    expect(t.updated).toBe('2026-10-20T04:00:00Z');
  });

  it('planaccept never rewrites the headline state either', () => {
    const tasks = foldTasks([
      ...planned,
      ev('demo-1', 'progress', '2026-10-20T03:00:00Z', 'broke', { checkpoint: 'c2', status: 'fail' }),
      ev('demo-1', 'planaccept', '2026-10-20T04:00:00Z', undefined, { checkpoint: 'c2' }),
    ]);
    expect(tasks[0].state).toBe('plan');
    expect(tasks[0].checkpoint_accepts).toEqual({ c2: '2026-10-20T04:00:00Z' });
  });

  it('answered after plan marks the plan approved; a fresh plan resets it', () => {
    const approved = foldTasks([...planned, ev('demo-1', 'answered', '2026-10-20T03:00:00Z', 'plan approved by owner')]);
    expect(approved[0].plan_approved).toBe(true);
    const replanned = foldTasks([
      ...planned,
      ev('demo-1', 'answered', '2026-10-20T03:00:00Z', 'plan approved by owner'),
      ev('demo-1', 'progress', '2026-10-20T04:00:00Z', undefined, { checkpoint: 'c1', status: 'ok' }),
      ev('demo-1', 'plan', '2026-10-20T05:00:00Z', 'revised', { checkpoints: [CPS[0]] }),
    ]);
    expect(replanned[0].plan_approved).toBe(false);
    expect(replanned[0].checkpoints).toEqual([CPS[0]]);
    expect(replanned[0].progress).toEqual({});
  });

  it('answered from a question is not a plan approval', () => {
    const tasks = foldTasks([
      ev('demo-1', 'asked', '2026-10-20T01:00:00Z'),
      ev('demo-1', 'question', '2026-10-20T02:00:00Z'),
      ev('demo-1', 'answered', '2026-10-20T03:00:00Z'),
    ]);
    expect(tasks[0].plan_approved).toBe(false);
  });

  it('doneBlockers names each blocking checkpoint', () => {
    const t = foldTasks([
      ...planned,
      ev('demo-1', 'progress', '2026-10-20T03:00:00Z', undefined, { checkpoint: 'c1', status: 'skip' }),
    ])[0];
    expect(doneBlockers(t)).toEqual(['c1 was skipped without a note', 'c2 has no terminal progress']);
  });
});
