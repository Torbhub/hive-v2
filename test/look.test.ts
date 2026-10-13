import { describe, expect, it } from 'vitest';
import type { HubView } from '../src/types.js';
import {
  agentRef, ago, buildNeeds, homeTilde, orchestratorLook, untilLabel, waitLook,
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
    root: '/r', hubName: 'hub', projects: [], tasks: [], dialogs: {}, updatedAt: NOW, error: '',
  };
  it('hub-not-recorded need first', () => {
    const needs = buildNeeds({ ...base, hubName: '' }, NOW);
    expect(needs[0]).toMatchObject({ key: 'hub', glyph: '!', color: 'red', who: 'hub' });
  });
  it('task needs carry waitLook and ago', () => {
    const needs = buildNeeds({
      ...base,
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
});
