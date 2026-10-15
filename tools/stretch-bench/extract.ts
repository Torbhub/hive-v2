// Reads kimi-code wire.jsonl transcripts (~/.kimi-code/sessions/<wd>/<session>/agents/<agent>/wire.jsonl)
// into replies: one per turn, the turn's text parts concatenated. Turns with no text (pure tool
// turns) yield nothing.
//   tsx tools/stretch-bench/extract.ts [sessionsRoot]   — prints counts, no output files
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export type Reply = {
  /** Session-relative wire key, e.g. wd_x/session_y/agents/main/wire.jsonl. */
  wire: string;
  turn: string;
  text: string;
  words: number;
};

type WireRow = {
  type?: string;
  event?: { type?: string; turnId?: string; part?: { type?: string; text?: string } };
};

/** Words a person reads: whitespace-separated tokens holding a letter or a digit. */
export function words(text: string): number {
  return text.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
}

export function repliesOf(wirePath: string, sessionsRoot: string): Reply[] {
  const parts = new Map<string, string[]>();
  for (const line of readFileSync(wirePath, 'utf8').split('\n')) {
    if (!line) continue;
    let row: WireRow;
    try {
      row = JSON.parse(line) as WireRow;
    } catch {
      continue;
    }
    if (row.type !== 'context.append_loop_event') continue;
    const e = row.event;
    if (e?.type !== 'content.part' || e.part?.type !== 'text' || !e.part.text) continue;
    const turn = e.turnId ?? '?';
    parts.set(turn, [...(parts.get(turn) ?? []), e.part.text]);
  }
  const wire = path.relative(sessionsRoot, wirePath);
  return [...parts.entries()].map(([turn, texts]) => {
    const text = texts.join('\n\n').trim();
    return { wire, turn, text, words: words(text) };
  }).filter((r) => r.words > 0);
}

/** Every wire.jsonl under the sessions root, most recently modified first. */
export function wireFiles(sessionsRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (name === 'wire.jsonl') out.push(p);
    }
  };
  walk(sessionsRoot);
  return out.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

if (process.argv[1] && process.argv[1].endsWith('extract.ts')) {
  const root = process.argv[2] ?? `${process.env.HOME}/.kimi-code/sessions`;
  const files = wireFiles(root);
  const replies = files.flatMap((f) => repliesOf(f, root));
  const qualifying = replies.filter((r) => r.words >= 150);
  console.log(`wire files: ${files.length}, replies: ${replies.length}, >=150 words: ${qualifying.length}`);
}
