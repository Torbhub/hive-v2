// Stretchtext markup: `{{short|long}}` in agent prose. The reader sees
// `short`; opening it puts `long` in its place. `long` may hold further
// stretches. Code spans and fences are copied as written, so braces in code
// never open a stretch.

export type Segment = string | Stretch;

export type Stretch = {
  /** Names the stretch by its short form and its parents', so sibling repeats take `~2`, `~3`. */
  key: string;
  short: string;
  /** Undefined when no `|` was written: then there is nothing to open. */
  long: Segment[] | undefined;
  /** False while the closing braces never arrived (truncated text). */
  isClosed: boolean;
};

const KEY_SEPARATOR = ' › ';

export function isOpenable(stretch: Stretch): boolean {
  return stretch.isClosed && stretch.long !== undefined;
}

type Frame = { stretch: Stretch; siblings: Map<string, number> };

/** Where the code span opening at `i` ends: past the next run of as many backticks, or at the text's end. */
function codeSpanEnd(text: string, i: number): number {
  const run = /^`+/.exec(text.slice(i))?.[0] ?? '`';
  const end = text.indexOf(run, i + run.length);
  return end === -1 ? text.length : end + run.length;
}

export function parse(text: string): Segment[] {
  const root: Segment[] = [];
  const stack: Frame[] = [];
  const rootSiblings = new Map<string, number>();

  const write = (chunk: string) => {
    const frame = stack.at(-1);
    if (frame && frame.stretch.long === undefined) {
      frame.stretch.short += chunk;
      return;
    }
    const segments = frame?.stretch.long ?? root;
    const last = segments.at(-1);
    if (typeof last === 'string') segments[segments.length - 1] = last + chunk;
    else segments.push(chunk);
  };

  let i = 0;
  while (i < text.length) {
    const frame = stack.at(-1);
    const isInShort = frame !== undefined && frame.stretch.long === undefined;

    const fenceStop = i === 0 || text[i - 1] === '\n' ? fenceEnd(text, i) : undefined;
    if (fenceStop !== undefined) {
      write(text.slice(i, fenceStop));
      i = fenceStop;
      continue;
    }

    if (text[i] === '`') {
      const stop = codeSpanEnd(text, i);
      write(text.slice(i, stop));
      i = stop;
      continue;
    }

    if (text.startsWith('{{', i) && !isInShort) {
      const stretch: Stretch = { key: '', short: '', long: undefined, isClosed: false };
      (frame?.stretch.long ?? root).push(stretch);
      stack.push({ stretch, siblings: new Map() });
      i += 2;
      continue;
    }

    if (isInShort && text[i] === '|') {
      frame.stretch.key = keyOf(frame.stretch.short, stack.at(-2), rootSiblings);
      frame.stretch.long = [];
      i += 1;
      continue;
    }

    if (frame && text.startsWith('}}', i)) {
      frame.stretch.isClosed = true;
      stack.pop();
      i += 2;
      continue;
    }

    write(text[i]);
    i += 1;
  }

  return root;
}

function keyOf(short: string, parent: Frame | undefined, rootSiblings: Map<string, number>): string {
  const name = short.trim();
  const siblings = parent?.siblings ?? rootSiblings;
  const seen = (siblings.get(name) ?? 0) + 1;
  siblings.set(name, seen);
  const own = seen === 1 ? name : `${name}~${seen}`;
  return parent ? `${parent.stretch.key}${KEY_SEPARATOR}${own}` : own;
}

/** Where a fenced code block opening at `start` ends (past its closing line), or undefined when no fence opens there. */
function fenceEnd(text: string, start: number): number | undefined {
  const lineEnd = (from: number) => {
    const end = text.indexOf('\n', from);
    return end === -1 ? text.length : end;
  };
  const opening = /^[ \t]*(`{3,}|~{3,})/.exec(text.slice(start, lineEnd(start)))?.[1];
  if (opening === undefined) return undefined;

  for (let at = lineEnd(start) + 1; at < text.length; at = lineEnd(at) + 1) {
    const line = text.slice(at, lineEnd(at)).trim();
    if (line.length >= opening.length && [...line].every((c) => c === opening[0])) {
      return Math.min(lineEnd(at) + 1, text.length);
    }
  }

  return text.length;
}
