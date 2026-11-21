import { valueDigest } from './state.js';
import type { HubTask, TaskAcceptance, TaskEvent, TaskEvidence, TaskReceipt, TeamEntry, TmuxAdmission } from './types.js';

export const REGISTERED_PREDICATES = ['task_receipt', 'git_diff_scope', 'native_result', 'github_check'];

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

export function acceptanceFor(task: HubTask, predicateId: string, acceptanceId?: string): TaskAcceptance | undefined {
  const matches = (task.contract?.acceptance ?? []).filter((acceptance) => acceptance.predicate_id === predicateId
    && (!acceptanceId || acceptance.id === acceptanceId));
  return matches.length === 1 ? matches[0] : undefined;
}

export function evidenceAcceptanceBound(task: HubTask, acceptance: TaskAcceptance, evidence: TaskEvidence): boolean {
  const verification = evidence.verification;
  if (verification?.adapter_id !== acceptance.predicate_id || verification.evidence_type !== acceptance.predicate_id) {
    return false;
  }
  if (verification.acceptance_id !== undefined) return verification.acceptance_id === acceptance.id;
  return acceptanceFor(task, acceptance.predicate_id)?.id === acceptance.id;
}

export function acceptanceReceipt(
  events: TaskEvent[], task: HubTask, acceptance: TaskAcceptance, leaseId = task.last_receipt?.lease_id,
): TaskReceipt | undefined {
  const receipts = events.filter((event) => event.id === task.id && event.event === 'receipt' && event.receipt);
  for (let index = receipts.length - 1; index >= 0; index--) {
    const receipt = receipts[index].receipt!;
    if (receipt.plan_digest !== task.plan_digest || receipt.epoch !== task.lease_epoch
      || receipt.lease_id !== leaseId) continue;
    const bound = new Set<string>();
    if (receipt.resume_condition?.type === 'predicate') {
      const acceptanceId = receipt.resume_condition.acceptance_id;
      if (!task.contract?.acceptance.some((candidate) => candidate.id === acceptanceId)) return receipt;
      bound.add(acceptanceId);
    }
    for (const hash of receipt.evidence_hashes) {
      for (const event of events) {
        if (event.id !== task.id || event.event !== 'evidence' || event.evidence?.evidence_hash !== hash
          || event.evidence.lease_id !== receipt.lease_id || event.evidence.plan_digest !== receipt.plan_digest
          || event.evidence.epoch !== receipt.epoch) continue;
        for (const candidate of task.contract?.acceptance ?? []) {
          if (evidenceAcceptanceBound(task, candidate, event.evidence)) bound.add(candidate.id);
        }
      }
    }
    if (bound.has(acceptance.id) || bound.size === 0) return receipt;
  }
  return undefined;
}

function currentEntry(task: HubTask, admission: TmuxAdmission, entries: TeamEntry[]): TeamEntry | undefined {
  return entries.find((entry) => entry.name === admission.agent && entry.lease_id === admission.lease_id
    && entry.task === task.id && entry.plan_digest === admission.plan_digest
    && entry.root_lease_epoch === admission.root_lease_epoch && entry.lease_epoch === admission.lease_epoch);
}

export function admissionEvidenceCurrent(task: HubTask, admission: TmuxAdmission, entries: TeamEntry[]): boolean {
  const entry = currentEntry(task, admission, entries);
  if (!entry) return false;
  const active = !admission.lease_revoked && ['admitted', 'running'].includes(admission.status)
    && !entry.lease_revoked && !entry.closed_at;
  const cleanRelease = admission.status === 'released' && !admission.launch_error
    && entry.admission_status === 'released' && !entry.launch_error && entry.closed_at;
  return Boolean(active || cleanRelease);
}

function evidenceLeaseCurrent(task: HubTask, admission: TmuxAdmission, entries: TeamEntry[]): boolean {
  if (admission.adapter !== 'native') return admissionEvidenceCurrent(task, admission, entries);
  const active = !admission.lease_revoked && ['admitted', 'running'].includes(admission.status);
  const released = admission.status === 'released' && admission.lease_revoked && !admission.launch_error;
  if (!active && !released || admission.lease_epoch !== 1 || admission.write_scope.length !== 0
    || !admission.parent_lease_id) return false;
  const parent = task.admissions?.find((candidate) => candidate.lease_id === admission.parent_lease_id);
  return Boolean(parent && admission.depth === (parent.depth ?? 1) + 1
    && admissionEvidenceCurrent(task, parent, entries));
}

export function acceptanceAdmission(
  task: HubTask, acceptance: TaskAcceptance, evidence: TaskEvidence, entries: TeamEntry[],
): TmuxAdmission | undefined {
  if (!evidence.lease_id) return undefined;
  const matches = (task.admissions ?? []).filter((admission) => admission.lease_id === evidence.lease_id
    && admission.acceptance_ids.includes(acceptance.id) && admission.plan_digest === task.plan_digest
    && admission.root_lease_epoch === task.lease_epoch
    && (acceptance.predicate_id !== 'native_result' || admission.adapter === 'native')
    && evidenceLeaseCurrent(task, admission, entries));
  return matches.length === 1 ? matches[0] : undefined;
}

function currentReceiptBinding(
  task: HubTask, acceptance: TaskAcceptance, evidence: TaskEvidence, receipt = task.last_receipt,
): boolean {
  const reconciling = task.state === 'reconciling' || task.state === 'blocked' && task.resume_state === 'reconciling';
  const configuredHashes = acceptance.configuration.evidence_hashes;
  return Boolean(reconciling && receipt?.state === 'reconciling' && receipt.plan_digest === task.plan_digest
    && receipt.epoch === task.lease_epoch && receipt.artifact_digest === evidence.artifact_digest
    && receipt.lease_id === evidence.lease_id && receipt.evidence_hashes.includes(evidence.evidence_hash)
    && (!Array.isArray(configuredHashes)
      || configuredHashes.every((hash) => receipt.evidence_hashes.includes(String(hash))))
    && canonicalActor(evidence.actor) === canonicalActor(receipt.actor)
    && canonicalActor(receipt.actor) === canonicalActor(task.receipt_actor ?? ''));
}

export function registeredEvidenceBinding(
  task: HubTask, acceptance: TaskAcceptance, evidence: TaskEvidence, entries: TeamEntry[], provenanceDigest?: string,
  receipt?: TaskReceipt,
): boolean {
  if (!task.contract || task.lease_revoked || evidence.plan_digest !== task.plan_digest
    || evidence.epoch !== task.lease_epoch || !evidenceAcceptanceBound(task, acceptance, evidence)) return false;
  const configuredArtifact = acceptance.configuration.artifact_digest;
  if (typeof configuredArtifact === 'string' && evidence.artifact_digest !== configuredArtifact) return false;
  if (acceptance.predicate_id === 'github_check') {
    return provenanceDigest !== undefined && evidence.verification!.provenance_digest === provenanceDigest;
  }
  if (acceptance.predicate_id === 'task_receipt' && !currentReceiptBinding(task, acceptance, evidence, receipt)) return false;
  const configuredLease = acceptance.configuration.lease_id;
  if (typeof configuredLease === 'string' && configuredLease !== evidence.lease_id) return false;
  if (acceptance.predicate_id === 'task_receipt' && !evidence.lease_id) {
    return allowsLeaseLessFallback(task, evidence.actor)
      && evidence.verification!.provenance_digest === valueDigest(task.contract.provenance);
  }
  const admission = acceptanceAdmission(task, acceptance, evidence, entries);
  return Boolean(admission && evidence.verification!.provenance_digest === valueDigest(admission.provenance));
}
