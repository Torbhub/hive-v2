import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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


describe('supervision and work-tree dependency discipline', () => {
  it('allows the stored-record and registry seams', () => {
    expect(checkEnforcement(fixture('src/supervision.ts', "import { readTaskEvents } from './state.js';\nexport { readTaskEvents };\n")).status).toBe(0);
    expect(checkEnforcement(fixture('web/App.tsx', "import type { HubView } from '../src/types.js';\nexport type { HubView };\n")).status).toBe(0);
  });

  it.each([
    { name: 'watch import', file: 'src/supervision.ts', source: "import { watch } from './watch.js';\nexport { watch };\n" },
    { name: 'hub import', file: 'src/supervision.ts', source: "export async function load() { return import('./hub.js'); }\n" },
    { name: 'web import', file: 'src/supervision.ts', source: "import { act } from '../web/actions.js';\nexport { act };\n" },
    { name: 'App persistence import', file: 'web/App.tsx', source: "import { readTaskEvents } from '../src/state.js';\nexport { readTaskEvents };\n" },
    { name: 'tree adapter import', file: 'web/WorkTree.tsx', source: "import { buildWorkTree } from '../src/supervision.js';\nexport { buildWorkTree };\n" },
  ])('rejects $name', ({ file, source }) => {
    const result = checkEnforcement(fixture(file, source));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(file);
  });
});

const LINE_FILES = ['web/App.tsx', 'src/hub.ts', 'src/ui/HubApp.tsx', 'src/cli.ts', 'web/server.ts'];

function inventoryResult(root: string) {
  return spawnSync(process.execPath, [SCRIPT, '--inventory-comments', root], { encoding: 'utf8' });
}

function inventory(file: string, source: string): Record<string, number[]> {
  const result = inventoryResult(fixture(file, source));
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return JSON.parse(result.stdout) as Record<string, number[]>;
}

function commentFixture(comments: Record<string, number>, sources: Record<string, string> = {}, baseline = true): string {
  const root = fixture(LINE_FILES[0], '');
  for (const file of LINE_FILES.slice(1)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), '');
  }
  for (const [file, source] of Object.entries(sources)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), source);
  }
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  for (const file of ['discipline-gate.mjs', 'discipline-comments.mjs', 'discipline-python-comments.py']) {
    cpSync(path.join(path.dirname(SCRIPT), file), path.join(root, 'scripts', file));
  }
  symlinkSync(path.join(path.dirname(SCRIPT), '..', 'node_modules'), path.join(root, 'node_modules'), 'dir');
  if (baseline) {
    writeFileSync(path.join(root, 'scripts', 'discipline-baseline.json'), JSON.stringify({
      version: 1,
      files: Object.fromEntries(LINE_FILES.map((file) => [file, 0])),
      comments,
    }));
  }
  return root;
}

function discipline(root: string, mode = '--check') {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'discipline-gate.mjs'), mode], { cwd: root, encoding: 'utf8' });
}

describe('comment inventory scanners', () => {
  it('uses the TypeScript scanner for strings, regexes, templates, trailing and multiline comments', () => {
    const source = 'const url = "https://example.test/a//b#c";\nconst regex = /\\/\\/ not a comment/;\n// standalone\nconst value = 1; // trailing\n/* first\n * second\n */\nconst template = `// no\n/* no\n`;\ntry {} catch { /* detached */ }\n';
    expect(inventory('src/scanner.ts', source)).toEqual({ 'src/scanner.ts': [3, 4, 5, 6, 7, 11] });
  });

  it('distinguishes TSX comments from text and string data', () => {
    const source = 'const text = <div title="// no">{/* real */}<span>{"// no"}</span></div>;\n// next\n';
    expect(inventory('web/component.tsx', source)).toEqual({ 'web/component.tsx': [1, 2] });
  });

  it.each([
    ['src/script.js', '// javascript\n'],
    ['src/module.mjs', '/* module\ncomment */\n'],
    ['src/config.jsonc', '{\n// jsonc\n"url": "https://example.test"\n}\n'],
  ])('scans %s', (file, source) => {
    const lines = file.endsWith('.mjs') ? [1, 2] : file.endsWith('.jsonc') ? [2] : [1];
    expect(inventory(file, source)).toEqual({ [file]: lines });
  });

  it('uses Python tokens rather than matching string contents', () => {
    const source = '#!/usr/bin/env python3\nvalue = "# no"\ntext = """\n# no\n"""\n# yes\nvalue = 1 # trailing\n';
    expect(inventory('scripts/example.py', source)).toEqual({ 'scripts/example.py': [6, 7] });
  });

  it('handles shell quotes, shebangs, trailing comments and indented heredocs', () => {
    const source = '#!/usr/bin/env bash\necho \'# no\' "# no" https://example.test/#fragment\necho ok # trailing\ncat <<\'EOF\'\n# heredoc\nEOF\ncat <<-TXT\n\t# indented heredoc\n\tTXT\nprintf \'%s\' "multi\n# still string";\nprintf ok # after\n';
    expect(inventory('scripts/example.sh', source)).toEqual({ 'scripts/example.sh': [3, 12] });
  });

  it('distinguishes shell arithmetic shifts from real heredocs', () => {
    const source = 'value=$((1 << 2)) # arithmetic\n((value = value << 1)) # command\ncat <<EOF\n# data\nEOF\n# after\n';
    expect(inventory('scripts/arithmetic.sh', source)).toEqual({ 'scripts/arithmetic.sh': [1, 2, 6] });
  });

  it('does not treat a here-string as a heredoc', () => {
    expect(inventory('scripts/here-string.sh', 'grep -q value <<<"$body"\necho ok # after\n')).toEqual({ 'scripts/here-string.sh': [2] });
  });

  it('fails closed on an unterminated active heredoc', () => {
    const result = inventoryResult(fixture('scripts/active.sh', 'cat <<EOF\n# data\n'));
    expect(result.stderr).toContain('unterminated heredoc');
    expect(result.status).toBe(1);
  });

  it('fails closed on an unterminated pending heredoc', () => {
    const result = inventoryResult(fixture('scripts/pending.sh', 'cat <<EOF "unterminated\n'));
    expect(result.stderr).toContain('unterminated heredoc');
    expect(result.status).toBe(1);
  });

  it('ignores YAML quoted strings, tags, anchors, and block scalar bodies', () => {
    const source = 'url: https://example.test/#fragment\nquoted: "# no"\nblock: &literal |\n  # no\n  text\nFn::Base64: !Sub |-\n  #!/usr/bin/env bash\n  # no\nafter: yes # trailing\n# standalone\n';
    expect(inventory('.github/workflows/example.yml', source)).toEqual({ '.github/workflows/example.yml': [9, 10] });
  });

  it('counts multiline CSS comments but not string data', () => {
    const source = 'a::before { content: "/* no */"; }\na { color: red; } /* one\ntwo\nthree */\n';
    expect(inventory('web/app.css', source)).toEqual({ 'web/app.css': [2, 3, 4] });
  });

  it('counts HTML and embedded code comments outside attributes and string data', () => {
    const source = '<div title="<!-- no -->"></div>\n<!-- one\ntwo -->\n<script>const x = "<!-- no -->";</script>\n<script>// embedded\nconst x = 1;</script>\n<style>/* style\nstyle */</style>\n';
    expect(inventory('web/index.html', source)).toEqual({ 'web/index.html': [2, 3, 5, 7, 8] });
  });

  it('closes raw text only at exact HTML tag names', () => {
    const source = '<script>const fake = "</scripture>"; // javascript\n</script>\n<style>.x::after { content: "</stylesheet>"; } /* css\nmore */\n</style>\n';
    expect(inventory('web/raw.html', source)).toEqual({ 'web/raw.html': [1, 3, 4] });
  });

  it.each(['script', 'style'])('fails closed on an unterminated %s raw-text region', (tag) => {
    const result = inventoryResult(fixture(`web/unterminated-${tag}.html`, `<${tag}>const value = 1;\n`));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`unterminated ${tag} raw-text region`);
  });

  it.each([
    ['Dockerfile', 'FROM node\nLABEL url="https://example.test/#x"\nRUN echo ok # trailing\n# standalone\n'],
    ['infra/settings.toml', 'url = "https://example.test/#x"\nvalue = 1 # trailing\n'],
    ['infra/settings.ini', '[section]\nvalue = "# no"\n; standalone\n'],
    ['infra/main.tf', 'resource "thing" "name" { # trailing\n  value = "https://example.test/#no"\n  text = <<-EOF\n    # no\n    // no\n  EOF\n  /* block\n  block */\n  value = 1 // line\n}\n'],
  ])('scans common infrastructure config in %s', (file, source) => {
    const lines = file.endsWith('.ini') ? [3] : file === 'Dockerfile' ? [3, 4]
      : file.endsWith('.tf') ? [1, 7, 8, 9] : [2];
    expect(inventory(file, source)).toEqual({ [file]: lines });
  });

  it('recognizes TOML comments without preceding whitespace', () => {
    const source = 'value = 1#comment\ntext = "# data"\n';
    expect(inventory('infra/no-space.toml', source)).toEqual({ 'infra/no-space.toml': [1] });
  });

  it('recognizes properties comments only at the first nonwhitespace character', () => {
    const source = '  # comment\n  ! comment\nkey=value#data\nquoted="#data"\n';
    expect(inventory('infra/settings.properties', source)).toEqual({ 'infra/settings.properties': [1, 2] });
  });

  it('scans supported languages inside Markdown fences with original line numbers', () => {
    const source = '# Example\n```ts\nconst url = "https://example.test";\n// yes\n/* two\nlines */\n```\n```shell\necho "# no"\necho ok # yes\n```\n';
    expect(inventory('docs/example.md', source)).toEqual({ 'docs/example.md': [4, 5, 6, 10] });
  });

  it('scans HTML comments outside Markdown fences without scanning plain fence data', () => {
    const source = '<!-- outer\ntwo -->\n```\n<!-- plain fence data -->\n```\n```html\n<!-- html fence comment -->\n```\nafter <!-- inline -->\n';
    expect(inventory('docs/comments.md', source)).toEqual({ 'docs/comments.md': [1, 2, 7, 9] });
  });

  it('masks variable-length and multiline Markdown code spans before HTML scanning', () => {
    const source = '`<!-- example data -->`\n<!-- real -->\n``<script>``\n``<style>``\n<!-- after -->\n``multi\n<!-- multiline data -->\n``\n<!-- final -->\n';
    expect(inventory('docs/inline.md', source)).toEqual({ 'docs/inline.md': [2, 5, 9] });
  });

  it('recognizes inline code only in Markdown text, not HTML attributes or raw JavaScript', () => {
    const attribute = '<div title="`"> <!-- attribute --> `\n';
    expect(inventory('docs/attribute.md', attribute)).toEqual({ 'docs/attribute.md': [1] });
    const javascript = '<script>const before = "`"; // javascript\nconst after = "`";</script>\n';
    expect(inventory('docs/javascript.md', javascript)).toEqual({ 'docs/javascript.md': [1] });
  });

  it('scans closed fenced code blocks in Markdown blockquote and list containers', () => {
    const source = '> ```ts\n> // quoted\n> const value = 1;\n> ```\n10. ```shell\n    echo ok # listed\n    echo done\n    ```\nafter <!-- outside -->\n';
    expect(inventory('docs/containers.md', source)).toEqual({ 'docs/containers.md': [2, 6, 9] });
  });

  it('normalizes mixed and nested Markdown container prefixes until stable', () => {
    const source = '- > ```ts\n  > // list quote\n  > ```\n> - ```shell\n>   echo ok # quote list\n>   ```\n- - ```ts\n    // nested list\n    ```\nafter <!-- outside -->\n';
    expect(inventory('docs/nested-containers.md', source)).toEqual({ 'docs/nested-containers.md': [2, 5, 8, 10] });
  });

  it('does not treat new list markers inside a root fence as closing fences', () => {
    const source = '~~~shell\n- ~~~\n# hidden\n~~~\nafter <!-- outside -->\n';
    expect(inventory('docs/root-fence.md', source)).toEqual({ 'docs/root-fence.md': [3, 5] });
  });

  it('does not recognize new container markers inside nested fence content', () => {
    const source = '- ~~~shell\n  - ~~~\n  # hidden\n  ~~~\nafter <!-- outside -->\n';
    expect(inventory('docs/nested-fence.md', source)).toEqual({ 'docs/nested-fence.md': [3, 5] });
  });

  it.each(['.gitignore', '.gitattributes', '.gitmodules'])('excludes the exact VCS file %s', (file) => {
    expect(inventory(file, '# excluded\n')).toEqual({});
  });

  it('does not exclude comments from files merely sharing the .git prefix', () => {
    expect(inventory('.gitlab-ci.yml', '# gitlab comment\n')).toEqual({ '.gitlab-ci.yml': [1] });
    expect(inventory('.git-evasion.sh', '#!/bin/sh\n# scanned\n')).toEqual({ '.git-evasion.sh': [2] });
  });

  it('excludes shebangs in scanned scripts and discovers extensionless hooks', () => {
    expect(inventory('scripts/example.mjs', '#!/usr/bin/env node\n// yes\n')).toEqual({ 'scripts/example.mjs': [2] });
    expect(inventory('scripts/git-hooks/pre-push', '#!/usr/bin/env bash\n# yes\n')).toEqual({ 'scripts/git-hooks/pre-push': [2] });
  });
});

describe('comment baseline discipline', () => {
  it('fails closed when the baseline is missing', () => {
    const result = discipline(commentFixture({}, {}, false));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('discipline-baseline.json missing');
  });

  it('fails closed on malformed comment counts', () => {
    const root = commentFixture({ 'src/a.ts': 1 });
    writeFileSync(path.join(root, 'scripts', 'discipline-baseline.json'), '{"version":1,"files":{},"comments":{"src/a.ts":"one"}}');
    const result = discipline(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('malformed');
  });

  it('rejects stale entries for missing files', () => {
    const result = discipline(commentFixture({ 'src/gone.ts': 1 }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('stale baseline entries: src/gone.ts');
  });

  it('rejects new files with deterministic path and line diagnostics', () => {
    const result = discipline(commentFixture({}, { 'src/new.ts': '// one\nconst n = 1; // two\n' }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('new files with comments: src/new.ts');
    expect(result.stderr).toContain('src/new.ts:1');
    expect(result.stderr).toContain('src/new.ts:2');
  });

  it.each(['constructor', '__proto__'])('rejects a new extensionless executable named %s', (file) => {
    const result = discipline(commentFixture({}, { [file]: '#!/bin/sh\n# comment\n' }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`new files with comments: ${file}`);
    expect(result.stderr).toContain(`${file}:2`);
  });

  it('rejects stale baseline paths that are not regular files', () => {
    const result = discipline(commentFixture({ 'src/gone.ts': 1 }, { 'src/gone.ts/child.txt': 'data\n' }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('stale baseline entries: src/gone.ts');
  });

  it('rejects a non-excluded file symlink during inventory', () => {
    const root = fixture('src/target.ts', '// target\n');
    symlinkSync('target.ts', path.join(root, 'src', 'linked.ts'), 'file');
    const result = inventoryResult(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/linked.ts');
    expect(result.stderr).toContain('symbolic link');
  });

  it('rejects a non-excluded directory symlink during inventory', () => {
    const root = fixture('src/target.ts', '// target\n');
    symlinkSync(path.join(root, 'src'), path.join(root, 'linked'), 'dir');
    const result = inventoryResult(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('linked');
    expect(result.stderr).toContain('symbolic link');
  });

  it('rejects increased comment counts', () => {
    const result = discipline(commentFixture({ 'src/a.ts': 1 }, { 'src/a.ts': '// one\n// two\n' }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('increased comment counts: src/a.ts');
    expect(result.stderr).toContain('src/a.ts:2');
  });

  it('updates downward and removes zero and stale comment entries', () => {
    const root = commentFixture({ 'src/a.ts': 3, 'src/gone.ts': 2 }, { 'src/a.ts': '// one\n' });
    expect(discipline(root, '--update').status).toBe(0);
    const updated = JSON.parse(readFileSync(path.join(root, 'scripts', 'discipline-baseline.json'), 'utf8'));
    expect(updated.comments).toEqual({ 'src/a.ts': 1 });
  });

  it('refuses to ratchet a comment count upward or add a new commented file', () => {
    const root = commentFixture({ 'src/a.ts': 1 }, { 'src/a.ts': '// one\n// two\n', 'src/new.ts': '// new\n' });
    const result = discipline(root, '--update');
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('REFUSED to ratchet comments up: src/a.ts');
    expect(result.stderr).toContain('REFUSED to add new comment baseline: src/new.ts');
    const updated = JSON.parse(readFileSync(path.join(root, 'scripts', 'discipline-baseline.json'), 'utf8'));
    expect(updated.comments).toEqual({ 'src/a.ts': 1 });
    expect(discipline(root).status).toBe(1);
  });
});

describe('tracked hook ownership', () => {
  it('upgrades executable and legacy markers without backing up foreign hooks', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hive-hooks-'));
    const project = path.join(path.dirname(SCRIPT), '..');
    mkdirSync(path.join(root, 'scripts', 'git-hooks'), { recursive: true });
    cpSync(path.join(project, 'scripts', 'install-git-hooks.sh'), path.join(root, 'scripts', 'install-git-hooks.sh'));
    cpSync(path.join(project, 'scripts', 'git-hooks', 'pre-push'), path.join(root, 'scripts', 'git-hooks', 'pre-push'));
    expect(spawnSync('git', ['init', '--quiet'], { cwd: root }).status).toBe(0);
    const install = () => spawnSync('bash', ['scripts/install-git-hooks.sh'], { cwd: root, encoding: 'utf8' });
    expect(install().status).toBe(0);
    const installed = path.join(root, '.git', 'hooks', 'pre-push');
    expect(readFileSync(installed, 'utf8')).toContain(": 'hive-v2 tracked hook: scripts/git-hooks/pre-push'");
    writeFileSync(installed, `${readFileSync(installed, 'utf8')}\n:\n`);
    expect(install().status).toBe(0);
    expect(readdirSync(path.dirname(installed)).some((file) => file.includes('.bak-'))).toBe(false);
    writeFileSync(installed, '#!/bin/sh\n# tracked in the repo at scripts/git-hooks/\nexit 0\n');
    expect(install().status).toBe(0);
    expect(readFileSync(installed, 'utf8')).toContain(": 'hive-v2 tracked hook: scripts/git-hooks/pre-push'");
    expect(readdirSync(path.dirname(installed)).some((file) => file.includes('.bak-'))).toBe(false);
    writeFileSync(installed, '#!/bin/sh\nexit 0\n');
    expect(install().status).toBe(0);
    expect(existsSync(installed)).toBe(true);
    expect(readdirSync(path.dirname(installed)).some((file) => file.includes('.bak-'))).toBe(true);
  });
});
