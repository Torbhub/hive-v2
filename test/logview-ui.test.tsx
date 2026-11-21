// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentLog } from '../src/logview';
import { LogView } from '../web/logview';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function page(
  ids: string[], olderCursor: string | null = null, sessionId = 'session_abc', fileGeneration = 'file-a',
): AgentLog {
  return {
    agent: 'demo-orchestrator',
    session_id: sessionId,
    fileGeneration,
    hasOlder: olderCursor !== null,
    olderCursor,
    agents: ids.length === 0 ? [] : [{
      agentId: 'main',
      entries: ids.map((id) => ({
        id: `${fileGeneration}:${id}`, at: '2026-11-21T12:00:00.000Z', kind: 'text', text: id,
      })),
    }],
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let responses: (AgentLog | Response | Promise<AgentLog>)[];
let requested: string[];
let requestSignals: (AbortSignal | undefined)[];

beforeEach(() => {
  vi.useFakeTimers();
  responses = [];
  requested = [];
  requestSignals = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    requested.push(url);
    requestSignals.push(init?.signal ?? undefined);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    const value = await next;
    return value instanceof Response ? value : new Response(JSON.stringify(value), { status: 200 });
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mount(): Promise<void> {
  await act(async () => {
    root.render(<LogView project="demo" onBack={vi.fn()} />);
  });
}

function scroller(): HTMLElement {
  const element = container.querySelector('[role="log"]');
  if (!element) throw new Error('no log scroller rendered');
  return element as HTMLElement;
}

function size(element: HTMLElement, scrollHeight: number): void {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, value: scrollHeight },
  });
}

function scrollTo(element: HTMLElement, top: number): void {
  act(() => {
    element.scrollTop = top;
    element.dispatchEvent(new Event('scroll'));
  });
}

async function poll(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
}

function renderedEntries(): string[] {
  return [...container.querySelectorAll('[data-log-entry]')].map((element) => element.textContent);
}

describe('log investigation scrolling', () => {
  it('follows a latest-page poll only when the reader is already at the tail', async () => {
    responses = [page(['latest-1']), page(['latest-1', 'latest-2'])];
    await mount();
    const element = scroller();
    size(element, 1000);
    scrollTo(element, 800);
    size(element, 1200);

    await poll();

    expect(element.scrollTop).toBe(1000);
    expect(renderedEntries().filter((text) => text?.includes('latest-2'))).toHaveLength(1);
  });

  it('keeps a scrolled-up reader at the same position during latest-page polling', async () => {
    responses = [page(['latest-1']), page(['latest-1', 'latest-2'])];
    await mount();
    const element = scroller();
    size(element, 1000);
    scrollTo(element, 100);
    size(element, 1200);

    await poll();

    expect(element.scrollTop).toBe(100);
  });

  it('preserves the prepend anchor, focus, and older pages across polling without duplicates', async () => {
    responses = [
      page(['latest-1', 'latest-2'], 'older-cursor'),
      page(['older-1', 'latest-1']),
      page(['latest-1', 'latest-2', 'latest-3']),
    ];
    await mount();
    const element = scroller();
    size(element, 1000);
    scrollTo(element, 400);
    Object.defineProperty(element, 'scrollHeight', {
      configurable: true,
      get: () => 1000 + Math.max(0, container.querySelectorAll('[data-log-entry]').length - 2) * 250,
    });
    element.getBoundingClientRect = () => new DOMRect(0, 100, 500, 200);

    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'load older')!.click();
    });

    expect(element.scrollTop).toBe(650);
    expect(renderedEntries()).toEqual([
      expect.stringContaining('older-1'), expect.stringContaining('latest-1'), expect.stringContaining('latest-2'),
    ]);
    expect(document.activeElement).toBe(element);
    const focusedRect = (document.activeElement as HTMLElement).getBoundingClientRect();
    expect(focusedRect.top).toBeGreaterThanOrEqual(0);
    expect(focusedRect.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Loaded 1 older entry.');
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'load older')).toBe(false);
    expect(requested.filter((url) => url.includes('before='))).toHaveLength(1);
    expect(requested.find((url) => url.includes('before='))).toContain('before=older-cursor');

    await poll();

    expect(renderedEntries()).toEqual([
      expect.stringContaining('older-1'), expect.stringContaining('latest-1'),
      expect.stringContaining('latest-2'), expect.stringContaining('latest-3'),
    ]);
    expect(requested.filter((url) => url.includes('before='))).toHaveLength(1);
    expect(element.scrollTop).toBe(650);
  });

  it('clears and reannounces equal-sized consecutive older pages', async () => {
    const secondPage = deferred<AgentLog>();
    responses = [
      page(['latest-1', 'latest-2'], 'second-cursor'),
      page(['older-3', 'older-4'], 'first-cursor'),
      secondPage.promise,
    ];
    await mount();
    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'load older')!.click();
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Loaded 2 older entries.');

    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'load older')!.click();
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe('');

    await act(async () => {
      secondPage.resolve(page(['older-1', 'older-2']));
      await Promise.resolve();
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Loaded 2 older entries.');
    expect(renderedEntries()).toHaveLength(6);
  });

  it('resets instead of concatenating a disjoint latest page after more than 100 appends', async () => {
    const initial = Array.from({ length: 100 }, (_, i) => `entry-${i}`);
    const replacement = Array.from({ length: 100 }, (_, i) => `entry-${i + 100}`);
    responses = [
      page(initial, 'stale-cursor'),
      page(replacement, 'fresh-cursor'),
      page(['entry-99']),
    ];
    await mount();

    await poll();

    expect(renderedEntries()).toHaveLength(100);
    expect(renderedEntries()[0]).toContain('entry-100');
    expect(renderedEntries().some((text) => text?.includes('entry-0'))).toBe(false);
    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'load older')!.click();
    });
    expect(requested.filter((url) => url.includes('before='))).toEqual([
      expect.stringContaining('before=fresh-cursor'),
    ]);
  });

  it('ignores out-of-order latest responses across sessions and aborts the superseded request', async () => {
    const oldResponse = deferred<AgentLog>();
    const newResponse = deferred<AgentLog>();
    responses = [page(['session-a'], null, 'session-a'), oldResponse.promise, newResponse.promise];
    await mount();
    await poll();
    await poll();
    expect(requestSignals[1]?.aborted).toBe(true);

    await act(async () => {
      newResponse.resolve(page(['session-b'], null, 'session-b', 'file-b'));
      await Promise.resolve();
    });
    expect(renderedEntries()).toEqual([expect.stringContaining('session-b')]);

    await act(async () => {
      oldResponse.resolve(page(['late-session-a'], null, 'session-a'));
      await Promise.resolve();
    });
    expect(renderedEntries()).toEqual([expect.stringContaining('session-b')]);
  });

  it('aborts and ignores an in-flight request when the log view is removed', async () => {
    const pending = deferred<AgentLog>();
    responses = [page(['initial']), pending.promise];
    await mount();
    await poll();
    expect(requestSignals[1]?.aborted).toBe(false);

    act(() => root.render(<div />));

    expect(requestSignals[1]?.aborted).toBe(true);
    await act(async () => {
      pending.resolve(page(['late']));
      await Promise.resolve();
    });
    expect(renderedEntries()).toEqual([]);
  });

  it('resets to a rotated empty latest file and ignores the previous file response', async () => {
    const oldResponse = deferred<AgentLog>();
    const emptyResponse = deferred<AgentLog>();
    responses = [page(['before-rotation']), oldResponse.promise, emptyResponse.promise];
    await mount();
    await poll();
    await poll();

    await act(async () => {
      emptyResponse.resolve(page([], null, 'session_abc', 'file-b'));
      await Promise.resolve();
    });
    expect(renderedEntries()).toEqual([]);
    expect(container.textContent).toContain('no thinking recorded yet under session session_abc');

    await act(async () => {
      oldResponse.resolve(page(['late-before-rotation']));
      await Promise.resolve();
    });
    expect(renderedEntries()).toEqual([]);
  });

  it('ignores an older response that arrives after a file generation change', async () => {
    const olderResponse = deferred<AgentLog>();
    responses = [
      page(['latest-a'], 'older-cursor'),
      olderResponse.promise,
      page(['latest-b'], null, 'session_abc', 'file-b'),
    ];
    await mount();
    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'load older')!.click();
    });
    await poll();
    expect(renderedEntries()).toEqual([expect.stringContaining('latest-b')]);

    await act(async () => {
      olderResponse.resolve(page(['older-a']));
      await Promise.resolve();
    });
    expect(renderedEntries()).toEqual([expect.stringContaining('latest-b')]);
  });

  it('reloads latest paging state when a process-stale older cursor is refused', async () => {
    responses = [
      page(['before-restart'], 'process-stale-cursor'),
      new Response(JSON.stringify({ ok: false, detail: 'log cursor is stale or invalid' }), { status: 400 }),
      page(['after-restart']),
    ];
    await mount();

    await act(async () => {
      [...container.querySelectorAll('button')].find((button) => button.textContent === 'load older')!.click();
    });

    expect(renderedEntries()).toEqual([expect.stringContaining('after-restart')]);
    expect(requested.filter((url) => url.includes('before='))).toHaveLength(1);
    expect(container.textContent).not.toContain('log cursor is stale or invalid');
  });
});
