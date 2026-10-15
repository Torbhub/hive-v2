// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubView } from '../src/types.js';

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
    // A collapse records nothing.
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
  it('the moment Resume is clicked the card shows resuming… and all other action buttons disable', async () => {
    const startBtn = [...container.querySelectorAll('button')]
      .find((b) => b.textContent === 'Start task') as HTMLButtonElement;
    expect(startBtn.disabled).toBe(true); // empty input disables it
    const resume = resumeButton();
    act(() => {
      resume.click();
    });
    // The action fetch is still in flight; feedback is already visible.
    expect(resolveAction).not.toBeNull();
    expect(container.textContent).toContain('resuming…');
    expect(container.querySelectorAll('button:not(:disabled)')).toHaveLength(1); // only refresh stays live
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
    // two POSTs: task then start; resolve both
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({ ok: true, id: 'demo-1' }), { status: 200 }));
    });
    await act(async () => {
      resolveAction!(new Response(JSON.stringify({ ok: true, pane: '%1' }), { status: 200 }));
    });
    expect(container.textContent).toContain('coming up on demo-1');
  });

  it('a dialog answer shows cyan answering… immediately', async () => {
    const dialogView: HubView = {
      ...VIEW,
      projects: [{
        ...VIEW.projects[0],
        orchestrator: { ...VIEW.projects[0].orchestrator, state: 'running', question: true },
      }],
      dialogs: {
        demo: {
          kind: 'numbered', text: 'Run this command?\n 1. Approve once', cursor: null, esc: true,
          options: [{ n: 1, label: 'Approve once', detail: '', offered: true, saves_rule: false }],
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
      // re-poll with the dialog view in place
      [...container.querySelectorAll('button')].find((b) => b.textContent === 'refresh')!.click();
    });
    const option = [...container.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Approve once'));
    if (!option) throw new Error('no dialog option button rendered');
    act(() => {
      option.click();
    });
    expect(container.textContent).toContain('answering…');
    expect(option.disabled).toBe(true);
    expect(option.getAttribute('data-pressed')).toBe('true');
    await act(async () => {
      resolveAction!(new Response(
        JSON.stringify({ ok: true, option: 'Approve once', dialog_gone: true }),
        { status: 200 },
      ));
    });
    expect(container.textContent).toContain('answered "Approve once"');
  });
});
