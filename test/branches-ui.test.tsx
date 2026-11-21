import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeBranchDetail } from '../src/types';
import { Branches } from '../web/branches';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const ID = '7ca3c50b-8304-45f0-a925-f41d10a14cf2';
const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);
const PROMPT_ID = `hive-rejoin-${ID}-${DIGEST.slice(0, 16)}`;
const OTHER_PROMPT_ID = `hive-rejoin-${ID}-${OTHER_DIGEST.slice(0, 16)}`;
const CREATED = '2026-11-18T12:00:00.000Z';
const UPDATED = '2026-11-18T12:01:00.000Z';
const REJOINED = '2026-11-18T12:02:00.000Z';
const PROMPT = JSON.stringify({
  kind: 'hive.native-branch.reviewed-findings',
  branchId: ID,
  reviewDigest: DIGEST,
  promptId: PROMPT_ID,
  escaped: '<img src=x onerror="window.__branchXss = true">\\n\"quoted\"',
});

type ReviewedDetail = NativeBranchDetail & { review: NonNullable<NativeBranchDetail['review']> };
type RejoinedDetail = ReviewedDetail & { rejoin: NonNullable<NativeBranchDetail['rejoin']> };

function activeBranch(): NativeBranchDetail {
  return {
    id: ID,
    kind: 'child',
    status: 'active',
    purpose: 'Review the transport boundary',
    agent: 'builder',
    task: 'demo-1',
    createdAt: CREATED,
    updatedAt: UPDATED,
    hasResult: true,
    error: 'child transport needs attention',
    findings: [{
      id: 'finding-1',
      answer: 'Return only the reviewed finding.',
      recommendation: 'Use the exact prompt preview.',
      uncertainty: 'No unselected finding is included.',
    }],
  };
}

function reviewedBranch(digest = DIGEST): ReviewedDetail {
  const promptId = digest === DIGEST ? PROMPT_ID : OTHER_PROMPT_ID;
  const prompt = digest === DIGEST ? PROMPT : JSON.stringify({
    kind: 'hive.native-branch.reviewed-findings', branchId: ID, reviewDigest: digest, promptId,
  });
  return {
    ...activeBranch(),
    review: {
      digest,
      findingIds: ['finding-1'],
      createdAt: UPDATED,
      expiresAt: '2026-11-18T12:16:00.000Z',
      promptId,
      prompt,
    },
  };
}

function rejoinedBranch(digest = DIGEST): RejoinedDetail {
  const reviewed = reviewedBranch(digest);
  return {
    ...reviewed,
    status: 'rejoined',
    updatedAt: REJOINED,
    rejoin: {
      status: 'rejoined',
      reviewDigest: digest,
      promptId: reviewed.review.promptId,
      nativeMessageId: 'msg_rejoined',
      rejoinedAt: REJOINED,
    },
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let branch: NativeBranchDetail;
let detailStatus: number;
let rejoinOutcome: 'rejoined' | 'unknown';
let rejoinHttpError: { status: number; detail: string } | null;
let rejoinNetworkError: string | null;

beforeEach(() => {
  branch = activeBranch();
  detailStatus = 200;
  rejoinOutcome = 'rejoined';
  rejoinHttpError = null;
  rejoinNetworkError = null;
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === 'api/branches?project=demo' || url === '/api/branches?project=demo') {
      const { findings: _findings, review: _review, rejoin: _rejoin, ...summary } = branch;
      return new Response(JSON.stringify({ ok: true, branches: [summary] }), { status: 200 });
    }
    if (url.startsWith('api/branch?') || url.startsWith('/api/branch?')) {
      if (detailStatus !== 200) return new Response(JSON.stringify({ ok: false, detail: 'not found' }), { status: detailStatus });
      return new Response(JSON.stringify({ ok: true, branch }), { status: 200 });
    }
    if (url.endsWith('api/branch-review')) {
      const body = JSON.parse(String(init?.body));
      branch = { ...reviewedBranch(), review: { ...reviewedBranch().review, findingIds: body.findingIds } };
      return new Response(JSON.stringify({ ok: true, branch }), { status: 200 });
    }
    if (url.endsWith('api/branch-rejoin')) {
      const body = JSON.parse(String(init?.body));
      if (rejoinNetworkError) throw new Error(rejoinNetworkError);
      if (rejoinHttpError) {
        return new Response(JSON.stringify({ ok: false, detail: rejoinHttpError.detail }), { status: rejoinHttpError.status });
      }
      if (body.reviewDigest !== branch.review?.digest) {
        return new Response(JSON.stringify({ ok: false, detail: 'review digest mismatch' }), { status: 400 });
      }
      if (rejoinOutcome === 'unknown') {
        branch = {
          ...reviewedBranch(),
          rejoin: {
            status: 'unknown', reviewDigest: DIGEST, promptId: PROMPT_ID, nativeMessageId: 'msg_unverified',
          },
        };
      } else {
        branch = rejoinedBranch(body.reviewDigest);
      }
      return new Response(JSON.stringify({ ok: true, branch }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(): Promise<void> {
  await act(async () => {
    root.render(<Branches project="demo" onBack={vi.fn()} />);
  });
}

function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === text);
  if (!found) throw new Error(`no "${text}" button rendered. Body: ${container.textContent}`);
  return found as HTMLButtonElement;
}

function finding(id = 'finding-1'): HTMLInputElement {
  const input = container.querySelector(`input[aria-label="select finding ${id}"]`);
  if (!input) throw new Error(`no finding checkbox for ${id}`);
  return input as HTMLInputElement;
}

async function selectBranch(): Promise<void> {
  const selected = [...container.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.includes('Review the transport boundary'));
  if (!selected) throw new Error('no branch selection button');
  await act(async () => {
    (selected as HTMLButtonElement).click();
  });
}

function posts(pathname: string) {
  return vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input).endsWith(pathname) && init?.method === 'POST');
}

async function reviewAndArm(): Promise<void> {
  await mount();
  await selectBranch();
  act(() => finding().click());
  await act(async () => button('Review').click());
  act(() => button('Rejoin').click());
  expect(posts('/api/branch-rejoin')).toHaveLength(0);
  button('Confirm rejoin');
}

describe('native branch review and rejoin', () => {
  it('disarms on detail refresh without sending a rejoin', async () => {
    await reviewAndArm();
    await act(async () => button('Refresh').click());
    button('Rejoin');
    expect(posts('/api/branch-rejoin')).toHaveLength(0);
  });

  it('disarms when finding selection changes', async () => {
    await reviewAndArm();
    act(() => finding().click());
    button('Rejoin');
    expect(button('Review').disabled).toBe(true);
    expect(posts('/api/branch-rejoin')).toHaveLength(0);
  });

  it('disarms on digest change and confirms only the newly displayed digest', async () => {
    await reviewAndArm();
    branch = reviewedBranch(OTHER_DIGEST);
    await act(async () => button('Refresh').click());
    expect(container.querySelector('[data-branch-prompt]')?.textContent).toBe(reviewedBranch(OTHER_DIGEST).review.prompt);
    expect(container.textContent).toContain(OTHER_DIGEST);
    expect(container.textContent).not.toContain(PROMPT_ID);
    button('Rejoin');
    expect(posts('/api/branch-rejoin')).toHaveLength(0);

    act(() => button('Rejoin').click());
    await act(async () => button('Confirm rejoin').click());
    expect(JSON.parse(String(posts('/api/branch-rejoin')[0][1]?.body))).toEqual({
      project: 'demo', branch: ID, reviewDigest: OTHER_DIGEST,
    });
  });

  it.each([
    ['ACL', 400, 'native branch review grant, expiry, project, or ACL authority is invalid'],
    ['digest', 400, 'native review digest does not match the current review'],
    ['pause', 409, 'execution is paused'],
    ['expired review', 400, 'native branch review is expired or stale'],
  ])('%s refusal stays visible and does not poison a refreshed review', async (_name, status, detail) => {
    await reviewAndArm();
    rejoinHttpError = { status, detail };
    await act(async () => button('Confirm rejoin').click());
    expect(container.textContent).toContain(detail);
    expect(container.textContent).not.toContain('Rejoin delivery is unknown');
    expect(button('Rejoin').disabled).toBe(false);

    rejoinHttpError = null;
    branch = reviewedBranch(OTHER_DIGEST);
    await act(async () => button('Refresh').click());
    expect(button('Rejoin').disabled).toBe(false);
    act(() => button('Rejoin').click());
    await act(async () => button('Confirm rejoin').click());
    expect(posts('/api/branch-rejoin')).toHaveLength(2);
    expect(container.querySelector('[data-branch-receipt]')).not.toBeNull();
  });

  it('a transport error is not an actual unknown rejoin and does not disable a later attempt', async () => {
    await reviewAndArm();
    rejoinNetworkError = 'socket closed before the response';
    await act(async () => button('Confirm rejoin').click());
    expect(container.textContent).toContain('socket closed before the response');
    expect(container.textContent).not.toContain('Rejoin delivery is unknown');
    expect(button('Rejoin').disabled).toBe(false);
  });

  it('clears unauthorized detail, selection, preview, and armed state', async () => {
    await reviewAndArm();
    detailStatus = 404;
    await act(async () => button('Refresh').click());
    expect(container.querySelector('[data-branch-detail]')).toBeNull();
    expect(container.querySelector('[data-branch-prompt]')).toBeNull();
    expect(container.textContent).not.toContain('Return only the reviewed finding.');
    expect(container.textContent).not.toContain(DIGEST);
    expect([...container.querySelectorAll('button')].some((candidate) => candidate.textContent === 'Confirm rejoin')).toBe(false);
    expect(posts('/api/branch-rejoin')).toHaveLength(0);
  });
});

describe('native branch disabled states', () => {
  it.each(['stale', 'diverged', 'creating', 'unknown'] as const)('%s disables review and rejoin', async (status) => {
    branch = { ...reviewedBranch(), status };
    await mount();
    await selectBranch();
    expect(button('Review').disabled).toBe(true);
    expect(button('Rejoin').disabled).toBe(true);
  });

  it('unknown delivery is not success and disables retry', async () => {
    rejoinOutcome = 'unknown';
    await reviewAndArm();
    await act(async () => button('Confirm rejoin').click());
    expect(container.textContent).toContain('unknown');
    expect(container.querySelector('[data-branch-receipt]')).toBeNull();
    expect(container.textContent).not.toContain('msg_unverified');
    expect(container.textContent).not.toContain('Rejoined');
    expect(button('Rejoin').disabled).toBe(true);
    expect(button('Review').disabled).toBe(true);
    expect(posts('/api/branch-rejoin')).toHaveLength(1);
  });
});
