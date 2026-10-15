import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repliesOf, words } from '../tools/stretch-bench/extract.js';
import { claimsOf, covered } from '../tools/stretch-bench/measure.js';

const loopEvent = (turnId: string, part: object) =>
  JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', turnId, part } });

function wireWith(lines: string[]): { root: string; file: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'wire-'));
  const file = path.join(root, 'wd_x/session_y/agents/main/wire.jsonl');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, lines.join('\n') + '\n');
  return { root, file };
}

describe('repliesOf', () => {
  it('concatenates a turn’s text parts and keys the reply by session-relative path', () => {
    const { root, file } = wireWith([
      '{"type":"metadata","protocol_version":"1.5"}',
      loopEvent('0', { type: 'think', think: 'planning' }),
      loopEvent('0', { type: 'text', text: 'First part.' }),
      loopEvent('0', { type: 'text', text: 'Second part.' }),
      loopEvent('1', { type: 'text', text: 'Next turn answer.' }),
    ]);
    const replies = repliesOf(file, root);
    expect(replies.map((r) => r.text)).toEqual(['First part.\n\nSecond part.', 'Next turn answer.']);
    expect(replies[0]?.wire).toBe('wd_x/session_y/agents/main/wire.jsonl');
    expect(replies[0]?.turn).toBe('0');
  });

  it('skips pure-tool turns, non-text parts, and malformed lines', () => {
    const { root, file } = wireWith([
      'not json',
      JSON.stringify({ type: 'context.append_loop_event', event: { type: 'tool.call', turnId: '0' } }),
      JSON.stringify({ type: 'context.append_message', message: { role: 'user', content: [] } }),
      loopEvent('1', { type: 'text', text: 'The only reply.' }),
    ]);
    const replies = repliesOf(file, root);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.turn).toBe('1');
  });

  it('drops turns whose text is only whitespace', () => {
    const { root, file } = wireWith([loopEvent('0', { type: 'text', text: '   ' })]);
    expect(repliesOf(file, root)).toEqual([]);
  });
});

describe('words', () => {
  it('counts only tokens holding a letter or a digit', () => {
    expect(words('one two — —— 3')).toBe(3);
  });
});

describe('claimsOf and covered', () => {
  it('takes the first sentence, then list-item first clauses, at most three', () => {
    const text = 'The build is green. More detail here.\n- Deployed the hub: it took 4 minutes\n- Fixed the gate; see PR 7\n- Fourth item ignored';
    expect(claimsOf(text)).toEqual(['The build is green.', 'Deployed the hub', 'Fixed the gate']);
  });

  it('matches a claim by normalized substring or by content-word overlap', () => {
    expect(covered('The build is green.', 'Skim: the build is green!')).toBe(true);
    expect(covered('Deployed the hub', 'Hub deploy finished; the hub was deployed cleanly')).toBe(true);
    expect(covered('Rotated the database password', 'The docs are updated.')).toBe(false);
  });
});
