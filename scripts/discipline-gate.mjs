#!/usr/bin/env node
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { commentInventory } from './discipline-comments.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = 'scripts/discipline-baseline.json';
const FILES = ['web/App.tsx', 'src/hub.ts', 'src/ui/HubApp.tsx', 'src/cli.ts', 'web/server.ts'];
const TASK_APPEND_MODULES = new Set([
  'src/hub.ts', 'src/state.ts', 'src/taskgate.ts', 'src/admission.ts', 'src/evidence.ts', 'src/questions.ts',
  'src/supervision.ts',
]);
const TEAM_WRITE_MODULES = new Set(['src/state.ts', 'src/admission.ts']);

const usage = 'usage: node scripts/discipline-gate.mjs [--check|--update|--check-task-appends <root>|--check-enforcement <root>|--inventory-comments [root]]';
const appendMode = process.argv[2] === '--check-task-appends';
const enforcementMode = process.argv[2] === '--check-enforcement';
const inventoryMode = process.argv[2] === '--inventory-comments';
const scopedMode = appendMode || enforcementMode;
if ((scopedMode && process.argv.length !== 4) || (inventoryMode && process.argv.length > 4)
  || (!scopedMode && !inventoryMode && process.argv.length > 3)) {
  console.error(usage);
  process.exit(2);
}
const mode = process.argv[2] ?? '--check';
if (!scopedMode && !inventoryMode && !['--check', '--update'].includes(mode)) {
  console.error(usage);
  process.exit(2);
}

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

if (inventoryMode) {
  const root = process.argv[3] ?? ROOT;
  try {
    console.log(JSON.stringify(commentInventory(root), null, 2));
  } catch (error) {
    fail(`FAIL: comment inventory: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(0);
}

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

function hasTeamJsonLiteral(sourceFile, node) {
  if (ts.isStringLiteral(node) && node.text === 'team.json') return true;
  let found = false;
  ts.forEachChild(node, (child) => { if (hasTeamJsonLiteral(sourceFile, child)) found = true; });
  return found;
}

function sourceWorkerErrors(sourceFile, name) {
  const errors = new Set();
  const writeAliases = new Set(['writeJson']);
  const bannedAdmissionImport = (specifier) => /(?:^|\/)(?:spawn|watch|kill|branches)\.js$/.test(specifier)
    || /(?:^|\/)web\//.test(specifier);
  const bannedEvidenceImport = (specifier) => name === 'src/gate.ts' && /(?:^|\/)evidence\.js$/.test(specifier)
    || ['src/gate.ts', 'src/evidence.ts'].includes(name)
      && (/(?:^|\/)(?:web|ui)\//.test(specifier) || ['react', 'ink'].includes(specifier));
  const bannedSliceSixImport = (specifier) => name === 'src/supervision.ts'
      && (/(?:^|\/)(?:watch|hub)(?:\.js)?$/.test(specifier) || /(?:^|\/)web\//.test(specifier))
    || ['web/App.tsx', 'web/WorkTree.tsx'].includes(name)
      && /(?:^|\/)src\/(?:state|hub|supervision|admission|branches)(?:\.js)?$/.test(specifier);
  const bannedNativeImport = (specifier) => name === 'src/branches.ts'
      && /(?:^|\/)(?:evidence|taskgate|hub|native-client|kimi-server)\.js$/.test(specifier)
    || name === 'src/evidence.ts' && /(?:^|\/)kimi-server\.js$/.test(specifier)
    || bannedSliceSixImport(specifier);
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (name === 'src/admission.ts' && bannedAdmissionImport(node.moduleSpecifier.text)) errors.add(name);
      if (bannedEvidenceImport(node.moduleSpecifier.text)) errors.add(name);
      if (bannedNativeImport(node.moduleSpecifier.text)) errors.add(name);
      if (node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        for (const element of node.importClause.namedBindings.elements) {
          if ((element.propertyName?.text ?? element.name.text) === 'writeJson') writeAliases.add(element.name.text);
        }
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
      for (const element of node.name.elements) {
        if (ts.isIdentifier(element.name) && (element.propertyName?.text ?? element.name.text) === 'writeJson') {
          writeAliases.add(element.name.text);
        }
      }
    }
    if (ts.isCallExpression(node)) {
      if (ts.isImportKeyword(node.expression) && ts.isStringLiteral(node.arguments[0])) {
        if (name === 'src/admission.ts' && bannedAdmissionImport(node.arguments[0].text)) errors.add(name);
        if (bannedEvidenceImport(node.arguments[0].text)) errors.add(name);
        if (bannedNativeImport(node.arguments[0].text)) errors.add(name);
      }
      const expression = node.expression;
      const writeCall = ts.isIdentifier(expression) && writeAliases.has(expression.text)
        || ts.isPropertyAccessExpression(expression) && /^(?:writeJson|writeFile|writeFileSync)$/.test(expression.name.text)
        || ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression)
          && /^(?:writeJson|writeFile|writeFileSync)$/.test(expression.argumentExpression.text);
      if (!TEAM_WRITE_MODULES.has(name) && writeCall
        && node.arguments.some((argument) => hasTeamJsonLiteral(sourceFile, argument))) errors.add(name);
      const legacyUpsert = ts.isIdentifier(expression) && expression.text === 'upsertTeamEntry'
        || ts.isPropertyAccessExpression(expression) && expression.name.text === 'upsertTeamEntry';
      if (name !== 'src/state.ts' && legacyUpsert) errors.add(name);
    }
    ts.forEachChild(node, visit);
  };
  if (sourceFile.parseDiagnostics.length) errors.add(name);
  else visit(sourceFile);
  return errors;
}

function workerEnforcementErrors(root) {
  const errors = new Set(taskAppendErrors(root));
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
        const name = relative(root, file);
        if (TEAM_WRITE_MODULES.has(name) && name !== 'src/admission.ts') continue;
        const sourceFile = ts.createSourceFile(name, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
          entry.name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        for (const error of sourceWorkerErrors(sourceFile, name)) errors.add(error);
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

if (enforcementMode) {
  const errors = workerEnforcementErrors(process.argv[3]);
  if (errors.length) fail(`FAIL: worker enforcement dependency or team write ban: ${errors.join(', ')}`);
  console.log('worker enforcement gate: OK');
  process.exit(0);
}

const dictionary = () => Object.create(null);
const regularFile = (file) => {
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
};
const counts = dictionary();
for (const f of FILES) {
  const p = join(ROOT, f);
  if (!regularFile(p)) fail(`FAIL: tracked file missing or not a regular file: ${f}`);
  counts[f] = readFileSync(p, 'utf8').split('\n').length - 1;
}

const baselinePath = join(ROOT, BASELINE);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validPath = (value) => value.length > 0 && !value.startsWith('/') && !value.split('/').includes('..');

function readBaseline(allowMissing) {
  if (!existsSync(baselinePath)) {
    if (allowMissing) return { files: dictionary(), comments: dictionary(), seedComments: true };
    fail(`FAIL: ${BASELINE} missing — generate it with: node scripts/discipline-gate.mjs --update`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch {
    fail(`FAIL: ${BASELINE} malformed JSON`);
  }
  if (!record(parsed) || parsed.version !== 1 || !record(parsed.files)
    || (parsed.comments !== undefined && !record(parsed.comments))) {
    fail(`FAIL: ${BASELINE} malformed structure`);
  }
  for (const [file, count] of Object.entries(parsed.files)) {
    if (!validPath(file) || !Number.isInteger(count) || count < 0) fail(`FAIL: ${BASELINE} malformed line count: ${file}`);
  }
  for (const [file, count] of Object.entries(parsed.comments ?? {})) {
    if (!validPath(file) || !Number.isInteger(count) || count <= 0) fail(`FAIL: ${BASELINE} malformed comment count: ${file}`);
  }
  return {
    files: Object.assign(dictionary(), parsed.files),
    comments: Object.assign(dictionary(), parsed.comments ?? {}),
    seedComments: parsed.comments === undefined,
  };
}

let inventory;
try {
  inventory = commentInventory(ROOT);
} catch (error) {
  fail(`FAIL: comment inventory: ${error instanceof Error ? error.message : String(error)}`);
}
const currentComments = dictionary();
for (const [file, lines] of Object.entries(inventory)) currentComments[file] = lines.length;
const baseline = readBaseline(mode === '--update');

if (mode === '--update') {
  const next = dictionary();
  for (const f of FILES) {
    if (Object.hasOwn(baseline.files, f) && counts[f] > baseline.files[f]) {
      next[f] = baseline.files[f];
      console.error(`WARNING: ${f} is ${counts[f]} lines, over baseline ${baseline.files[f]} — REFUSED to ratchet up; the gate still fails until the file shrinks`);
    } else {
      next[f] = counts[f];
    }
  }
  const nextComments = dictionary();
  for (const [file, count] of Object.entries(currentComments)) {
    const hasPrevious = Object.hasOwn(baseline.comments, file);
    const previous = hasPrevious ? baseline.comments[file] : undefined;
    if (!baseline.seedComments && !hasPrevious) {
      console.error(`WARNING: REFUSED to add new comment baseline: ${file}`);
    } else if (!baseline.seedComments && count > previous) {
      nextComments[file] = previous;
      console.error(`WARNING: REFUSED to ratchet comments up: ${file} (${previous} -> ${count})`);
    } else {
      nextComments[file] = count;
    }
  }
  writeFileSync(baselinePath, `${JSON.stringify({ version: 1, files: next, comments: nextComments }, null, 2)}\n`);
  console.log(`baseline written: ${BASELINE} (${FILES.length} line counts, ${Object.keys(nextComments).length} comment counts)`);
  process.exit(0);
}

const absent = FILES.filter((f) => !Object.hasOwn(baseline.files, f));
if (absent.length) {
  fail(`FAIL: baseline missing entries: ${absent.join(', ')} — regenerate with: node scripts/discipline-gate.mjs --update`);
}
const over = FILES.filter((f) => counts[f] > baseline.files[f]);
const down = FILES.filter((f) => counts[f] < baseline.files[f]);
for (const f of FILES) {
  const marker = counts[f] > baseline.files[f] ? 'OVER' : counts[f] < baseline.files[f] ? 'down' : 'ok';
  console.log(`  ${f.padEnd(24)} baseline=${String(baseline.files[f]).padEnd(5)} current=${String(counts[f]).padEnd(5)} ${marker}`);
}
if (over.length) fail(`FAIL: ${over.length} file(s) over baseline — shrink them; the baseline ratchets down only`);
if (down.length) console.log(`note: ${down.length} file(s) below baseline — ratchet down with: node scripts/discipline-gate.mjs --update`);

const stale = Object.keys(baseline.comments).filter((file) => !regularFile(join(ROOT, file))).sort();
if (stale.length) fail(`FAIL: stale baseline entries: ${stale.join(', ')}`);
const added = Object.keys(currentComments).filter((file) => !Object.hasOwn(baseline.comments, file)).sort();
const increased = Object.keys(currentComments).filter((file) => Object.hasOwn(baseline.comments, file)
  && currentComments[file] > baseline.comments[file]).sort();
if (added.length) console.error(`FAIL: new files with comments: ${added.join(', ')}`);
if (increased.length) console.error(`FAIL: increased comment counts: ${increased.join(', ')}`);
for (const file of [...added, ...increased].sort()) {
  for (const line of inventory[file]) console.error(`comment ${file}:${line}`);
}
if (added.length || increased.length) fail('FAIL: comment baseline ratchets down only');
const commentsDown = Object.keys(baseline.comments).filter((file) => Object.hasOwn(currentComments, file)
  && currentComments[file] < baseline.comments[file]);
if (commentsDown.length) {
  console.log(`note: ${commentsDown.length} file(s) below comment baseline — ratchet down with: node scripts/discipline-gate.mjs --update`);
}
const workerErrors = workerEnforcementErrors(ROOT);
if (workerErrors.length) fail(`FAIL: worker enforcement dependency or team write ban: ${workerErrors.join(', ')}`);
console.log(`discipline gate: OK (${Object.keys(currentComments).length} files with comments, no ratchet increases)`);
