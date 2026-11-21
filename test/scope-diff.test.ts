import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { gitDiffScope } from '../src/scope.js';
import { hivePath, readTaskEvents, readTeam, valueDigest, writeJson } from '../src/state.js';
import { admitted, artifact, evaluateScope, git, gitRepo, IDLE } from './scope-fixture.js';

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
