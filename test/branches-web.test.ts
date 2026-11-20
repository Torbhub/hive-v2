import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/branches.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/branches.js')>();
  return {
    ...actual,
    __realReadNativeBranch: actual.readNativeBranch,
    listNativeBranches: vi.fn(),
    readNativeBranch: vi.fn(),
    rejoinNativeBranch: vi.fn(),
    reviewNativeBranch: vi.fn(),
  };
});

vi.mock('../src/kimi-server.js', () => ({
  KimiServerClient: vi.fn(() => ({ fakeNativeClient: true })),
}));

import * as branchInternals from '../src/branches.js';
import {
  listNativeBranches,
  previewNativeBranchRejoin,
  readNativeBranch,
  rejoinNativeBranch,
  reviewNativeBranch,
} from '../src/branches.js';
import { KimiServerClient } from '../src/kimi-server.js';
import { hivePath, hubPath, Refusal, writeJson } from '../src/state.js';
import type { NativeBranchRecord } from '../src/types.js';
import { createServer } from '../web/server.js';
import { agentHeaders, authHeaders, configureSecurity, MemoryRegistry, registryItems } from './security-fixture.js';

const realReadNativeBranch = (branchInternals as unknown as {
  __realReadNativeBranch: typeof readNativeBranch;
}).__realReadNativeBranch;
const ID = '7ca3c50b-8304-45f0-a925-f41d10a14cf2';
const OTHER_ID = 'f19d0d09-e682-47d8-a91c-e542a52c8984';
const REAL_ID = '036ba4b2-0b2a-4d7b-a1f4-fcb2d99465f8';
const DIGEST = 'a'.repeat(64);
const PROMPT_ID = `hive-rejoin-${ID}-${DIGEST.slice(0, 16)}`;
const CREATED = '2026-11-18T12:00:00.000Z';
const UPDATED = '2026-11-18T12:01:00.000Z';
const REJOINED = '2026-11-18T12:02:00.000Z';
const NATIVE_TOKEN = 'test-only-native-token-that-must-not-reach-the-browser';

function activeRecord(): NativeBranchRecord {
  const snapshot = {
    count: 1,
    headId: 'msg_private_head',
    historyHash: 'b'.repeat(64),
    messages: [{ id: 'msg_private_head', contentHash: 'c'.repeat(64) }],
  };
  return {
    schemaVersion: 1,
    id: ID,
    kind: 'child',
    purpose: 'Review the transport boundary',
    parentSessionId: 'session_parent_private',
    childSessionId: 'session_child_private',
    workspaceId: 'workspace_private',
    cwd: '/private/native/worktree',
    scope: { project: 'demo', agent: 'builder', task: 'demo-1' },
    parentSnapshot: snapshot,
    childSnapshot: { ...snapshot, headId: 'msg_private_child' },
    status: 'active',
    createdAt: CREATED,
    updatedAt: UPDATED,
    error: 'child transport needs attention',
    leaseId: 'native-lease-private',
    result: {
      schemaVersion: 1,
      branchId: ID,
      childHistoryHash: snapshot.historyHash,
      digest: 'd'.repeat(64),
      recordedAt: UPDATED,
      findings: [{
        id: 'finding-1',
        answer: 'Return only the reviewed finding.',
        recommendation: 'Use the exact prompt preview.',
        uncertainty: 'No unselected finding is included.',
        nativeEvidence: [{ messageId: 'msg_private_child', contentHash: 'c'.repeat(64) }],
      }],
    },
  };
}

function reviewedRecord(): NativeBranchRecord {
  return {
    ...activeRecord(),
    review: {
      branchId: ID,
      findingIds: ['finding-1'],
      digest: DIGEST,
      parentHistoryHash: 'b'.repeat(64),
      childHistoryHash: 'b'.repeat(64),
      reviewer: 'user:alice',
      consumerGrantId: 'agent-grant',
      consumerAclEpoch: 1,
      approverGrantId: 'human-grant',
      approverAclEpoch: 1,
      createdAt: UPDATED,
      expiresAt: '2026-11-18T12:16:00.000Z',
    },
  };
}

function rejoinedRecord(): NativeBranchRecord {
  return {
    ...reviewedRecord(),
    status: 'rejoined',
    updatedAt: REJOINED,
    rejoin: {
      status: 'rejoined',
      reviewDigest: DIGEST,
      promptId: PROMPT_ID,
      promptHash: 'e'.repeat(64),
      intentAt: UPDATED,
      nativeMessageId: 'msg_rejoined',
      rejoinedAt: REJOINED,
      detail: 'private native delivery detail',
    },
  };
}

function storedCreatingRecord(): NativeBranchRecord {
  const messages = [{ id: 'msg_stored_parent', contentHash: 'c'.repeat(64) }];
  return {
    schemaVersion: 1,
    id: REAL_ID,
    kind: 'child',
    purpose: 'Stored branch used for real read failures',
    parentSessionId: 'session_stored_parent',
    childSessionId: null,
    workspaceId: 'workspace_stored',
    cwd: path.join(root, 'demo'),
    scope: { project: 'demo', agent: 'builder', task: 'demo-1' },
    parentSnapshot: {
      count: 1,
      headId: 'msg_stored_parent',
      historyHash: createHash('sha256').update(JSON.stringify(messages)).digest('hex'),
      messages,
    },
    childSnapshot: null,
    status: 'creating',
    createdAt: CREATED,
    updatedAt: UPDATED,
  };
}

function summary(record: NativeBranchRecord) {
  return {
    id: record.id,
    status: record.status,
    purpose: record.purpose,
    agent: record.scope.agent,
    task: record.scope.task,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    hasResult: Boolean(record.result),
    ...(record.error === undefined ? {} : { error: record.error }),
  };
}

function detail(record: NativeBranchRecord) {
  const preview = record.review ? previewNativeBranchRejoin(record) : undefined;
  return {
    ...summary(record),
    kind: record.kind,
    findings: record.result?.findings.map((finding) => ({
      id: finding.id,
      answer: finding.answer,
      recommendation: finding.recommendation,
      uncertainty: finding.uncertainty,
    })) ?? [],
    ...(record.review ? {
      review: {
        digest: record.review.digest,
        findingIds: record.review.findingIds,
        createdAt: record.review.createdAt,
        expiresAt: record.review.expiresAt,
        promptId: preview!.promptId,
        prompt: preview!.prompt,
      },
    } : {}),
    ...(record.rejoin ? {
      rejoin: {
        status: record.rejoin.status,
        reviewDigest: record.rejoin.reviewDigest,
        promptId: record.rejoin.promptId,
        ...(record.rejoin.status === 'rejoined' ? {
          nativeMessageId: record.rejoin.nativeMessageId,
          rejoinedAt: record.rejoin.rejoinedAt,
        } : {}),
      },
    } : {}),
  };
}

let root: string;
let registry: MemoryRegistry;
let server: Server;
let base: string;
let current: NativeBranchRecord;

beforeEach(async () => {
  vi.clearAllMocks();
  configureSecurity(true);
  process.env.HIVE_NATIVE_BRANCHES = '1';
  process.env.HIVE_KIMI_SERVER_TOKEN = NATIVE_TOKEN;
  process.env.HIVE_KIMI_SERVER_ORIGIN = 'http://127.0.0.1:58627';
  root = await fs.mkdtemp(path.join(tmpdir(), 'hive-branches-web-'));
  await writeJson(hubPath(root, 'projects.json'), {
    projects: [
      { name: 'demo', home: path.join(root, 'demo'), repos: [] },
      { name: 'other', home: path.join(root, 'other'), repos: [] },
    ],
  });
  await writeJson(hubPath(root, 'hub.json'), { name: 'hub' });
  await writeJson(hivePath(path.join(root, 'demo'), 'team.json'), { agents: [] });
  registry = new MemoryRegistry(registryItems());
  current = activeRecord();

  vi.mocked(listNativeBranches).mockImplementation(async (_root, project) => {
    if (project !== 'demo') return [];
    return [current, { ...activeRecord(), id: OTHER_ID, scope: { project: 'demo', agent: 'other', task: 'demo-2' } }];
  });
  vi.mocked(readNativeBranch).mockImplementation(async (scope, id) => {
    if (scope.root === root && scope.project === 'demo' && id === ID) return current;
    return realReadNativeBranch(scope, id);
  });
  vi.mocked(reviewNativeBranch).mockImplementation(async (_scope, _id, input) => {
    if (input.principal.kind !== 'human') throw new Refusal('native branch review requires a human principal');
    current = {
      ...reviewedRecord(),
      review: { ...reviewedRecord().review!, findingIds: [...input.findingIds] },
    };
    return current;
  });
  vi.mocked(rejoinNativeBranch).mockImplementation(async (_scope, _id, input) => {
    if (input.reviewDigest !== current.review?.digest) throw new Refusal('native review digest does not match');
    current = rejoinedRecord();
    return current;
  });

  server = createServer(root, registry);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(root, { recursive: true, force: true });
  delete process.env.HIVE_NATIVE_BRANCHES;
  delete process.env.HIVE_KIMI_SERVER_TOKEN;
  delete process.env.HIVE_KIMI_SERVER_ORIGIN;
  delete process.env.HIVE_COLLABORATION_ENABLED;
  delete process.env.HIVE_WAKE_SUBSCRIPTION_WRITES_ENABLED;
});

async function request(pathname: string, init: RequestInit = {}, headers = authHeaders()): Promise<Response> {
  const merged = new Headers(init.headers);
  if (!merged.has('authorization')) merged.set('authorization', headers.authorization);
  return fetch(base + pathname, { ...init, headers: merged });
}

function post(pathname: string, body: unknown, headers = authHeaders()): Promise<Response> {
  return request(pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, headers);
}

function expectNoNativeSecrets(body: string): void {
  for (const secret of [
    NATIVE_TOKEN, '/private/native/worktree', 'workspace_private', 'session_parent_private', 'session_child_private',
    'human-grant', 'agent-grant', 'parentSnapshot', 'childSnapshot', 'consumerAclEpoch', 'approverAclEpoch',
    'parentHistoryHash', 'childHistoryHash', 'nativeEvidence', 'messageId', 'msg_private',
    'promptHash', 'private native delivery detail', 'native-lease-private',
  ]) expect(body).not.toContain(secret);
}

async function expectGenericNotFound(response: Response): Promise<void> {
  expect(response.status).toBe(404);
  expect(await response.text()).toBe(JSON.stringify({ ok: false, detail: 'not found' }));
}

describe('lazy native branch reads', () => {
  it('filters list items by the stored task and returns whitelisted list and detail DTOs without a native client', async () => {
    const listed = await request(`/api/branches?project=demo`);
    expect(listed.status).toBe(200);
    const listBody = await listed.text();
    expect(JSON.parse(listBody)).toEqual({ ok: true, branches: [summary(current)] });
    expect(listBody).not.toContain('finding-1');
    expect(listBody).not.toContain(OTHER_ID);
    expectNoNativeSecrets(listBody);
    expect(listNativeBranches).toHaveBeenCalledWith(root, 'demo');

    const response = await request(`/api/branch?project=demo&branch=${ID}`);
    expect(response.status).toBe(200);
    const detailBody = await response.text();
    expect(JSON.parse(detailBody)).toEqual({ ok: true, branch: detail(current) });
    expectNoNativeSecrets(detailBody);
    expect(readNativeBranch).toHaveBeenCalledWith({ root, project: 'demo' }, ID);

    expect((await request('/api/view')).status).toBe(200);
    expect(KimiServerClient).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown valid UUID', 'demo', OTHER_ID],
    ['cross-project lookup', 'other', REAL_ID],
    ['unauthorized lookup', 'demo', REAL_ID],
  ])('returns one generic 404 for %s in detail and both mutations', async (_name, project, id) => {
    await writeJson(hivePath(path.join(root, 'demo'), 'branches', `${REAL_ID}.json`), storedCreatingRecord());
    const grant = registry.items.find((row) => row.pk === 'ACL#demo#demo-1#*' && row.sk === 'PRINCIPAL#user:alice')!;
    grant.revokedAt = project === 'demo' && id === REAL_ID ? 1 : null;
    const [detailResponse, reviewResponse, rejoinResponse] = await Promise.all([
      request(`/api/branch?project=${project}&branch=${id}`),
      post('/api/branch-review', { project, branch: id, findingIds: ['finding-1'] }),
      post('/api/branch-rejoin', { project, branch: id, reviewDigest: DIGEST }),
    ]);
    await Promise.all([
      expectGenericNotFound(detailResponse),
      expectGenericNotFound(reviewResponse),
      expectGenericNotFound(rejoinResponse),
    ]);
    expect(KimiServerClient).not.toHaveBeenCalled();
  });
});

describe('reviewed native branch mutations', () => {
  it('derives review authority from the request and returns only the reviewed DTO and exact preview', async () => {
    const response = await post('/api/branch-review', { project: 'demo', branch: ID, findingIds: ['finding-1'] });
    expect(response.status).toBe(200);
    const body = await response.text();
    const parsed = JSON.parse(body);
    expect(parsed).toEqual({ ok: true, branch: detail(reviewedRecord()) });
    const prompt = JSON.parse(parsed.branch.review.prompt);
    expect(prompt).toMatchObject({ branchId: ID, reviewDigest: DIGEST, promptId: PROMPT_ID });
    expect(prompt.findings).toHaveLength(1);
    expect(prompt.findings[0]).toMatchObject({
      answer: 'Return only the reviewed finding.',
      recommendation: 'Use the exact prompt preview.',
      uncertainty: 'No unselected finding is included.',
    });
    for (const field of ['parentSessionId', 'childSessionId', 'parentHistoryHash', 'childHistoryHash']) {
      expect(prompt).not.toHaveProperty(field);
    }
    expect(prompt.findings[0]).not.toHaveProperty('nativeEvidence');
    expect(parsed.branch.review.prompt).not.toContain('msg_');
    expectNoNativeSecrets(body);
    expect(reviewNativeBranch).toHaveBeenCalledTimes(1);
    const [scope, id, input] = vi.mocked(reviewNativeBranch).mock.calls[0];
    expect(scope).toEqual({ root, project: 'demo' });
    expect(id).toBe(ID);
    expect(Object.keys(input).sort()).toEqual(['findingIds', 'principal', 'registry']);
    expect(input).toMatchObject({
      findingIds: ['finding-1'],
      principal: { kind: 'human', subject: 'user:alice' },
      registry,
    });
    expect(KimiServerClient).toHaveBeenCalledTimes(1);
  });

  it('sends only the displayed digest and returns an actual rejoined receipt', async () => {
    current = reviewedRecord();
    const response = await post('/api/branch-rejoin', { project: 'demo', branch: ID, reviewDigest: DIGEST });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ ok: true, branch: detail(rejoinedRecord()) });
    expect(JSON.parse(body).branch.rejoin).toEqual({
      status: 'rejoined',
      reviewDigest: DIGEST,
      promptId: PROMPT_ID,
      nativeMessageId: 'msg_rejoined',
      rejoinedAt: REJOINED,
    });
    expectNoNativeSecrets(body);
    const input = vi.mocked(rejoinNativeBranch).mock.calls[0][2];
    expect(Object.keys(input).sort()).toEqual(['principal', 'registry', 'reviewDigest']);
    expect(input).toMatchObject({
      reviewDigest: DIGEST,
      principal: { kind: 'human', subject: 'user:alice' },
      registry,
    });
    expect(KimiServerClient).toHaveBeenCalledTimes(1);
  });

  it('requires an exact task execute grant and rejects agent self-review', async () => {
    const grant = registry.items.find((row) => row.pk === 'ACL#demo#demo-1#*' && row.sk === 'PRINCIPAL#user:alice')!;
    grant.pk = 'ACL#demo#*#*';
    const projectOnly = await post('/api/branch-review', { project: 'demo', branch: ID, findingIds: ['finding-1'] });
    expect(projectOnly.status).toBe(404);
    expect(reviewNativeBranch).not.toHaveBeenCalled();
    current = reviewedRecord();
    const projectOnlyRejoin = await post('/api/branch-rejoin', { project: 'demo', branch: ID, reviewDigest: DIGEST });
    expect(projectOnlyRejoin.status).toBe(404);
    expect(rejoinNativeBranch).not.toHaveBeenCalled();

    grant.pk = 'ACL#demo#demo-1#*';
    const agent = await post('/api/branch-review', { project: 'demo', branch: ID, findingIds: ['finding-1'] }, agentHeaders());
    expect(agent.status).toBe(400);
    expect((await agent.json()).detail).toMatch(/human/);
    expect(vi.mocked(reviewNativeBranch).mock.calls[0][2].principal).toMatchObject({ kind: 'agent', subject: 'agent:builder' });
  });

  it.each(['reviewer', 'task', 'agent', 'session', 'sessionId', 'grantId', 'history', 'parentHistoryHash', 'expiresAt'])(
    'refuses browser-supplied %s authority', async (field) => {
      current = reviewedRecord();
      const response = await post('/api/branch-rejoin', {
        project: 'demo', branch: ID, reviewDigest: DIGEST, [field]: 'substituted',
      });
      expect([400, 404]).toContain(response.status);
      expect(rejoinNativeBranch).not.toHaveBeenCalled();
      expect(KimiServerClient).not.toHaveBeenCalled();
    },
  );
});
