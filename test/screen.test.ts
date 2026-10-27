import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ansiClean, classify, dialogFingerprint, hasEmptyPrompt, hasSpinner, isNativeQuestion, lines, parseDialog, scrapeContext,
} from '../src/screen.js';

const fixtures = path.join(import.meta.dirname, 'fixtures');
function fixture(name: string): string[] {
  return lines(readFileSync(path.join(fixtures, name), 'utf8'));
}

describe('ansiClean', () => {
  it('strips escapes from an ansi capture to match the plain one', () => {
    const plain = readFileSync(path.join(fixtures, 'idle-empty-prompt.txt'), 'utf8');
    const ansi = readFileSync(path.join(fixtures, 'idle-empty-prompt.ansi.txt'), 'utf8');
    expect(ansiClean(ansi)).toBe(ansiClean(plain));
  });
});

describe('idle detection', () => {
  it('sees an empty prompt as idle', () => {
    const ls = fixture('idle-empty-prompt.txt');
    expect(hasEmptyPrompt(ls)).toBe(true);
    expect(hasSpinner(ls)).toBe(false);
    expect(classify(ls)).toBe('idle');
  });

  it('stays idle after a reply', () => {
    expect(classify(fixture('idle-after-reply.txt'))).toBe('idle');
    expect(classify(fixture('idle-after-list.txt'))).toBe('idle');
  });

  it('sees the braille spinner as working', () => {
    const ls = fixture('working.txt');
    expect(hasSpinner(ls)).toBe(true);
    expect(classify(ls)).toBe('working');
  });
});

describe('context scrape', () => {
  it('reads 0% from a fresh session', () => {
    expect(scrapeContext(fixture('idle-empty-prompt.txt'))).toEqual({ percent: 0, used: '0', window: '1M' });
  });
  it('reads the percent after a reply', () => {
    const ctx = scrapeContext(fixture('idle-after-reply.txt'));
    expect(ctx?.percent).toBe(3);
    expect(ctx?.used).toBe('26.7k');
  });
});

describe('native question detection', () => {
  it('matches only the captured native-question footer', () => {
    expect(isNativeQuestion(fixture('dialog-ask-user-question.txt'))).toBe(true);
    expect(isNativeQuestion(fixture('dialog-permission.txt'))).toBe(false);
    expect(isNativeQuestion(fixture('dialog-trust-menu.txt'))).toBe(false);
  });
});

describe('dialog parse', () => {
  it('parses the numbered permission dialog', () => {
    const d = parseDialog(fixture('dialog-permission.txt'));
    expect(d.kind).toBe('numbered');
    expect(d.options.map((o) => [o.n, o.label, o.offered])).toEqual([
      [1, 'Approve once', true],
      [2, 'Approve for this session', true],
      [3, 'Reject', true],
      [4, 'Reject with feedback', true],
    ]);
    expect(d.cursor).toBe(1);
    expect(d.esc).toBe(true);
    expect(d.fingerprint).toMatch(/^[0-9a-f]{40}$/);
    expect(d.text).toContain('Run this command?');
    expect(classify(fixture('dialog-permission.txt'))).toBe('dialog');
  });

  it('parses the trust menu as a menu with options and cursor', () => {
    const d = parseDialog(fixture('dialog-trust-menu.txt'));
    expect(d.kind).toBe('menu');
    expect(d.cursor).toBe(1);
    expect(d.esc).toBe(true);
    expect(d.text).toContain('Trust this folder');
    expect(d.options.map((o) => [o.n, o.label, o.detail, o.offered])).toEqual([
      [1, 'Trust this folder', 'Enable project MCP servers. Remembered for this folder.', true],
      [2, "Don't trust", 'Exit Kimi Code. Asked again next launch.', true],
    ]);
  });

  it('sees no dialog on an idle screen', () => {
    expect(parseDialog(fixture('idle-empty-prompt.txt')).kind).toBe('none');
  });

  it('fingerprint is stable and text-sensitive', () => {
    const a = parseDialog(fixture('dialog-permission.txt'));
    const b = parseDialog(fixture('dialog-permission.txt'));
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(dialogFingerprint(a.text + 'x')).not.toBe(a.fingerprint);
  });

  it('marks Type-something options not offered', () => {
    const ls = [
      ' ────────────────────────────────',
      '   ▶ 1. Approve once',
      '     2. Type something.',
      '   ↑/↓ select · 1/2 choose · ↵ confirm',
      ' ────────────────────────────────',
    ];
    const d = parseDialog(ls);
    expect(d.options[0].offered).toBe(true);
    expect(d.options[1].offered).toBe(false);
  });
});
