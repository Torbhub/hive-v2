import { revokeTaskAdmissionsLocked } from './admission.js';
import {
  appendTaskEvent, doneBlockers, foldTasks, readProjects, readTaskEvents, Refusal,
  taskEvidenceDigests, valueDigest, withHubLock, withTeamLock,
} from './state.js';
import { CLOSED_STATES } from './types.js';
import type {
  HubTask, NativeBranchRecord, TaskAcceptance, TaskEvidence, TaskEvent, TaskOperation,
  TaskReceipt, TeamEntry, WorkTree, WorkTreeNode,
} from './types.js';

export type GitHubCheckConfig = {
  repository?: string;
  sha?: string;
  external_id?: string;
  artifact_digest?: string;
  plan_digest?: string;
  acceptance_id?: string;
  owner?: string;
  deadline?: string;
};
export type GitHubOptions = { baseUrl?: string; token?: string };
export type GitHubTransferOptions = GitHubOptions & { newOwner: string };

type CheckRun = {
  id: number;
  head_sha: string;
  external_id: string;
  name: string;
  status: string;
  conclusion: string | null;
  app?: { slug?: string };
  cancellation_requested?: boolean;
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
    repository: config.repository, sha: config.sha, external_id: config.external_id,
    plan_digest: config.plan_digest, artifact_digest: config.artifact_digest,
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
    external_id: config.external_id,
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
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)
    || endpoint.username || endpoint.password) {
    throw new Refusal('GitHub API needs HTTPS without userinfo, or a loopback test server');
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
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await response.text();
  if (raw.length > 1024 * 1024) throw new Error('GitHub API response exceeds the byte cap');
  if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
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

async function findRun(operation: TaskOperation, options: GitHubOptions): Promise<CheckRun | undefined> {
  if (operation.external_run_id) {
    return readRun(await apiRequest(options, `repos/${operation.repository}/check-runs/${operation.external_run_id}`));
  }
  for (let page = 1; page <= 100; page++) {
    const query = new URLSearchParams({
      check_name: checkName(operation.external_id!), external_id: operation.external_id!,
      per_page: '100', page: String(page),
    });
    const result = await apiRequest(
      options,
      `repos/${operation.repository}/commits/${operation.commit}/check-runs?${query}`,
    ) as { check_runs?: unknown[] };
    if (!Array.isArray(result.check_runs)) throw new Error('GitHub check-run list is invalid');
    const matches = result.check_runs.map(readRun).filter((run) => run.external_id === operation.external_id
      && run.head_sha === operation.commit && run.name === checkName(operation.external_id!));
    if (matches.length > 1) throw new Error('GitHub check-run identity is ambiguous');
    if (matches[0]) return matches[0];
    if (result.check_runs.length < 100) return undefined;
  }
  throw new Error('GitHub check-run identity exceeded the page cap');
}

function runBound(operation: TaskOperation, run: CheckRun): boolean {
  return String(run.id) === operation.external_run_id
    && run.head_sha === operation.commit
    && run.external_id === operation.external_id
    && run.name === checkName(operation.external_id!);
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
  await appendOperation(root, task, { ...operation, status: 'blocked_external', detail });
}

async function passRun(root: string, task: HubTask, operation: TaskOperation, run: CheckRun): Promise<void> {
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

async function finishCancellation(root: string, task: HubTask, operation: TaskOperation, run: CheckRun): Promise<void> {
  if (CLOSED_STATES.has(task.state)) return;
  await appendOperation(root, task, {
    ...operation, status: 'failed', detail: 'external_cancelled', result: { remote_tip: run.head_sha, reconciled: true },
  });
  const project = (await readProjects(root)).projects.find((candidate) => candidate.name === task.project);
  if (project) await withTeamLock(project.home, () => revokeTaskAdmissionsLocked(root, project.home, task.id));
  await appendTaskEvent(root, operation.close_outcome === 'superseded' ? {
    id: task.id, project: task.project, event: 'superseded', at: new Date().toISOString(),
    note: `GitHub check ${run.id} was cancelled`, outcome: {
      actor: operation.actor, plan_digest: operation.plan_digest, epoch: operation.epoch,
      replacement_id: operation.replacement_id, reason: 'external cancellation proved',
    },
  } : {
    id: task.id, project: task.project, event: 'cancelled', at: new Date().toISOString(),
    note: `GitHub check ${run.id} was cancelled`,
  });
}

async function reconcileLocked(
  root: string, id: string, operationId: string, options: GitHubOptions,
): Promise<void> {
  const task = await currentTask(root, id);
  const operation = latestOperation(task, operationId);
  if (!operation || operation.kind !== 'github_check' || CLOSED_STATES.has(task.state)) return;
  if (operation.status === 'succeeded' && task.state === 'reconciling') return;
  let run: CheckRun | undefined;
  try {
    run = await findRun(operation, options);
  } catch (error) {
    await failRun(root, task, operation, undefined, 'adapter-error', error instanceof Error ? error.message : String(error));
    return;
  }
  if (!run) {
    await failRun(root, task, operation, undefined, 'adapter-error', 'external identity not found');
    return;
  }
  if (!runBound(operation, run)) {
    await failRun(root, task, operation, run, 'adapter-error', 'external identity binding changed');
    return;
  }
  if (operation.status === 'closing_external') {
    if (run.status === 'completed' && run.conclusion === 'cancelled') await finishCancellation(root, task, operation, run);
    return;
  }
  if (run.status !== 'completed') {
    await appendOperation(root, task, { ...operation, status: 'blocked_external', detail: undefined });
    return;
  }
  if (run.conclusion === 'success') {
    await passRun(root, task, operation, run);
    return;
  }
  await appendAdapterEvidence(root, task, operation, run, 'failed', `GitHub conclusion: ${run.conclusion ?? 'unknown'}`);
  await appendOperation(root, task, {
    ...operation, status: 'failed', detail: `GitHub conclusion: ${run.conclusion ?? 'unknown'}`,
  });
}

export async function dispatchGithubCheck(
  root: string, id: string, config: GitHubCheckConfig, options: GitHubOptions = {},
): Promise<TaskOperation> {
  return withHubLock(root, async () => {
    const task = await currentTask(root, id);
    if (!task.plan_digest || config.plan_digest !== task.plan_digest || config.artifact_digest === undefined) {
      const operation = unknownOperation(task, { ...config, plan_digest: task.plan_digest ?? config.plan_digest });
      await appendOperation(root, task, operation);
      return operation;
    }
    if (!validIdentity(config)) {
      const operation = unknownOperation(task, config);
      await appendOperation(root, task, operation);
      return operation;
    }
    const operation = operationFor(task, config);
    const existing = latestOperation(task, operation.operation_id);
    if (existing?.detail === 'identity_unknown' || existing?.status === 'succeeded') return existing;
    if (existing && (existing.idempotency_key !== operation.idempotency_key
      || existing.plan_digest !== operation.plan_digest || existing.artifact_digest !== operation.artifact_digest)) {
      const ambiguous = { ...existing, status: 'ambiguous' as const, detail: 'operation identity changed' };
      await appendOperation(root, task, ambiguous);
      return ambiguous;
    }
    let run: CheckRun | undefined;
    try {
      run = await findRun(existing ?? operation, options);
      if (!run && existing?.status !== 'closing_external') {
        run = readRun(await apiRequest(options, `repos/${operation.repository}/check-runs`, {
          method: 'POST',
          idempotencyKey: operation.idempotency_key,
          body: {
            name: checkName(operation.external_id!), head_sha: operation.commit, external_id: operation.external_id,
            status: 'in_progress',
          },
        }));
      }
    } catch (error) {
      await failRun(root, task, existing ?? operation, undefined, 'adapter-error', error instanceof Error ? error.message : String(error));
      return { ...operation, detail: 'adapter_error' };
    }
    if (!run) return existing ?? operation;
    const next = {
      ...(existing ?? operation), external_run_id: String(run.id),
      status: existing?.status === 'closing_external' ? 'closing_external' as const : 'blocked_external' as const,
      detail: runBound({ ...(existing ?? operation), external_run_id: String(run.id) }, run) ? undefined : 'external identity binding changed',
    };
    await appendOperation(root, task, next);
    return next;
  });
}

export async function reconcileGithubCheck(
  root: string, id: string, operationId: string, options: GitHubOptions = {},
): Promise<void> {
  return withHubLock(root, () => reconcileLocked(root, id, operationId, options));
}

export async function cancelGithubCheck(
  root: string, id: string, operationId: string, options: GitHubOptions = {},
): Promise<void> {
  return withHubLock(root, async () => {
    const task = await currentTask(root, id);
    const operation = latestOperation(task, operationId);
    if (!operation || operation.kind !== 'github_check' || CLOSED_STATES.has(task.state)) return;
    const closing = { ...operation, status: 'closing_external' as const, cancellation_requested: true };
    await appendOperation(root, task, closing);
    if (operation.status === 'closing_external' && operation.cancellation_requested) {
      await reconcileLocked(root, id, operationId, options);
      return;
    }
    try {
      const run = await findRun(operation, options);
      if (!run) return;
      if (run.status === 'completed' && run.conclusion === 'cancelled') {
        await finishCancellation(root, task, closing, run);
        return;
      }
      await apiRequest(options, `repos/${operation.repository}/check-runs/${run.id}`, {
        method: 'PATCH', body: { status: 'completed', conclusion: 'cancelled' },
      });
    } catch (error) {
      await failRun(root, task, closing, undefined, 'adapter-error', error instanceof Error ? error.message : String(error));
    }
  });
}

export async function transferGithubCheck(
  root: string, id: string, operationId: string, options: GitHubTransferOptions,
): Promise<void> {
  if (!options.newOwner.trim()) throw new Refusal('ownership transfer needs a new owner');
  return withHubLock(root, async () => {
    const task = await currentTask(root, id);
    const operation = latestOperation(task, operationId);
    if (!operation || operation.status !== 'closing_external' || CLOSED_STATES.has(task.state)) return;
    const run = await findRun(operation, options);
    if (!run || !runBound(operation, run) || run.app?.slug !== options.newOwner) {
      await failRun(root, task, operation, run, 'adapter-error', 'ownership transfer proof does not match');
      return;
    }
    await appendOperation(root, task, {
      ...operation, owner: options.newOwner, status: 'blocked_external', cancellation_requested: false, detail: undefined,
    });
  });
}

export async function evaluateGithubCheck(root: string, id: string, config: GitHubCheckConfig): Promise<boolean> {
  const events = await readTaskEvents(root);
  const task = foldTasks(events).find((candidate) => candidate.id === id);
  if (!task || config.plan_digest !== task.plan_digest || !validIdentity(config)) return false;
  const operation = latestOperation(task, operationFor(task, config).operation_id);
  if (operation?.status !== 'succeeded' || operation.result?.remote_tip !== operation.commit) return false;
  return events.some((event) => event.id === id && event.event === 'evidence'
    && event.evidence?.outcome === 'passed' && event.evidence.plan_digest === task.plan_digest
    && event.evidence.epoch === task.lease_epoch && event.evidence.artifact_digest === config.artifact_digest
    && event.evidence.verification?.adapter_id === 'github_check'
    && event.evidence.verification.provenance_digest === operation.idempotency_key);
}

export async function supervisionPass(root: string, options: GitHubOptions = {}): Promise<{ watchers: string[] }> {
  const tasks = foldTasks(await readTaskEvents(root));
  for (const task of tasks) {
    if (!task.contract || CLOSED_STATES.has(task.state)) continue;
    for (const acceptance of task.contract.acceptance) {
      if (acceptance.predicate_id !== 'github_check' || acceptance.version !== 1) continue;
      const config = { ...acceptance.configuration, acceptance_id: acceptance.id, plan_digest: task.plan_digest } as GitHubCheckConfig;
      const operation = latestOperation(task, operationFor(task, config).operation_id);
      if (operation?.status !== 'closing_external') await dispatchGithubCheck(root, task.id, config, options);
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
      if (operation.watcher_id) watchers.add(operation.watcher_id);
      if (operation.status === 'closing_external' && !operation.cancellation_requested) {
        await cancelGithubCheck(root, task.id, operation.operation_id, options);
      } else {
        await reconcileGithubCheck(root, task.id, operation.operation_id, options);
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

function detail(label: string, value: string | undefined): { label: string; value: string }[] {
  return value ? [{ label, value: bounded(value)! }] : [];
}

function latestOperations(task: HubTask): TaskOperation[] {
  const operations = new Map<string, TaskOperation>();
  const poisoned = new Set<string>();
  for (const operation of task.operations ?? []) {
    if (operation.plan_digest !== task.plan_digest || operation.epoch !== task.lease_epoch) continue;
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

function passingEvidence(task: HubTask, acceptance: TaskAcceptance, events: TaskEvent[]): boolean {
  const supported = ['task_receipt', 'git_diff_scope', 'native_result', 'github_check'];
  if (!supported.includes(acceptance.predicate_id)) return false;
  const receipt = task.last_receipt;
  if (acceptance.predicate_id === 'task_receipt') {
    const reconciling = task.state === 'reconciling' || task.state === 'blocked' && task.resume_state === 'reconciling';
    const configuredHashes = acceptance.configuration.evidence_hashes;
    if (!reconciling || receipt?.state !== 'reconciling'
      || receipt.artifact_digest !== acceptance.configuration.artifact_digest
      || (Array.isArray(configuredHashes) && configuredHashes.some((hash) => !receipt.evidence_hashes.includes(String(hash))))) {
      return false;
    }
  }
  return events.some((event) => {
    const evidence = event.evidence;
    if (event.id !== task.id || event.event !== 'evidence' || !evidence || evidence.outcome !== 'passed'
      || evidence.plan_digest !== task.plan_digest || evidence.epoch !== task.lease_epoch
      || evidence.verification?.adapter_id !== acceptance.predicate_id) return false;
    const configuredArtifact = acceptance.configuration.artifact_digest;
    if (typeof configuredArtifact === 'string' && evidence.artifact_digest !== configuredArtifact) return false;
    if (acceptance.predicate_id === 'task_receipt' && !receipt?.evidence_hashes.includes(evidence.evidence_hash)) return false;
    return acceptance.required_evidence.filter((item) => /^[0-9a-f]{64}$/.test(item))
      .every((hash) => hash === evidence.evidence_hash);
  });
}

function acceptanceBlockers(task: HubTask, events: TaskEvent[]): string[] {
  const blockers: string[] = [];
  let registeredPasses = 0;
  for (const acceptance of task.contract?.acceptance ?? []) {
    const supported = ['task_receipt', 'git_diff_scope', 'native_result', 'github_check'].includes(acceptance.predicate_id);
    if (!supported) {
      const human = task.human_acceptance?.[acceptance.id];
      const accepted = acceptance.required === false && human
        && (human.actor.startsWith('user:') || human.actor === 'legacy')
        && human.plan_digest === task.plan_digest && human.epoch === task.lease_epoch;
      if (!accepted) {
        blockers.push(acceptance.required === false
          ? `Extra acceptance ${acceptance.id} needs a human. Required registered passes still apply.`
          : `Required acceptance ${acceptance.id} is unsupported.`);
      }
      continue;
    }
    if (passingEvidence(task, acceptance, events)) registeredPasses++;
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
  const blockers = [...doneBlockers(task), ...acceptanceBlockers(task, input.events)];
  if (!task.plan_approved) blockers.push('the plan is not approved');
  for (const operation of latestOperations(task)) {
    if (operation.status !== 'succeeded' || operation.result?.remote_tip !== operation.commit) {
      blockers.push(`external operation ${operation.operation_id} is unresolved`);
    }
  }
  for (const admission of task.admissions ?? []) {
    if (!admission.lease_revoked && ['admitted', 'running'].includes(admission.status)) {
      blockers.push(`writer ${admission.agent} is active`);
    }
  }
  for (const entry of input.teams[task.project] ?? []) {
    if (entry.task === task.id && !entry.orchestrator && !entry.closed_at
      && (!entry.lease_id || !(task.admissions ?? []).some((admission) => admission.lease_id === entry.lease_id
        && admission.lease_revoked))) {
      blockers.push(`writer ${entry.name} is active`);
    }
  }
  for (const childId of task.contract?.required_children ?? []) {
    const child = input.tasks.find((candidate) => candidate.id === childId && candidate.project === task.project);
    if (!child || !childReconciled(child, input.tasks, input.events)) blockers.push(`required child ${childId} is unresolved`);
  }
  for (const node of nodes) {
    if (node.task === task.id && node.kind !== 'task' && node.active) blockers.push(`${node.recordId} is unresolved`);
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
    doneEnabled: false, doneBlockers: [], planDigest: task.plan_digest ?? undefined, epoch: task.lease_epoch,
    scope: task.contract?.write_scope ?? [], blocker: bounded(task.last_note ?? task.unblock_condition ?? undefined),
    externalId: operation?.external_run_id ?? operation?.external_id, evidenceOutcome: evidence?.outcome,
    details: [
      ...detail('orchestrator', orchestrator?.name), ...detail('pane', orchestrator?.pane),
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
        done: false, doneEnabled: false, doneBlockers: [], planDigest: admission.plan_digest,
        epoch: admission.root_lease_epoch, scope: admission.write_scope, lineageId: admission.lineage_id,
        attempts: admission.attempts_used, blocker: bounded(admission.launch_error), externalId: admission.external_operation_id,
        details: [...detail('agent', admission.agent), ...detail('pane', entry?.pane), ...detail('session', entry?.session_id)],
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
        active: !entry.closed_at, terminal: Boolean(entry.closed_at), done: false, doneEnabled: false, doneBlockers: [],
        planDigest: entry.plan_digest, epoch: entry.root_lease_epoch, scope: entry.write_scope ?? [],
        lineageId: entry.lineage_id, attempts: entry.attempts_used, externalId: entry.external_operation_id,
        details: [...detail('agent', entry.name), ...detail('pane', entry.pane), ...detail('session', entry.session_id)],
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
      done: false, doneEnabled: false, doneBlockers: [], planDigest: admission?.plan_digest,
      epoch: admission?.root_lease_epoch, scope: admission?.write_scope ?? [], lineageId: admission?.lineage_id,
      attempts: admission?.attempts_used, blocker: bounded(branch.error),
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
      node.doneBlockers = taskBlockers(task, input, boundedNodes).map((blocker) => bounded(blocker)!);
      node.doneEnabled = node.active && node.doneBlockers.length === 0;
    }
  }
  return { nodes: boundedNodes, truncated: nodes.length > NODE_CAP };
}
