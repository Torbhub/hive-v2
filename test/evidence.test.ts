import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPERATION_REGISTRY, PREDICATE_REGISTRY } from '../src/evidence.js';
import { pushByHash } from '../src/gate.js';
import {
  evaluateTaskPredicate, listTasks, reconcileBlockedTasks, recordHumanAcceptance, recordTaskEvidence, recordTaskOutcome,
  recordTaskReceipt, TASK_PREDICATES,
} from '../src/hub.js';
import {
  appendTaskEvent, contractDigest, foldTasks, hivePath, readTaskEvents, taskEvidenceDigests, valueDigest,
  writeJson, writeProjects,
} from '../src/state.js';
import type {
  HubTask, NativeBranchClient, NativeBranchRecord, NativeMessage, NativeSession, RootContract,
  TaskAcceptance, TaskEvidenceOutcome, TaskOperation, TaskOutcome, TmuxAdmission,
} from '../src/types.js';

const CHECKPOINTS = [{ id: 'work', desc: 'bounded work', etaMin: 5 }];
const ARTIFACT = { diff: 'src/a.ts' };
const CONTENT = { check: 'unit', status: 'passed' };
const DIGESTS = taskEvidenceDigests(ARTIFACT, CONTENT);

afterEach(() => vi.restoreAllMocks());

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

function outputAcceptance(artifactDigest: string, artifactPath = 'src/a.ts'): TaskAcceptance {
  return {
    id: 'receipt', predicate_id: 'task_receipt', version: 1,
    configuration: {
      output_claim: 'a bounded diff', artifact_path: artifactPath, artifact_digest: artifactDigest,
    },
    required_evidence: ['server-read-artifact'],
  };
}

function diffAcceptance(): TaskAcceptance {
  return { id: 'diff', predicate_id: 'git_diff_scope', version: 1, configuration: {}, required_evidence: ['diff'] };
}

async function setup(options: {
  acceptance?: TaskAcceptance[]; writer?: boolean; requiredChildren?: string[]; currentBase?: boolean; native?: boolean;
  research?: boolean;
  researchSource?: { id: string; path: string; sha256: string; observed_at: string };
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
    deliverable: 'a bounded diff', kind: options.research ? 'research' : 'build',
    acceptance: options.acceptance ?? [receiptAcceptance()],
    provenance: options.research ? {
      kind: 'research',
      source_range: {
        start: options.researchSource?.id ?? 'session:start', end: options.researchSource?.id ?? 'session:end',
        sources: options.researchSource ? [options.researchSource] : [
          {
            id: 'session:start', path: 'src/a.ts', sha256: createHash('sha256').update('artifact\n').digest('hex'),
            observed_at: '2026-11-20T11:00:00.000Z',
          },
          {
            id: 'session:end', path: 'src/a.ts', sha256: createHash('sha256').update('artifact\n').digest('hex'),
            observed_at: '2026-11-20T12:00:00.000Z',
          },
        ],
      },
      evidence_window: { starts_at: '2026-11-20T00:00:00.000Z', ends_at: '2026-11-21T00:00:00.000Z' },
    } : { repository: home, base_revision: base, artifact_revision: options.currentBase ? base : artifact },
    write_scope: ['src'], action_scope: ['push'],
    budget: { depth: options.native ? 2 : 1, active_children: 8, active_project_records: 16, attempts: 3 },
    delegation: options.native
      ? { output_claims: ['a bounded diff', 'a native review'], adapters: ['tmux', 'native'] }
      : { output_claims: ['a bounded diff'], adapters: ['tmux'] },
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
    if (task.contract.provenance.kind === 'research') throw new Error('code fixture required');
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

async function recordDone(root: string, writer = false, native?: NativeBranchClient) {
  const task = await currentTask(root);
  return recordTaskOutcome(root, task.id, 'done', outcomeBinding(task, writer), { native });
}

async function declareOutput(root: string, artifactDigest: string, artifactPath = 'src/a.ts') {
  const task = await currentTask(root);
  await recordTaskReceipt(root, task.id, {
    actor: 'agent:builder', plan_digest: task.plan_digest!, epoch: task.lease_epoch!,
    sequence: (task.last_receipt_sequence ?? 0) + 1, lease_id: 'lease-1', artifact_digest: artifactDigest,
    counters: {}, external_ids: {}, evidence_hashes: [], state: 'reconciling',
    output_claim: 'a bounded diff', artifact_path: artifactPath,
  });
  return {
    plan_digest: task.plan_digest!, lease_id: 'lease-1', artifact_digest: artifactDigest,
    output_claim: 'a bounded diff', artifact_path: artifactPath,
  };
}

async function pendingOperation(root: string): Promise<TaskOperation> {
  const task = await currentTask(root);
  return {
    operation_id: 'push-1', idempotency_key: 'key-1', kind: 'push', actor: 'legacy',
    plan_digest: task.plan_digest!, epoch: task.lease_epoch!, repository_fingerprint: 'repo', commit: 'a'.repeat(40),
    branch: 'feat/evidence', status: 'pending', updated_at: new Date().toISOString(),
  };
}

const NATIVE_BRANCH_ID = '7ca3c50b-8304-45f0-a925-f41d10a14cf2';
const NATIVE_LEASE_ID = 'native-lease-1';

function nativeSha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function nativeSnapshot(id: string, contentHash: string) {
  const messages = [{ id, contentHash }];
  return { count: 1, headId: id, historyHash: nativeSha(messages), messages };
}

function nativeMessage(id: string, sessionId: string, role: string, content: unknown): NativeMessage {
  return {
    id, session_id: sessionId, role, content: [{ type: 'text', text: String(content) }],
    created_at: '2026-11-20T12:00:00.000Z',
  };
}

async function nativeFixture(acceptance?: TaskAcceptance[], acceptanceIds = ['native']) {
  const defaultAcceptance: TaskAcceptance = {
    id: 'native', predicate_id: 'native_result', version: 1, configuration: {}, required_evidence: ['native-result'],
  };
  const fixture = await setup({ acceptance: acceptance ?? [defaultAcceptance], writer: true, native: true });
  const parentMessage = nativeMessage('msg_parent', 'session_parent', 'user', 'parent history');
  const findingContent = {
    answer: 'The native result is bounded.',
    recommendation: 'Use the verified result.',
    uncertainty: 'No further native claim is made.',
  };
  const resultMessage = nativeMessage('msg_child_result', 'session_child', 'assistant', JSON.stringify({
    schemaVersion: 1, branchId: NATIVE_BRANCH_ID, findings: [findingContent],
  }));
  const resultMessageHash = nativeSha(resultMessage.content);
  const childSnapshot = nativeSnapshot(resultMessage.id, resultMessageHash);
  const finding = {
    ...findingContent,
    nativeEvidence: [{ messageId: resultMessage.id, contentHash: resultMessageHash }],
  };
  const findingWithId = { id: `f_${nativeSha({ branchId: NATIVE_BRANCH_ID, ...finding })}`, ...finding };
  const result = {
    schemaVersion: 1 as const, branchId: NATIVE_BRANCH_ID, childHistoryHash: childSnapshot.historyHash,
    findings: [findingWithId],
  };
  const branch: NativeBranchRecord = {
    schemaVersion: 1, id: NATIVE_BRANCH_ID, kind: 'child', purpose: 'Review native evidence',
    parentSessionId: 'session_parent', childSessionId: 'session_child', workspaceId: 'workspace', cwd: fixture.home,
    scope: { project: 'demo', agent: 'builder', task: 'demo-1' },
    parentSnapshot: nativeSnapshot(parentMessage.id, nativeSha(parentMessage.content)), childSnapshot,
    status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    leaseId: NATIVE_LEASE_ID,
    result: {
      ...result, digest: nativeSha(result), recordedAt: new Date().toISOString(), resultMessageId: resultMessage.id,
    },
  };
  await writeJson(hivePath(fixture.home, 'branches', `${NATIVE_BRANCH_ID}.json`), branch);
  const team = JSON.parse(await readFile(hivePath(fixture.home, 'team.json'), 'utf8')) as {
    agents: Record<string, unknown>[];
  };
  await writeJson(hivePath(fixture.home, 'team.json'), {
    agents: team.agents.map((agent) => agent.name === 'builder' ? { ...agent, session_id: 'session_parent', depth: 1 } : agent),
  });
  const nativeAdmission: TmuxAdmission = {
    task: 'demo-1', project: 'demo', agent: NATIVE_BRANCH_ID, parent_id: 'demo-1', plan_digest: fixture.planDigest,
    root_lease_epoch: 1, lease_id: NATIVE_LEASE_ID, lease_epoch: 1, lease_revoked: false,
    output_claim: 'a native review', acceptance_ids: acceptanceIds, provenance: { ...fixture.contract.provenance },
    provenance_digest: valueDigest(fixture.contract.provenance), write_scope: [], adapter: 'native',
    parent_lease_id: 'lease-1', depth: 2, lineage_id: NATIVE_BRANCH_ID, attempts_used: 1, status: 'admitted',
  };
  await appendTaskEvent(fixture.root, {
    id: 'demo-1', project: 'demo', event: 'admission', at: new Date().toISOString(), admission: nativeAdmission,
  });
  const histories = new Map<string, NativeMessage[]>([
    ['session_parent', [parentMessage]],
    ['session_child', [resultMessage]],
  ]);
  const sessions: Record<string, NativeSession> = {
    session_parent: {
      id: 'session_parent', workspace_id: 'workspace', metadata: { cwd: fixture.home },
    },
    session_child: {
      id: 'session_child', workspace_id: 'workspace',
      read_only: {
        filesystem: 'read-only', shell: 'denied', side_effects: 'denied', tools: ['Read', 'Grep', 'Glob'],
      } as const,
      metadata: {
        cwd: fixture.home, hive_branch_id: NATIVE_BRANCH_ID,
        parent_session_id: 'session_parent', child_session_kind: 'child',
      },
    },
  };
  const native: NativeBranchClient & {
    histories: Map<string, NativeMessage[]>; sessions: Record<string, NativeSession>;
  } = {
    histories,
    sessions,
    async getSession(sessionId) {
      const session = sessions[sessionId];
      if (!session) throw new Error('native session missing');
      return session;
    },
    async listMessages(sessionId, options = {}) {
      const history = histories.get(sessionId) ?? [];
      const start = options.beforeId ? history.findIndex((entry) => entry.id === options.beforeId) + 1 : 0;
      const pageSize = options.pageSize ?? 50;
      return { items: history.slice(start, start + pageSize), has_more: start + pageSize < history.length };
    },
    async createChild() { throw new Error('unexpected createChild'); },
    async forkSession() { throw new Error('unexpected forkSession'); },
    async listChildren() { return { items: [], has_more: false }; },
    async submitPrompt() { throw new Error('unexpected submitPrompt'); },
  };
  return { ...fixture, branch, nativeAdmission, native };
}

async function addNativeResult(
  fixture: Awaited<ReturnType<typeof nativeFixture>>, branchId: string, leaseId: string, acceptanceIds: string[],
) {
  const source = fixture.branch.result!.findings[0];
  const findingContent = {
    answer: source.answer, recommendation: source.recommendation, uncertainty: source.uncertainty,
  };
  const sessionId = `session_child_${leaseId}`;
  const resultMessage = nativeMessage(`msg_child_result_${leaseId}`, sessionId, 'assistant', JSON.stringify({
    schemaVersion: 1, branchId, findings: [findingContent],
  }));
  const resultMessageHash = nativeSha(resultMessage.content);
  const childSnapshot = nativeSnapshot(resultMessage.id, resultMessageHash);
  const finding = {
    ...findingContent,
    nativeEvidence: [{ messageId: resultMessage.id, contentHash: resultMessageHash }],
  };
  const findingWithId = { id: `f_${nativeSha({ branchId, ...finding })}`, ...finding };
  const result = {
    schemaVersion: 1 as const, branchId, childHistoryHash: childSnapshot.historyHash, findings: [findingWithId],
  };
  const branch: NativeBranchRecord = {
    ...fixture.branch,
    id: branchId,
    childSessionId: sessionId,
    leaseId,
    childSnapshot,
    result: {
      ...result, digest: nativeSha(result), recordedAt: fixture.branch.result!.recordedAt,
      resultMessageId: resultMessage.id,
    },
  };
  const admission: TmuxAdmission = {
    ...fixture.nativeAdmission,
    agent: branchId,
    lease_id: leaseId,
    acceptance_ids: acceptanceIds,
    lineage_id: branchId,
  };
  await writeJson(hivePath(fixture.home, 'branches', `${branchId}.json`), branch);
  fixture.native.histories.set(sessionId, [resultMessage]);
  fixture.native.sessions[sessionId] = {
    ...fixture.native.sessions.session_child,
    id: sessionId,
    metadata: { ...fixture.native.sessions.session_child.metadata, hive_branch_id: branchId },
  };
  await appendTaskEvent(fixture.root, {
    id: 'demo-1', project: 'demo', event: 'admission', at: new Date().toISOString(), admission,
  });
  return { branch, admission };
}

function nativeConfig(branch: NativeBranchRecord, planDigest: string) {
  return { lease_id: NATIVE_LEASE_ID, plan_digest: planDigest, artifact_digest: branch.result!.digest };
}

async function evaluateNative(fixture: Awaited<ReturnType<typeof nativeFixture>>, config: Parameters<typeof evaluateTaskPredicate>[3]) {
  return evaluateTaskPredicate(fixture.root, 'demo-1', 'native_result', config, 1, fixture.native);
}

describe('native result evidence', () => {
  it('registers verified result evidence once and reconciles the parent outcome', async () => {
    const fixture = await nativeFixture();
    const { root, home, branch, planDigest } = fixture;
    const config = nativeConfig(branch, planDigest);
    await expect(evaluateNative(fixture, config)).resolves.toBe(true);
    const events = await readTaskEvents(root);
    const evidence = events.findLast((event) => event.event === 'evidence')?.evidence;
    expect(evidence).toMatchObject({
      lease_id: NATIVE_LEASE_ID, artifact_digest: branch.result!.digest, outcome: 'passed',
      verification: { adapter_id: 'native_result', evidence_type: 'native_result' },
    });
    await expect(evaluateNative(fixture, config)).resolves.toBe(true);
    expect((await readTaskEvents(root)).filter((event) => event.event === 'evidence')).toHaveLength(1);
    await expect(recordDone(root)).rejects.toThrow(/writer/);
    const { transitionTmuxAdmission } = await import('../src/admission.js');
    await transitionTmuxAdmission(root, home, 'demo-1', NATIVE_BRANCH_ID, NATIVE_LEASE_ID, 'released');
    await transitionTmuxAdmission(root, home, 'demo-1', 'builder', 'lease-1', 'released');
    await recordDone(root, false, fixture.native);
    expect((await currentTask(root)).state).toBe('done');
  });

  it('rejects missing, stale, wrong-plan, and wrong-artifact results', async () => {
    const missing = await nativeFixture();
    const { result: _result, ...withoutResult } = missing.branch;
    await writeJson(hivePath(missing.home, 'branches', `${NATIVE_BRANCH_ID}.json`), withoutResult);
    await expect(evaluateNative(missing, nativeConfig(missing.branch, missing.planDigest))).resolves.toBe(false);

    const stale = await nativeFixture();
    await writeJson(hivePath(stale.home, 'branches', `${NATIVE_BRANCH_ID}.json`), { ...stale.branch, status: 'stale' });
    await expect(evaluateNative(stale, nativeConfig(stale.branch, stale.planDigest))).resolves.toBe(false);
    await expect(evaluateNative(stale, {
      ...nativeConfig(stale.branch, stale.planDigest), plan_digest: 'f'.repeat(64),
    })).resolves.toBe(false);
    await expect(evaluateNative(stale, {
      ...nativeConfig(stale.branch, stale.planDigest), artifact_digest: '0'.repeat(64),
    })).resolves.toBe(false);
  });

  it('rejects recomputed but unverified finding evidence content hashes', async () => {
    const fixture = await nativeFixture();
    const finding = {
      ...fixture.branch.result!.findings[0],
      nativeEvidence: [{ messageId: 'msg_child', contentHash: '0'.repeat(64) }],
    };
    const findingWithId = {
      ...finding,
      id: `f_${nativeSha({ branchId: NATIVE_BRANCH_ID, answer: finding.answer, recommendation: finding.recommendation,
        uncertainty: finding.uncertainty, nativeEvidence: finding.nativeEvidence })}`,
    };
    const result = {
      schemaVersion: 1 as const, branchId: NATIVE_BRANCH_ID,
      childHistoryHash: fixture.branch.childSnapshot!.historyHash, findings: [findingWithId],
    };
    const changed = {
      ...fixture.branch,
      result: { ...result, digest: nativeSha(result), recordedAt: fixture.branch.result!.recordedAt },
    };
    await writeJson(hivePath(fixture.home, 'branches', `${NATIVE_BRANCH_ID}.json`), changed);
    await expect(evaluateNative(fixture, nativeConfig(changed, fixture.planDigest))).resolves.toBe(false);
    expect((await readTaskEvents(fixture.root)).some((event) => event.event === 'evidence')).toBe(false);
  });

  it('evaluates every allocated admission without weakening explicit selectors', async () => {
    const released = await nativeFixture();
    await appendTaskEvent(released.root, {
      id: 'demo-1', project: 'demo', event: 'admission', at: new Date().toISOString(),
      admission: {
        ...released.nativeAdmission, lease_id: 'failed-a', agent: 'failed-a', status: 'failed', lease_revoked: true,
      },
    });
    const { transitionTmuxAdmission } = await import('../src/admission.js');
    await transitionTmuxAdmission(released.root, released.home, 'demo-1', NATIVE_BRANCH_ID, NATIVE_LEASE_ID, 'released');
    await transitionTmuxAdmission(released.root, released.home, 'demo-1', 'builder', 'lease-1', 'released');
    const config = { plan_digest: released.planDigest, artifact_digest: released.branch.result!.digest };
    await expect(evaluateNative(released, config)).resolves.toBe(true);
    await expect(evaluateNative(released, config)).resolves.toBe(true);
    expect((await readTaskEvents(released.root)).filter((event) => event.event === 'evidence')).toHaveLength(1);
    await expect(evaluateNative(released, { ...config, lease_id: 'failed-a' })).resolves.toBe(false);
    await recordDone(released.root, false, released.native);
    expect((await currentTask(released.root)).state).toBe('done');

    const failed = await nativeFixture();
    await transitionTmuxAdmission(failed.root, failed.home, 'demo-1', NATIVE_BRANCH_ID, NATIVE_LEASE_ID, 'released');
    await appendTaskEvent(failed.root, {
      id: 'demo-1', project: 'demo', event: 'admission', at: new Date().toISOString(),
      admission: {
        ...failed.nativeAdmission, lease_id: 'failed-b', agent: 'failed-b', status: 'failed', lease_revoked: true,
      },
    });
    await transitionTmuxAdmission(failed.root, failed.home, 'demo-1', 'builder', 'lease-1', 'released');
    await expect(evaluateNative(failed, {
      plan_digest: failed.planDigest, artifact_digest: failed.branch.result!.digest,
    })).resolves.toBe(true);
    await recordDone(failed.root, false, failed.native);
    expect((await currentTask(failed.root)).state).toBe('done');

    const invalid = await nativeFixture();
    await transitionTmuxAdmission(invalid.root, invalid.home, 'demo-1', NATIVE_BRANCH_ID, NATIVE_LEASE_ID, 'failed', 'invalid');
    await expect(evaluateNative(invalid, {
      plan_digest: invalid.planDigest, artifact_digest: invalid.branch.result!.digest,
    })).resolves.toBe(false);
    await expect(recordDone(invalid.root, false, invalid.native)).rejects.toThrow(/registered acceptance|writer/);
  });

  it('scopes every candidate to the current acceptance allocation', async () => {
    const acceptance: TaskAcceptance[] = [
      { id: 'native-a', predicate_id: 'native_result', version: 1, configuration: {}, required_evidence: ['native-a'] },
      { id: 'native-b', predicate_id: 'native_result', version: 1, configuration: {}, required_evidence: ['native-b'] },
    ];
    const fixture = await nativeFixture(acceptance, ['native-a']);
    const other = await addNativeResult(fixture, 'f19d0d09-e682-47d8-a91c-e542a52c8984', 'native-lease-b', ['native-b']);
    const configA = { plan_digest: fixture.planDigest, acceptance_id: 'native-a' };
    const configB = { plan_digest: fixture.planDigest, acceptance_id: 'native-b' };
    await expect(evaluateNative(fixture, configA)).resolves.toBe(true);
    await expect(evaluateNative(fixture, configB)).resolves.toBe(true);
    expect((await readTaskEvents(fixture.root)).filter((event) => event.event === 'evidence')).toHaveLength(2);

    const { transitionTmuxAdmission } = await import('../src/admission.js');
    await transitionTmuxAdmission(fixture.root, fixture.home, 'demo-1', other.branch.id, other.admission.lease_id, 'failed', 'invalid B');
    await expect(evaluateNative(fixture, configB)).resolves.toBe(false);
    await expect(evaluateNative(fixture, configA)).resolves.toBe(true);

    await appendTaskEvent(fixture.root, {
      id: 'demo-1', project: 'demo', event: 'admission', at: new Date().toISOString(),
      admission: { ...fixture.nativeAdmission, acceptance_ids: ['native-a', 'native-b'] },
    });
    await expect(evaluateNative(fixture, configB)).resolves.toBe(true);
    expect((await readTaskEvents(fixture.root)).filter((event) => event.event === 'evidence')).toHaveLength(2);
  });

  it.each(['session_child', 'session_parent'])('rejects cached evidence after %s advances without refresh', async (sessionId) => {
    const fixture = await nativeFixture();
    const config = nativeConfig(fixture.branch, fixture.planDigest);
    await expect(evaluateNative(fixture, config)).resolves.toBe(true);
    fixture.native.histories.set(sessionId, [
      nativeMessage('msg_late', sessionId, 'user', 'late native history'),
      ...fixture.native.histories.get(sessionId)!,
    ]);
    await expect(evaluateNative(fixture, config)).resolves.toBe(false);
    const { transitionTmuxAdmission } = await import('../src/admission.js');
    await transitionTmuxAdmission(fixture.root, fixture.home, 'demo-1', NATIVE_BRANCH_ID, NATIVE_LEASE_ID, 'released');
    await transitionTmuxAdmission(fixture.root, fixture.home, 'demo-1', 'builder', 'lease-1', 'released');
    await expect(recordDone(fixture.root, false, fixture.native)).rejects.toThrow(/registered acceptance/);
    expect((await readTaskEvents(fixture.root)).filter((event) => event.event === 'evidence')).toHaveLength(1);
  });

  it('allows only the exact rejoin acknowledgement after the parent snapshot', async () => {
    const fixture = await nativeFixture();
    const finding = fixture.branch.result!.findings[0];
    const reviewBase = {
      branchId: NATIVE_BRANCH_ID,
      findingIds: [finding.id],
      parentHistoryHash: fixture.branch.parentSnapshot.historyHash,
      childHistoryHash: fixture.branch.childSnapshot!.historyHash,
      reviewer: 'user:alice',
      consumerGrantId: 'agent-grant',
      consumerAclEpoch: 1,
      approverGrantId: 'human-grant',
      approverAclEpoch: 1,
      createdAt: '2026-11-20T12:00:00.000Z',
      expiresAt: '2026-11-20T12:15:00.000Z',
    };
    const review = { ...reviewBase, digest: nativeSha(reviewBase) };
    const promptId = `hive-rejoin-${NATIVE_BRANCH_ID}-${review.digest.slice(0, 16)}`;
    const prompt = JSON.stringify({
      kind: 'hive.native-branch.reviewed-findings', untrusted: true, branchId: NATIVE_BRANCH_ID,
      reviewDigest: review.digest, promptId,
      findings: [{
        id: finding.id, answer: finding.answer, recommendation: finding.recommendation, uncertainty: finding.uncertainty,
      }],
    });
    const rejoined = {
      ...fixture.branch,
      status: 'rejoined' as const,
      review,
      rejoin: {
        status: 'rejoined' as const, reviewDigest: review.digest, promptId, promptHash: nativeSha(prompt),
        intentAt: '2026-11-20T12:00:00.000Z', nativeMessageId: 'msg_rejoin', rejoinedAt: '2026-11-20T12:01:00.000Z',
      },
    };
    await writeJson(hivePath(fixture.home, 'branches', `${NATIVE_BRANCH_ID}.json`), rejoined);
    fixture.native.histories.set('session_parent', [
      nativeMessage('msg_rejoin', 'session_parent', 'user', prompt),
      ...fixture.native.histories.get('session_parent')!,
    ]);
    const { transitionTmuxAdmission } = await import('../src/admission.js');
    await transitionTmuxAdmission(fixture.root, fixture.home, 'demo-1', NATIVE_BRANCH_ID, NATIVE_LEASE_ID, 'released');
    await transitionTmuxAdmission(fixture.root, fixture.home, 'demo-1', 'builder', 'lease-1', 'released');
    await expect(evaluateNative(fixture, nativeConfig(rejoined, fixture.planDigest))).resolves.toBe(true);
    fixture.native.histories.set('session_parent', [
      nativeMessage('msg_other_parent_work', 'session_parent', 'user', 'other parent work'),
      ...fixture.native.histories.get('session_parent')!,
    ]);
    await expect(evaluateNative(fixture, nativeConfig(rejoined, fixture.planDigest))).resolves.toBe(false);
  });
});

describe('registered blocked resume conditions', () => {
  async function gitReceipt(root: string, state: 'running' | 'reconciling') {
    const task = await currentTask(root);
    if (task.contract!.provenance.kind === 'research') throw new Error('code fixture required');
    const evidence = await recordTaskEvidence(root, task.id, {
      actor: 'agent:builder', plan_digest: task.plan_digest!, epoch: task.lease_epoch!,
      outcome: 'passed', lease_id: 'lease-1', artifact: ARTIFACT, content: CONTENT,
    });
    await recordTaskReceipt(root, task.id, {
      actor: 'agent:builder', plan_digest: task.plan_digest!, epoch: task.lease_epoch!,
      sequence: (task.last_receipt_sequence ?? 0) + 1, lease_id: 'lease-1',
      artifact_digest: evidence.artifact_digest, counters: {}, external_ids: {},
      evidence_hashes: [evidence.evidence_hash], state,
    });
  }

  async function freshGitEvidence(root: string) {
    const task = await currentTask(root);
    if (task.contract!.provenance.kind === 'research') throw new Error('code fixture required');
    await evaluateTaskPredicate(root, task.id, 'git_diff_scope', {
      lease_id: 'lease-1', base_revision: task.contract!.provenance.base_revision,
      artifact_revision: task.contract!.provenance.artifact_revision,
    });
    return (await readTaskEvents(root)).findLast((event) => event.event === 'evidence')!.evidence!;
  }

  it('resumes execution only when its registered predicate passes', async () => {
    const { root } = await setupGit();
    await gitReceipt(root, 'running');
    await recordTaskReceipt(root, 'demo-1', {
      ...(await currentTask(root)).last_receipt!, sequence: 2, state: 'blocked', blocker_kind: 'execution',
      resume_condition: { type: 'predicate', acceptance_id: 'diff' },
    });
    await recordTaskReceipt(root, 'demo-1', {
      ...(await currentTask(root)).last_receipt!, sequence: 3, state: 'running',
      artifact_digest: (await freshGitEvidence(root)).artifact_digest,
      evidence_hashes: [(await freshGitEvidence(root)).evidence_hash],
      blocker_kind: undefined, resume_condition: undefined,
    });
    expect((await currentTask(root)).state).toBe('running');
    const retryEvidence = await recordTaskEvidence(root, 'demo-1', {
      actor: 'agent:builder', plan_digest: (await currentTask(root)).plan_digest!, epoch: 1,
      outcome: 'passed', lease_id: 'lease-1', artifact: ARTIFACT, content: CONTENT,
    });
    await recordTaskReceipt(root, 'demo-1', {
      ...(await currentTask(root)).last_receipt!, sequence: 4, state: 'blocked', blocker_kind: 'execution',
      artifact_digest: retryEvidence.artifact_digest, evidence_hashes: [retryEvidence.evidence_hash],
      resume_condition: { type: 'predicate', acceptance_id: 'missing' },
    });
    await expect(recordTaskReceipt(root, 'demo-1', {
      ...(await currentTask(root)).last_receipt!, sequence: 5, state: 'running',
      blocker_kind: undefined, resume_condition: undefined,
    })).rejects.toThrow(/resume condition/);
    expect((await currentTask(root)).state).toBe('blocked');
  });

  it('resumes evidence only with current registered passing evidence', async () => {
    const { root } = await setupGit();
    await gitReceipt(root, 'reconciling');
    await recordTaskReceipt(root, 'demo-1', {
      ...(await currentTask(root)).last_receipt!, sequence: 2, state: 'blocked', blocker_kind: 'evidence',
      resume_condition: { type: 'predicate', acceptance_id: 'diff' },
    });
    await recordTaskReceipt(root, 'demo-1', {
      ...(await currentTask(root)).last_receipt!, sequence: 3, state: 'reconciling',
      artifact_digest: (await freshGitEvidence(root)).artifact_digest,
      evidence_hashes: [(await freshGitEvidence(root)).evidence_hash],
      blocker_kind: undefined, resume_condition: undefined,
    });
    expect((await currentTask(root)).state).toBe('reconciling');
    const retryEvidence = await recordTaskEvidence(root, 'demo-1', {
      actor: 'agent:builder', plan_digest: (await currentTask(root)).plan_digest!, epoch: 1,
      outcome: 'passed', lease_id: 'lease-1', artifact: ARTIFACT, content: CONTENT,
    });
    await recordTaskReceipt(root, 'demo-1', {
      ...(await currentTask(root)).last_receipt!, sequence: 4, state: 'blocked', blocker_kind: 'evidence',
      artifact_digest: retryEvidence.artifact_digest, evidence_hashes: [retryEvidence.evidence_hash],
      resume_condition: { type: 'predicate', acceptance_id: 'missing' },
    });
    await expect(recordTaskReceipt(root, 'demo-1', {
      ...(await currentTask(root)).last_receipt!, sequence: 5, state: 'reconciling',
      blocker_kind: undefined, resume_condition: undefined,
    })).rejects.toThrow(/resume condition/);
    expect((await currentTask(root)).state).toBe('blocked');
  });

  it('resumes a child blocker only after the real child reconciles', async () => {
    const fixture = await setupGit({ requiredChildren: ['demo-2'] });
    await appendTaskEvent(fixture.root, { id: 'demo-2', project: 'demo', event: 'asked', at: new Date().toISOString() });
    await gitReceipt(fixture.root, 'reconciling');
    await recordTaskReceipt(fixture.root, 'demo-1', {
      ...(await currentTask(fixture.root)).last_receipt!, sequence: 2, state: 'blocked', blocker_kind: 'child',
      resume_condition: { type: 'child', child_id: 'demo-2' },
    });
    await reconcileBlockedTasks(fixture.root);
    expect((await currentTask(fixture.root)).state).toBe('blocked');
    expect((await readTaskEvents(fixture.root)).filter((event) => event.event === 'receipt')).toHaveLength(2);

    const childContract: RootContract = {
      ...fixture.contract,
      provenance: {
        repository: fixture.home, base_revision: fixture.artifact, artifact_revision: fixture.artifact,
      },
      required_children: undefined,
    };
    const childDigest = contractDigest(childContract);
    const at = new Date().toISOString();
    await appendTaskEvent(fixture.root, {
      id: 'demo-2', project: 'demo', event: 'plan', at, checkpoints: CHECKPOINTS,
      contract: childContract, plan_digest: childDigest,
    });
    await appendTaskEvent(fixture.root, {
      id: 'demo-2', project: 'demo', event: 'answered', at, plan_digest: childDigest,
    });
    await appendTaskEvent(fixture.root, {
      id: 'demo-2', project: 'demo', event: 'progress', at, checkpoint: 'work', status: 'ok',
    });
    await recordTaskOutcome(fixture.root, 'demo-2', 'no_op', {
      actor: 'legacy', plan_digest: childDigest, epoch: 1, acceptance_inapplicable: true,
    });
    expect((await currentTask(fixture.root, 'demo-2')).state).toBe('no_op');
    await reconcileBlockedTasks(fixture.root);
    expect((await currentTask(fixture.root)).state).toBe('reconciling');
    expect((await readTaskEvents(fixture.root)).filter((event) => event.event === 'receipt')).toHaveLength(3);
  });
});

describe('server-produced task receipts', () => {
  const artifactDigest = createHash('sha256').update('artifact\n').digest('hex');

  it('verifies real admitted bytes and reaches done through the registry', async () => {
    const fixture = await setup({ acceptance: [outputAcceptance(artifactDigest)], writer: true });
    const config = await declareOutput(fixture.root, artifactDigest);
    await expect(evaluateTaskPredicate(fixture.root, 'demo-1', 'task_receipt', config)).resolves.toBe(true);
    await expect(evaluateTaskPredicate(fixture.root, 'demo-1', 'task_receipt', config)).resolves.toBe(true);
    const produced = await readTaskEvents(fixture.root);
    expect(produced.filter((event) => event.event === 'evidence')).toHaveLength(1);
    expect(produced.filter((event) => event.event === 'receipt')).toHaveLength(2);
    expect(produced.findLast((event) => event.event === 'evidence')?.evidence).toMatchObject({
      actor: 'adapter:task_receipt', outcome: 'passed', artifact_digest: artifactDigest,
      artifact: { output_claim: 'a bounded diff', path: 'src/a.ts', content_digest: artifactDigest },
      verification: { adapter_id: 'task_receipt', evidence_type: 'task_receipt' },
    });
    const { transitionTmuxAdmission } = await import('../src/admission.js');
    await transitionTmuxAdmission(fixture.root, fixture.home, 'demo-1', 'builder', 'lease-1', 'released');
    await recordDone(fixture.root);
    expect((await currentTask(fixture.root)).state).toBe('done');
  });

  it('admits research without commits and verifies its declared output', async () => {
    const fixture = await setup({ acceptance: [outputAcceptance(artifactDigest)], writer: true, research: true });
    expect(fixture.contract.provenance).toMatchObject({
      kind: 'research', source_range: { start: 'session:start', end: 'session:end' },
    });
    expect(fixture.contract.provenance.repository).toBeUndefined();
    const config = await declareOutput(fixture.root, artifactDigest);
    await expect(evaluateTaskPredicate(fixture.root, 'demo-1', 'task_receipt', config)).resolves.toBe(true);
    const { transitionTmuxAdmission } = await import('../src/admission.js');
    await transitionTmuxAdmission(fixture.root, fixture.home, 'demo-1', 'builder', 'lease-1', 'released');
    await recordDone(fixture.root);
    expect((await currentTask(fixture.root)).state).toBe('done');
  });

  it.each([
    { name: 'nonexistent', path: 'src/missing.ts', sha256: artifactDigest, observed_at: '2026-11-20T12:00:00.000Z' },
    { name: 'wrong digest', path: 'src/a.ts', sha256: 'f'.repeat(64), observed_at: '2026-11-20T12:00:00.000Z' },
    { name: 'outside window', path: 'src/a.ts', sha256: artifactDigest, observed_at: '2026-11-19T12:00:00.000Z' },
    { name: 'future', path: 'src/a.ts', sha256: artifactDigest, observed_at: '2999-01-01T00:00:00.000Z' },
  ])('rejects a research source with $name evidence', async (source) => {
    const fixture = await setup({
      acceptance: [outputAcceptance(artifactDigest)], writer: true, research: true,
      researchSource: { id: 'source-1', ...source },
    });
    const config = await declareOutput(fixture.root, artifactDigest);
    await expect(evaluateTaskPredicate(fixture.root, 'demo-1', 'task_receipt', config)).resolves.toBe(false);
    const events = await readTaskEvents(fixture.root);
    expect(events.filter((event) => event.event === 'evidence')).toHaveLength(0);
    expect(events.filter((event) => event.event === 'receipt')).toHaveLength(1);
  });

  it.each(['wrong', 'missing', 'out-of-scope'] as const)('rejects a %s declared artifact', async (kind) => {
    const digest = kind === 'wrong' ? 'f'.repeat(64) : artifactDigest;
    const artifactPath = kind === 'missing' ? 'src/missing.ts' : kind === 'out-of-scope' ? 'outside.ts' : 'src/a.ts';
    const fixture = await setup({ acceptance: [outputAcceptance(digest, artifactPath)], writer: true });
    if (kind === 'out-of-scope') await writeFile(path.join(fixture.home, artifactPath), 'artifact\n');
    const config = await declareOutput(fixture.root, digest, artifactPath);
    await expect(evaluateTaskPredicate(fixture.root, 'demo-1', 'task_receipt', config)).resolves.toBe(false);
    expect((await readTaskEvents(fixture.root)).filter((event) => event.event === 'evidence')).toHaveLength(0);
    const { transitionTmuxAdmission } = await import('../src/admission.js');
    await transitionTmuxAdmission(fixture.root, fixture.home, 'demo-1', 'builder', 'lease-1', 'released');
    await expect(recordDone(fixture.root)).rejects.toThrow(/registered acceptance/);
  });

  it('rejects a moved worktree even when the second repository has the same bytes', async () => {
    const fixture = await setup({ acceptance: [outputAcceptance(artifactDigest)], writer: true });
    const other = path.join(fixture.root, 'other');
    await mkdir(path.join(other, 'src'), { recursive: true });
    git(other, 'init', '-b', 'main');
    await writeFile(path.join(other, 'src', 'a.ts'), 'artifact\n');
    const team = JSON.parse(await readFile(hivePath(fixture.home, 'team.json'), 'utf8')) as {
      agents: Record<string, unknown>[];
    };
    await writeJson(hivePath(fixture.home, 'team.json'), {
      agents: team.agents.map((agent) => agent.name === 'builder' ? { ...agent, worktree: other } : agent),
    });
    const config = await declareOutput(fixture.root, artifactDigest);
    await expect(evaluateTaskPredicate(fixture.root, 'demo-1', 'task_receipt', config)).resolves.toBe(false);
    expect((await readTaskEvents(fixture.root)).filter((event) => event.event === 'evidence')).toHaveLength(0);
  });

  it('rejects a final symlink instead of opening its target', async () => {
    const fixture = await setup({ acceptance: [outputAcceptance(artifactDigest)], writer: true });
    await rename(path.join(fixture.home, 'src', 'a.ts'), path.join(fixture.home, 'src', 'real.ts'));
    await writeFile(path.join(fixture.root, 'outside.ts'), 'artifact\n');
    await symlink(path.join(fixture.root, 'outside.ts'), path.join(fixture.home, 'src', 'a.ts'));
    const config = await declareOutput(fixture.root, artifactDigest);
    await expect(evaluateTaskPredicate(fixture.root, 'demo-1', 'task_receipt', config)).resolves.toBe(false);
    expect((await readTaskEvents(fixture.root)).filter((event) => event.event === 'evidence')).toHaveLength(0);
    await rm(path.join(fixture.home, 'src', 'real.ts'));
  });

  it('rejects an oversized replacement before producing evidence', async () => {
    const fixture = await setup({ acceptance: [outputAcceptance(artifactDigest)], writer: true });
    await writeFile(path.join(fixture.home, 'src', 'a.ts'), 'x'.repeat(16 * 1024 * 1024 + 1));
    const config = await declareOutput(fixture.root, artifactDigest);
    await expect(evaluateTaskPredicate(fixture.root, 'demo-1', 'task_receipt', config)).resolves.toBe(false);
    expect((await readTaskEvents(fixture.root)).filter((event) => event.event === 'evidence')).toHaveLength(0);
  });

  it.each(['grow', 'replace'] as const)('rejects a %s during the stable read', async (kind) => {
    const fixture = await setup({ acceptance: [outputAcceptance(artifactDigest)], writer: true });
    const filename = path.join(fixture.home, 'src', 'a.ts');
    const open = fs.open;
    vi.spyOn(fs, 'open').mockImplementationOnce(async (file, flags) => {
      const handle = await open(file, flags);
      const read = handle.read.bind(handle);
      handle.read = (async (...args: unknown[]) => {
        if (kind === 'grow') await writeFile(filename, 'artifact\n'.repeat(20));
        else {
          await rename(filename, `${filename}.old`);
          await writeFile(filename, 'artifact\n');
        }
        return read(...args as never);
      }) as typeof handle.read;
      return handle;
    });
    const config = await declareOutput(fixture.root, artifactDigest);
    await expect(evaluateTaskPredicate(fixture.root, 'demo-1', 'task_receipt', config)).resolves.toBe(false);
    expect((await readTaskEvents(fixture.root)).filter((event) => event.event === 'evidence')).toHaveLength(0);
  });

  it('rejects tampering after a server-produced pass', async () => {
    const fixture = await setup({ acceptance: [outputAcceptance(artifactDigest)], writer: true });
    const config = await declareOutput(fixture.root, artifactDigest);
    await expect(evaluateTaskPredicate(fixture.root, 'demo-1', 'task_receipt', config)).resolves.toBe(true);
    await writeFile(path.join(fixture.home, 'src', 'a.ts'), 'tampered\n');
    await expect(evaluateTaskPredicate(fixture.root, 'demo-1', 'task_receipt', config)).resolves.toBe(false);
    await expect(recordDone(fixture.root)).rejects.toThrow();
  });
});

describe('task receipt blocked resume evidence', () => {
  const bytes = JSON.stringify(ARTIFACT);
  const digest = createHash('sha256').update(bytes).digest('hex');

  async function fixture(state: 'running' | 'reconciling') {
    const current = await setup({ acceptance: [outputAcceptance(digest), diffAcceptance()], writer: true });
    await writeFile(path.join(current.home, 'src', 'a.ts'), bytes);
    const task = await currentTask(current.root);
    const evidence = await recordTaskEvidence(current.root, task.id, {
      actor: 'agent:builder', plan_digest: task.plan_digest!, epoch: 1, outcome: 'passed', lease_id: 'lease-1',
      artifact: ARTIFACT, content: CONTENT,
    });
    await recordTaskReceipt(current.root, task.id, {
      actor: 'agent:builder', plan_digest: task.plan_digest!, epoch: 1, sequence: 1, lease_id: 'lease-1',
      artifact_digest: digest, counters: {}, external_ids: {}, evidence_hashes: [evidence.evidence_hash], state,
    });
    await recordTaskReceipt(current.root, task.id, {
      actor: 'agent:builder', plan_digest: task.plan_digest!, epoch: 1, sequence: 2, lease_id: 'lease-1',
      artifact_digest: digest, counters: {}, external_ids: {}, evidence_hashes: [evidence.evidence_hash],
      state: 'blocked', blocker_kind: state === 'running' ? 'execution' : 'evidence',
      resume_condition: { type: 'predicate', acceptance_id: 'receipt' },
      output_claim: 'a bounded diff', artifact_path: 'src/a.ts',
    });
    return { ...current, evidence };
  }

  function freshHash(sequence: number): string {
    return valueDigest({
      artifact: { output_claim: 'a bounded diff', path: 'src/a.ts', content_digest: digest },
      content: { bytes: Buffer.byteLength(bytes), declared_sequence: sequence },
    });
  }

  it.each([
    { state: 'running' as const, blocker: 'execution' },
    { state: 'reconciling' as const, blocker: 'evidence' },
  ])('resumes $state manually with fresh task receipt evidence', async ({ state }) => {
    const current = await fixture(state);
    await recordTaskReceipt(current.root, 'demo-1', {
      ...(await currentTask(current.root)).last_receipt!, sequence: 3, state,
      evidence_hashes: [freshHash(2)], blocker_kind: undefined, resume_condition: undefined,
    });
    expect((await currentTask(current.root)).state).toBe(state);
    expect((await readTaskEvents(current.root)).filter((event) => event.event === 'receipt')).toHaveLength(3);
  });

  it.each([
    { state: 'running' as const },
    { state: 'reconciling' as const },
  ])('resumes $state automatically with one fresh receipt', async ({ state }) => {
    const current = await fixture(state);
    await reconcileBlockedTasks(current.root);
    const task = await currentTask(current.root);
    expect(task.state).toBe(state);
    expect(task.last_receipt).toMatchObject({ sequence: 3, state, evidence_hashes: [freshHash(2)] });
    expect((await readTaskEvents(current.root)).filter((event) => event.event === 'receipt')).toHaveLength(3);
  });

  it('rejects pre-block, failed, and unrelated evidence', async () => {
    const current = await fixture('reconciling');
    const blocked = (await currentTask(current.root)).last_receipt!;
    await expect(recordTaskReceipt(current.root, 'demo-1', {
      ...blocked, sequence: 3, state: 'reconciling', blocker_kind: undefined, resume_condition: undefined,
    })).rejects.toThrow(/evidence|resume condition/);
    const failed = await recordTaskEvidence(current.root, 'demo-1', {
      actor: 'agent:builder', plan_digest: current.planDigest, epoch: 1, outcome: 'failed', lease_id: 'lease-1',
      artifact: ARTIFACT, content: { check: 'unit', status: 'failed' },
    });
    await expect(recordTaskReceipt(current.root, 'demo-1', {
      ...blocked, sequence: 3, state: 'reconciling', evidence_hashes: [failed.evidence_hash],
      blocker_kind: undefined, resume_condition: undefined,
    })).rejects.toThrow(/evidence|resume condition/);
    const task = await currentTask(current.root);
    if (task.contract!.provenance.kind === 'research') throw new Error('code fixture required');
    await evaluateTaskPredicate(current.root, 'demo-1', 'git_diff_scope', {
      lease_id: 'lease-1', base_revision: task.contract!.provenance.base_revision,
      artifact_revision: task.contract!.provenance.artifact_revision,
    });
    const unrelated = (await readTaskEvents(current.root)).findLast((event) => event.event === 'evidence')!.evidence!;
    await expect(recordTaskReceipt(current.root, 'demo-1', {
      ...blocked, sequence: 3, state: 'reconciling', evidence_hashes: [unrelated.evidence_hash],
      blocker_kind: undefined, resume_condition: undefined,
    })).rejects.toThrow(/evidence|resume condition/);
    expect((await currentTask(current.root)).state).toBe('blocked');
  });

  it('fails closed for empty evidence hashes', async () => {
    const current = await setup({ acceptance: [outputAcceptance(digest)], writer: true });
    await writeFile(path.join(current.home, 'src', 'a.ts'), bytes);
    const config = await declareOutput(current.root, digest);
    await evaluateTaskPredicate(current.root, 'demo-1', 'task_receipt', config);
    const events = await readTaskEvents(current.root);
    const emptied = events.map((event) => event.event === 'receipt'
      ? { ...event, receipt: { ...event.receipt!, evidence_hashes: [] } }
      : event);
    expect(TASK_PREDICATES.task_receipt(emptied, 'demo-1', config)).toBe(false);
  });
});

describe('registered evidence dispatch', () => {
  it('wires only real predicates and the real push executor', async () => {
    expect(Object.keys(PREDICATE_REGISTRY).sort()).toEqual(['git_diff_scope', 'github_check', 'native_result', 'task_receipt']);
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
