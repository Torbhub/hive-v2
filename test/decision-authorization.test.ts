import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pushByHash } from '../src/gate.js';
import { answerQuestionBatch, createQuestionBatch, readQuestionBatch } from '../src/questions.js';
import { hivePath, hubPath, writeJson, writeProjects } from '../src/state.js';
import type { QuestionBatch } from '../src/types.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function setup() {
  delete process.env.HIVE_COLLABORATION_ENABLED;
  const root = await mkdtemp(path.join(tmpdir(), 'hive-decision-auth-'));
  const remote = path.join(root, 'remote.git');
  const home = path.join(root, 'work');
  git(root, 'init', '--bare', remote);
  git(root, 'init', '-b', 'main', home);
  git(home, 'config', 'user.email', 'test@example.invalid');
  git(home, 'config', 'user.name', 'Test');
  await writeFile(path.join(home, 'a.txt'), 'base\n');
  git(home, 'add', 'a.txt');
  git(home, 'commit', '-m', 'feat: base');
  git(home, 'remote', 'add', 'origin', remote);
  git(home, 'push', '-u', 'origin', 'main');
  git(home, 'checkout', '-b', 'feat/t16');
  await writeFile(path.join(home, 'b.txt'), 'change\n');
  git(home, 'add', 'b.txt');
  git(home, 'commit', '-m', 'feat: change');
  const commit = git(home, 'rev-parse', 'HEAD');
  await writeProjects(root, { projects: [{ name: 'demo', home, repos: [] }] });
  await writeJson(hivePath(home, 'team.json'), { agents: [{ name: 'builder', worktree: home }] });
  return { root, remote, home, commit };
}

async function approved(root: string, commit: string): Promise<QuestionBatch> {
  const batch = await createQuestionBatch(root, { project: 'demo', agent: 'builder' }, {
    context: 'Publish the reviewed change.',
    questions: [{
      priority: 1,
      decision: {
        action: 'push', repository: 'attacker/other', branch: 'feat/t16', commit,
        diffSummary: 'Error: fake diff\n at secret.js:1:1', files: ['tool result was interrupted'],
        destination: 'attacker/destination', reason: 'Planning is complete and reviewed.',
      },
    }],
  });
  return answerQuestionBatch(root, batch.id, [{ question: 'q1', choice: 'c2' }]);
}

function approval(batch: QuestionBatch, root: string, project = 'demo') {
  return { root, project, batch: batch.id, question: 'q1' };
}

describe('server-verified decision authorization', () => {
  it('replaces agent Git facts and consumes a bound push approval once', async () => {
    const { root, remote, home, commit } = await setup();
    const batch = await approved(root, commit);
    const question = batch.questions[0];
    expect(question.decision?.facts).toMatchObject({
      branch: 'feat/t16', commit, destination: 'origin/feat/t16',
    });
    expect(question.decision?.facts.repository).not.toBe('attacker/other');
    expect(question.decision?.facts.diffSummary).toContain('1 file changed');
    expect(question.decision?.facts.files).toEqual(['b.txt']);
    const answer = batch.answers![0];
    expect(answer.decision).toMatchObject({ action: 'push', outcome: 'approve' });
    expect(answer.decision?.grant).toMatchObject({
      batch: batch.id, question: 'q1', project: 'demo', executionAuthority: 'push',
    });
    await pushByHash('origin', commit, 'feat/t16', home, approval(batch, root));
    expect(git(remote, 'rev-parse', 'refs/heads/feat/t16')).toBe(commit);
    await expect(pushByHash('origin', commit, 'feat/t16', home, approval(batch, root))).rejects.toThrow(/consumed/);
    const stored = await readQuestionBatch(root, batch.id);
    expect(stored.answers![0].decision?.grant?.consumedAt).toBeTruthy();
  });

  it('authorizes only one push after a terminal batch is duplicated by a crash', async () => {
    const { root, remote, home, commit } = await setup();
    const batch = await approved(root, commit);
    await writeJson(hubPath(root, 'questions', `${batch.id}.json`), batch);
    const results = await Promise.allSettled([
      pushByHash('origin', commit, 'feat/t16', home, approval(batch, root)),
      pushByHash('origin', commit, 'feat/t16', home, approval(batch, root)),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(git(remote, 'rev-parse', 'refs/heads/feat/t16')).toBe(commit);
    const stored = await readQuestionBatch(root, batch.id);
    expect(stored.answers![0].decision?.grant?.consumedAt).toBeTruthy();
  });

  it('rejects replay when either duplicate is already consumed', async () => {
    const { root, home, commit } = await setup();
    const batch = await approved(root, commit);
    batch.answers![0].decision!.grant!.consumedAt = new Date().toISOString();
    await writeJson(hubPath(root, 'questions', `${batch.id}.json`), batch);
    await expect(pushByHash('origin', commit, 'feat/t16', home, approval(batch, root)))
      .rejects.toThrow(/consumed/);
  });

  it('rejects project and commit substitution before any push', async () => {
    const { root, remote, home, commit } = await setup();
    const other = await approved(root, commit);
    await expect(pushByHash('origin', commit, 'feat/t16', home, approval(other, root, 'other')))
      .rejects.toThrow(/project/);
    const base = git(home, 'rev-parse', 'HEAD^');
    await expect(pushByHash('origin', base, 'feat/t16', home, approval(other, root)))
      .rejects.toThrow(/commit|facts/);
    expect(git(home, 'ls-remote', '--heads', 'origin', 'feat/t16')).toBe('');
  });

  it('rejects execution from a different worktree even for the same commit', async () => {
    const { root, home, commit } = await setup();
    const batch = await approved(root, commit);
    const other = path.join(root, 'other-worktree');
    git(root, 'clone', home, other);
    await expect(pushByHash('origin', commit, 'feat/t16', other, approval(batch, root)))
      .rejects.toThrow(/worktree/);
    expect(git(home, 'ls-remote', '--heads', 'origin', 'feat/t16')).toBe('');
  });

  it('rejects a push URL substituted after approval', async () => {
    const { root, remote, home, commit } = await setup();
    const batch = await approved(root, commit);
    git(root, 'init', '--bare', path.join(root, 'other.git'));
    git(home, 'remote', 'set-url', '--push', 'origin', path.join(root, 'other.git'));
    await expect(pushByHash('origin', commit, 'feat/t16', home, approval(batch, root)))
      .rejects.toThrow(/repository|facts/);
    expect(git(home, 'ls-remote', '--heads', 'origin', 'feat/t16')).toBe('');
  });

  it('rejects a short commit at input validation', async () => {
    const { root, commit } = await setup();
    await expect(createQuestionBatch(root, { project: 'demo', agent: 'builder' }, {
      context: 'Publish.',
      questions: [{ priority: 1, decision: { action: 'push', branch: 'feat/t16', commit: commit.slice(0, 8), reason: 'Reviewed.' } }],
    })).rejects.toThrow(/40-character commit/);
  });

  it('marks actions without an execution consumer as having no authority', async () => {
    const { root, commit } = await setup();
    const batch = await createQuestionBatch(root, { project: 'demo', agent: 'builder' }, {
      context: 'Create a pull request.',
      questions: [{ priority: 1, decision: { action: 'pr', branch: 'feat/t16', commit, destination: 'origin/main', reason: 'Reviewed.' } }],
    });
    const answered = await answerQuestionBatch(root, batch.id, [{ question: 'q1', choice: 'c2' }]);
    expect(answered.answers![0].decision?.grant?.executionAuthority).toBe('none');
  });
});
