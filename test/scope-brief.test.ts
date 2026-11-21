import { promises as fs } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hubTask } from '../src/hub.js';
import { taskScope } from '../src/scope.js';
import { hubPath } from '../src/state.js';
import { brief, setup } from './scope-fixture.js';

describe('taskScope', () => {
  it('parses plain bullets', () => {
    const s = taskScope(brief('- src/a.ts — one line\n- src/b.ts (~10 lines)'));
    expect(s).toEqual({ kind: 'claim', paths: new Set(['src/a.ts', 'src/b.ts']) });
  });

  it('parses NEW prefixes and backticks', () => {
    const s = taskScope(brief('- NEW src/new.ts — brand new\n- NEW `test/new.test.ts` (~50 lines)'));
    expect(s).toEqual({ kind: 'claim', paths: new Set(['src/new.ts', 'test/new.test.ts']) });
  });

  it('ignores continuation lines', () => {
    const s = taskScope(brief('- src/a.ts — ONE test reusing\n  this harness:'));
    expect(s).toEqual({ kind: 'claim', paths: new Set(['src/a.ts']) });
  });

  it('none when the section is missing', () => {
    expect(taskScope(brief(null)).kind).toBe('none');
    expect(taskScope('# demo-1\n\nplain task text\n').kind).toBe('none');
  });

  it('invalid on a pathless bullet or an empty section', () => {
    expect(taskScope(brief('- — no path here')).kind).toBe('invalid');
    expect(taskScope(brief('no bullets at all')).kind).toBe('invalid');
  });

  it('invalid when a bullet carries more than one path token', () => {
    expect(taskScope(brief('- src/a.ts, src/b.ts')).kind).toBe('invalid');
    expect(taskScope(brief('- src/a.ts src/b.ts')).kind).toBe('invalid');
  });

  it('invalid on a NEW bullet with no path', () => {
    expect(taskScope(brief('- NEW')).kind).toBe('invalid');
  });

  it('accepts annotations opened with a dash or a paren', () => {
    const s = taskScope(brief('- src/a.ts — one line\n- src/b.ts (~10 lines)\n- src/c.ts'));
    expect(s).toEqual({ kind: 'claim', paths: new Set(['src/a.ts', 'src/b.ts', 'src/c.ts']) });
  });

  it('invalid when frontmatter opens and never closes', () => {
    expect(taskScope('---\ntitle: "x"\n\n## Files to touch\n- src/a.ts\n').kind).toBe('invalid');
  });
});

describe('hubTask brief validation', () => {
  it('refuses a brief that does not parse', async () => {
    const { root } = await setup();
    await expect(hubTask(root, 'demo', '---\nno closer here')).rejects.toThrow(/does not parse/);
    await expect(hubTask(root, 'demo', brief('- — no path here'))).rejects.toThrow(/does not parse/);
  });

  it('records a brief verbatim, frontmatter at the top', async () => {
    const { root } = await setup();
    const text = brief('- src/a.ts — x');
    const id = await hubTask(root, 'demo', text);
    const written = await fs.readFile(hubPath(root, 'tasks', `${id}.md`), 'utf8');
    expect(written.startsWith('---\n')).toBe(true);
    expect(written).toBe(text);
  });

  it('keeps the plain-text shape for plain tasks', async () => {
    const { root } = await setup();
    const id = await hubTask(root, 'demo', 'add a /health endpoint');
    const written = await fs.readFile(hubPath(root, 'tasks', `${id}.md`), 'utf8');
    expect(written).toBe(`# ${id}\n\nadd a /health endpoint\n`);
  });
});
