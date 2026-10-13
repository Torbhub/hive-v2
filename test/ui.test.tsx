import { describe, expect, it } from 'vitest';
import { ago, orchestratorLook } from '../src/ui/HubApp.js';

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
