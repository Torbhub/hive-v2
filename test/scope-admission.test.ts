import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { admitTmux } from '../src/admission.js';
import { normalizeScope, scopesOverlap } from '../src/scope.js';
import { contractDigest, hivePath, manifestRead, readTeam, writeJson } from '../src/state.js';
import { newWindow } from '../src/tmux.js';
import { admitted, artifact, brief, evaluateScope, gitRepo, IDLE, setup, spawn, writeTask } from './scope-fixture.js';

vi.mock('../src/tmux.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/tmux.js')>();
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
