import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  admitNative, admitTmux, applyRootDeltaLocked, assertTmuxGrant, reconcileTaskBudgets, recordTmuxLaunchOutcome,
  transitionTmuxAdmission, type TmuxAdmissionRequest,
} from '../src/admission.js';
import {
  evaluateTaskPredicate, hubLog, hubProgress, hubResolve, hubTask, planAnswer, recordTaskEvidence, recordTaskReceipt,
} from '../src/hub.js';
import {
  appendTaskEvent, contractDigest, foldTasks, hivePath, hubPath, readTaskEvents, readTeam, withHubLock, writeJson,
} from '../src/state.js';
import type { RootContract } from '../src/types.js';

const IDLE = await fs.readFile(new URL('./fixtures/idle-empty-prompt.txt', import.meta.url), 'utf8');
vi.mock('../src/tmux.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/tmux.js')>();
  return {
    ...original,
    paneExists: vi.fn(async () => true),
    paneIdentity: vi.fn(async () => ({ pid: 1, started: 'x' })),
    paneIs: vi.fn(async () => true),
    capturePane: vi.fn(async () => IDLE),
    sendLiteral: vi.fn(async () => {}),
    sendEnter: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
  };
});

const OUTPUT = 'Return the bounded implementation and its evidence.';

async function setup(contractChanges: Partial<RootContract> = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'hive-admission-'));
  const home = path.join(root, 'demo');
  await fs.mkdir(home, { recursive: true });
  const contract: RootContract = {
    schema_version: 1,
    objective: 'Implement the bounded change.',
    consumer: 'demo-orchestrator',
    deliverable: OUTPUT,
    kind: 'build',
    acceptance: [{
      id: 'diff', predicate_id: 'git_diff_scope', version: 1,
      configuration: {}, required_evidence: ['diff-evidence'],
    }],
    provenance: {
      repository: home,
      base_revision: '0'.repeat(40),
      artifact_revision: '1'.repeat(40),
    },
    write_scope: ['src'],
    action_scope: [],
    budget: { depth: 1, active_children: 4, active_project_records: 4, attempts: 3 },
    delegation: { output_claims: [OUTPUT, 'Review the bounded change.'], adapters: ['tmux'] },
    ...contractChanges,
  };
  await writeJson(hubPath(root, 'projects.json'), {
    projects: [{ name: 'demo', home, repos: [{ folder: home }] }],
  });
  return { root, home, contract };
}

async function seedTask(root: string, contract: RootContract, id = 'demo-1') {
  const project = id.replace(/-\d+$/, '');
  expect(await hubTask(root, project, 'Implement the bounded change.')).toBe(id);
  const home = contract.provenance.kind === 'research' ? path.join(root, project) : contract.provenance.repository;
  const team = await readTeam(home);
  if (!team.agents.some((agent) => agent.orchestrator)) {
    await writeJson(hivePath(home, 'team.json'), {
      agents: [...team.agents, {
        name: `${project}-orchestrator`, orchestrator: true, pane: '%1', pane_pid: 1, pane_started: 'x',
      }],
    });
  }
  await hubLog(root, id, 'plan', 'the plan', [{ id: 'work', desc: 'bounded work', etaMin: 5 }], undefined, contract);
  await planAnswer(root, project, id, 'approve');
}

function request(home: string, contract: RootContract, changes: Partial<TmuxAdmissionRequest> = {}): TmuxAdmissionRequest {
  return {
    parent_id: 'demo-1',
    plan_digest: contractDigest(contract),
    output_claim: OUTPUT,
    acceptance_ids: ['diff'],
    provenance: contract.provenance.kind === 'research'
      ? { ...contract.provenance }
      : { ...contract.provenance, repository: home },
    write_scope: ['src'],
    adapter: 'tmux',
    budget: { depth: 1, attempts: contract.budget.attempts },
    ...changes,
  };
}

async function withRetryIdentity(root: string, value: TmuxAdmissionRequest): Promise<TmuxAdmissionRequest> {
  if (!value.retry_of) return value;
  const task = foldTasks(await readTaskEvents(root)).find((candidate) => candidate.id === value.parent_id);
  const previous = task?.admissions?.filter((admission) => admission.agent === value.retry_of).at(-1);
  return {
    ...value,
    retry_lease_id: previous?.lease_id,
    retry_plan_digest: previous?.plan_digest,
    lineage_id: previous?.lineage_id,
  };
}

async function admit(
  root: string, home: string, contract: RootContract, agent: string,
  changes: Partial<TmuxAdmissionRequest> = {}, id = 'demo-1',
) {
  return admitTmux(root, home, id, agent, await withRetryIdentity(root, request(home, contract, changes)));
}

async function outcome(root: string, home: string, agent: string, detail: string) {
  const task = foldTasks(await readTaskEvents(root)).find((candidate) => candidate.id === 'demo-1');
  const admission = task?.admissions?.filter((candidate) => candidate.agent === agent).at(-1)!;
  await recordTmuxLaunchOutcome(root, home, 'demo-1', agent, admission.lease_id, detail);
}

describe('tmux admission leases', () => {
  it('admits one epoch-1 writer from a 20-way race without a prior worker epoch', async () => {
    const { root, home, contract } = await setup();
    await seedTask(root, contract);
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => admit(root, home, contract, 'builder')));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof admit>>>;
    expect(winner.value).toMatchObject({ lease_epoch: 1, attempts_used: 1, status: 'admitted' });
    const team = await readTeam(home);
    const workers = team.agents.filter((agent) => !agent.orchestrator);
    expect(workers).toHaveLength(1);
    expect(workers[0]).toMatchObject({ name: 'builder', lease_epoch: 1, attempts_used: 1 });
  });

  it('normalizes prefix collisions, including writers on the same task', async () => {
    const { root, home, contract } = await setup();
    await seedTask(root, contract);
    await admit(root, home, contract, 'builder', { output_claim: OUTPUT });
    await expect(admit(root, home, contract, 'reviewer', {
      output_claim: 'Review the bounded change.', write_scope: ['./src/a'],
    })).rejects.toThrow(/overlap|collision/);
    expect((await readTeam(home)).agents.filter((agent) => !agent.orchestrator).map((agent) => agent.name)).toEqual(['builder']);
  });

  it('allows identical names and relative paths in different canonical repositories', async () => {
    const { root, home, contract } = await setup();
    await seedTask(root, contract);
    const otherHome = path.join(root, 'other');
    await fs.mkdir(otherHome);
    await writeJson(hubPath(root, 'projects.json'), {
      projects: [
        { name: 'demo', home, repos: [{ folder: home }] },
        { name: 'other', home: otherHome, repos: [{ folder: otherHome }] },
      ],
    });
    const otherContract = { ...contract, provenance: { ...contract.provenance, repository: otherHome } };
    await seedTask(root, otherContract, 'other-1');
    await admit(root, home, contract, 'builder');
    const other = await admit(root, otherHome, otherContract, 'builder', { parent_id: 'other-1' }, 'other-1');
    expect(other).toMatchObject({ agent: 'builder', project: 'other', lineage_id: 'builder', attempts_used: 1 });
    expect((await readTeam(home)).agents.find((agent) => agent.name === 'builder')?.write_scope).toEqual(['src']);
    expect((await readTeam(otherHome)).agents.find((agent) => agent.name === 'builder')?.write_scope).toEqual(['src']);
  });

  it('collides overlapping writers in two real JJ workspaces of one repository', async () => {
    const { root, home, contract } = await setup();
    execFileSync('jj', ['git', 'init', home]);
    execFileSync('jj', ['config', 'set', '--repo', 'user.email', 'hive@example.invalid'], { cwd: home });
    execFileSync('jj', ['config', 'set', '--repo', 'user.name', 'Hive Test'], { cwd: home });
    execFileSync('jj', ['new', '-m', 'base'], { cwd: home });
    await seedTask(root, contract);
    const otherHome = `${home}-worktree`;
    execFileSync('jj', ['workspace', 'add', otherHome], { cwd: home });
    await writeJson(hubPath(root, 'projects.json'), {
      projects: [
        { name: 'demo', home, repos: [{ folder: home }] },
        { name: 'other', home: otherHome, repos: [{ folder: otherHome }] },
      ],
    });
    const otherContract = { ...contract, provenance: { ...contract.provenance, repository: otherHome } };
    await seedTask(root, otherContract, 'other-1');
    await admit(root, home, contract, 'builder');
    await expect(admit(root, otherHome, otherContract, 'reviewer', { parent_id: 'other-1' }, 'other-1'))
      .rejects.toThrow(/collision/);
  });

  it('lets overlapping read-only leases coexist and never treats empty scope as a writer', async () => {
    const { root, home, contract } = await setup({ write_scope: [] });
    await seedTask(root, contract);
    await admit(root, home, contract, 'reader-a', { write_scope: [] });
    await admit(root, home, contract, 'reader-b', {
      output_claim: 'Review the bounded change.', write_scope: [],
    });
    expect((await readTeam(home)).agents.filter((agent) => !agent.orchestrator)).toHaveLength(2);
    expect((await readTeam(home)).agents.filter((agent) => !agent.orchestrator)
      .every((agent) => agent.write_scope?.length === 0)).toBe(true);
  });

  it.each([
    ['/tmp/src'], ['../src'], ['src/../../outside'], ['src/*'], [''],
  ])('rejects ambiguous or escaping scope %s', async (scope) => {
    const { root, home, contract } = await setup();
    await seedTask(root, contract);
    await expect(admit(root, home, contract, 'builder', { write_scope: [scope] })).rejects.toThrow(/scope|path/);
  });

  it.each([
    '.hive/team.json',
    '.hive/team/builder/role.md',
    '.hive-hub/launches/demo:unallocated.json',
    'src/admission.ts',
    'scripts/discipline-gate.mjs',
  ])('rejects protected scope %s at admission', async (scope) => {
    const { root, home, contract } = await setup({ write_scope: ['src', scope] });
    await seedTask(root, contract);
    await expect(admit(root, home, contract, 'builder', { write_scope: [scope] }))
      .rejects.toThrow(/protected|scope/);
    expect((await readTeam(home)).agents.filter((agent) => !agent.orchestrator)).toHaveLength(0);
  });

  it('rejects an unresolved repository root before reserving', async () => {
    const { root, home, contract } = await setup();
    await seedTask(root, contract);
    await expect(admitTmux(root, path.join(home, 'missing'), 'demo-1', 'builder', request(home, contract)))
      .rejects.toThrow(/root|repository/);
    expect((await readTeam(home)).agents.filter((agent) => !agent.orchestrator)).toHaveLength(0);
  });

  it('validates the digest, acceptance, provenance, output claim, adapter, and scope subset', async () => {
    const { root, home, contract } = await setup();
    await seedTask(root, contract);
    const invalid = [
      { plan_digest: 'f'.repeat(64) },
      { acceptance_ids: ['missing'] },
      { provenance: { ...contract.provenance, base_revision: '2'.repeat(40) } },
      { output_claim: 'unallocated output' },
      { adapter: 'native' as const },
      { write_scope: ['test'] },
      { budget: { depth: 2, attempts: 3 } },
    ];
    for (const changes of invalid) {
      await expect(admit(root, home, contract, 'builder', changes as Partial<TmuxAdmissionRequest>)).rejects.toThrow();
    }
    expect((await readTeam(home)).agents.filter((agent) => !agent.orchestrator)).toHaveLength(0);
  });

  it('enforces parent and project active-record budgets', async () => {
    const { root, home, contract } = await setup({
      write_scope: [], budget: { depth: 1, active_children: 1, active_project_records: 1, attempts: 3 },
    });
    await seedTask(root, contract);
    await admit(root, home, contract, 'reader-a', { write_scope: [] });
    await expect(admit(root, home, contract, 'reader-b', {
      output_claim: 'Review the bounded change.', write_scope: [],
    })).rejects.toThrow(/active children|active project|budget/);

    const second = { ...contract };
    await seedTask(root, second, 'demo-2');
    await expect(admitTmux(root, home, 'demo-2', 'reader-c', {
      ...request(home, second, {
        parent_id: 'demo-2', output_claim: 'Review the bounded change.', write_scope: [],
      }),
    })).rejects.toThrow(/active project|budget/);
  });

  it('counts legacy workers once and does not double count represented replacements', async () => {
    const legacy = await setup({
      write_scope: [], budget: { depth: 1, active_children: 1, active_project_records: 1, attempts: 3 },
    });
    await seedTask(legacy.root, legacy.contract);
    await writeJson(hivePath(legacy.home, 'team.json'), {
      agents: [{ name: 'legacy', task: 'demo-1', write_scope: [] }],
    });
    await expect(admit(legacy.root, legacy.home, legacy.contract, 'builder', { write_scope: [] }))
      .rejects.toThrow(/active children|active project/);

    const represented = await setup({
      write_scope: [], budget: { depth: 1, active_children: 1, active_project_records: 1, attempts: 3 },
    });
    await seedTask(represented.root, represented.contract);
    const first = await admit(represented.root, represented.home, represented.contract, 'builder', { write_scope: [] });
    const replacement = await admit(represented.root, represented.home, represented.contract, 'builder', {
      retry_of: 'builder', write_scope: [],
    });
    expect(replacement.attempts_used).toBe(first.attempts_used + 1);
  });

  it('deduplicates remediation by fingerprint and other work by output and provenance', async () => {
    const remediation = await setup({
      kind: 'remediation', defect_fingerprint: 'repo:base:workflow:step', write_scope: [],
    });
    await seedTask(remediation.root, remediation.contract);
    await admit(remediation.root, remediation.home, remediation.contract, 'fix-a', { write_scope: [] });
    await expect(admit(remediation.root, remediation.home, remediation.contract, 'fix-b', {
      output_claim: 'Review the bounded change.', write_scope: [],
    })).rejects.toThrow(/duplicate/);

    const build = await setup({ write_scope: [] });
    await seedTask(build.root, build.contract);
    await admit(build.root, build.home, build.contract, 'build-a', { write_scope: [] });
    await expect(admit(build.root, build.home, build.contract, 'build-b', { write_scope: [] })).rejects.toThrow(/duplicate/);
  });

  it('revokes the ledger reservation when the team write fails', async () => {
    const { root, home, contract } = await setup();
    await seedTask(root, contract);
    await fs.mkdir(hivePath(home, `team.json.tmp.${process.pid}`), { recursive: true });
    await expect(admit(root, home, contract, 'builder')).rejects.toThrow(/EISDIR|directory/);
    const task = foldTasks(await readTaskEvents(root)).find((candidate) => candidate.id === 'demo-1')!;
    expect(task.admissions?.at(-1)).toMatchObject({ agent: 'builder', lease_revoked: true, status: 'revoked' });
    expect(task.admissions?.some((admission) => !admission.lease_revoked
      && (admission.status === 'admitted' || admission.status === 'running'))).toBe(false);
  });

  it('rechecks the external preflight snapshot under the locks', async () => {
    const { root, home, contract } = await setup({ preflight_snapshot: 'version-1' });
    await seedTask(root, contract);
    const readPreflightSnapshot = vi.fn()
      .mockResolvedValueOnce('version-1')
      .mockResolvedValueOnce('version-2');
    await expect(admitTmux(root, home, 'demo-1', 'builder', request(home, contract), {
      readPreflightSnapshot,
    })).rejects.toThrow(/preflight/);
    expect(readPreflightSnapshot).toHaveBeenCalledTimes(2);
    expect((await readTeam(home)).agents.filter((agent) => !agent.orchestrator)).toHaveLength(0);
  });
});

describe('tmux replacement lineage', () => {
  it('admits one respawn from the same entry and ignores the stale failure', async () => {
    const { root, home, contract } = await setup();
    await seedTask(root, contract);
    const first = await admit(root, home, contract, 'builder');
    const results = await Promise.allSettled([
      admit(root, home, contract, 'builder', { retry_of: 'builder' }),
      admit(root, home, contract, 'builder', { retry_of: 'builder' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof admit>>>;
    expect(winner.value.attempts_used).toBe(2);
    await recordTmuxLaunchOutcome(root, home, 'demo-1', 'builder', first.lease_id, 'delayed attempt 1 failure');
    expect((await readTeam(home)).agents.find((agent) => agent.lease_id === winner.value.lease_id)).toMatchObject({
      lease_revoked: false, admission_status: 'admitted', attempts_used: 2,
    });
  });

  it('keeps lineage when a replacement changes adapters', async () => {
    const { root, home, contract } = await setup();
    await seedTask(root, contract);
    const first = await admit(root, home, contract, 'tmux-old');
    await outcome(root, home, 'tmux-old', 'retry on native');
    await appendTaskEvent(root, {
      id: 'demo-1', project: 'demo', event: 'admission', at: new Date().toISOString(),
      admission: {
        ...first, agent: 'native-old', adapter: 'native', lease_id: 'native-epoch-1',
        attempts_used: 2, status: 'failed', lease_revoked: true,
      },
    });
    const third = await admit(root, home, contract, 'tmux-new', { retry_of: 'native-old' });
    expect(third).toMatchObject({ attempts_used: 3, lineage_id: 'tmux-old', adapter: 'tmux' });
  });

  it('keeps cumulative attempts across replacements, restart folds, external resume, and cap increases', async () => {
    const { root, home, contract } = await setup();
    await seedTask(root, contract);
    await admit(root, home, contract, 'attempt-1');
    await outcome(root, home, 'attempt-1', 'launch failed');

    await admit(root, home, contract, 'attempt-2', { retry_of: 'attempt-1' });
    expect((await readTeam(home)).agents.find((agent) => agent.name === 'attempt-2')).toMatchObject({
      retry_of: 'attempt-1', lineage_id: 'attempt-1', attempts_used: 2,
    });
    await outcome(root, home, 'attempt-2', 'process restarted');

    const eventsBeforeRestart = await readTaskEvents(root);
    expect(eventsBeforeRestart.some((event) => event.admission?.attempts_used === 2)).toBe(true);
    const third = await admit(root, home, contract, 'attempt-3', { retry_of: 'attempt-2' });
    const { recordTmuxExternalOperation } = await import('../src/admission.js');
    await recordTmuxExternalOperation(root, home, 'demo-1', 'attempt-3', third.lease_id, 'external-1');
    const beforeResume = (await readTaskEvents(root)).length;
    const resumed = await admitTmux(root, home, 'demo-1', 'attempt-3',
      await withRetryIdentity(root, request(home, contract, { retry_of: 'attempt-3' })), {
        externalOperationId: 'external-1', resumeExternal: true,
      });
    expect(resumed.attempts_used).toBe(3);
    expect((await readTaskEvents(root)).length).toBe(beforeResume);
    const resumeRequest = await withRetryIdentity(root, request(home, contract, { retry_of: 'attempt-3' }));
    await expect(admitTmux(root, home, 'demo-1', 'attempt-3', resumeRequest, { resumeExternal: true }))
      .rejects.toThrow(/operation ID/);
    await expect(admitTmux(root, home, 'demo-1', 'attempt-3', resumeRequest, {
      resumeExternal: true, externalOperationId: 'external-other',
    })).rejects.toThrow(/operation ID/);
    expect((await readTaskEvents(root)).length).toBe(beforeResume);

    await outcome(root, home, 'attempt-3', 'unknown outcome');
    await expect(admit(root, home, contract, 'attempt-4', { retry_of: 'attempt-3' }))
      .rejects.toThrow(/blocked:budget_exhausted/);
    expect((await readTaskEvents(root)).at(-1)?.admission).toMatchObject({
      agent: 'attempt-3', status: 'blocked:budget_exhausted', attempts_used: 3,
    });

    const increased = { ...contract, budget: { ...contract.budget, attempts: 4 } };
    await hubResolve(root, 'demo', 'demo-1', 'rebrief', 'increase the attempt cap');
    await hubLog(root, 'demo-1', 'plan', 'increase the cap', [{ id: 'work', desc: 'bounded work', etaMin: 5 }], undefined, increased);
    await planAnswer(root, 'demo', 'demo-1', 'approve');
    const fourth = await admit(root, home, increased, 'attempt-4', { retry_of: 'attempt-3' });
    expect(fourth).toMatchObject({ attempts_used: 4, lease_epoch: 1, retry_of: 'attempt-3' });
  });
});

describe('worker evidence and cancellation', () => {
  it('binds receipts to the current lease and fences them on root cancel', async () => {
    const { root, home, contract } = await setup();
    await seedTask(root, contract);
    const first = await admit(root, home, contract, 'builder');
    const task = foldTasks(await readTaskEvents(root)).find((candidate) => candidate.id === 'demo-1')!;
    const firstEvidence = await recordTaskEvidence(root, 'demo-1', {
      actor: 'builder', plan_digest: first.plan_digest, epoch: task.lease_epoch!, lease_id: first.lease_id,
      outcome: 'passed', artifact: { diff: 'src/a' }, content: { check: 'diff' },
    });
    await recordTaskReceipt(root, 'demo-1', {
      actor: 'builder', plan_digest: first.plan_digest, epoch: task.lease_epoch!, sequence: 1, lease_id: first.lease_id,
      artifact_digest: firstEvidence.artifact_digest, counters: {}, external_ids: {},
      evidence_hashes: [firstEvidence.evidence_hash], state: 'reconciling',
    });
    await expect(evaluateTaskPredicate(root, 'demo-1', 'task_receipt', {
      plan_digest: first.plan_digest, artifact_digest: firstEvidence.artifact_digest, lease_id: first.lease_id,
    })).resolves.toBe(false);

    const second = await admit(root, home, contract, 'builder', { retry_of: 'builder' });
    await expect(recordTaskEvidence(root, 'demo-1', {
      actor: 'builder', plan_digest: first.plan_digest, epoch: task.lease_epoch!, lease_id: first.lease_id,
      outcome: 'passed', artifact: { diff: 'src/a' }, content: { check: 'late' },
    })).rejects.toThrow(/stale|current/);
    await expect(recordTaskReceipt(root, 'demo-1', {
      actor: 'builder', plan_digest: first.plan_digest, epoch: task.lease_epoch!, sequence: 2, lease_id: first.lease_id,
      artifact_digest: firstEvidence.artifact_digest, counters: {}, external_ids: {},
      evidence_hashes: [firstEvidence.evidence_hash], state: 'reconciling',
    })).rejects.toThrow(/stale|current/);
    const secondEvidence = await recordTaskEvidence(root, 'demo-1', {
      actor: 'builder', plan_digest: second.plan_digest, epoch: task.lease_epoch!, lease_id: second.lease_id,
      outcome: 'passed', artifact: { diff: 'src/a' }, content: { check: 'diff' },
    });
    await recordTaskReceipt(root, 'demo-1', {
      actor: 'builder', plan_digest: second.plan_digest, epoch: task.lease_epoch!, sequence: 2, lease_id: second.lease_id,
      artifact_digest: secondEvidence.artifact_digest, counters: {}, external_ids: {},
      evidence_hashes: [secondEvidence.evidence_hash], state: 'reconciling',
    });

    await hubResolve(root, 'demo', 'demo-1', 'cancel', 'stop the task');
    expect((await readTeam(home)).agents.find((agent) => agent.lease_id === second.lease_id)).toMatchObject({
      lease_revoked: true, admission_status: 'revoked',
    });
    await expect(assertTmuxGrant(root, home, 'demo-1', 'builder', second.lease_id)).rejects.toThrow(/root contract grant|current/);
    await expect(recordTaskEvidence(root, 'demo-1', {
      actor: 'builder', plan_digest: second.plan_digest, epoch: task.lease_epoch!, lease_id: second.lease_id,
      outcome: 'passed', artifact: { diff: 'src/a' }, content: { check: 'late' },
    })).rejects.toThrow(/revoked|already/);
    await expect(evaluateTaskPredicate(root, 'demo-1', 'task_receipt', {
      plan_digest: second.plan_digest, artifact_digest: secondEvidence.artifact_digest, lease_id: second.lease_id,
    })).resolves.toBe(false);
  });

  it.each(
    (['released', 'launch_failed', 'revoked'] as const).flatMap((status) =>
      (['builder', 'legacy', 'orchestrator'] as const).map((agent) => ({ agent, status }))),
  )('refuses omitted worker leases for $agent while active, after $status, and when never admitted', async ({ agent, status }) => {
    const { root, home, contract } = await setup();
    await seedTask(root, contract);
    const admission = await admit(root, home, contract, agent);
    const task = foldTasks(await readTaskEvents(root)).find((candidate) => candidate.id === 'demo-1')!;
    await expect(recordTaskEvidence(root, 'demo-1', {
      actor: agent, plan_digest: admission.plan_digest, epoch: task.lease_epoch!,
      outcome: 'passed', artifact: { diff: 'src/a' }, content: { check: 'missing active lease' },
    })).rejects.toThrow(/lease ID/);
    const evidence = await recordTaskEvidence(root, 'demo-1', {
      actor: agent, plan_digest: admission.plan_digest, epoch: task.lease_epoch!, lease_id: admission.lease_id,
      outcome: 'passed', artifact: { diff: 'src/a' }, content: { check: 'diff' },
    });
    await expect(recordTaskReceipt(root, 'demo-1', {
      actor: agent, plan_digest: admission.plan_digest, epoch: task.lease_epoch!, sequence: 1,
      artifact_digest: evidence.artifact_digest, counters: {}, external_ids: {},
      evidence_hashes: [evidence.evidence_hash], state: 'reconciling',
    })).rejects.toThrow(/lease ID/);
    await recordTaskReceipt(root, 'demo-1', {
      actor: agent, plan_digest: admission.plan_digest, epoch: task.lease_epoch!, sequence: 1,
      lease_id: admission.lease_id, artifact_digest: evidence.artifact_digest,
      counters: {}, external_ids: {}, evidence_hashes: [evidence.evidence_hash], state: 'reconciling',
    });
    await expect(evaluateTaskPredicate(root, 'demo-1', 'task_receipt', {
      plan_digest: admission.plan_digest, artifact_digest: evidence.artifact_digest,
    })).resolves.toBe(false);
    await expect(evaluateTaskPredicate(root, 'demo-1', 'task_receipt', {
      plan_digest: admission.plan_digest, artifact_digest: evidence.artifact_digest, lease_id: admission.lease_id,
    })).resolves.toBe(false);
    await transitionTmuxAdmission(root, home, 'demo-1', agent, admission.lease_id, status);
    await expect(recordTaskEvidence(root, 'demo-1', {
      actor: agent, plan_digest: admission.plan_digest, epoch: task.lease_epoch!,
      outcome: 'passed', artifact: { diff: 'src/a' }, content: { check: 'late' },
    })).rejects.toThrow(/lease ID|revoked|already/);
    await expect(recordTaskReceipt(root, 'demo-1', {
      actor: agent, plan_digest: admission.plan_digest, epoch: task.lease_epoch!, sequence: 2,
      artifact_digest: evidence.artifact_digest, counters: {}, external_ids: {},
      evidence_hashes: [evidence.evidence_hash], state: 'reconciling',
    })).rejects.toThrow(/lease ID|revoked|already/);
    await expect(evaluateTaskPredicate(root, 'demo-1', 'task_receipt', {
      plan_digest: admission.plan_digest, artifact_digest: evidence.artifact_digest,
    })).resolves.toBe(false);

    const never = await setup();
    await seedTask(never.root, never.contract);
    await expect(recordTaskEvidence(never.root, 'demo-1', {
      actor: `agent:${agent}`, plan_digest: contractDigest(never.contract), epoch: 1,
      outcome: 'passed', artifact: { diff: 'src/a' }, content: { check: 'never admitted' },
    })).rejects.toThrow(/lease ID/);
  });

  it.each([
    ['builder', 'agent:builder'],
    ['agent:builder', 'builder'],
  ])('accepts canonical actor alias %s → %s with one current lease', async (evidenceActor, receiptActor) => {
    const { root, home, contract } = await setup();
    await seedTask(root, contract);
    const admission = await admit(root, home, contract, 'builder');
    const task = foldTasks(await readTaskEvents(root)).find((candidate) => candidate.id === 'demo-1')!;
    const evidence = await recordTaskEvidence(root, 'demo-1', {
      actor: evidenceActor, plan_digest: admission.plan_digest, epoch: task.lease_epoch!, lease_id: admission.lease_id,
      outcome: 'passed', artifact: { diff: 'src/a' }, content: { check: 'diff' },
    });
    await recordTaskReceipt(root, 'demo-1', {
      actor: receiptActor, plan_digest: admission.plan_digest, epoch: task.lease_epoch!, sequence: 1,
      lease_id: admission.lease_id, artifact_digest: evidence.artifact_digest,
      counters: {}, external_ids: {}, evidence_hashes: [evidence.evidence_hash], state: 'reconciling',
    });
    await expect(evaluateTaskPredicate(root, 'demo-1', 'task_receipt', {
      plan_digest: admission.plan_digest, artifact_digest: evidence.artifact_digest, lease_id: admission.lease_id,
    })).resolves.toBe(false);
  });

  it('keeps the lease-less fallback for a genuinely unadmitted legacy actor', async () => {
    const { root, contract } = await setup();
    await seedTask(root, contract);
    const task = foldTasks(await readTaskEvents(root)).find((candidate) => candidate.id === 'demo-1')!;
    const evidence = await recordTaskEvidence(root, 'demo-1', {
      actor: 'legacy', plan_digest: task.plan_digest!, epoch: task.lease_epoch!,
      outcome: 'passed', artifact: { diff: 'src/a' }, content: { check: 'legacy' },
    });
    await recordTaskReceipt(root, 'demo-1', {
      actor: 'legacy', plan_digest: task.plan_digest!, epoch: task.lease_epoch!, sequence: 1,
      artifact_digest: evidence.artifact_digest, counters: {}, external_ids: {},
      evidence_hashes: [evidence.evidence_hash], state: 'reconciling',
    });
    await expect(evaluateTaskPredicate(root, 'demo-1', 'task_receipt', {
      plan_digest: task.plan_digest!, artifact_digest: evidence.artifact_digest,
    })).resolves.toBe(false);
  });
});

describe('native admission leases', () => {
  async function nativeFixture(contractChanges: Partial<RootContract> = {}) {
    const fixture = await setup({
      write_scope: ['src'],
      budget: { depth: 2, active_children: 4, active_project_records: 4, attempts: 3 },
      delegation: {
        output_claims: [OUTPUT, 'Review the bounded change.', 'Inspect another allocation.'],
        adapters: ['tmux', 'native'],
      },
      ...contractChanges,
    });
    await seedTask(fixture.root, fixture.contract);
    const parent = await admit(fixture.root, fixture.home, fixture.contract, 'builder');
    const nativeRequest = request(fixture.home, fixture.contract, {
      output_claim: 'Review the bounded change.', write_scope: [], adapter: 'native',
      parent_lease_id: parent.lease_id, budget: { depth: 2, attempts: fixture.contract.budget.attempts },
    });
    return { ...fixture, parent, nativeRequest };
  }

  it('persists an epoch-1 read lease without adding a team worker and allows writer overlap', async () => {
    const { root, home, parent, nativeRequest } = await nativeFixture();
    const native = await admitNative(root, home, 'demo-1', 'native-branch-1', nativeRequest);
    expect(native).toMatchObject({
      adapter: 'native', parent_lease_id: parent.lease_id, lease_epoch: 1,
      depth: 2, write_scope: [], attempts_used: 1, status: 'admitted',
    });
    expect((await readTeam(home)).agents.filter((agent) => !agent.orchestrator)).toHaveLength(1);
    await expect(admitNative(root, home, 'demo-1', 'native-branch-2', {
      ...nativeRequest, output_claim: 'Inspect another allocation.',
    })).resolves.toMatchObject({ depth: 2, write_scope: [] });
  });

  it('shares dedup and parent and project budget predicates with tmux', async () => {
    const { root, home, nativeRequest } = await nativeFixture({
      budget: { depth: 2, active_children: 2, active_project_records: 2, attempts: 3 },
    });
    await admitNative(root, home, 'demo-1', 'native-branch-1', nativeRequest);
    await expect(admitNative(root, home, 'demo-1', 'native-branch-duplicate', nativeRequest))
      .rejects.toThrow(/duplicate/);
    await expect(admitNative(root, home, 'demo-1', 'native-branch-2', {
      ...nativeRequest, output_claim: 'Inspect another allocation.',
    })).rejects.toThrow(/active children|active project|budget/);
  });

  it('rejects writable scope and excess depth without a reservation', async () => {
    const { root, home, nativeRequest } = await nativeFixture({
      budget: { depth: 1, active_children: 4, active_project_records: 4, attempts: 3 },
    });
    await expect(admitNative(root, home, 'demo-1', 'native-branch-write', {
      ...nativeRequest, write_scope: ['src'], budget: { depth: 1, attempts: 3 },
    })).rejects.toThrow(/read.only|writable|write scope/i);
    await expect(admitNative(root, home, 'demo-1', 'native-branch-depth', nativeRequest))
      .rejects.toThrow(/depth|budget/);
    const task = foldTasks(await readTaskEvents(root)).find((candidate) => candidate.id === 'demo-1')!;
    expect(task.admissions?.filter((admission) => admission.adapter === 'native')).toHaveLength(0);
  });

  it('accumulates native replacement attempts on the same lineage', async () => {
    const { root, home, contract, nativeRequest } = await nativeFixture({
      budget: { depth: 2, active_children: 4, active_project_records: 4, attempts: 2 },
    });
    const first = await admitNative(root, home, 'demo-1', 'native-branch-1', nativeRequest);
    await transitionTmuxAdmission(root, home, 'demo-1', first.agent, first.lease_id, 'failed', 'retry native');
    const second = await admitNative(root, home, 'demo-1', 'native-branch-1', await withRetryIdentity(root, {
      ...nativeRequest, retry_of: first.agent,
    }));
    expect(second).toMatchObject({ attempts_used: 2, lineage_id: first.lineage_id, lease_epoch: 1 });
    await transitionTmuxAdmission(root, home, 'demo-1', second.agent, second.lease_id, 'failed', 'retry native again');
    await expect(admitNative(root, home, 'demo-1', 'native-branch-1', await withRetryIdentity(root, {
      ...nativeRequest, retry_of: second.agent,
    }))).rejects.toThrow(/blocked:budget_exhausted/);
    expect(contract.budget.attempts).toBe(2);
  });
});

describe('research provenance and root wall budgets', () => {
  it('admits research with source and evidence ranges and no Git revisions', async () => {
    const digest = 'a'.repeat(64);
    const fixture = await setup({
      kind: 'research',
      acceptance: [{
        id: 'diff', predicate_id: 'task_receipt', version: 1,
        configuration: { output_claim: OUTPUT, artifact_path: 'src/result.md', artifact_digest: digest },
        required_evidence: ['server-read-artifact'],
      }],
      provenance: {
        kind: 'research',
        source_range: {
          start: 'session:first', end: 'session:first',
          sources: [{
            id: 'session:first', path: 'src/result.md',
            sha256: createHash('sha256').update('research\n').digest('hex'),
            observed_at: '2026-11-20T12:00:00.000Z',
          }],
        },
        evidence_window: { starts_at: '2026-11-20T00:00:00.000Z', ends_at: '2026-11-21T00:00:00.000Z' },
      },
    });
    await fs.mkdir(path.join(fixture.home, 'src'), { recursive: true });
    await fs.writeFile(path.join(fixture.home, 'src', 'result.md'), 'research\n');
    await seedTask(fixture.root, fixture.contract);
    const admitted = await admit(fixture.root, fixture.home, fixture.contract, 'researcher', {
      write_scope: ['src'],
    });
    expect(admitted).toMatchObject({ repository_root: fixture.home, status: 'admitted' });
    expect(admitted.provenance).toEqual(fixture.contract.provenance);
    expect(admitted.provenance.repository).toBeUndefined();
    expect(admitted.provenance.base_revision).toBeUndefined();
    expect(admitted.provenance.artifact_revision).toBeUndefined();
  });

  it('expires writers once and extends only by root delta without resetting attempts', async () => {
    const fixture = await setup({
      budget: { depth: 1, active_children: 4, active_project_records: 4, attempts: 3, wall_seconds: 60 },
    });
    await seedTask(fixture.root, fixture.contract);
    const admitted = await admit(fixture.root, fixture.home, fixture.contract, 'builder');
    const before = foldTasks(await readTaskEvents(fixture.root)).find((task) => task.id === 'demo-1')!;
    const expiry = Date.parse(before.expires_at!);
    expect(expiry).toBe(Date.parse(before.admitted_at!) + 60_000);
    const expired = expiry + 1;
    await reconcileTaskBudgets(fixture.root, expired);
    await reconcileTaskBudgets(fixture.root, expired);
    const blocked = foldTasks(await readTaskEvents(fixture.root)).find((task) => task.id === 'demo-1')!;
    expect(blocked).toMatchObject({ state: 'blocked:budget_exhausted', lease_revoked: true });
    expect((await readTaskEvents(fixture.root)).filter((event) => event.note === 'blocked:budget_exhausted')).toHaveLength(1);
    expect((await readTeam(fixture.home)).agents.find((agent) => agent.lease_id === admitted.lease_id))
      .toMatchObject({ lease_revoked: true, admission_status: 'revoked' });
    await expect(assertTmuxGrant(fixture.root, fixture.home, 'demo-1', 'builder', admitted.lease_id))
      .rejects.toThrow(/budget|grant|revoked/);
    await expect(admitTmux(fixture.root, fixture.home, 'demo-1', 'other', request(fixture.home, fixture.contract), {
      now: expired,
    })).rejects.toThrow(/budget|grant/);
    const beforeProgress = await readTaskEvents(fixture.root);
    await expect(hubProgress(fixture.root, 'demo-1', 'work', 'started')).rejects.toThrow(/budget/);
    const { handleTaskAction } = await import('../web/taskactions.js');
    await expect(handleTaskAction(fixture.root, 'demo', '/api/progress', {
      task: 'demo-1', checkpoint: 'work', status: 'started',
    })).rejects.toThrow(/budget/);
    expect(await readTaskEvents(fixture.root)).toEqual(beforeProgress);

    const nextContract = {
      ...fixture.contract,
      budget: { ...fixture.contract.budget, wall_seconds: 120 },
    };
    await withHubLock(fixture.root, () => applyRootDeltaLocked(
      fixture.root, fixture.home, 'demo-1', nextContract, contractDigest(fixture.contract), 1,
    ));
    const replacement = await admit(fixture.root, fixture.home, nextContract, 'builder-replacement', {
      retry_of: 'builder',
    });
    expect(replacement.attempts_used).toBe(2);
    const extended = foldTasks(await readTaskEvents(fixture.root)).find((task) => task.id === 'demo-1')!;
    expect(Date.parse(extended.expires_at!)).toBe(Date.parse(before.admitted_at!) + 120_000);
    expect(extended.state).not.toBe('blocked:budget_exhausted');
  });
});
