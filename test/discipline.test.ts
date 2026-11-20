import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'discipline-gate.mjs');

function fixture(file: string, source = "import { appendTaskEvent } from './state.js';\nappendTaskEvent(root, event);\n"): string {
  const root = mkdtempSync(path.join(tmpdir(), 'hive-discipline-'));
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), source);
  return root;
}

function check(root: string) {
  return spawnSync(process.execPath, [SCRIPT, '--check-task-appends', root], { encoding: 'utf8' });
}

function checkEnforcement(root: string) {
  return spawnSync(process.execPath, [SCRIPT, '--check-enforcement', root], { encoding: 'utf8' });
}

describe('raw task append discipline', () => {
  it('allows calls in the sanctioned locked transition module', () => {
    const result = check(fixture('src/taskgate.ts'));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('task append gate: OK');
  });

  it.each([
    { name: 'direct call', file: 'web/actions.ts', source: "import { appendTaskEvent } from './state.js';\nappendTaskEvent(root, event);\n" },
    { name: 'TSX', file: 'web/Component.tsx', source: "import { appendTaskEvent } from './state.js';\nexport const Component = () => <div>{appendTaskEvent(root, event)}</div>;\n" },
    { name: 'import alias', file: 'web/alias.ts', source: "import { appendTaskEvent as append } from './state.js';\nappend(root, event);\n" },
    { name: 'namespace call', file: 'web/namespace.ts', source: "import * as state from './state.js';\nstate.appendTaskEvent(root, event);\n" },
    { name: 'dynamic alias', file: 'web/dynamic.ts', source: "async function run() { const { appendTaskEvent: append } = await import('./state.js'); append(root, event); }\n" },
    { name: 'dynamic namespace', file: 'web/dynamic-namespace.ts', source: "(await import('./state.js')).appendTaskEvent(root, event);\n" },
    { name: 're-export alias', file: 'web/reexport.ts', source: "import { appendTaskEvent as append } from './taskgate.js';\nappend(root, event);\n" },
  ])('rejects a forbidden $name', ({ file, source }) => {
    const result = check(fixture(file, source));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(file);
  });
});

describe('worker enforcement dependencies', () => {
  it('allows admission in spawn and team writes in sanctioned modules', () => {
    expect(checkEnforcement(fixture('src/spawn.ts', "import { admitTmux } from './admission.js';\nexport { admitTmux };\n")).status).toBe(0);
    expect(checkEnforcement(fixture('src/admission.ts', "import { writeJson } from './state.js';\nwriteJson(hivePath(home, 'team.json'), team);\n")).status).toBe(0);
  });

  it.each([
    { name: 'watch import', file: 'src/admission.ts', source: "import { watch } from './watch.js';\nexport { watch };\n" },
    { name: 'dynamic kill import', file: 'src/admission.ts', source: "export async function load() { return import('./kill.js'); }\n" },
    { name: 'web import', file: 'src/admission.ts', source: "import { act } from '../web/actions.js';\nexport { act };\n" },
    { name: 'team write alias', file: 'src/watch.ts', source: "import { writeJson as write } from './state.js';\nwrite(hivePath(home, 'team.json'), team);\n" },
    { name: 'namespace team write', file: 'src/kill.ts', source: "import * as state from './state.js';\nstate.writeJson(hivePath(home, 'team.json'), team);\n" },
    { name: 'legacy partial upsert', file: 'src/watch.ts', source: "import { upsertTeamEntry } from './state.js';\nupsertTeamEntry(home, { name: 'builder' });\n" },
  ])('rejects $name', ({ file, source }) => {
    const result = checkEnforcement(fixture(file, source));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(file);
  });
});

describe('evidence dependency discipline', () => {
  it('allows the real push adapter below evidence', () => {
    expect(checkEnforcement(fixture('src/evidence.ts', "import { pushByHash } from './gate.js';\nexport const push = pushByHash;\n")).status).toBe(0);
  });

  it.each([
    { name: 'gate imports evidence', file: 'src/gate.ts', source: "import { evaluate } from './evidence.js';\nexport { evaluate };\n" },
    { name: 'evidence imports web', file: 'src/evidence.ts', source: "import { act } from '../web/actions.js';\nexport { act };\n" },
    { name: 'evidence imports terminal UI', file: 'src/evidence.ts', source: "import { HubApp } from './ui/HubApp.js';\nexport { HubApp };\n" },
    { name: 'gate imports terminal UI', file: 'src/gate.ts', source: "export async function load() { return import('./ui/look.js'); }\n" },
  ])('rejects $name', ({ file, source }) => {
    const result = checkEnforcement(fixture(file, source));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(file);
  });
});

describe('native evidence dependency discipline', () => {
  it('allows evidence to read stored branches and construct a client only at the predicate seam', () => {
    expect(checkEnforcement(fixture('src/evidence.ts', "import { readNativeBranch } from './branches.js';\nexport { readNativeBranch };\n")).status).toBe(0);
    expect(checkEnforcement(fixture('src/evidence.ts', "import { createNativeBranchClient } from './native-client.js';\nexport { createNativeBranchClient };\n")).status).toBe(0);
  });

  it.each([
    { name: 'branches imports evidence', file: 'src/branches.ts', source: "import { evaluate } from './evidence.js';\nexport { evaluate };\n" },
    { name: 'branches imports hub', file: 'src/branches.ts', source: "import { record } from './hub.js';\nexport { record };\n" },
    { name: 'branches imports native client', file: 'src/branches.ts', source: "export async function load() { return import('./native-client.js'); }\n" },
    { name: 'evidence dynamically imports Kimi server', file: 'src/evidence.ts', source: "export async function load() { return import('./kimi-server.js'); }\n" },
  ])('rejects $name', ({ file, source }) => {
    const result = checkEnforcement(fixture(file, source));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(file);
  });
});
