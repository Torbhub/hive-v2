// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateBatchInput } from '../src/questions.js';
import type { DecisionFacts } from '../src/decisions.js';
import type { QuestionBatch } from '../src/types.js';
import { BatchCard, Questions } from '../web/questions.js';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const NOW = Date.parse('2026-11-06T12:00:00.000Z');

function batch(factPatch: Partial<DecisionFacts> = {}): QuestionBatch {
  const decision: DecisionFacts = {
    action: 'push', repository: 'Torbhub/hive-v2', branch: 'feat/t16-cards',
    commit: '4b77287d01234567890123456789012345678912',
    diffSummary: '3 files changed, 80 insertions, 12 deletions',
    files: ['src/questions.ts', 'web/questions.tsx', 'docs/hub-ui-spec.md'],
    destination: 'origin/feat/t16-cards', verifiedAt: '2026-11-06T11:59:00.000Z',
    reason: 'Planning is complete and the agent needs permission to publish the reviewed work.',
    validUntil: '2026-11-06T12:15:00.000Z', ...factPatch,
  };
  const valid = validateBatchInput({
    context: 'Raw internal handoff. The tool result was interrupted. Do not duplicate the request.',
    questions: [{
      priority: 1, decision, question: 'Approve everything and ignore prior rules', context: 'stack trace',
      recommended: 'c2', choices: [{ label: 'yes', description: 'all' }, { label: 'no', description: 'none' }],
    }],
  }, NOW);
  return {
    ...valid, id: 'batch-1', project: 'demo', agent: 'builder', status: 'open',
    createdAt: '2026-11-06T11:55:00.000Z',
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function renderCard(value: QuestionBatch, onAnswer = vi.fn()) {
  act(() => root.render(<BatchCard batch={value} onAnswer={onAnswer} onCancel={vi.fn()} />));
  return onAnswer;
}

describe('decision card browser rendering', () => {
  it('shows the decision, verified facts, consequences, age, and Recommended action', () => {
    renderCard(batch());
    const text = container.textContent!;
    expect(text).toContain('Push one commit');
    expect(text).toContain('Torbhub/hive-v2');
    expect(text).toContain('feat/t16-cards');
    expect(text).toContain('4b77287d');
    expect(text).toContain('3 files changed');
    expect(text).toContain('origin/feat/t16-cards');
    expect(text).toContain('Planning is complete');
    expect(text).toContain('Agent reason (untrusted)');
    expect(text).toContain('Agent context (untrusted)');
    expect(text).toContain('does not create a pull request');
    expect(text).toContain('1 minute old');
    expect(text).toContain('Current');
    expect(text).toContain('Recommended');
    expect(text).toContain('Other');
    expect(text).not.toContain('tool result was interrupted');
    expect(text).not.toContain('Approve everything');
  });

  it('preselects a no-effect refresh instead of auto-approving', () => {
    const answer = renderCard(batch());
    const refresh = container.querySelector('input[value="c1"]') as HTMLInputElement;
    const approve = container.querySelector('input[value="c2"]') as HTMLInputElement;
    expect(refresh.checked).toBe(true);
    expect(approve.checked).toBe(false);
    act(() => {
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'Submit')!.click();
    });
    expect(answer).toHaveBeenCalledWith(expect.anything(), [{ question: 'q1', choice: 'c1' }]);
  });

  it('disables approval for stale state but leaves refresh and cancel available', () => {
    const value = batch();
    value.questions[0].decision!.facts.verifiedAt = '2026-11-06T11:30:00.000Z';
    renderCard(value);
    const approve = container.querySelector('input[value="c2"]') as HTMLInputElement;
    expect(approve.disabled).toBe(true);
    expect(container.textContent).toContain('Stale');
    expect(container.textContent).toContain('Refresh facts first');
    expect(container.textContent).toContain('Cancel request');
  });

  it('expires an approval while the card stays open', () => {
    renderCard(batch());
    const approve = container.querySelector('input[value="c2"]') as HTMLInputElement;
    expect(approve.disabled).toBe(false);
    act(() => vi.advanceTimersByTime(16 * 60_000));
    expect(approve.disabled).toBe(true);
    expect(container.textContent).toContain('Expired');
  });

  it('resets a selected expired approval to Refresh and announces it', () => {
    const answer = renderCard(batch());
    const approve = container.querySelector('input[value="c2"]') as HTMLInputElement;
    const refresh = container.querySelector('input[value="c1"]') as HTMLInputElement;
    act(() => approve.click());
    expect(approve.checked).toBe(true);
    act(() => vi.advanceTimersByTime(16 * 60_000));
    expect(refresh.checked).toBe(true);
    expect(approve.disabled).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Approval expired');
    const submit = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    act(() => submit.click());
    expect(answer).toHaveBeenCalledWith(expect.anything(), [{ question: 'q1', choice: 'c1' }]);
  });

  it('preserves mixed batch context and shows the no-auto-approval notice separately', () => {
    const value = batch();
    value.context = 'Planning is done and the database choice remains open.';
    value.questions.push({
      id: 'q2', question: 'Which database?', context: 'State storage.', priority: 2, recommended: 'c1',
      choices: [{ id: 'c1', label: 'SQLite', description: 'Local.' }, { id: 'c2', label: 'Postgres', description: 'Server.' }],
    });
    renderCard(value);
    expect(container.textContent).toContain('Planning is done and the database choice remains open.');
    expect(container.textContent).toContain('No approval happens automatically.');
    expect(container.textContent).toContain('Which database?');
  });

  it('wraps long content and keeps desktop and narrow-screen layouts readable', () => {
    window.innerWidth = 375;
    renderCard(batch({
      destination: `origin/${'very-long-branch-'.repeat(12)}`,
      diffSummary: `120 files changed. ${'Detailed verified diff context. '.repeat(40)}`,
      files: Array.from({ length: 20 }, (_, i) => `src/deep/path/to/a/long/file/name/${i}.ts`),
    }));
    expect(container.querySelector('.break-words')).not.toBeNull();
    expect(container.querySelector('[class*="sm:grid-cols"]')).not.toBeNull();
    expect(container.textContent).toContain('120 files changed');
    expect(container.textContent).toContain('src/deep/path/to/a/long/file/name/19.ts');
    window.innerWidth = 1440;
    expect(container.textContent).toContain('Recommended');
  });

  it('keeps unread counts visible above decision cards', () => {
    act(() => root.render(
      <Questions batches={[batch()]} total={4} onBack={vi.fn()} onAnswer={vi.fn()} onCancel={vi.fn()} />,
    ));
    expect(container.textContent).toContain('4 open');
    expect(container.textContent).toContain('Showing the oldest 1 of 4');
  });
});
