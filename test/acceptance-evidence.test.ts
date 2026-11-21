import { describe, expect, it } from 'vitest';
import { acceptanceEvidenceRows, buildWorkTree } from '../src/supervision.js';
import { contractDigest, taskEvidenceDigests, valueDigest } from '../src/state.js';
import type {
  HubTask, RootContract, TaskAcceptance, TaskEvidence, TaskEvent, TaskOperation, TeamEntry, TmuxAdmission,
} from '../src/types.js';

const AT = '2026-11-21T12:00:00.000Z';
const SHA = 'a'.repeat(40);
const ARTIFACT = 'b'.repeat(64);
const OTHER_ARTIFACT = 'c'.repeat(64);

function nativeAcceptance(overrides: Partial<TaskAcceptance> = {}): TaskAcceptance {
  return {
    id: 'native', predicate_id: 'native_result', version: 1,
    configuration: { artifact_digest: ARTIFACT }, required_evidence: ['native-result'], ...overrides,
  };
}

function githubAcceptance(overrides: Partial<TaskAcceptance> = {}): TaskAcceptance {
  return {
    id: 'github', predicate_id: 'github_check', version: 1,
    configuration: {
      repository: 'octo/hive', sha: SHA, external_id: 'deliverable-check', artifact_digest: ARTIFACT,
      owner: 'hive-checks', deadline: '2026-11-22T12:00:00.000Z',
    },
    required_evidence: ['github-check'], ...overrides,
  };
}

function fixture(acceptance: TaskAcceptance[] = [nativeAcceptance()], research = false) {
  const contract: RootContract = {
    schema_version: 1, objective: 'Verify the result.', consumer: 'demo-orchestrator',
    deliverable: 'a verified result', kind: research ? 'research' : 'build', acceptance,
    provenance: research ? {
      kind: 'research', source_range: {
        start: 'source', end: 'source',
        sources: [{ id: 'source', path: 'result.md', sha256: ARTIFACT, observed_at: AT }],
      },
      evidence_window: { starts_at: '2026-11-21T00:00:00.000Z', ends_at: '2026-11-22T00:00:00.000Z' },
    } : { repository: 'octo/hive', base_revision: '0'.repeat(40), artifact_revision: SHA },
    write_scope: ['src'], action_scope: [],
    budget: { depth: 2, active_children: 4, active_project_records: 8, attempts: 3 },
    delegation: { output_claims: ['a verified result'], adapters: ['native'] },
  };
  const planDigest = contractDigest(contract);
  const parentAdmission: TmuxAdmission = {
    task: 'demo-1', project: 'demo', agent: 'builder', parent_id: 'demo-1', plan_digest: planDigest,
    root_lease_epoch: 1, lease_id: 'parent-lease', lease_epoch: 1, lease_revoked: true,
    output_claim: 'a verified result', acceptance_ids: [], provenance: contract.provenance,
    provenance_digest: valueDigest(contract.provenance), write_scope: ['src'], adapter: 'tmux',
    lineage_id: 'parent-lineage', attempts_used: 1, status: 'released',
  };
  const admission: TmuxAdmission = {
    ...parentAdmission, agent: 'native-worker', lease_id: 'lease-1', parent_lease_id: parentAdmission.lease_id,
    depth: 2, acceptance_ids: acceptance.map((item) => item.id), write_scope: [], adapter: 'native',
    lineage_id: 'lineage-1',
  };
  const entry: TeamEntry = {
    name: 'builder', task: 'demo-1', lease_id: parentAdmission.lease_id, lease_epoch: 1,
    plan_digest: planDigest, root_lease_epoch: 1, admission_status: 'released', closed_at: AT,
  };
  const task: HubTask = {
    id: 'demo-1', project: 'demo', asked: AT, updated: AT, state: 'reconciling', last_note: null,
    needs_owner: false, plan_approved: true, plan_digest: planDigest, lease_epoch: 1, contract,
    checkpoints: [{ id: 'work', desc: 'verify', etaMin: 5 }],
    progress: { work: { status: 'ok', at: AT } }, admissions: [parentAdmission, admission],
  };
  return { contract, task, admission, entry, planDigest };
}

function evidenceEvent(
  fixture: ReturnType<typeof fixture>, acceptance: TaskAcceptance, overrides: Partial<TaskEvidence> = {},
): TaskEvent {
  const digests = taskEvidenceDigests({ result: 'stored' }, { status: 'stored' });
  return {
    id: 'demo-1', project: 'demo', event: 'evidence', at: AT,
    evidence: {
      actor: 'agent:native-worker', plan_digest: fixture.planDigest, epoch: 1, outcome: 'passed',
      lease_id: 'lease-1', artifact: { result: 'stored' }, content: { status: 'stored' }, ...digests,
      artifact_digest: ARTIFACT,
      verification: {
        adapter_id: acceptance.predicate_id as 'native_result', evidence_type: acceptance.predicate_id as 'native_result',
        provenance_digest: valueDigest(fixture.contract.provenance), acceptance_id: acceptance.id,
      },
      ...overrides,
    },
  };
}

function githubOperation(fixture: ReturnType<typeof fixture>, status: TaskOperation['status']): TaskOperation {
  const acceptance = fixture.contract.acceptance[0];
  const config = acceptance.configuration;
  const binding = {
    project: 'demo', task: 'demo-1', acceptance: acceptance.id,
    repository: config.repository, sha: config.sha, external_id: config.external_id,
    plan_digest: fixture.planDigest, artifact_digest: config.artifact_digest, owner: config.owner, epoch: 1,
  };
  const idempotency = valueDigest(binding);
  return {
    operation_id: `github-check-${idempotency.slice(0, 32)}`, idempotency_key: idempotency,
    kind: 'github_check', actor: 'adapter:github_check', plan_digest: fixture.planDigest, epoch: 1,
    repository_fingerprint: valueDigest(config.repository), commit: String(config.sha), branch: String(config.external_id),
    status, updated_at: AT, owner: String(config.owner), repository: String(config.repository),
    external_id: `github-check-${idempotency}`, external_run_id: '100', artifact_digest: String(config.artifact_digest),
    acceptance_id: acceptance.id, deadline: String(config.deadline),
    ...(status === 'succeeded' ? { result: { remote_tip: SHA, reconciled: true } } : {}),
  };
}

function rows(fixture: ReturnType<typeof fixture>, events: TaskEvent[]) {
  return acceptanceEvidenceRows(fixture.task, events, [fixture.entry]);
}

describe('acceptance evidence rows', () => {
  it('reports NOT_RUN, PENDING, FAIL, and PASS from stored native evidence', () => {
    const current = fixture();
    expect(rows(current, [])[0]).toMatchObject({
      acceptanceId: 'native', predicateId: 'native_result', required: true,
      result: 'NOT_RUN', artifactDigest: '—', target: SHA,
    });
    expect(rows(current, [evidenceEvent(current, current.contract.acceptance[0], { outcome: 'pending' })])[0])
      .toMatchObject({ result: 'PENDING', artifactDigest: ARTIFACT });
    expect(rows(current, [evidenceEvent(current, current.contract.acceptance[0], { outcome: 'failed' })])[0])
      .toMatchObject({ result: 'FAIL' });
    expect(rows(current, [evidenceEvent(current, current.contract.acceptance[0])])[0])
      .toMatchObject({ result: 'PASS', artifactDigest: ARTIFACT, target: SHA, blocker: undefined });
  });

  it('fails stale plan or epoch evidence instead of using it as a current pass', () => {
    const current = fixture();
    const acceptance = current.contract.acceptance[0];
    for (const stale of [{ plan_digest: 'd'.repeat(64) }, { epoch: 2 }]) {
      expect(rows(current, [evidenceEvent(current, acceptance, stale)])[0])
        .toMatchObject({ result: 'FAIL', artifactDigest: ARTIFACT });
    }
    current.task.plan_digest = 'e'.repeat(64);
    expect(rows(current, [evidenceEvent(current, acceptance)])[0]).toMatchObject({ result: 'FAIL' });
  });

  it('fails artifact, lease, and provenance mismatches', () => {
    const current = fixture();
    const acceptance = current.contract.acceptance[0];
    const mismatches = [
      { artifact_digest: OTHER_ARTIFACT },
      { lease_id: 'other-lease' },
      { verification: { ...evidenceEvent(current, acceptance).evidence!.verification!, provenance_digest: 'wrong' } },
    ];
    for (const mismatch of mismatches) {
      expect(rows(current, [evidenceEvent(current, acceptance, mismatch)])[0]).toMatchObject({ result: 'FAIL' });
    }
  });

  it('uses GitHub operation provenance and reports pending and failed operations', () => {
    const pending = fixture([githubAcceptance()]);
    const pendingOperation = githubOperation(pending, 'blocked_external');
    pending.task.operations = [pendingOperation];
    expect(rows(pending, [])[0]).toMatchObject({ result: 'PENDING', target: SHA });

    const failed = fixture([githubAcceptance()]);
    const failedOperation = githubOperation(failed, 'failed');
    failed.task.operations = [failedOperation];
    expect(rows(failed, [evidenceEvent(failed, failed.contract.acceptance[0], {
      outcome: 'failed', verification: {
        adapter_id: 'github_check', evidence_type: 'github_check', acceptance_id: 'github',
        provenance_digest: failedOperation.idempotency_key,
      },
    })])[0]).toMatchObject({ result: 'FAIL' });

    const passed = fixture([githubAcceptance()]);
    const operation = githubOperation(passed, 'succeeded');
    passed.task.operations = [operation];
    const event = evidenceEvent(passed, passed.contract.acceptance[0], {
      verification: {
        adapter_id: 'github_check', evidence_type: 'github_check', acceptance_id: 'github',
        provenance_digest: operation.idempotency_key,
      },
    });
    expect(rows(passed, [event])[0]).toMatchObject({ result: 'PASS', target: SHA });
    event.evidence!.verification!.provenance_digest = 'wrong';
    expect(rows(passed, [event])[0]).toMatchObject({ result: 'FAIL' });
  });

  it('never shares legacy proof between duplicate predicates', () => {
    const current = fixture([
      nativeAcceptance({ id: 'native-a' }), nativeAcceptance({ id: 'native-b' }),
    ]);
    const legacy = evidenceEvent(current, current.contract.acceptance[0]);
    legacy.evidence!.verification!.acceptance_id = undefined;
    expect(rows(current, [legacy]).map((row) => row.result)).toEqual(['NOT_RUN', 'NOT_RUN']);

    const single = fixture();
    const unambiguous = evidenceEvent(single, single.contract.acceptance[0]);
    unambiguous.evidence!.verification!.acceptance_id = undefined;
    expect(rows(single, [unambiguous])[0]).toMatchObject({ result: 'PASS' });
  });

  it('uses the same row result for required Done blockers', () => {
    const current = fixture();
    const events = [evidenceEvent(current, current.contract.acceptance[0])];
    const tree = buildWorkTree({ tasks: [current.task], teams: { demo: [current.entry] }, branches: [], events });
    expect(tree.nodes[0].acceptance[0].result).toBe('PASS');
    expect(tree.nodes[0].doneEnabled).toBe(true);
    expect(tree.nodes[0].doneBlockers).toEqual([]);

    const missing = buildWorkTree({ tasks: [current.task], teams: { demo: [current.entry] }, branches: [], events: [] });
    expect(missing.nodes[0].acceptance[0].result).toBe('NOT_RUN');
    expect(missing.nodes[0].doneEnabled).toBe(false);
    expect(missing.nodes[0].doneBlockers).toContain('native has no passing registered evidence');
  });

  it('keeps optional human acceptance separate from required registered proof', () => {
    const human = nativeAcceptance({ id: 'review', predicate_id: 'human_review', required: false });
    const current = fixture([nativeAcceptance(), human]);
    current.task.human_acceptance = {
      review: { actor: 'user:alice', acceptance_id: 'review', plan_digest: current.planDigest, epoch: 1, at: AT },
    };
    const events = [evidenceEvent(current, current.contract.acceptance[0])];
    expect(rows(current, events).map((row) => row.result)).toEqual(['PASS', 'PASS']);
    expect(buildWorkTree({ tasks: [current.task], teams: { demo: [current.entry] }, branches: [], events }).nodes[0].doneEnabled).toBe(true);

    human.required = true;
    current.task.plan_digest = contractDigest(current.contract);
    expect(rows(current, events)[1]).toMatchObject({ result: 'FAIL' });
  });

  it('uses n/a research as the target and does not mutate stored inputs', () => {
    const current = fixture([nativeAcceptance()], true);
    const events = [evidenceEvent(current, current.contract.acceptance[0])];
    const before = JSON.stringify({ task: current.task, events });
    expect(rows(current, events)[0]).toMatchObject({ result: 'PASS', target: 'n/a research' });
    expect(JSON.stringify({ task: current.task, events })).toBe(before);
  });

  it('uses the poisoned latest operation projection instead of a restored raw success', () => {
    const current = fixture([githubAcceptance()]);
    const operation = githubOperation(current, 'succeeded');
    current.task.operations = [operation, { ...operation, repository_fingerprint: 'poisoned' }];
    const event = evidenceEvent(current, current.contract.acceptance[0], {
      verification: {
        adapter_id: 'github_check', evidence_type: 'github_check', acceptance_id: 'github',
        provenance_digest: operation.idempotency_key,
      },
    });
    expect(rows(current, [event])[0]).toMatchObject({ result: 'FAIL' });
  });

  it.each(['failed', 'revoked'] as const)('rejects a %s evidence lease and disables Done', (kind) => {
    const current = fixture();
    current.admission.status = kind === 'failed' ? 'failed' : 'running';
    current.admission.lease_revoked = true;
    current.entry.admission_status = current.admission.status;
    current.entry.closed_at = kind === 'failed' ? AT : undefined;
    const events = [evidenceEvent(current, current.contract.acceptance[0])];
    expect(rows(current, events)[0]).toMatchObject({ result: 'FAIL' });
    const tree = buildWorkTree({ tasks: [current.task], teams: { demo: [current.entry] }, branches: [], events });
    expect(tree.nodes[0].doneEnabled).toBe(false);
  });

  it('uses original long acceptance IDs for blockers and authoritative evidence flags', () => {
    const id = 'x'.repeat(700);
    const current = fixture([nativeAcceptance({ id })]);
    const events = [evidenceEvent(current, current.contract.acceptance[0])];
    const root = buildWorkTree({ tasks: [current.task], teams: { demo: [current.entry] }, branches: [], events }).nodes[0];
    expect(root.acceptance[0]).toMatchObject({ result: 'PASS', acceptanceId: 'x'.repeat(500) });
    expect(root.registeredPass).toBe(true);
    expect(root.evidenceIncomplete).toBe(false);
    expect(root.doneEnabled).toBe(true);
    expect(root.doneBlockers).toEqual([]);
  });

  it('retains blockers for IDs that share the same bounded prefix', () => {
    const prefix = 'x'.repeat(600);
    const current = fixture([
      nativeAcceptance({ id: `${prefix}-a` }), nativeAcceptance({ id: `${prefix}-b` }),
    ]);
    const root = buildWorkTree({ tasks: [current.task], teams: { demo: [current.entry] }, branches: [], events: [] }).nodes[0];
    const blockers = root.doneBlockers.filter((blocker) => blocker.startsWith('x'.repeat(500)));
    expect(blockers).toHaveLength(2);
    expect(new Set(blockers).size).toBe(1);
  });

  it('rejects a revoked budget-exhausted root with current GitHub proof', () => {
    const current = fixture([githubAcceptance()]);
    const operation = githubOperation(current, 'succeeded');
    current.task.operations = [operation];
    current.task.lease_revoked = true;
    current.task.state = 'blocked:budget_exhausted';
    const events = [evidenceEvent(current, current.contract.acceptance[0], {
      verification: {
        adapter_id: 'github_check', evidence_type: 'github_check', acceptance_id: 'github',
        provenance_digest: operation.idempotency_key,
      },
    })];
    expect(rows(current, events)[0]).toMatchObject({ result: 'FAIL' });
    const root = buildWorkTree({ tasks: [current.task], teams: { demo: [current.entry] }, branches: [], events }).nodes[0];
    expect(root.doneEnabled).toBe(false);
    expect(root.evidenceIncomplete).toBe(true);
  });

  it('marks empty acceptance and unsupported-version human PASS as evidence incomplete', () => {
    const empty = fixture([]);
    empty.task.state = 'done';
    const emptyRoot = buildWorkTree({ tasks: [empty.task], teams: { demo: [] }, branches: [], events: [] }).nodes[0];
    expect(emptyRoot.registeredPass).toBe(false);
    expect(emptyRoot.evidenceIncomplete).toBe(true);

    const human = nativeAcceptance({ id: 'review', version: 2, required: false });
    const current = fixture([human]);
    current.task.state = 'done';
    current.task.human_acceptance = {
      review: { actor: 'user:alice', acceptance_id: 'review', plan_digest: current.planDigest, epoch: 1, at: AT },
    };
    const events: TaskEvent[] = [];
    expect(rows(current, events)[0]).toMatchObject({ result: 'PASS' });
    const root = buildWorkTree({ tasks: [current.task], teams: { demo: [] }, branches: [], events }).nodes[0];
    expect(root.registeredPass).toBe(false);
    expect(root.evidenceIncomplete).toBe(true);
  });

  it('caps public rows at 50 while Done blockers still use every acceptance', () => {
    const acceptance = Array.from({ length: 51 }, (_, index) => nativeAcceptance({ id: `native-${index}` }));
    const current = fixture(acceptance);
    const root = buildWorkTree({ tasks: [current.task], teams: { demo: [current.entry] }, branches: [], events: [] }).nodes[0];
    expect(root.acceptance).toHaveLength(50);
    expect(root.acceptanceTruncated).toBe(true);
    expect(root.doneBlockers).toContain('native-50 has no passing registered evidence');
    expect(root.registeredPass).toBe(false);
    expect(root.evidenceIncomplete).toBe(true);
  });
});
