import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { coherenceErrors, INVARIANTS, JOURNEYS } from '../src/journeys.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('journey registry coherence', () => {
  it('is internally sound and every referenced file exists', () => {
    expect(coherenceErrors(ROOT)).toEqual([]);
  });

  it('links task enforcement invariants to executable evidence', () => {
    const ids = ['locked-task-transitions', 'plan-answer-current-lease', 'receipt-current-evidence',
      'revocation-fences-receipts', 'hard-deny-before-auto'];
    expect(INVARIANTS.filter((invariant) => ids.includes(invariant.id)).map((invariant) => invariant.evidence)).toEqual([
      'test/hub.test.ts::atomic task transitions',
      'test/hub.test.ts::atomic task transitions',
      'test/hub.test.ts::task receipts',
      'test/hub.test.ts::task receipts',
      'test/watch.test.ts::watchCycle hard denies in auto mode',
    ]);
    expect(JOURNEYS.find((journey) => journey.id === 'TASK_RECEIPT_RECOVERY')?.status).toBe('USED');
  });

  it('links delegate and rewake enforcement to behavior tests', () => {
    expect(JOURNEYS.find((journey) => journey.id === 'DELEGATE_WORK')).toMatchObject({
      status: 'USED', tracer: 'test/admission.test.ts',
    });
    expect(INVARIANTS.find((invariant) => invariant.id === 'attempt-lineage-budget')?.evidence)
      .toBe('test/admission.test.ts::tmux replacement lineage');
    expect(INVARIANTS.find((invariant) => invariant.id === 'scope-diff-fences-lease')?.evidence)
      .toBe('test/scope.test.ts::git_diff_scope');
    expect(JOURNEYS.find((journey) => journey.id === 'WATCHDOG_REWAKE')?.criteria)
      .toContain('wake-current-lease');
    expect(INVARIANTS.find((invariant) => invariant.id === 'public-contract-intake')?.evidence)
      .toBe('test/web.test.ts::POST /api/task-plan');
    expect(INVARIANTS.find((invariant) => invariant.id === 'exact-lease-revocation')?.evidence)
      .toBe('test/admission.test.ts::worker evidence and cancellation');
    expect(INVARIANTS.find((invariant) => invariant.id === 'owned-lock-release')?.evidence)
      .toBe('test/state.test.ts::withTeamLock');
  });

  it('links evidence outcomes and push operations to real adapter tests', () => {
    expect(JOURNEYS.find((journey) => journey.id === 'EVIDENCE_DONE')).toMatchObject({
      status: 'USED', tracer: 'test/evidence.test.ts',
    });
    expect(INVARIANTS.find((invariant) => invariant.id === 'registered-evidence-done')?.evidence)
      .toBe('test/evidence.test.ts::evidence outcomes');
    expect(INVARIANTS.find((invariant) => invariant.id === 'terminal-outcome-guards')?.evidence)
      .toBe('test/evidence.test.ts::evidence outcomes');
    expect(JOURNEYS.find((journey) => journey.id === 'GATE_VERIFY_PUSH')?.criteria)
      .toContain('push-operation-binding');
    expect(INVARIANTS.find((invariant) => invariant.id === 'push-operation-binding')?.evidence)
      .toBe('test/push-consumption.test.ts::contract-bound push operations');
  });
});
