import { execFileSync } from 'node:child_process';
import { promises as fs, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>();
  return { ...orig, promises: { ...orig.promises, realpath: vi.fn(orig.promises.realpath) } };
});

vi.mock('../src/tmux.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/tmux.js')>();
  return { ...orig, run: vi.fn(orig.run) };
});

vi.mock('../src/state.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/state.js')>();
  return { ...orig, writeProjects: vi.fn(orig.writeProjects) };
});

import { addProjectFromBody, removeProject } from '../src/project.js';
import {
  hivePath, hubPath, readProjects, writeJson, writePendingPane, writeProjects,
} from '../src/state.js';
import { run } from '../src/tmux.js';

function command(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function git(cwd: string, ...args: string[]): string {
  return command('git', args, cwd);
}

async function emptyHub() {
  const root = mkdtempSync(path.join(tmpdir(), 'hive-project-add-'));
  await writeJson(hubPath(root, 'projects.json'), { projects: [] });
  return root;
}

async function gitSource(root: string, folder = 'source') {
  const source = path.join(root, folder);
  await fs.mkdir(source, { recursive: true });
  git(source, 'init');
  git(source, 'config', 'user.email', 'hive@example.test');
  git(source, 'config', 'user.name', 'Hive Test');
  await fs.mkdir(hivePath(source), { recursive: true });
  await fs.writeFile(hivePath(source, 'team.json'), '{"agents":[{"name":"inherited"}]}\n');
  await fs.writeFile(path.join(source, 'marker.txt'), 'source\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'initial');
  return source;
}

async function jjSource(root: string) {
  const source = path.join(root, 'jj-source');
  command('jj', ['git', 'init', source], root);
  await fs.mkdir(hivePath(source), { recursive: true });
  await fs.writeFile(hivePath(source, 'team.json'), '{"agents":[{"name":"inherited"}]}\n');
  await fs.writeFile(path.join(source, 'marker.txt'), 'source\n');
  command('jj', [
    '--config', 'user.name=Hive Test', '--config', 'user.email=hive@example.test',
    'describe', '-m', 'initial',
  ], source);
  return source;
}

function expectBoundedProcesses() {
  const calls = vi.mocked(run).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) expect(call[4]).toBe(30_000);
}

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'hive-project-'));
  const home = path.join(root, 'demo');
  const otherHome = path.join(root, 'other');
  await fs.mkdir(home, { recursive: true });
  await writeJson(hubPath(root, 'projects.json'), {
    projects: [
      { name: 'demo', home, repos: [{ folder: home }] },
      { name: 'other', home: otherHome, repos: [{ folder: otherHome }] },
    ],
  });
  await writeJson(hivePath(home, 'team.json'), { agents: [] });
  return { root, home };
}

describe('removeProject', () => {
  it('removes only the registry entry and preserves project and hub records', async () => {
    const { root, home } = await setup();
    const files = [
      [hubPath(root, 'tasks.jsonl'), '{"task":"keep"}\n'],
      [hubPath(root, 'decisions.jsonl'), '{"decision":"keep"}\n'],
      [hivePath(home, 'handoffs', 'builder.md'), 'keep handoff\n'],
      [hivePath(home, 'manifest.jsonl'), '{"kind":"jj-workspace"}\n'],
      [path.join(home, 'repo-marker.txt'), 'keep repo\n'],
      [hivePath(home, 'team.json'), '{"agents":[]}\n'],
    ] as const;
    for (const [file, contents] of files) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, contents);
    }

    await removeProject(root, 'demo');

    expect((await readProjects(root)).projects.map((p) => p.name)).toEqual(['other']);
    for (const [file, contents] of files) {
      expect(await fs.readFile(file, 'utf8')).toBe(contents);
    }
  });

  it('refuses an unknown project without changing the registry', async () => {
    const { root } = await setup();
    await expect(removeProject(root, 'missing')).rejects.toThrow(/unknown project/);
    expect((await readProjects(root)).projects.map((p) => p.name)).toEqual(['demo', 'other']);
  });

  it('refuses every nonempty team, including stopped entries', async () => {
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'builder', pane: '%2', closed_at: '2026-10-27T00:00:00Z' }],
    });
    await expect(removeProject(root, 'demo')).rejects.toThrow(/team is not empty/);
    expect((await readProjects(root)).projects.map((p) => p.name)).toEqual(['demo', 'other']);
  });

  it('refuses a pending launch and keeps its record', async () => {
    const { root } = await setup();
    await writePendingPane(root, 'demo', { pane: '%9', kind: 'start', at: '2026-10-27T00:00:00Z' });
    await expect(removeProject(root, 'demo')).rejects.toThrow(/launch is pending/);
    expect((await readProjects(root)).projects.map((p) => p.name)).toEqual(['demo', 'other']);
    expect(JSON.parse(await fs.readFile(hubPath(root, 'panes', 'demo.json'), 'utf8')).pane).toBe('%9');
  });
});

describe('addProjectFromBody', () => {
  it('creates an empty Git repository from a name and returns its actual home', async () => {
    const root = await emptyHub();
    const result = await addProjectFromBody(root, { name: 'fresh' });
    expect(result).toEqual({ ok: true, name: 'fresh', home: path.join(root, 'fresh') });
    expect(git(result.home, 'rev-parse', '--is-inside-work-tree')).toBe('true');
    expect((await readProjects(root)).projects[0].home).toBe(result.home);
    expectBoundedProcesses();
  });

  it('creates a missing explicit directory as an empty Git repository', async () => {
    const root = await emptyHub();
    const home = path.join(root, 'nested', 'fresh');
    const result = await addProjectFromBody(root, { name: 'fresh', path: home });
    expect(result).toEqual({ ok: true, name: 'fresh', home });
    expect(git(result.home, 'rev-parse', '--is-inside-work-tree')).toBe('true');
    expect((await readProjects(root)).projects[0].home).toBe(home);
    expectBoundedProcesses();
  });

  it('initializes an existing plain directory without removing its content', async () => {
    const root = await emptyHub();
    const home = path.join(root, 'plain');
    await fs.mkdir(hivePath(home), { recursive: true });
    await fs.writeFile(path.join(home, 'keep.txt'), 'keep\n');
    await fs.writeFile(hivePath(home, 'team.json'), '{"agents":[]}\n');
    const result = await addProjectFromBody(root, { name: 'plain', path: home });
    expect(result).toEqual({ ok: true, name: 'plain', home });
    expect(git(result.home, 'rev-parse', '--is-inside-work-tree')).toBe('true');
    expect(await fs.readFile(path.join(home, 'keep.txt'), 'utf8')).toBe('keep\n');
    expect(await fs.readFile(hivePath(home, 'team.json'), 'utf8')).toBe('{"agents":[]}\n');
    expectBoundedProcesses();
  });

  it('uses a random suffix on collision and preserves the existing path', async () => {
    const root = await emptyHub();
    const marker = path.join(root, 'fresh', 'keep.txt');
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, 'keep\n');
    const result = await addProjectFromBody(root, { name: 'fresh', path: '' });
    expect(path.basename(result.home)).toMatch(/^fresh-[0-9a-f]{8}$/);
    expect(path.dirname(result.home)).toBe(root);
    expect(await fs.readFile(marker, 'utf8')).toBe('keep\n');
  });

  it('refuses a duplicate canonical home through a symlink', async () => {
    const root = await emptyHub();
    const home = await gitSource(root);
    const alias = path.join(root, 'alias');
    await fs.symlink(home, alias, 'dir');
    await addProjectFromBody(root, { name: 'first', path: alias });
    expect((await readProjects(root)).projects[0].home).toBe(home);
    await expect(addProjectFromBody(root, { name: 'second', path: alias })).rejects.toThrow(/already registered/);
    expect((await readProjects(root)).projects.map((p) => p.name)).toEqual(['first']);
  });

  it('creates a detached plain-Git worktree without inherited Hive state', async () => {
    const root = await emptyHub();
    const source = await gitSource(root);
    const result = await addProjectFromBody(root, { name: 'copy', source });
    expect(git(result.home, 'rev-parse', '--is-inside-work-tree')).toBe('true');
    expect(() => git(result.home, 'symbolic-ref', '-q', 'HEAD')).toThrow();
    expect(await fs.readFile(path.join(result.home, 'marker.txt'), 'utf8')).toBe('source\n');
    expect(await fs.stat(hivePath(result.home)).catch(() => null)).toBeNull();
    expect(await fs.readFile(hivePath(source, 'team.json'), 'utf8')).toContain('inherited');
    expectBoundedProcesses();
  });

  it('creates a real JJ workspace without inherited Hive state', async () => {
    const root = await emptyHub();
    const source = await jjSource(root);
    const result = await addProjectFromBody(root, { name: 'jj-copy', source });
    expect(command('jj', ['root'], result.home)).toBe(result.home);
    expect(await fs.readFile(path.join(result.home, 'marker.txt'), 'utf8')).toBe('source\n');
    expect(await fs.stat(hivePath(result.home)).catch(() => null)).toBeNull();
    expectBoundedProcesses();
  });

  it('rolls back only the allocated home after creation fails', async () => {
    const root = await emptyHub();
    const source = path.join(root, 'unborn');
    await fs.mkdir(source, { recursive: true });
    git(source, 'init');
    await fs.writeFile(path.join(source, 'keep.txt'), 'keep\n');
    await expect(addProjectFromBody(root, { name: 'failed', source })).rejects.toThrow(/worktree add failed/);
    expect(vi.mocked(run).mock.calls.some(([, args]) => args[2] === 'worktree' && args[3] === 'remove')).toBe(false);
    expect(await fs.stat(path.join(root, 'failed')).catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(source, 'keep.txt'), 'utf8')).toBe('keep\n');
    expect((await readProjects(root)).projects).toEqual([]);
  });

  it('skips a registered canonical home whose directory is missing', async () => {
    const root = await emptyHub();
    await writeJson(hubPath(root, 'projects.json'), {
      projects: [{ name: 'stale', home: path.join(root, 'fresh'), repos: [] }],
    });
    const result = await addProjectFromBody(root, { name: 'fresh' });
    expect(path.basename(result.home)).toMatch(/^fresh-[0-9a-f]{8}$/);
  });

  it.each(['git', 'jj'])('refuses a %s source subdirectory instead of using the enclosing repository', async (kind) => {
    const root = await emptyHub();
    const source = kind === 'git' ? await gitSource(root) : await jjSource(root);
    const subdirectory = path.join(source, 'nested');
    await fs.mkdir(subdirectory);
    await expect(addProjectFromBody(root, { name: 'bad-source', source: subdirectory })).rejects.toThrow(/repository root/);
    expect((await readProjects(root)).projects).toEqual([]);
  });

  it('accepts an independent Git root nested inside a JJ repository', async () => {
    const root = await emptyHub();
    const outer = await jjSource(root);
    const source = await gitSource(outer, 'nested-git');
    const result = await addProjectFromBody(root, { name: 'nested-git', source });
    expect(git(result.home, 'rev-parse', '--is-inside-work-tree')).toBe('true');
    expect(() => git(result.home, 'symbolic-ref', '-q', 'HEAD')).toThrow();
  });

  it('does not disturb an older JJ workspace with the same project basename', async () => {
    const root = await emptyHub();
    const source = await jjSource(root);
    const older = path.join(root, 'older-workspace');
    command('jj', ['workspace', 'add', older, '--name', 'shared', '-r', '@'], source);
    const result = await addProjectFromBody(root, { name: 'shared', source });
    expect(result.home).toBe(path.join(root, 'shared'));
    expect(command('jj', ['root'], older)).toBe(older);
    expect(command('jj', ['workspace', 'list'], source)).toMatch(/^shared:/m);
  });

  it('deregisters a partial JJ workspace when workspace add reports failure', async () => {
    const root = await emptyHub();
    const source = await jjSource(root);
    const actualRun = vi.mocked(run).getMockImplementation()!;
    let allocated = '';
    vi.mocked(run).mockImplementation(async (cmd, args, cwd, env, timeout) => {
      if (cmd === 'jj' && args[2] === 'workspace' && args[3] === 'add') {
        allocated = args[4];
        const made = await actualRun(cmd, args, cwd, env, timeout);
        expect(made.code).toBe(0);
        return { ...made, code: 1, stderr: 'injected partial failure' };
      }
      return actualRun(cmd, args, cwd, env, timeout);
    });
    try {
      await expect(addProjectFromBody(root, { name: 'partial-jj', source })).rejects.toThrow(/injected partial failure/);
    } finally {
      vi.mocked(run).mockImplementation(actualRun);
    }
    expect(allocated).not.toBe('');
    expect(await fs.stat(allocated).catch(() => null)).toBeNull();
    expect(command('jj', ['workspace', 'list'], source)).not.toContain(path.basename(allocated));
    expect((await readProjects(root)).projects).toEqual([]);
  });

  it('surfaces cleanup command failure after partial Git creation and keeps the destination', async () => {
    const root = await emptyHub();
    const source = await gitSource(root);
    const actualRun = vi.mocked(run).getMockImplementation()!;
    let allocated = '';
    let partialInjected = false;
    let cleanupInjected = false;
    vi.mocked(run).mockImplementation(async (cmd, args, cwd, env, timeout) => {
      if (cmd === 'git' && args[2] === 'worktree' && args[3] === 'add') {
        allocated = args[5];
        const made = await actualRun(cmd, args, cwd, env, timeout);
        expect(made.code).toBe(0);
        partialInjected = true;
        return { ...made, code: 1, stderr: 'injected partial failure' };
      }
      if (cmd === 'git' && args[2] === 'worktree' && args[3] === 'remove') {
        cleanupInjected = true;
        return { code: 1, stdout: '', stderr: 'cleanup denied' };
      }
      return actualRun(cmd, args, cwd, env, timeout);
    });
    try {
      await expect(addProjectFromBody(root, { name: 'partial-git', source })).rejects.toThrow(/cleanup denied/);
    } finally {
      vi.mocked(run).mockImplementation(actualRun);
    }
    expect(partialInjected).toBe(true);
    expect(cleanupInjected).toBe(true);
    expect((await fs.stat(allocated)).isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(allocated, 'marker.txt'), 'utf8')).toBe('source\n');
    expect((await readProjects(root)).projects).toEqual([]);
  });

  it('preserves a replacement and its Hive state when creation swaps the allocation', async () => {
    const root = await emptyHub();
    const actualRun = vi.mocked(run).getMockImplementation()!;
    const home = path.join(root, 'creation-swap');
    vi.mocked(run).mockImplementation(async (cmd, args, cwd, env, timeout) => {
      if (cmd === 'git' && args[0] === 'init') {
        await fs.rm(home, { recursive: true, force: true });
        await fs.mkdir(hivePath(home), { recursive: true });
        await fs.writeFile(hivePath(home, 'team.json'), '{"agents":[{"name":"owner"}]}\n');
        return { code: 0, stdout: '', stderr: '' };
      }
      return actualRun(cmd, args, cwd, env, timeout);
    });
    try {
      await expect(addProjectFromBody(root, { name: 'creation-swap' })).rejects.toThrow(/identity|changed/);
    } finally {
      vi.mocked(run).mockImplementation(actualRun);
    }
    expect(await fs.readFile(hivePath(home, 'team.json'), 'utf8')).toContain('owner');
    expect((await readProjects(root)).projects).toEqual([]);
  });

  it('leaves a JJ destination in place when workspace forget fails', async () => {
    const root = await emptyHub();
    const source = await jjSource(root);
    const actualRun = vi.mocked(run).getMockImplementation()!;
    let allocated = '';
    vi.mocked(run).mockImplementation(async (cmd, args, cwd, env, timeout) => {
      if (cmd === 'jj' && args[2] === 'workspace' && args[3] === 'add') {
        allocated = args[4];
        const made = await actualRun(cmd, args, cwd, env, timeout);
        return { ...made, code: 1, stderr: 'injected partial failure' };
      }
      if (cmd === 'jj' && args[2] === 'workspace' && args[3] === 'forget') {
        return { code: 1, stdout: '', stderr: 'forget denied' };
      }
      return actualRun(cmd, args, cwd, env, timeout);
    });
    try {
      await expect(addProjectFromBody(root, { name: 'partial-jj', source })).rejects.toThrow(/forget denied/);
    } finally {
      vi.mocked(run).mockImplementation(actualRun);
    }
    expect(await fs.readFile(path.join(allocated, 'marker.txt'), 'utf8')).toBe('source\n');
  });

  it('preserves a replacement directory when rollback sees a different identity', async () => {
    const root = await emptyHub();
    const home = path.join(root, 'replaced');
    const actualWrite = vi.mocked(writeProjects).getMockImplementation()!;
    vi.mocked(writeProjects).mockImplementation(async (writeRoot, projects) => {
      if (projects.projects.some((p) => p.name === 'replaced')) {
        await fs.rm(home, { recursive: true, force: true });
        await fs.mkdir(home);
        await fs.writeFile(path.join(home, 'keep.txt'), 'keep\n');
        throw new Error('registry unavailable');
      }
      return actualWrite(writeRoot, projects);
    });
    try {
      await expect(addProjectFromBody(root, { name: 'replaced' })).rejects.toThrow(/registry unavailable/);
    } finally {
      vi.mocked(writeProjects).mockImplementation(actualWrite);
    }
    expect(await fs.readFile(path.join(home, 'keep.txt'), 'utf8')).toBe('keep\n');
    expect((await readProjects(root)).projects).toEqual([]);
  });

  it('revalidates an explicit canonical home before registry commit', async () => {
    const root = await emptyHub();
    const home = await gitSource(root);
    const alias = path.join(root, 'alias');
    const blocker = path.join(root, 'blocker');
    await fs.symlink(home, alias, 'dir');
    await writeJson(hubPath(root, 'projects.json'), {
      projects: [{ name: 'blocker', home: blocker, repos: [] }],
    });
    const actualRealpath = vi.mocked(fs.realpath).getMockImplementation()!;
    vi.mocked(fs.realpath).mockImplementation(async (file) => {
      if (file === blocker) {
        await fs.rename(home, `${home}-moved`);
        await fs.mkdir(home);
        await fs.writeFile(path.join(home, 'keep.txt'), 'keep\n');
      }
      return actualRealpath(file);
    });
    try {
      await expect(addProjectFromBody(root, { name: 'swapped', path: alias })).rejects.toThrow(/identity|changed/);
    } finally {
      vi.mocked(fs.realpath).mockImplementation(actualRealpath);
    }
    expect((await readProjects(root)).projects.map((p) => p.name)).toEqual(['blocker']);
    expect(await fs.readFile(path.join(home, 'keep.txt'), 'utf8')).toBe('keep\n');
  });

  it('refuses a source with an explicit path before creating anything', async () => {
    const root = await emptyHub();
    const source = await gitSource(root);
    const explicit = path.join(root, 'explicit');
    await expect(addProjectFromBody(root, { name: 'bad', path: explicit, source })).rejects.toThrow(/source.*path|path.*source/);
    expect(await fs.stat(explicit).catch(() => null)).toBeNull();
    expect((await readProjects(root)).projects).toEqual([]);
  });
});
