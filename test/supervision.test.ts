import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OPERATION_REGISTRY, PREDICATE_REGISTRY } from '../src/evidence.js';
import { buildWorkTree, supervisionPass } from '../src/supervision.js';
import { appendTaskEvent, contractDigest, foldTasks, readTaskEvents, writeJson, writeProjects } from '../src/state.js';
import type {
  HubTask, NativeBranchRecord, RootContract, TaskAcceptance, TeamEntry,
} from '../src/types.js';

const SHA = 'a'.repeat(40);
const ARTIFACT = 'b'.repeat(64);
const AT = '2026-11-20T12:00:00.000Z';
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
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://github.test');
      const send = (value: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.method === 'POST' && url.pathname === '/repos/octo/hive/check-runs') {
        calls.posts++;
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
        send(run);
        return;
      }
      if (req.method === 'PATCH') {
        calls.patches++;
        run.cancellation_requested = true;
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
      owner: 'hive-checks', deadline: '2026-11-21T12:00:00.000Z',
    },
    required_evidence: ['github-check'],
    ...overrides,
  };
}

function contract(items: TaskAcceptance[]): RootContract {
  return {
    schema_version: 1, objective: 'Verify the external artifact.', consumer: 'demo-orchestrator',
    deliverable: 'a verified check', kind: 'build', acceptance: items,
    provenance: { repository: 'octo/hive', base_revision: '0'.repeat(40), artifact_revision: SHA },
    write_scope: ['src'], action_scope: [],
    budget: { depth: 2, active_children: 4, active_project_records: 8, attempts: 3 },
    delegation: { output_claims: ['a verified check'], adapters: ['tmux', 'native'] },
  };
}

async function fixture(items = [acceptance()]) {
  const root = await mkdtemp(path.join(tmpdir(), 'hive-supervision-'));
  const home = path.join(root, 'demo');
  const rootContract = contract(items);
  const planDigest = contractDigest(rootContract);
  await writeProjects(root, { projects: [{ name: 'demo', home, repos: [] }] });
  await writeJson(path.join(home, '.hive', 'team.json'), { agents: [] });
  await appendTaskEvent(root, { id: 'demo-1', project: 'demo', event: 'asked', at: AT, lease_epoch: 1 });
  await appendTaskEvent(root, {
    id: 'demo-1', project: 'demo', event: 'plan', at: AT, contract: rootContract, plan_digest: planDigest,
    checkpoints: [{ id: 'work', desc: 'verify', etaMin: 5 }],
  });
  await appendTaskEvent(root, { id: 'demo-1', project: 'demo', event: 'answered', at: AT, plan_digest: planDigest });
  await appendTaskEvent(root, { id: 'demo-1', project: 'demo', event: 'progress', at: AT, checkpoint: 'work', status: 'ok' });
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

async function recordFlow(root: string, fixture: string, label: string): Promise<void> {
  const directory = process.env.HIVE_TEST_ARTIFACTS;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const current = await task(root);
  const record = {
    journey: 'GITHUB_CHECK_SUPERVISION', fixture, label, head: process.env.GITHUB_SHA ?? 'local-hook',
    state: current.state, operations: current.operations?.map((operation) => ({
      id: operation.operation_id, status: operation.status, owner: operation.owner,
      externalId: operation.external_run_id, watcherId: operation.watcher_id,
    })),
  };
  await appendFile(path.join(directory, 'GITHUB_CHECK_SUPERVISION-state-flow.jsonl'), `${JSON.stringify(record)}\n`);
}

describe('github check supervision', () => {
  it('dispatches once, recovers by identity after a crash, and resumes one record once', async () => {
    const github = await githubServer();
    const first = await fixture();
    const crashed = await fixture();
    const options = { baseUrl: github.baseUrl };
    const firstConfig = config(await task(first.root));
    await OPERATION_REGISTRY.github_check.dispatch(first.root, 'demo-1', firstConfig, options);
    expect(github.calls.posts).toBe(1);
    expect((await task(first.root)).state).toBe('blocked_external');
    await recordFlow(first.root, 'wait-resume', 'waiting');
    const externalId = github.runs[0].external_id;

    await OPERATION_REGISTRY.github_check.dispatch(crashed.root, 'demo-1', config(await task(crashed.root)), options);
    expect(github.calls.posts).toBe(1);
    const recovered = (await task(crashed.root)).operations![0];
    expect(recovered).toMatchObject({
      external_id: externalId, external_run_id: '100', watcher_id: recovered.watcher_id,
      plan_digest: crashed.planDigest, artifact_digest: ARTIFACT,
    });
    await OPERATION_REGISTRY.github_check.dispatch(crashed.root, 'demo-1', config(await task(crashed.root)), options);
    expect(github.calls.posts).toBe(1);
    expect(await events(crashed.root, 'operation')).toHaveLength(1);

    Object.assign(github.runs[0], { status: 'completed', conclusion: 'success' });
    await OPERATION_REGISTRY.github_check.reconcile(crashed.root, 'demo-1', recovered.operation_id, options);
    await OPERATION_REGISTRY.github_check.reconcile(crashed.root, 'demo-1', recovered.operation_id, options);
    expect((await task(crashed.root)).state).toBe('reconciling');
    expect(await events(crashed.root, 'evidence')).toHaveLength(1);
    expect(await events(crashed.root, 'receipt')).toHaveLength(1);
    expect(await events(crashed.root, 'operation')).toHaveLength(2);
    await expect(PREDICATE_REGISTRY.github_check.evaluate(crashed.root, 'demo-1', firstConfig)).resolves.toBe(true);
    await recordFlow(crashed.root, 'wait-resume', 'resumed');
  });

  it('fails closed on missing identity without a blind retry', async () => {
    const github = await githubServer();
    const current = await fixture([acceptance({ configuration: { repository: 'octo/hive' } })]);
    const options = { baseUrl: github.baseUrl };
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
    const options = { baseUrl: github.baseUrl };
    await OPERATION_REGISTRY.github_check.dispatch(first.root, 'demo-1', config(await task(first.root)), options);
    const operation = (await task(first.root)).operations![0];
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
    await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', currentConfig, { baseUrl: github.baseUrl });
    expect(github.calls.posts + github.calls.lists).toBe(0);
    expect((await task(current.root)).operations![0].detail).toBe('identity_unknown');

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
    const options = { baseUrl: github.baseUrl };
    const currentTask = await task(current.root);
    await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', config(currentTask), options);
    const operation = (await task(current.root)).operations![0];
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

  it('accepts only remote ownership-transfer proof and never treats it as cancellation', async () => {
    const github = await githubServer();
    const current = await fixture();
    const options = { baseUrl: github.baseUrl };
    await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', config(await task(current.root)), options);
    const operation = (await task(current.root)).operations![0];
    await OPERATION_REGISTRY.github_check.cancel(current.root, 'demo-1', operation.operation_id, options);
    github.runs[0].app.slug = 'new-owner';
    await OPERATION_REGISTRY.github_check.transfer(current.root, 'demo-1', operation.operation_id, {
      ...options, newOwner: 'new-owner',
    });
    await OPERATION_REGISTRY.github_check.transfer(current.root, 'demo-1', operation.operation_id, {
      ...options, newOwner: 'new-owner',
    });
    expect((await task(current.root)).state).toBe('blocked_external');
    expect((await task(current.root)).operations!.at(-1)).toMatchObject({ owner: 'new-owner', status: 'blocked_external' });
    expect(await events(current.root, 'cancelled')).toHaveLength(0);
    expect(await events(current.root, 'operation')).toHaveLength(3);
    await recordFlow(current.root, 'transfer', 'ownership-proved');
  });

  it('records adapter and binding failures as evidence, never as a pass', async () => {
    const github = await githubServer();
    const current = await fixture();
    const options = { baseUrl: github.baseUrl };
    const currentConfig = config(await task(current.root));
    await OPERATION_REGISTRY.github_check.dispatch(current.root, 'demo-1', currentConfig, options);
    const operation = (await task(current.root)).operations![0];
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
    const first = await supervisionPass(current.root, { baseUrl: github.baseUrl });
    const second = await supervisionPass(current.root, { baseUrl: github.baseUrl });
    expect(github.calls.posts).toBe(1);
    expect(first.watchers).toEqual(second.watchers);
    expect(first.watchers).toHaveLength(1);
    expect(await events(current.root, 'operation')).toHaveLength(1);
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
      const current = {
        id: 'demo-1', project: 'demo', asked: AT, updated: AT, state, last_note: null, needs_owner: false,
        plan_digest: 'c'.repeat(64), lease_epoch: 1, plan_approved: true,
        contract: contract([acceptance()]),
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
      expect(JSON.stringify(tree)).not.toContain('/secret');
    }
  });
});
