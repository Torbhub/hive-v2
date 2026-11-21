import { describe, expect, it } from 'vitest';
import { matchingEvidence, TASK_PREDICATES } from '../src/evidence.js';
import { acceptanceEvidenceRows, buildWorkTree } from '../src/supervision.js';
import { contractDigest, foldTasks, valueDigest } from '../src/state.js';
import type {
  RootContract, TaskAcceptance, TaskEvidence, TaskEvent, TaskReceipt, TeamEntry, TmuxAdmission,
} from '../src/types.js';

const AT = '2026-11-21T12:00:00.000Z';
const SHA = 'a'.repeat(40);
const ARTIFACT = 'b'.repeat(64);
const OTHER_ARTIFACT = 'c'.repeat(64);
const PLAN_CONTRACT: RootContract = {
  schema_version: 1, objective: 'Verify bytes.', consumer: 'demo-orchestrator', deliverable: 'bytes', kind: 'build',
  acceptance: [{
    id: 'receipt', predicate_id: 'task_receipt', version: 1,
    configuration: {
      output_claim: 'bytes', artifact_path: 'src/a.ts', artifact_digest: ARTIFACT,
    },
    required_evidence: ['server-read-artifact'],
  } satisfies TaskAcceptance],
  provenance: { repository: 'octo/hive', base_revision: '0'.repeat(40), artifact_revision: SHA },
  write_scope: ['src'], action_scope: [],
  budget: { depth: 1, active_children: 2, active_project_records: 4, attempts: 3 },
  delegation: { output_claims: ['bytes'], adapters: ['tmux'] },
};
const PLAN = contractDigest(PLAN_CONTRACT);

function admission(leaseId: string): TmuxAdmission {
  return {
    task: 'demo-1', project: 'demo', agent: 'builder', parent_id: 'demo-1', plan_digest: PLAN,
    root_lease_epoch: 1, lease_id: leaseId, lease_epoch: 1, lease_revoked: false,
    output_claim: 'bytes', acceptance_ids: ['receipt'], provenance: PLAN_CONTRACT.provenance,
    provenance_digest: valueDigest(PLAN_CONTRACT.provenance), write_scope: ['src'], adapter: 'tmux',
    lineage_id: leaseId, attempts_used: 1, status: 'running',
  };
}

function entry(leaseId: string): TeamEntry {
  return {
    name: 'builder', task: 'demo-1', lease_id: leaseId, lease_epoch: 1, plan_digest: PLAN,
    root_lease_epoch: 1, admission_status: 'running',
  };
}

function evidence(leaseId: string, sequence: number, overrides: Partial<TaskEvidence> = {}): TaskEvent {
  const artifact = { output_claim: 'bytes', path: 'src/a.ts', content_digest: ARTIFACT };
  const content = { bytes: 8, declared_sequence: sequence };
  return {
    id: 'demo-1', project: 'demo', event: 'evidence', at: AT,
    evidence: {
      actor: 'adapter:task_receipt', plan_digest: PLAN, epoch: 1, outcome: 'passed', lease_id: leaseId,
      artifact, content, artifact_digest: ARTIFACT, evidence_hash: valueDigest({ artifact, content }),
      verification: {
        adapter_id: 'task_receipt', evidence_type: 'task_receipt',
        provenance_digest: valueDigest(PLAN_CONTRACT.provenance), acceptance_id: 'receipt',
      },
      ...overrides,
    },
  };
}

function receipt(leaseId: string, sequence: number, hashes: string[], artifactDigest = ARTIFACT): TaskEvent {
  const value: TaskReceipt = {
    actor: 'adapter:task_receipt', plan_digest: PLAN, epoch: 1, sequence, lease_id: leaseId,
    artifact_digest: artifactDigest, counters: {}, external_ids: {}, evidence_hashes: hashes,
    state: 'reconciling', output_claim: 'bytes', artifact_path: 'src/a.ts',
  };
  return { id: 'demo-1', project: 'demo', event: 'receipt', at: AT, receipt: value };
}

function config(leaseId: string) {
  return {
    plan_digest: PLAN, lease_id: leaseId, artifact_digest: ARTIFACT,
    output_claim: 'bytes', artifact_path: 'src/a.ts', acceptance_id: 'receipt',
  };
}

function withState(events: TaskEvent[], leases: string[]): TaskEvent[] {
  return [
    { id: 'demo-1', project: 'demo', event: 'asked', at: AT, lease_epoch: 1 },
    { id: 'demo-1', project: 'demo', event: 'plan', at: AT, contract: PLAN_CONTRACT, plan_digest: PLAN, checkpoints: [] },
    { id: 'demo-1', project: 'demo', event: 'answered', at: AT, plan_digest: PLAN },
    ...leases.map((lease): TaskEvent => ({
      id: 'demo-1', project: 'demo', event: 'admission', at: AT, admission: admission(lease),
    })),
    ...events,
  ];
}

function projectedTask(events: TaskEvent[], leases: string[]) {
  return foldTasks(withState(events, leases))[0];
}

describe('task receipt current-attempt binding', () => {
  it('fails an empty current receipt with an older passing receipt and evidence', () => {
    const old = evidence('lease-1', 1);
    const events = [old, receipt('lease-1', 1, [old.evidence!.evidence_hash]), receipt('lease-1', 2, [])];
    expect(TASK_PREDICATES.task_receipt(withState(events, ['lease-1']), 'demo-1', config('lease-1'))).toBe(false);
    expect(acceptanceEvidenceRows(projectedTask(events, ['lease-1']), events, [entry('lease-1')])[0].result).toBe('FAIL');
  });

  it('fails an unrelated current receipt with older passing evidence', () => {
    const old = evidence('lease-1', 1);
    const unrelated = evidence('lease-1', 2, {
      artifact: { output_claim: 'other', path: 'src/other.ts', content_digest: OTHER_ARTIFACT },
      artifact_digest: OTHER_ARTIFACT,
      verification: {
        adapter_id: 'task_receipt', evidence_type: 'task_receipt',
        provenance_digest: valueDigest(PLAN_CONTRACT.provenance), acceptance_id: 'other',
      },
    });
    const events = [
      old, receipt('lease-1', 1, [old.evidence!.evidence_hash]),
      unrelated, receipt('lease-1', 2, [unrelated.evidence!.evidence_hash], OTHER_ARTIFACT),
    ];
    expect(TASK_PREDICATES.task_receipt(withState(events, ['lease-1']), 'demo-1', config('lease-1'))).toBe(false);
    expect(acceptanceEvidenceRows(projectedTask(events, ['lease-1']), events, [entry('lease-1')])[0].result).toBe('FAIL');
  });

  it('does not resurrect R1 proof after a blocked reconciling R2 for the same acceptance', () => {
    const old = evidence('lease-1', 1);
    const blocked = receipt('lease-1', 2, [old.evidence!.evidence_hash]);
    blocked.receipt!.state = 'blocked';
    blocked.receipt!.blocker_kind = 'evidence';
    blocked.receipt!.resume_condition = { type: 'predicate', acceptance_id: 'receipt' };
    const events = [old, receipt('lease-1', 1, [old.evidence!.evidence_hash]), blocked];
    expect(TASK_PREDICATES.task_receipt(withState(events, ['lease-1']), 'demo-1', config('lease-1'))).toBe(false);
    const task = projectedTask(events, []);
    task.plan_approved = true;
    const root = buildWorkTree({ tasks: [task], teams: { demo: [] }, branches: [], events }).nodes[0];
    expect(root.acceptance[0].result).toBe('FAIL');
    expect(root.doneEnabled).toBe(false);
  });

  it('does not let B resurrect R1 when blocked R2 has A evidence and an unknown resume owner', () => {
    const contract: RootContract = {
      ...PLAN_CONTRACT,
      acceptance: [
        { ...PLAN_CONTRACT.acceptance[0], id: 'receipt-a' },
        { ...PLAN_CONTRACT.acceptance[0], id: 'receipt-b' },
      ],
    };
    const plan = contractDigest(contract);
    const oldB = evidence('lease-1', 1, {
      plan_digest: plan,
      verification: {
        adapter_id: 'task_receipt', evidence_type: 'task_receipt',
        provenance_digest: valueDigest(contract.provenance), acceptance_id: 'receipt-b',
      },
    });
    const evidenceA = evidence('lease-1', 2, {
      plan_digest: plan,
      verification: {
        adapter_id: 'task_receipt', evidence_type: 'task_receipt',
        provenance_digest: valueDigest(contract.provenance), acceptance_id: 'receipt-a',
      },
    });
    const first = receipt('lease-1', 1, [oldB.evidence!.evidence_hash]);
    first.receipt!.plan_digest = plan;
    const blocked = receipt('lease-1', 2, [evidenceA.evidence!.evidence_hash]);
    blocked.receipt!.plan_digest = plan;
    blocked.receipt!.state = 'blocked';
    blocked.receipt!.blocker_kind = 'evidence';
    blocked.receipt!.resume_condition = { type: 'predicate', acceptance_id: 'missing' };
    const events = [oldB, first, evidenceA, blocked];
    const state: TaskEvent[] = [
      { id: 'demo-1', project: 'demo', event: 'asked', at: AT, lease_epoch: 1 },
      { id: 'demo-1', project: 'demo', event: 'plan', at: AT, contract, plan_digest: plan, checkpoints: [] },
      { id: 'demo-1', project: 'demo', event: 'answered', at: AT, plan_digest: plan },
      {
        id: 'demo-1', project: 'demo', event: 'admission', at: AT,
        admission: { ...admission('lease-1'), plan_digest: plan, acceptance_ids: ['receipt-a', 'receipt-b'] },
      },
      ...events,
    ];
    expect(TASK_PREDICATES.task_receipt(state, 'demo-1', {
      ...config('lease-1'), plan_digest: plan, acceptance_id: 'receipt-b',
    })).toBe(false);
    const task = foldTasks(state)[0];
    const root = buildWorkTree({ tasks: [task], teams: { demo: [entry('lease-1')] }, branches: [], events }).nodes[0];
    expect(root.acceptance[1].result).toBe('FAIL');
    expect(root.doneEnabled).toBe(false);
  });

  it('uses valid lease2 proof without poisoning from later lease1 history', () => {
    const current = evidence('lease-2', 2);
    const staleFailure = evidence('lease-1', 1, { outcome: 'failed' });
    const events = [current, receipt('lease-2', 2, [current.evidence!.evidence_hash])];
    const withStaleHistory = [
      ...events, staleFailure, receipt('lease-1', 3, [staleFailure.evidence!.evidence_hash]),
    ];
    expect(TASK_PREDICATES.task_receipt(withState(withStaleHistory, ['lease-1', 'lease-2']), 'demo-1', config('lease-2'))).toBe(true);
    expect(acceptanceEvidenceRows(
      projectedTask(events, ['lease-1', 'lease-2']), events, [entry('lease-1'), entry('lease-2')],
    )[0].result).toBe('PASS');
  });

  it('does not authorize lease2 with only lease1 proof and an empty lease2 receipt', () => {
    const old = evidence('lease-1', 1);
    const events = [old, receipt('lease-1', 1, [old.evidence!.evidence_hash]), receipt('lease-2', 2, [])];
    expect(TASK_PREDICATES.task_receipt(withState(events, ['lease-1', 'lease-2']), 'demo-1', config('lease-2'))).toBe(false);
  });

  it('excludes proof before the requested event window', () => {
    const proof = evidence('lease-1', 1);
    const currentReceipt = receipt('lease-1', 1, [proof.evidence!.evidence_hash]).receipt!;
    const events = [proof, { id: 'demo-1', project: 'demo', event: 'note', at: AT, note: 'window' } as TaskEvent];
    const task = projectedTask([...events, receipt('lease-1', 1, [proof.evidence!.evidence_hash])], ['lease-1']);
    expect(matchingEvidence(events, 'demo-1', currentReceipt, task, false, true, -1)).toHaveLength(1);
    expect(matchingEvidence(events, 'demo-1', currentReceipt, task, false, true, 1)).toBeNull();
  });
});
