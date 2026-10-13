import { createHash } from 'node:crypto';
import type { HubDialog, HubDialogOption } from './types.js';

// Port of hh_pane_clean: dim runs (placeholder text), CSI/OSC escapes, no-break spaces.
export function ansiClean(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[(?:[01];)?2m.*?(?:\x1b\[(?:0|22)?m|$)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b[()][0-9A-Z]/g, '')
    .replace(/\u00a0/g, ' ');
}

export function lines(raw: string): string[] {
  return ansiClean(raw).split('\n');
}

// A horizontal rule: the input box's ╭─╮/╰─╯ rows or a dialog's plain ──── rule.
const RULE_RE = /^\s*[╭╰]?[─╌]{4,}[╮╯]?\s*$/;
// Empty prompt row inside the input box: `│ >` and nothing else.
const EMPTY_PROMPT_RE = /^\s*│\s*>\s*│?\s*$/;
// Kimi's spinner: a braille glyph, a word, an ellipsis — `⠼ thinking…`, `⠼ Thinking… · Tip: …`.
const SPINNER_RE = /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+\S[^…]*…/;
const CONTEXT_RE = /context:\s*(\d+)%\s*\(([^/\s]+)\s*\/\s*([^)\s]+)\)/;
const NUMBERED_OPTION_RE = /^\s*(▶)?\s*(\d)\.\s+(.+?)\s*$/;
const MENU_CURSOR_RE = /^\s*❯\s+(.+?)\s*$/;

// Phrases a live Kimi dialog shows, calibrated on 2.1.1 captures (test/fixtures/).
const DIALOG_PHRASES = [
  'Trust this folder',
  'Run this command?',
  'Esc to cancel',
  'Esc exit',
  '↑/↓ select',
  '↑↓ navigate',
  'Do you want to',
  'Allow this',
  'Approve once',
  'Press Enter to continue',
  'Enter to confirm',
];

// Options that need the owner's own text; a button cannot answer them (spec §4).
const NOT_OFFERED_RE = /^(Type something\.?|Chat about this)$/i;
const SAVES_RULE_RE = /always allow|don't ask again|switch to accept edits/i;

export type ContextInfo = { percent: number; used: string; window: string };

export function scrapeContext(ls: string[]): ContextInfo | null {
  for (let i = ls.length - 1; i >= 0; i--) {
    const m = ls[i].match(CONTEXT_RE);
    if (m) return { percent: Number(m[1]), used: m[2], window: m[3] };
  }
  return null;
}

function ruleIndexes(ls: string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < ls.length; i++) if (RULE_RE.test(ls[i])) out.push(i);
  return out;
}

// The prompt box and what is below it: from the second-to-last rule down, else everything.
function boxRegion(ls: string[]): string[] {
  const rules = ruleIndexes(ls);
  if (rules.length >= 2) return ls.slice(rules[rules.length - 2]);
  return ls;
}

export function hasEmptyPrompt(ls: string[]): boolean {
  const tail = ls.filter((l) => l.trim() !== '').slice(-6);
  return tail.some((l) => EMPTY_PROMPT_RE.test(l));
}

export function hasSpinner(ls: string[]): boolean {
  return boxRegion(ls).some((l) => SPINNER_RE.test(l));
}

export type ScreenState = 'idle' | 'working' | 'dialog' | 'unknown';

export function classify(ls: string[]): ScreenState {
  if (parseDialog(ls).kind !== 'none') return 'dialog';
  if (hasSpinner(ls)) return 'working';
  if (hasEmptyPrompt(ls)) return 'idle';
  return 'unknown';
}

// Dialog text = the block between the last two plain rules, or the whole screen
// when there are too few rules (refusing to type is the safe error either way).
function dialogRegion(ls: string[]): string[] {
  const rules = ruleIndexes(ls);
  if (rules.length >= 2) return ls.slice(rules[rules.length - 2], rules[rules.length - 1] + 1);
  return ls;
}

export function dialogFingerprint(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

export function parseDialog(ls: string[]): HubDialog {
  const none: HubDialog = { kind: 'none', text: '', options: [], cursor: null, esc: false, fingerprint: '' };
  const block = dialogRegion(ls);
  if (!block.some((l) => DIALOG_PHRASES.some((p) => l.includes(p)))) {
    if (!ls.some((l) => DIALOG_PHRASES.some((p) => l.includes(p)))) return none;
  }

  const options: HubDialogOption[] = [];
  let cursor: number | null = null;
  let menuCursor: number | null = null;
  block.forEach((l, i) => {
    const num = l.match(NUMBERED_OPTION_RE);
    if (num) {
      const label = num[3];
      if (num[1]) cursor = Number(num[2]);
      options.push({
        n: Number(num[2]),
        label,
        detail: '',
        offered: !NOT_OFFERED_RE.test(label),
        saves_rule: SAVES_RULE_RE.test(label),
      });
      return;
    }
    if (MENU_CURSOR_RE.test(l) && menuCursor === null) menuCursor = i + 1;
  });

  const text = block.map((l) => l.replace(/\s+$/, '')).join('\n').replace(/^\n+|\n+$/g, '');
  const fingerprint = dialogFingerprint(text);
  const esc =
    block.some((l) => /Esc (to cancel|exit)/.test(l)) || options.length > 0 || menuCursor !== null;
  if (options.length > 0) return { kind: 'numbered', text, options, cursor, esc, fingerprint };
  if (menuCursor !== null || block.some((l) => /↑↓ navigate/.test(l))) {
    return { kind: 'menu', text, options: [], cursor: menuCursor, esc, fingerprint };
  }
  return { kind: 'none', text, options: [], cursor: null, esc, fingerprint };
}
