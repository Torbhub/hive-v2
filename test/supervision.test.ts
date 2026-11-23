import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reconcileTaskBudgets } from '../src/admission.js';
import { OPERATION_REGISTRY, PREDICATE_REGISTRY } from '../src/evidence.js';
import { recordTaskOutcome } from '../src/hub.js';
import { buildWorkTree, supervisionPass } from '../src/supervision.js';
import {
  appendTaskEvent, contractDigest, foldTasks, readTaskEvents, taskEvidenceDigests, withHubLock, writeJson, writeProjects,
} from '../src/state.js';
import type {
  HubTask, NativeBranchRecord, RootContract, TaskAcceptance, TaskEvent, TeamEntry,
} from '../src/types.js';

const SHA = 'a'.repeat(40);
const ARTIFACT = 'b'.repeat(64);
const AT = '2026-11-20T12:00:00.000Z';
const DEADLINE = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const servers = new Set<Server>();

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers.clear();
});

type CheckRun = {
  id: number;
  head_sha: string;
  external_id: string;
  status: string;
  conclusion: string | null;
  name: string;
  app: { slug: string };
  cancellation_requested?: boolean;
};

async function githubServer() {
  const runs: CheckRun[] = [];
  const calls = { posts: 0, patches: 0, lists: 0 };
  const state = { getFailures: 0, patchFailures: 0, lostPatchResponses: 0 };
  const requests: { method: string; url: string; authorized: boolean }[] = [];
  const deferrals: { method: string; markEntered: () => void; wait: Promise<void> }[] = [];
  const defer = (method: string) => {
    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    deferrals.push({ method, markEntered, wait });
    return { entered, release };
  };
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '', authorized: Boolean(req.headers.authorization) });
    void (async () => {
      if (req.method === 'POST') calls.posts++;
      if (req.method === 'PATCH') calls.patches++;
      const deferralIndex = deferrals.findIndex((candidate) => candidate.method === req.method);
      if (deferralIndex >= 0) {
        const [deferral] = deferrals.splice(deferralIndex, 1);
        deferral.markEntered();
        await deferral.wait;
      }
      const url = new URL(req.url ?? '/', 'http://github.test');
      const send = (value: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.method === 'POST' && url.pathname === '/repos/octo/hive/check-runs') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw) as { head_sha: string; external_id: string; name: string };
        const run: CheckRun = {
          id: 100 + runs.length, ...body, status: 'in_progress', conclusion: null, app: { slug: 'hive-checks' },
        };
        runs.push(run);
        send(run, 201);
        return;
      }
      if (req.method === 'GET' && url.pathname === `/repos/octo/hive/commits/${SHA}/check-runs`) {
        calls.lists++;
        send({ check_runs: runs.filter((run) => run.head_sha === SHA && run.external_id === url.searchParams.get('external_id')) });
        return;
      }
      const match = url.pathname.match(/^\/repos\/octo\/hive\/check-runs\/(\d+)$/);
      const run = match ? runs.find((candidate) => candidate.id === Number(match[1])) : undefined;
      if (!run) {
        send({ message: 'not found' }, 404);
        return;
      }
      if (req.method === 'GET') {
        if (state.getFailures > 0) {
          state.getFailures--;
          send({ message: 'injected GET failure' }, 500);
          return;
        }
        send(run);
        return;
      }
      if (req.method === 'PATCH') {
        if (state.patchFailures > 0) {
          state.patchFailures--;
          send({ message: 'injected PATCH failure' }, 500);
          return;
        }
        run.cancellation_requested = true;
        if (state.lostPatchResponses > 0) {
          state.lostPatchResponses--;
          run.status = 'completed';
          run.conclusion = 'cancelled';
          req.socket.destroy();
          return;
        }
        send(run);
        return;
      }
      send({ message: 'unexpected request' }, 500);
    })().catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.add(server);
  return {
    runs,
    calls,
    state,
    requests,
    defer,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

function acceptance(overrides: Partial<TaskAcceptance> = {}): TaskAcceptance {
  return {
    id: 'github',
    predicate_id: 'github_check',
    version: 1,
    configuration: {
      repository: 'octo/hive', sha: SHA, external_id: 'deliverable-check', artifact_digest: ARTIFACT,
      owner: 'hive-checks', deadline: DEADLINE,
    },
    required_evidence: ['github-check'],
    ...overrides,
  };
}

function contract(items: TaskAcceptance[], wallSeconds?: number): RootContract {
  return {
    schema_version: 1, objective: 'Verify the external artifact.', consumer: 'demo-orchestrator',
    deliverable: 'a verified check', kind: 'build', acceptance: items,
    provenance: { repository: 'octo/hive', base_revision: '0'.repeat(40), artifact_revision: SHA },
    write_scope: ['src'], action_scope: [],
    budget: { depth: 2, active_children: 4, active_project_records: 8, attempts: 3, wall_seconds: wallSeconds },
    delegation: { output_claims: ['a verified check'], adapters: ['tmux', 'native'] },
  };
}

async function fixture(items = [acceptance()], approved = true, wallSeconds?: number) {
  const root = await mkdtemp(path.join(tmpdir(), 'hive-supervision-'));
  const home = path.join(root, 'demo');
  const rootContract = contract(items, wallSeconds);
  const planDigest = contractDigest(rootContract);
  await writeProjects(root, { projects: [{ name: 'demo', home, repos: [] }] });
  await writeJson(path.join(home, '.hive', 'team.json'), { agents: [] });
  await appendTaskEvent(root, { id: 'demo-1', project: 'demo', event: 'asked', at: AT, lease_epoch: 1 });
  await appendTaskEvent(root, {
    id: 'demo-1', project: 'demo', event: 'plan', at: AT, contract: rootContract, plan_digest: planDigest,
    checkpoints: [{ id: 'work', desc: 'verify', etaMin: 5 }],
  });
  if (approved) {
    await appendTaskEvent(root, { id: 'demo-1', project: 'demo', event: 'answered', at: AT, plan_digest: planDigest });
    await appendTaskEvent(root, { id: 'demo-1', project: 'demo', event: 'progress', at: AT, checkpoint: 'work', status: 'ok' });
  }
  return { root, home, rootContract, planDigest };
}

function config(task: HubTask, overrides: Record<string, unknown> = {}) {
  return {
    ...task.contract!.acceptance[0].configuration,
    acceptance_id: 'github',
    plan_digest: task.plan_digest!,
    ...overrides,
  };
}

async function task(root: string): Promise<HubTask> {
  return foldTasks(await readTaskEvents(root)).find((candidate) => candidate.id === 'demo-1')!;
}

function events(root: string, kind: string) {
  return readTaskEvents(root).then((items) => items.filter((item) => item.event === kind));
}

async function noteWhileBlocked(
  root: string, gate: { entered: Promise<void>; release: () => void }, note: string,
): Promise<void> {
  await gate.entered;
  try {
    await withHubLock(root, () => appendTaskEvent(root, { id: 'demo-1', project: 'demo', event: 'note', at: AT, note }));
  } finally {
    gate.release();
  }
}

async function recordFlow(root: string, fixture: string, label: string): Promise<void> {
  const directory = process.env.HIVE_TEST_ARTIFACTS;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const current = await task(root);
  const record = {
    journey: 'GITHUB_CHECK_SUPERVISION', fixture, label, head: process.env.GITHUB_SHA ?? 'local-hook',
    state: current.state, operations: current.operations?.map((operation) => ({
      id: operation.operation_id, status: operation.status, owner: operation.owner,
      closeOutcome: operation.close_outcome, replacementId: operation.replacement_id,
      externalId: operation.external_run_id, watcherId: operation.watcher_id,
    })),
  };
  await appendFile(path.join(directory, 'GITHUB_CHECK_SUPERVISION-state-flow.jsonl'), `${JSON.stringify(record)}\n`);
}

describe('github check supervision', () => {
  it('allows hub writes while dispatch, reconcile, cancel, and transfer HTTP is blocked', async () => {
    const github = await githubServer();
    const current = await fixture();
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    const currentConfig = config(await task(current.root));

    const dispatchGate = github.defer('GET');
    const dispatching = OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', currentConfig, options);
    await noteWhileBlocked(current.root, dispatchGate, 'dispatch HTTP is outside the hub lock');
    await dispatching;
    const operation = (await task(current.root)).operations!.at(-1)!;

    const reconcileGate = github.defer('GET');
    const reconciling = OPERATION_REGISTRY.github_check.reconcile(current.root, 'demo-1', operation.operation_id, options);
    await noteWhileBlocked(current.root, reconcileGate, 'reconcile HTTP is outside the hub lock');
    await reconciling;

    const cancelFindGate = github.defer('GET');
    const cancelPatchGate = github.defer('PATCH');
    const cancelling = OPERATION_REGISTRY.github_check.cancel(current.root, 'demo-1', operation.operation_id, options);
    await noteWhileBlocked(current.root, cancelFindGate, 'cancel lookup is outside the hub lock');
    await noteWhileBlocked(current.root, cancelPatchGate, 'cancel PATCH is outside the hub lock');
    await cancelling;

    github.runs[0].app.slug = 'new-owner';
    const transferGate = github.defer('GET');
    const transferring = OPERATION_REGISTRY.github_check.transfer(current.root, 'demo-1', operation.operation_id, {
      ...options, newOwner: 'new-owner',
    });
    await noteWhileBlocked(current.root, transferGate, 'transfer HTTP is outside the hub lock');
    await transferring;
    expect(await events(current.root, 'note')).toHaveLength(5);
  });

  it('persists one dispatch intent across concurrent callers', async () => {
    const github = await githubServer();
    const current = await fixture();
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    const currentConfig = config(await task(current.root));
    const gate = github.defer('POST');
    const first = OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', currentConfig, options);
    const second = OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', currentConfig, options);
    try {
      await gate.entered;
      expect(github.calls.posts).toBe(1);
      expect((await task(current.root)).operations!.at(-1)).toMatchObject({ status: 'pending' });
    } finally {
      gate.release();
    }
    await Promise.all([first, second]);
    expect(github.calls.posts).toBe(1);
    expect(github.runs).toHaveLength(1);
    expect((await task(current.root)).operations!.at(-1)).toMatchObject({
      status: 'blocked_external', external_run_id: '100',
    });
  });

  it('recovers a persisted dispatch intent without a duplicate POST', async () => {
    const github = await githubServer();
    const origin = await fixture();
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    const gate = github.defer('POST');
    const dispatching = OPERATION_REGISTRY.github_check.dispatch(
      origin.root, 'demo-1', config(await task(origin.root)), options,
    );
    let intent: TaskEvent;
    try {
      await gate.entered;
      intent = (await events(origin.root, 'operation'))[0];
      expect(intent.operation).toMatchObject({ status: 'pending' });
      expect(intent.operation?.attempt_id).toBeUndefined();
    } finally {
      gate.release();
    }
    await dispatching;

    const crashed = await fixture();
    await appendTaskEvent(crashed.root, intent);
    github.runs.splice(0);
    const postsBeforeRecovery = github.calls.posts;
    await supervisionPass(crashed.root, options);
    expect(github.calls.posts).toBe(postsBeforeRecovery + 1);
    expect((await task(crashed.root)).operations!.at(-1)).toMatchObject({
      status: 'blocked_external', external_run_id: '100',
    });
    await supervisionPass(crashed.root, options);
    expect(github.calls.posts).toBe(postsBeforeRecovery + 1);
  });

  it('fences concurrent recovery callers to one POST', async () => {
    const github = await githubServer();
    const origin = await fixture();
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    await OPERATION_REGISTRY.github_check.dispatch(origin.root, 'demo-1', config(await task(origin.root)), options);
    const bound = (await task(origin.root)).operations!.at(-1)!;
    const current = await fixture();
    await appendTaskEvent(current.root, {
      id: 'demo-1', project: 'demo', event: 'operation', at: AT,
      operation: { ...bound, status: 'pending', external_run_id: undefined },
    });
    github.runs.splice(0);
    const postsBeforeRecovery = github.calls.posts;
    const gate = github.defer('POST');
    const first = supervisionPass(current.root, options);
    const second = supervisionPass(current.root, options);
    try {
      await gate.entered;
      expect(github.calls.posts).toBe(postsBeforeRecovery + 1);
    } finally {
      gate.release();
    }
    await Promise.all([first, second]);
    expect(github.calls.posts).toBe(postsBeforeRecovery + 1);
    expect(github.runs).toHaveLength(1);
  });

  it('fences an initial dispatch against overlapping recovery', async () => {
    const github = await githubServer();
    const current = await fixture();
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    const gate = github.defer('POST');
    const dispatching = OPERATION_REGISTRY.github_check.dispatch(
      current.root, 'demo-1', config(await task(current.root)), options,
    );
    try {
      await gate.entered;
      await supervisionPass(current.root, options);
      expect(github.calls.posts).toBe(1);
    } finally {
      gate.release();
    }
    await dispatching;
    expect(github.calls.posts).toBe(1);
    expect(github.runs).toHaveLength(1);
  });

  it('fences a timed-out lookup before a replacement can POST', async () => {
    const github = await githubServer();
    const current = await fixture();
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    const lookupGate = github.defer('GET');
    const dispatching = OPERATION_REGISTRY.github_check.dispatch(
      current.root, 'demo-1', config(await task(current.root)), options,
    );
    await lookupGate.entered;
    const claimed = (await task(current.root)).operations!.at(-1)!;
    expect(claimed.attempt_phase).toBe('dispatch_lookup');
    await appendTaskEvent(current.root, {
      id: 'demo-1', project: 'demo', event: 'operation', at: AT,
      operation: { ...claimed, attempted_at: '2000-01-01T00:00:00.000Z' },
    });
    const postGate = github.defer('POST');
    const recovering = supervisionPass(current.root, options);
    try {
      await postGate.entered;
      lookupGate.release();
      await dispatching;
      expect(github.calls.posts).toBe(1);
    } finally {
      lookupGate.release();
      postGate.release();
    }
    await recovering;
    expect(github.calls.posts).toBe(1);
    expect(github.runs).toHaveLength(1);
  });

  it('marks a timed-out dispatch_post ambiguous without another POST', async () => {
    const github = await githubServer();
    const origin = await fixture();
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    await OPERATION_REGISTRY.github_check.dispatch(origin.root, 'demo-1', config(await task(origin.root)), options);
    const bound = (await task(origin.root)).operations!.at(-1)!;
    const current = await fixture();
    await appendTaskEvent(current.root, {
      id: 'demo-1', project: 'demo', event: 'operation', at: AT,
      operation: {
        ...bound, status: 'pending', external_run_id: undefined,
        attempt_id: 'crashed-post', attempted_at: '2000-01-01T00:00:00.000Z', attempt_phase: 'dispatch_post',
      },
    });
    github.runs.splice(0);
    const postsBeforeRecovery = github.calls.posts;
    const pass = await supervisionPass(current.root, options);
    expect(github.calls.posts).toBe(postsBeforeRecovery);
    expect(github.runs).toHaveLength(0);
    expect(pass.watchers).toEqual([bound.watcher_id]);
    expect((await task(current.root)).operations!.at(-1)).toMatchObject({
      status: 'blocked_external', detail: 'dispatch_ambiguous',
    });
    expect((await task(current.root)).operations!.at(-1)!.attempt_id).toBeUndefined();
    await supervisionPass(current.root, options);
    expect(github.calls.posts).toBe(postsBeforeRecovery);
    expect((await task(current.root)).operations!.at(-1)!.detail).toBe('dispatch_ambiguous');
  });

  it('binds a late original run without another POST', async () => {
    const github = await githubServer();
    const origin = await fixture();
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    await OPERATION_REGISTRY.github_check.dispatch(origin.root, 'demo-1', config(await task(origin.root)), options);
    const bound = (await task(origin.root)).operations!.at(-1)!;
    const current = await fixture();
    await appendTaskEvent(current.root, {
      id: 'demo-1', project: 'demo', event: 'operation', at: AT,
      operation: {
        ...bound, status: 'pending', external_run_id: undefined,
        attempt_id: 'crashed-post', attempted_at: '2000-01-01T00:00:00.000Z', attempt_phase: 'dispatch_post',
      },
    });
    github.runs.splice(0);
    github.runs.push({
      id: 100, head_sha: SHA, external_id: bound.external_id!, name: `hive-enforcement:${bound.external_id}`,
      status: 'in_progress', conclusion: null, app: { slug: 'hive-checks' },
    });
    const postsBeforeRecovery = github.calls.posts;
    await supervisionPass(current.root, options);
    expect(github.calls.posts).toBe(postsBeforeRecovery);
    expect((await task(current.root)).operations!.at(-1)).toMatchObject({
      status: 'blocked_external', external_run_id: '100',
    });
    expect((await task(current.root)).operations!.at(-1)!.attempt_id).toBeUndefined();
  });

  it('keeps an ambiguous late run bound through reconcile and later empty lookups', async () => {
    const github = await githubServer();
    const origin = await fixture();
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    await OPERATION_REGISTRY.github_check.dispatch(origin.root, 'demo-1', config(await task(origin.root)), options);
    const bound = (await task(origin.root)).operations!.at(-1)!;
    const current = await fixture();
    await appendTaskEvent(current.root, {
      id: 'demo-1', project: 'demo', event: 'operation', at: AT,
      operation: {
        ...bound, status: 'pending', external_run_id: undefined,
        attempt_id: 'crashed-post', attempted_at: '2000-01-01T00:00:00.000Z', attempt_phase: 'dispatch_post',
      },
    });
    github.runs.splice(0);
    await supervisionPass(current.root, options);
    expect((await task(current.root)).operations!.at(-1)!.detail).toBe('dispatch_ambiguous');
    github.runs.push({
      id: 100, head_sha: SHA, external_id: bound.external_id!, name: `hive-enforcement:${bound.external_id}`,
      status: 'in_progress', conclusion: null, app: { slug: 'hive-checks' },
    });
    await OPERATION_REGISTRY.github_check.reconcile(current.root, 'demo-1', bound.operation_id, options);
    expect((await task(current.root)).operations!.at(-1)).toMatchObject({
      status: 'blocked_external', external_run_id: '100',
    });
    expect((await task(current.root)).operations!.at(-1)!.detail).toBeUndefined();
    github.runs.splice(0);
    const postsBeforeRecovery = github.calls.posts;
    await supervisionPass(current.root, options);
    expect(github.calls.posts).toBe(postsBeforeRecovery);
    expect(github.runs).toHaveLength(0);
    expect((await task(current.root)).operations!.at(-1)!.external_run_id).toBe('100');
  });

  it('retries dispatch only after a known pre-request Refusal', async () => {
    const github = await githubServer();
    const current = await fixture();
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    const gate = github.defer('GET');
    const dispatching = OPERATION_REGISTRY.github_check.dispatch(
      current.root, 'demo-1', config(await task(current.root)), options,
    );
    try {
      await gate.entered;
      options.baseUrl = 'http://example.invalid';
    } finally {
      gate.release();
    }
    await dispatching;
    expect(github.calls.posts).toBe(0);
    expect((await task(current.root)).operations!.at(-1)).toMatchObject({ status: 'blocked_external' });
    expect((await task(current.root)).operations!.at(-1)!.attempt_id).toBeUndefined();
    expect((await task(current.root)).operations!.at(-1)!.attempt_phase).toBeUndefined();
    options.baseUrl = github.baseUrl;
    await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', config(await task(current.root)), options);
    expect(github.calls.posts).toBe(1);
    expect(github.runs).toHaveLength(1);
  });

  it('does not reopen closing_external when a pending dispatch returns a bound run', async () => {
    const github = await githubServer();
    const current = await fixture();
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    const gate = github.defer('GET');
    const dispatching = OPERATION_REGISTRY.github_check.dispatch(
      current.root, 'demo-1', config(await task(current.root)), options,
    );
    await gate.entered;
    const pending = (await task(current.root)).operations!.at(-1)!;
    github.runs.push({
      id: 100, head_sha: SHA, external_id: pending.external_id!, name: `hive-enforcement:${pending.external_id}`,
      status: 'in_progress', conclusion: null, app: { slug: 'hive-checks' },
    });
    await appendTaskEvent(current.root, {
      id: 'demo-1', project: 'demo', event: 'operation', at: AT,
      operation: {
        ...pending, status: 'closing_external', cancellation_requested: false,
        attempt_id: undefined, attempted_at: undefined, attempt_phase: undefined,
      },
    });
    gate.release();
    await dispatching;
    expect((await task(current.root)).operations!.at(-1)).toMatchObject({ status: 'closing_external' });
    expect((await task(current.root)).operations!.at(-1)!.external_run_id).toBeUndefined();
    expect(github.calls.posts).toBe(0);
  });

  it('persists cancellation during dispatch lookup and prevents a later POST', async () => {
    const github = await githubServer();
    const current = await fixture();
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    const gate = github.defer('GET');
    const dispatching = OPERATION_REGISTRY.github_check.dispatch(
      current.root, 'demo-1', config(await task(current.root)), options,
    );
    await gate.entered;
    const pending = (await task(current.root)).operations!.at(-1)!;
    await OPERATION_REGISTRY.github_check.cancel(current.root, 'demo-1', pending.operation_id, options);
    expect((await task(current.root)).operations!.at(-1)).toMatchObject({
      status: 'closing_external', cancellation_requested: false,
    });
    expect((await task(current.root)).operations!.at(-1)!.attempt_id).toBeUndefined();
    gate.release();
    await dispatching;
    await supervisionPass(current.root, options);
    expect(github.calls.posts).toBe(0);
    expect(github.runs).toHaveLength(0);
    expect((await task(current.root)).state).toBe('closing_external');
  });

  it('fences a completed old run when the plan and epoch change during reconcile', async () => {
    const github = await githubServer();
    const current = await fixture();
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', config(await task(current.root)), options);
    const operation = (await task(current.root)).operations!.at(-1)!;
    Object.assign(github.runs[0], { status: 'completed', conclusion: 'success' });
    const changedContract = { ...current.rootContract, objective: 'A replacement plan.' };
    const changedDigest = contractDigest(changedContract);
    const gate = github.defer('GET');
    const reconciling = OPERATION_REGISTRY.github_check.reconcile(current.root, 'demo-1', operation.operation_id, options);
    await gate.entered;
    try {
      await withHubLock(current.root, async () => {
        await appendTaskEvent(current.root, {
          id: 'demo-1', project: 'demo', event: 'plan', at: AT, lease_epoch: 2,
          contract: changedContract, plan_digest: changedDigest,
          checkpoints: [{ id: 'work', desc: 'verify', etaMin: 5 }],
        });
        await appendTaskEvent(current.root, {
          id: 'demo-1', project: 'demo', event: 'answered', at: AT, plan_digest: changedDigest,
        });
      });
    } finally {
      gate.release();
    }
    await reconciling;

    expect(await events(current.root, 'evidence')).toHaveLength(0);
    expect(await events(current.root, 'receipt')).toHaveLength(0);
    const changed = await task(current.root);
    expect(changed).toMatchObject({ plan_digest: changedDigest, lease_epoch: 2 });
    expect(changed.operations!.at(-1)).toMatchObject({ status: 'blocked_external', plan_digest: current.planDigest });
    await expect(PREDICATE_REGISTRY.github_check.evaluate(current.root, 'demo-1', config(changed))).resolves.toBe(false);
    await supervisionPass(current.root, options);
    expect(github.calls.posts).toBe(2);
    expect(github.runs[0].external_id).not.toBe(github.runs[1].external_id);
  });

  it('shares one in-flight cancellation PATCH across concurrent callers', async () => {
    const github = await githubServer();
    const current = await fixture();
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', config(await task(current.root)), options);
    const operation = (await task(current.root)).operations!.at(-1)!;
    const gate = github.defer('PATCH');
    const first = OPERATION_REGISTRY.github_check.cancel(current.root, 'demo-1', operation.operation_id, options);
    const second = OPERATION_REGISTRY.github_check.cancel(current.root, 'demo-1', operation.operation_id, options);
    try {
      await gate.entered;
      expect(github.calls.patches).toBe(1);
      expect((await task(current.root)).operations!.at(-1)).toMatchObject({
        status: 'closing_external', cancellation_requested: false, attempt_phase: 'cancellation_patch',
      });
    } finally {
      gate.release();
    }
    await Promise.all([first, second]);
    expect(github.calls.patches).toBe(1);
  });

  it('retries a stale pre-PATCH claim when the remote is still active', async () => {
    const github = await githubServer();
    const current = await fixture();
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', config(await task(current.root)), options);
    const operation = (await task(current.root)).operations!.at(-1)!;
    await appendTaskEvent(current.root, {
      id: 'demo-1', project: 'demo', event: 'operation', at: AT,
      operation: {
        ...operation, status: 'closing_external', cancellation_requested: false,
        attempt_id: 'crashed-cancellation', attempted_at: '2000-01-01T00:00:00.000Z',
        attempt_phase: 'cancellation_claim',
      },
    });
    await OPERATION_REGISTRY.github_check.cancel(current.root, 'demo-1', operation.operation_id, options);
    expect(github.calls.patches).toBe(1);
    expect(github.runs[0]).toMatchObject({ status: 'in_progress', cancellation_requested: true });
    expect((await task(current.root)).operations!.at(-1)).toMatchObject({
      status: 'closing_external', cancellation_requested: true,
    });
    expect((await task(current.root)).operations!.at(-1)!.attempt_id).toBeUndefined();
    await OPERATION_REGISTRY.github_check.cancel(current.root, 'demo-1', operation.operation_id, options);
    await supervisionPass(current.root, options);
    expect(github.calls.patches).toBe(1);
  });

  it('retries a timed-out cancellation_patch only while the remote is active and unrequested', async () => {
    const github = await githubServer();
    const current = await fixture();
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', config(await task(current.root)), options);
    const operation = (await task(current.root)).operations!.at(-1)!;
    await appendTaskEvent(current.root, {
      id: 'demo-1', project: 'demo', event: 'operation', at: AT,
      operation: {
        ...operation, status: 'closing_external', cancellation_requested: false,
        attempt_id: 'crashed-patch', attempted_at: '2000-01-01T00:00:00.000Z',
        attempt_phase: 'cancellation_patch',
      },
    });
    expect(github.calls.patches).toBe(0);
    expect(github.runs[0].cancellation_requested).toBeUndefined();
    await OPERATION_REGISTRY.github_check.cancel(current.root, 'demo-1', operation.operation_id, options);
    expect(github.calls.patches).toBe(1);
    expect(github.runs[0]).toMatchObject({ status: 'in_progress', cancellation_requested: true });
    await OPERATION_REGISTRY.github_check.cancel(current.root, 'demo-1', operation.operation_id, options);
    await supervisionPass(current.root, options);
    expect(github.calls.patches).toBe(1);
  });

  it('keeps a lost cancellation response ambiguous and reconciles without a blind PATCH', async () => {
    const github = await githubServer();
    const current = await fixture();
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', config(await task(current.root)), options);
    const operation = (await task(current.root)).operations!.at(-1)!;
    github.state.lostPatchResponses = 1;
    await OPERATION_REGISTRY.github_check.cancel(current.root, 'demo-1', operation.operation_id, options);
    expect((await task(current.root)).operations!.at(-1)).toMatchObject({
      status: 'closing_external', cancellation_requested: true,
    });
    expect((await events(current.root, 'evidence')).at(-1)?.evidence?.outcome).toBe('adapter-error');
    await OPERATION_REGISTRY.github_check.cancel(current.root, 'demo-1', operation.operation_id, options);
    await supervisionPass(current.root, options);
    expect(github.calls.patches).toBe(1);
    expect((await task(current.root)).state).toBe('cancelled');
    expect(await events(current.root, 'receipt')).toHaveLength(0);
  });

  it('dispatches once, recovers by identity after a crash, and resumes one record once', async () => {
    const github = await githubServer();
    const first = await fixture();
    const crashed = await fixture();
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    const firstConfig = config(await task(first.root));
    await OPERATION_REGISTRY.github_check.dispatch(first.root, 'demo-1', firstConfig, options);
    expect(github.calls.posts).toBe(1);
    expect((await task(first.root)).state).toBe('blocked_external');
    await recordFlow(first.root, 'wait-resume', 'waiting');
    const externalId = github.runs[0].external_id;

    await OPERATION_REGISTRY.github_check.dispatch(crashed.root, 'demo-1', config(await task(crashed.root)), options);
    expect(github.calls.posts).toBe(1);
    const recovered = (await task(crashed.root)).operations!.at(-1)!;
    expect(recovered).toMatchObject({
      external_id: externalId, external_run_id: '100', watcher_id: recovered.watcher_id,
      plan_digest: crashed.planDigest, artifact_digest: ARTIFACT,
    });
    await OPERATION_REGISTRY.github_check.dispatch(crashed.root, 'demo-1', config(await task(crashed.root)), options);
    expect(github.calls.posts).toBe(1);
    expect(await events(crashed.root, 'operation')).toHaveLength(3);

    Object.assign(github.runs[0], { status: 'completed', conclusion: 'success' });
    await OPERATION_REGISTRY.github_check.reconcile(crashed.root, 'demo-1', recovered.operation_id, options);
    await OPERATION_REGISTRY.github_check.reconcile(crashed.root, 'demo-1', recovered.operation_id, options);
    expect((await task(crashed.root)).state).toBe('reconciling');
    expect(await events(crashed.root, 'evidence')).toHaveLength(1);
    expect(await events(crashed.root, 'receipt')).toHaveLength(1);
    expect(await events(crashed.root, 'operation')).toHaveLength(4);
    await expect(PREDICATE_REGISTRY.github_check.evaluate(crashed.root, 'demo-1', firstConfig)).resolves.toBe(true);
    await recordFlow(crashed.root, 'wait-resume', 'resumed');
  });

  it('fails closed on missing identity without a blind retry', async () => {
    const github = await githubServer();
    const current = await fixture([acceptance({ configuration: { repository: 'octo/hive' } })]);
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    const broken = config(await task(current.root));
    await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', broken, options);
    await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', broken, options);
    expect(github.calls.posts + github.calls.lists).toBe(0);
    expect((await task(current.root))).toMatchObject({
      state: 'blocked_external', operations: [{ status: 'blocked_external', detail: 'identity_unknown' }],
    });
  });

  it('finishes a resume when a crash persisted success without its receipt', async () => {
    const github = await githubServer();
    const first = await fixture();
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    await OPERATION_REGISTRY.github_check.dispatch(first.root, 'demo-1', config(await task(first.root)), options);
    const operation = (await task(first.root)).operations!.at(-1)!;
    Object.assign(github.runs[0], { status: 'completed', conclusion: 'success' });
    await OPERATION_REGISTRY.github_check.reconcile(first.root, 'demo-1', operation.operation_id, options);

    const recovered = await fixture();
    for (const event of await readTaskEvents(first.root)) {
      if (event.event === 'evidence' || event.event === 'operation') await appendTaskEvent(recovered.root, event);
    }
    expect((await task(recovered.root)).state).toBe('blocked_external');
    expect(await events(recovered.root, 'receipt')).toHaveLength(0);
    await OPERATION_REGISTRY.github_check.reconcile(recovered.root, 'demo-1', operation.operation_id, options);
    expect((await task(recovered.root)).state).toBe('reconciling');
    expect(await events(recovered.root, 'receipt')).toHaveLength(1);
    expect(github.calls.posts).toBe(1);
  });

  it('rejects path-like repositories and cleartext non-loopback API endpoints', async () => {
    const github = await githubServer();
    const invalid = acceptance();
    const current = await fixture([{
      ...invalid, configuration: { ...invalid.configuration, repository: '../check-runs' },
    }]);
    const currentConfig = config(await task(current.root));
    await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', currentConfig, { baseUrl: github.baseUrl, allowLoopback: true });
    expect(github.calls.posts + github.calls.lists).toBe(0);
    expect((await task(current.root)).operations).toBeUndefined();

    const cleartext = await fixture();
    await OPERATION_REGISTRY.github_check.dispatch(cleartext.root, 'demo-1', config(await task(cleartext.root)), {
      baseUrl: 'http://example.invalid',
    });
    expect((await events(cleartext.root, 'evidence')).at(-1)?.evidence?.outcome).toBe('adapter-error');
    await expect(PREDICATE_REGISTRY.github_check.evaluate(cleartext.root, 'demo-1', config(await task(cleartext.root))))
      .resolves.toBe(false);
  });

  it('keeps cancel nonterminal until external proof and deduplicates close receipts', async () => {
    const github = await githubServer();
    const current = await fixture();
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    const currentTask = await task(current.root);
    await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', config(currentTask), options);
    const operation = (await task(current.root)).operations!.at(-1)!;
    await OPERATION_REGISTRY.github_check.cancel(current.root, 'demo-1', operation.operation_id, options);
    expect((await task(current.root)).state).toBe('closing_external');
    await recordFlow(current.root, 'cancel', 'closing');
    expect(github.calls.patches).toBe(1);
    await OPERATION_REGISTRY.github_check.cancel(current.root, 'demo-1', operation.operation_id, options);
    expect(github.calls.patches).toBe(1);
    Object.assign(github.runs[0], { status: 'completed', conclusion: 'cancelled' });
    await OPERATION_REGISTRY.github_check.reconcile(current.root, 'demo-1', operation.operation_id, options);
    await OPERATION_REGISTRY.github_check.reconcile(current.root, 'demo-1', operation.operation_id, options);
    expect((await task(current.root)).state).toBe('cancelled');
    expect(await events(current.root, 'cancelled')).toHaveLength(1);
    await recordFlow(current.root, 'cancel', 'proved');
  });

  it('closes on remote ownership-transfer proof and fences later success and duplicate receipts', async () => {
    const github = await githubServer();
    const current = await fixture();
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', config(await task(current.root)), options);
    const operation = (await task(current.root)).operations!.at(-1)!;
    await OPERATION_REGISTRY.github_check.cancel(current.root, 'demo-1', operation.operation_id, options);
    github.runs[0].app.slug = 'new-owner';
    await OPERATION_REGISTRY.github_check.transfer(current.root, 'demo-1', operation.operation_id, {
      ...options, newOwner: 'new-owner',
    });
    await OPERATION_REGISTRY.github_check.transfer(current.root, 'demo-1', operation.operation_id, {
      ...options, newOwner: 'new-owner',
    });
    expect((await task(current.root)).state).toBe('cancelled');
    expect((await task(current.root)).operations!.at(-1)).toMatchObject({
      owner: 'new-owner', status: 'failed', detail: 'ownership_transferred',
    });
    expect(await events(current.root, 'cancelled')).toHaveLength(1);
    expect(await events(current.root, 'operation')).toHaveLength(8);
    Object.assign(github.runs[0], { status: 'completed', conclusion: 'success' });
    await OPERATION_REGISTRY.github_check.reconcile(current.root, 'demo-1', operation.operation_id, options);
    expect((await supervisionPass(current.root, options)).watchers).toEqual([]);
    expect((await task(current.root)).state).toBe('cancelled');
    expect(await events(current.root, 'receipt')).toHaveLength(0);
    expect(await events(current.root, 'operation')).toHaveLength(8);
    await recordFlow(current.root, 'transfer', 'ownership-proved');
  });

  it('closes a transferred supersession with its replacement linkage', async () => {
    const github = await githubServer();
    const current = await fixture();
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', config(await task(current.root)), options);
    const operation = (await task(current.root)).operations!.at(-1)!;
    await appendTaskEvent(current.root, { id: 'demo-2', project: 'demo', event: 'asked', at: AT });
    const { recordTaskOutcome } = await import('../src/hub.js');
    await recordTaskOutcome(current.root, 'demo-1', 'superseded', {
      actor: 'legacy', plan_digest: current.planDigest, epoch: 1, replacement_id: 'demo-2',
    });
    expect((await task(current.root)).state).toBe('closing_external');
    github.runs[0].app.slug = 'new-owner';
    await OPERATION_REGISTRY.github_check.transfer(current.root, 'demo-1', operation.operation_id, {
      ...options, newOwner: 'new-owner',
    });
    const closed = await task(current.root);
    expect(closed.state).toBe('superseded');
    expect(closed.lease_revoked).toBe(true);
    expect((await events(current.root, 'superseded'))[0].outcome).toMatchObject({ replacement_id: 'demo-2' });
    expect(closed.operations!.at(-1)).toMatchObject({
      status: 'failed', detail: 'ownership_transferred', replacement_id: 'demo-2',
    });
    await recordFlow(current.root, 'transfer-superseded', 'ownership-proved');
  });

  it('records adapter and binding failures as evidence, never as a pass', async () => {
    const github = await githubServer();
    const current = await fixture();
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    const currentConfig = config(await task(current.root));
    await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', currentConfig, options);
    const operation = (await task(current.root)).operations!.at(-1)!;
    Object.assign(github.runs[0], { head_sha: 'f'.repeat(40), status: 'completed', conclusion: 'success' });
    await OPERATION_REGISTRY.github_check.reconcile(current.root, 'demo-1', operation.operation_id, options);
    expect((await events(current.root, 'evidence')).at(-1)?.evidence?.outcome).toBe('adapter-error');
    await expect(PREDICATE_REGISTRY.github_check.evaluate(current.root, 'demo-1', currentConfig)).resolves.toBe(false);
    expect((await task(current.root)).state).toBe('blocked_external');
    expect(await events(current.root, 'receipt')).toHaveLength(0);
  });

  it('runs one supervision pass outside agent loops and reuses one logical watcher', async () => {
    const github = await githubServer();
    const current = await fixture();
    const first = await supervisionPass(current.root, { baseUrl: github.baseUrl, allowLoopback: true });
    const second = await supervisionPass(current.root, { baseUrl: github.baseUrl, allowLoopback: true });
    expect(github.calls.posts).toBe(1);
    expect(first.watchers).toEqual(second.watchers);
    expect(first.watchers).toHaveLength(1);
    expect(await events(current.root, 'operation')).toHaveLength(4);
  });

  it('rejects wrong-app success and refuses cancellation without a strengthened binding', async () => {
    const github = await githubServer();
    const current = await fixture();
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    const currentConfig = config(await task(current.root));
    await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', currentConfig, options);
    const operation = (await task(current.root)).operations!.at(-1)!;
    Object.assign(github.runs[0], { status: 'completed', conclusion: 'success', app: { slug: 'attacker' } });
    await OPERATION_REGISTRY.github_check.reconcile(current.root, 'demo-1', operation.operation_id, options);
    expect((await events(current.root, 'evidence')).filter((event) => event.evidence?.outcome === 'passed')).toHaveLength(0);
    expect(await events(current.root, 'receipt')).toHaveLength(0);
    await expect(PREDICATE_REGISTRY.github_check.evaluate(current.root, 'demo-1', currentConfig)).resolves.toBe(false);
    await OPERATION_REGISTRY.github_check.cancel(current.root, 'demo-1', operation.operation_id, options);
    expect(github.calls.patches).toBe(0);
    expect((await task(current.root)).state).toBe('blocked_external');
    expect(await events(current.root, 'cancelled')).toHaveLength(0);
  });

  it('requires approved current provenance before dispatch and isolates similar external IDs', async () => {
    const github = await githubServer();
    const unapproved = await fixture([acceptance()], false);
    const before = await readTaskEvents(unapproved.root);
    await OPERATION_REGISTRY.github_check.dispatch(unapproved.root, 'demo-1', config(await task(unapproved.root)), {
      baseUrl: github.baseUrl, allowLoopback: true,
    });
    expect(github.calls.posts + github.calls.lists).toBe(0);
    expect(await readTaskEvents(unapproved.root)).toEqual(before);
    expect((await task(unapproved.root)).state).toBe('plan');
    await appendTaskEvent(unapproved.root, {
      id: 'demo-1', project: 'demo', event: 'answered', at: AT, plan_digest: unapproved.planDigest,
    });
    await OPERATION_REGISTRY.github_check.dispatch(unapproved.root, 'demo-1', config(await task(unapproved.root)), {
      baseUrl: github.baseUrl, allowLoopback: true,
    });
    expect(github.calls.posts).toBe(1);

    const other = await fixture([acceptance({ id: 'other-check' })]);
    const otherConfig = { ...config(await task(other.root)), acceptance_id: 'other-check' };
    await OPERATION_REGISTRY.github_check.dispatch(other.root, 'demo-1', otherConfig, {
      baseUrl: github.baseUrl, allowLoopback: true,
    });
    expect(github.runs).toHaveLength(2);
    expect(github.runs[0].external_id).not.toBe(github.runs[1].external_id);

    const mismatch = await fixture();
    const mismatched = config(await task(mismatch.root), { repository: 'octo/other', sha: 'f'.repeat(40) });
    const original = await readTaskEvents(mismatch.root);
    await OPERATION_REGISTRY.github_check.dispatch(mismatch.root, 'demo-1', mismatched, {
      baseUrl: github.baseUrl, allowLoopback: true,
    });
    expect(await readTaskEvents(mismatch.root)).toEqual(original);
    expect(github.calls.posts).toBe(2);
  });

  it.each(['repository', 'sha'] as const)('rejects a registered %s mismatch through supervisionPass', async (field) => {
    const github = await githubServer();
    const item = acceptance();
    const configuration = {
      ...item.configuration,
      [field]: field === 'repository' ? 'octo/other' : 'f'.repeat(40),
    };
    const current = await fixture([{ ...item, configuration }]);
    const before = await readTaskEvents(current.root);
    await supervisionPass(current.root, { baseUrl: github.baseUrl, allowLoopback: true });
    expect(github.requests).toHaveLength(0);
    expect(await readTaskEvents(current.root)).toEqual(before);
  });

  it('binds operation identity to the root epoch across an identical approved rebrief', async () => {
    const github = await githubServer();
    const current = await fixture();
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', config(await task(current.root)), options);
    const oldOperation = (await task(current.root)).operations!.at(-1)!;
    await appendTaskEvent(current.root, { id: 'demo-1', project: 'demo', event: 'asked', at: AT });
    await appendTaskEvent(current.root, {
      id: 'demo-1', project: 'demo', event: 'plan', at: AT, lease_epoch: 2,
      contract: current.rootContract, plan_digest: current.planDigest,
      checkpoints: [{ id: 'work', desc: 'verify', etaMin: 5 }],
    });
    await appendTaskEvent(current.root, {
      id: 'demo-1', project: 'demo', event: 'answered', at: AT, plan_digest: current.planDigest,
    });
    await supervisionPass(current.root, options);
    const currentTask = await task(current.root);
    expect(currentTask.lease_epoch).toBe(2);
    expect(currentTask.operations).toHaveLength(8);
    expect(github.calls.posts).toBe(2);
    expect(github.runs[0].external_id).not.toBe(github.runs[1].external_id);
    const newOperation = currentTask.operations!.at(-1)!;
    expect(newOperation.operation_id).not.toBe(oldOperation.operation_id);
    expect(newOperation.epoch).toBe(2);

    Object.assign(github.runs[1], { status: 'completed', conclusion: 'success' });
    await OPERATION_REGISTRY.github_check.reconcile(current.root, 'demo-1', newOperation.operation_id, options);
    expect((await events(current.root, 'receipt')).at(-1)?.receipt?.epoch).toBe(2);
    await expect(PREDICATE_REGISTRY.github_check.evaluate(current.root, 'demo-1', config(currentTask)))
      .resolves.toBe(true);
    const calls = github.requests.length;
    const currentEvents = await readTaskEvents(current.root);
    await OPERATION_REGISTRY.github_check.reconcile(current.root, 'demo-1', oldOperation.operation_id, options);
    expect(github.requests.length).toBe(calls);
    expect(await readTaskEvents(current.root)).toEqual(currentEvents);
  });

  it.each([undefined, '2026-11-22T12:00:00.000Z'])('requires exact deadline equality for %s', async (deadline) => {
    const github = await githubServer();
    const current = await fixture();
    const before = await readTaskEvents(current.root);
    await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', config(await task(current.root), { deadline }), {
      baseUrl: github.baseUrl, allowLoopback: true,
    });
    expect(github.requests).toHaveLength(0);
    expect(await readTaskEvents(current.root)).toEqual(before);
  });

  it('refuses to extend a watcher with a mismatched stored deadline', async () => {
    const github = await githubServer();
    const current = await fixture();
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', config(await task(current.root)), options);
    const operation = (await task(current.root)).operations!.at(-1)!;
    await appendTaskEvent(current.root, {
      id: 'demo-1', project: 'demo', event: 'operation', at: AT,
      operation: { ...operation, deadline: '2026-11-22T12:00:00.000Z' },
    });
    const before = await readTaskEvents(current.root);
    const calls = github.requests.length;
    await OPERATION_REGISTRY.github_check.reconcile(current.root, 'demo-1', operation.operation_id, options);
    expect(github.requests.length).toBe(calls);
    expect(await readTaskEvents(current.root)).toEqual(before);
  });

  it('keeps unknown and stale operations out of every watcher and mutation path', async () => {
    const github = await githubServer();
    const unknown = await fixture([acceptance({ configuration: { repository: 'octo/hive' } })]);
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    const broken = config(await task(unknown.root));
    await OPERATION_REGISTRY.github_check.dispatch(unknown.root, 'demo-1', broken, options);
    const operation = (await task(unknown.root)).operations!.at(-1)!;
    await OPERATION_REGISTRY.github_check.reconcile(unknown.root, 'demo-1', operation.operation_id, options);
    await OPERATION_REGISTRY.github_check.cancel(unknown.root, 'demo-1', operation.operation_id, options);
    await OPERATION_REGISTRY.github_check.transfer(unknown.root, 'demo-1', operation.operation_id, {
      ...options, newOwner: 'someone',
    });
    const pass = await supervisionPass(unknown.root, options);
    expect(pass.watchers).toEqual([]);
    expect(github.calls.posts + github.calls.lists + github.calls.patches).toBe(0);
    expect((await task(unknown.root)).operations!.at(-1)!.detail).toBe('identity_unknown');

    const stale = await fixture();
    await OPERATION_REGISTRY.github_check.dispatch(stale.root, 'demo-1', config(await task(stale.root)), options);
    const staleOperation = (await task(stale.root)).operations!.at(-1)!;
    const changedContract = { ...stale.rootContract, objective: 'A replacement plan.' };
    await appendTaskEvent(stale.root, {
      id: 'demo-1', project: 'demo', event: 'plan', at: AT, contract: changedContract,
      plan_digest: contractDigest(changedContract), lease_epoch: 2,
      checkpoints: [{ id: 'work', desc: 'verify', etaMin: 5 }],
    });
    await appendTaskEvent(stale.root, {
      id: 'demo-1', project: 'demo', event: 'answered', at: AT, plan_digest: contractDigest(changedContract),
    });
    const calls = github.requests.length;
    const staleEvents = await readTaskEvents(stale.root);
    await OPERATION_REGISTRY.github_check.reconcile(stale.root, 'demo-1', staleOperation.operation_id, options);
    await OPERATION_REGISTRY.github_check.cancel(stale.root, 'demo-1', staleOperation.operation_id, options);
    expect(github.requests.length).toBe(calls);
    expect(await readTaskEvents(stale.root)).toEqual(staleEvents);
  });

  it('continues healthy dispatch after another task expires', async () => {
    const github = await githubServer();
    const current = await fixture([acceptance()], true, 60);
    const healthy = contract([acceptance()], 3600);
    const healthyDigest = contractDigest(healthy);
    await appendTaskEvent(current.root, { id: 'demo-2', project: 'demo', event: 'asked', at: AT, lease_epoch: 1 });
    await appendTaskEvent(current.root, {
      id: 'demo-2', project: 'demo', event: 'plan', at: AT, contract: healthy, plan_digest: healthyDigest,
      checkpoints: [{ id: 'work', desc: 'verify', etaMin: 5 }],
    });
    await appendTaskEvent(current.root, { id: 'demo-2', project: 'demo', event: 'answered', at: AT, plan_digest: healthyDigest });
    await appendTaskEvent(current.root, {
      id: 'demo-2', project: 'demo', event: 'progress', at: AT, checkpoint: 'work', status: 'ok',
    });
    const expired = Date.parse(AT) + 61_000;
    await supervisionPass(current.root, { baseUrl: github.baseUrl, allowLoopback: true }, expired);
    expect(github.calls.posts).toBe(1);
    expect((await task(current.root)).state).toBe('blocked:budget_exhausted');
    const healthyTask = foldTasks(await readTaskEvents(current.root)).find((candidate) => candidate.id === 'demo-2')!;
    expect(healthyTask.operations!.at(-1)!.status).toBe('blocked_external');
  });

  it('does not POST or replace the budget headline when dispatch lookup finishes after expiry', async () => {
    const github = await githubServer();
    const current = await fixture([acceptance()], true, 60);
    const options = { baseUrl: github.baseUrl, allowLoopback: true, now: Date.parse(AT) };
    const gate = github.defer('GET');
    const dispatching = OPERATION_REGISTRY.github_check.dispatch(
      current.root, 'demo-1', config(await task(current.root)), options,
    );
    try {
      await gate.entered;
      await reconcileTaskBudgets(current.root, Date.parse(AT) + 61_000);
      expect((await task(current.root)).state).toBe('blocked:budget_exhausted');
    } finally {
      gate.release();
    }
    await dispatching;
    expect(github.calls.posts).toBe(0);
    expect((await task(current.root)).state).toBe('blocked:budget_exhausted');
    expect(await events(current.root, 'evidence')).toHaveLength(0);
  });

  it('drops a dispatch binding when POST completes after budget revocation', async () => {
    const github = await githubServer();
    const current = await fixture([acceptance()], true, 60);
    const options = { baseUrl: github.baseUrl, allowLoopback: true, now: Date.parse(AT) };
    const gate = github.defer('POST');
    const dispatching = OPERATION_REGISTRY.github_check.dispatch(
      current.root, 'demo-1', config(await task(current.root)), options,
    );
    try {
      await gate.entered;
      await reconcileTaskBudgets(current.root, Date.parse(AT) + 61_000);
    } finally {
      gate.release();
    }
    await dispatching;
    expect(github.calls.posts).toBe(1);
    expect(github.runs).toHaveLength(1);
    expect((await task(current.root)).state).toBe('blocked:budget_exhausted');
    expect((await task(current.root)).operations!.at(-1)).toMatchObject({
      status: 'pending', attempt_phase: 'dispatch_post',
    });
    expect((await task(current.root)).operations!.at(-1)!.external_run_id).toBeUndefined();
    expect(await events(current.root, 'evidence')).toHaveLength(0);
    expect(await events(current.root, 'receipt')).toHaveLength(0);
  });

  it.each(['active', 'error', 'success'] as const)(
    'drops a late %s reconcile result after budget revocation', async (result) => {
      const github = await githubServer();
      const current = await fixture([acceptance()], true, 60);
      const options = { baseUrl: github.baseUrl, allowLoopback: true, now: Date.parse(AT) };
      await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', config(await task(current.root)), options);
      const operation = (await task(current.root)).operations!.at(-1)!;
      const operationEvents = await events(current.root, 'operation');
      if (result === 'success') Object.assign(github.runs[0], { status: 'completed', conclusion: 'success' });
      if (result === 'error') github.state.getFailures = 1;
      const gate = github.defer('GET');
      const reconciling = OPERATION_REGISTRY.github_check.reconcile(current.root, 'demo-1', operation.operation_id, options);
      try {
        await gate.entered;
        await reconcileTaskBudgets(current.root, Date.parse(AT) + 61_000);
      } finally {
        gate.release();
      }
      await reconciling;
      expect((await task(current.root)).state).toBe('blocked:budget_exhausted');
      expect(await events(current.root, 'operation')).toHaveLength(operationEvents.length);
      expect(await events(current.root, 'evidence')).toHaveLength(0);
      expect(await events(current.root, 'receipt')).toHaveLength(0);
    },
  );

  it('fences direct success after root expiry without blocking valid closure', async () => {
    const github = await githubServer();
    const current = await fixture([acceptance()], true, 60);
    const options = { baseUrl: github.baseUrl, allowLoopback: true, now: Date.parse(AT) };
    await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', config(await task(current.root)), options);
    const operation = (await task(current.root)).operations!.at(-1)!;
    Object.assign(github.runs[0], { status: 'completed', conclusion: 'success' });
    const expired = Date.parse(AT) + 61_000;
    await supervisionPass(current.root, options, expired);
    const before = await readTaskEvents(current.root);
    await OPERATION_REGISTRY.github_check.reconcile(current.root, 'demo-1', operation.operation_id, { ...options, now: expired });
    expect(await readTaskEvents(current.root)).toEqual(before);
    expect((await task(current.root)).state).toBe('blocked:budget_exhausted');
    expect((await task(current.root)).operations!.at(-1)!.status).toBe('blocked_external');
    expect((await events(current.root, 'evidence')).filter((event) => event.evidence?.outcome === 'passed')).toHaveLength(0);
    expect(await events(current.root, 'receipt')).toHaveLength(0);

    const closeGithub = await githubServer();
    const closeOptions = { baseUrl: closeGithub.baseUrl, allowLoopback: true, now: Date.parse(AT) };
    const closing = await fixture([acceptance()], true, 60);
    await OPERATION_REGISTRY.github_check.dispatch(closing.root, 'demo-1', config(await task(closing.root)), closeOptions);
    const closingOperation = (await task(closing.root)).operations!.at(-1)!;
    await OPERATION_REGISTRY.github_check.cancel(closing.root, 'demo-1', closingOperation.operation_id, closeOptions);
    Object.assign(closeGithub.runs[0], { status: 'completed', conclusion: 'cancelled' });
    await supervisionPass(closing.root, closeOptions, expired);
    expect((await task(closing.root)).state).toBe('cancelled');
  });

  it('keeps an uncertain close ambiguous through missing runs without a blind PATCH', async () => {
    const github = await githubServer();
    const current = await fixture();
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', config(await task(current.root)), options);
    const operation = (await task(current.root)).operations!.at(-1)!;
    github.state.patchFailures = 1;
    await OPERATION_REGISTRY.github_check.cancel(current.root, 'demo-1', operation.operation_id, options);
    expect((await task(current.root)).state).toBe('closing_external');
    await OPERATION_REGISTRY.github_check.cancel(current.root, 'demo-1', operation.operation_id, options);
    expect(github.calls.patches).toBe(1);

    github.runs.splice(0);
    await OPERATION_REGISTRY.github_check.reconcile(current.root, 'demo-1', operation.operation_id, options);
    await supervisionPass(current.root, options);
    expect((await task(current.root)).state).toBe('closing_external');
    expect(github.calls.posts).toBe(1);
    github.runs.push({
      ...operation, id: 100, head_sha: SHA, external_id: operation.external_id!, name: 'hive-enforcement:' + operation.external_id,
      status: 'completed', conclusion: 'success', app: { slug: 'hive-checks' },
    } as CheckRun);
    await OPERATION_REGISTRY.github_check.reconcile(current.root, 'demo-1', operation.operation_id, options);
    expect((await task(current.root)).state).toBe('closing_external');
    expect(await events(current.root, 'receipt')).toHaveLength(0);
  });

  it('quarantines expired watchers without requests, success, or blind retry', async () => {
    const github = await githubServer();
    const expired = acceptance();
    const current = await fixture([{
      ...expired, configuration: { ...expired.configuration, deadline: '2026-11-20T00:00:00.000Z' },
    }]);
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', config(await task(current.root)), options);
    expect(github.calls.posts + github.calls.lists).toBe(0);
    const pass = await supervisionPass(current.root, options);
    expect(pass.watchers).toEqual([]);
    expect((await task(current.root)).state).toBe('blocked_external:deadline_exceeded');
    expect(await events(current.root, 'receipt')).toHaveLength(0);
    expect(await events(current.root, 'evidence')).toHaveLength(0);
  });

  it('allows only the official origin or explicit loopback tests and blocks redirects and streaming overflow', async () => {
    const github = await githubServer();
    const current = await fixture();
    const currentConfig = config(await task(current.root));
    for (const options of [
      { baseUrl: github.baseUrl, token: 'secret-test-token' },
      { baseUrl: 'https://example.invalid', token: 'secret-test-token' },
      { baseUrl: 'http://169.254.169.254', allowLoopback: true, token: 'secret-test-token' },
    ]) {
      await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', currentConfig, options);
    }
    expect(github.requests).toHaveLength(0);

    let redirected = 0;
    let redirectedAuthorization = false;
    const target = createServer((req) => {
      redirected++;
      redirectedAuthorization = Boolean(req.headers.authorization);
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    servers.add(target);
    const targetPort = (target.address() as AddressInfo).port;
    const redirect = createServer((req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/steal` });
      res.end();
    });
    await new Promise<void>((resolve) => redirect.listen(0, '127.0.0.1', resolve));
    servers.add(redirect);
    const redirectPort = (redirect.address() as AddressInfo).port;
    await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', currentConfig, {
      baseUrl: `http://127.0.0.1:${redirectPort}`, allowLoopback: true, token: 'secret-test-token',
    });
    expect(redirected).toBe(0);
    expect(redirectedAuthorization).toBe(false);

    let completed = false;
    let releaseOversizedResponse!: () => void;
    const oversizedResponse = new Promise<void>((resolve) => { releaseOversizedResponse = resolve; });
    const oversized = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"check_runs":[');
      res.write('x'.repeat(1024 * 1024));
      void oversizedResponse.then(() => {
        res.end(']}');
        completed = true;
      });
    });
    await new Promise<void>((resolve) => oversized.listen(0, '127.0.0.1', resolve));
    servers.add(oversized);
    const oversizedPort = (oversized.address() as AddressInfo).port;
    try {
      await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', currentConfig, {
        baseUrl: `http://127.0.0.1:${oversizedPort}`, allowLoopback: true,
      });
      expect(completed).toBe(false);
      expect((await events(current.root, 'evidence')).at(-1)?.evidence?.content).toMatchObject({
        detail: 'GitHub API response exceeds the byte cap',
      });
    } finally {
      releaseOversizedResponse();
    }
  });
});

describe('acceptance outcome evidence binding', () => {
  it('rejects another acceptance registered hash through recordTaskOutcome', async () => {
    const github = await githubServer();
    const required = taskEvidenceDigests({ run: 'other' }, { conclusion: 'success' });
    const first = acceptance({ id: 'github-a', required_evidence: [required.evidence_hash] });
    const second = acceptance({ id: 'github-b' });
    const current = await fixture([first, second]);
    const options = { baseUrl: github.baseUrl, allowLoopback: true };
    for (const acceptanceId of ['github-a', 'github-b']) {
      const currentConfig = config(await task(current.root), { acceptance_id: acceptanceId });
      await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', currentConfig, options);
      Object.assign(github.runs.at(-1)!, { status: 'completed', conclusion: 'success' });
      const operation = (await task(current.root)).operations!.at(-1)!;
      await OPERATION_REGISTRY.github_check.reconcile(current.root, 'demo-1', operation.operation_id, options);
    }
    const currentTask = await task(current.root);
    const operationB = currentTask.operations!.find((operation) => operation.acceptance_id === 'github-b')!;
    await appendTaskEvent(current.root, {
      id: 'demo-1', project: 'demo', event: 'evidence', at: AT,
      evidence: {
        actor: 'adapter:github_check', plan_digest: current.planDigest, epoch: 1, outcome: 'passed',
        artifact: { run: 'other' }, content: { conclusion: 'success' }, ...required,
        artifact_digest: ARTIFACT,
        verification: {
          adapter_id: 'github_check', evidence_type: 'github_check', acceptance_id: 'github-b',
          provenance_digest: operationB.idempotency_key,
        },
      },
    });
    await expect(recordTaskOutcome(current.root, 'demo-1', 'done', {
      actor: 'legacy', plan_digest: current.planDigest, epoch: 1,
    })).rejects.toThrow(/registered acceptance/);
    expect((await task(current.root)).state).not.toBe('done');
  });
});

describe('read-only work-tree projection', () => {
  it('keeps unique lineage across seeded descendants and never marks non-success outcomes done', () => {
    let seed = 0x51ce6;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    for (let iteration = 0; iteration < 40; iteration++) {
      const states = ['running', 'blocked_external', 'closing_external', 'done', 'already_fixed', 'duplicate', 'no_op', 'failed', 'unknown', 'superseded'];
      const state = states[Math.floor(random() * states.length)];
      const currentContract = contract([{ ...acceptance(), id: 'custom%20', predicate_id: 'predicate%20' }]);
      const current = {
        id: 'demo-1', project: 'demo', asked: AT, updated: AT, state, last_note: null, needs_owner: false,
        plan_digest: contractDigest(currentContract), lease_epoch: 1, plan_approved: true,
        contract: currentContract,
      } as HubTask;
      const child: TeamEntry = {
        name: 'builder', task: 'demo-1', pane: '%7', session_id: 'session-parent', lease_id: 'lease-1',
        parent_id: 'demo-1', adapter: 'tmux', lineage_id: 'lineage-1', attempts_used: 2, admission_status: 'running',
        plan_digest: current.plan_digest!, write_scope: ['src'],
      };
      const branch = {
        schemaVersion: 1, id: '7ca3c50b-8304-45f0-a925-f41d10a14cf2', kind: 'child', purpose: 'Review',
        parentSessionId: 'session-parent', childSessionId: 'session-child', workspaceId: 'workspace', cwd: '/secret',
        scope: { project: 'demo', agent: 'builder', task: 'demo-1' },
        parentSnapshot: { count: 0, headId: null, historyHash: 'p', messages: [] }, childSnapshot: null,
        status: 'active', createdAt: AT, updatedAt: AT, leaseId: 'native-1',
      } as NativeBranchRecord;
      const input = { tasks: [current], teams: { demo: [child] }, branches: [branch], events: [] };
      const before = JSON.stringify(input);
      const tree = buildWorkTree(input);
      expect(JSON.stringify(input)).toBe(before);
      expect(new Set(tree.nodes.map((node) => node.id)).size).toBe(tree.nodes.length);
      expect(tree.nodes.map((node) => node.kind).sort()).toEqual(['native', 'task', 'tmux']);
      for (const node of tree.nodes) {
        expect(node.parentId === null || tree.nodes.some((parent) => parent.id === node.parentId)).toBe(true);
        expect(node.doneEnabled).toBe(false);
      }
      const root = tree.nodes.find((node) => node.kind === 'task')!;
      expect(root.done).toBe(state === 'done');
      expect(root.active).toBe(!['done', 'already_fixed', 'duplicate', 'no_op', 'failed', 'unknown', 'superseded', 'cancelled'].includes(state));
      expect(root.acceptance[0]).toMatchObject({
        acceptanceId: 'custom%20', predicateId: 'predicate%20', blocker: expect.stringContaining('custom%20'),
      });
      expect(root.doneBlockers.some((blocker) => blocker.includes('custom%20'))).toBe(true);
      expect(JSON.stringify(tree)).not.toContain('/secret');
      expect(JSON.stringify(tree)).not.toContain('%7');
      expect(JSON.stringify(tree)).toContain('builder');
      expect(JSON.stringify(tree)).toContain('custom%20');
    }
  });

  it('joins distinct required evidence events when enabling Done', async () => {
    const github = await githubServer();
    const first = taskEvidenceDigests({ run: 1 }, { conclusion: 'success' });
    const second = taskEvidenceDigests({ run: 2 }, { conclusion: 'success' });
    const item = acceptance({ required_evidence: [first.evidence_hash, second.evidence_hash] });
    const current = await fixture([item]);
    await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', config(await task(current.root)), {
      baseUrl: github.baseUrl, allowLoopback: true,
    });
    const currentTask = await task(current.root);
    const operation = currentTask.operations!.at(-1)!;
    await appendTaskEvent(current.root, {
      id: 'demo-1', project: 'demo', event: 'operation', at: AT,
      operation: { ...operation, status: 'succeeded', result: { remote_tip: SHA } },
    });
    for (const [index, digests] of [first, second].entries()) {
      await appendTaskEvent(current.root, {
        id: 'demo-1', project: 'demo', event: 'evidence', at: AT,
        evidence: {
          actor: 'adapter:github_check', plan_digest: current.planDigest, epoch: 1, outcome: 'passed',
          artifact: { run: index + 1 }, content: { conclusion: 'success' }, ...digests,
          artifact_digest: ARTIFACT,
          verification: { adapter_id: 'github_check', evidence_type: 'github_check', provenance_digest: operation.idempotency_key },
        },
      });
    }
    const events = await readTaskEvents(current.root);
    const tree = buildWorkTree({ tasks: foldTasks(events), teams: { demo: [] }, branches: [], events });
    expect(tree.nodes[0].doneEnabled).toBe(true);
    expect(tree.nodes[0].doneBlockers).toEqual([]);
  });
});
