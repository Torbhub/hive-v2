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
