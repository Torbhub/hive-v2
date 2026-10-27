import { describe, expect, it } from 'vitest';
import type { HubTask, HubView } from '../src/types.js';
import {
  agentRef, ago, buildNeeds, homeTilde, orchestratorLook, staleTask,
  taskProgress, untilLabel, waitLook, windowLabel,
} from '../src/ui/look.js';

const NOW = Date.parse('2026-10-13T12:00:00Z');

describe('ago', () => {
  it('formats per the spec table', () => {
    expect(ago('not a date', NOW)).toBe('');
    expect(ago('2026-10-13T11:59:30Z', NOW)).toBe('now');
    expect(ago('2026-10-13T11:45:00Z', NOW)).toBe('15m');
    expect(ago('2026-10-13T06:00:00Z', NOW)).toBe('6h');
    expect(ago('2026-10-10T12:00:00Z', NOW)).toBe('3d');
  });
});

describe('untilLabel', () => {
  it('is HH:MM today, weekday + HH:MM otherwise', () => {
    const noon = new Date(2026, 9, 13, 12, 0).getTime();
    expect(untilLabel(new Date(2026, 9, 13, 18, 30).getTime(), noon)).toBe('18:30');
    expect(untilLabel(new Date(2026, 9, 14, 7, 30).getTime(), noon)).toBe('Wed 07:30');
  });
});

describe('orchestratorLook', () => {
  const base = { state: 'none' as const };
  it('covers the spec table', () => {
    expect(orchestratorLook({ ...base, starting: { pane: '%1', kind: 'start', at: '', typed: true } }))
      .toEqual({ dot: '◐', word: 'coming up', color: 'cyan' });
    expect(orchestratorLook({ ...base, starting: { pane: '%1', kind: 'start', at: '' } }))
      .toEqual({ dot: '◐', word: 'waiting on you', color: 'magenta' });
    expect(orchestratorLook({ state: 'running' })).toEqual({ dot: '●', word: 'running', color: 'green' });
    expect(orchestratorLook({ state: 'stopped' })).toEqual({ dot: '○', word: 'stopped', color: 'yellow' });
    expect(orchestratorLook({ state: 'unknown' })).toEqual({ dot: '?', word: 'cannot tell', color: 'red' });
    expect(orchestratorLook({ state: 'none' })).toEqual({ dot: '◌', word: 'no team', color: 'gray' });
    expect(orchestratorLook({ state: 'unregistered' })).toEqual({ dot: '◑', word: 'not registered', color: 'magenta' });
    expect(orchestratorLook({ state: 'resumable' })).toEqual({ dot: '○', word: 'stopped, not registered', color: 'yellow' });
  });
});

describe('waitLook', () => {
  it('covers the spec table', () => {
    expect(waitLook('plan')).toEqual({ glyph: '▲', words: 'plan to approve', color: 'magenta' });
    expect(waitLook('question')).toEqual({ glyph: '?', words: 'question', color: 'yellow' });
    expect(waitLook('blocked')).toEqual({ glyph: '✖', words: 'blocked', color: 'red' });
    expect(waitLook('overnight')).toEqual({ glyph: '•', words: 'overnight', color: 'white' });
  });
});

describe('agentRef / homeTilde', () => {
  it('agentRef is ref else name', () => {
    expect(agentRef({ name: 'fixer', state: 'running', ref: 'fixer@/wt' })).toBe('fixer@/wt');
    expect(agentRef({ name: 'fixer', state: 'running' })).toBe('fixer');
  });
  it('homeTilde substitutes only a real home prefix', () => {
    expect(homeTilde('/home/u/work', '/home/u')).toBe('~/work');
    expect(homeTilde('/home/u', '/home/u')).toBe('~');
    expect(homeTilde('/home/u2/work', '/home/u')).toBe('/home/u2/work');
  });
});

describe('buildNeeds', () => {
  const base: HubView = {
    root: '/r', hubName: 'hub', projects: [], tasks: [], dialogs: {}, decisions: [], questions: [], updatedAt: NOW, error: '',
  };
  const taskBase: HubView = {
    ...base,
    projects: [{
      name: 'demo', home: '/r/demo', repos: [], agents: [], open_tasks: 1,
      orchestrator: { state: 'running', question: false },
    }],
  };
  it('hub-not-recorded need first', () => {
    const needs = buildNeeds({ ...base, hubName: '' }, NOW);
    expect(needs[0]).toMatchObject({ key: 'hub', glyph: '!', color: 'red', who: 'hub' });
  });
  it('task needs carry waitLook and ago', () => {
    const needs = buildNeeds({
      ...taskBase,
      tasks: [{
        id: 'demo-1', project: 'demo', asked: '2026-10-13T10:00:00Z', state: 'plan',
        updated: '2026-10-13T11:00:00Z', last_note: null, needs_owner: true,
      }],
    }, NOW);
    expect(needs[0]).toMatchObject({
      key: 'task-demo-1', glyph: '▲', color: 'magenta', who: 'demo-1', words: 'plan to approve', when: '1h',
    });
  });
  it('starting orchestrator need carries the continue action', () => {
    const needs = buildNeeds({
      ...base,
      projects: [{
        name: 'demo', home: '/r/demo', repos: [], agents: [], open_tasks: 0,
        orchestrator: { state: 'none', starting: { pane: '%7', kind: 'start', at: '2026-10-13T11:30:00Z' } },
      }],
    }, NOW);
    expect(needs[0]).toMatchObject({
      key: 'starting-demo', action: 'continue', project: 'demo',
      words: 'waiting in pane %7 for its first line', when: '30m',
    });
  });
  it('a plan task absorbs the orchestrator question into one card', () => {
    const needs = buildNeeds({
      ...base,
      projects: [{
        name: 'demo', home: '/r/demo', repos: [], agents: [], open_tasks: 1,
        orchestrator: { state: 'running', question: true },
      }],
      tasks: [{
        id: 'demo-1', project: 'demo', asked: '2026-10-13T10:00:00Z', state: 'plan',
        updated: '2026-10-13T11:00:00Z', last_note: null, needs_owner: true,
      }],
    }, NOW);
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({
      key: 'task-demo-1', action: 'plan', project: 'demo', taskId: 'demo-1', dialogKey: 'demo',
    });
  });
  it('an orchestrator question with no plan task stays its own card', () => {
    const needs = buildNeeds({
      ...base,
      projects: [{
        name: 'demo', home: '/r/demo', repos: [], agents: [], open_tasks: 0,
        orchestrator: { state: 'running', question: true },
      }],
    }, NOW);
    expect(needs[0]).toMatchObject({ key: 'orch-demo', dialogKey: 'demo' });
  });
  it('structured-only questions use their inline cards, not fake screen dialogs', () => {
    const needs = buildNeeds({
      ...base,
      projects: [{
        name: 'demo', home: '/r/demo', repos: [], open_tasks: 1,
        orchestrator: { state: 'running', question: true, operator_question: true },
        agents: [{ name: 'builder', state: 'running', question: true, operator_question: true, ref: 'builder' }],
      }],
      tasks: [{
        id: 'demo-1', project: 'demo', asked: '2026-10-13T10:00:00Z', state: 'plan',
        updated: '2026-10-13T11:00:00Z', last_note: null, needs_owner: true,
      }],
    }, NOW);
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({ key: 'task-demo-1', action: 'plan' });
    expect(needs[0].dialogKey).toBeUndefined();
  });

  it('keeps native dialog actions when a structured batch is also open', () => {
    const needs = buildNeeds({
      ...base,
      projects: [{
        name: 'demo', home: '/r/demo', repos: [], open_tasks: 0,
        orchestrator: { state: 'running', question: true, operator_question: true, screen_question: true },
        agents: [{ name: 'builder', state: 'running', question: true, operator_question: true, screen_question: true, ref: 'builder' }],
      }],
    }, NOW);
    expect(needs.map((n) => n.key)).toEqual(['orch-demo', 'agent-demo-builder']);
  });

  it('a plan task with no screen question offers the plan action and no dialog', () => {
    const needs = buildNeeds({
      ...base,
      projects: [{
        name: 'demo', home: '/r/demo', repos: [], agents: [], open_tasks: 1,
        orchestrator: { state: 'running' },
      }],
      tasks: [{
        id: 'demo-1', project: 'demo', asked: '2026-10-13T10:00:00Z', state: 'plan',
        updated: '2026-10-13T11:00:00Z', last_note: null, needs_owner: true,
      }],
    }, NOW);
    expect(needs[0]).toMatchObject({ key: 'task-demo-1', action: 'plan', taskId: 'demo-1' });
    expect(needs[0].dialogKey).toBeUndefined();
  });

  const task = (over: Partial<HubTask>): HubTask => ({
    id: 'demo-1', project: 'demo', asked: '2026-10-13T10:00:00Z', state: 'blocked',
    updated: '2026-10-13T11:00:00Z', last_note: null, needs_owner: true, ...over,
  });

  it('a blocked or question need carries its reason and the resolve action', () => {
    const needs = buildNeeds({ ...taskBase, tasks: [task({ last_note: 'the API key is missing' })] }, NOW);
    expect(needs[0]).toMatchObject({
      key: 'task-demo-1', who: 'demo-1', words: 'blocked', action: 'resolve',
      project: 'demo', taskId: 'demo-1', detail: 'the API key is missing',
    });
    const question = buildNeeds({ ...taskBase, tasks: [task({ state: 'question' })] }, NOW);
    expect(question[0]).toMatchObject({ action: 'resolve', detail: 'no reason recorded' });
  });

  it('a plan need carries its checkpoint list', () => {
    const checkpoints = [{ id: 'a', desc: 'write it', etaMin: 5 }, { id: 'b', desc: 'ship it', etaMin: 10 }];
    const needs = buildNeeds({ ...taskBase, tasks: [task({ state: 'plan', checkpoints })] }, NOW);
    expect(needs[0]).toMatchObject({ action: 'plan', checkpoints });
  });

  it('suppresses task actions for unregistered and no-team projects without changing task data', () => {
    const projects = (['running', 'none'] as const).map((state) => ({
      name: state, home: `/r/${state}`, repos: [], agents: [], open_tasks: 1,
      orchestrator: { state, question: false },
    }));
    const tasks = projects.map((p) => task({ id: `${p.name}-1`, project: p.name }));
    tasks.push(task({ id: 'ghost-1', project: 'ghost' }));
    const view = { ...base, projects, tasks };
    const needs = buildNeeds(view, NOW);
    expect(needs.map((n) => n.key)).toEqual(['task-running-1']);
    expect(view.tasks).toHaveLength(3);
    expect(view.projects.map((p) => p.open_tasks)).toEqual([1, 1]);
  });

  it('stale math: 4h past last progress, or past the latest activity, live states only', () => {
    expect(staleTask(task({ state: 'blocked', last_progress_at: '2026-10-13T07:59:59Z' }), NOW)).toBe(true);
    expect(staleTask(task({ state: 'blocked', last_progress_at: '2026-10-13T08:00:01Z' }), NOW)).toBe(false);
    // No progress yet: the clock starts at the latest activity (updated), so a
    // rebriefed days-old task is not instantly stale.
    expect(staleTask(task({ state: 'handed', needs_owner: false, updated: '2026-10-13T06:00:00Z' }), NOW)).toBe(true);
    expect(staleTask(task({ state: 'handed', needs_owner: false, asked: '2026-10-10T06:00:00Z' }), NOW)).toBe(false);
    expect(staleTask(task({ state: 'done', needs_owner: false }), NOW)).toBe(false);
    expect(staleTask(task({ state: 'asked', needs_owner: false }), NOW)).toBe(false);
    const needs = buildNeeds({ ...taskBase, tasks: [task({ last_progress_at: '2026-10-13T06:00:00Z' })] }, NOW);
    expect(needs[0].stale).toBe(true);
  });
});

describe('taskProgress', () => {
  const planned: HubTask = {
    id: 'demo-1', project: 'demo', asked: '2026-10-13T06:00:00Z', state: 'handed',
    updated: '2026-10-13T11:00:00Z', last_note: null, needs_owner: false,
    checkpoints: [
      { id: 'a', desc: 'write it', etaMin: 5 },
      { id: 'b', desc: 'test it', etaMin: 5 },
      { id: 'c', desc: 'ship it', etaMin: 5 },
    ],
    progress: {
      a: { status: 'ok', at: '2026-10-13T10:00:00Z' },
      b: { status: 'fail', note: 'red tests', at: '2026-10-13T10:30:00Z' },
      c: { status: 'started', at: '2026-10-13T11:00:00Z' },
    },
    last_progress_at: '2026-10-13T11:00:00Z',
  };

  it('counts terminal checkpoints, finds the live one, lists the failed', () => {
    expect(taskProgress(planned)).toEqual({
      done: 2, total: 3, current: 'c', lastAt: '2026-10-13T11:00:00Z', failed: ['b'],
    });
  });

  it('no checkpoints means no progress, no events means nothing done or live', () => {
    expect(taskProgress({ ...planned, checkpoints: [] })).toBeNull();
    const fresh = { ...planned, progress: {}, last_progress_at: null };
    expect(taskProgress(fresh)).toEqual({ done: 0, total: 3, current: null, lastAt: null, failed: [] });
  });
});

describe('windowLabel', () => {
  it('is the tmux window name <project>:<agent>', () => {
    expect(windowLabel('demo', 'demo-orchestrator')).toBe('demo:demo-orchestrator');
    expect(windowLabel('demo', 'fixer')).toBe('demo:fixer');
  });
});
