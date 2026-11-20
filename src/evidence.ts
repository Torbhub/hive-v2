import { assertAdmissionEvidenceLocked, transitionTmuxAdmissionLocked } from './admission.js';
import { assertNativeBranchCurrentLocked, assertNativeResultFresh, listNativeBranches, readNativeBranch } from './branches.js';
import { pushByHash } from './gate.js';
import { createNativeBranchClient } from './native-client.js';
import { gitDiffScope } from './scope.js';
import {
  appendTaskEvent, contractDigest, foldTasks, readProjects, readTaskEvents, Refusal, taskEvidenceDigests,
  validateRootContract, valueDigest, withHubLock, withTeamLock,
} from './state.js';
import type { HubTask, NativeBranchClient, TaskEvent, TaskEvidence, TaskReceipt } from './types.js';

export type TaskReceiptPredicateConfig = {
  plan_digest: string;
  artifact_digest: string;
  evidence_hashes?: string[];
  lease_id?: string;
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
export type TaskPredicateConfig = TaskReceiptPredicateConfig | GitDiffScopePredicateConfig | NativeResultPredicateConfig;

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

function latestEvidence(events: TaskEvent[], id: string, hash: string): TaskEvidence | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.id === id && event.event === 'evidence' && event.evidence?.evidence_hash === hash) {
      return event.evidence;
    }
  }
  return undefined;
}

export function matchingEvidence(
  events: TaskEvent[], id: string, receipt: TaskReceipt, task: HubTask, recovery: boolean, requireVerification = false,
): TaskEvidence[] | null {
  const matches: TaskEvidence[] = [];
  for (const hash of receipt.evidence_hashes) {
    const evidence = latestEvidence(events, id, hash);
    if (!evidence || evidence.artifact_digest !== receipt.artifact_digest
      || evidence.lease_id !== receipt.lease_id) return null;
    const digests = taskEvidenceDigests(evidence.artifact, evidence.content);
    if (evidence.artifact_digest !== digests.artifact_digest || evidence.evidence_hash !== digests.evidence_hash) {
      return null;
    }
    const admission = (task.admissions ?? []).find((candidate) => candidate.lease_id === receipt.lease_id);
    const provenanceDigest = task.contract ? valueDigest(admission?.provenance ?? task.contract.provenance) : 'legacy';
    if (evidence.verification && (evidence.verification.adapter_id !== 'task_receipt'
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
  task_receipt: {
    version: 1,
    async evaluate(root: string, id: string, config: TaskReceiptPredicateConfig): Promise<boolean> {
      return TASK_PREDICATES.task_receipt(await readTaskEvents(root), id, config);
    },
  },
  git_diff_scope: {
    version: 1,
    evaluate: evaluateGitDiffScopeLocked,
  },
  native_result: {
    version: 1,
    evaluate: evaluateNativeResultLocked,
  },
};

export const OPERATION_REGISTRY = {
  push: { version: 1, dispatch: pushByHash },
};

export async function evaluateTaskPredicate(
  root: string, id: string, predicate: string, config: TaskPredicateConfig, version = 1, native?: NativeBranchClient,
): Promise<boolean> {
  const entry = PREDICATE_REGISTRY[predicate as keyof typeof PREDICATE_REGISTRY];
  if (!entry || entry.version !== version) throw new Refusal(`blocked:unsupported_predicate: ${predicate} v${version}`);
  if (predicate === 'git_diff_scope') {
    return withHubLock(root, () => evaluateGitDiffScopeLocked(root, id, config as GitDiffScopePredicateConfig));
  }
  if (predicate === 'native_result') {
    return withHubLock(root, () => evaluateNativeResultLocked(root, id, config as NativeResultPredicateConfig, native));
  }
  return entry.evaluate(root, id, config as never);
}

export type AcceptanceEvaluation = { blockers: string[]; requiredBlockers: string[]; passingRegistered: number };

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
    const config = { ...acceptance.configuration } as TaskPredicateConfig;
    if (acceptance.predicate_id === 'task_receipt') {
      Object.assign(config, {
        plan_digest: task.plan_digest,
        lease_id: (config as TaskReceiptPredicateConfig).lease_id ?? task.last_receipt?.lease_id,
      });
    } else if (acceptance.predicate_id === 'git_diff_scope') {
      const admission = (task.admissions ?? []).find((candidate) => candidate.acceptance_ids.includes(acceptance.id)
        && candidate.plan_digest === task.plan_digest && candidate.root_lease_epoch === task.lease_epoch);
      Object.assign(config, {
        lease_id: (config as GitDiffScopePredicateConfig).lease_id ?? admission?.lease_id,
        base_revision: task.contract.provenance.base_revision,
        artifact_revision: task.contract.provenance.artifact_revision,
      });
    } else if (acceptance.predicate_id === 'native_result') {
      Object.assign(config, { plan_digest: task.plan_digest, acceptance_id: acceptance.id });
    }
    let passed = false;
    try {
      passed = acceptance.predicate_id === 'native_result'
        ? await evaluateNativeResultLocked(root, task.id, config as NativeResultPredicateConfig, native)
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
