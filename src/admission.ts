import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeScope, pathsWithinScope, protectedClaim, repositoryIdentity, scopesOverlap, taskScope } from './scope.js';
import {
  appendTaskEvent, canonicalJson, contractDigest, foldTasks, hivePath, hubPath, readProjects, readTaskEvents, readTeam,
  Refusal, validateRootContract, valueDigest, withHubLock, withTeamLock, writeJson,
} from './state.js';
import type { HubTask, RootContract, TaskProvenance, TeamEntry, TmuxAdmission } from './types.js';

export type TmuxAdmissionRequest = {
  parent_id: string;
  plan_digest: string;
  output_claim: string;
  acceptance_ids: string[];
  provenance: TaskProvenance;
  write_scope: string[];
  adapter: 'tmux' | 'native';
  budget?: { depth?: number; attempts?: number };
  retry_of?: string;
  retry_lease_id?: string;
  retry_plan_digest?: string;
  lineage_id?: string;
};

export type TmuxAdmissionOptions = {
  parent?: string;
  worktree?: string;
  model?: string;
  externalOperationId?: string;
  resumeExternal?: boolean;
  readPreflightSnapshot?: () => Promise<string>;
};

type AdmissionStatus = TmuxAdmission['status'];
type Grant = { task: HubTask; admission: TmuxAdmission; entry: TeamEntry };

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function storedTask(tasks: HubTask[], id: string): HubTask {
  const task = tasks.find((candidate) => candidate.id === id);
  if (!task) throw new Refusal(`unknown task: ${id}`);
  if (!task.plan_approved) throw new Refusal(`${id} has no approved plan; the owner approves the plan before workers spawn`);
  if (!task.contract || task.lease_revoked || !task.plan_digest || !task.lease_epoch) {
    throw new Refusal(`${id} has no current root contract grant`);
  }
  validateRootContract(task.contract);
  if (contractDigest(task.contract) !== task.plan_digest) throw new Refusal(`${id} root contract digest does not match`);
  return task;
}

async function assertRegisteredHome(root: string, home: string, task: HubTask): Promise<void> {
  const project = (await readProjects(root)).projects.find((candidate) => candidate.name === task.project);
  const [registeredHome, requestedHome, contractHome] = await Promise.all([
    project ? fs.realpath(project.home).catch(() => null) : null,
    fs.realpath(home).catch(() => null),
    fs.realpath(task.contract!.provenance.repository).catch(() => null),
  ]);
  if (!project || !registeredHome || registeredHome !== requestedHome || requestedHome !== contractHome
    || !task.id.startsWith(`${task.project}-`)) {
    throw new Refusal('task, project, repository, and registered home do not match');
  }
}

function activeAdmission(admission: TmuxAdmission): boolean {
  return !admission.lease_revoked && (admission.status === 'admitted' || admission.status === 'running');
}

function allAdmissions(tasks: HubTask[]): { task: HubTask; admission: TmuxAdmission }[] {
  return tasks.flatMap((task) => (task.admissions ?? []).map((admission) => ({ task, admission })));
}

function validateRequest(task: HubTask, request: TmuxAdmissionRequest): void {
  const contract = task.contract!;
  if (request.parent_id !== task.id || request.plan_digest !== task.plan_digest
    || canonicalJson(request.provenance) !== canonicalJson(contract.provenance)) {
    throw new Refusal('delegate parent, plan digest, or provenance does not match the root grant');
  }
  if (!contract.delegation.output_claims.includes(request.output_claim)) {
    throw new Refusal('delegate output claim is not allocated by the root contract');
  }
  const acceptance = new Set(contract.acceptance.map((item) => item.id));
  if (!Array.isArray(request.acceptance_ids) || request.acceptance_ids.length === 0
    || request.acceptance_ids.some((id) => !acceptance.has(id))) {
    throw new Refusal('delegate acceptance IDs are not allocated by the root contract');
  }
  if (request.adapter !== 'tmux' || !contract.delegation.adapters.includes(request.adapter)) {
    throw new Refusal('delegate adapter is not an admitted tmux allocation');
  }
  const depth = request.budget?.depth ?? 1;
  const attempts = request.budget?.attempts ?? contract.budget.attempts;
  if (!positiveInteger(depth) || depth > contract.budget.depth
    || !positiveInteger(attempts) || attempts > contract.budget.attempts) {
    throw new Refusal('delegate depth or attempt allocation exceeds the root budget');
  }
}

async function normalizedAllocation(home: string, contract: RootContract, request: TmuxAdmissionRequest) {
  const rootScope = await normalizeScope(home, contract.write_scope);
  const writeScope = await normalizeScope(home, request.write_scope);
  if (!pathsWithinScope(writeScope, rootScope)) throw new Refusal('delegate write scope is not a root scope subset');
  const protectedPath = writeScope.find((claim) => protectedClaim(claim)
    && claim !== '.hive/handoffs' && !claim.startsWith('.hive/handoffs/'));
  if (protectedPath) throw new Refusal(`delegate write scope contains protected path: ${protectedPath}`);
  return writeScope;
}

function previousAdmission(task: HubTask, request: TmuxAdmissionRequest): TmuxAdmission | undefined {
  if (!request.retry_of) return undefined;
  const previous = task.admissions?.find((admission) => admission.lease_id === request.retry_lease_id);
  if (!request.retry_lease_id || !request.retry_plan_digest || !request.lineage_id || !previous
    || previous.agent !== request.retry_of || previous.task !== task.id || previous.project !== task.project
    || previous.parent_id !== request.parent_id || previous.plan_digest !== request.retry_plan_digest
    || previous.lineage_id !== request.lineage_id
    || previous.provenance_digest !== valueDigest(request.provenance)) {
    throw new Refusal('replacement identity, plan, lineage, or provenance does not match the previous lease');
  }
  return previous;
}

async function checkBudgets(
  root: string, home: string, tasks: HubTask[], task: HubTask, request: TmuxAdmissionRequest,
): Promise<void> {
  const represented = new Set(allAdmissions(tasks).map(({ admission }) => admission.lease_id));
  const active = allAdmissions(tasks).filter(({ admission }) => activeAdmission(admission)
    && admission.lease_id !== request.retry_lease_id);
  const legacy = (await readTeam(home)).agents.filter((entry) => entry.task && !entry.orchestrator && !entry.closed_at
    && (!entry.lease_id || !represented.has(entry.lease_id)));
  const parentCount = active.filter(({ admission }) => admission.parent_id === request.parent_id).length
    + legacy.filter((entry) => entry.task === request.parent_id).length;
  if (parentCount + 1 > task.contract!.budget.active_children) throw new Refusal('active children budget exhausted');
  const projectCount = active.filter(({ task: owner }) => owner.project === task.project).length
    + legacy.filter((entry) => entry.task?.startsWith(`${task.project}-`)).length;
  if (projectCount + 1 > task.contract!.budget.active_project_records) {
    throw new Refusal('active project records budget exhausted');
  }
}

function checkDuplicate(tasks: HubTask[], task: HubTask, request: TmuxAdmissionRequest, provenanceDigest: string): void {
  for (const { task: owner, admission } of allAdmissions(tasks)) {
    if (!activeAdmission(admission) || admission.lease_id === request.retry_lease_id) continue;
    const duplicate = task.contract!.kind === 'remediation'
      ? owner.contract?.defect_fingerprint === task.contract!.defect_fingerprint
      : admission.output_claim === request.output_claim && admission.provenance_digest === provenanceDigest;
    if (duplicate) throw new Refusal(`duplicate active work covered by ${admission.agent}`);
  }
}

async function sameRepository(home: string, repository: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    repositoryIdentity(home).catch(() => null), repositoryIdentity(repository).catch(() => null),
  ]);
  return Boolean(left && right && left === right);
}

async function checkCollisions(
  root: string, home: string, tasks: HubTask[], agent: string, request: TmuxAdmissionRequest, writeScope: string[],
): Promise<void> {
  for (const { admission } of allAdmissions(tasks)) {
    if (!activeAdmission(admission) || admission.lease_id === request.retry_lease_id
      || !await sameRepository(home, admission.provenance.repository)) continue;
    if (writeScope.length && admission.write_scope.length && scopesOverlap(writeScope, admission.write_scope)) {
      throw new Refusal(`writer scope collision with ${admission.agent}`);
    }
  }
  const team = await readTeam(home);
  for (const old of team.agents) {
    if (old.closed_at || old.lease_id && old.lease_id === request.retry_lease_id) continue;
    if (old.name === agent) throw new Refusal(`${taskProject(tasks, request.parent_id)} already has an agent named ${agent}`);
    if (!old.task || old.lease_id || !writeScope.length) continue;
    const text = await fs.readFile(hubPath(root, 'tasks', `${old.task}.md`), 'utf8').catch(() => null);
    const claim = text === null ? { kind: 'invalid' as const, why: 'the task file is gone' } : taskScope(text);
    if (claim.kind === 'invalid') throw new Refusal(`${old.task} scope does not parse: ${claim.why}`);
    if (claim.kind === 'claim') {
      const oldScope = await normalizeScope(home, [...claim.paths]);
      if (scopesOverlap(writeScope, oldScope)) {
        const shared = writeScope.filter((candidate) => scopesOverlap([candidate], oldScope));
        throw new Refusal(`${request.parent_id} overlaps ${old.name}'s task ${old.task}: ${shared.join(', ')}`);
      }
    }
  }
}

function taskProject(tasks: HubTask[], id: string): string {
  return tasks.find((task) => task.id === id)?.project ?? 'project';
}

function reservation(
  task: HubTask, agent: string, request: TmuxAdmissionRequest, writeScope: string[],
  previous: TmuxAdmission | undefined, attemptsUsed: number,
): TmuxAdmission {
  return {
    task: task.id, project: task.project, agent, parent_id: request.parent_id,
    plan_digest: task.plan_digest!, root_lease_epoch: task.lease_epoch!,
    lease_id: randomUUID(), lease_epoch: 1, lease_revoked: false,
    output_claim: request.output_claim, acceptance_ids: [...request.acceptance_ids],
    provenance: { ...request.provenance }, provenance_digest: valueDigest(request.provenance),
    write_scope: writeScope, adapter: request.adapter, retry_of: request.retry_of,
    lineage_id: previous?.lineage_id ?? agent, attempts_used: attemptsUsed, status: 'admitted',
  };
}

function entryFromAdmission(admission: TmuxAdmission, old: TeamEntry | undefined, options: TmuxAdmissionOptions): TeamEntry {
  return {
    ...old,
    name: admission.agent, task: admission.task,
    parent: options.parent ?? old?.parent,
    worktree: options.worktree ?? old?.worktree,
    model: options.model ?? old?.model,
    parent_id: admission.parent_id, plan_digest: admission.plan_digest,
    root_lease_epoch: admission.root_lease_epoch, lease_id: admission.lease_id,
    lease_epoch: admission.lease_epoch, lease_revoked: false,
    output_claim: admission.output_claim, acceptance_ids: [...admission.acceptance_ids],
    provenance: { ...admission.provenance }, provenance_digest: admission.provenance_digest,
    write_scope: [...admission.write_scope], adapter: admission.adapter,
    retry_of: admission.retry_of, lineage_id: admission.lineage_id,
    attempts_used: admission.attempts_used, admission_status: admission.status,
    closed_at: undefined, launch_error: undefined,
  };
}

async function appendAdmission(root: string, admission: TmuxAdmission, supersedes: string[] = []): Promise<void> {
  await appendTaskEvent(root, {
    id: admission.task, project: admission.project, event: 'admission', at: new Date().toISOString(),
    admission, supersedes,
  });
}

export async function admitTmux(
  root: string, home: string, taskId: string, agent: string,
  request: TmuxAdmissionRequest, options: TmuxAdmissionOptions = {},
): Promise<TmuxAdmission> {
  if (!await fs.realpath(home).catch(() => null)) throw new Refusal(`unresolved repository root: ${home}`);
  const beforePreflight = options.readPreflightSnapshot ? await options.readPreflightSnapshot() : undefined;
  return withHubLock(root, async () => withTeamLock(home, async () => {
    const tasks = foldTasks(await readTaskEvents(root));
    const task = storedTask(tasks, taskId);
    await assertRegisteredHome(root, home, task);
    validateRequest(task, request);
    if (task.contract!.preflight_snapshot !== undefined
      && (beforePreflight !== task.contract!.preflight_snapshot
        || await options.readPreflightSnapshot?.() !== task.contract!.preflight_snapshot)) {
      throw new Refusal('preflight snapshot changed before admission');
    }
    const writeScope = await normalizedAllocation(home, task.contract!, request);
    const previous = previousAdmission(task, request);
    if (previous && activeAdmission(previous) && previous.agent !== agent) {
      throw new Refusal('replacement requires a fenced prior lease');
    }
    if (options.resumeExternal) {
      if (!options.externalOperationId) throw new Refusal('external resume needs the recorded operation ID');
      const currentEntry = previous
        ? (await readTeam(home)).agents.find((entry) => entry.lease_id === previous.lease_id)
        : undefined;
      if (!previous || previous.agent !== agent || !activeAdmission(previous)
        || previous.plan_digest !== task.plan_digest || previous.root_lease_epoch !== task.lease_epoch
        || previous.output_claim !== request.output_claim || !currentEntry || currentEntry.lease_revoked
        || currentEntry.closed_at || currentEntry.plan_digest !== previous.plan_digest
        || currentEntry.root_lease_epoch !== previous.root_lease_epoch
        || previous.external_operation_id !== options.externalOperationId
        || currentEntry.external_operation_id !== options.externalOperationId) {
        throw new Refusal('external resume has no current matching admission and operation ID');
      }
      return previous;
    }
    await checkCollisions(root, home, tasks, agent, request, writeScope);
    checkDuplicate(tasks, task, request, valueDigest(request.provenance));
    await checkBudgets(root, home, tasks, task, request);
    const attemptsUsed = (previous?.attempts_used ?? 0) + 1;
    const attemptCap = Math.min(request.budget?.attempts ?? task.contract!.budget.attempts, task.contract!.budget.attempts);
    if (attemptsUsed > attemptCap) {
      if (previous) await transitionTmuxAdmissionLocked(root, home, previous, 'blocked:budget_exhausted');
      throw new Refusal(`blocked:budget_exhausted for ${previous?.lineage_id ?? agent}`);
    }
    if (!request.retry_of && (await readTeam(home)).agents.some((old) => old.name === agent)) {
      throw new Refusal(`${task.project} already has an agent named ${agent}`);
    }
    const admitted = reservation(task, agent, request, writeScope, previous, attemptsUsed);
    const team = await readTeam(home);
    const old = previous ? team.agents.find((candidate) => candidate.lease_id === previous.lease_id) : undefined;
    const agents = previous ? team.agents.filter((candidate) => candidate.lease_id !== previous.lease_id) : [...team.agents];
    agents.push(entryFromAdmission(admitted, old, options));
    await appendAdmission(root, admitted, previous ? [previous.lease_id] : []);
    try {
      await writeJson(hivePath(home, 'team.json'), { agents });
    } catch (error) {
      await appendAdmission(root, {
        ...admitted, status: 'revoked', lease_revoked: true,
        launch_error: `team reservation failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      throw error;
    }
    return admitted;
  }));
}

function currentGrant(task: HubTask, team: { agents: TeamEntry[] }, agent: string, leaseId: string, allowClosed: boolean): Grant {
  const admission = task.admissions?.find((candidate) => candidate.agent === agent && candidate.lease_id === leaseId);
  const entry = team.agents.find((candidate) => candidate.name === agent && candidate.lease_id === leaseId);
  if (!admission || !entry || !activeAdmission(admission) || entry.lease_revoked
    || !allowClosed && entry.closed_at || entry.task !== task.id
    || admission.plan_digest !== task.plan_digest || admission.root_lease_epoch !== task.lease_epoch
    || entry.plan_digest !== admission.plan_digest || entry.root_lease_epoch !== admission.root_lease_epoch
    || entry.lease_epoch !== admission.lease_epoch) {
    throw new Refusal(`${agent} does not hold the current digest, epoch, and lease`);
  }
  return { task, admission, entry };
}

export async function assertAdmissionCurrentLocked(
  root: string, home: string, taskId: string, agent: string, leaseId: string, allowClosed = false,
): Promise<Grant> {
  const task = storedTask(foldTasks(await readTaskEvents(root)), taskId);
  await assertRegisteredHome(root, home, task);
  return currentGrant(task, await readTeam(home), agent, leaseId, allowClosed);
}

export async function withTmuxGrant<T>(
  root: string, home: string, taskId: string, agent: string, leaseId: string,
  fn: (grant: Grant) => Promise<T>, options: { allowClosed?: boolean } = {},
): Promise<T> {
  return withHubLock(root, async () => withTeamLock(home, async () => {
    const grant = await assertAdmissionCurrentLocked(root, home, taskId, agent, leaseId, options.allowClosed === true);
    return fn(grant);
  }));
}

export async function assertTmuxGrant(
  root: string, home: string, taskId: string, agent: string, leaseId: string,
): Promise<TmuxAdmission> {
  return withTmuxGrant(root, home, taskId, agent, leaseId, async ({ admission }) => admission);
}

export async function registerTmuxLaunch(
  root: string, home: string, taskId: string, agent: string, leaseId: string,
  patch: Partial<TeamEntry>, options: { allowClosed?: boolean } = {},
): Promise<TeamEntry> {
  return withHubLock(root, async () => withTeamLock(home, async () => {
    const { admission, entry } = await assertAdmissionCurrentLocked(
      root, home, taskId, agent, leaseId, options.allowClosed === true,
    );
    const worktree = patch.worktree ?? entry.worktree ?? home;
    const teamState = await fs.readFile(hivePath(worktree, 'team.json'), 'utf8').catch(() => null);
    if (patch.team_state_hash && (teamState === null || valueDigest(teamState) !== patch.team_state_hash)) {
      throw new Refusal(`${agent} team state changed during launch`);
    }
    const updated = { ...entry, ...patch, closed_at: undefined, wedged_at: undefined };
    const team = await readTeam(home);
    const agents = team.agents.map((candidate) => candidate.lease_id === leaseId ? updated : candidate);
    await appendAdmission(root, {
      ...admission, status: 'running',
      runtime_files: patch.runtime_files,
      team_state_hash: patch.team_state_hash,
      handoff_path: patch.handoff_path,
      handoff_digest: patch.handoff_digest,
      launch_claim_path: patch.launch_claim_path,
      launch_claim_digest: patch.launch_claim_digest,
      launch_claim_in_worktree: patch.launch_claim_in_worktree,
      launch_claim_completed: patch.launch_claim_completed,
    });
    await writeJson(hivePath(home, 'team.json'), { agents });
    return updated;
  }));
}

export async function completeTmuxLaunch(
  root: string, home: string, taskId: string, agent: string, leaseId: string, worktree: string, claim: string,
): Promise<void> {
  await withHubLock(root, async () => withTeamLock(home, async () => {
    const { admission } = await assertAdmissionCurrentLocked(root, home, taskId, agent, leaseId);
    const original = path.resolve(root, claim);
    const worker = path.resolve(worktree, claim);
    const originalContent = await fs.readFile(original, 'utf8').catch(() => null);
    if (!admission.launch_claim_digest || originalContent === null
      || valueDigest(originalContent) !== admission.launch_claim_digest) {
      throw new Refusal(`${agent} launch claim changed or disappeared before completion`);
    }
    if (worker !== original) {
      const workerContent = await fs.readFile(worker, 'utf8').catch(() => null);
      if (admission.launch_claim_in_worktree) {
        if (workerContent === null || valueDigest(workerContent) !== admission.launch_claim_digest) {
          throw new Refusal(`${agent} worktree launch claim changed or disappeared before completion`);
        }
      } else if (workerContent !== null) {
        throw new Refusal(`${agent} unexpected worktree launch claim before completion`);
      }
    }
    await fs.rm(original, { force: true });
    if (worker !== original) await fs.rm(worker, { force: true });
    await appendAdmission(root, { ...admission, launch_claim_completed: true });
  }));
}

export async function transitionTmuxAdmissionLocked(
  root: string, home: string, admission: TmuxAdmission, status: AdmissionStatus, detail?: string,
): Promise<void> {
  const finished = {
    ...admission, status, lease_revoked: true,
    ...(detail === undefined ? {} : { launch_error: detail }),
  };
  await appendAdmission(root, finished);
  const team = await readTeam(home);
  await writeJson(hivePath(home, 'team.json'), {
    agents: team.agents.map((entry) => entry.lease_id === admission.lease_id ? {
      ...entry, lease_revoked: true, admission_status: status,
      closed_at: new Date().toISOString(), launch_error: detail,
    } : entry),
  });
}

export async function transitionTmuxAdmission(
  root: string, home: string, taskId: string, agent: string, leaseId: string,
  status: 'launch_failed' | 'failed' | 'revoked' | 'released', detail?: string,
): Promise<void> {
  await withHubLock(root, async () => withTeamLock(home, async () => {
    const task = foldTasks(await readTaskEvents(root)).find((candidate) => candidate.id === taskId);
    const admission = task?.admissions?.find((candidate) => candidate.agent === agent && candidate.lease_id === leaseId);
    if (admission) await transitionTmuxAdmissionLocked(root, home, admission, status, detail);
  }));
}

export async function revokeTmuxAdmission(root: string, home: string, entry: TeamEntry): Promise<void> {
  if (!entry.task || !entry.lease_id) return;
  await transitionTmuxAdmission(root, home, entry.task, entry.name, entry.lease_id, 'revoked');
}

export async function revokeTaskAdmissionsLocked(root: string, home: string, taskId: string): Promise<void> {
  const task = foldTasks(await readTaskEvents(root)).find((candidate) => candidate.id === taskId);
  for (const admission of task?.admissions ?? []) {
    if (activeAdmission(admission)) await transitionTmuxAdmissionLocked(root, home, admission, 'revoked', 'root task cancelled');
  }
}

export async function recordTmuxLaunchOutcome(
  root: string, home: string, taskId: string, agent: string, leaseId: string, detail: string,
): Promise<void> {
  await transitionTmuxAdmission(root, home, taskId, agent, leaseId, 'launch_failed', detail);
}

export async function recordTmuxExternalOperation(
  root: string, home: string, taskId: string, agent: string, leaseId: string, operationId: string,
): Promise<void> {
  if (!operationId) throw new Refusal('an external operation ID is required');
  await withHubLock(root, async () => withTeamLock(home, async () => {
    const { admission, entry } = await assertAdmissionCurrentLocked(root, home, taskId, agent, leaseId);
    await appendAdmission(root, { ...admission, external_operation_id: operationId });
    const team = await readTeam(home);
    await writeJson(hivePath(home, 'team.json'), {
      agents: team.agents.map((candidate) => candidate.lease_id === leaseId
        ? { ...entry, external_operation_id: operationId } : candidate),
    });
  }));
}
