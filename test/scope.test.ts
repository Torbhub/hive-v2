import { promises as fs, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const IDLE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'idle-empty-prompt.txt'),
  'utf8',
);

vi.mock('../src/tmux.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/tmux.js')>();
  return {
    ...orig,
    run: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    newWindow: vi.fn(async () => '%9'),
    paneIdentity: vi.fn(async () => ({ pid: 4242, started: 'later' })),
    paneIs: vi.fn(async () => true),
    capturePane: vi.fn(async () => IDLE),
    sendLiteral: vi.fn(async () => {}),
    sendEnter: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
  };
});

import { taskScope } from '../src/scope.js';
import { spawnAgent } from '../src/spawn.js';
import { hubAdd, hubInit, hubTask } from '../src/hub.js';
import { appendTaskEvent, hivePath, hubPath, manifestRead, readTeam, writeJson } from '../src/state.js';

function spawn(root: string, opts: Parameters<typeof spawnAgent>[2]): Promise<string> {
  return spawnAgent(root, 'demo', {
    assignment: 'Complete the bounded scope assignment in the requested files.',
    deliverable: 'Return the named artifact and verification evidence to the orchestrator.',
    ...opts,
  });
}

function brief(scope: string | null): string {
  const fm = '---\ntitle: "x"\nstatus: ready\ndeps: []\nmax_diff_lines: 300\n---\n\n## Goal\nx\n';
  return fm + (scope === null ? '' : `\n## Files to touch\n${scope}\n`);
}

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

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'hive-scope-'));
  const home = path.join(root, 'demo');
  await fs.mkdir(home, { recursive: true });
  await hubInit(root);
  await hubAdd(root, 'demo', home);
  return { root, home };
}

// A scope-test task carries an approved plan, the same path planAnswer writes:
// plan with checkpoints, then answered from the plan state.
async function writeTask(root: string, id: string, text: string) {
  await fs.writeFile(hubPath(root, 'tasks', `${id}.md`), text);
  const project = id.replace(/-\d+$/, '');
  const at = new Date().toISOString();
  await appendTaskEvent(root, { id, project, event: 'asked', at });
  await appendTaskEvent(root, {
    id, project, event: 'plan', at,
    checkpoints: [{ id: 'c1', desc: 'the work', etaMin: 5 }],
  });
  await appendTaskEvent(root, { id, project, event: 'answered', at, note: 'plan approved by owner' });
}

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

describe('spawnAgent --task', () => {
  async function seedAgent(home: string, name: string, task: string) {
    await writeJson(hivePath(home, 'team.json'), { agents: [{ name, task }] });
  }

  it('refuses an overlapping scope and spawns nothing', async () => {
    const { root, home } = await setup();
    await writeTask(root, 'demo-1', brief('- src/a.ts — x'));
    await writeTask(root, 'demo-2', brief('- src/a.ts — y\n- src/b.ts — z'));
    await seedAgent(home, 'impl-1', 'demo-1');
    await expect(spawn(root, { agent: 'impl-2', task: 'demo-2' }))
      .rejects.toThrow("demo-2 overlaps impl-1's task demo-1: src/a.ts");
    expect(await manifestRead(home)).toHaveLength(0);
  });

  it('spawns on a disjoint scope and records the task', async () => {
    const { root, home } = await setup();
    await writeTask(root, 'demo-1', brief('- src/a.ts — x'));
    await writeTask(root, 'demo-3', brief('- src/c.ts — z'));
    await seedAgent(home, 'impl-1', 'demo-1');
    await spawn(root, { agent: 'impl-2', task: 'demo-3' });
    const team = await readTeam(home);
    expect(team.agents.find((a) => a.name === 'impl-2')?.task).toBe('demo-3');
  }, 20_000);

  it('lets two agents onto the same task', async () => {
    const { root, home } = await setup();
    await writeTask(root, 'demo-1', brief('- src/a.ts — x'));
    await seedAgent(home, 'impl-1', 'demo-1');
    await spawn(root, { agent: 'reviewer', task: 'demo-1' });
    expect((await readTeam(home)).agents).toHaveLength(2);
  }, 20_000);

  it('fails closed on an unparseable scope, either side', async () => {
    const { root, home } = await setup();
    await writeTask(root, 'demo-1', brief('- — no path here'));
    await writeTask(root, 'demo-2', brief('- src/b.ts — y'));
    await seedAgent(home, 'impl-1', 'demo-1');
    await expect(spawn(root, { agent: 'impl-2', task: 'demo-2' }))
      .rejects.toThrow(/does not parse/);
    await expect(spawn(root, { agent: 'impl-3', task: 'demo-1' }))
      .rejects.toThrow(/fix the brief/);
  });

  it('checks nothing when the claimant declares no scope', async () => {
    const { root, home } = await setup();
    await writeTask(root, 'demo-1', brief('- src/a.ts — x'));
    await writeTask(root, 'demo-4', '# demo-4\n\nplain task, no claim\n');
    await seedAgent(home, 'impl-1', 'demo-1');
    await spawn(root, { agent: 'impl-2', task: 'demo-4' });
    expect((await readTeam(home)).agents).toHaveLength(2);
  }, 20_000);

  it('refuses an unknown or foreign task id', async () => {
    const { root } = await setup();
    await expect(spawn(root, { agent: 'impl-2', task: '../../x' }))
      .rejects.toThrow(/task id/);
    await expect(spawn(root, { agent: 'impl-2', task: 'demo-99' }))
      .rejects.toThrow(/no task file/);
  });

  it('records the claim before the window opens', async () => {
    const { root, home } = await setup();
    await writeTask(root, 'demo-1', brief('- src/a.ts — x'));
    const { newWindow } = await import('../src/tmux.js');
    let seenAtLaunch: { agents: { name: string; task?: string }[] } | null = null;
    vi.mocked(newWindow).mockImplementationOnce(async () => {
      seenAtLaunch = JSON.parse(await fs.readFile(hivePath(home, 'team.json'), 'utf8'));
      return '%9';
    });
    await spawn(root, { agent: 'impl-1', task: 'demo-1' });
    expect(seenAtLaunch!.agents).toContainEqual({ name: 'impl-1', task: 'demo-1' });
  }, 20_000);

  it('lets exactly one of two concurrent overlapping spawns start', async () => {
    const { root, home } = await setup();
    await writeTask(root, 'demo-1', brief('- src/a.ts — x'));
    await writeTask(root, 'demo-2', brief('- src/a.ts — y'));
    const results = await Promise.allSettled([
      spawn(root, { agent: 'impl-1', task: 'demo-1' }),
      spawn(root, { agent: 'impl-2', task: 'demo-2' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason.message).toMatch(/overlaps/);
    expect((await readTeam(home)).agents).toHaveLength(1);
  }, 20_000);
});
