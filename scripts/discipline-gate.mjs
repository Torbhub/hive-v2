#!/usr/bin/env node
// discipline-gate.mjs — line-count ratchet for the god files (hive has no
// linter; growth is how these files got here). Any count above the checked-in
// baseline fails the gate. --update moves the baseline DOWN only. A missing
// baseline, a missing entry, or a missing file fails loud — a silent skip is
// a false green.
// Modes: --check (default) | --update (ratchet down) | --check-task-appends <root>.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = 'scripts/discipline-baseline.json';
const FILES = ['web/App.tsx', 'src/hub.ts', 'src/ui/HubApp.tsx', 'src/cli.ts', 'web/server.ts'];
const TASK_APPEND_MODULES = new Set(['src/hub.ts', 'src/state.ts', 'src/taskgate.ts']);

const usage = 'usage: node scripts/discipline-gate.mjs [--check|--update|--check-task-appends <root>]';
const appendMode = process.argv[2] === '--check-task-appends';
if ((appendMode && process.argv.length !== 4) || (!appendMode && process.argv.length > 3)) {
  console.error(usage);
  process.exit(2);
}
const mode = process.argv[2] ?? '--check';
if (!appendMode && !['--check', '--update'].includes(mode)) {
  console.error(usage);
  process.exit(2);
}

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

function sourceAppendErrors(sourceFile) {
  const errors = new Set();
  const localNames = new Set(['appendTaskEvent']);
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings
      && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const element of node.importClause.namedBindings.elements) {
        if ((element.propertyName?.text ?? element.name.text) === 'appendTaskEvent') localNames.add(element.name.text);
      }
    }
    if (ts.isVariableDeclaration(node)) {
      if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (ts.isIdentifier(element.name)
            && (element.propertyName?.text ?? element.name.text) === 'appendTaskEvent') {
            localNames.add(element.name.text);
          }
        }
      } else if (ts.isIdentifier(node.name) && node.initializer
        && ts.isPropertyAccessExpression(node.initializer) && node.initializer.name.text === 'appendTaskEvent') {
        localNames.add(node.name.text);
      }
    }
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (ts.isIdentifier(expression) && localNames.has(expression.text)) errors.add(sourceFile.fileName);
      if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'appendTaskEvent') {
        errors.add(sourceFile.fileName);
      }
      if (ts.isElementAccessExpression(expression)
        && ts.isStringLiteral(expression.argumentExpression)
        && expression.argumentExpression.text === 'appendTaskEvent') {
        errors.add(sourceFile.fileName);
      }
    }
    // Re-export aliases have no local import graph here, so fail closed.
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)
      && node.exportClause.elements.some((element) =>
        (element.propertyName?.text ?? element.name.text) === 'appendTaskEvent')) {
      errors.add(sourceFile.fileName);
    }
    ts.forEachChild(node, visit);
  };
  if (sourceFile.parseDiagnostics.length) errors.add(sourceFile.fileName);
  else visit(sourceFile);
  return errors;
}

function taskAppendErrors(root) {
  const errors = new Set();
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
        const name = relative(root, file);
        if (TASK_APPEND_MODULES.has(name)) continue;
        const sourceFile = ts.createSourceFile(name, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
          entry.name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        for (const error of sourceAppendErrors(sourceFile)) errors.add(error);
      }
    }
  };
  for (const area of ['src', 'web', 'tools']) {
    if (existsSync(join(root, area))) walk(join(root, area));
  }
  return [...errors].sort();
}

if (appendMode) {
  const errors = taskAppendErrors(process.argv[3]);
  if (errors.length) fail(`FAIL: raw appendTaskEvent outside locked transition modules: ${errors.join(', ')}`);
  console.log('task append gate: OK');
  process.exit(0);
}

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
const rawAppends = taskAppendErrors(ROOT);
if (rawAppends.length) fail(`FAIL: raw appendTaskEvent outside locked transition modules: ${rawAppends.join(', ')}`);
console.log('discipline gate: OK (no file above baseline, task appends sanctioned)');
