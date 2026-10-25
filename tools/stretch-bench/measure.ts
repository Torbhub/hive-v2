// Measures the bench output: the skim/original word ratio, and a points-coverage proxy.
// The proxy takes each original's top claims — its first sentence, then each list item's first
// clause, up to three — and checks each claim against the skim: normalized substring, else fuzzy
// (most of the claim's content words present in the skim).
//   tsx tools/stretch-bench/measure.ts [--in tools/stretch-bench/results/replay.jsonl] \
//     [--root ~/.kimi-code/sessions] [--summary tools/stretch-bench/results/summary.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { makeOption } from './args.js';
import { repliesOf } from './extract.js';

const option = makeOption(process.argv.slice(2));
const input = option('--in', new URL('./results/replay.jsonl', import.meta.url).pathname);
const root = option('--root', `${process.env.HOME}/.kimi-code/sessions`);
const summaryPath = option('--summary', new URL('./results/summary.json', import.meta.url).pathname);

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
const contentWords = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length >= 4));

/** First sentence, then each list item's first clause, most important first, at most three. */
export function claimsOf(original: string): string[] {
  const claims: string[] = [];
  const firstSentence = original.trim().split(/(?<=[.!?])\s/)[0]?.trim() ?? '';
  if (firstSentence && !/^\s*(?:[-*]|\d+[.)])/.test(firstSentence)) claims.push(firstSentence);
  for (const line of original.split('\n')) {
    const m = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)$/);
    if (!m) continue;
    const clause = (m[1] ?? '').split(/[:;—]| - /)[0]?.trim() ?? '';
    if (clause) claims.push(clause);
    if (claims.length >= 3) break;
  }
  return claims.slice(0, 3);
}

/** Substring after normalization, else fuzzy: >= 70% of the claim's content words in the skim. */
export function covered(claim: string, skim: string): boolean {
  const nClaim = norm(claim), nSkim = norm(skim);
  if (nClaim !== '' && nSkim.includes(nClaim)) return true;
  const bag = contentWords(claim);
  if (bag.size === 0) return false;
  const skimWords = new Set(nSkim.split(' '));
  return [...bag].filter((w) => skimWords.has(w)).length / bag.size >= 0.7;
}

type Row = { wire: string; turn: string; originalWords: number; skimWords: number; skim: string };

export function report(rows: Row[], rootDir: string, summaryFile?: string): void {
  const wireCache = new Map<string, ReturnType<typeof repliesOf>>();
  const originals = (wire: string) => {
    if (!wireCache.has(wire)) wireCache.set(wire, repliesOf(`${rootDir}/${wire}`, rootDir));
    return wireCache.get(wire) ?? [];
  };

  const perReply = [];
  for (const row of rows) {
    const original = originals(row.wire).find((r) => r.turn === row.turn);
    if (!original) {
      console.error(`no original for ${row.wire} turn ${row.turn}; skipped`);
      continue;
    }
    const claims = claimsOf(original.text);
    const hits = claims.filter((c) => covered(c, row.skim)).length;
    perReply.push({
      wire: row.wire, turn: row.turn,
      originalWords: row.originalWords, skimWords: row.skimWords,
      ratio: row.originalWords === 0 ? 1 : row.skimWords / row.originalWords,
      claims: claims.length, hits,
    });
  }

  const tot = perReply.reduce(
    (a, r) => ({ ow: a.ow + r.originalWords, sw: a.sw + r.skimWords, claims: a.claims + r.claims, hits: a.hits + r.hits }),
    { ow: 0, sw: 0, claims: 0, hits: 0 },
  );
  const summary = {
    replies: perReply.length,
    originalWords: tot.ow,
    skimWords: tot.sw,
    skimRatio: tot.ow === 0 ? 1 : tot.sw / tot.ow,
    claims: tot.claims,
    claimsCovered: tot.hits,
    coverage: tot.claims === 0 ? 1 : tot.hits / tot.claims,
  };
  if (summaryFile) writeFileSync(summaryFile, JSON.stringify({ summary, perReply }, null, 2) + '\n');

  console.log(`replies: ${summary.replies}`);
  console.log(`skim ratio: ${(summary.skimRatio * 100).toFixed(1)}% (${summary.skimWords} / ${summary.originalWords} words)`);
  console.log(`top-3 coverage: ${(summary.coverage * 100).toFixed(1)}% (${summary.claimsCovered} / ${summary.claims} claims)`);
  for (const r of perReply) {
    console.log(`  ${r.wire}#${r.turn}: ${(r.ratio * 100).toFixed(0)}% words, ${r.hits}/${r.claims} claims`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('measure.ts')) {
  const rows = readFileSync(input, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row);
  report(rows, root, summaryPath);
}
