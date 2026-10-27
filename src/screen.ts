import { createHash } from 'node:crypto';
import type { HubDialog, HubDialogOption } from './types.js';

// Dim runs are placeholder text; escapes and nbsp would break the regexes below.
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
const NUMBERED_OPTION_RE = /^\s*(▶)?\s*(\d{1,2})\.\s+(.+?)\s*$/;
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

export function isNativeQuestion(ls: string[]): boolean {
  return ls.some((line) => /↑↓ select\s+\d+-\d+ \/ ↵ choose\s+←\/→\/tab switch\s+esc cancel/.test(line));
}

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

export function hasEmptyPrompt(ls: string[]): boolean {
  const tail = ls.filter((l) => l.trim() !== '').slice(-6);
  return tail.some((l) => EMPTY_PROMPT_RE.test(l));
}

export function hasSpinner(ls: string[]): boolean {
  // Kimi clears the spinner when it goes idle, so any spinner line on screen is live.
  return ls.some((l) => SPINNER_RE.test(l));
}

export type ScreenState = 'idle' | 'working' | 'dialog' | 'unknown';

export function classify(ls: string[]): ScreenState {
  if (parseDialog(ls).kind !== 'none') return 'dialog';
  if (hasSpinner(ls)) return 'working';
  if (hasEmptyPrompt(ls)) return 'idle';
  return 'unknown';
}// Dialog text is the block between the last two plain rules; with too few rules, the whole screen (a misread only refuses to type).
function dialogRegion(ls: string[]): string[] {
  const rules = ruleIndexes(ls);
  if (rules.length >= 2) return ls.slice(rules[rules.length - 2], rules[rules.length - 1] + 1);
  return ls;
}

export function dialogFingerprint(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

// A menu's option labels sit at the cursor line's label column and each one
// follows a blank or rule line; the lines under a label are its detail.
// Calibrated on the 2.1.1 trust menu (test/fixtures/dialog-trust-menu.txt).
function menuOptions(block: string[], cursorLine: number): { options: HubDialogOption[]; cursor: number } {
  const marker = block[cursorLine].match(/^\s*❯\s+/);
  const labelCol = marker ? marker[0].length : 0;
  const options: HubDialogOption[] = [];
  let cursor = 1;
  let current: HubDialogOption | null = null;
  for (let i = cursorLine; i < block.length; i++) {
    const l = block[i];
    // Strip the ❯ marker so the cursor line's label measures at labelCol too.
    const stripped = i === cursorLine ? l.replace(/^(\s*)❯\s+/, '$1') : l;
    const text = stripped.trim();
    if (text === '' || RULE_RE.test(l)) {
      current = null;
      continue;
    }
    const indent = stripped.length - stripped.trimStart().length;
    if ((i === cursorLine || indent === labelCol) && current === null) {
      current = {
        n: options.length + 1,
        label: text,
        detail: '',
        offered: !NOT_OFFERED_RE.test(text),
        saves_rule: SAVES_RULE_RE.test(text),
      };
      if (i === cursorLine) cursor = current.n;
      options.push(current);
    } else if (current) {
      current.detail = current.detail ? `${current.detail} ${text}` : text;
    }
  }
  return { options, cursor };
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
    if (menuCursor !== null) {
      const m = menuOptions(block, menuCursor - 1);
      return { kind: 'menu', text, options: m.options, cursor: m.cursor, esc, fingerprint };
    }
    return { kind: 'menu', text, options: [], cursor: null, esc, fingerprint };
  }
  return { kind: 'none', text, options: [], cursor: null, esc, fingerprint };
}
