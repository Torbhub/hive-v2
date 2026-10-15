import { describe, expect, it } from 'vitest';
import { isOpenable, parse, type Segment, type Stretch } from '../src/stretch.js';

function stretchesOf(segments: Segment[]): Stretch[] {
  return segments.flatMap((s) => (typeof s === 'string' ? [] : [s, ...stretchesOf(s.long ?? [])]));
}

describe('parse', () => {
  it('plain text passes through as one string', () => {
    expect(parse('hello world')).toEqual(['hello world']);
  });

  it('a stretch parses into short and long forms', () => {
    const segments = parse('chose postgres {{why|it fits the brief}} today');
    expect(segments).toHaveLength(3);
    expect(segments[0]).toBe('chose postgres ');
    expect(segments[2]).toBe(' today');
    const s = segments[1] as Stretch;
    expect(s.short).toBe('why');
    expect(s.long).toEqual(['it fits the brief']);
    expect(s.isClosed).toBe(true);
    expect(isOpenable(s)).toBe(true);
  });

  it('stretches nest inside long forms', () => {
    const [outer] = parse('{{outer|has {{inner|deep}} end}}') as Stretch[];
    expect(outer.short).toBe('outer');
    const inner = stretchesOf(outer.long ?? []).find((s) => s !== outer)!;
    expect(inner.short).toBe('inner');
    expect(inner.long).toEqual(['deep']);
    expect(inner.key).toBe('outer › inner');
  });

  it('an unclosed stretch is not openable and keeps its text', () => {
    const [s] = parse('{{short|long text') as Stretch[];
    expect(s.isClosed).toBe(false);
    expect(isOpenable(s)).toBe(false);
    expect(s.short).toBe('short');
    expect(s.long).toEqual(['long text']);
  });

  it('no pipe means plain text: nothing to open', () => {
    const [s] = parse('{{just words}}') as Stretch[];
    expect(s.short).toBe('just words');
    expect(s.long).toBeUndefined();
    expect(s.isClosed).toBe(true);
    expect(isOpenable(s)).toBe(false);
  });

  it('repeated sibling short forms get distinct keys', () => {
    const stretches = stretchesOf(parse('{{a|1}} and {{a|2}}'));
    expect(stretches.map((s) => s.key)).toEqual(['a', 'a~2']);
  });

  it('braces inside code spans never open a stretch', () => {
    expect(parse('run `{{x|y}}` now')).toEqual(['run `{{x|y}}` now']);
  });

  it('braces inside fenced blocks never open a stretch', () => {
    const text = 'before\n```\n{{x|y}}\n```\nafter';
    expect(parse(text)).toEqual([text]);
  });

  it('a stray closing brace pair is plain text', () => {
    expect(parse('a }} b')).toEqual(['a }} b']);
  });
});
