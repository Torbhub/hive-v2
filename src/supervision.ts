import { randomUUID } from 'node:crypto';
import { reconcileTaskBudgets, revokeTaskAdmissionsLocked } from './admission.js';
import {
  acceptanceAdmission, acceptanceReceipt, evidenceAcceptanceBound, REGISTERED_PREDICATES, registeredEvidenceBinding,
} from './acceptance.js';
import { sweepQuestionBatches } from './questions.js';
import {
  appendTaskEvent, assertTaskBudgetCurrent, contractDigest, doneBlockers, foldTasks, readProjects, readTaskEvents, Refusal,
  taskBudgetExpired, taskEvidenceDigests, valueDigest, withHubLock, withTeamLock,
} from './state.js';
import { CLOSED_STATES } from './types.js';
import { withoutPaneIds } from './window-name.js';
import type {
  AcceptanceEvidenceRow, HubTask, NativeBranchRecord, TaskAcceptance, TaskEvidence, TaskEvent, TaskOperation,
  TaskReceipt, TeamEntry, WorkTree, WorkTreeNode,
} from './types.js';

export type GitHubCheckConfig = {
  repository?: string;
  sha?: string;
  external_id?: string;
  artifact_digest?: string;
  plan_digest?: string;
  acceptance_id?: string; owner?: string; deadline?: string;
};
export type GitHubOptions = { baseUrl?: string; token?: string; allowLoopback?: boolean; now?: number };
export type GitHubTransferOptions = GitHubOptions & { newOwner: string };

type CheckRun = {
  id: number; head_sha: string; external_id: string;
  name: string; status: string; conclusion: string | null;
  app?: { slug?: string }; cancellation_requested?: boolean;
};

const API_VERSION = '2022-11-28';
const CHECK_NAME = 'hive-enforcement';

function checkName(externalId: string): string {
  return `${CHECK_NAME}:${externalId}`;
}

function validIdentity(config: GitHubCheckConfig): boolean {
  const repositoryParts = (config.repository ?? '').split('/');
  return repositoryParts.length === 2
    && repositoryParts.every((part) => /^[A-Za-z0-9_.-]{1,100}$/.test(part) && part !== '.' && part !== '..')
    && /^[0-9a-f]{40}$/i.test(config.sha ?? '')
    && typeof config.external_id === 'string' && config.external_id.length > 0 && config.external_id.length <= 200
    && /^[0-9a-f]{64}$/.test(config.artifact_digest ?? '')
    && /^[0-9a-f]{64}$/.test(config.plan_digest ?? '')
    && typeof config.owner === 'string' && config.owner.length > 0 && config.owner.length <= 100
    && (config.deadline === undefined || config.deadline.length <= 40 && Number.isFinite(Date.parse(config.deadline)));
}

function operationFor(task: HubTask, config: GitHubCheckConfig): TaskOperation {
  const binding = {
    project: task.project, task: task.id, acceptance: config.acceptance_id,
    repository: config.repository, sha: config.sha, external_id: config.external_id,
    plan_digest: config.plan_digest, artifact_digest: config.artifact_digest, owner: config.owner,
    epoch: task.lease_epoch,
  };
  const idempotency = valueDigest(binding);
  const suffix = idempotency.slice(0, 32);
  return {
    operation_id: `github-check-${suffix}`,
    idempotency_key: idempotency,
    kind: 'github_check',
    actor: 'adapter:github_check',
    plan_digest: task.plan_digest ?? '',
    epoch: task.lease_epoch ?? 0,
    repository_fingerprint: valueDigest(config.repository ?? 'unknown'),
    commit: config.sha ?? '',
    branch: config.external_id ?? config.acceptance_id ?? 'unknown',
    status: 'blocked_external',
    updated_at: new Date().toISOString(),
    owner: config.owner,
    repository: config.repository,
    external_id: `github-check-${idempotency}`,
    artifact_digest: config.artifact_digest,
    resume_condition: `github_check:${config.external_id}@${config.sha} conclusion=success`,
    deadline: config.deadline,
    watcher_id: `github-check-watcher-${suffix}`,
    acceptance_id: config.acceptance_id,
  };
}

function unknownOperation(task: HubTask, config: GitHubCheckConfig): TaskOperation {
  const suffix = valueDigest({ task: task.id, acceptance: config.acceptance_id, plan: task.plan_digest }).slice(0, 32);
  return {
    ...operationFor(task, config),
    operation_id: `github-check-${suffix}`,
    watcher_id: `github-check-watcher-${suffix}`,
    status: 'blocked_external',
    detail: 'identity_unknown',
  };
}

function registeredConfig(task: HubTask, config: GitHubCheckConfig): boolean {
  if (!task.plan_approved || !task.contract || !task.plan_digest || contractDigest(task.contract) !== task.plan_digest
    || config.plan_digest !== task.plan_digest || !provenanceMatches(task, config)) return false;
  const acceptance = task.contract.acceptance.find((candidate) => candidate.id === config.acceptance_id
    && candidate.predicate_id === 'github_check' && candidate.version === 1);
  return Boolean(acceptance
    && acceptance.configuration.repository === config.repository
    && acceptance.configuration.sha === config.sha
    && acceptance.configuration.external_id === config.external_id
    && acceptance.configuration.artifact_digest === config.artifact_digest
    && acceptance.configuration.owner === config.owner
    && acceptance.configuration.deadline === config.deadline);
}

function provenanceMatches(task: HubTask, config: GitHubCheckConfig): boolean {
  return task.contract?.provenance.kind !== 'research'
    && (config.repository === undefined || config.repository === task.contract?.provenance.repository)
    && (config.sha === undefined || config.sha === task.contract?.provenance.artifact_revision);
}

function currentOperation(task: HubTask, operation: TaskOperation): boolean {
  if (operation.detail === 'identity_unknown') return false;
  const acceptance = task.contract?.acceptance.find((candidate) => candidate.id === operation.acceptance_id);
  const config = {
    ...acceptance?.configuration, acceptance_id: operation.acceptance_id, plan_digest: operation.plan_digest,
  } as GitHubCheckConfig;
  if (!registeredConfig(task, config) || !validIdentity(config) || operation.epoch !== task.lease_epoch) return false;
  const expected = operationFor(task, config);
  return operation.operation_id === expected.operation_id
    && operation.idempotency_key === expected.idempotency_key
    && operation.external_id === expected.external_id
    && operation.repository === expected.repository
    && operation.commit === expected.commit
    && operation.artifact_digest === expected.artifact_digest
    && operation.branch === expected.branch && operation.deadline === expected.deadline
    && (operation.owner === config.owner || operation.previous_owner === config.owner);
}

function expired(operation: TaskOperation, now = Date.now()): boolean {
  return operation.deadline !== undefined && Date.parse(operation.deadline) <= now;
}

async function currentTask(root: string, id: string): Promise<HubTask> {
  const task = foldTasks(await readTaskEvents(root)).find((candidate) => candidate.id === id);
  if (!task) throw new Refusal(`unknown task: ${id}`);
  return task;
}

function latest<T>(values: T[], matches: (value: T) => boolean): T | undefined {
  for (let index = values.length - 1; index >= 0; index--) {
    if (matches(values[index])) return values[index];
  }
  return undefined;
}

function latestOperation(task: HubTask, operationId: string): TaskOperation | undefined {
  return latest(task.operations ?? [], (operation) => operation.operation_id === operationId);
}

function sameOperation(left: TaskOperation, right: TaskOperation): boolean {
  const { updated_at: _leftUpdated, ...leftFields } = left;
  const { updated_at: _rightUpdated, ...rightFields } = right;
  return valueDigest(leftFields) === valueDigest(rightFields);
}

async function appendOperation(root: string, task: HubTask, operation: TaskOperation): Promise<void> {
  const previous = latestOperation(task, operation.operation_id);
  if (previous && sameOperation(previous, operation)) return;
  await appendTaskEvent(root, {
    id: task.id, project: task.project, event: 'operation', at: new Date().toISOString(),
    operation: { ...operation, updated_at: new Date().toISOString() },
  });
}

async function apiRequest(options: GitHubOptions, pathname: string, init: {
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
} = {}): Promise<unknown> {
  const base = options.baseUrl ?? process.env.HIVE_GITHUB_API_URL ?? 'https://api.github.com';
  const endpoint = new URL(pathname, base.endsWith('/') ? base : `${base}/`);
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(endpoint.hostname);
  const official = endpoint.origin === 'https://api.github.com';
  const testServer = options.allowLoopback === true && endpoint.protocol === 'http:' && loopback;
  if (!official && !testServer || endpoint.username || endpoint.password) {
    throw new Refusal('GitHub API allows only api.github.com or an explicit loopback test server');
  }
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': API_VERSION,
    'user-agent': 'hive-v2-supervision',
  };
  const token = options.token ?? process.env.GITHUB_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(endpoint, {
    method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: 'error', signal: AbortSignal.timeout(2_000),
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) {
          void reader.cancel().catch(() => {});
          throw new Error('GitHub API response exceeds the byte cap');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
  const raw = Buffer.concat(chunks).toString('utf8');
  const value = raw ? JSON.parse(raw) : {};
  if (!value || typeof value !== 'object') throw new Error('GitHub API returned a non-object');
  return value;
}

function readRun(value: unknown): CheckRun {
  const run = value as Partial<CheckRun>;
  if (!Number.isSafeInteger(run.id) || !/^[0-9a-f]{40}$/i.test(run.head_sha ?? '')
    || typeof run.external_id !== 'string' || run.external_id.length > 200
    || typeof run.status !== 'string' || run.status.length > 64
    || typeof run.name !== 'string' || run.name.length > 256
    || (run.conclusion !== null && (typeof run.conclusion !== 'string' || run.conclusion.length > 64))
    || (run.app?.slug !== undefined && run.app.slug.length > 100)) {
    throw new Error('GitHub check-run response is invalid');
  }
  return run as CheckRun;
}

async function findRun(operation: TaskOperation, options: GitHubOptions, owner?: string): Promise<CheckRun | undefined> {
  const bound = owner ? { ...operation, owner } : operation;
  if (operation.external_run_id) {
    const run = readRun(await apiRequest(options, `repos/${operation.repository}/check-runs/${operation.external_run_id}`));
    return runBound(bound, run) ? run : undefined;
  }
  for (let page = 1; page <= 10; page++) {
    const query = new URLSearchParams({
      check_name: checkName(operation.external_id!), external_id: operation.external_id!,
      per_page: '100', page: String(page),
    });
    const result = await apiRequest(
      options,
      `repos/${operation.repository}/commits/${operation.commit}/check-runs?${query}`,
    ) as { check_runs?: unknown[] };
    if (!Array.isArray(result.check_runs)) throw new Error('GitHub check-run list is invalid');
    const matches = result.check_runs.map(readRun).filter((run) => runBound(
      { ...bound, external_run_id: String(run.id) }, run,
    ));
    if (matches.length > 1) throw new Error('GitHub check-run identity is ambiguous');
    if (matches[0]) return matches[0];
    if (result.check_runs.length < 100) return undefined;
  }
  throw new Error('GitHub check-run identity exceeded the page cap');
}

function runBound(operation: TaskOperation, run: CheckRun): boolean {
  return (!operation.external_run_id || String(run.id) === operation.external_run_id)
    && run.head_sha === operation.commit
    && run.external_id === operation.external_id
    && run.name === checkName(operation.external_id!)
    && run.app?.slug === operation.owner;
}

async function appendAdapterEvidence(
  root: string, task: HubTask, operation: TaskOperation, run: CheckRun | undefined,
  outcome: 'passed' | 'failed' | 'adapter-error', detail?: string,
): Promise<TaskEvidence> {
  const artifact = {
    repository: operation.repository, sha: operation.commit, external_id: operation.external_id,
    external_run_id: operation.external_run_id, artifact_digest: operation.artifact_digest,
  };
  const content = {
    status: run?.status, conclusion: run?.conclusion, external_id: run?.external_id,
    head_sha: run?.head_sha, detail,
  };
  const evidence: TaskEvidence = {
    actor: operation.actor, plan_digest: operation.plan_digest, epoch: operation.epoch,
    outcome, artifact, content, ...taskEvidenceDigests(artifact, content),
    artifact_digest: operation.artifact_digest!,
    verification: {
      adapter_id: 'github_check', evidence_type: 'github_check', provenance_digest: operation.idempotency_key,
      acceptance_id: operation.acceptance_id,
    },
  };
  const existing = latest(await readTaskEvents(root), (event) => event.id === task.id
    && event.event === 'evidence' && event.evidence?.evidence_hash === evidence.evidence_hash
    && event.evidence.outcome === outcome && event.evidence.plan_digest === evidence.plan_digest
    && event.evidence.epoch === evidence.epoch);
  if (!existing) {
    await appendTaskEvent(root, { id: task.id, project: task.project, event: 'evidence', at: new Date().toISOString(), evidence });
  }
  return evidence;
}

async function failRun(
  root: string, task: HubTask, operation: TaskOperation, run: CheckRun | undefined,
  outcome: 'failed' | 'adapter-error', detail: string,
): Promise<void> {
  await appendAdapterEvidence(root, task, operation, run, outcome, detail);
  await appendOperation(root, task, {
    ...operation, status: operation.status === 'closing_external' ? 'closing_external' : 'blocked_external', detail,
  });
}

async function passRun(root: string, task: HubTask, operation: TaskOperation, run: CheckRun, now?: number): Promise<void> {
  if (taskBudgetExpired(task, now)) return;
  const evidence = await appendAdapterEvidence(root, task, operation, run, 'passed');
  await appendOperation(root, task, {
    ...operation, status: 'succeeded', result: { remote_tip: operation.commit, reconciled: true }, detail: undefined,
  });
  const sequence = task.last_receipt_sequence ?? 0;
  const receipt: TaskReceipt = {
    actor: operation.actor, plan_digest: operation.plan_digest, epoch: operation.epoch,
    sequence: sequence + 1, artifact_digest: operation.artifact_digest!, counters: {},
    external_ids: { github_check: String(run.id) }, evidence_hashes: [evidence.evidence_hash], state: 'reconciling',
  };
  if (task.last_receipt?.state !== 'reconciling'
    || valueDigest(task.last_receipt.external_ids) !== valueDigest(receipt.external_ids)) {
    await appendTaskEvent(root, { id: task.id, project: task.project, event: 'receipt', at: new Date().toISOString(), receipt });
  }
}

async function finishClose(
  root: string, task: HubTask, operation: TaskOperation, run: CheckRun,
  proof: 'external_cancelled' | 'ownership_transferred',
): Promise<void> {
  if (CLOSED_STATES.has(task.state) || !currentOperation(task, operation) || !runBound(operation, run)) return;
  const project = (await readProjects(root)).projects.find((candidate) => candidate.name === task.project);
  if (!project) throw new Refusal(`unknown project: ${task.project}`);
  await withTeamLock(project.home, () => revokeTaskAdmissionsLocked(root, project.home, task.id));
  const reason = proof === 'external_cancelled' ? 'external cancellation proved' : 'external ownership transfer proved';
  await appendTaskEvent(root, operation.close_outcome === 'superseded' ? {
    id: task.id, project: task.project, event: 'superseded', at: new Date().toISOString(),
    note: `GitHub check ${run.id} closed by ${proof}`, outcome: {
      actor: operation.actor, plan_digest: operation.plan_digest, epoch: operation.epoch,
      replacement_id: operation.replacement_id, reason,
    },
  } : {
    id: task.id, project: task.project, event: 'cancelled', at: new Date().toISOString(),
    note: `GitHub check ${run.id} closed by ${proof}`,
  });
  await appendOperation(root, task, {
    ...operation, status: 'failed', detail: proof, watcher_id: undefined,
    result: { remote_tip: run.head_sha, reconciled: true },
  });
}

function matchingOperation(task: HubTask, expected: TaskOperation): TaskOperation | undefined {
  const operation = latestOperation(task, expected.operation_id);
  if (!operation || operation.kind !== 'github_check' || !sameOperation(operation, expected)
    || !currentOperation(task, operation)) return undefined;
  return operation;
}

async function reconcileLocked(
  root: string, id: string, operationId: string, options: GitHubOptions,
): Promise<TaskOperation | undefined> {
  const task = await currentTask(root, id);
  const operation = latestOperation(task, operationId);
  if (!operation || operation.kind !== 'github_check' || operation.detail === 'identity_unknown'
    || CLOSED_STATES.has(task.state) || !currentOperation(task, operation)) return undefined;
  if (expired(operation, options.now)) {
    await appendOperation(root, task, { ...operation, detail: 'deadline_exceeded' });
    return undefined;
  }
  if (operation.status !== 'closing_external' && taskBudgetExpired(task, options.now)) return undefined;
  if (operation.status === 'succeeded' && task.state === 'reconciling') return undefined;
  return operation;
}

const CLAIM_TIMEOUT_MS = 60_000;

type AttemptPhase = NonNullable<TaskOperation['attempt_phase']>;

function clearAttempt(operation: TaskOperation): TaskOperation {
  return { ...operation, attempt_id: undefined, attempted_at: undefined, attempt_phase: undefined };
}

function startAttempt(operation: TaskOperation, phase: AttemptPhase): TaskOperation {
  return { ...operation, attempt_id: randomUUID(), attempted_at: new Date().toISOString(), attempt_phase: phase };
}

function staleClaim(operation: TaskOperation): boolean {
  if (!operation.attempt_phase) return false;
  const claimedAt = Date.parse(operation.attempted_at ?? '');
  return !Number.isFinite(claimedAt) || Date.now() - claimedAt > CLAIM_TIMEOUT_MS;
}

type DispatchIntent = { operation: TaskOperation; lookup: boolean; claim: boolean };

export async function dispatchGithubCheck(
  root: string, id: string, config: GitHubCheckConfig, options: GitHubOptions = {}, recoverPending = false,
): Promise<TaskOperation> {
  const intent = await withHubLock(root, async (): Promise<DispatchIntent> => {
    const task = await currentTask(root, id);
    const operation = operationFor(task, config);
    if (!registeredConfig(task, config)) return { operation, lookup: false, claim: false };
    assertTaskBudgetCurrent(task, options.now);
    if (!validIdentity(config)) {
      const wrongRepository = config.repository !== undefined && config.repository !== task.contract?.provenance.repository;
      const wrongSha = config.sha !== undefined && config.sha !== task.contract?.provenance.artifact_revision;
      if (wrongRepository || wrongSha) return { operation, lookup: false, claim: false };
      const unknown = unknownOperation(task, config);
      await appendOperation(root, task, unknown);
      return { operation: unknown, lookup: false, claim: false };
    }
    if (expired(operation, options.now)) {
      const quarantined = { ...operation, detail: 'deadline_exceeded' };
      await appendOperation(root, task, quarantined);
      return { operation: quarantined, lookup: false, claim: false };
    }
    const existing = latestOperation(task, operation.operation_id);
    if (existing?.detail === 'identity_unknown' || existing?.status === 'succeeded'
      || existing?.status === 'closing_external' || existing?.detail === 'deadline_exceeded') {
      return { operation: existing, lookup: false, claim: false };
    }
    if (existing && (existing.idempotency_key !== operation.idempotency_key
      || existing.plan_digest !== operation.plan_digest || existing.artifact_digest !== operation.artifact_digest)) {
      const ambiguous = { ...existing, status: 'ambiguous' as const, detail: 'operation identity changed' };
      await appendOperation(root, task, ambiguous);
      return { operation: ambiguous, lookup: false, claim: false };
    }
    if (!existing) {
      const pending = { ...operation, status: 'pending' as const };
      await appendOperation(root, task, pending);
      return { operation: pending, lookup: true, claim: true };
    }
    return {
      operation: existing, lookup: true,
      claim: !existing.external_run_id && existing.detail !== 'dispatch_ambiguous'
        && (existing.status !== 'pending' || recoverPending),
    };
  });
  if (!intent.lookup) return intent.operation;

  const claimed = await withHubLock(root, async (): Promise<DispatchIntent> => {
    const task = await currentTask(root, id);
    if (!intent.claim) return intent;
    const current = matchingOperation(task, intent.operation);
    if (!current) {
      return {
        operation: latestOperation(task, intent.operation.operation_id) ?? intent.operation,
        lookup: false, claim: false,
      };
    }
    if (current.attempt_phase === 'dispatch_post'
      || current.attempt_phase === 'dispatch_lookup' && !staleClaim(current)) {
      return { operation: current, lookup: true, claim: false };
    }
    const pending = startAttempt({ ...current, status: 'pending' }, 'dispatch_lookup');
    await appendOperation(root, task, pending);
    return { operation: pending, lookup: true, claim: true };
  });
  if (!claimed.lookup) return claimed.operation;

  let activeOperation = claimed.operation;
  let run: CheckRun | undefined;
  try {
    run = await findRun(activeOperation, options);
    if (!run && claimed.claim) {
      const posting = await withHubLock(root, async () => {
        const task = await currentTask(root, id);
        const current = matchingOperation(task, activeOperation);
        if (!current || current.attempt_phase !== 'dispatch_lookup' || current.external_run_id
          || taskBudgetExpired(task, options.now)) return undefined;
        const next = { ...current, attempted_at: new Date().toISOString(), attempt_phase: 'dispatch_post' as const };
        await appendOperation(root, task, next);
        return next;
      });
      if (!posting) return latestOperation(await currentTask(root, id), activeOperation.operation_id) ?? activeOperation;
      activeOperation = posting;
      run = readRun(await apiRequest(options, `repos/${activeOperation.repository}/check-runs`, {
        method: 'POST',
        idempotencyKey: activeOperation.idempotency_key,
        body: {
          name: checkName(activeOperation.external_id!), head_sha: activeOperation.commit,
          external_id: activeOperation.external_id, status: 'in_progress',
        },
      }));
    }
  } catch (error) {
    if (!claimed.claim) return activeOperation;
    return withHubLock(root, async () => {
      const task = await currentTask(root, id);
      const current = matchingOperation(task, activeOperation);
      if (current && !taskBudgetExpired(task, options.now)) {
        const unsent = current.attempt_phase === 'dispatch_lookup'
          || current.attempt_phase === 'dispatch_post' && error instanceof Refusal;
        const failed = unsent ? clearAttempt(current) : current;
        await failRun(root, task, failed, undefined, 'adapter-error', error instanceof Error ? error.message : String(error));
      }
      return { ...activeOperation, detail: 'adapter_error' };
    });
  }
  if (!run && activeOperation.attempt_phase === 'dispatch_post' && staleClaim(activeOperation)) {
    return withHubLock(root, async () => {
      const task = await currentTask(root, id);
      const current = matchingOperation(task, activeOperation);
      if (!current) return latestOperation(task, activeOperation.operation_id) ?? activeOperation;
      if (current.attempt_phase !== 'dispatch_post' || !staleClaim(current)
        || current.external_run_id || taskBudgetExpired(task, options.now)) return current;
      const ambiguous = clearAttempt({ ...current, status: 'blocked_external', detail: 'dispatch_ambiguous' });
      await appendOperation(root, task, ambiguous);
      return ambiguous;
    });
  }
  if (!run) return activeOperation;
  return withHubLock(root, async () => {
    const task = await currentTask(root, id);
    const current = matchingOperation(task, activeOperation);
    if (!current) return latestOperation(task, activeOperation.operation_id) ?? activeOperation;
    if (taskBudgetExpired(task, options.now)) return current;
    const bound = {
      ...current, external_run_id: String(run.id),
      status: 'blocked_external' as const,
      detail: runBound({ ...current, external_run_id: String(run.id) }, run) ? undefined : 'external identity binding changed',
    };
    const next = clearAttempt(bound);
    await appendOperation(root, task, next);
    return next;
  });
}

export async function reconcileGithubCheck(
  root: string, id: string, operationId: string, options: GitHubOptions = {},
): Promise<void> {
  const operation = await withHubLock(root, () => reconcileLocked(root, id, operationId, options));
  if (!operation) return;
  let run: CheckRun | undefined;
  let failure: string | undefined;
  try {
    run = await findRun(operation, options);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  await withHubLock(root, async () => {
    const task = await currentTask(root, id);
    const current = matchingOperation(task, operation);
    if (!current || CLOSED_STATES.has(task.state)) return;
    if (current.status !== 'closing_external' && taskBudgetExpired(task, options.now)) return;
    if (current.detail === 'dispatch_ambiguous' && (failure || !run)) return;
    if (failure) {
      await failRun(root, task, current, undefined, 'adapter-error', failure);
      return;
    }
    if (!run) {
      await failRun(root, task, current, undefined, 'adapter-error', 'external identity not found');
      return;
    }
    if (!runBound(current, run)) {
      await failRun(root, task, current, run, 'adapter-error', 'external identity binding changed');
      return;
    }
    const bound = { ...current, external_run_id: String(run.id) };
    if (bound.status === 'closing_external') {
      if (run.status === 'completed' && run.conclusion === 'cancelled') {
        await finishClose(root, task, bound, run, 'external_cancelled');
      }
      return;
    }
    if (run.status !== 'completed') {
      await appendOperation(root, task, { ...bound, status: 'blocked_external', detail: undefined });
      return;
    }
    if (run.conclusion === 'success') {
      await passRun(root, task, bound, run, options.now);
      return;
    }
    await appendAdapterEvidence(root, task, bound, run, 'failed', `GitHub conclusion: ${run.conclusion ?? 'unknown'}`);
    await appendOperation(root, task, {
      ...bound, status: 'failed', detail: `GitHub conclusion: ${run.conclusion ?? 'unknown'}`,
    });
  });
}

export async function cancelGithubCheck(
  root: string, id: string, operationId: string, options: GitHubOptions = {},
): Promise<void> {
  const operation = await withHubLock(root, async () => {
    const task = await currentTask(root, id);
    const operation = latestOperation(task, operationId);
    if (!operation || operation.kind !== 'github_check' || operation.detail === 'identity_unknown'
      || CLOSED_STATES.has(task.state) || !currentOperation(task, operation)) return undefined;
    if (expired(operation, options.now)) {
      await appendOperation(root, task, { ...operation, detail: 'deadline_exceeded' });
      return undefined;
    }
    return operation;
  });
  if (!operation) return;
  let run: CheckRun | undefined;
  let failure: string | undefined;
  try {
    run = await findRun(operation, options);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  const claim = await withHubLock(root, async () => {
    const task = await currentTask(root, id);
    const current = matchingOperation(task, operation);
    if (!current || CLOSED_STATES.has(task.state)) return undefined;
    if (failure || !run) {
      if (current.status !== 'closing_external' && !current.external_run_id) {
        await appendOperation(root, task, clearAttempt({
          ...current, status: 'closing_external', cancellation_requested: false,
        }));
      } else if (!current.attempt_phase) {
        await failRun(root, task, current, undefined, 'adapter-error', failure ?? 'external identity not found');
      }
      return undefined;
    }
    const closing = { ...current, status: 'closing_external' as const };
    if (run.status === 'completed' && run.conclusion === 'cancelled') {
      const closed = clearAttempt(closing);
      await appendOperation(root, task, closed);
      await finishClose(root, task, closed, run, 'external_cancelled');
      return undefined;
    }
    if (run.status === 'completed') {
      await appendOperation(root, task, clearAttempt(closing));
      return undefined;
    }
    if (current.cancellation_requested || run.cancellation_requested) {
      await appendOperation(root, task, clearAttempt({ ...closing, cancellation_requested: true }));
      return undefined;
    }
    if ((current.attempt_phase === 'cancellation_patch' || current.attempt_phase === 'cancellation_claim')
      && !staleClaim(current)) return undefined;
    const claimed = startAttempt({ ...closing, cancellation_requested: false }, 'cancellation_claim');
    await appendOperation(root, task, claimed);
    return { operation: claimed, run };
  });
  if (!claim) return;
  const patch = await withHubLock(root, async () => {
    const task = await currentTask(root, id);
    const current = matchingOperation(task, claim.operation);
    if (!current || CLOSED_STATES.has(task.state)) return undefined;
    const patching = { ...current, attempted_at: new Date().toISOString(), attempt_phase: 'cancellation_patch' as const };
    await appendOperation(root, task, patching);
    return { operation: patching, run: claim.run };
  });
  if (!patch) return;
  let patchError: unknown;
  try {
    await apiRequest(options, `repos/${patch.operation.repository}/check-runs/${patch.run.id}`, {
      method: 'PATCH', body: { status: 'completed', conclusion: 'cancelled' },
    });
  } catch (error) {
    patchError = error;
  }
  await withHubLock(root, async () => {
    const task = await currentTask(root, id);
    const current = matchingOperation(task, patch.operation);
    if (!current || CLOSED_STATES.has(task.state)) return;
    if (patchError) {
      const failed = {
        ...clearAttempt(current), cancellation_requested: !(patchError instanceof Refusal),
      };
      await failRun(root, task, failed, undefined, 'adapter-error',
        patchError instanceof Error ? patchError.message : String(patchError));
      return;
    }
    await appendOperation(root, task, clearAttempt({ ...current, cancellation_requested: true }));
  });
}

export async function transferGithubCheck(
  root: string, id: string, operationId: string, options: GitHubTransferOptions,
): Promise<void> {
  if (!options.newOwner.trim()) throw new Refusal('ownership transfer needs a new owner');
  const operation = await withHubLock(root, async () => {
    const task = await currentTask(root, id);
    const operation = latestOperation(task, operationId);
    if (!operation || operation.status !== 'closing_external' || operation.detail === 'identity_unknown'
      || CLOSED_STATES.has(task.state) || !currentOperation(task, operation)) return undefined;
    if (expired(operation, options.now)) {
      await appendOperation(root, task, { ...operation, detail: 'deadline_exceeded' });
      return undefined;
    }
    return operation;
  });
  if (!operation) return;
  const run = await findRun(operation, options, options.newOwner);
  await withHubLock(root, async () => {
    const task = await currentTask(root, id);
    const current = matchingOperation(task, operation);
    if (!current || CLOSED_STATES.has(task.state)) return;
    if (!run) {
      await failRun(root, task, current, run, 'adapter-error', 'ownership transfer proof does not match');
      return;
    }
    await finishClose(root, task, {
      ...current, owner: options.newOwner, previous_owner: current.owner,
      cancellation_requested: false, detail: undefined,
    }, run, 'ownership_transferred');
  });
}

export async function evaluateGithubCheck(root: string, id: string, config: GitHubCheckConfig): Promise<boolean> {
  const events = await readTaskEvents(root);
  const task = foldTasks(events).find((candidate) => candidate.id === id);
  if (!task || taskBudgetExpired(task) || config.plan_digest !== task.plan_digest || !validIdentity(config)) return false;
  const operation = latestOperation(task, operationFor(task, config).operation_id);
  if (!operation || !currentOperation(task, operation)
    || operation.status !== 'succeeded' || operation.result?.remote_tip !== operation.commit) return false;
  return events.some((event) => event.id === id && event.event === 'evidence'
    && event.evidence?.outcome === 'passed' && event.evidence.plan_digest === task.plan_digest
    && event.evidence.epoch === task.lease_epoch && event.evidence.artifact_digest === config.artifact_digest
    && event.evidence.verification?.adapter_id === 'github_check'
    && event.evidence.verification.provenance_digest === operation.idempotency_key);
}

export async function supervisionPass(root: string, options: GitHubOptions = {}, now = Date.now()): Promise<{ watchers: string[] }> {
  await reconcileTaskBudgets(root, now);
  await sweepQuestionBatches(root, now);
  const passOptions = { ...options, now };
  const tasks = foldTasks(await readTaskEvents(root));
  for (const task of tasks) {
    if (!task.contract || CLOSED_STATES.has(task.state) || taskBudgetExpired(task, now)) continue;
    for (const acceptance of task.contract.acceptance) {
      if (acceptance.predicate_id !== 'github_check' || acceptance.version !== 1) continue;
      const config = { ...acceptance.configuration, acceptance_id: acceptance.id, plan_digest: task.plan_digest } as GitHubCheckConfig;
      const operation = latestOperation(task, operationFor(task, config).operation_id);
      if (operation?.status !== 'closing_external') await dispatchGithubCheck(root, task.id, config, passOptions, true);
    }
  }
  const watchers = new Set<string>();
  for (const task of foldTasks(await readTaskEvents(root))) {
    const latest = new Map<string, TaskOperation>();
    for (const operation of task.operations ?? []) {
      if (operation.kind === 'github_check') latest.set(operation.operation_id, operation);
    }
    for (const operation of latest.values()) {
      if (operation.status !== 'blocked_external' && operation.status !== 'closing_external') continue;
      if (!currentOperation(task, operation)) continue;
      if (expired(operation, now)) {
        await reconcileGithubCheck(root, task.id, operation.operation_id, passOptions);
        continue;
      }
      if (operation.status !== 'closing_external' && taskBudgetExpired(task, now)) continue;
      if (operation.watcher_id) watchers.add(operation.watcher_id);
      if (operation.status === 'closing_external' && !operation.cancellation_requested) {
        await cancelGithubCheck(root, task.id, operation.operation_id, passOptions);
      } else {
        await reconcileGithubCheck(root, task.id, operation.operation_id, passOptions);
      }
    }
  }
  return { watchers: [...watchers].sort() };
}

export type WorkTreeInput = {
  tasks: HubTask[];
  teams: Record<string, TeamEntry[]>;
  branches: NativeBranchRecord[];
  events: TaskEvent[];
};

const NODE_CAP = 500;
const TEXT_CAP = 500;

function bounded(value: string | undefined): string | undefined {
  return value?.slice(0, TEXT_CAP);
}

function boundedBlocker(value: string | undefined): string | undefined {
  return value === undefined ? undefined : bounded(withoutPaneIds(value));
}

function detail(label: string, value: string | undefined): { label: string; value: string }[] {
  return value ? [{ label, value: bounded(value)! }] : [];
}

function latestOperations(task: HubTask, currentOnly = true): TaskOperation[] {
  const operations = new Map<string, TaskOperation>();
  const poisoned = new Set<string>();
  for (const operation of task.operations ?? []) {
    if (currentOnly && (operation.plan_digest !== task.plan_digest || operation.epoch !== task.lease_epoch)) continue;
    const previous = operations.get(operation.operation_id);
    const identity = (candidate: TaskOperation) => valueDigest({
      idempotency_key: candidate.idempotency_key, kind: candidate.kind, actor: candidate.actor,
      lease_id: candidate.lease_id, repository_fingerprint: candidate.repository_fingerprint,
      commit: candidate.commit, branch: candidate.branch, external_id: candidate.external_id,
      artifact_digest: candidate.artifact_digest,
    });
    if (previous && identity(previous) !== identity(operation)) poisoned.add(operation.operation_id);
    operations.set(operation.operation_id, poisoned.has(operation.operation_id)
      ? { ...operation, status: 'ambiguous', detail: 'operation identity changed' }
      : operation);
  }
  return [...operations.values()];
}

function acceptanceOperation(task: HubTask, acceptance: TaskAcceptance): TaskOperation | undefined {
  return latest(latestOperations(task, false), (operation) => operation.kind === 'github_check'
    && operation.acceptance_id === acceptance.id);
}

export function githubAcceptanceProvenance(task: HubTask, acceptance: TaskAcceptance): string | undefined {
  const operation = acceptanceOperation(task, acceptance);
  return operation && currentOperation(task, operation) && operation.status === 'succeeded'
    && operation.result?.remote_tip === operation.commit ? operation.idempotency_key : undefined;
}

function currentEvidenceBinding(
  task: HubTask, acceptance: TaskAcceptance, evidence: TaskEvidence, operation: TaskOperation | undefined,
  entries: TeamEntry[], receipt?: TaskReceipt,
): boolean {
  const provenance = acceptance.predicate_id === 'github_check' && operation && currentOperation(task, operation)
    ? operation.idempotency_key : undefined;
  return registeredEvidenceBinding(task, acceptance, evidence, entries, provenance, receipt);
}

function legacyBinding(
  task: HubTask, acceptance: TaskAcceptance, evidence: TaskEvidence, operation: TaskOperation | undefined,
  entries: TeamEntry[],
): boolean {
  if (!evidenceAcceptanceBound(task, acceptance, evidence)) return false;
  const configuredArtifact = acceptance.configuration.artifact_digest;
  if (typeof configuredArtifact === 'string' && evidence.artifact_digest !== configuredArtifact) return false;
  if (acceptance.predicate_id === 'github_check') {
    return Boolean(operation && evidence.verification!.provenance_digest === operation.idempotency_key);
  }
  if (acceptance.predicate_id === 'task_receipt' && !evidence.lease_id) return true;
  return Boolean(acceptanceAdmission(task, acceptance, evidence, entries));
}

function rowTarget(task: HubTask, operation: TaskOperation | undefined): string {
  if (task.contract?.provenance.kind === 'research') return 'n/a research';
  const result = operation?.result?.remote_tip;
  return typeof result === 'string' && /^[0-9a-f]{40}$/i.test(result)
    ? result : task.contract?.provenance.artifact_revision ?? '—';
}

function rowBlocker(result: AcceptanceEvidenceRow['result']): string | undefined {
  if (result === 'PASS') return undefined;
  if (result === 'PENDING') return 'registered evidence is still pending';
  if (result === 'NOT_RUN') return 'no current registered attempt';
  return 'registered evidence failed or does not match the current acceptance';
}

export function acceptanceEvidenceRows(
  task: HubTask, events: TaskEvent[], entries: TeamEntry[] = [],
): AcceptanceEvidenceRow[] {
  const rows: AcceptanceEvidenceRow[] = [];
  if (!task.contract) return rows;
  for (const acceptance of task.contract.acceptance) {
    const operation = acceptance.predicate_id === 'github_check' ? acceptanceOperation(task, acceptance) : undefined;
    const base = {
      acceptanceId: bounded(acceptance.id)!, predicateId: bounded(acceptance.predicate_id)!,
      required: acceptance.required !== false, artifactDigest: '—', target: bounded(rowTarget(task, operation))!,
    };
    if (!task.plan_digest || contractDigest(task.contract) !== task.plan_digest) {
      rows.push({ ...base, result: 'FAIL', blocker: 'the current root contract digest is stale' });
      continue;
    }
    if (!REGISTERED_PREDICATES.includes(acceptance.predicate_id) || acceptance.version !== 1) {
      const human = task.human_acceptance?.[acceptance.id];
      const accepted = acceptance.required === false && human
        && (human.actor.startsWith('user:') || human.actor === 'legacy')
        && human.plan_digest === task.plan_digest && human.epoch === task.lease_epoch;
      rows.push(accepted ? { ...base, result: 'PASS' } : {
        ...base, result: 'FAIL', blocker: bounded(acceptance.required === false
          ? `Extra acceptance ${acceptance.id} needs a human. Required registered passes still apply.`
          : `Required acceptance ${acceptance.id} is unsupported.`),
      });
      continue;
    }
    const configuredLease = acceptance.configuration.lease_id;
    const receipt = acceptance.predicate_id === 'task_receipt'
      ? acceptanceReceipt(events, task, acceptance, typeof configuredLease === 'string' ? configuredLease : undefined)
      : undefined;
    const attempts = events.filter((event) => {
      const evidence = event.evidence;
      if (event.id !== task.id || event.event !== 'evidence' || !evidence?.verification) return false;
      if (evidence.verification.acceptance_id !== undefined) return evidence.verification.acceptance_id === acceptance.id;
      return legacyBinding(task, acceptance, evidence, operation, entries);
    });
    const bound = attempts.filter((event) => acceptance.predicate_id !== 'task_receipt' || Boolean(receipt
      && event.evidence!.lease_id === receipt.lease_id && receipt.evidence_hashes.includes(event.evidence!.evidence_hash)));
    const latestEvent = bound.at(-1);
    const evidence = latestEvent?.evidence;
    const artifactDigest = evidence && /^[0-9a-f]{64}$/i.test(evidence.artifact_digest) ? evidence.artifact_digest : '—';
    let result: AcceptanceEvidenceRow['result'];
    if (operation && (!currentOperation(task, operation) || operation.status === 'failed'
      || operation.status === 'ambiguous' || operation.detail === 'deadline_exceeded')) {
      result = 'FAIL';
    } else if (!evidence) {
      result = operation ? operation.status === 'succeeded' ? 'FAIL' : 'PENDING'
        : acceptance.predicate_id === 'task_receipt' && attempts.length > 0 ? 'FAIL' : 'NOT_RUN';
    } else if (!currentEvidenceBinding(task, acceptance, evidence, operation, entries, receipt)) {
      result = 'FAIL';
    } else if (evidence.outcome === 'pending') {
      result = 'PENDING';
    } else if (evidence.outcome !== 'passed') {
      result = 'FAIL';
    } else if (operation && (operation.status !== 'succeeded' || operation.result?.remote_tip !== operation.commit)) {
      result = 'PENDING';
    } else {
      const passingHashes = new Set(bound.filter((event) => event.evidence?.outcome === 'passed'
        && currentEvidenceBinding(task, acceptance, event.evidence, operation, entries, receipt))
        .map((event) => event.evidence!.evidence_hash));
      result = acceptance.required_evidence.filter((item) => /^[0-9a-f]{64}$/.test(item))
        .every((hash) => passingHashes.has(hash)) ? 'PASS' : 'FAIL';
    }
    rows.push({ ...base, result, artifactDigest, blocker: rowBlocker(result) });
  }
  return rows;
}

export const ACCEPTANCE_ROW_CAP = 50;

function acceptanceGuard(task: HubTask, rows: AcceptanceEvidenceRow[]): { registeredPass: boolean; evidenceIncomplete: boolean } {
  let registeredPass = false;
  let missingRequired = false;
  for (const [index, acceptance] of (task.contract?.acceptance ?? []).entries()) {
    const result = rows[index]?.result ?? 'FAIL';
    if (REGISTERED_PREDICATES.includes(acceptance.predicate_id) && acceptance.version === 1 && result === 'PASS') {
      registeredPass = true;
    }
    if (acceptance.required !== false && result !== 'PASS') missingRequired = true;
  }
  return { registeredPass, evidenceIncomplete: !registeredPass || missingRequired };
}

function acceptanceBlockers(task: HubTask, rows: AcceptanceEvidenceRow[]): string[] {
  const blockers: string[] = [];
  let registeredPasses = 0;
  for (const [index, acceptance] of (task.contract?.acceptance ?? []).entries()) {
    const row = rows[index];
    const registered = REGISTERED_PREDICATES.includes(acceptance.predicate_id) && acceptance.version === 1;
    if (!registered) {
      if (row?.result !== 'PASS' && row?.blocker) blockers.push(row.blocker);
      continue;
    }
    if (row?.result === 'PASS') registeredPasses++;
    else if (acceptance.required !== false) blockers.push(`${acceptance.id} has no passing registered evidence`);
  }
  if (registeredPasses === 0) blockers.push('no registered acceptance predicate passed');
  return blockers;
}

function childReconciled(task: HubTask, tasks: HubTask[], events: TaskEvent[], seen = new Set<string>()): boolean {
  if (seen.has(task.id)) return false;
  seen.add(task.id);
  if (['done', 'already_fixed', 'no_op'].includes(task.state)) return true;
  if (task.state !== 'duplicate') return false;
  const event = latest(events, (candidate) => candidate.id === task.id && candidate.event === 'duplicate');
  const covering = tasks.find((candidate) => candidate.id === event?.outcome?.covering_record
    && candidate.project === task.project);
  return covering ? childReconciled(covering, tasks, events, seen) : false;
}

function taskBlockers(task: HubTask, input: WorkTreeInput, nodes: WorkTreeNode[]): string[] {
  const root = nodes.find((node) => node.kind === 'task' && node.task === task.id && node.project === task.project);
  const blockers = [...doneBlockers(task), ...acceptanceBlockers(task, root?.acceptance ?? [])];
  if (!task.plan_approved) blockers.push('the plan is not approved');
  for (const operation of latestOperations(task)) {
    if (operation.status !== 'succeeded' || operation.result?.remote_tip !== operation.commit) {
      blockers.push(`external operation ${operation.operation_id} is unresolved`);
    }
  }
  for (const admission of task.admissions ?? []) {
    if (!admission.lease_revoked && ['admitted', 'running'].includes(admission.status)) {
      blockers.push('required work is unresolved');
    }
  }
  for (const entry of input.teams[task.project] ?? []) {
    if (entry.task === task.id && !entry.orchestrator && !entry.closed_at
      && (!entry.lease_id || !(task.admissions ?? []).some((admission) => admission.lease_id === entry.lease_id
        && admission.lease_revoked))) {
      blockers.push('required work is unresolved');
    }
  }
  for (const childId of task.contract?.required_children ?? []) {
    const child = input.tasks.find((candidate) => candidate.id === childId && candidate.project === task.project);
    if (!child || !childReconciled(child, input.tasks, input.events)) blockers.push('required work is unresolved');
  }
  for (const node of nodes) {
    if (node.task === task.id && node.kind !== 'task' && node.active) blockers.push('required work is unresolved');
  }
  return [...new Set(blockers)];
}

function taskNode(task: HubTask, input: WorkTreeInput): WorkTreeNode {
  const operation = latest(latestOperations(task), (candidate) => candidate.kind === 'github_check');
  const evidence = latest(input.events, (event) => event.id === task.id && event.event === 'evidence')?.evidence;
  const orchestrator = (input.teams[task.project] ?? []).find((entry) => entry.orchestrator);
  return {
    id: `task:${task.project}:${task.id}`, parentId: null, project: task.project, task: task.id,
    kind: 'task', recordId: task.id, adapter: operation ? 'github_check' : 'root', state: task.state,
    active: !CLOSED_STATES.has(task.state), terminal: CLOSED_STATES.has(task.state), done: task.state === 'done',
    doneEnabled: false, doneBlockers: [], registeredPass: false, evidenceIncomplete: false, acceptance: [], acceptanceTruncated: false, planDigest: task.plan_digest ?? undefined, epoch: task.lease_epoch,
    scope: task.contract?.write_scope ?? [], blocker: boundedBlocker(task.last_note ?? task.unblock_condition ?? undefined),
    externalId: operation?.external_run_id ?? operation?.external_id, evidenceOutcome: evidence?.outcome,
    details: [
      ...detail('orchestrator', orchestrator?.name),
      ...detail('session', orchestrator?.session_id),
    ],
  };
}

export function buildWorkTree(input: WorkTreeInput): WorkTree {
  const nodes = input.tasks.map((task) => taskNode(task, input));
  const byLease = new Map<string, string>();
  for (const task of input.tasks) {
    for (const admission of task.admissions ?? []) {
      if (admission.adapter === 'native') continue;
      const id = `tmux:${task.project}:${admission.lease_id}`;
      byLease.set(admission.lease_id, id);
      const entry = (input.teams[task.project] ?? []).find((candidate) => candidate.lease_id === admission.lease_id);
      nodes.push({
        id, parentId: `task:${task.project}:${task.id}`, project: task.project, task: task.id,
        kind: 'tmux', recordId: admission.lease_id, adapter: 'tmux', state: entry?.admission_status ?? admission.status,
        active: !entry?.closed_at && !['released', 'failed', 'launch_failed', 'superseded', 'revoked'].includes(admission.status),
        terminal: Boolean(entry?.closed_at) || ['released', 'failed', 'launch_failed', 'superseded', 'revoked'].includes(admission.status),
        done: false, doneEnabled: false, doneBlockers: [], registeredPass: false, evidenceIncomplete: false, acceptance: [], acceptanceTruncated: false, planDigest: admission.plan_digest,
        epoch: admission.root_lease_epoch, scope: admission.write_scope, lineageId: admission.lineage_id,
        attempts: admission.attempts_used, blocker: boundedBlocker(admission.launch_error), externalId: admission.external_operation_id,
        details: [...detail('agent', admission.agent), ...detail('session', entry?.session_id)],
      });
    }
  }
  for (const [project, entries] of Object.entries(input.teams)) {
    for (const entry of entries) {
      if (entry.orchestrator || !entry.task || entry.lease_id && byLease.has(entry.lease_id)) continue;
      const stable = entry.lease_id ?? valueDigest({ name: entry.name, worktree: entry.worktree }).slice(0, 32);
      const id = `tmux:${project}:${stable}`;
      nodes.push({
        id, parentId: `task:${project}:${entry.task}`, project, task: entry.task, kind: 'tmux', recordId: stable,
        adapter: entry.adapter ?? 'tmux', state: entry.closed_at ? 'closed' : entry.admission_status ?? 'recorded',
        active: !entry.closed_at, terminal: Boolean(entry.closed_at), done: false, doneEnabled: false, doneBlockers: [], registeredPass: false, evidenceIncomplete: false, acceptance: [], acceptanceTruncated: false,
        planDigest: entry.plan_digest, epoch: entry.root_lease_epoch, scope: entry.write_scope ?? [],
        lineageId: entry.lineage_id, attempts: entry.attempts_used, externalId: entry.external_operation_id,
        details: [...detail('agent', entry.name), ...detail('session', entry.session_id)],
      });
    }
  }
  for (const branch of input.branches) {
    const task = input.tasks.find((candidate) => candidate.id === branch.scope.task && candidate.project === branch.scope.project);
    if (!task) continue;
    const admission = task.admissions?.find((candidate) => candidate.lease_id === branch.leaseId);
    const id = `native:${branch.scope.project}:${branch.id}`;
    if (branch.leaseId) byLease.set(branch.leaseId, id);
    nodes.push({
      id, parentId: admission?.parent_lease_id && byLease.has(admission.parent_lease_id)
        ? byLease.get(admission.parent_lease_id)! : `task:${task.project}:${task.id}`,
      project: task.project, task: task.id, kind: 'native', recordId: branch.id, adapter: 'native', state: branch.status,
      active: ['creating', 'active', 'unknown'].includes(branch.status), terminal: !['creating', 'active', 'unknown'].includes(branch.status),
      done: false, doneEnabled: false, doneBlockers: [], registeredPass: false, evidenceIncomplete: false, acceptance: [], acceptanceTruncated: false, planDigest: admission?.plan_digest,
      epoch: admission?.root_lease_epoch, scope: admission?.write_scope ?? [], lineageId: admission?.lineage_id,
      attempts: admission?.attempts_used, blocker: boundedBlocker(branch.error),
      details: [
        ...detail('kind', branch.kind), ...detail('parent session', branch.parentSessionId),
        ...detail('child session', branch.childSessionId ?? undefined),
      ],
    });
  }
  for (const task of input.tasks) {
    for (const childId of task.contract?.required_children ?? []) {
      const child = nodes.find((node) => node.id === `task:${task.project}:${childId}`);
      if (child) child.parentId = `task:${task.project}:${task.id}`;
    }
  }
  for (const [leaseId, id] of byLease) {
    const node = nodes.find((candidate) => candidate.id === id);
    if (!node) continue;
    const admission = input.tasks.flatMap((task) => task.admissions ?? []).find((candidate) => candidate.lease_id === leaseId);
    if (admission?.parent_lease_id && byLease.has(admission.parent_lease_id)) node.parentId = byLease.get(admission.parent_lease_id)!;
  }
  const boundedNodes = nodes.slice(0, NODE_CAP);
  const included = new Set(boundedNodes.map((node) => node.id));
  for (const node of boundedNodes) {
    if (node.parentId && !included.has(node.parentId)) node.parentId = null;
    if (node.kind === 'task') {
      const task = input.tasks.find((candidate) => candidate.id === node.task && candidate.project === node.project)!;
      const acceptance = acceptanceEvidenceRows(task, input.events, input.teams[task.project] ?? []);
      node.acceptance = acceptance;
      node.doneBlockers = taskBlockers(task, input, boundedNodes).map((blocker) => bounded(blocker)!);
      node.doneEnabled = node.active && node.doneBlockers.length === 0;
      const guard = acceptanceGuard(task, acceptance);
      node.registeredPass = guard.registeredPass;
      node.evidenceIncomplete = guard.evidenceIncomplete;
      node.acceptanceTruncated = acceptance.length > ACCEPTANCE_ROW_CAP;
      node.acceptance = acceptance.slice(0, ACCEPTANCE_ROW_CAP);
    }
  }
  return { nodes: boundedNodes, truncated: nodes.length > NODE_CAP };
}
