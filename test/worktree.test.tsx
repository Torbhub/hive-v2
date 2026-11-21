// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkTreeView } from '../web/WorkTree';
import type { WorkTreeNode } from '../src/types.js';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function node(overrides: Partial<WorkTreeNode> = {}): WorkTreeNode {
  return {
    id: 'task:demo:demo-1', parentId: null, project: 'demo', task: 'demo-1', kind: 'task',
    recordId: 'demo-1', adapter: 'root', state: 'reconciling', active: true, terminal: false,
    done: false, doneEnabled: false, doneBlockers: ['native has no passing registered evidence'],
    registeredPass: false, evidenceIncomplete: true, acceptanceTruncated: false,
    scope: [], details: [], acceptance: [{
      acceptanceId: 'native', predicateId: 'native_result', required: true, result: 'FAIL',
      artifactDigest: 'b'.repeat(64), target: 'a'.repeat(40), blocker: 'registered evidence failed',
    }],
    ...overrides,
  };
}

async function render(current: WorkTreeNode) {
  await act(async () => {
    root.render(<WorkTreeView tree={{ nodes: [current], truncated: false }} onChanged={vi.fn()} />);
  });
}

describe('acceptance evidence display', () => {
  it('shows the shared row result, digest, target, and bounded blocker', async () => {
    await render(node());
    const evidence = container.querySelector('[data-acceptance-evidence]')!;
    expect(evidence.getAttribute('aria-label')).toBe('Acceptance evidence');
    expect(evidence.textContent).toContain('native');
    expect(evidence.textContent).toContain('native_result');
    expect(evidence.textContent).toContain('FAIL');
    expect(evidence.textContent).toContain('b'.repeat(64));
    expect(evidence.textContent).toContain('a'.repeat(40));
    expect(evidence.textContent).toContain('registered evidence failed');
    expect(container.querySelector<HTMLButtonElement>('[data-work-tree-done]')!.disabled).toBe(true);
  });

  it('uses the server incomplete flag even when a predicate row is PASS', async () => {
    await render(node({
      state: 'done', active: false, terminal: true, done: true, doneBlockers: [],
      registeredPass: true, evidenceIncomplete: true,
      acceptance: [{
        acceptanceId: 'native', predicateId: 'native_result', required: true, result: 'PASS',
        artifactDigest: 'b'.repeat(64), target: 'a'.repeat(40),
      }],
    }));
    expect(container.querySelector('[data-work-tree-node]')!.textContent).toContain('done · evidence incomplete');
    expect(container.querySelector('[data-work-tree-done]')).toBeNull();
  });

  it('renders only bounded rows and announces truncation in the live detail region', async () => {
    const acceptance = Array.from({ length: 50 }, (_, index) => ({
      acceptanceId: `native-${index}`, predicateId: 'native_result', required: false, result: 'PASS' as const,
      artifactDigest: 'b'.repeat(64), target: 'a'.repeat(40),
    }));
    await render(node({ acceptance, acceptanceTruncated: true, registeredPass: true, evidenceIncomplete: false }));
    expect(container.querySelectorAll('[data-acceptance-evidence] tbody > tr')).toHaveLength(50);
    expect(container.querySelector('[data-work-tree-details]')!.textContent).toContain('acceptance evidence truncated');
    expect(container.querySelector('[data-work-tree-details]')!.getAttribute('aria-live')).toBe('polite');
  });

  it('uses index keys for duplicate bounded IDs and blocker text', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const acceptanceId = 'x'.repeat(500);
    try {
      await render(node({
        acceptance: [0, 1].map(() => ({
          acceptanceId, predicateId: 'native_result', required: true, result: 'FAIL' as const,
          artifactDigest: '—', target: 'n/a research', blocker: 'same blocker',
        })),
        doneBlockers: ['same blocker', 'same blocker'],
      }));
      expect(container.querySelectorAll('[data-acceptance-evidence] tbody > tr')).toHaveLength(4);
      expect(container.querySelector('[aria-label="Done blockers"]')!.children).toHaveLength(2);
      expect(errors.mock.calls.filter((call) => /same key|unique "key"/.test(call.join(' ')))).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });
});
