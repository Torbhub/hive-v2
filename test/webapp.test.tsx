import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubView, QuestionBatch, RootContract } from '../src/types.js';
import { taskContract } from './task-contract.js';
import { readRoute, routeUrl } from '../web/routes';
import { apiPath } from '../web/api';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as Record<string, unknown>).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

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
  window.history.replaceState({}, '', '/');
  resolveAction = null;
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
  })));
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

async function openProject(name = 'demo', tab?: 'Activity' | 'Team' | 'Settings'): Promise<void> {
  const link = container.querySelector(`[data-project-name="${name}"]`) as HTMLAnchorElement;
  await act(async () => link.click());
  if (tab) {
    const trigger = [...container.querySelectorAll('button')].find((button) => button.textContent === tab.toLowerCase());
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
      trigger?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
      trigger?.click();
    });
  }
}

async function openHome(): Promise<void> {
  const link = [...container.querySelectorAll('a')].find((candidate) => candidate.textContent === 'Needs you');
  await act(async () => link?.click());
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
    expect(stretchSpan('why').parentElement?.classList.contains('truncate')).toBe(false);
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

describe('task presets', () => {
  beforeEach(async () => openProject());
  it('lists the six workflows and explains why Encord and SieveData are disabled', () => {
    const summary = [...container.querySelectorAll('summary')].find((item) => item.textContent === 'Preset');
    expect(summary).toBeDefined();
    act(() => summary!.click());
    const options = [...container.querySelectorAll('button[data-task-preset]')];
    expect(options.map((option) => option.textContent)).toEqual([
      'Appen — mostly processedProcess selected recordings into Appen’s processed MCAP episode drop under a chosen destination. Optionally force task difficulty to hard.',
      'Turing / OpenAIBuild and validate a Turing delivery drop with registry-issued sequential episode IDs, configured chunking, and any required calibration packages.',
      'PixelsTwo — raw session transferCopy complete selected sessions—all raw MCAP files plus session.json—to the configured PixelsTwo R2 destination. Do not annotate or rebake.',
      'Shrink anythingRun verified cuts on a GitHub-hosted runner after approval. Open a pull request and upload the report and judgment task.',
      'Encord — sample curationHistorical workflow for selecting and reviewing 20–30 minute clips and preparing transcode/crop work. Requires a source set, destination, and output contract.',
      'SieveDataNot configured. No job contract is defined yet.',
    ]);
    expect(options.map((option) => option.disabled)).toEqual([false, false, false, false, true, true]);
  });

  it.each([
    {
      label: 'Appen — mostly processed',
      profile: 'sellable_raw_mostly_processed',
      placeholders: ['[REQUIRED SELECTED RECORDINGS]', '[REQUIRED DESTINATION PREFIX]', '[OPTIONAL YES OR NO]'],
    },
    {
      label: 'Turing / OpenAI',
      profile: 'turing_openai',
      placeholders: ['[REQUIRED DESTINATION]', '[REQUIRED VENDOR CODE]', '[REQUIRED REGISTRY]'],
    },
    {
      label: 'PixelsTwo — raw session transfer',
      profile: '',
      placeholders: ['[REQUIRED SOURCE]', '[REQUIRED R2 DESTINATION]'],
    },
    {
      label: 'Shrink anything',
      profile: '',
      placeholders: [
        '[REQUIRED OWNER/REPOSITORY]', '[REQUIRED BASE BRANCH]',
        '[REQUIRED 40-CHARACTER COMMIT]', '[REQUIRED CHECK COMMAND]',
      ],
    },
  ])('inserts $label as an editable draft without submitting it', ({ label, profile, placeholders }) => {
    act(() => {
      ([...container.querySelectorAll('summary')].find((item) => item.textContent === 'Preset') as HTMLElement).click();
    });
    act(() => {
      (container.querySelector(`button[data-task-preset="${label}"]`) as HTMLButtonElement).click();
    });
    const input = container.querySelector('textarea[aria-label="new task for demo"]') as HTMLInputElement;
    for (const placeholder of placeholders) expect(input.value).toContain(placeholder);
    if (profile) expect(input.value).toContain(`minipipe profile ${profile}`);
    if (label === 'Shrink anything') {
      expect(input.value).toContain('@el4cteo/shrink-anything from the published npm package');
      expect(input.value).toContain('Do not vendor upstream source.');
      expect(input.value).toContain('Do not merge the target pull request without my approval.');
    }
    expect(input.value).toContain('First present a plan for my approval.');
    expect(input.value).toContain('After approval, use normal Hive execution.');
    expect(document.activeElement).toBe(input);
    expect(vi.mocked(fetch).mock.calls.filter(([target]) => !String(target).endsWith('api/view'))).toHaveLength(0);
  });

  it('preserves arbitrary task text when a preset is inserted', () => {
    const input = container.querySelector('textarea[aria-label="new task for demo"]') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, 'keep this arbitrary task');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      ([...container.querySelectorAll('summary')].find((item) => item.textContent === 'Preset') as HTMLElement).click();
    });
    act(() => {
      (container.querySelector('button[data-task-preset="PixelsTwo — raw session transfer"]') as HTMLButtonElement).click();
    });
    expect(input.value).toMatch(/^keep this arbitrary task Copy complete selected sessions/);
    expect(vi.mocked(fetch).mock.calls.filter(([target]) => !String(target).endsWith('api/view'))).toHaveLength(0);
  });
});

describe('instant click feedback', () => {
  beforeEach(async () => openProject());
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
    expect([...container.querySelectorAll('button')].find((button) => button.textContent === 'refresh')?.disabled).toBe(false);
    expect(startBtn.disabled).toBe(true);
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({ ok: true, pane: '%1' }), { status: 200 }));
    });
    expect(container.textContent).toContain('demo-orchestrator is coming up');
    expect(container.textContent).not.toContain('%1');
  });

  it('a typed task enables Start task, and clicking it swaps the row to starting… before the fetch resolves', async () => {
    const input = container.querySelector('textarea[aria-label="new task for demo"]') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
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
    expect(container.querySelector('textarea[aria-label="new task for demo"]')).toBeNull();
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({ ok: true, id: 'demo-1' }), { status: 200 }));
    });
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({ ok: true, pane: '%1' }), { status: 200 }));
    });
    expect(container.textContent).toContain('demo-orchestrator is coming up on demo-1');
    expect(container.textContent).not.toContain('%1');
  });

  it('a task sent to a running orchestrator opens a durable result and registers once', async () => {
    const input = container.querySelector('textarea[aria-label="new task for demo"]') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
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
    expect(container.textContent).toContain('demo-1 was sent to demo-orchestrator');
    expect(container.querySelector('[data-testid="task-view-demo-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="task-delivery-state"]')?.textContent).toContain('The running orchestrator received the task.');
    expect(container.textContent).toContain('write the docs');
    expect(container.querySelector('textarea[aria-label="new task for demo"]')).toBeNull();
    expect(window.location.pathname).toBe('/projects/demo/tasks/demo-1');
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
    await openHome();
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
    button('Cancel task');
  });

  it('Cancel posts task-resolve and toasts; the card gates while busy', async () => {
    mountWith({ ...VIEW, tasks: [blockedTask] });
    await repoll();
    act(() => button('Cancel task').click());
    expect(resolveAction).toBeNull();
    expect(container.textContent).toContain('Cancellation closes this task.');
    act(() => button('Cancel demo-1?').click());
    expect(resolveAction).not.toBeNull();
    expect(container.textContent).toContain('resolving · demo');
    expect(button('refresh').disabled).toBe(false);
    expect(container.querySelector('[data-project-name="demo"]')).not.toBeNull();
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
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Cancel task')).toBe(false);
    act(() => {
      button('Back').click();
    });
    expect(container.querySelector('input[aria-label="new brief for demo-1"]')).toBeNull();
    button('Rebrief');
    button('Cancel task');
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
    expect(input.value).toBe('use the staging key');
    const send = [...input.closest('form')!.querySelectorAll('button')]
      .find((b) => b.textContent === 'Send') as HTMLButtonElement;
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

  it('a plan need renders verdict actions before expandable checkpoints', async () => {
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
    expect(container.querySelector('[data-plan-summary]')).not.toBeNull();
    expect(container.querySelector('[data-plan-disclosure]')?.hasAttribute('open')).toBe(false);
    expect(button('Approve plan').compareDocumentPosition(checkpoints!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    button('Send back');
  });

  it('returns from send-back feedback without losing the draft', async () => {
    mountWith({
      ...VIEW,
      tasks: [{
        id: 'demo-2', project: 'demo', asked: iso(30), state: 'plan', updated: iso(20),
        last_note: 'ship the docs', needs_owner: true, checkpoints: [],
      }],
    });
    await repoll();
    act(() => button('Send back').click());
    const input = container.querySelector('input[placeholder="what should change? (optional)"]') as HTMLInputElement;
    typeInto(input, 'add more evidence');
    act(() => button('Back').click());
    act(() => button('Send back').click());
    expect((container.querySelector('input[placeholder="what should change? (optional)"]') as HTMLInputElement).value).toBe('add more evidence');
  });

  it('keeps every build contract field and the stored digest in expandable detail', async () => {
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
    expect(button('Approve plan').compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    expect(button('Approve plan').compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    expect(button('Approve plan').compareDocumentPosition(container.querySelector('[data-root-contract]')!)
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
    expect(container.textContent).toContain('nudging · demo');
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
    await openProject();
    expect(container.textContent).toContain('1/2 checkpoints');
    expect(container.textContent).toContain('on b');
    expect(container.textContent).toContain('failed: a');
    expect(container.textContent).toContain('demo-4');
    await openProject('demo', 'Team');
    expect(container.textContent).toContain('demo:demo-orchestrator');
    expect(container.textContent).toContain('demo:fixer');
    expect(container.textContent).toContain('attach: tmux -L hive-v2 attach');
    expect(container.textContent).not.toContain('select-pane');
  });

  it('continue message names the orchestrator without a pane id', async () => {
    mountWith({
      ...VIEW,
      projects: [{
        ...VIEW.projects[0],
        orchestrator: {
          state: 'none', name: 'demo-orchestrator',
          starting: { pane: '%9', kind: 'start', at: new Date().toISOString() },
        },
      }],
    });
    await repoll();
    act(() => button('Continue').click());
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({ ok: true, pane: '%9' }), { status: 200 }));
    });
    expect(container.textContent).toContain("demo-orchestrator's first line was sent");
    expect(container.textContent).not.toContain('%9');
  });

  it('wake toast uses the orchestrator name registered by the action', async () => {
    mountWith({
      ...VIEW,
      projects: [{
        ...VIEW.projects[0],
        name: 'simplification-agent',
        orchestrator: { state: 'stopped', question: false, name: 'citadel-orchestrator', session_id: 'session_x' },
      }],
    });
    await repoll();
    await openProject('simplification-agent');
    act(() => resumeButton().click());
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({
        ok: true, pane: '%15', name: 'simplification-agent-orchestrator',
      }), { status: 200 }));
    });
    const toast = container.querySelector('[data-sonner-toast]');
    expect(toast?.textContent).toContain('simplification-agent-orchestrator');
    expect(toast?.textContent).not.toContain('citadel-orchestrator');
  });

  it('attaches to the named window for an aliased project', async () => {
    mountWith({
      ...VIEW,
      projects: [{
        ...VIEW.projects[0],
        name: 'simplification-agent',
        orchestrator: { state: 'running', question: false, name: 'citadel-orchestrator', pane: '%15' },
      }],
    });
    await repoll();
    await openProject('simplification-agent', 'Team');
    const hints = [...container.querySelectorAll('div')].map((el) => el.textContent)
      .filter((text) => text?.startsWith('attach:'));
    expect(hints).toEqual(['attach: hive attach simplification-agent']);
    expect(container.textContent).not.toContain('%15');
  });

  it('unregistered orchestrator label omits the pane id', async () => {
    mountWith({
      ...VIEW,
      projects: [{
        ...VIEW.projects[0],
        orchestrator: { state: 'unregistered', question: false, name: 'demo-orchestrator', pane: '%11' },
      }],
    });
    await repoll();
    await openProject();
    expect(container.textContent).toContain('demo-orchestrator');
    expect(container.textContent).not.toContain('%11');
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
    await openProject('demo', 'Team');
    if (state === 'unknown') {
      expect(container.textContent).toContain('Orchestrator state unknown');
      button('Copy tmux attach');
    }
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
    await openProject();
    expect(container.textContent).not.toContain('0/5 checkpoints');
    expect(container.textContent).not.toContain('Nudge');
    await openProject('demo', 'Team');
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
    return [...document.querySelectorAll('button')].filter((b) => b.textContent === text).at(-1) as HTMLButtonElement;
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
    act(() => button('Add project').click());
  });

  it('offers registered repositories and submits a name with an empty source by default', async () => {
    const source = document.querySelector('select[aria-label="new project source"]') as HTMLSelectElement;
    expect([...source.options].map((o) => o.textContent)).toEqual([
      'empty Git repository', '/r/demo', '/r/demo-lane',
    ]);
    expect(source.value).toBe('');
    expect(document.querySelector('label[for="new-project-name"]')?.textContent).toBe('Name');
    expect(document.querySelector('label[for="new-project-path"]')?.textContent).toBe('Absolute path');
    expect(document.querySelector('label[for="new-project-source"]')?.textContent).toBe('Source');
    expect(document.querySelectorAll('[data-slot="dialog-title"]')).toHaveLength(1);
    expect(document.querySelector('[data-slot="dialog-title"]')?.textContent).toBe('Add project');
    expect(document.querySelector('[data-slot="field-legend"]')).toBeNull();
    typeInto(document.querySelector('input[aria-label="new project name"]') as HTMLInputElement, 'fresh');
    expect(button('Add project').disabled).toBe(false);
    expect(button('Add project').getAttribute('data-variant')).toBe('default');
    act(() => button('Add project').click());
    const call = vi.mocked(fetch).mock.calls.find(([i]) => String(i).endsWith('api/project'));
    expect(JSON.parse(String(call![1]?.body))).toEqual({ name: 'fresh', path: '', source: '' });
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({ ok: true, name: 'fresh', home: '/r/fresh' }), { status: 200 }));
    });
    expect(container.textContent).toContain('fresh: project added (/r/fresh)');
    expect(document.querySelector('input[aria-label="new project name"]')).toBeNull();
    expect(window.location.pathname).toBe('/projects/fresh');
  });

  it('keeps explicit-path submission unchanged and hides the source selector', async () => {
    typeInto(document.querySelector('input[aria-label="new project name"]') as HTMLInputElement, 'existing');
    typeInto(document.querySelector('input[aria-label="new project path"]') as HTMLInputElement, '/r/existing');
    expect(document.querySelector('select[aria-label="new project source"]')).toBeNull();
    act(() => button('Add project').click());
    const call = vi.mocked(fetch).mock.calls.find(([i]) => String(i).endsWith('api/project'));
    expect(JSON.parse(String(call![1]?.body))).toEqual({ name: 'existing', path: '/r/existing' });
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({ ok: true, name: 'existing', home: '/r/existing' }), { status: 200 }));
    });
  });

  it('keeps the name, path, and source draft after an error', async () => {
    const name = document.querySelector('input[aria-label="new project name"]') as HTMLInputElement;
    const folder = document.querySelector('input[aria-label="new project path"]') as HTMLInputElement;
    const source = document.querySelector('select[aria-label="new project source"]') as HTMLSelectElement;
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
  beforeEach(async () => openProject('demo', 'Settings'));
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
    button('Remove project from Hive');

    current = { ...noTeamView, projects: [{ ...noTeamView.projects[0], agents: [{ name: 'builder', state: 'stopped' }] }] };
    await repoll();
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Remove project from Hive')).toBe(false);

    current = {
      ...noTeamView,
      projects: [{
        ...noTeamView.projects[0],
        orchestrator: { state: 'none', starting: { pane: '%9', kind: 'start', at: new Date().toISOString() } },
      }],
    };
    await repoll();
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Remove project from Hive')).toBe(false);

    current = VIEW;
    await repoll();
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Remove project from Hive')).toBe(false);
  });

  it('requires confirmation, shows busy state, refreshes, and removes the card', async () => {
    mount();
    await repoll();
    act(() => button('Remove project from Hive').click());
    expect(vi.mocked(fetch).mock.calls.some(([i]) => String(i).endsWith('api/project-delete'))).toBe(false);
    expect(container.textContent).toContain('Local Git files and task records remain untouched.');
    act(() => button('Remove from Hive?').click());
    expect(container.textContent).toContain('removing from Hive…');
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
    act(() => button('Remove project from Hive').click());
    act(() => button('Remove from Hive?').click());
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({ ok: false, detail: 'demo\'s team is not empty' }), { status: 400 }));
    });
    expect(container.textContent).toContain('demo: demo\'s team is not empty');
    await openProject();
    expect(container.textContent).toContain('none yet');
    await openProject('demo', 'Settings');
    button('Remove project from Hive');
  });
});

describe('interrupt buttons', () => {
  beforeEach(async () => openProject());
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
    await openProject('demo', 'Team');
    interruptButton('Interrupt');
    await openProject();
    interruptButton('Interrupt builder');
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Interrupt fixer')).toBe(false);
  });

  it('the orchestrator Interrupt posts without an agent and gates while busy', async () => {
    mountRunning();
    await repoll();
    await openProject('demo', 'Team');
    act(() => {
      interruptButton('Interrupt').click();
    });
    expect(resolveAction).not.toBeNull();
    const call = vi.mocked(fetch).mock.calls.find(([i]) => String(i).endsWith('api/interrupt'));
    expect(JSON.parse(String(call![1]?.body))).toEqual({ project: 'demo' });
    expect([...container.querySelectorAll('button')].find((button) => button.textContent === 'refresh')?.disabled).toBe(false);
    expect(interruptButton('Interrupt').disabled).toBe(true);
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
  beforeEach(async () => openProject('demo', 'Team'));
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


describe('journey states', () => {
  it('round-trips deep links and keeps production API paths under Hive', () => {
    window.history.replaceState({}, '', '/hive/projects/demo/tasks/demo-1');
    expect(readRoute()).toEqual({ name: 'task', project: 'demo', task: 'demo-1' });
    expect(routeUrl({ name: 'project', project: 'demo', tab: 'team' })).toBe('/hive/projects/demo?tab=team');
    expect(apiPath('api/view')).toBe('/hive/api/view');
    expect(apiPath('/api/task')).toBe('/hive/api/task');
  });

  it('uses a branded loading shell and replaces an initial failure with Retry', async () => {
    act(() => root.unmount());
    vi.mocked(fetch).mockImplementation(() => Promise.reject(new Error('connection refused')));
    const { App } = await import('../web/App');
    root = createRoot(container);
    await act(async () => root.render(<App />));
    expect(container.querySelector('[data-testid="hive-error-shell"]')).not.toBeNull();
    expect(container.textContent).toContain('Could not load projects');
    expect(container.textContent).toContain('connection refused');
    expect(container.textContent).not.toContain('Reading projects…');
    expect(container.textContent).toContain('hive');
    expect(container.textContent).toContain('Opening through Nexus');
    expect([...container.querySelectorAll('a')].some((link) => link.textContent === 'Back to Nexus')).toBe(true);
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'Retry')).toBe(true);
  });

  it('labels retained data as stale after a failed refresh', async () => {
    vi.mocked(fetch).mockImplementation(() => Promise.reject(new Error('relay offline')));
    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'refresh')!.click();
    });
    expect(container.querySelector('[aria-label="Stale data"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Live data"]')).toBeNull();
    expect(container.textContent).toContain('Showing data from');
    expect(container.textContent).toContain('relay offline');
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'Retry')).toBe(true);
  });

  it('disables messaging without a running orchestrator and explains why', async () => {
    await openProject('demo', 'Activity');
    const input = container.querySelector('input[aria-label="message for demo"]') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    expect(container.textContent).toContain('Start or resume the orchestrator to send a message.');
  });

  it('links every project task, including tasks without checkpoints', async () => {
    const tasks: HubView['tasks'] = [{
      id: 'demo-plain', project: 'demo', asked: new Date().toISOString(), state: 'asked', updated: new Date().toISOString(),
      brief: 'Ship the unplanned task', last_note: null, needs_owner: false,
    }, {
      id: 'demo-planned', project: 'demo', asked: new Date().toISOString(), state: 'handed', updated: new Date().toISOString(),
      last_note: null, needs_owner: false, checkpoints: [{ id: 'build', desc: 'Build it', etaMin: 2 }],
    }];
    vi.mocked(fetch).mockImplementation((input: unknown) => {
      if (String(input).endsWith('api/view')) return Promise.resolve(new Response(JSON.stringify({ ...VIEW, tasks }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });
    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'refresh')!.click();
    });
    await openProject();
    const inventory = container.querySelector('[data-testid="task-inventory"]')!;
    expect(inventory.querySelectorAll('[data-task-id]')).toHaveLength(2);
    expect(inventory.querySelector('[data-task-id="demo-plain"]')?.getAttribute('href')).toBe('/projects/demo/tasks/demo-plain');
    expect(inventory.textContent).toContain('Ship the unplanned task');
    expect(inventory.textContent).toContain('No checkpoints recorded');
    expect(inventory.textContent).toContain('No agent recorded');
    expect(container.textContent).toContain('Permissions ask · Approvals manual');
    const search = container.querySelector('input[aria-label="Search tasks for demo"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(search, 'demo-planned');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelectorAll('[data-testid="task-inventory"] [data-task-id]')).toHaveLength(1);
    expect(container.querySelector('[data-task-id="demo-plain"]')).toBeNull();
  });

  it('answers raw question choices directly through the existing message API', async () => {
    const questionView: HubView = {
      ...VIEW,
      tasks: [{
        id: 'demo-question', project: 'demo', asked: new Date().toISOString(), state: 'question', updated: new Date().toISOString(),
        last_note: 'Options: A) close the old task. B) run the scan anyway. Which?', needs_owner: true,
      }],
    };
    vi.mocked(fetch).mockImplementation((input: unknown) => {
      if (String(input).endsWith('api/view')) return Promise.resolve(new Response(JSON.stringify(questionView), { status: 200 }));
      return new Promise<Response>((resolve) => { resolveAction = resolve; });
    });
    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'refresh')!.click();
    });
    const option = [...container.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Option A'));
    expect(option?.textContent).toContain('close the old task');
    act(() => option!.click());
    const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith('api/message'));
    expect(JSON.parse(String(call![1]?.body))).toEqual({ project: 'demo', text: 'demo-question: A' });
    await act(async () => resolveAction!(new Response(JSON.stringify({ ok: true }), { status: 200 })));
  });

  it('uses verified supersession to close approval and open the replacement', async () => {
    const tasks: HubView['tasks'] = [{
      id: 'demo-old', project: 'demo', asked: new Date().toISOString(), state: 'superseded', updated: new Date().toISOString(),
      last_note: null, needs_owner: false, superseded_by: 'demo-new',
    }, {
      id: 'demo-new', project: 'demo', asked: new Date().toISOString(), state: 'asked', updated: new Date().toISOString(),
      brief: 'Replacement task', last_note: null, needs_owner: false,
    }];
    vi.mocked(fetch).mockImplementation((input: unknown) => {
      if (String(input).endsWith('api/view')) return Promise.resolve(new Response(JSON.stringify({ ...VIEW, tasks }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });
    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'refresh')!.click();
    });
    await openProject();
    await act(async () => (container.querySelector('[data-task-id="demo-old"]') as HTMLAnchorElement).click());
    expect(container.querySelector('[data-testid="superseded-task"]')?.textContent).toContain('Superseded by demo-new. Approval is closed.');
    expect(container.textContent).not.toContain('Approve plan');
    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'Open replacement')!.click();
    });
    expect(window.location.pathname).toBe('/projects/demo/tasks/demo-new');
    expect(container.textContent).toContain('Replacement task');
  });

  it('guards stale archive and posts only the selected stale task IDs', async () => {
    const old = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    const staleBatch: QuestionBatch = {
      id: 'stale-batch', project: 'demo', agent: 'builder', context: 'old question', createdAt: old, status: 'open', questions: [],
    };
    const staleView: HubView = {
      ...VIEW,
      tasks: [{
        id: 'demo-stale', project: 'demo', asked: old, state: 'plan', updated: old,
        last_note: 'old plan', needs_owner: true, checkpoints: [{ id: 'a', desc: 'old work', etaMin: 1 }],
      }],
      questions: [staleBatch],
    };
    vi.mocked(fetch).mockImplementation((input: unknown) => {
      if (String(input).endsWith('api/view')) return Promise.resolve(new Response(JSON.stringify(staleView), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ ok: true, archived: ['demo-stale'] }), { status: 200 }));
    });
    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'refresh')!.click();
    });
    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'stale')!.click();
    });
    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'Archive stale')!.click();
    });
    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'Archive 2 stale items?')!.click();
    });
    const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith('api/tasks-archive'));
    expect(JSON.parse(String(call![1]?.body))).toEqual({ project: 'demo', tasks: ['demo-stale'] });
    const questionCall = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith('api/questions/cancel'));
    expect(JSON.parse(String(questionCall![1]?.body))).toEqual({ id: staleBatch.id });
  });
});

describe('dashboard shell', () => {
  it('shows one project at a time with navigation and a team graph', async () => {
    const projects = ['alpha', 'beta'].map((name) => ({
      ...VIEW.projects[0], name, home: `/r/${name}`,
      orchestrator: { state: 'running' as const, question: false, name: `${name}-orchestrator`, session_id: `session_${name}`, context: 3 },
      agents: [{ name: 'builder', state: 'running' as const, ref: 'builder', session_id: `session_${name}_builder` }],
    }));
    vi.mocked(fetch).mockImplementation((input: unknown) => {
      if (String(input).endsWith('api/view')) {
        return Promise.resolve(new Response(JSON.stringify({ ...VIEW, projects }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });
    await act(async () => {
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'refresh')!.click();
    });
    expect(container.querySelector('[data-testid="needs-home"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="project-nav"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid^="project-card-"]')).toHaveLength(0);
    const alpha = container.querySelector('[data-project-name="alpha"]') as HTMLAnchorElement;
    const beta = container.querySelector('[data-project-name="beta"]') as HTMLAnchorElement;
    expect(alpha.getAttribute('data-active')).toBe('false');
    expect(beta.getAttribute('data-active')).toBe('false');
    await act(async () => alpha.click());
    expect(container.querySelectorAll('[data-testid^="project-card-"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="project-card-alpha"]')).not.toBeNull();
    expect(alpha.getAttribute('data-active')).toBe('true');
    await openProject('alpha', 'Team');
    expect(container.querySelector('[data-testid="team-map"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="team-map"]')?.textContent).toContain('builder');
    expect(container.textContent).toContain('3% context');
    await act(async () => beta.click());
    expect(container.querySelectorAll('[data-testid^="project-card-"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="project-card-beta"]')).not.toBeNull();
    expect(alpha.getAttribute('data-active')).toBe('false');
    expect(beta.getAttribute('data-active')).toBe('true');
    expect(window.location.pathname).toBe('/projects/beta');
    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[data-testid="project-card-alpha"]')).not.toBeNull();
  });
});
