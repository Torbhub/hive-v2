import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubView, QuestionBatch, RootContract } from '../src/types.js';
import { taskContract } from './task-contract.js';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const VIEW: HubView = {
  root: '/r',
  hubName: 'hub',
  projects: [{
    name: 'demo',
    home: '/r/demo',
    repos: [],
    mode: 'ask',
    orchestrator: { state: 'stopped', question: false, name: 'demo-orchestrator', session_id: 'session_x' },
    agents: [],
    open_tasks: 0,
  }],
  tasks: [],
  dialogs: {},
  decisions: [],
  questions: [],
  updatedAt: Date.now(),
  error: '',
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let resolveAction: ((v: Response) => void) | null;

beforeEach(async () => {
  resolveAction = null;
  vi.stubGlobal('fetch', vi.fn((input: unknown) => {
    if (String(input).endsWith('api/view')) {
      return Promise.resolve(new Response(JSON.stringify(VIEW), { status: 200 }));
    }
    return new Promise<Response>((resolve) => {
      resolveAction = resolve;
    });
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  const { App } = await import('../web/App');
  root = createRoot(container);
  await act(async () => {
    root.render(<App />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function resumeButton(): HTMLButtonElement {
  const btn = [...container.querySelectorAll('button')]
    .find((b) => b.textContent === 'Resume · 1 session');
  if (!btn) throw new Error('no Resume button rendered');
  return btn;
}

describe('stretchtext decisions', () => {
  const stretchView: HubView = {
    ...VIEW,
    decisions: [{
      at: new Date().toISOString(),
      project: 'demo',
      task: 'demo-1',
      by: 'watch',
      summary: 'chose postgres {{why|it fits the relational brief}} for demo',
    }],
  };

  function mountWithDecisions(): void {
    vi.mocked(fetch).mockImplementation((input: unknown) => {
      const url = String(input);
      if (url.endsWith('api/view')) {
        return Promise.resolve(new Response(JSON.stringify(stretchView), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });
  }

  function stretchSpan(text: string): HTMLElement {
    const el = [...container.querySelectorAll('[role="button"]')]
      .find((b) => b.textContent === text) as HTMLElement | undefined;
    if (!el) throw new Error(`no stretch span rendered for "${text}"`);
    return el;
  }

  it('the short form shows, a click expands the long form and records the open', async () => {
    mountWithDecisions();
    await act(async () => {
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'refresh')!.click();
    });
    expect(stretchSpan('why').getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('it fits the relational brief');

    act(() => {
      stretchSpan('why').click();
    });
    expect(container.textContent).toContain('it fits the relational brief');
    expect(container.textContent).not.toContain('{{why|');
    const recorded = vi.mocked(fetch).mock.calls
      .map(([input, init]) => ({ url: String(input), init }))
      .find((c) => c.url.endsWith('api/stretch-opened'));
    expect(recorded).toBeDefined();
    expect(JSON.parse(String(recorded!.init?.body))).toEqual({ short: 'why', pane: 'demo-1' });

    act(() => {
      stretchSpan('it fits the relational brief').click();
    });
    expect(container.textContent).not.toContain('it fits the relational brief');
    expect(vi.mocked(fetch).mock.calls.filter(([i]) => String(i).endsWith('api/stretch-opened'))).toHaveLength(1);
  });

  it('a failed record call leaves the expansion working', async () => {
    mountWithDecisions();
    vi.mocked(fetch).mockImplementation((input: unknown) => {
      const url = String(input);
      if (url.endsWith('api/view')) {
        return Promise.resolve(new Response(JSON.stringify(stretchView), { status: 200 }));
      }
      return Promise.reject(new Error('network down'));
    });
    await act(async () => {
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'refresh')!.click();
    });
    act(() => {
      stretchSpan('why').click();
    });
    expect(container.textContent).toContain('it fits the relational brief');
  });
});

describe('instant click feedback', () => {
  it('the moment Resume is clicked the card shows resuming… and all other action buttons disable', async () => {
    const startBtn = [...container.querySelectorAll('button')]
      .find((b) => b.textContent === 'Start task') as HTMLButtonElement;
    expect(startBtn.disabled).toBe(true);
    const resume = resumeButton();
    act(() => {
      resume.click();
    });
    expect(resolveAction).not.toBeNull();
    expect(container.textContent).toContain('resuming…');
    expect(container.querySelectorAll('button:not(:disabled)')).toHaveLength(1);
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({ ok: true, pane: '%1' }), { status: 200 }));
    });
    expect(container.textContent).toContain('its orchestrator is coming up');
  });

  it('a typed task enables Start task, and clicking it swaps the row to starting… before the fetch resolves', async () => {
    const input = container.querySelector('input[aria-label="new task for demo"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, 'write the docs');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const startBtn = [...container.querySelectorAll('button')]
      .find((b) => b.textContent === 'Start task') as HTMLButtonElement;
    expect(startBtn.disabled).toBe(false);
    act(() => {
      startBtn.click();
    });
    expect(container.textContent).toContain('starting…');
    expect(container.querySelector('input[aria-label="new task for demo"]')).toBeNull();
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({ ok: true, id: 'demo-1' }), { status: 200 }));
    });
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({ ok: true, pane: '%1' }), { status: 200 }));
    });
    expect(container.textContent).toContain('coming up on demo-1');
  });

  it('a task sent to a running orchestrator clears the draft and registers once', async () => {
    const input = container.querySelector('input[aria-label="new task for demo"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, 'write the docs');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      ([...container.querySelectorAll('button')].find((b) => b.textContent === 'Start task') as HTMLButtonElement).click();
    });
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({ ok: true, id: 'demo-1' }), { status: 200 }));
    });
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({ ok: true, typed: true }), { status: 200 }));
    });
    expect(container.textContent).toContain('demo-1 was sent to its running orchestrator');
    expect((container.querySelector('input[aria-label="new task for demo"]') as HTMLInputElement).value).toBe('');
    expect(vi.mocked(fetch).mock.calls.filter(([i]) => String(i).endsWith('api/task'))).toHaveLength(1);
    expect(vi.mocked(fetch).mock.calls.filter(([i]) => String(i).endsWith('api/start'))).toHaveLength(1);
  });

  it('a long dialog option wraps and retains its answer behavior', async () => {
    const longLabel = 'Approve this extraordinarily long dialog option without overflowing the narrow mobile viewport';
    const dialogView: HubView = {
      ...VIEW,
      projects: [{
        ...VIEW.projects[0],
        orchestrator: { ...VIEW.projects[0].orchestrator, state: 'running', question: true },
      }],
      dialogs: {
        demo: {
          kind: 'numbered', text: `Run this command?\n 1. ${longLabel}`, cursor: null, esc: true,
          options: [{ n: 1, label: longLabel, detail: '', offered: true, saves_rule: false }],
          fingerprint: 'fp',
        },
      },
    };
    vi.mocked(fetch).mockImplementation((input: unknown) => {
      if (String(input).endsWith('api/view')) {
        return Promise.resolve(new Response(JSON.stringify(dialogView), { status: 200 }));
      }
      return new Promise<Response>((resolve) => {
        resolveAction = resolve;
      });
    });
    await act(async () => {
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'refresh')!.click();
    });
    const option = [...container.querySelectorAll('button')]
      .find((b) => b.textContent?.includes(longLabel));
    if (!option) throw new Error('no dialog option button rendered');
    expect(option.classList.contains('h-auto')).toBe(true);
    expect(option.classList.contains('max-w-full')).toBe(true);
    expect(option.classList.contains('whitespace-normal')).toBe(true);
    expect(option.classList.contains('text-left')).toBe(true);
    act(() => {
      option.click();
    });
    expect(container.textContent).toContain('answering…');
    expect(option.disabled).toBe(true);
    expect(option.getAttribute('data-pressed')).toBe('true');
    await act(async () => {
      resolveAction!(new Response(
        JSON.stringify({ ok: true, option: longLabel, dialog_gone: true }),
        { status: 200 },
      ));
    });
    expect(container.textContent).toContain(`answered "${longLabel}"`);
  });
});

const LIVE_PLAN = 'Plan: AUDIT with two read-only explorers: one maps citadel cleanup queues, conventions, tests, and dead-code candidates; one maps ops/minipipe plus existing cron/runner and agent-knowledge mechanisms. DESIGN: I will select the smallest evidence-backed first chunks and the thinnest recurring design, then record decisions. BUILD: separate implementers own the cleanup lanes and the recurring runner/skill lane in isolated worktrees. The loop will use bounded chunks, fresh-eyes review, exact-commit gates, and recorded accepted/rejected lessons so later runs improve without uncontrolled self-edits. REVIEW: independent reviewers check behavior preservation, austerity, readability, minimal tests, lore-comment removal, and performance neutrality; no optimization work. GATE: run each repo\'s standard checks on the exact deliverable commits and read gate-verify output. SCHEDULE: dry-run one cycle, then propose cadence and recurring model spend for owner decision. No push, PR, deploy, landing, or recurring paid run without the owner\'s separate word. The first pass will not declare the whole repos pristine; it establishes the verified loop and lands only approved slices.';

const LIVE_PHASES = [
  ['AUDIT', 'with two read-only explorers: one maps citadel cleanup queues, conventions, tests, and dead-code candidates; one maps ops/minipipe plus existing cron/runner and agent-knowledge mechanisms.'],
  ['DESIGN', 'I will select the smallest evidence-backed first chunks and the thinnest recurring design, then record decisions.'],
  ['BUILD', 'separate implementers own the cleanup lanes and the recurring runner/skill lane in isolated worktrees. The loop will use bounded chunks, fresh-eyes review, exact-commit gates, and recorded accepted/rejected lessons so later runs improve without uncontrolled self-edits.'],
  ['REVIEW', 'independent reviewers check behavior preservation, austerity, readability, minimal tests, lore-comment removal, and performance neutrality; no optimization work.'],
  ['GATE', "run each repo's standard checks on the exact deliverable commits and read gate-verify output."],
  ['SCHEDULE', 'dry-run one cycle, then propose cadence and recurring model spend for owner decision.'],
] as const;

const LIVE_GUARDRAILS = [
  "No push, PR, deploy, landing, or recurring paid run without the owner's separate word.",
  'The first pass will not declare the whole repos pristine; it establishes the verified loop and lands only approved slices.',
];

const LIVE_CHECKPOINTS = [
  { id: 'audit', desc: 'two read-only explorers map citadel cleanup queues and recurring mechanisms', etaMin: 15 },
  { id: 'design', desc: 'select the smallest evidence-backed first chunks and thinnest recurring design', etaMin: 10 },
  { id: 'build', desc: 'separate implementers own cleanup and recurring lanes in isolated worktrees', etaMin: 45 },
  { id: 'review', desc: 'independent reviewers check behavior preservation, austerity, readability, and performance neutrality', etaMin: 20 },
  { id: 'gate', desc: "run each repo's standard checks on exact deliverable commits and read gate-verify output", etaMin: 20 },
  { id: 'schedule', desc: 'dry-run one cycle, then propose cadence and recurring model spend for owner decision', etaMin: 10 },
];

describe('needs-ui', () => {
  const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();

  function mountWith(view: HubView): void {
    vi.mocked(fetch).mockImplementation((input: unknown) => {
      const url = String(input);
      if (url.endsWith('api/view')) {
        return Promise.resolve(new Response(JSON.stringify(view), { status: 200 }));
      }
      return new Promise<Response>((resolve) => {
        resolveAction = resolve;
      });
    });
  }

  async function repoll(): Promise<void> {
    await act(async () => {
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'refresh')!.click();
    });
  }

  function button(text: string): HTMLButtonElement {
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === text);
    if (!btn) throw new Error(`no "${text}" button rendered`);
    return btn as HTMLButtonElement;
  }

  function typeInto(input: HTMLInputElement, text: string): void {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  const blockedTask = {
    id: 'demo-1', project: 'demo', asked: iso(400), state: 'blocked',
    updated: iso(300), last_note: 'no API key in the vault', needs_owner: true,
    last_progress_at: iso(300),
  };

  it('a blocked need renders its reason and the Rebrief/Cancel actions', async () => {
    mountWith({ ...VIEW, tasks: [blockedTask] });
    await repoll();
    expect(container.textContent).toContain('demo-1');
    expect(container.textContent).toContain('blocked');
    expect(container.textContent).toContain('no API key in the vault');
    button('Rebrief');
    button('Cancel');
  });

  it('Cancel posts task-resolve and toasts; the card gates while busy', async () => {
    mountWith({ ...VIEW, tasks: [blockedTask] });
    await repoll();
    act(() => {
      button('Cancel').click();
    });
    expect(resolveAction).not.toBeNull();
    expect(container.textContent).toContain('resolving…');
    expect(container.querySelectorAll('button:not(:disabled)')).toHaveLength(1);
    const call = vi.mocked(fetch).mock.calls.find(([i]) => String(i).endsWith('api/task-resolve'));
    expect(JSON.parse(String(call![1]?.body))).toEqual({
      project: 'demo', task: 'demo-1', action: 'cancel',
    });
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });
    expect(container.textContent).toContain('demo-1: cancelled');
  });

  it('Rebrief swaps the buttons for the brief line, and Back abandons it', async () => {
    mountWith({ ...VIEW, tasks: [blockedTask] });
    await repoll();
    act(() => {
      button('Rebrief').click();
    });
    expect(container.querySelector('input[aria-label="new brief for demo-1"]')).not.toBeNull();
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Cancel')).toBe(false);
    act(() => {
      button('Back').click();
    });
    expect(container.querySelector('input[aria-label="new brief for demo-1"]')).toBeNull();
    button('Rebrief');
    button('Cancel');
    expect(vi.mocked(fetch).mock.calls.some(([i]) => String(i).endsWith('api/task-resolve'))).toBe(false);
  });

  it('Rebrief needs a brief and posts it as the note', async () => {
    mountWith({ ...VIEW, tasks: [blockedTask] });
    await repoll();
    act(() => {
      button('Rebrief').click();
    });
    const input = container.querySelector('input[aria-label="new brief for demo-1"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(button('Send').disabled).toBe(true);
    typeInto(input, 'use the staging key');
    const send = button('Send');
    expect(send.disabled).toBe(false);
    act(() => {
      send.click();
    });
    const call = vi.mocked(fetch).mock.calls.find(([i]) => String(i).endsWith('api/task-resolve'));
    expect(JSON.parse(String(call![1]?.body))).toEqual({
      project: 'demo', task: 'demo-1', action: 'rebrief', note: 'use the staging key',
    });
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });
    expect(container.textContent).toContain('back to asked');
  });

  it('a plan need renders its checkpoint list above the verdict buttons', async () => {
    mountWith({
      ...VIEW,
      tasks: [{
        id: 'demo-2', project: 'demo', asked: iso(30), state: 'plan',
        updated: iso(20), last_note: 'ship the docs', needs_owner: true,
        checkpoints: [{ id: 'a', desc: 'write it', etaMin: 5 }, { id: 'b', desc: 'ship it', etaMin: 10 }],
      }],
    });
    await repoll();
    expect(container.querySelector('[data-plan-fallback] p')?.textContent).toBe('ship the docs');
    const checkpoints = container.querySelector('[data-plan-checkpoints]');
    expect(checkpoints?.querySelectorAll('li')).toHaveLength(2);
    expect(checkpoints?.querySelector('[data-checkpoint-id="a"] [data-checkpoint-description]')?.textContent).toBe('write it');
    expect(checkpoints?.querySelector('[data-checkpoint-id="b"] [data-checkpoint-estimate]')?.textContent).toBe('~10m');
    expect(checkpoints!.compareDocumentPosition(button('Approve plan')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    button('Send back');
  });

  it('shows every build contract field and the stored digest before approval', async () => {
    const base = taskContract('/r/demo', ['src', 'docs'], 'Return the bounded artifact.');
    const contract: RootContract = {
      ...base,
      objective: 'Ship the reviewed artifact.',
      consumer: 'release-owner',
      deliverable: 'A reviewed diff and test evidence.',
      acceptance: [{
        id: 'diff', predicate_id: 'git_diff_scope', version: 2, required: true,
        configuration: {
          paths: ['src'], limits: { max_files: 2, review: { required: true, tiers: ['owner', 'peer'] } },
        },
        required_evidence: ['diff-evidence', 'review-evidence'],
      }, {
        id: 'receipt', predicate_id: 'task_receipt', version: 1, required: false,
        configuration: { output_claim: 'A reviewed diff and test evidence.' }, required_evidence: ['receipt-evidence'],
      }],
      provenance: {
        kind: 'code', repository: '/r/demo', base_revision: '0'.repeat(40), artifact_revision: '1'.repeat(40),
      },
      budget: { depth: 2, active_children: 4, active_project_records: 8, attempts: 3, wall_seconds: 900 },
      delegation: { output_claims: ['A reviewed diff and test evidence.', 'A native review.'], adapters: ['tmux', 'native'] },
      required_children: ['demo-4', 'demo-5'], preflight_snapshot: 'preflight-v3', defect_fingerprint: 'repo:base:gate:1',
    };
    const digest = 'd'.repeat(64);
    mountWith({
      ...VIEW,
      tasks: [{
        id: 'demo-2', project: 'demo', asked: iso(30), state: 'plan', updated: iso(20),
        last_note: 'ship the artifact', needs_owner: true, checkpoints: [{ id: 'a', desc: 'write it', etaMin: 5 }],
        contract, plan_digest: digest,
      }],
    });
    await repoll();

    const block = container.querySelector('[data-root-contract]')!;
    for (const text of [
      'Root contract', `Plan digest: ${digest}`, 'Schema: 1', 'Kind: build',
      'Objective: Ship the reviewed artifact.', 'Consumer: release-owner',
      'Deliverable: A reviewed diff and test evidence.',
      'Acceptance diff: git_diff_scope v2', 'Required: true',
      'Configuration: {', '      "limits": {', '        "review": {', '          "required": true',
      '          "tiers": [', '            "owner",', 'Evidence: diff-evidence, review-evidence',
      'Acceptance receipt: task_receipt v1', 'Required: false', '"output_claim": "A reviewed diff and test evidence."',
      'Evidence: receipt-evidence', 'Provenance kind: code', 'Repository: /r/demo',
      `Base revision: ${'0'.repeat(40)}`, `Artifact revision: ${'1'.repeat(40)}`,
      'Write scope: src, docs', 'Action scope: (none)',
      'Budget: depth=2, active_children=4, active_project_records=8, attempts=3, wall_seconds=900',
      'Delegated output claims: A reviewed diff and test evidence., A native review.',
      'Delegated adapters: tmux, native', 'Required children: demo-4, demo-5',
      'Preflight snapshot: preflight-v3', 'Defect fingerprint: repo:base:gate:1',
    ]) expect(block.textContent).toContain(text);
    expect(block.compareDocumentPosition(button('Approve plan')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows research provenance and explicit empty scopes before approval', async () => {
    const base = taskContract('/r/demo', [], 'Return the research report.');
    const contract: RootContract = {
      ...base,
      kind: 'research',
      provenance: {
        kind: 'research',
        source_range: {
          start: 'source:first', end: 'source:last',
          sources: [{
            id: 'source:first', path: 'docs/first.md', sha256: 'a'.repeat(64), observed_at: '2026-11-20T10:00:00.000Z',
          }, {
            id: 'source:last', path: 'docs/last.md', sha256: 'b'.repeat(64), observed_at: '2026-11-20T11:00:00.000Z',
          }],
        },
        evidence_window: { starts_at: '2026-11-20T00:00:00.000Z', ends_at: '2026-11-21T00:00:00.000Z' },
      },
      write_scope: [], action_scope: [],
    };
    mountWith({
      ...VIEW,
      tasks: [{
        id: 'demo-2', project: 'demo', asked: iso(30), state: 'plan', updated: iso(20),
        last_note: 'review the research', needs_owner: true, contract, plan_digest: 'e'.repeat(64),
      }],
    });
    await repoll();

    const block = container.querySelector('[data-root-contract]')!;
    for (const text of [
      'Kind: research', 'Provenance kind: research', 'Source range: source:first → source:last',
      `Source source:first: docs/first.md sha256=${'a'.repeat(64)} observed_at=2026-11-20T10:00:00.000Z`,
      `Source source:last: docs/last.md sha256=${'b'.repeat(64)} observed_at=2026-11-20T11:00:00.000Z`,
      'Evidence window: 2026-11-20T00:00:00.000Z → 2026-11-21T00:00:00.000Z',
      'Write scope: (none)', 'Action scope: (none)',
    ]) expect(block.textContent).toContain(text);
    expect(block.textContent).not.toContain('Repository:');
    expect(block.compareDocumentPosition(button('Approve plan')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('marks a legacy plan with no contract and still shows its stored digest', async () => {
    mountWith({
      ...VIEW,
      tasks: [{
        id: 'demo-2', project: 'demo', asked: iso(30), state: 'plan', updated: iso(20),
        last_note: 'legacy plan', needs_owner: true, plan_digest: 'f'.repeat(64),
      }],
    });
    await repoll();

    expect(container.querySelector('[data-contract-empty]')?.textContent).toBe('No root contract is recorded.');
    expect(container.querySelector('[data-root-contract]')?.textContent).toContain(`Plan digest: ${'f'.repeat(64)}`);
    expect(container.querySelector('[data-root-contract]')!.compareDocumentPosition(button('Approve plan'))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders the live plan as complete headed sections and structured checkpoints', async () => {
    mountWith({
      ...VIEW,
      tasks: [{
        id: 'demo-2', project: 'demo', asked: iso(30), state: 'plan',
        updated: iso(20), last_note: LIVE_PLAN, needs_owner: true, checkpoints: LIVE_CHECKPOINTS,
      }],
    });
    await repoll();

    const plan = container.querySelector('[data-plan]')!;
    expect(container.textContent).not.toContain('Plan:');
    for (const [heading, prose] of LIVE_PHASES) {
      const section = plan.querySelector(`[data-plan-section="${heading}"]`);
      expect(section?.querySelector('h3')?.textContent).toBe(heading);
      expect(section?.querySelector('[data-plan-prose]')?.textContent).toBe(prose);
    }
    expect([...plan.querySelectorAll('[data-plan-guardrails] p')].map((p) => p.textContent)).toEqual(LIVE_GUARDRAILS);
    expect(plan.querySelector('[data-plan-checkpoints] h3')?.textContent).toBe('Checkpoints');
    const rows = [...plan.querySelectorAll('[data-plan-checkpoints] li')];
    expect(rows).toHaveLength(6);
    for (const [index, checkpoint] of LIVE_CHECKPOINTS.entries()) {
      const row = rows[index];
      expect(row.querySelector('[data-checkpoint-number]')?.textContent).toBe(`${index + 1}.`);
      expect(row.querySelector('[data-checkpoint-number]')?.getAttribute('aria-hidden')).toBe('true');
      expect(row.querySelector('[data-checkpoint-id]')?.textContent).toBe(checkpoint.id);
      expect(row.querySelector('[data-checkpoint-description]')?.textContent).toBe(checkpoint.desc);
      expect(row.querySelector('[data-checkpoint-estimate]')?.textContent).toBe(`~${checkpoint.etaMin}m`);
    }
    expect(plan.querySelector('.truncate')).toBeNull();
  });

  it('preserves an unpunctuated trailing fragment in its plan section', async () => {
    mountWith({
      ...VIEW,
      tasks: [{
        id: 'demo-2', project: 'demo', asked: iso(30), state: 'plan',
        updated: iso(20), last_note: 'BUILD: Do work. Ship it', needs_owner: true,
      }],
    });
    await repoll();

    const section = container.querySelector('[data-plan-section="BUILD"]');
    expect(section?.querySelector('h3')?.textContent).toBe('BUILD');
    expect(section?.querySelector('[data-plan-prose]')?.textContent).toBe('Do work. Ship it');
  });

  it('a stale need is marked and its Nudge posts the status message', async () => {
    mountWith({ ...VIEW, tasks: [blockedTask] });
    await repoll();
    expect(container.textContent).toContain('stale');
    act(() => {
      button('Nudge').click();
    });
    expect(container.textContent).toContain('nudging…');
    const call = vi.mocked(fetch).mock.calls.find(([i]) => String(i).endsWith('api/message'));
    expect(JSON.parse(String(call![1]?.body))).toEqual({
      project: 'demo', text: 'demo-1: owner asks for status',
    });
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });
    expect(container.textContent).toContain('asked for status');
  });

  it('the project card renders checkpoint progress, window names, and the attach hint', async () => {
    mountWith({
      ...VIEW,
      projects: [{
        ...VIEW.projects[0],
        orchestrator: { state: 'running', question: false, name: 'demo-orchestrator' },
        agents: [{ name: 'fixer', state: 'running', ref: 'fixer' }],
      }],
      tasks: [{
        id: 'demo-3', project: 'demo', asked: iso(90), state: 'handed',
        updated: iso(10), last_note: null, needs_owner: false,
        checkpoints: [{ id: 'a', desc: 'write it', etaMin: 5 }, { id: 'b', desc: 'ship it', etaMin: 10 }],
        progress: {
          a: { status: 'fail', note: 'red', at: iso(20) },
          b: { status: 'started', at: iso(10) },
        },
        last_progress_at: iso(10),
      }, {
        id: 'demo-4', project: 'demo', asked: iso(200), state: 'done',
        updated: iso(5), last_note: null, needs_owner: false,
        checkpoints: [{ id: 'a', desc: 'write it', etaMin: 5 }],
        progress: { a: { status: 'ok', at: iso(6) } },
        last_progress_at: iso(6),
      }],
    });
    await repoll();
    expect(container.textContent).toContain('1/2 checkpoints');
    expect(container.textContent).toContain('on b');
    expect(container.textContent).toContain('failed: a');
    expect(container.textContent).not.toContain('demo-4');
    expect(container.textContent).toContain('demo:demo-orchestrator');
    expect(container.textContent).toContain('demo:fixer');
    expect(container.textContent).toContain('attach: tmux -L hive-v2 attach');
    expect(container.textContent).not.toContain('select-pane');
  });

  it('attaches to the verified live pane for an aliased project', async () => {
    mountWith({
      ...VIEW,
      projects: [{
        ...VIEW.projects[0],
        name: 'simplification-agent',
        orchestrator: { state: 'running', question: false, name: 'citadel-orchestrator', pane: '%15' },
      }],
    });
    await repoll();
    const hints = [...container.querySelectorAll('div')].map((el) => el.textContent)
      .filter((text) => text?.startsWith('attach: tmux'));
    expect(hints).toEqual(['attach: tmux -L hive-v2 attach -t hive \\; select-window -t %15 \\; select-pane -t %15']);
    expect(container.textContent).not.toContain('hive:simplification-agent:citadel-orchestrator');
  });

  it.each(['unknown', 'stopped'] as const)('uses the generic attach hint for a %s pane', async (state) => {
    mountWith({
      ...VIEW,
      projects: [{
        ...VIEW.projects[0],
        orchestrator: { state, question: false, name: 'citadel-orchestrator', pane: '%15' },
      }],
    });
    await repoll();
    const hints = [...container.querySelectorAll('div')].map((el) => el.textContent)
      .filter((text) => text?.startsWith('attach: tmux'));
    expect(hints).toEqual(['attach: tmux -L hive-v2 attach']);
    expect(container.textContent).not.toContain('select-pane');
  });

  it('a no-team project hides its checkpoint trail and keeps the generic attach hint', async () => {
    mountWith({
      ...VIEW,
      projects: [{ ...VIEW.projects[0], orchestrator: { state: 'none', question: false } }],
      tasks: [{
        id: 'demo-8', project: 'demo', asked: iso(400), state: 'handed',
        updated: iso(300), last_note: null, needs_owner: false,
        checkpoints: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, desc: 'work', etaMin: 5 })),
        last_progress_at: iso(300),
      }],
    });
    await repoll();
    expect(container.textContent).not.toContain('0/5 checkpoints');
    expect(container.textContent).not.toContain('Nudge');
    const hints = [...container.querySelectorAll('div')].map((el) => el.textContent)
      .filter((text) => text?.startsWith('attach: tmux'));
    expect(hints).toEqual(['attach: tmux -L hive-v2 attach']);
  });
});

describe('add project row', () => {
  const repoView: HubView = {
    ...VIEW,
    projects: [{
      ...VIEW.projects[0],
      repos: [
        { folder: '/r/demo', kind: 'repo' },
        { folder: '/r/demo-lane', kind: 'worktree' },
        { folder: '/r/plain', kind: 'folder' },
      ],
    }],
  };

  function button(text: string): HTMLButtonElement {
    return [...container.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement;
  }

  function typeInto(input: HTMLInputElement, text: string): void {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  beforeEach(async () => {
    vi.mocked(fetch).mockImplementation((input: unknown) => {
      if (String(input).endsWith('api/view')) {
        return Promise.resolve(new Response(JSON.stringify(repoView), { status: 200 }));
      }
      return new Promise<Response>((resolve) => { resolveAction = resolve; });
    });
    await act(async () => {
      button('refresh').click();
    });
  });

  it('offers registered repositories and submits a name with an empty source by default', async () => {
    const source = container.querySelector('select[aria-label="new project source"]') as HTMLSelectElement;
    expect([...source.options].map((o) => o.textContent)).toEqual([
      'empty Git repository', '/r/demo', '/r/demo-lane',
    ]);
    expect(source.value).toBe('');
    typeInto(container.querySelector('input[aria-label="new project name"]') as HTMLInputElement, 'fresh');
    expect(button('Add project').disabled).toBe(false);
    act(() => button('Add project').click());
    const call = vi.mocked(fetch).mock.calls.find(([i]) => String(i).endsWith('api/project'));
    expect(JSON.parse(String(call![1]?.body))).toEqual({ name: 'fresh', path: '', source: '' });
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({ ok: true, name: 'fresh', home: '/r/fresh' }), { status: 200 }));
    });
    expect(container.textContent).toContain('fresh: project added (/r/fresh)');
    expect((container.querySelector('input[aria-label="new project name"]') as HTMLInputElement).value).toBe('');
  });

  it('keeps explicit-path submission unchanged and hides the source selector', async () => {
    typeInto(container.querySelector('input[aria-label="new project name"]') as HTMLInputElement, 'existing');
    typeInto(container.querySelector('input[aria-label="new project path"]') as HTMLInputElement, '/r/existing');
    expect(container.querySelector('select[aria-label="new project source"]')).toBeNull();
    act(() => button('Add project').click());
    const call = vi.mocked(fetch).mock.calls.find(([i]) => String(i).endsWith('api/project'));
    expect(JSON.parse(String(call![1]?.body))).toEqual({ name: 'existing', path: '/r/existing' });
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({ ok: true, name: 'existing', home: '/r/existing' }), { status: 200 }));
    });
  });

  it('keeps the name, path, and source draft after an error', async () => {
    const name = container.querySelector('input[aria-label="new project name"]') as HTMLInputElement;
    const folder = container.querySelector('input[aria-label="new project path"]') as HTMLInputElement;
    const source = container.querySelector('select[aria-label="new project source"]') as HTMLSelectElement;
    typeInto(name, 'fresh');
    act(() => {
      source.value = '/r/demo-lane';
      source.dispatchEvent(new Event('change', { bubbles: true }));
    });
    act(() => button('Add project').click());
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({ ok: false, detail: 'workspace failed' }), { status: 400 }));
    });
    expect(name.value).toBe('fresh');
    expect(folder.value).toBe('');
    expect(source.value).toBe('/r/demo-lane');
    expect(container.textContent).toContain('workspace failed');
  });
});

describe('project delete button', () => {
  const noTeamView: HubView = {
    ...VIEW,
    projects: [{ ...VIEW.projects[0], orchestrator: { state: 'none', question: false } }],
  };
  let current = noTeamView;

  function mount(): void {
    current = noTeamView;
    vi.mocked(fetch).mockImplementation((input: unknown) => {
      if (String(input).endsWith('api/view')) {
        return Promise.resolve(new Response(JSON.stringify(current), { status: 200 }));
      }
      return new Promise<Response>((resolve) => {
        resolveAction = resolve;
      });
    });
  }

  async function repoll(): Promise<void> {
    await act(async () => {
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'refresh')!.click();
    });
  }

  function button(text: string): HTMLButtonElement {
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === text);
    if (!btn) throw new Error(`no "${text}" button rendered`);
    return btn as HTMLButtonElement;
  }

  it('appears only for a no-team project with no agents and no pending launch', async () => {
    mount();
    await repoll();
    button('Delete');

    current = { ...noTeamView, projects: [{ ...noTeamView.projects[0], agents: [{ name: 'builder', state: 'stopped' }] }] };
    await repoll();
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Delete')).toBe(false);

    current = {
      ...noTeamView,
      projects: [{
        ...noTeamView.projects[0],
        orchestrator: { state: 'none', starting: { pane: '%9', kind: 'start', at: new Date().toISOString() } },
      }],
    };
    await repoll();
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Delete')).toBe(false);

    current = VIEW;
    await repoll();
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Delete')).toBe(false);
  });

  it('requires confirmation, shows busy state, refreshes, and removes the card', async () => {
    mount();
    await repoll();
    act(() => button('Delete').click());
    expect(vi.mocked(fetch).mock.calls.some(([i]) => String(i).endsWith('api/project-delete'))).toBe(false);
    act(() => button('Delete project?').click());
    expect(container.textContent).toContain('deleting…');
    const call = vi.mocked(fetch).mock.calls.find(([i]) => String(i).endsWith('api/project-delete'));
    expect(JSON.parse(String(call![1]?.body))).toEqual({ project: 'demo' });
    current = { ...noTeamView, projects: [] };
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({ ok: true, name: 'demo' }), { status: 200 }));
    });
    expect(container.textContent).toContain('demo: project deleted');
    expect(container.textContent).toContain('No projects yet');
  });

  it('shows the server error and refreshes without removing the card', async () => {
    mount();
    await repoll();
    act(() => button('Delete').click());
    act(() => button('Delete project?').click());
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({ ok: false, detail: 'demo\'s team is not empty' }), { status: 400 }));
    });
    expect(container.textContent).toContain('demo: demo\'s team is not empty');
    expect(container.textContent).toContain('none yet');
    button('Delete');
  });
});

describe('interrupt buttons', () => {
  const runningView: HubView = {
    ...VIEW,
    projects: [{
      ...VIEW.projects[0],
      orchestrator: { state: 'running', question: false, name: 'demo-orchestrator' },
      agents: [
        { name: 'builder', state: 'running', ref: 'builder' },
        { name: 'fixer', state: 'stopped', ref: 'fixer' },
      ],
    }],
  };

  function mountRunning(): void {
    vi.mocked(fetch).mockImplementation((input: unknown) => {
      if (String(input).endsWith('api/view')) {
        return Promise.resolve(new Response(JSON.stringify(runningView), { status: 200 }));
      }
      return new Promise<Response>((resolve) => {
        resolveAction = resolve;
      });
    });
  }

  async function repoll(): Promise<void> {
    await act(async () => {
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'refresh')!.click();
    });
  }

  function interruptButton(text: string): HTMLButtonElement {
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === text);
    if (!btn) throw new Error(`no "${text}" button rendered`);
    return btn as HTMLButtonElement;
  }

  it('running rows render Interrupt buttons, stopped rows do not', async () => {
    mountRunning();
    await repoll();
    interruptButton('Interrupt');
    interruptButton('Interrupt builder');
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Interrupt fixer')).toBe(false);
  });

  it('the orchestrator Interrupt posts without an agent and gates while busy', async () => {
    mountRunning();
    await repoll();
    act(() => {
      interruptButton('Interrupt').click();
    });
    expect(resolveAction).not.toBeNull();
    const call = vi.mocked(fetch).mock.calls.find(([i]) => String(i).endsWith('api/interrupt'));
    expect(JSON.parse(String(call![1]?.body))).toEqual({ project: 'demo' });
    expect(container.querySelectorAll('button:not(:disabled)')).toHaveLength(1);
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({ ok: true, target: 'demo-orchestrator', pane: '%1' }), { status: 200 }));
    });
    expect(container.textContent).toContain('interrupted demo-orchestrator');
  });

  it('an agent Interrupt posts its ref', async () => {
    mountRunning();
    await repoll();
    act(() => {
      interruptButton('Interrupt builder').click();
    });
    const call = vi.mocked(fetch).mock.calls.find(([i]) => String(i).endsWith('api/interrupt'));
    expect(JSON.parse(String(call![1]?.body))).toEqual({ project: 'demo', agent: 'builder' });
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({ ok: true, target: 'builder', pane: '%2' }), { status: 200 }));
    });
    expect(container.textContent).toContain('interrupted builder');
  });
});

describe('kill button', () => {
  const killView: HubView = {
    ...VIEW,
    projects: [{
      ...VIEW.projects[0],
      orchestrator: { state: 'running', question: false, name: 'demo-orchestrator', children: 2 },
      agents: [],
    }],
  };

  function mountKill(): void {
    vi.mocked(fetch).mockImplementation((input: unknown) => {
      if (String(input).endsWith('api/view')) {
        return Promise.resolve(new Response(JSON.stringify(killView), { status: 200 }));
      }
      return new Promise<Response>((resolve) => {
        resolveAction = resolve;
      });
    });
  }

  async function repoll(): Promise<void> {
    await act(async () => {
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'refresh')!.click();
    });
  }

  function button(text: string): HTMLButtonElement {
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === text);
    if (!btn) throw new Error(`no "${text}" button rendered`);
    return btn as HTMLButtonElement;
  }

  it('shows the cascade size and fires only on the confirm click', async () => {
    mountKill();
    await repoll();
    act(() => {
      button('Kill +2').click();
    });
    expect(vi.mocked(fetch).mock.calls.some(([i]) => String(i).endsWith('api/kill'))).toBe(false);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    act(() => {
      button('Kill +2 for good?').click();
    });
    const call = vi.mocked(fetch).mock.calls.find(([i]) => String(i).endsWith('api/kill'));
    expect(JSON.parse(String(call![1]?.body))).toEqual({ project: 'demo' });
    await act(async () => {
      resolveAction!(new Response(
        JSON.stringify({ ok: true, target: 'demo-orchestrator', killed: ['b1', 'b2', 'demo-orchestrator'], summary: 'killed demo-orchestrator + 2 agents' }),
        { status: 200 },
      ));
    });
    expect(container.textContent).toContain('killed demo-orchestrator + 2 agents');
  });

  it('the second hit of a double-click lands on a disabled confirm', async () => {
    mountKill();
    await repoll();
    act(() => {
      button('Kill +2').click();
    });
    act(() => {
      button('Kill +2 for good?').click();
    });
    expect(vi.mocked(fetch).mock.calls.some(([i]) => String(i).endsWith('api/kill'))).toBe(false);
  });

  it('Back disarms without a post', async () => {
    mountKill();
    await repoll();
    act(() => {
      button('Kill +2').click();
    });
    act(() => {
      button('Back').click();
    });
    button('Kill +2');
    expect(vi.mocked(fetch).mock.calls.some(([i]) => String(i).endsWith('api/kill'))).toBe(false);
  });
});

describe('operator questions', () => {
  const BATCH: QuestionBatch = {
    id: 'batch-1',
    project: 'demo',
    agent: 'builder',
    context: 'Choose the launch setup.',
    status: 'open',
    createdAt: '2026-10-25T10:02:00.000Z',
    questions: [{
      id: 'q1',
      question: 'Which database should we use?',
      context: 'The hub keeps project state.',
      priority: 2,
      recommended: 'c1',
      choices: [
        { id: 'c1', label: 'Postgres', description: 'Use the existing database.' },
        { id: 'c2', label: 'SQLite', description: 'Keep state on this box.' },
      ],
    }, {
      id: 'q2',
      question: 'Which region should we use?',
      context: 'Users sit close to this region.',
      priority: 1,
      recommended: 'c2',
      choices: [
        { id: 'c1', label: 'US West', description: 'Use the west coast.' },
        { id: 'c2', label: 'EU West', description: 'Use the European region.' },
      ],
    }, {
      id: 'q3',
      question: 'When should we launch?',
      context: 'The deploy window starts soon.',
      priority: 1,
      recommended: 'c1',
      choices: [
        { id: 'c1', label: 'Now', description: 'Use the next deploy.' },
        { id: 'c2', label: 'Later', description: 'Wait for another review.' },
      ],
    }],
  };

  function button(text: string): HTMLButtonElement {
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === text);
    if (!btn) throw new Error(`no "${text}" button rendered`);
    return btn as HTMLButtonElement;
  }

  function radio(question: string, choice: string): HTMLInputElement {
    const input = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
      .find((r) => r.name.endsWith(`-${question}`) && r.value === choice);
    if (!input) throw new Error(`no ${choice} radio for ${question}`);
    return input;
  }

  function typeInto(input: HTMLInputElement, text: string): void {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function mountQuestions(view: HubView): (next: HubView) => void {
    let current = view;
    vi.mocked(fetch).mockImplementation((input: unknown) => {
      if (String(input).endsWith('api/view')) {
        return Promise.resolve(new Response(JSON.stringify(current), { status: 200 }));
      }
      return new Promise<Response>((resolve) => {
        resolveAction = resolve;
      });
    });
    return (next) => {
      current = next;
    };
  }

  async function openQuestions(count = 1): Promise<void> {
    await act(async () => {
      button('refresh').click();
    });
    act(() => {
      button(`Questions ${count}`).click();
    });
  }

  it('shows actionable question cards on the main screen and answers inline', async () => {
    const update = mountQuestions({ ...VIEW, questions: [BATCH] });
    await act(async () => {
      button('refresh').click();
    });
    expect(container.textContent).toContain(BATCH.context);
    expect(container.textContent).toContain(BATCH.questions[0].question);

    act(() => {
      button('Submit').click();
    });
    const call = vi.mocked(fetch).mock.calls.find(([i]) => String(i).endsWith('api/questions/answer'));
    expect(JSON.parse(String(call![1]?.body))).toEqual({
      id: 'batch-1',
      answers: [
        { question: 'q2', choice: 'c2' },
        { question: 'q3', choice: 'c1' },
        { question: 'q1', choice: 'c1' },
      ],
    });
    update({ ...VIEW, questions: [] });
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });
    expect(container.textContent).not.toContain(BATCH.context);
  });

  it('shows the count, lists oldest batches first, and returns to the hub', async () => {
    mountQuestions({
      ...VIEW,
      questions: [BATCH, { ...BATCH, id: 'batch-2', context: 'Older batch.', createdAt: '2026-10-25T10:01:00.000Z' }],
    });
    await openQuestions(2);
    expect(container.textContent).toContain('demo · builder');
    expect(container.textContent).toContain(BATCH.createdAt);
    expect(container.textContent!.indexOf('Older batch.')).toBeLessThan(container.textContent!.indexOf(BATCH.context));
    act(() => {
      button('back').click();
    });
    button('Questions 2');
  });

  it('sorts by priority with stable ties and preselects recommended choices', async () => {
    mountQuestions({ ...VIEW, questions: [BATCH] });
    await openQuestions();
    const text = container.textContent!;
    expect(text.indexOf(BATCH.questions[1].question)).toBeLessThan(text.indexOf(BATCH.questions[2].question));
    expect(text.indexOf(BATCH.questions[2].question)).toBeLessThan(text.indexOf(BATCH.questions[0].question));
    expect(text).toContain('P1');
    expect(text).toContain('P2');
    expect(radio('q1', 'c1').checked).toBe(true);
    expect(radio('q2', 'c2').checked).toBe(true);
    expect(radio('q3', 'c1').checked).toBe(true);
    expect([...container.querySelectorAll('span')].filter((s) => s.textContent === 'Recommended')).toHaveLength(3);
  });

  it('requires Other text only while Other is selected', async () => {
    mountQuestions({ ...VIEW, questions: [BATCH] });
    await openQuestions();
    expect(button('Submit').disabled).toBe(false);
    act(() => {
      radio('q1', 'other').click();
    });
    const other = container.querySelector('input[aria-label="Other answer for q1"]') as HTMLInputElement;
    expect(other.required).toBe(true);
    expect(other.maxLength).toBe(4000);
    expect(button('Submit').disabled).toBe(true);
    typeInto(other, '   ');
    expect(button('Submit').disabled).toBe(true);
    typeInto(other, 'DynamoDB');
    expect(button('Submit').disabled).toBe(false);
    act(() => {
      radio('q1', 'c1').click();
    });
    expect(other.required).toBe(false);
    expect(button('Submit').disabled).toBe(false);
  });

  it('posts every answer in display order and removes the closed batch on refresh', async () => {
    const update = mountQuestions({ ...VIEW, questions: [BATCH] });
    await openQuestions();
    act(() => {
      button('Submit').click();
    });
    const call = vi.mocked(fetch).mock.calls.find(([i]) => String(i).endsWith('api/questions/answer'));
    expect(JSON.parse(String(call![1]?.body))).toEqual({
      id: 'batch-1',
      answers: [
        { question: 'q2', choice: 'c2' },
        { question: 'q3', choice: 'c1' },
        { question: 'q1', choice: 'c1' },
      ],
    });
    update({ ...VIEW, questions: [] });
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });
    expect(container.textContent).not.toContain(BATCH.context);
    expect(container.textContent).toContain('No open questions.');
  });

  it('keeps the draft and shows the error after a failed answer', async () => {
    mountQuestions({ ...VIEW, questions: [BATCH] });
    await openQuestions();
    act(() => {
      radio('q1', 'other').click();
      radio('q2', 'c1').click();
    });
    const other = container.querySelector('input[aria-label="Other answer for q1"]') as HTMLInputElement;
    typeInto(other, 'DynamoDB');
    act(() => {
      button('Submit').click();
    });
    const call = vi.mocked(fetch).mock.calls.find(([i]) => String(i).endsWith('api/questions/answer'));
    expect(JSON.parse(String(call![1]?.body))).toEqual({
      id: 'batch-1',
      answers: [
        { question: 'q2', choice: 'c1' },
        { question: 'q3', choice: 'c1' },
        { question: 'q1', choice: 'other', text: 'DynamoDB' },
      ],
    });
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({ ok: false, detail: 'batch is already answered' }), { status: 400 }));
    });
    expect(other.value).toBe('DynamoDB');
    expect(radio('q1', 'other').checked).toBe(true);
    expect(radio('q2', 'c1').checked).toBe(true);
    expect(container.textContent).toContain('batch is already answered');
  });

  it('arms cancel without posting, then posts only the batch id', async () => {
    const update = mountQuestions({ ...VIEW, questions: [BATCH] });
    await openQuestions();
    act(() => {
      button('Cancel batch').click();
    });
    expect(vi.mocked(fetch).mock.calls.some(([i]) => String(i).endsWith('api/questions/cancel'))).toBe(false);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    update({ ...VIEW, questions: [] });
    act(() => {
      button('Cancel batch?').click();
    });
    const call = vi.mocked(fetch).mock.calls.find(([i]) => String(i).endsWith('api/questions/cancel'));
    expect(JSON.parse(String(call![1]?.body))).toEqual({ id: 'batch-1' });
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });
    expect(container.textContent).toContain('No open questions.');
  });

  it('keeps open batches when a status read fails', async () => {
    const update = mountQuestions({ ...VIEW, questions: [BATCH] });
    await openQuestions();
    update({ ...VIEW, questions: [], updatedAt: 0, error: 'the status read failed' });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r' }));
    });
    expect(container.textContent).toContain(BATCH.context);
  });
});
