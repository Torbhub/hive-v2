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
});
