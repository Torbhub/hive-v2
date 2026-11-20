import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPERATION_REGISTRY, PREDICATE_REGISTRY } from '../src/evidence.js';
import { pushByHash } from '../src/gate.js';
import {
  evaluateTaskPredicate, listTasks, recordHumanAcceptance, recordTaskEvidence, recordTaskOutcome, recordTaskReceipt,
} from '../src/hub.js';
import {
  appendTaskEvent, contractDigest, foldTasks, hivePath, readTaskEvents, taskEvidenceDigests, valueDigest,
  writeJson, writeProjects,
} from '../src/state.js';
import type {
  HubTask, RootContract, TaskAcceptance, TaskEvidenceOutcome, TaskOperation, TaskOutcome, TmuxAdmission,
} from '../src/types.js';

const CHECKPOINTS = [{ id: 'work', desc: 'bounded work', etaMin: 5 }];
const ARTIFACT = { diff: 'src/a.ts' };
const CONTENT = { check: 'unit', status: 'passed' };
const DIGESTS = taskEvidenceDigests(ARTIFACT, CONTENT);

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function receiptAcceptance(overrides: Partial<TaskAcceptance> = {}): TaskAcceptance {
  return {
    id: 'receipt', predicate_id: 'task_receipt', version: 1,
    configuration: { artifact_digest: DIGESTS.artifact_digest, evidence_hashes: [DIGESTS.evidence_hash] },
    required_evidence: [DIGESTS.evidence_hash], ...overrides,
  };
}

function diffAcceptance(): TaskAcceptance {
  return { id: 'diff', predicate_id: 'git_diff_scope', version: 1, configuration: {}, required_evidence: ['diff'] };
}

async function setup(options: {
  acceptance?: TaskAcceptance[]; writer?: boolean; requiredChildren?: string[]; currentBase?: boolean;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'hive-evidence-'));
  const home = path.join(root, 'work');
  await mkdir(path.join(home, 'src'), { recursive: true });
  git(home, 'init', '-b', 'main');
  git(home, 'config', 'user.email', 'test@example.invalid');
  git(home, 'config', 'user.name', 'Test');
  await writeFile(path.join(home, 'src', 'a.ts'), 'base\n');
  git(home, 'add', 'src/a.ts');
  git(home, 'commit', '-m', 'feat: base');
  const base = git(home, 'rev-parse', 'HEAD');
  await writeFile(path.join(home, 'src', 'a.ts'), 'artifact\n');
  git(home, 'commit', '-am', 'feat: artifact');
  const artifact = git(home, 'rev-parse', 'HEAD');
  const contract: RootContract = {
    schema_version: 1, objective: 'Complete the bounded task.', consumer: 'demo-orchestrator',
    deliverable: 'a bounded diff', kind: 'build', acceptance: options.acceptance ?? [receiptAcceptance()],
    provenance: { repository: home, base_revision: base, artifact_revision: options.currentBase ? base : artifact },
    write_scope: ['src'], action_scope: ['push'],
    budget: { depth: 1, active_children: 8, active_project_records: 16, attempts: 3 },
    delegation: { output_claims: ['a bounded diff'], adapters: ['tmux'] },
    ...(options.requiredChildren ? { required_children: options.requiredChildren } : {}),
  };
  const planDigest = contractDigest(contract);
  await writeProjects(root, { projects: [{ name: 'demo', home, repos: [] }] });
  await writeJson(hivePath(home, 'team.json'), {
    agents: [{ name: 'demo-orchestrator', orchestrator: true, worktree: home }],
  });
  const at = new Date().toISOString();
  await appendTaskEvent(root, { id: 'demo-1', project: 'demo', event: 'asked', at, lease_epoch: 1 });
  await appendTaskEvent(root, {
    id: 'demo-1', project: 'demo', event: 'plan', at, checkpoints: CHECKPOINTS, contract, plan_digest: planDigest,
  });
  await appendTaskEvent(root, { id: 'demo-1', project: 'demo', event: 'answered', at, plan_digest: planDigest });
  await appendTaskEvent(root, {
    id: 'demo-1', project: 'demo', event: 'progress', at, checkpoint: 'work', status: 'ok',
  });
  let admission: TmuxAdmission | undefined;
  if (options.writer) {
    admission = {
      task: 'demo-1', project: 'demo', agent: 'builder', parent_id: 'demo-1', plan_digest: planDigest,
      root_lease_epoch: 1, lease_id: 'lease-1', lease_epoch: 1, lease_revoked: false,
      output_claim: 'a bounded diff', acceptance_ids: contract.acceptance.map((item) => item.id),
      provenance: { ...contract.provenance }, provenance_digest: 'unused', write_scope: ['src'], adapter: 'tmux',
      lineage_id: 'builder', attempts_used: 1, status: 'running',
    };
    await writeJson(hivePath(home, 'team.json'), {
      agents: [
        { name: 'demo-orchestrator', orchestrator: true, worktree: home },
        {
          name: 'builder', task: 'demo-1', worktree: home, parent_id: 'demo-1', plan_digest: planDigest,
          root_lease_epoch: 1, lease_id: 'lease-1', lease_epoch: 1, lease_revoked: false,
          output_claim: 'a bounded diff', acceptance_ids: admission.acceptance_ids,
          provenance: { ...contract.provenance }, provenance_digest: 'unused', write_scope: ['src'], adapter: 'tmux',
          lineage_id: 'builder', attempts_used: 1, admission_status: 'running',
        },
      ],
    });
    admission.team_state_hash = valueDigest(await readFile(hivePath(home, 'team.json'), 'utf8'));
    await appendTaskEvent(root, { id: 'demo-1', project: 'demo', event: 'admission', at, admission });
  }
  return { root, home, contract, planDigest, base, artifact, admission };
}

async function setupGit(options: Parameters<typeof setup>[0] = {}) {
  return setup({ ...options, acceptance: [diffAcceptance()], writer: true });
}

async function separateWorktree(root: string, home: string, artifact: string, existingTeam: boolean): Promise<string> {
  const worktree = path.join(root, 'separate-worktree');
  git(home, 'worktree', 'add', '--detach', worktree, artifact);
  const { readTeam } = await import('../src/state.js');
  const team = await readTeam(home);
  await writeJson(hivePath(home, 'team.json'), {
    agents: team.agents.map((agent) => agent.name === 'builder' ? { ...agent, worktree } : agent),
  });
  if (existingTeam) await writeJson(hivePath(worktree, 'team.json'), { agents: [{ name: 'worktree-state' }] });
  return worktree;
}

async function currentTask(root: string, id = 'demo-1'): Promise<HubTask> {
  return (await listTasks(root)).find((task) => task.id === id)!;
}

async function passAcceptance(root: string, writer = false) {
  const task = await currentTask(root);
  if (task.contract?.acceptance.some((acceptance) => acceptance.predicate_id === 'git_diff_scope')) {
    await expect(evaluateTaskPredicate(root, task.id, 'git_diff_scope', {
      lease_id: 'lease-1', base_revision: task.contract.provenance.base_revision,
      artifact_revision: task.contract.provenance.artifact_revision,
    })).resolves.toBe(true);
    const evidence = (await readTaskEvents(root)).findLast((event) => event.event === 'evidence')!.evidence!;
    if (!writer) {
      const { transitionTmuxAdmission } = await import('../src/admission.js');
      await transitionTmuxAdmission(root, task.contract.provenance.repository, task.id, 'builder', 'lease-1', 'released');
    }
    return evidence;
  }
  const evidence = await recordTaskEvidence(root, task.id, {
    actor: writer ? 'agent:builder' : 'legacy', plan_digest: task.plan_digest!, epoch: task.lease_epoch!,
    outcome: 'passed', artifact: ARTIFACT, content: CONTENT,
    ...(writer ? { lease_id: 'lease-1' } : {}),
  });
  await recordTaskReceipt(root, task.id, {
    actor: writer ? 'agent:builder' : 'legacy', plan_digest: task.plan_digest!, epoch: task.lease_epoch!,
    sequence: 1, artifact_digest: evidence.artifact_digest, counters: {}, external_ids: {},
    evidence_hashes: [evidence.evidence_hash], state: 'reconciling',
    ...(writer ? { lease_id: 'lease-1' } : {}),
  });
  return evidence;
}

function outcomeBinding(task: HubTask, writer = false) {
  return {
    actor: writer ? 'agent:builder' : 'legacy', plan_digest: task.plan_digest!, epoch: task.lease_epoch!,
    ...(writer ? { lease_id: 'lease-1' } : {}),
  };
}

async function recordDone(root: string, writer = false) {
  const task = await currentTask(root);
  return recordTaskOutcome(root, task.id, 'done', outcomeBinding(task, writer));
}

async function pendingOperation(root: string): Promise<TaskOperation> {
  const task = await currentTask(root);
  return {
    operation_id: 'push-1', idempotency_key: 'key-1', kind: 'push', actor: 'legacy',
    plan_digest: task.plan_digest!, epoch: task.lease_epoch!, repository_fingerprint: 'repo', commit: 'a'.repeat(40),
    branch: 'feat/evidence', status: 'pending', updated_at: new Date().toISOString(),
  };
}

describe('registered evidence dispatch', () => {
  it('wires only real predicates and the real push executor', async () => {
    expect(Object.keys(PREDICATE_REGISTRY).sort()).toEqual(['git_diff_scope', 'task_receipt']);
    expect(OPERATION_REGISTRY.push.dispatch).toBe(pushByHash);
    const { root, planDigest } = await setup({ acceptance: [receiptAcceptance()] });
    await passAcceptance(root);
    await expect(evaluateTaskPredicate(root, 'demo-1', 'task_receipt', {
      plan_digest: planDigest, artifact_digest: DIGESTS.artifact_digest, evidence_hashes: [DIGESTS.evidence_hash],
    })).resolves.toBe(false);
    await expect(evaluateTaskPredicate(root, 'demo-1', 'not_registered', {} as never))
      .rejects.toThrow('blocked:unsupported_predicate');
  });

  it('dispatches git_diff_scope against real admitted provenance', async () => {
    const acceptance: TaskAcceptance = {
      id: 'diff', predicate_id: 'git_diff_scope', version: 1, configuration: {}, required_evidence: ['diff'],
    };
    const { root, base, artifact } = await setup({ acceptance: [acceptance], writer: true });
    const passed = await evaluateTaskPredicate(root, 'demo-1', 'git_diff_scope', {
      lease_id: 'lease-1', base_revision: base, artifact_revision: artifact,
    });
    expect((await readTaskEvents(root)).filter((event) => event.event === 'evidence')[0]?.evidence?.content)
      .toMatchObject({ out_of_scope: [] });
    expect(passed).toBe(true);
    await expect(evaluateTaskPredicate(root, 'demo-1', 'git_diff_scope', {
      lease_id: 'lease-1', base_revision: base, artifact_revision: 'f'.repeat(40),
    })).rejects.toThrow(/provenance|revision/);
    const evidence = (await readTaskEvents(root)).filter((event) => event.event === 'evidence');
    expect(evidence).toHaveLength(1);
    expect(evidence[0].evidence).toMatchObject({ outcome: 'passed', lease_id: 'lease-1' });
  });

  it.each(['pending', 'skipped', 'failed', 'adapter-error'] as TaskEvidenceOutcome[])(
    'never passes %s evidence', async (outcome) => {
      const { root, planDigest } = await setup();
      const task = await currentTask(root);
      await recordTaskEvidence(root, task.id, {
        actor: 'legacy', plan_digest: planDigest, epoch: 1, outcome, artifact: ARTIFACT, content: CONTENT,
      });
      await expect(evaluateTaskPredicate(root, task.id, 'task_receipt', {
        plan_digest: planDigest, artifact_digest: DIGESTS.artifact_digest, evidence_hashes: [DIGESTS.evidence_hash],
      })).resolves.toBe(false);
    },
  );

  it('rejects missing, wrong-artifact, stale, and wrong-version evidence', async () => {
    const { root, contract, planDigest } = await setup();
    await expect(evaluateTaskPredicate(root, 'demo-1', 'task_receipt', {
      plan_digest: planDigest, artifact_digest: DIGESTS.artifact_digest,
    })).resolves.toBe(false);
    await passAcceptance(root);
    await expect(evaluateTaskPredicate(root, 'demo-1', 'task_receipt', {
      plan_digest: planDigest, artifact_digest: 'f'.repeat(64),
    })).resolves.toBe(false);
    await expect(evaluateTaskPredicate(root, 'demo-1', 'task_receipt', {
      plan_digest: planDigest, artifact_digest: DIGESTS.artifact_digest,
    }, 2)).rejects.toThrow('blocked:unsupported_predicate');
    const changed = { ...contract, objective: 'A changed contract.' };
    const changedDigest = contractDigest(changed);
    await appendTaskEvent(root, {
      id: 'demo-1', project: 'demo', event: 'plan', at: new Date().toISOString(),
      checkpoints: CHECKPOINTS, contract: changed, plan_digest: changedDigest, lease_epoch: 2,
    });
    await appendTaskEvent(root, {
      id: 'demo-1', project: 'demo', event: 'answered', at: new Date().toISOString(), plan_digest: changedDigest,
    });
    await appendTaskEvent(root, {
      id: 'demo-1', project: 'demo', event: 'progress', at: new Date().toISOString(), checkpoint: 'work', status: 'ok',
    });
    await expect(evaluateTaskPredicate(root, 'demo-1', 'task_receipt', {
      plan_digest: planDigest, artifact_digest: DIGESTS.artifact_digest,
    })).resolves.toBe(false);
    expect((await readTaskEvents(root)).some((event) => event.event === 'evidence')).toBe(true);
    await expect(recordDone(root)).rejects.toThrow(/registered acceptance|reconciling/);
  });
});

describe('review evidence blockers', () => {
  it('allows an exact clean release and rejects an out-of-scope release', async () => {
    const acceptance: TaskAcceptance = {
      id: 'diff', predicate_id: 'git_diff_scope', version: 1, configuration: {}, required_evidence: ['diff'],
    };
    const releasedRoot = await setup({ acceptance: [acceptance], writer: true });
    await expect(evaluateTaskPredicate(releasedRoot.root, 'demo-1', 'git_diff_scope', {
      lease_id: 'lease-1', base_revision: releasedRoot.base, artifact_revision: releasedRoot.artifact,
    })).resolves.toBe(true);
    const { transitionTmuxAdmission } = await import('../src/admission.js');
    await transitionTmuxAdmission(releasedRoot.root, releasedRoot.home, 'demo-1', 'builder', 'lease-1', 'released');
    const released = await currentTask(releasedRoot.root);
    await recordTaskOutcome(releasedRoot.root, released.id, 'done', {
      actor: 'demo-orchestrator', plan_digest: released.plan_digest!, epoch: released.lease_epoch!,
    });
    expect((await currentTask(releasedRoot.root)).state).toBe('done');

    const failedRoot = await setup({ acceptance: [acceptance], writer: true });
    await writeFile(path.join(failedRoot.home, 'outside.txt'), 'outside\n');
    await expect(evaluateTaskPredicate(failedRoot.root, 'demo-1', 'git_diff_scope', {
      lease_id: 'lease-1', base_revision: failedRoot.base, artifact_revision: failedRoot.artifact,
    })).resolves.toBe(false);
    await expect(evaluateTaskPredicate(failedRoot.root, 'demo-1', 'git_diff_scope', {
      lease_id: 'lease-1', base_revision: failedRoot.base, artifact_revision: failedRoot.artifact,
    })).rejects.toThrow(/release|current|launch_error/);
  });

  it('does not manufacture verification from a stored public claim', async () => {
    const { root, planDigest } = await setup({ acceptance: [receiptAcceptance()] });
    const task = await currentTask(root);
    const evidence = await recordTaskEvidence(root, task.id, {
      actor: 'legacy', plan_digest: planDigest, epoch: 1, outcome: 'passed', artifact: ARTIFACT, content: CONTENT,
    });
    await recordTaskReceipt(root, task.id, {
      actor: 'legacy', plan_digest: planDigest, epoch: 1, sequence: 1,
      artifact_digest: evidence.artifact_digest, counters: {}, external_ids: {},
      evidence_hashes: [evidence.evidence_hash], state: 'reconciling',
    });
    expect(evidence.verification).toBeUndefined();
    await expect(evaluateTaskPredicate(root, task.id, 'task_receipt', {
      plan_digest: planDigest, artifact_digest: evidence.artifact_digest,
    })).resolves.toBe(false);
  });
});

describe('evidence outcomes', () => {
  it('requires a registered pass before done', async () => {
    const unverified = await setup();
    await expect(recordDone(unverified.root)).rejects.toThrow(/registered acceptance/);
    const { root } = await setupGit();
    await passAcceptance(root);
    await recordDone(root);
    expect((await currentTask(root)).state).toBe('done');
  });

  it('allows already_fixed and no_op with evidence, and guards duplicate links', async () => {
    for (const outcome of ['already_fixed', 'no_op'] as TaskOutcome[]) {
      const { root } = await setupGit({ currentBase: true });
      await passAcceptance(root);
      const task = await currentTask(root);
      await recordTaskOutcome(root, task.id, outcome, outcomeBinding(task));
      expect((await currentTask(root)).state).toBe(outcome);
    }
    const changedRoot = await setup();
    await passAcceptance(changedRoot.root);
    const changedTask = await currentTask(changedRoot.root);
    await expect(recordTaskOutcome(changedRoot.root, changedTask.id, 'already_fixed', outcomeBinding(changedTask)))
      .rejects.toThrow(/current-base/);

    const { root } = await setupGit();
    await passAcceptance(root);
    const task = await currentTask(root);
    await expect(recordTaskOutcome(root, task.id, 'duplicate', outcomeBinding(task)))
      .rejects.toThrow(/covering record/);
    await appendTaskEvent(root, { id: 'demo-2', project: 'demo', event: 'asked', at: new Date().toISOString() });
    await appendTaskEvent(root, { id: 'demo-2', project: 'demo', event: 'done', at: new Date().toISOString() });
    await recordTaskOutcome(root, task.id, 'duplicate', {
      ...outcomeBinding(task), covering_record: 'demo-2',
    });
    expect((await currentTask(root)).state).toBe('duplicate');

    const crossRoot = await setup();
    await passAcceptance(crossRoot.root);
    const crossTask = await currentTask(crossRoot.root);
    await appendTaskEvent(crossRoot.root, { id: 'other-2', project: 'other', event: 'done', at: new Date().toISOString() });
    await expect(recordTaskOutcome(crossRoot.root, crossTask.id, 'duplicate', {
      ...outcomeBinding(crossTask), covering_record: 'other-2',
    })).rejects.toThrow(/covering record|project/);
  });

  it('records failed, unknown, and superseded without treating them as success', async () => {
    for (const outcome of ['failed', 'unknown', 'superseded'] as const) {
      const { root } = await setup();
      if (outcome === 'superseded') {
        await appendTaskEvent(root, { id: 'demo-9', project: 'demo', event: 'asked', at: new Date().toISOString() });
      }
      const task = await currentTask(root);
      await recordTaskOutcome(root, task.id, outcome, {
        ...outcomeBinding(task), reason: 'outcome is not provable',
        ...(outcome === 'superseded' ? { replacement_id: 'demo-9' } : {}),
      });
      expect((await currentTask(root)).state).toBe(outcome);
      expect((await currentTask(root)).state).not.toBe('done');
    }
    const { root } = await setup();
    const task = await currentTask(root);
    await expect(recordTaskOutcome(root, task.id, 'superseded', outcomeBinding(task)))
      .rejects.toThrow(/replacement/);
    await expect(recordTaskOutcome(root, task.id, 'superseded', {
      ...outcomeBinding(task), replacement_id: task.id,
    })).rejects.toThrow(/replacement/);
    await appendTaskEvent(root, { id: 'other-9', project: 'other', event: 'done', at: new Date().toISOString() });
    await expect(recordTaskOutcome(root, task.id, 'superseded', {
      ...outcomeBinding(task), replacement_id: 'other-9',
    })).rejects.toThrow(/replacement|project/);

    const optional = {
      id: 'optional', predicate_id: 'optional_unknown', version: 1, configuration: {}, required_evidence: ['extra'],
      required: false,
    };
    const passedRoot = await setup({ acceptance: [diffAcceptance(), optional], writer: true });
    await passAcceptance(passedRoot.root);
    const passedTask = await currentTask(passedRoot.root);
    await expect(recordTaskOutcome(passedRoot.root, passedTask.id, 'failed', {
      ...outcomeBinding(passedTask), reason: 'contradictory failure',
    })).rejects.toThrow(/unsatisfied/);
  });

  it('blocks every terminal outcome with an owned live operation', async () => {
    const { root } = await setupGit();
    await passAcceptance(root);
    const operation = await pendingOperation(root);
    await appendTaskEvent(root, {
      id: 'demo-1', project: 'demo', event: 'operation', at: new Date().toISOString(), operation,
    });
    await expect(recordDone(root)).rejects.toThrow(/external operation/);
    await appendTaskEvent(root, { id: 'demo-9', project: 'demo', event: 'asked', at: new Date().toISOString() });
    const task = await currentTask(root);
    for (const outcome of ['failed', 'unknown', 'superseded'] as const) {
      await expect(recordTaskOutcome(root, task.id, outcome, {
        ...outcomeBinding(task), reason: 'unresolved operation', replacement_id: 'demo-9',
      })).rejects.toThrow(/live external operation/);
    }
    await appendTaskEvent(root, {
      id: 'demo-1', project: 'demo', event: 'operation', at: new Date().toISOString(),
      operation: { ...operation, status: 'succeeded', result: { remote_tip: operation.commit } },
    });
    await recordDone(root);
  });

  it('poisons an operation ID permanently after an identity conflict', async () => {
    const { root } = await setup();
    const operation = await pendingOperation(root);
    await appendTaskEvent(root, {
      id: 'demo-1', project: 'demo', event: 'operation', at: new Date().toISOString(), operation,
    });
    await appendTaskEvent(root, {
      id: 'demo-1', project: 'demo', event: 'operation', at: new Date().toISOString(),
      operation: { ...operation, branch: 'changed' },
    });
    await appendTaskEvent(root, {
      id: 'demo-1', project: 'demo', event: 'operation', at: new Date().toISOString(),
      operation: { ...operation, status: 'succeeded', result: { remote_tip: operation.commit } },
    });
    await appendTaskEvent(root, {
      id: 'demo-1', project: 'demo', event: 'operation', at: new Date().toISOString(), operation,
    });
    await expect(recordDone(root)).rejects.toThrow(/external operation|ambiguous/);
  });

  it('rejects done with a wrong or missing remote tip', async () => {
    for (const result of [{ remote_tip: '0'.repeat(40) }, {}] as const) {
      const { root } = await setup();
      await passAcceptance(root);
      const operation = await pendingOperation(root);
      await appendTaskEvent(root, {
        id: 'demo-1', project: 'demo', event: 'operation', at: new Date().toISOString(),
        operation: { ...operation, status: 'succeeded', result } as TaskOperation,
      });
      await expect(recordDone(root)).rejects.toThrow(/remote tip/);
    }
  });

  it('blocks required children and accounts for active writers on every terminal outcome', async () => {
    const childRoot = await setupGit({ requiredChildren: ['demo-2'] });
    await passAcceptance(childRoot.root);
    await expect(recordDone(childRoot.root)).rejects.toThrow(/required child demo-2/);

    const writerRoot = await setupGit();
    await passAcceptance(writerRoot.root, true);
    await expect(recordDone(writerRoot.root, true)).rejects.toThrow(/writer/);
    const writerTask = await currentTask(writerRoot.root);
    for (const outcome of ['failed', 'unknown'] as const) {
      await expect(recordTaskOutcome(writerRoot.root, writerTask.id, outcome, {
        ...outcomeBinding(writerTask, true), reason: 'writer still active',
      })).rejects.toThrow(/writer/);
    }
    const { transitionTmuxAdmission } = await import('../src/admission.js');
    await transitionTmuxAdmission(writerRoot.root, writerRoot.home, 'demo-1', 'builder', 'lease-1', 'released');
    const released = await currentTask(writerRoot.root);
    await recordTaskOutcome(writerRoot.root, released.id, 'done', {
      actor: 'demo-orchestrator', plan_digest: released.plan_digest!, epoch: released.lease_epoch!,
    });
    expect((await currentTask(writerRoot.root)).state).toBe('done');
  });

  it('rejects missing, cross-project, and cyclic covering records for required children', async () => {
    const { root } = await setupGit({ requiredChildren: ['demo-2'] });
    await passAcceptance(root);
    await appendTaskEvent(root, {
      id: 'demo-2', project: 'demo', event: 'duplicate', at: new Date().toISOString(),
      outcome: { actor: 'legacy', plan_digest: 'child-plan', epoch: 1, covering_record: 'demo-3' },
    });
    await appendTaskEvent(root, {
      id: 'demo-3', project: 'demo', event: 'duplicate', at: new Date().toISOString(),
      outcome: { actor: 'legacy', plan_digest: 'child-plan', epoch: 1, covering_record: 'demo-2' },
    });
    await expect(recordDone(root)).rejects.toThrow(/required child demo-2/);

    const crossRoot = await setupGit({ requiredChildren: ['other-2'] });
    await passAcceptance(crossRoot.root);
    await appendTaskEvent(crossRoot.root, { id: 'other-2', project: 'other', event: 'done', at: new Date().toISOString() });
    await expect(recordDone(crossRoot.root)).rejects.toThrow(/required child other-2/);

    const missingRoot = await setupGit({ requiredChildren: ['https://example.invalid/pull/12'] });
    await passAcceptance(missingRoot.root);
    await expect(recordDone(missingRoot.root)).rejects.toThrow(/required child/);
  });

  it('lets a human resolve only an unsupported extra predicate', async () => {
    const extra: TaskAcceptance = {
      id: 'extra', predicate_id: 'human_review', version: 1, configuration: {}, required_evidence: ['review'],
      required: false,
    };
    const { root } = await setup({ acceptance: [diffAcceptance(), extra], writer: true });
    await passAcceptance(root);
    await expect(recordDone(root)).rejects.toThrow('blocked:unsupported_predicate');
    let task = await currentTask(root);
    await recordHumanAcceptance(root, task.id, {
      ...outcomeBinding(task, false), actor: 'user:alice', acceptance_id: 'extra',
    });
    await recordDone(root);
    expect((await currentTask(root)).state).toBe('done');

    const requiredRoot = await setup({
      acceptance: [diffAcceptance(), { ...extra, id: 'required-human', required: true }], writer: true,
    });
    await passAcceptance(requiredRoot.root);
    task = await currentTask(requiredRoot.root);
    await recordHumanAcceptance(requiredRoot.root, task.id, {
      ...outcomeBinding(task), actor: 'user:alice', acceptance_id: 'required-human',
    });
    await expect(recordDone(requiredRoot.root)).rejects.toThrow('blocked:unsupported_predicate');
  });

  it('never lets human acceptance replace a required registered pass', async () => {
    const { root } = await setup({ acceptance: [receiptAcceptance()] });
    const task = await currentTask(root);
    await recordHumanAcceptance(root, task.id, {
      ...outcomeBinding(task), actor: 'user:alice', acceptance_id: 'receipt',
    });
    await expect(recordDone(root)).rejects.toThrow(/registered acceptance/);
  });

  it('exposes folded operations without replacing task or team records', async () => {
    const { root, home } = await setup();
    const operation = await pendingOperation(root);
    await appendTaskEvent(root, {
      id: 'demo-1', project: 'demo', event: 'operation', at: new Date().toISOString(), operation,
    });
    const events = await readTaskEvents(root);
    expect(foldTasks(events)[0].operations).toEqual([operation]);
    expect(events.filter((event) => event.event === 'admission')).toHaveLength(0);
    await expect((await import('../src/state.js')).readTeam(home)).resolves.toMatchObject({
      agents: [{ name: 'demo-orchestrator' }],
    });
  });
});

describe('focused review blockers', () => {
  it('rejects protected team mutation after a clean release', async () => {
    const acceptance: TaskAcceptance = {
      id: 'diff', predicate_id: 'git_diff_scope', version: 1, configuration: {}, required_evidence: ['diff'],
    };
    const { root, home, base, artifact } = await setup({ acceptance: [acceptance], writer: true });
    await expect(evaluateTaskPredicate(root, 'demo-1', 'git_diff_scope', {
      lease_id: 'lease-1', base_revision: base, artifact_revision: artifact,
    })).resolves.toBe(true);
    const { transitionTmuxAdmission } = await import('../src/admission.js');
    await transitionTmuxAdmission(root, home, 'demo-1', 'builder', 'lease-1', 'released');
    const { readTeam } = await import('../src/state.js');
    const team = await readTeam(home);
    await writeJson(hivePath(home, 'team.json'), {
      agents: team.agents.map((agent) => agent.orchestrator ? { ...agent, protected_note: 'changed after release' } : agent),
    });
    await expect(evaluateTaskPredicate(root, 'demo-1', 'git_diff_scope', {
      lease_id: 'lease-1', base_revision: base, artifact_revision: artifact,
    })).resolves.toBe(false);
    const released = await currentTask(root);
    await expect(recordTaskOutcome(root, released.id, 'done', {
      actor: 'demo-orchestrator', plan_digest: released.plan_digest!, epoch: released.lease_epoch!,
    })).rejects.toThrow(/registered acceptance/);
  });

  it('binds clean release to the evaluated worktree team file', async () => {
    const acceptance: TaskAcceptance = {
      id: 'diff', predicate_id: 'git_diff_scope', version: 1, configuration: {}, required_evidence: ['diff'],
    };
    const { transitionTmuxAdmission } = await import('../src/admission.js');
    const clean = await setup({ acceptance: [acceptance], writer: true });
    await separateWorktree(clean.root, clean.home, clean.artifact, true);
    await transitionTmuxAdmission(clean.root, clean.home, 'demo-1', 'builder', 'lease-1', 'released');
    await recordDone(clean.root);
    expect((await currentTask(clean.root)).state).toBe('done');

    const changed = await setup({ acceptance: [acceptance], writer: true });
    const worktree = await separateWorktree(changed.root, changed.home, changed.artifact, true);
    await transitionTmuxAdmission(changed.root, changed.home, 'demo-1', 'builder', 'lease-1', 'released');
    await writeJson(hivePath(worktree, 'team.json'), { agents: [{ name: 'worktree-state', protected_note: 'changed' }] });
    await expect(evaluateTaskPredicate(changed.root, 'demo-1', 'git_diff_scope', {
      lease_id: 'lease-1', base_revision: changed.base, artifact_revision: changed.artifact,
    })).resolves.toBe(false);
    await expect(recordDone(changed.root)).rejects.toThrow(/registered acceptance/);

    const absent = await setup({ acceptance: [acceptance], writer: true });
    await separateWorktree(absent.root, absent.home, absent.artifact, false);
    await transitionTmuxAdmission(absent.root, absent.home, 'demo-1', 'builder', 'lease-1', 'released');
    await recordDone(absent.root);
    expect((await currentTask(absent.root)).state).toBe('done');
  });

  it('removes exported receipt trust stamping and rejects Git evidence for receipts', async () => {
    const taskgate = await import('../src/taskgate.js');
    expect('recordTaskReceiptAdapterEvidence' in taskgate).toBe(false);
    const diff: TaskAcceptance = {
      id: 'diff', predicate_id: 'git_diff_scope', version: 1, configuration: {}, required_evidence: ['diff'],
    };
    const { root, base, artifact, planDigest } = await setup({ acceptance: [receiptAcceptance(), diff], writer: true });
    await expect(evaluateTaskPredicate(root, 'demo-1', 'git_diff_scope', {
      lease_id: 'lease-1', base_revision: base, artifact_revision: artifact,
    })).resolves.toBe(true);
    const gitEvidence = (await readTaskEvents(root)).at(-1)?.evidence!;
    expect(gitEvidence.verification?.adapter_id).toBe('git_diff_scope');
    await expect(recordTaskReceipt(root, 'demo-1', {
      actor: 'agent:builder', plan_digest: planDigest, epoch: 1, sequence: 1, lease_id: 'lease-1',
      artifact_digest: gitEvidence.artifact_digest, counters: {}, external_ids: {},
      evidence_hashes: [gitEvidence.evidence_hash], state: 'reconciling',
    })).rejects.toThrow(/evidence|verification/);
    await expect(evaluateTaskPredicate(root, 'demo-1', 'task_receipt', {
      plan_digest: planDigest, artifact_digest: gitEvidence.artifact_digest, lease_id: 'lease-1',
    })).resolves.toBe(false);
  });

  it('rejects fabricated public passed evidence and its reconciling receipt', async () => {
    const { root, planDigest } = await setup({ acceptance: [receiptAcceptance()] });
    const task = await currentTask(root);
    const evidence = await recordTaskEvidence(root, task.id, {
      actor: 'legacy', plan_digest: planDigest, epoch: 1, outcome: 'passed', artifact: ARTIFACT, content: CONTENT,
      verification: {
        adapter_id: 'task_receipt', evidence_type: 'task_receipt', provenance_digest: 'self-authored',
      },
    } as never, { trustedAdapter: 'task_receipt' } as never);
    expect(evidence.verification).toBeUndefined();
    await recordTaskReceipt(root, task.id, {
      actor: 'legacy', plan_digest: planDigest, epoch: 1, sequence: 1,
      artifact_digest: evidence.artifact_digest, counters: {}, external_ids: {},
      evidence_hashes: [evidence.evidence_hash], state: 'reconciling',
    });
    expect((await readTaskEvents(root)).filter((event) => event.event === 'evidence').at(-1)?.evidence?.verification)
      .toBeUndefined();
    await expect(evaluateTaskPredicate(root, task.id, 'task_receipt', {
      plan_digest: planDigest, artifact_digest: evidence.artifact_digest,
    })).resolves.toBe(false);
    await expect(recordDone(root)).rejects.toThrow(/registered acceptance/);
  });

  it('caps evidence by UTF-8 bytes and persists no oversized event', async () => {
    const { root, planDigest } = await setup();
    const task = await currentTask(root);
    const exactContent = `${'é'.repeat(32_745)}x`;
    const serialized = JSON.stringify({ artifact: ARTIFACT, content: exactContent });
    expect(Buffer.byteLength(serialized, 'utf8')).toBe(64 * 1024);
    const exact = await recordTaskEvidence(root, task.id, {
      actor: 'legacy', plan_digest: planDigest, epoch: 1, outcome: 'passed',
      artifact: ARTIFACT, content: exactContent,
    });
    expect(exact.evidence_hash).toBeTruthy();
    const before = await readTaskEvents(root);
    await expect(recordTaskEvidence(root, task.id, {
      actor: 'legacy', plan_digest: planDigest, epoch: 1, outcome: 'passed',
      artifact: ARTIFACT, content: `${exactContent}x`,
    })).rejects.toThrow(/byte cap/);
    expect(await readTaskEvents(root)).toEqual(before);
  });
});
