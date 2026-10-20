#!/usr/bin/env node
// discipline-gate.mjs — line-count ratchet for the god files (hive has no
// linter; growth is how these files got here). Any count above the checked-in
// baseline fails the gate. --update moves the baseline DOWN only. A missing
// baseline, a missing entry, or a missing file fails loud — a silent skip is
// a false green.
// Modes: --check (default, gate) | --update (regenerate, ratchet down only).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = 'scripts/discipline-baseline.json';
const FILES = ['web/App.tsx', 'src/hub.ts', 'src/ui/HubApp.tsx', 'src/cli.ts', 'web/server.ts'];

const usage = 'usage: node scripts/discipline-gate.mjs [--check|--update]';
if (process.argv.length > 3) {
  console.error(usage);
  process.exit(2);
}
const mode = process.argv[2] ?? '--check';
if (!['--check', '--update'].includes(mode)) {
  console.error(usage);
  process.exit(2);
}

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const counts = {};
for (const f of FILES) {
  const p = join(ROOT, f);
  if (!existsSync(p)) fail(`FAIL: tracked file missing on disk: ${f}`);
  // newline count, matching wc -l so the seeded baseline stays honest
  counts[f] = readFileSync(p, 'utf8').split('\n').length - 1;
}

const baselinePath = join(ROOT, BASELINE);

if (mode === '--update') {
  const old = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')).files ?? {} : {};
  const next = {};
  for (const f of FILES) {
    if (old[f] !== undefined && counts[f] > old[f]) {
      next[f] = old[f];
      console.error(`WARNING: ${f} is ${counts[f]} lines, over baseline ${old[f]} — REFUSED to ratchet up; the gate still fails until the file shrinks`);
    } else {
      next[f] = counts[f];
    }
  }
  writeFileSync(baselinePath, `${JSON.stringify({ version: 1, files: next }, null, 2)}\n`);
  console.log(`baseline written: ${BASELINE} (${FILES.length} files)`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  fail(`FAIL: ${BASELINE} missing — generate it with: node scripts/discipline-gate.mjs --update`);
}
const base = JSON.parse(readFileSync(baselinePath, 'utf8')).files;
if (!base) fail(`FAIL: ${BASELINE} missing files — regenerate with: node scripts/discipline-gate.mjs --update`);
const absent = FILES.filter((f) => base[f] === undefined);
if (absent.length) {
  fail(`FAIL: baseline missing entries: ${absent.join(', ')} — regenerate with: node scripts/discipline-gate.mjs --update`);
}

const over = FILES.filter((f) => counts[f] > base[f]);
const down = FILES.filter((f) => counts[f] < base[f]);
for (const f of FILES) {
  const marker = counts[f] > base[f] ? 'OVER' : counts[f] < base[f] ? 'down' : 'ok';
  console.log(`  ${f.padEnd(24)} baseline=${String(base[f]).padEnd(5)} current=${String(counts[f]).padEnd(5)} ${marker}`);
}

if (over.length) {
  fail(`FAIL: ${over.length} file(s) over baseline — shrink them; the baseline ratchets down only`);
}
if (down.length) {
  console.log(`note: ${down.length} file(s) below baseline — ratchet down with: node scripts/discipline-gate.mjs --update`);
}
console.log('discipline gate: OK (no file above baseline)');
