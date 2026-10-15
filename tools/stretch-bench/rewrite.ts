// Rewrites a sample of long replies (>= MIN_WORDS) as stretchtext skims, calling `kimi -p`
// through teamkimi, sequentially — the call is slow. Writes one JSON row per reply.
//   tsx tools/stretch-bench/rewrite.ts [--sample 20] [--seed 7] [--files 30] \
//     [--root ~/.kimi-code/sessions] [--out tools/stretch-bench/results/replay.jsonl]
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { run } from '../../src/tmux.js';
import { kimiEnv } from '../../src/watch.js';
import { makeOption } from './args.js';
import { repliesOf, wireFiles, words, type Reply } from './extract.js';
import { GUIDE } from './guide.js';
import { redact } from './redact.js';

const MIN_WORDS = 150;
const KIMI_TIMEOUT_MS = 300_000;

const option = makeOption(process.argv.slice(2));
const sample = Number(option('--sample', '20'));
const seed = Number(option('--seed', '7'));
const fileCount = Number(option('--files', '30'));
const root = option('--root', `${process.env.HOME}/.kimi-code/sessions`);
const out = option('--out', new URL('./results/replay.jsonl', import.meta.url).pathname);

/** A small seeded generator, so the same transcripts always give the same sample. */
function random(state: number) {
  return () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const PROMPT = (reply: string) =>
  `${GUIDE}\n\nBelow is a reply you wrote earlier in a coding session, before skims existed. Rewrite it as the skim, under the contract above. Output only the rewritten skim, nothing before or after it.\n\n<reply>\n${reply}\n</reply>`;

async function rewrite(reply: string, env: NodeJS.ProcessEnv): Promise<string> {
  const r = await run('kimi', ['-p', PROMPT(reply), '--output-format', 'stream-json'], undefined,
    { ...process.env, ...env, KIMI_CODE_NO_AUTO_UPDATE: '1' }, KIMI_TIMEOUT_MS);
  if (r.code !== 0) throw new Error(`kimi -p exited ${r.code}: ${r.stderr.split('\n')[0] ?? ''}`);
  // stream-json emits one event per line. Hook notices arrive as assistant events of their own,
  // with no distinguishing field — the only stable anchor is the label line the harness prints.
  const texts: string[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    const e = JSON.parse(line) as { role?: string; content?: string };
    if (e.role !== 'assistant' || typeof e.content !== 'string') continue;
    if (e.content.startsWith('UserPromptSubmit hook\n')) continue;
    texts.push(e.content);
  }
  if (texts.length === 0) throw new Error('no assistant event in the kimi output');
  return texts.join('\n\n').trim();
}

const pool = wireFiles(root).slice(0, fileCount)
  .flatMap((f) => repliesOf(f, root))
  .filter((r) => r.words >= MIN_WORDS);
const pick = random(seed);
for (let i = pool.length - 1; i > 0; i--) {
  const j = Math.floor(pick() * (i + 1));
  const a = pool[i] as Reply, b = pool[j] as Reply;
  pool[i] = b;
  pool[j] = a;
}
const chosen = pool.slice(0, sample);
console.error(`pool: ${pool.length} replies >= ${MIN_WORDS} words; rewriting ${chosen.length}`);

mkdirSync(path.dirname(out), { recursive: true });
const env = await kimiEnv();
const rows: unknown[] = [];
const started = Date.now();
const flush = () => writeFileSync(`${out}.tmp`, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
for (const [i, reply] of chosen.entries()) {
  try {
    const skim = redact(await rewrite(reply.text, env));
    rows.push({ wire: reply.wire, turn: reply.turn, originalWords: reply.words, skimWords: words(skim), skim });
    flush();
    console.error(`[${i + 1}/${chosen.length}] ${reply.wire} turn ${reply.turn}: ${reply.words} -> ${words(skim)} words (${Math.round((Date.now() - started) / 1000)}s elapsed)`);
  } catch (error) {
    console.error(`skipped ${reply.wire} turn ${reply.turn}: ${(error as Error).message.split('\n')[0]}`);
  }
}
flush();
renameSync(`${out}.tmp`, out);
console.error(`wrote ${rows.length} rows to ${out}`);
