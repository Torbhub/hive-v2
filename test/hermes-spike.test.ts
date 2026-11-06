import { describe, expect, it } from 'vitest';
import { runHermesFixture } from '../tools/hermes-spike/fixture.js';

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(value)}\n`);

const init = { timestamp: 1, type: 'system', subtype: 'init', session_id: 'session-1', model: 'fixture' };
const tokens = { input: 3, output: 2, total: 5, cache_read: 0, cache_write: 0 };
const result = (exitCode = 0, text = 'done') => ({
  timestamp: 1,
  type: 'result',
  session_id: 'session-1',
  exit_code: exitCode,
  text,
  tokens,
  duration_ms: 10,
});

describe('Hermes no-model fixture lifecycle', () => {
  it('keeps native order and succeeds after a matching result, EOF, and exit', () => {
    const outcome = runHermesFixture([
      {
        type: 'stdout',
        bytes: new Uint8Array([
          ...encode(init),
          ...encode({ timestamp: 1, type: 'text', text: 'do' }),
          ...encode({ timestamp: 1, type: 'tool_use', name: 'read', tool_call_id: 'tool-1' }),
          ...encode({ timestamp: 1, type: 'tool_result', name: 'read', duration_ms: 1, is_error: false, output: 'ok', tool_call_id: 'tool-1' }),
          ...encode(result()),
        ]),
      },
      { type: 'eof' },
      { type: 'exit', code: 0 },
    ]);

    expect(outcome.trace.map((entry) => entry.kind)).toEqual([
      'system', 'text', 'tool_use', 'tool_result', 'result', 'eof', 'exit',
    ]);
    expect(outcome.state).toBe('succeeded');
    expect(outcome.finalText).toBe('done');
    expect(outcome.usage).toEqual(tokens);
    expect(outcome.terminalTransitions).toBe(1);
  });

  it('fails after a matching native failure, EOF, and exit', () => {
    const outcome = runHermesFixture([
      { type: 'stdout', bytes: encode(result(1, 'native failure')) },
      { type: 'eof' },
      { type: 'exit', code: 1 },
    ]);

    expect(outcome.state).toBe('failed');
    expect(outcome.finalText).toBeUndefined();
    expect(outcome.terminalTransitions).toBe(1);
  });

  it('keeps EOF without a result unknown and preserves partial text', () => {
    const outcome = runHermesFixture([
      { type: 'stdout', bytes: encode({ timestamp: 1, type: 'text', text: 'unfinished' }) },
      { type: 'eof' },
    ]);

    expect(outcome.state).toBe('unknown');
    expect(outcome.partialText).toBe('unfinished');
    expect(outcome.finalText).toBeUndefined();
  });

  it('keeps a successful result with a failing process exit unknown', () => {
    const outcome = runHermesFixture([
      { type: 'stdout', bytes: encode(result()) },
      { type: 'eof' },
      { type: 'exit', code: 1 },
    ]);

    expect(outcome.state).toBe('unknown');
    expect(outcome.finalText).toBeUndefined();
  });

  it('never infers success from exit zero without a result', () => {
    const outcome = runHermesFixture([
      { type: 'stdout', bytes: encode({ timestamp: 1, type: 'text', text: 'partial' }) },
      { type: 'exit', code: 0 },
    ]);

    expect(outcome.state).toBe('unknown');
    expect(outcome.partialText).toBe('partial');
  });

  it('waits for EOF and exit after a result', () => {
    const outcome = runHermesFixture([{ type: 'stdout', bytes: encode(result()) }]);

    expect(outcome.state).toBe('cleanup-pending');
    expect(outcome.finalText).toBeUndefined();
    expect(outcome.terminalTransitions).toBe(0);
  });

  it('preserves late text as non-final without a second terminal transition', () => {
    const outcome = runHermesFixture([
      {
        type: 'stdout',
        bytes: new Uint8Array([...encode(result()), ...encode({ timestamp: 1, type: 'text', text: 'late' })]),
      },
      { type: 'eof' },
      { type: 'exit', code: 0 },
    ]);

    expect(outcome.state).toBe('succeeded');
    expect(outcome.finalText).toBe('done');
    expect(outcome.lateText).toEqual(['late']);
    expect(outcome.terminalTransitions).toBe(1);
  });

  it('deduplicates an identical result', () => {
    const outcome = runHermesFixture([
      { type: 'stdout', bytes: new Uint8Array([...encode(result()), ...encode(result())]) },
      { type: 'eof' },
      { type: 'exit', code: 0 },
    ]);

    expect(outcome.state).toBe('succeeded');
    expect(outcome.terminalTransitions).toBe(1);
  });

  it('fences the generation after conflicting results', () => {
    const outcome = runHermesFixture([
      {
        type: 'stdout',
        bytes: new Uint8Array([...encode(result()), ...encode(result(0, 'conflict'))]),
      },
      { type: 'eof' },
      { type: 'exit', code: 0 },
    ]);

    expect(outcome.state).toBe('unknown');
    expect(outcome.fenced).toBe(true);
    expect(outcome.finalText).toBeUndefined();
    expect(outcome.terminalTransitions).toBe(1);
  });

  it('preserves a tool result before its start without fabricating activity', () => {
    const outcome = runHermesFixture([
      {
        type: 'stdout',
        bytes: new Uint8Array([
          ...encode({ timestamp: 1, type: 'tool_result', name: 'read', duration_ms: 1, is_error: false, output: 'early', tool_call_id: 'tool-1' }),
          ...encode(result()),
        ]),
      },
      { type: 'eof' },
      { type: 'exit', code: 0 },
    ]);

    expect(outcome.trace.map((entry) => entry.kind)).toEqual(['tool_result', 'result', 'eof', 'exit']);
    expect(outcome.state).toBe('succeeded');
  });

  it('fences finalization after malformed JSON between valid records', () => {
    const first = encode({ timestamp: 1, type: 'text', text: 'keep' });
    const bytes = new Uint8Array([
      ...first,
      ...new TextEncoder().encode('not json\n'),
      ...encode(result()),
    ]);
    const outcome = runHermesFixture([
      { type: 'stdout', bytes },
      { type: 'eof' },
      { type: 'exit', code: 0 },
    ]);

    expect(outcome.state).toBe('unknown');
    expect(outcome.parserErrors).toEqual([{ kind: 'malformed-json', offset: first.length }]);
    expect(outcome.trace.map((entry) => entry.kind)).toEqual([
      'text', 'parser-error', 'result', 'eof', 'exit',
    ]);
    expect(outcome.partialText).toBe('keep');
    expect(outcome.finalText).toBeUndefined();
    expect(outcome.rawStdout).toEqual(bytes);
  });

  it('reports truncated JSON at EOF even when the process exits zero', () => {
    const bytes = new TextEncoder().encode('{"type":"result"');
    const outcome = runHermesFixture([
      { type: 'stdout', bytes },
      { type: 'eof' },
      { type: 'exit', code: 0 },
    ]);

    expect(outcome.state).toBe('unknown');
    expect(outcome.parserErrors).toEqual([{ kind: 'truncated-json', offset: 0 }]);
    expect(outcome.rawStdout).toEqual(bytes);
    expect(outcome.finalText).toBeUndefined();
  });

  it('preserves truncated UTF-8 bytes without replacement text becoming final', () => {
    const first = encode({ timestamp: 1, type: 'text', text: 'keep' });
    const bytes = new Uint8Array([
      ...first,
      ...new TextEncoder().encode('{"type":"text","text":"'),
      0xe2,
      0x82,
    ]);
    const outcome = runHermesFixture([
      { type: 'stdout', bytes },
      { type: 'eof' },
      { type: 'exit', code: 0 },
    ]);

    expect(outcome.state).toBe('unknown');
    expect(outcome.parserErrors).toEqual([{ kind: 'truncated-utf8', offset: first.length }]);
    expect(outcome.rawStdout).toEqual(bytes);
    expect(outcome.partialText).toBe('keep');
    expect(outcome.partialText).not.toContain('\uFFFD');
    expect(outcome.finalText).toBeUndefined();
  });

  it('requires a terminal cancellation receipt after client detachment', () => {
    const observations = [
      { type: 'cancel' } as const,
      { type: 'stdout', bytes: encode(result(130, 'detached')) } as const,
      { type: 'eof' } as const,
      { type: 'exit', code: 130 } as const,
    ];
    const detached = runHermesFixture(observations);
    const reconciled = runHermesFixture([
      ...observations,
      { type: 'receipt', status: 'interrupted' },
    ]);

    expect(detached.state).toBe('cleanup-pending');
    expect(detached.state).not.toBe('cancelled');
    expect(reconciled.state).toBe('cancelled');
    expect(reconciled.terminalTransitions).toBe(1);
  });

  it('becomes unknown when a deadline forces a stop before a result', () => {
    const outcome = runHermesFixture([
      { type: 'stdout', bytes: encode({ timestamp: 1, type: 'text', text: 'partial' }) },
      { type: 'deadline' },
      { type: 'forced-stop' },
    ]);

    expect(outcome.trace.map((entry) => [entry.kind, entry.state])).toEqual([
      ['text', 'running'],
      ['deadline', 'cancelling'],
      ['forced-stop', 'unknown'],
    ]);
    expect(outcome.partialText).toBe('partial');
    expect(outcome.fenced).toBe(true);
  });

  it('keeps conflict unknown against later cancel, deadline, native output, and receipt', () => {
    const outcome = runHermesFixture([
      {
        type: 'stdout',
        bytes: new Uint8Array([...encode(result()), ...encode(result(0, 'conflict'))]),
      },
      { type: 'cancel' },
      { type: 'deadline' },
      { type: 'stdout', bytes: encode({ timestamp: 1, type: 'text', text: 'late' }) },
      { type: 'receipt', status: 'interrupted' },
    ]);

    expect(outcome.state).toBe('unknown');
    expect(outcome.trace.map((entry) => entry.state)).toEqual([
      'cleanup-pending', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown',
    ]);
    expect(outcome.lateText).toEqual(['late']);
    expect(outcome.terminalTransitions).toBe(1);
  });

  it('keeps a parser error unknown after an interrupted receipt', () => {
    const outcome = runHermesFixture([
      { type: 'stdout', bytes: new TextEncoder().encode('not json\n') },
      { type: 'receipt', status: 'interrupted' },
    ]);

    expect(outcome.state).toBe('unknown');
    expect(outcome.trace.at(-1)).toEqual({ kind: 'receipt', state: 'unknown' });
    expect(outcome.terminalTransitions).toBe(1);
  });

  it('keeps a forced stop unknown after later cancellation evidence', () => {
    const outcome = runHermesFixture([
      { type: 'deadline' },
      { type: 'forced-stop' },
      { type: 'stdout', bytes: encode(result(130, 'detached')) },
      { type: 'eof' },
      { type: 'exit', code: 130 },
      { type: 'receipt', status: 'interrupted' },
    ]);

    expect(outcome.state).toBe('unknown');
    expect(outcome.trace.at(-1)).toEqual({ kind: 'receipt', state: 'unknown' });
    expect(outcome.finalText).toBeUndefined();
    expect(outcome.terminalTransitions).toBe(1);
  });

  it('resolves an interrupted receipt before result 130 exactly like receipt last', () => {
    const receiptFirst = runHermesFixture([
      { type: 'receipt', status: 'interrupted' },
      { type: 'stdout', bytes: encode(result(130, 'detached')) },
      { type: 'eof' },
      { type: 'exit', code: 130 },
    ]);
    const receiptLast = runHermesFixture([
      { type: 'stdout', bytes: encode(result(130, 'detached')) },
      { type: 'eof' },
      { type: 'exit', code: 130 },
      { type: 'receipt', status: 'interrupted' },
    ]);

    expect(receiptFirst.state).toBe('cancelled');
    expect(receiptFirst.state).toBe(receiptLast.state);
    expect(receiptFirst.finalText).toBe(receiptLast.finalText);
    expect(receiptFirst.usage).toEqual(receiptLast.usage);
    expect(receiptFirst.terminalTransitions).toBe(1);
    expect(receiptFirst.terminalTransitions).toBe(receiptLast.terminalTransitions);
  });

  it('fences an interrupted receipt that conflicts with success or failure results', () => {
    for (const exitCode of [0, 1]) {
      const receiptFirst = runHermesFixture([
        { type: 'receipt', status: 'interrupted' },
        { type: 'stdout', bytes: encode(result(exitCode)) },
        { type: 'eof' },
        { type: 'exit', code: exitCode },
      ]);
      const receiptLast = runHermesFixture([
        { type: 'stdout', bytes: encode(result(exitCode)) },
        { type: 'eof' },
        { type: 'exit', code: exitCode },
        { type: 'receipt', status: 'interrupted' },
      ]);

      expect(receiptFirst.state).toBe('unknown');
      expect(receiptLast.state).toBe('unknown');
      expect(receiptFirst.fenced).toBe(true);
      expect(receiptLast.fenced).toBe(true);
      expect(receiptFirst.finalText).toBeUndefined();
      expect(receiptLast.finalText).toBeUndefined();
    }
  });

  it('keeps native output after cancel in cancelling', () => {
    const outcome = runHermesFixture([
      { type: 'cancel' },
      { type: 'stdout', bytes: encode({ timestamp: 1, type: 'text', text: 'after' }) },
    ]);

    expect(outcome.state).toBe('cancelling');
    expect(outcome.trace.at(-1)).toEqual({ kind: 'text', state: 'cancelling' });
    expect(outcome.partialText).toBe('after');
  });

  it('keeps native output after deadline in cancelling', () => {
    const outcome = runHermesFixture([
      { type: 'deadline' },
      { type: 'stdout', bytes: encode({ timestamp: 1, type: 'text', text: 'after' }) },
    ]);

    expect(outcome.state).toBe('cancelling');
    expect(outcome.trace.at(-1)).toEqual({ kind: 'text', state: 'cancelling' });
    expect(outcome.partialText).toBe('after');
  });

  it('rejects non-object JSON records without throwing', () => {
    for (const value of [null, ['text'], 'text', 7, true]) {
      const bytes = encode(value);
      const outcome = runHermesFixture([
        { type: 'stdout', bytes },
        { type: 'eof' },
        { type: 'exit', code: 0 },
      ]);

      expect(outcome.state).toBe('unknown');
      expect(outcome.parserErrors).toEqual([{ kind: 'invalid-schema', offset: 0 }]);
      expect(outcome.rawStdout).toEqual(bytes);
      expect(outcome.finalText).toBeUndefined();
    }
  });

  it('rejects missing fields and invalid native event schemas', () => {
    const invalidEvents: unknown[] = [
      { timestamp: 1, type: 'text' },
      { ...result(), tokens: null },
      { ...result(), exit_code: '0' },
      { timestamp: 1, type: 'tool_use', name: 42 },
      { timestamp: 1, type: 'tool_result', name: 'read', output: 'ok' },
      { timestamp: 1, type: 'system', subtype: 'init', session_id: 'session-1' },
      { timestamp: 1, type: 'unknown' },
      { type: 'text', text: 'missing timestamp' },
    ];
    for (const value of invalidEvents) {
      const outcome = runHermesFixture([
        { type: 'stdout', bytes: encode(value) },
        { type: 'eof' },
        { type: 'exit', code: 0 },
      ]);

      expect(outcome.state).toBe('unknown');
      expect(outcome.parserErrors).toEqual([{ kind: 'invalid-schema', offset: 0 }]);
      expect(outcome.finalText).toBeUndefined();
    }
  });
});
