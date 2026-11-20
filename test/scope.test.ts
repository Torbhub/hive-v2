import { execFileSync } from 'node:child_process';
import { promises as fs, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const IDLE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'idle-empty-prompt.txt'),
  'utf8',
);

const testRun = vi.hoisted(() => ({ actualRun: null as unknown as typeof import('../src/tmux.js').run }));
vi.mock('../src/tmux.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/tmux.js')>();
  testRun.actualRun = orig.run;
  return {
    ...orig,
    run: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    newWindow: vi.fn(async () => '%9'),
    killWindow: vi.fn(async () => {}),
    paneIdentity: vi.fn(async () => ({ pid: 4242, started: 'later' })),
    paneExists: vi.fn(async () => true),
    paneIs: vi.fn(async () => true),
    capturePane: vi.fn(async () => IDLE),
    sendLiteral: vi.fn(async () => {}),
    sendEnter: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
  };
});

vi.mock('../src/admission.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/admission.js')>();
  return { ...original, completeTmuxLaunch: vi.fn(original.completeTmuxLaunch) };
});

import { gitDiffScope, normalizeScope, scopesOverlap, taskScope } from '../src/scope.js';
import { admitTmux, completeTmuxLaunch } from '../src/admission.js';
import { respawnAgent, spawnAgent, wakeAgent } from '../src/spawn.js';
import { evaluateTaskPredicate, hubAdd, hubInit, hubResolve, hubTask, recordTaskReceipt } from '../src/hub.js';
import { appendTaskEvent, contractDigest, hivePath, hubPath, manifestRead, readTaskEvents, readTeam, valueDigest, writeJson } from '../src/state.js';
import { approveContract, taskContract } from './task-contract.js';
import { killWindow, newWindow, paneIs, run } from '../src/tmux.js';

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

async function writeTask(root: string, id: string, text: string) {
  await fs.writeFile(hubPath(root, 'tasks', `${id}.md`), text);
  const project = id.replace(/-\d+$/, '');
  await appendTaskEvent(root, { id, project, event: 'asked', at: new Date().toISOString() });
  const scope = taskScope(text);
  const writeScope = scope.kind === 'claim' ? [...scope.paths] : [];
  await approveContract(root, id, taskContract(
    path.join(root, 'demo'), writeScope, 'Return the named artifact and verification evidence to the orchestrator.',
  ));
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

  it('refuses overlapping writers on the same task', async () => {
    const { root, home } = await setup();
    await writeTask(root, 'demo-1', brief('- src/a.ts — x'));
    await seedAgent(home, 'impl-1', 'demo-1');
    await expect(spawn(root, { agent: 'reviewer', task: 'demo-1' })).rejects.toThrow(/overlaps|collision/);
    expect((await readTeam(home)).agents).toHaveLength(1);
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

  it('treats a missing scope claim as read-only', async () => {
    const { root, home } = await setup();
    await writeTask(root, 'demo-1', brief('- src/a.ts — x'));
    await writeTask(root, 'demo-4', '# demo-4\n\nplain task, no claim\n');
    await seedAgent(home, 'impl-1', 'demo-1');
    await spawn(root, { agent: 'impl-2', task: 'demo-4' });
    expect((await readTeam(home)).agents.find((agent) => agent.name === 'impl-2')?.write_scope).toEqual([]);
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
    expect(seenAtLaunch!.agents).toContainEqual(expect.objectContaining({
      name: 'impl-1', task: 'demo-1', lease_epoch: 1, write_scope: ['src/a.ts'],
    }));
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
    expect((rejected as PromiseRejectedResult).reason.message).toMatch(/overlaps|collision/);
    expect((await readTeam(home)).agents.filter((agent) => !agent.orchestrator)).toHaveLength(1);
  }, 20_000);
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function gitRepo() {
  const repository = await fs.mkdtemp(path.join(tmpdir(), 'hive-git-scope-'));
  git(repository, ['init', '-q']);
  git(repository, ['config', 'user.email', 'hive@example.invalid']);
  git(repository, ['config', 'user.name', 'Hive Test']);
  await fs.mkdir(path.join(repository, 'src'));
  await fs.writeFile(path.join(repository, '.gitignore'), 'ignored.txt\n');
  await fs.writeFile(path.join(repository, 'src', 'a.txt'), 'base\n');
  await fs.writeFile(path.join(repository, 'outside.txt'), 'base\n');
  git(repository, ['add', '.']);
  git(repository, ['commit', '-qm', 'base']);
  const base = git(repository, ['rev-parse', 'HEAD']);
  return { repository, base };
}

async function artifact(repository: string): Promise<string> {
  git(repository, ['add', '-A']);
  if (git(repository, ['status', '--porcelain'])) git(repository, ['commit', '-qm', 'artifact']);
  return git(repository, ['rev-parse', 'HEAD']);
}

async function admitted(repository: string, base: string, artifactRevision: string, agent = 'builder', useWorktree = true) {
  await hubInit(repository);
  await hubAdd(repository, 'demo', repository);
  const output = 'Return the named artifact and verification evidence to the orchestrator.';
  const contract = {
    ...taskContract(repository, ['src'], output),
    provenance: { repository, base_revision: base, artifact_revision: artifactRevision },
  };
  const id = await hubTask(repository, 'demo', 'bounded Git work');
  await approveContract(repository, id, contract);
  const worktree = useWorktree ? `${repository}-lane-${agent}` : repository;
  if (useWorktree) git(repository, ['worktree', 'add', '-q', '--detach', worktree, artifactRevision]);
  const admission = await admitTmux(repository, repository, id, agent, {
    parent_id: id,
    plan_digest: contractDigest(contract),
    output_claim: output,
    acceptance_ids: ['diff'],
    provenance: contract.provenance,
    write_scope: ['src'],
    adapter: 'tmux',
  }, { worktree });
  return { id, admission, contract, worktree };
}

async function evaluateScope(repository: string, id: string, leaseId: string, base: string, artifactRevision: string) {
  return evaluateTaskPredicate(repository, id, 'git_diff_scope', {
    lease_id: leaseId, base_revision: base, artifact_revision: artifactRevision,
  });
}

async function jjRepo() {
  const repository = await fs.mkdtemp(path.join(tmpdir(), 'hive-jj-scope-'));
  execFileSync('jj', ['git', 'init', repository]);
  execFileSync('jj', ['config', 'set', '--repo', 'user.email', 'hive@example.invalid'], { cwd: repository });
  execFileSync('jj', ['config', 'set', '--repo', 'user.name', 'Hive Test'], { cwd: repository });
  await fs.mkdir(path.join(repository, 'src'));
  await fs.writeFile(path.join(repository, 'src', 'a.txt'), 'base\n');
  await fs.writeFile(path.join(repository, 'outside.txt'), 'base\n');
  await fs.writeFile(path.join(repository, '.gitignore'), 'ignored.txt\n');
  execFileSync('jj', ['new', '-m', 'base'], { cwd: repository });
  const base = execFileSync('jj', ['log', '-r', '@-', '-T', 'commit_id', '--no-graph'], { cwd: repository, encoding: 'utf8' }).trim();
  return { repository, base };
}

async function realSpawn(
  kind: 'git' | 'jj', beforeSpawn?: (repository: string) => Promise<void>, beforeWindow?: (worktree: string) => Promise<void>,
) {
  const { repository, base } = kind === 'jj' ? await jjRepo() : await gitRepo();
  await hubInit(repository);
  await hubAdd(repository, 'demo', repository);
  await beforeSpawn?.(repository);
  const output = 'Return the named artifact and verification evidence to the orchestrator.';
  const contract = {
    ...taskContract(repository, ['src', '.hive/handoffs'], output),
    provenance: { repository, base_revision: base, artifact_revision: base },
  };
  const id = await hubTask(repository, 'demo', 'bounded worker setup');
  await approveContract(repository, id, contract);
  vi.mocked(run).mockImplementation(async (command, args, cwd, env, timeout) => {
    if (command === 'teamkimi') return { code: 0, stdout: '', stderr: '' };
    return testRun.actualRun(command, args, cwd, env, timeout);
  });
  if (beforeWindow) {
    vi.mocked(newWindow).mockImplementationOnce(async () => {
      await beforeWindow(path.join(repository, '.hive', 'lanes', 'builder'));
      return '%9';
    });
  }
  await spawnAgent(repository, 'demo', {
    agent: 'builder', task: id,
    assignment: 'Complete the bounded scope assignment in the requested files.',
    deliverable: output,
  });
  const entry = (await readTeam(repository)).agents.find((agent) => agent.name === 'builder')!;
  return { repository, base, id, entry, worktree: entry.worktree! };
}

describe('normalized repository scope', () => {
  it('uses repository-relative prefixes', async () => {
    const { repository } = await gitRepo();
    await expect(normalizeScope(repository, ['./src/a', 'src'])).resolves.toEqual(['src', 'src/a']);
    expect(scopesOverlap(['src'], ['src/a'])).toBe(true);
    expect(scopesOverlap(['src'], ['src-old'])).toBe(false);
  });

  it('rejects unresolved roots', async () => {
    await expect(normalizeScope(path.join(tmpdir(), 'hive-no-such-root'), ['src'])).rejects.toThrow(/root/);
  });

  it('collides a symlink alias with its canonical writer scope', async () => {
    const { repository, base } = await gitRepo();
    const artifactRevision = await artifact(repository);
    const { id, admission, contract } = await admitted(repository, base, artifactRevision);
    await fs.symlink('src', path.join(repository, 'alias'), 'dir');
    await expect(admitTmux(repository, repository, id, 'reviewer', {
      parent_id: id,
      plan_digest: contractDigest(contract),
      output_claim: 'Return the named artifact and verification evidence to the orchestrator.',
      acceptance_ids: ['diff'],
      provenance: contract.provenance,
      write_scope: ['./alias/a.txt'],
      adapter: 'tmux',
    })).rejects.toThrow(/collision/);
    expect((await readTeam(repository)).agents.filter((agent) => agent.name === 'reviewer')).toHaveLength(0);
    expect(admission.lease_epoch).toBe(1);
  });

  it('rejects a stale diff without revoking the replacement lease', async () => {
    const { repository, base } = await gitRepo();
    const artifactRevision = await artifact(repository);
    const { id, admission, contract } = await admitted(repository, base, artifactRevision);
    const replacement = await admitTmux(repository, repository, id, 'builder', {
      parent_id: id,
      plan_digest: contractDigest(contract),
      output_claim: 'Return the named artifact and verification evidence to the orchestrator.',
      acceptance_ids: ['diff'],
      provenance: contract.provenance,
      write_scope: ['src'],
      adapter: 'tmux',
      retry_of: 'builder',
      retry_lease_id: admission.lease_id,
      retry_plan_digest: admission.plan_digest,
      lineage_id: admission.lineage_id,
    });
    await expect(evaluateScope(repository, id, admission.lease_id, base, artifactRevision)).rejects.toThrow(/current/);
    expect((await readTeam(repository)).agents.find((agent) => agent.lease_id === replacement.lease_id)).toMatchObject({
      lease_revoked: false, admission_status: 'admitted', attempts_used: 2,
    });
  });

  it('rejects a scope that escapes through a symlink', async () => {
    const { repository } = await gitRepo();
    const outside = await fs.mkdtemp(path.join(tmpdir(), 'hive-scope-outside-'));
    await fs.symlink(outside, path.join(repository, 'escape'), 'dir');
    await expect(normalizeScope(repository, ['escape/new.txt'])).rejects.toThrow(/symlink/);
  });

  it('releases the lease when an evidence path escapes through a symlink', async () => {
    const { repository, base } = await gitRepo();
    const artifactRevision = await artifact(repository);
    const { id, admission, worktree } = await admitted(repository, base, artifactRevision);
    const outside = await fs.mkdtemp(path.join(tmpdir(), 'hive-scope-evidence-outside-'));
    await fs.symlink(outside, path.join(worktree, 'src', 'escape'), 'dir');
    await fs.writeFile(path.join(outside, 'new.txt'), 'outside\n');
    await expect(evaluateScope(repository, id, admission.lease_id, base, artifactRevision)).rejects.toThrow(/symlink/);
    expect((await readTeam(repository)).agents.find((agent) => agent.lease_id === admission.lease_id)).toMatchObject({
      lease_revoked: true, admission_status: 'released',
    });
  });
});

describe('spawn runtime evidence', () => {
  it.each(['git', 'jj'] as const)('passes a clean real %s spawn and an authenticated receipt', async (kind) => {
    const { repository, base, id, entry } = await realSpawn(kind);
    expect(entry.runtime_files).toBeDefined();
    const evaluation = await evaluateScope(repository, id, entry.lease_id!, base, base).catch((error: unknown) => error);
    expect(evaluation).not.toBeInstanceOf(Error);
    const passed = evaluation as boolean;
    const evidence = (await readTaskEvents(repository)).findLast((event) => event.evidence)?.evidence!;
    expect(evidence.content).toMatchObject({ out_of_scope: [] });
    expect(passed).toBe(true);
    expect(evidence.actor).toBe('agent:builder');
    await recordTaskReceipt(repository, id, {
      actor: 'agent:builder', plan_digest: evidence.plan_digest, epoch: evidence.epoch, sequence: 1,
      lease_id: entry.lease_id, artifact_digest: evidence.artifact_digest,
      counters: {}, external_ids: {}, evidence_hashes: [evidence.evidence_hash], state: 'reconciling',
    });
    await expect(evaluateTaskPredicate(repository, id, 'task_receipt', {
      plan_digest: evidence.plan_digest, artifact_digest: evidence.artifact_digest, lease_id: entry.lease_id,
    })).resolves.toBe(true);
  }, 20_000);

  it('releases the lease when a role changes after a clean spawn', async () => {
    const { repository, base, id, entry, worktree } = await realSpawn('git');
    await expect(evaluateScope(repository, id, entry.lease_id!, base, base)).resolves.toBe(true);
    await fs.appendFile(hivePath(worktree, 'team', 'builder', 'role.md'), '\nworker edit\n');
    await expect(evaluateScope(repository, id, entry.lease_id!, base, base)).resolves.toBe(false);
    expect((await readTeam(repository)).agents.find((agent) => agent.lease_id === entry.lease_id)).toMatchObject({
      lease_revoked: true, admission_status: 'released',
    });
  }, 20_000);

  it('releases the lease for added team state and an undeclared handoff', async () => {
    const { repository, base, id, entry, worktree } = await realSpawn('git');
    await writeJson(hivePath(worktree, 'team.json'), { agents: [] });
    await expect(evaluateScope(repository, id, entry.lease_id!, base, base)).resolves.toBe(false);
    expect((await readTeam(repository)).agents.find((agent) => agent.lease_id === entry.lease_id)?.lease_revoked).toBe(true);
  }, 20_000);

  it('releases the lease for an undeclared handoff', async () => {
    const { repository, base, id, entry, worktree } = await realSpawn('git');
    await fs.writeFile(hivePath(worktree, 'handoffs', 'other.md'), 'not the deliverable\n');
    await expect(evaluateScope(repository, id, entry.lease_id!, base, base)).resolves.toBe(false);
    expect((await readTeam(repository)).agents.find((agent) => agent.lease_id === entry.lease_id)?.lease_revoked).toBe(true);
  }, 20_000);

  it('records claim completion and stays clean through spawn and respawn', async () => {
    const { repository, base, id, entry, worktree } = await realSpawn('jj');
    const firstClaim = entry.launch_claim_path!;
    expect(firstClaim).toMatch(/^\.hive-hub\/launches\/demo:/);
    await expect(fs.stat(path.join(worktree, firstClaim))).rejects.toThrow();
    await expect(evaluateScope(repository, id, entry.lease_id!, base, base)).resolves.toBe(true);
    const firstEvents = (await readTaskEvents(repository)).filter((event) => event.admission?.lease_id === entry.lease_id);
    expect(firstEvents.at(-1)?.admission?.launch_claim_completed).toBe(true);

    await respawnAgent(repository, 'demo', 'builder');
    const respawned = (await readTeam(repository)).agents.find((agent) => agent.name === 'builder')!;
    expect(respawned.lease_id).not.toBe(entry.lease_id);
    expect(respawned.launch_claim_path).toBeDefined();
    expect(respawned.launch_claim_path).not.toBe(firstClaim);
    expect(Object.keys(respawned.runtime_files!).filter((file) => file.startsWith('.hive-hub/launches/'))).toEqual([]);
    await expect(evaluateScope(repository, id, respawned.lease_id!, base, base)).resolves.toBe(true);
    const secondEvents = (await readTaskEvents(repository)).filter((event) => event.admission?.lease_id === respawned.lease_id);
    expect(secondEvents.at(-1)?.admission?.launch_claim_completed).toBe(true);
  }, 20_000);

  it.each(['create', 'modify'] as const)('rejects %s launch-claim tampering', async (operation) => {
    const { repository, base, id, entry, worktree } = await realSpawn('jj');
    await expect(evaluateScope(repository, id, entry.lease_id!, base, base)).resolves.toBe(true);
    if (operation === 'create') {
      await writeJson(hubPath(worktree, 'launches', 'demo:unallocated.json'), { project: 'demo' });
    } else {
      await fs.writeFile(path.join(worktree, entry.launch_claim_path!), 'tampered\n');
    }
    await expect(evaluateScope(repository, id, entry.lease_id!, base, base)).resolves.toBe(false);
    expect((await readTeam(repository)).agents.find((agent) => agent.lease_id === entry.lease_id)).toMatchObject({
      lease_revoked: true, admission_status: 'released',
    });
  }, 20_000);

  it('rejects a preexisting unallocated launch claim while binding only the current operation', async () => {
    const { repository, base, id, entry } = await realSpawn('jj', async (home) => {
      await writeJson(hubPath(home, 'launches', 'unallocated.json'), { project: 'demo' });
    });
    expect(entry.launch_claim_path).toMatch(/^\.hive-hub\/launches\/demo:/);
    expect(Object.keys(entry.runtime_files!).filter((file) => file.startsWith('.hive-hub/launches/'))).toEqual([]);
    await expect(evaluateScope(repository, id, entry.lease_id!, base, base)).resolves.toBe(false);
  }, 20_000);

  it('does not rebase immediate role and hub tampering during initial spawn', async () => {
    const { repository, base, id, entry } = await realSpawn('jj', undefined, async (worktree) => {
      await fs.appendFile(hivePath(worktree, 'team', 'builder', 'role.md'), '\nimmediate tamper\n');
      await fs.appendFile(hubPath(worktree, 'hub.json'), 'immediate tamper\n');
    });
    await expect(evaluateScope(repository, id, entry.lease_id!, base, base)).resolves.toBe(false);
  }, 20_000);

  it.each(['respawn', 'wake'] as const)('does not rebase immediate role tampering during %s', async (operation) => {
    const { repository, base, id, entry, worktree } = await realSpawn('jj');
    if (operation === 'wake') {
      const team = await readTeam(repository);
      await writeJson(hivePath(repository, 'team.json'), {
        agents: team.agents.map((agent) => agent.lease_id === entry.lease_id ? { ...agent, session_id: 'session-old' } : agent),
      });
      vi.mocked(paneIs).mockResolvedValueOnce(false);
    }
    vi.mocked(newWindow).mockImplementationOnce(async () => {
      await fs.appendFile(hivePath(worktree, 'team', 'builder', 'role.md'), '\nimmediate relaunch tamper\n');
      return '%9';
    });
    if (operation === 'respawn') await respawnAgent(repository, 'demo', 'builder');
    else await wakeAgent(repository, 'demo', 'builder');
    const current = (await readTeam(repository)).agents.find((agent) => agent.name === 'builder')!;
    await expect(evaluateScope(repository, id, current.lease_id!, base, base)).resolves.toBe(false);
  }, 20_000);

  it('kills the exact new pane and fails the exact lease when initial completion fails', async () => {
    let repository = '';
    vi.mocked(completeTmuxLaunch).mockRejectedValueOnce(new Error('injected completion failure'));
    vi.mocked(killWindow).mockClear();
    await expect(realSpawn('jj', async (home) => { repository = home; })).rejects.toThrow('injected completion failure');
    const current = (await readTeam(repository)).agents.find((agent) => agent.name === 'builder')!;
    expect(current).toMatchObject({ admission_status: 'launch_failed', lease_revoked: true });
    expect(killWindow).toHaveBeenCalledTimes(1);
    expect(killWindow).toHaveBeenCalledWith('%9', { pid: 4242, started: 'later' });
  }, 20_000);

  it.each(['respawn', 'wake'] as const)('kills the exact new pane and fails the exact lease when %s completion fails', async (operation) => {
    const { repository, entry } = await realSpawn('jj');
    if (operation === 'wake') {
      const team = await readTeam(repository);
      await writeJson(hivePath(repository, 'team.json'), {
        agents: team.agents.map((agent) => agent.lease_id === entry.lease_id ? { ...agent, session_id: 'session-old' } : agent),
      });
      vi.mocked(paneIs).mockResolvedValueOnce(false);
    }
    vi.mocked(completeTmuxLaunch).mockRejectedValueOnce(new Error(`injected ${operation} completion failure`));
    vi.mocked(killWindow).mockClear();
    const action = operation === 'respawn' ? respawnAgent : wakeAgent;
    await expect(action(repository, 'demo', 'builder')).rejects.toThrow(`injected ${operation} completion failure`);
    const current = (await readTeam(repository)).agents.find((agent) => agent.name === 'builder')!;
    expect(current.lease_id).not.toBe(entry.lease_id);
    expect(current).toMatchObject({ admission_status: 'launch_failed', lease_revoked: true });
    expect(killWindow).toHaveBeenCalledTimes(operation === 'respawn' ? 2 : 1);
    expect(killWindow).toHaveBeenCalledWith('%9', { pid: 4242, started: 'later' });
  }, 20_000);

  it('kills the new pane and fails the exact lease when cancellation races completion', async () => {
    let repository = '';
    vi.mocked(completeTmuxLaunch).mockImplementationOnce(async () => {
      await hubResolve(repository, 'demo', 'demo-1', 'cancel', 'cancellation raced completion');
      throw new Error('completion lost its current grant');
    });
    vi.mocked(killWindow).mockClear();
    await expect(realSpawn('jj', async (home) => { repository = home; })).rejects.toThrow('completion lost its current grant');
    const current = (await readTeam(repository)).agents.find((agent) => agent.name === 'builder')!;
    expect(current).toMatchObject({ admission_status: 'launch_failed', lease_revoked: true });
    expect(killWindow).toHaveBeenCalledWith('%9', { pid: 4242, started: 'later' });
  }, 20_000);

  it.each(['modify', 'delete'] as const)('refuses pre-completion claim %s and cleans up the exact launch', async (operation) => {
    let repository = '';
    vi.mocked(killWindow).mockClear();
    await expect(realSpawn('jj', async (home) => { repository = home; }, async (worktree) => {
      const claims = await fs.readdir(hubPath(worktree, 'launches'));
      const claim = claims.find((name) => name.startsWith('demo:'))!;
      if (operation === 'modify') await fs.appendFile(hubPath(worktree, 'launches', claim), 'tampered\n');
      else await fs.rm(hubPath(worktree, 'launches', claim));
    })).rejects.toThrow(/claim|completion/);
    const current = (await readTeam(repository)).agents.find((agent) => agent.name === 'builder')!;
    expect(current).toMatchObject({ admission_status: 'launch_failed', lease_revoked: true });
    expect(killWindow).toHaveBeenCalledWith('%9', { pid: 4242, started: 'later' });
  }, 20_000);

  it('handles JJ working-copy, untracked, and ignored out-of-scope changes', async () => {
    const { repository, base, id, entry, worktree } = await realSpawn('jj');
    await expect(evaluateScope(repository, id, entry.lease_id!, base, base)).resolves.toBe(true);
    await fs.writeFile(path.join(worktree, 'ignored.txt'), 'ignored escape\n');
    await expect(evaluateScope(repository, id, entry.lease_id!, base, base)).resolves.toBe(false);
    expect((await readTeam(repository)).agents.find((agent) => agent.lease_id === entry.lease_id)?.lease_revoked).toBe(true);
  }, 20_000);
});

describe('git_diff_scope', () => {
  it('rejects unexpected active claim deletion and allows only recorded completion absence', async () => {
    const { repository, base } = await gitRepo();
    const artifactRevision = await artifact(repository);
    const claim = '.hive-hub/launches/demo:active.json';
    const content = '{"project":"demo"}\n';
    await fs.mkdir(path.dirname(path.join(repository, claim)), { recursive: true });
    await fs.writeFile(path.join(repository, claim), content);
    const runtime = {
      output_claim: 'bounded output', launch_claim_path: claim,
      launch_claim_digest: valueDigest(content), launch_claim_completed: false,
    };
    await expect(gitDiffScope({
      repository, base_revision: base, artifact_revision: artifactRevision, write_scope: ['src'], runtime,
    })).resolves.toMatchObject({ passed: true });
    await fs.rm(path.join(repository, claim));
    await expect(gitDiffScope({
      repository, base_revision: base, artifact_revision: artifactRevision, write_scope: ['src'], runtime,
    })).resolves.toMatchObject({ passed: false, out_of_scope: [claim] });
    await expect(gitDiffScope({
      repository, base_revision: base, artifact_revision: artifactRevision, write_scope: ['src'],
      runtime: { ...runtime, launch_claim_completed: true },
    })).resolves.toMatchObject({ passed: true });
  });

  it('checks committed paths and releases the exact lease through public evaluation', async () => {
    const { repository, base } = await gitRepo();
    const artifactRevision = await artifact(repository);
    const { id, admission, worktree } = await admitted(repository, base, artifactRevision);
    await fs.writeFile(path.join(worktree, 'src', 'a.txt'), 'inside\n');
    await fs.writeFile(path.join(worktree, 'outside.txt'), 'outside\n');
    await expect(evaluateScope(repository, id, admission.lease_id, base, artifactRevision)).resolves.toBe(false);
    expect((await readTeam(repository)).agents.find((agent) => agent.lease_id === admission.lease_id)).toMatchObject({
      lease_revoked: true, admission_status: 'released',
    });
    const evidence = (await readTaskEvents(repository)).at(-2)?.evidence;
    expect(evidence).toMatchObject({ lease_id: admission.lease_id, outcome: 'failed' });
    expect(evidence?.evidence_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(['staged', 'untracked'])('releases the lease for an out-of-scope $name file', async (kind) => {
    const { repository, base } = await gitRepo();
    const artifactRevision = await artifact(repository);
    const { id, admission, worktree } = await admitted(repository, base, artifactRevision);
    await fs.writeFile(path.join(worktree, 'outside.txt'), `${kind}\n`);
    if (kind === 'staged') git(worktree, ['add', 'outside.txt']);
    await expect(evaluateScope(repository, id, admission.lease_id, base, artifactRevision)).resolves.toBe(false);
    expect((await readTeam(repository)).agents.find((agent) => agent.lease_id === admission.lease_id)?.lease_revoked).toBe(true);
  });

  it('includes ignored untracked files and releases the lease', async () => {
    const { repository, base } = await gitRepo();
    const artifactRevision = await artifact(repository);
    const { id, admission, worktree } = await admitted(repository, base, artifactRevision);
    await fs.writeFile(path.join(worktree, 'ignored.txt'), 'ignored escape\n');
    await expect(evaluateScope(repository, id, admission.lease_id, base, artifactRevision)).resolves.toBe(false);
    expect((await readTeam(repository)).agents.find((agent) => agent.lease_id === admission.lease_id)?.lease_revoked).toBe(true);
  });

  it('does not exempt team state inside the worker repository', async () => {
    const { repository, base } = await gitRepo();
    const artifactRevision = await artifact(repository);
    const { id, admission } = await admitted(repository, base, artifactRevision, 'builder', false);
    const team = await readTeam(repository);
    await writeJson(hivePath(repository, 'team.json'), { ...team, worker_note: 'out of lease' });
    await expect(evaluateScope(repository, id, admission.lease_id, base, artifactRevision)).resolves.toBe(false);
    expect((await readTeam(repository)).agents.find((agent) => agent.lease_id === admission.lease_id)?.lease_revoked).toBe(true);
  });

  it.each([
    { name: 'staged', prepare: async (repository: string) => {
      await fs.writeFile(path.join(repository, 'src', 'a.txt'), 'staged\n');
      git(repository, ['add', 'src/a.txt']);
    } },
    { name: 'unstaged', prepare: async (repository: string) => {
      await fs.writeFile(path.join(repository, 'src', 'a.txt'), 'unstaged\n');
    } },
    { name: 'untracked', prepare: async (repository: string) => {
      await fs.writeFile(path.join(repository, 'src', 'new.txt'), 'untracked\n');
    } },
  ])('includes $name in-scope changes', async ({ prepare }) => {
    const { repository, base } = await gitRepo();
    const artifactRevision = await artifact(repository);
    await prepare(repository);
    const result = await gitDiffScope({
      repository, base_revision: base, artifact_revision: artifactRevision, write_scope: ['src'],
    });
    expect(result.passed).toBe(true);
    expect(result.paths.length).toBeGreaterThan(0);
  });

  it('includes both rename paths and rejects a rename out of the lease', async () => {
    const { repository, base } = await gitRepo();
    git(repository, ['mv', 'src/a.txt', 'renamed.txt']);
    const artifactRevision = await artifact(repository);
    const result = await gitDiffScope({
      repository, base_revision: base, artifact_revision: artifactRevision, write_scope: ['src'],
    });
    expect(result.passed).toBe(false);
    expect(result.paths).toContain('src/a.txt');
    expect(result.paths).toContain('renamed.txt');
  });

  it('fails closed for a wrong repository or missing exact revision', async () => {
    const { repository, base } = await gitRepo();
    const artifactRevision = await artifact(repository);
    await expect(gitDiffScope({
      repository, base_revision: base, artifact_revision: 'f'.repeat(40), write_scope: ['src'],
    })).rejects.toThrow(/revision/);
    await expect(gitDiffScope({
      repository: path.join(repository, 'src'), base_revision: base, artifact_revision: artifactRevision, write_scope: ['src'],
    })).rejects.toThrow(/repository root/);
  });
});
