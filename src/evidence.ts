import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { assertAdmissionEvidenceLocked, transitionTmuxAdmissionLocked } from './admission.js';
import { assertNativeBranchCurrentLocked, assertNativeResultFresh, listNativeBranches, readNativeBranch } from './branches.js';
import { pushByHash } from './gate.js';
import { createNativeBranchClient } from './native-client.js';
import { gitDiffScope, normalizeScope, pathsWithinScope, repositoryIdentity } from './scope.js';
import {
  cancelGithubCheck, dispatchGithubCheck, evaluateGithubCheck, reconcileGithubCheck, transferGithubCheck,
  type GitHubCheckConfig,
} from './supervision.js';
import {
  appendTaskEvent, contractDigest, foldTasks, readProjects, readTaskEvents, Refusal, taskEvidenceDigests,
  validateRootContract, valueDigest, withHubLock, withTeamLock,
} from './state.js';
import type {
  HubTask, NativeBranchClient, TaskEvent, TaskEvidence, TaskEvidenceVerification, TaskReceipt, TaskResearchSource, TeamEntry,
  TmuxAdmission,
} from './types.js';

export type TaskReceiptPredicateConfig = {
  plan_digest: string;
  artifact_digest: string;
  output_claim?: string;
  artifact_path?: string;
  evidence_hashes?: string[];
  lease_id?: string;
  acceptance_id?: string;
};
export type GitDiffScopePredicateConfig = {
  lease_id: string;
  base_revision: string;
  artifact_revision: string;
};
export type NativeResultPredicateConfig = {
  acceptance_id?: string;
  lease_id?: string;
  plan_digest: string;
  artifact_digest?: string;
  branch_id?: string;
};
export type TaskPredicateConfig = TaskReceiptPredicateConfig | GitDiffScopePredicateConfig | NativeResultPredicateConfig | GitHubCheckConfig;

export function canonicalActor(actor: string): string {
  return actor.startsWith('agent:') ? actor.slice('agent:'.length) : actor;
}

export function allowsLeaseLessFallback(task: HubTask, actor: string): boolean {
  const canonical = canonicalActor(actor);
  if ((task.admissions ?? []).some((admission) => admission.agent === canonical)) return false;
  if (actor.startsWith('agent:')) return !task.contract;
  if (!task.contract) return true;
  return ['legacy', 'orchestrator', `${task.project}-orchestrator`].includes(canonical)
    || canonical.startsWith('user:');
}

function latestEvidence(events: TaskEvent[], id: string, hash: string, after?: string | number): TaskEvidence | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.id === id && event.event === 'evidence' && event.evidence?.evidence_hash === hash
      && (after === undefined || typeof after === 'number' && index > after || typeof after === 'string' && event.at > after)) {
      return event.evidence;
    }
  }
  return undefined;
}

export function matchingEvidence(
  events: TaskEvent[], id: string, receipt: TaskReceipt, task: HubTask, recovery: boolean, requireVerification = false,
  after?: string | number, adapterId: TaskEvidenceVerification['adapter_id'] | 'any' = 'task_receipt',
): TaskEvidence[] | null {
  if (receipt.evidence_hashes.length === 0) return null;
  const matches: TaskEvidence[] = [];
  for (const hash of receipt.evidence_hashes) {
    const evidence = latestEvidence(events, id, hash, after);
    if (!evidence || evidence.artifact_digest !== receipt.artifact_digest
      || evidence.lease_id !== receipt.lease_id) return null;
    const serverArtifact = evidence.verification?.adapter_id === 'task_receipt'
      && evidence.artifact !== null && typeof evidence.artifact === 'object'
      && (evidence.artifact as { content_digest?: unknown }).content_digest === evidence.artifact_digest
      && evidence.evidence_hash === valueDigest({ artifact: evidence.artifact, content: evidence.content });
    const digests = taskEvidenceDigests(evidence.artifact, evidence.content);
    if (!serverArtifact && (evidence.artifact_digest !== digests.artifact_digest
      || evidence.evidence_hash !== digests.evidence_hash)) return null;
    const admission = (task.admissions ?? []).find((candidate) => candidate.lease_id === receipt.lease_id);
    const provenanceDigest = task.contract ? valueDigest(admission?.provenance ?? task.contract.provenance) : 'legacy';
    if (evidence.verification && (adapterId !== 'any' && evidence.verification.adapter_id !== adapterId
      || evidence.verification.evidence_type !== evidence.verification.adapter_id
      || evidence.verification.provenance_digest !== provenanceDigest)) return null;
    if (requireVerification && !evidence.verification) return null;
    if (receipt.state === 'reconciling' && evidence.outcome !== 'passed') return null;
    if (recovery) {
      if (evidence.plan_digest !== receipt.plan_digest || evidence.epoch !== receipt.epoch) return null;
    } else if (evidence.plan_digest !== task.plan_digest || evidence.epoch !== task.lease_epoch
      || canonicalActor(evidence.actor) !== canonicalActor(receipt.actor)
      || canonicalActor(receipt.actor) !== canonicalActor(task.receipt_actor ?? '')) {
      return null;
    }
    matches.push(evidence);
  }
  return matches;
}

function currentReceiptLease(task: HubTask, receipt: TaskReceipt, config: TaskReceiptPredicateConfig): boolean {
  if (!receipt.lease_id) return !config.lease_id && allowsLeaseLessFallback(task, receipt.actor);
  return config.lease_id === receipt.lease_id && (task.admissions ?? []).some((admission) =>
    admission.lease_id === receipt.lease_id && (!admission.lease_revoked
      && (admission.status === 'admitted' || admission.status === 'running')
      || admission.status === 'released' && !admission.launch_error));
}

export const TASK_PREDICATES = {
  task_receipt(events: TaskEvent[], id: string, config: TaskReceiptPredicateConfig): boolean {
    const task = foldTasks(events).find((candidate) => candidate.id === id);
    const receipt = task?.last_receipt;
    const reconciling = task?.state === 'reconciling'
      || task?.state === 'blocked' && task.resume_state === 'reconciling';
    if (!task || task.lease_revoked || !reconciling || receipt?.state !== 'reconciling'
      || receipt.plan_digest !== config.plan_digest || receipt.plan_digest !== task.plan_digest
      || receipt.epoch !== task.lease_epoch || receipt.actor !== task.receipt_actor
      || receipt.artifact_digest !== config.artifact_digest || !currentReceiptLease(task, receipt, config)) {
      return false;
    }
    if (task.contract && contractDigest(task.contract) !== task.plan_digest) return false;
    const verified = matchingEvidence(events, id, receipt, task, false, true);
    if (!verified?.every((evidence) => evidence.verification?.adapter_id === 'task_receipt'
      && evidence.verification.evidence_type === evidence.verification.adapter_id)) return false;
    return (config.evidence_hashes ?? []).every((hash) => receipt.evidence_hashes.includes(hash));
  },
};

const ARTIFACT_BYTE_CAP = 16 * 1024 * 1024;

async function readStableFile(worktree: string, claim: string): Promise<{ path: string; bytes: Buffer } | null> {
  const [canonical] = await normalizeScope(worktree, [claim]).catch(() => []);
  if (!canonical) return null;
  const filename = path.join(worktree, canonical);
  const handle = await fs.open(filename, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)).catch(() => null);
  if (!handle) return null;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > ARTIFACT_BYTE_CAP) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= ARTIFACT_BYTE_CAP) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, ARTIFACT_BYTE_CAP + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, total);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      total += bytesRead;
    }
    if (total > ARTIFACT_BYTE_CAP) return null;
    const after = await handle.stat();
    const finalStat = await fs.lstat(filename).catch(() => null);
    const [canonicalAfter] = await normalizeScope(worktree, [canonical]).catch(() => []);
    if (canonicalAfter !== canonical || !finalStat?.isFile()
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || finalStat.dev !== after.dev || finalStat.ino !== after.ino
      || finalStat.size !== after.size || finalStat.mtimeMs !== after.mtimeMs) return null;
    return { path: canonical, bytes: Buffer.concat(chunks, total) };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function executionWorktree(
  task: HubTask, admission: TmuxAdmission, entry: TeamEntry, projectHome: string,
): Promise<string | null> {
  const [worktree, admittedRoot] = await Promise.all([
    fs.realpath(entry.worktree || projectHome).catch(() => null),
    fs.realpath(admission.repository_root ?? projectHome).catch(() => null),
  ]);
  if (!worktree || !admittedRoot) return null;
  const [worktreeIdentity, admittedIdentity] = await Promise.all([
    repositoryIdentity(worktree).catch(() => null), repositoryIdentity(admittedRoot).catch(() => null),
  ]);
  if (worktree !== admittedRoot && (!worktreeIdentity || worktreeIdentity !== admittedIdentity)) return null;
  if (task.contract!.provenance.kind !== 'research') {
    const contractRoot = await fs.realpath(task.contract!.provenance.repository).catch(() => null);
    const contractIdentity = contractRoot ? await repositoryIdentity(contractRoot).catch(() => null) : null;
    if (worktree !== contractRoot && (!worktreeIdentity || worktreeIdentity !== contractIdentity)) return null;
  }
  return worktree;
}

async function verifiedResearchSources(
  task: HubTask, admission: TmuxAdmission, worktree: string,
): Promise<TaskResearchSource[] | null> {
  if (task.contract!.provenance.kind !== 'research') return [];
  const { source_range: range, evidence_window: window } = task.contract!.provenance;
  const verified: TaskResearchSource[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (const source of range.sources) {
    const observed = Date.parse(source.observed_at);
    if (observed < previous || observed > Date.now()
      || observed < Date.parse(window.starts_at) || observed > Date.parse(window.ends_at)) return null;
    const file = await readStableFile(worktree, source.path);
    if (!file || !pathsWithinScope([file.path], admission.write_scope)
      || createHash('sha256').update(file.bytes).digest('hex') !== source.sha256) return null;
    verified.push({ ...source, path: file.path });
    previous = observed;
  }
  return verified;
}

async function evaluateTaskReceiptLocked(
  root: string, id: string, config: TaskReceiptPredicateConfig, resume = false,
): Promise<boolean> {
  const task = foldTasks(await readTaskEvents(root)).find((candidate) => candidate.id === id);
  const receipt = task?.last_receipt;
  const normalCandidate = receipt?.state === 'reconciling' && (task?.state === 'reconciling'
    || task?.state === 'blocked' && task.resume_state === 'reconciling');
  const resumeCandidate = receipt?.state === 'blocked' && task?.state === 'blocked'
    && (task.resume_state === 'running' || task.resume_state === 'reconciling')
    && task.resume_condition?.type === 'predicate'
    && task.resume_condition.acceptance_id === config.acceptance_id;
  if (!task?.contract || !receipt || task.lease_revoked || contractDigest(task.contract) !== task.plan_digest
    || !(resume ? resumeCandidate : normalCandidate)
    || receipt.plan_digest !== config.plan_digest || receipt.plan_digest !== task.plan_digest
    || receipt.epoch !== task.lease_epoch || receipt.artifact_digest !== config.artifact_digest || !receipt.lease_id
    || !config.output_claim || !config.artifact_path
    || receipt.output_claim !== config.output_claim || !receipt.artifact_path
    || valueDigest(admissionProvenance(task, receipt)) !== valueDigest(task.contract.provenance)
    || !currentReceiptLease(task, receipt, config)) return false;
  const acceptance = task.contract.acceptance.find((candidate) => candidate.predicate_id === 'task_receipt'
    && candidate.version === 1 && candidate.configuration.output_claim === config.output_claim
    && candidate.configuration.artifact_path === config.artifact_path
    && candidate.configuration.artifact_digest === config.artifact_digest);
  const admission = task.admissions?.find((candidate) => candidate.lease_id === receipt.lease_id
    && candidate.output_claim === config.output_claim && candidate.plan_digest === task.plan_digest
    && candidate.root_lease_epoch === task.lease_epoch && acceptance
    && candidate.acceptance_ids.includes(acceptance.id));
  const project = (await readProjects(root)).projects.find((candidate) => candidate.name === task.project);
  if (!acceptance || !admission || !project) return false;
  return withTeamLock(project.home, async () => {
    const { entry } = await assertAdmissionEvidenceLocked(
      root, project.home, id, admission.agent, admission.lease_id,
    ).catch(() => ({ entry: undefined }));
    if (!entry) return false;
    const worktree = await executionWorktree(task, admission, entry, project.home);
    if (!worktree) return false;
    const sources = await verifiedResearchSources(task, admission, worktree);
    if (!sources) return false;
    const file = await readStableFile(worktree, receipt.artifact_path!);
    const [configuredPath] = await normalizeScope(worktree, [config.artifact_path!]).catch(() => []);
    if (!file || file.path !== configuredPath || !pathsWithinScope([file.path], admission.write_scope)) return false;
    const contentDigest = createHash('sha256').update(file.bytes).digest('hex');
    if (contentDigest !== receipt.artifact_digest) return false;
    if (!resume && receipt.actor === 'adapter:task_receipt') {
      return TASK_PREDICATES.task_receipt(await readTaskEvents(root), id, config);
    }
    const artifact = { output_claim: config.output_claim, path: file.path, content_digest: contentDigest };
    const content = {
      bytes: file.bytes.byteLength, declared_sequence: receipt.sequence,
      ...(sources.length ? { sources } : {}),
    };
    const evidenceHash = valueDigest({ artifact, content });
    const evidence: TaskEvidence = {
      actor: resume ? receipt.actor : 'adapter:task_receipt',
      plan_digest: task.plan_digest!, epoch: task.lease_epoch!,
      outcome: 'passed', lease_id: admission.lease_id, artifact, content,
      artifact_digest: contentDigest, evidence_hash: evidenceHash,
      verification: {
        adapter_id: 'task_receipt', evidence_type: 'task_receipt',
        provenance_digest: valueDigest(admission.provenance),
      },
    };
    await appendTaskEvent(root, {
      id, project: task.project, event: 'evidence', at: new Date().toISOString(), evidence,
    });
    if (resume) return true;
    const produced: TaskReceipt = {
      actor: 'adapter:task_receipt', plan_digest: task.plan_digest!, epoch: task.lease_epoch!,
      sequence: (task.last_receipt_sequence ?? 0) + 1, lease_id: admission.lease_id,
      artifact_digest: contentDigest, counters: { bytes: file.bytes.byteLength }, external_ids: {},
      evidence_hashes: [evidenceHash], state: 'reconciling',
      output_claim: config.output_claim, artifact_path: file.path,
    };
    await appendTaskEvent(root, {
      id, project: task.project, event: 'receipt', at: new Date().toISOString(), receipt: produced,
    });
    return TASK_PREDICATES.task_receipt(await readTaskEvents(root), id, config);
  });
}

function admissionProvenance(task: HubTask, receipt: TaskReceipt) {
  return (task.admissions ?? []).find((admission) => admission.lease_id === receipt.lease_id)?.provenance;
}

async function evaluateGitDiffScopeLocked(root: string, id: string, config: GitDiffScopePredicateConfig): Promise<boolean> {
  const task = foldTasks(await readTaskEvents(root)).find((candidate) => candidate.id === id);
  if (!task) throw new Refusal(`unknown task: ${id}`);
  const admission = task.admissions?.find((candidate) => candidate.lease_id === config.lease_id);
  if (!admission || !task.contract?.acceptance.some((acceptance) => acceptance.predicate_id === 'git_diff_scope'
    && admission.acceptance_ids.includes(acceptance.id))) {
    throw new Refusal(`${id} has no registered git_diff_scope allocation for this lease`);
  }
  if (admission.plan_digest !== task.plan_digest || admission.root_lease_epoch !== task.lease_epoch
    || contractDigest(task.contract) !== task.plan_digest) {
    throw new Refusal('git_diff_scope plan digest or epoch is stale');
  }
  if (task.contract.provenance.kind === 'research' || admission.provenance.kind === 'research') {
    throw new Refusal('git_diff_scope needs code provenance');
  }
  if (config.base_revision !== admission.provenance.base_revision
    || config.artifact_revision !== admission.provenance.artifact_revision
    || config.base_revision !== task.contract.provenance.base_revision
    || config.artifact_revision !== task.contract.provenance.artifact_revision) {
    throw new Refusal('git_diff_scope revisions do not match the admitted provenance');
  }
  const project = (await readProjects(root)).projects.find((candidate) => candidate.name === task.project);
  if (!project) throw new Refusal(`unknown project: ${task.project}`);
  return withTeamLock(project.home, async () => {
    const { entry } = await assertAdmissionEvidenceLocked(root, project.home, id, admission.agent, admission.lease_id);
    const result = await gitDiffScope({
      repository: entry.worktree || project.home,
      base_revision: config.base_revision,
      artifact_revision: config.artifact_revision,
      write_scope: admission.write_scope,
      runtime: {
        files: admission.runtime_files,
        team_state_hash: admission.team_state_hash,
        handoff_path: admission.handoff_path,
        handoff_digest: admission.handoff_digest,
        launch_claim_path: admission.launch_claim_path,
        launch_claim_digest: admission.launch_claim_digest,
        launch_claim_completed: admission.launch_claim_completed,
        output_claim: admission.output_claim,
      },
    }).catch(async (error: unknown) => {
      await transitionTmuxAdmissionLocked(root, project.home, admission, 'released', 'git_diff_scope adapter error');
      throw error;
    });
    const digests = taskEvidenceDigests(result.changes, result);
    await appendTaskEvent(root, {
      id, project: task.project, event: 'evidence', at: new Date().toISOString(),
      evidence: {
        actor: `agent:${admission.agent}`, plan_digest: admission.plan_digest, epoch: admission.root_lease_epoch,
        outcome: result.passed ? 'passed' : 'failed', lease_id: admission.lease_id,
        artifact: result.changes, content: result, ...digests,
        verification: {
          adapter_id: 'git_diff_scope', evidence_type: 'git_diff_scope',
          provenance_digest: valueDigest(admission.provenance),
        },
      },
    });
    if (!result.passed) {
      await transitionTmuxAdmissionLocked(root, project.home, admission, 'released', 'out-of-scope Git changes');
    }
    return result.passed;
  });
}

async function evaluateNativeAdmissionLocked(
  root: string, task: HubTask, admission: NonNullable<HubTask['admissions']>[number], config: NativeResultPredicateConfig,
  native: NativeBranchClient,
): Promise<boolean> {
  const project = (await readProjects(root)).projects.find((candidate) => candidate.name === task.project);
  if (!project) return false;
  return withTeamLock(project.home, async () => {
    const scope = { root, project: task.project };
    const matches = config.branch_id
      ? [await readNativeBranch(scope, config.branch_id)]
      : (await listNativeBranches(root, task.project)).filter((candidate) => candidate.leaseId === admission.lease_id);
    if (matches.length !== 1) return false;
    const branch = matches[0];
    if (branch.leaseId !== admission.lease_id || branch.scope.task !== task.id
      || branch.status !== 'active' && branch.status !== 'rejoined'
      || !branch.result || !branch.childSnapshot
      || config.artifact_digest !== undefined && config.artifact_digest !== branch.result.digest
      || branch.result.childHistoryHash !== branch.childSnapshot.historyHash) {
      return false;
    }
    const nativeMessages = new Map(branch.childSnapshot.messages.map((entry) => [entry.id, entry.contentHash]));
    const verifiedReferences = branch.result.findings.every((finding) => finding.nativeEvidence.every(
      (reference) => nativeMessages.get(reference.messageId) === reference.contentHash,
    ));
    if (!verifiedReferences) return false;
    try {
      await assertNativeBranchCurrentLocked(scope, project.home, branch, true);
      await assertNativeResultFresh(branch, native);
    } catch {
      return false;
    }
    const { digest, recordedAt: _recordedAt, ...artifact } = branch.result;
    const content = { resultDigest: digest, childSnapshot: branch.childSnapshot };
    const evidenceHash = taskEvidenceDigests(artifact, content).evidence_hash;
    const events = await readTaskEvents(root);
    const existing = latestEvidence(events, task.id, evidenceHash);
    if (existing) {
      return existing.outcome === 'passed' && existing.artifact_digest === digest
        && existing.lease_id === admission.lease_id && existing.plan_digest === admission.plan_digest
        && existing.epoch === admission.root_lease_epoch
        && existing.verification?.adapter_id === 'native_result'
        && existing.verification.evidence_type === 'native_result'
        && existing.verification.provenance_digest === valueDigest(admission.provenance);
    }
    await appendTaskEvent(root, {
      id: task.id, project: task.project, event: 'evidence', at: new Date().toISOString(),
      evidence: {
        actor: `agent:${admission.agent}`, plan_digest: admission.plan_digest, epoch: admission.root_lease_epoch,
        outcome: 'passed', lease_id: admission.lease_id, artifact, content,
        artifact_digest: digest, evidence_hash: evidenceHash,
        verification: {
          adapter_id: 'native_result', evidence_type: 'native_result',
          provenance_digest: valueDigest(admission.provenance),
        },
      },
    });
    return true;
  });
}

async function evaluateNativeResultLocked(
  root: string, id: string, config: NativeResultPredicateConfig, native?: NativeBranchClient,
): Promise<boolean> {
  const task = foldTasks(await readTaskEvents(root)).find((candidate) => candidate.id === id);
  if (!task?.contract || contractDigest(task.contract) !== task.plan_digest || config.plan_digest !== task.plan_digest) {
    return false;
  }
  const acceptance = config.acceptance_id
    ? task.contract.acceptance.find((candidate) => candidate.id === config.acceptance_id)
    : undefined;
  if (config.acceptance_id && acceptance?.predicate_id !== 'native_result') return false;
  const admissions = (task.admissions ?? []).filter((admission) => admission.adapter === 'native'
    && admission.plan_digest === task.plan_digest && admission.root_lease_epoch === task.lease_epoch
    && (!config.lease_id || admission.lease_id === config.lease_id)
    && (config.acceptance_id
      ? admission.acceptance_ids.includes(config.acceptance_id)
      : task.contract!.acceptance.some((candidate) => candidate.predicate_id === 'native_result'
        && admission.acceptance_ids.includes(candidate.id))));
  if (admissions.length === 0) return false;
  const client = native ?? createNativeBranchClient();
  for (const admission of admissions) {
    if (await evaluateNativeAdmissionLocked(root, task, admission, config, client)) return true;
  }
  return false;
}

export const PREDICATE_REGISTRY = {
  task_receipt: { version: 1, evaluate: evaluateTaskReceiptLocked },
  git_diff_scope: {
    version: 1,
    evaluate: evaluateGitDiffScopeLocked,
  },
  native_result: {
    version: 1,
    evaluate: evaluateNativeResultLocked,
  },
  github_check: {
    version: 1,
    evaluate: evaluateGithubCheck,
  },
};

export const OPERATION_REGISTRY = {
  push: { version: 1, dispatch: pushByHash },
  github_check: {
    version: 1,
    dispatch: dispatchGithubCheck,
    reconcile: reconcileGithubCheck,
    cancel: cancelGithubCheck,
    transfer: transferGithubCheck,
  },
};

export async function evaluateTaskPredicate(
  root: string, id: string, predicate: string, config: TaskPredicateConfig, version = 1, native?: NativeBranchClient,
): Promise<boolean> {
  const entry = PREDICATE_REGISTRY[predicate as keyof typeof PREDICATE_REGISTRY];
  if (!entry || entry.version !== version) throw new Refusal(`blocked:unsupported_predicate: ${predicate} v${version}`);
  if (predicate === 'task_receipt') {
    return withHubLock(root, () => evaluateTaskReceiptLocked(root, id, config as TaskReceiptPredicateConfig));
  }
  if (predicate === 'git_diff_scope') {
    return withHubLock(root, () => evaluateGitDiffScopeLocked(root, id, config as GitDiffScopePredicateConfig));
  }
  if (predicate === 'native_result') {
    return withHubLock(root, () => evaluateNativeResultLocked(root, id, config as NativeResultPredicateConfig, native));
  }
  return entry.evaluate(root, id, config as never);
}

export type AcceptanceEvaluation = { blockers: string[]; requiredBlockers: string[]; passingRegistered: number };

export async function evaluateRegisteredAcceptanceLocked(
  root: string, task: HubTask, acceptance: NonNullable<HubTask['contract']>['acceptance'][number],
  native?: NativeBranchClient, resume = false,
): Promise<boolean> {
  if (!task.contract || !task.plan_digest || contractDigest(task.contract) !== task.plan_digest) return false;
  const entry = PREDICATE_REGISTRY[acceptance.predicate_id as keyof typeof PREDICATE_REGISTRY];
  if (!entry || entry.version !== acceptance.version) return false;
  const config = { ...acceptance.configuration } as TaskPredicateConfig;
  if (acceptance.predicate_id === 'task_receipt') {
    Object.assign(config, {
      plan_digest: task.plan_digest,
      lease_id: (config as TaskReceiptPredicateConfig).lease_id ?? task.last_receipt?.lease_id,
      acceptance_id: acceptance.id,
    });
  } else if (acceptance.predicate_id === 'git_diff_scope') {
    const admission = (task.admissions ?? []).find((candidate) => candidate.acceptance_ids.includes(acceptance.id)
      && candidate.plan_digest === task.plan_digest && candidate.root_lease_epoch === task.lease_epoch);
    Object.assign(config, {
      lease_id: (config as GitDiffScopePredicateConfig).lease_id ?? admission?.lease_id,
      base_revision: task.contract.provenance.base_revision,
      artifact_revision: task.contract.provenance.artifact_revision,
    });
  } else if (acceptance.predicate_id === 'native_result' || acceptance.predicate_id === 'github_check') {
    Object.assign(config, { plan_digest: task.plan_digest, acceptance_id: acceptance.id });
  }
  let passed = false;
  try {
    passed = acceptance.predicate_id === 'native_result'
      ? await evaluateNativeResultLocked(root, task.id, config as NativeResultPredicateConfig, native)
      : acceptance.predicate_id === 'task_receipt'
        ? await evaluateTaskReceiptLocked(root, task.id, config as TaskReceiptPredicateConfig, resume)
        : await entry.evaluate(root, task.id, config as never);
  } catch {
    passed = false;
  }
  const requiredHashes = acceptance.required_evidence.filter((item) => /^[0-9a-f]{64}$/.test(item));
  if (passed && requiredHashes.length) {
    const events = await readTaskEvents(root);
    passed = requiredHashes.every((hash) => events.some((event) => event.id === task.id
      && event.event === 'evidence' && event.evidence?.evidence_hash === hash
      && event.evidence.outcome === 'passed' && event.evidence.plan_digest === task.plan_digest
      && event.evidence.epoch === task.lease_epoch));
  }
  return passed;
}

export async function evaluateAcceptanceLocked(root: string, task: HubTask, native?: NativeBranchClient): Promise<AcceptanceEvaluation> {
  const blockers: string[] = [];
  const requiredBlockers: string[] = [];
  let passingRegistered = 0;
  let passingRequired = 0;
  if (!task.contract || !task.plan_digest || contractDigest(task.contract) !== task.plan_digest) {
    return { blockers: ['the current root contract digest is stale'], requiredBlockers: ['the current root contract digest is stale'], passingRegistered };
  }
  validateRootContract(task.contract);
  for (const acceptance of task.contract.acceptance) {
    const required = acceptance.required !== false;
    const entry = PREDICATE_REGISTRY[acceptance.predicate_id as keyof typeof PREDICATE_REGISTRY];
    if (!entry || entry.version !== acceptance.version) {
      const human = task.human_acceptance?.[acceptance.id];
      const humanActor = human?.actor.startsWith('user:') || human?.actor === 'legacy';
      const accepted = !required && human && humanActor
        && human.plan_digest === task.plan_digest && human.epoch === task.lease_epoch;
      if (!accepted) {
        blockers.push(`blocked:unsupported_predicate:${acceptance.id}`);
        if (required) requiredBlockers.push(`blocked:unsupported_predicate:${acceptance.id}`);
      }
      continue;
    }
    const passed = await evaluateRegisteredAcceptanceLocked(root, task, acceptance, native);
    if (passed) {
      passingRegistered++;
      if (required) passingRequired++;
    } else if (required) {
      blockers.push(`${acceptance.id} has no passing registered evidence`);
      requiredBlockers.push(`${acceptance.id} has no passing registered evidence`);
    }
  }
  if (passingRegistered === 0) blockers.push('no registered acceptance predicate passed');
  if (passingRequired === 0) requiredBlockers.push('no required acceptance predicate passed');
  return { blockers, requiredBlockers, passingRegistered };
}
