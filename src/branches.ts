import { constants, promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { cleanAgentText, containsInternalContent, containsSecurityInstruction } from './decisions.js';
import { withProjectLock } from './project.js';
import { assertExecutionAllowed } from './rollout.js';
import { authorizeExact, exactGrant, revoked, type Principal } from './security.js';
import { Refusal, hivePath, readProjects, readTeam, withTeamLock, writeJson } from './state.js';
import type { Registry, RegistryRow } from './registry.js';
import type {
  NativeBranchClient,
  NativeBranchCreateScope,
  NativeBranchFinding,
  NativeBranchRecord,
  NativeBranchResult,
  NativeBranchReview,
  NativeBranchScope,
  NativeBranchSnapshot,
  NativeMessage,
  NativeSession,
} from './types.js';

export type { NativeBranchRecord } from './types.js';

export const MAX_NATIVE_BRANCH_RESULT_BYTES = 64 * 1024;
export const NATIVE_HISTORY_SNAPSHOT_CAP = 100;

const MAX_NATIVE_BRANCH_RECORD_BYTES = 256 * 1024;
const REVIEW_TTL_MS = 15 * 60_000;
const BRANCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const STATUSES = ['creating', 'active', 'stale', 'diverged', 'unknown', 'rejoined'];

type TimeOptions = { now?: string };
type AuthInput = { principal: Principal; registry: Registry };
class Diverged extends Error {}
class HistoryCap extends Error {}
class CasConflict extends Error {}

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function now(options: TimeOptions): string {
  const parsed = options.now === undefined ? new Date() : new Date(options.now);
  if (Number.isNaN(parsed.getTime())) throw new Refusal('invalid native branch timestamp');
  return parsed.toISOString();
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Refusal(`${field} must be an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], field: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Refusal(`${field}: unknown field ${key}`);
}
function text(value: unknown, field: string, cap = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > cap) throw new Refusal(`${field} is invalid`);
  return value;
}
function hash(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Refusal(`${field} is invalid`);
  return value;
}
function enabled(): void {
  if (process.env.HIVE_NATIVE_BRANCHES !== '1') throw new Refusal('native branches are disabled; set HIVE_NATIVE_BRANCHES=1');
}
function branchPath(home: string, id: string): string {
  if (!BRANCH_ID.test(id)) throw new Refusal('invalid native branch id');
  return hivePath(home, 'branches', `${id}.json`);
}
async function readBounded(file: string, cap: number): Promise<string> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > cap) throw new Refusal(`not a regular bounded file: ${file}`);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(16_384, cap + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > cap) throw new Refusal(`file exceeds byte cap: ${file}`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await handle.close();
  }
}
function snapshotFrom(value: unknown, field: string): NativeBranchSnapshot {
  const raw = object(value, field);
  keys(raw, ['count', 'headId', 'historyHash', 'messages'], field);
  if (!Array.isArray(raw.messages) || raw.messages.length > NATIVE_HISTORY_SNAPSHOT_CAP || raw.count !== raw.messages.length) {
    throw new Refusal(`${field}.messages is invalid`);
  }
  const ids = new Set<string>();
  const messages = raw.messages.map((entry, index) => {
    const item = object(entry, `${field}.messages[${index}]`);
    keys(item, ['id', 'contentHash'], `${field}.messages[${index}]`);
    const id = text(item.id, `${field}.messages[${index}].id`);
    if (ids.has(id)) throw new Refusal(`${field} has duplicate message ids`);
    ids.add(id);
    return { id, contentHash: hash(item.contentHash, `${field}.messages[${index}].contentHash`) };
  });
  const headId = raw.headId === null ? null : text(raw.headId, `${field}.headId`);
  if (headId !== (messages.at(-1)?.id ?? null)) throw new Refusal(`${field}.headId conflicts with history`);
  const historyHash = hash(raw.historyHash, `${field}.historyHash`);
  if (historyHash !== sha(messages)) throw new Refusal(`${field}.historyHash conflicts with history`);
  return { count: messages.length, headId, historyHash, messages };
}
function cleanFindingText(value: unknown, field: string): string {
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Refusal(`${field} has unsafe controls`);
  }
  if (containsSecurityInstruction(value) || containsInternalContent(value)) throw new Refusal(`${field} has unsafe instructions`);
  const clean = cleanAgentText(value);
  if (!clean || clean === 'Internal content removed.' || containsSecurityInstruction(clean) || containsInternalContent(clean)) {
    throw new Refusal(`${field} has unsafe instructions`);
  }
  if (clean.length > 16_000) throw new Refusal(`${field} is too large`);
  return clean;
}
function findingFrom(value: unknown, branchId: string, stored: boolean): NativeBranchFinding {
  const raw = object(value, 'native result finding');
  keys(raw, stored ? ['id', 'answer', 'recommendation', 'uncertainty', 'nativeEvidence'] : ['answer', 'recommendation', 'uncertainty', 'nativeEvidence'], 'native result finding');
  const answer = cleanFindingText(raw.answer, 'native result answer');
  const recommendation = cleanFindingText(raw.recommendation, 'native result recommendation');
  const uncertainty = cleanFindingText(raw.uncertainty, 'native result uncertainty');
  if (!Array.isArray(raw.nativeEvidence) || raw.nativeEvidence.length < 1 || raw.nativeEvidence.length > 20) {
    throw new Refusal('native result evidence requires 1..20 references');
  }
  const nativeEvidence = raw.nativeEvidence.map((entry) => {
    const evidence = object(entry, 'native result evidence');
    keys(evidence, ['messageId', 'contentHash'], 'native result evidence');
    return { messageId: text(evidence.messageId, 'native evidence messageId'), contentHash: hash(evidence.contentHash, 'native evidence contentHash') };
  });
  const id = `f_${sha({ branchId, answer, recommendation, uncertainty, nativeEvidence })}`;
  if (stored && raw.id !== id) throw new Refusal('native result finding id conflicts with content');
  return { id, answer, recommendation, uncertainty, nativeEvidence };
}
function resultDigest(result: NativeBranchResult): string {
  return sha({
    schemaVersion: 1,
    branchId: result.branchId,
    childHistoryHash: result.childHistoryHash,
    findings: result.findings.map((finding) => ({
      id: finding.id, answer: finding.answer, recommendation: finding.recommendation,
      uncertainty: finding.uncertainty, nativeEvidence: finding.nativeEvidence,
    })),
  });
}
function resultFrom(branch: NativeBranchRecord, value: unknown, stored: boolean): NativeBranchResult {
  const raw = object(value, 'native result schema');
  keys(raw, stored
    ? ['schemaVersion', 'branchId', 'childHistoryHash', 'findings', 'digest', 'recordedAt']
    : ['schemaVersion', 'branchId', 'childHistoryHash', 'findings'], 'native result schema');
  const childHistoryHash = hash(raw.childHistoryHash, 'native result childHistoryHash');
  if (raw.schemaVersion !== 1 || raw.branchId !== branch.id || !branch.childSnapshot
    || (branch.status !== 'stale' && childHistoryHash !== branch.childSnapshot.historyHash)) {
    throw new Refusal('native result branch or child snapshot does not match');
  }
  if (!Array.isArray(raw.findings) || raw.findings.length < 1 || raw.findings.length > 50) throw new Refusal('native result schema needs 1..50 findings');
  const result: NativeBranchResult = {
    schemaVersion: 1,
    branchId: branch.id,
    childHistoryHash,
    findings: raw.findings.map((finding) => findingFrom(finding, branch.id, stored)),
  };
  if (stored) {
    if (raw.digest !== resultDigest(result)) throw new Refusal('native result digest conflicts with content');
    text(raw.recordedAt, 'native result recordedAt', 40);
  }
  return result;
}
function reviewDigest(review: Omit<NativeBranchReview, 'digest'>): string {
  return sha({
    branchId: review.branchId,
    findingIds: review.findingIds,
    parentHistoryHash: review.parentHistoryHash,
    childHistoryHash: review.childHistoryHash,
    reviewer: review.reviewer,
    consumerGrantId: review.consumerGrantId,
    consumerAclEpoch: review.consumerAclEpoch,
    approverGrantId: review.approverGrantId,
    approverAclEpoch: review.approverAclEpoch,
    createdAt: review.createdAt,
    expiresAt: review.expiresAt,
  });
}
function reviewFrom(value: unknown): NativeBranchReview {
  const raw = object(value, 'native branch review');
  keys(raw, [
    'branchId', 'findingIds', 'digest', 'parentHistoryHash', 'childHistoryHash', 'reviewer',
    'consumerGrantId', 'consumerAclEpoch', 'approverGrantId', 'approverAclEpoch', 'createdAt', 'expiresAt',
  ], 'native branch review');
  if (!Array.isArray(raw.findingIds) || raw.findingIds.length === 0 || raw.findingIds.some((id) => typeof id !== 'string')) {
    throw new Refusal('native branch review findingIds is invalid');
  }
  const base = {
    branchId: text(raw.branchId, 'review branchId'),
    findingIds: raw.findingIds as string[],
    parentHistoryHash: hash(raw.parentHistoryHash, 'review parentHistoryHash'),
    childHistoryHash: hash(raw.childHistoryHash, 'review childHistoryHash'),
    reviewer: text(raw.reviewer, 'review reviewer'),
    consumerGrantId: text(raw.consumerGrantId, 'review consumerGrantId'),
    consumerAclEpoch: Number(raw.consumerAclEpoch),
    approverGrantId: text(raw.approverGrantId, 'review approverGrantId'),
    approverAclEpoch: Number(raw.approverAclEpoch),
    createdAt: text(raw.createdAt, 'review createdAt', 40),
    expiresAt: text(raw.expiresAt, 'review expiresAt', 40),
  };
  if (!Number.isSafeInteger(base.consumerAclEpoch) || !Number.isSafeInteger(base.approverAclEpoch)) throw new Refusal('review ACL epochs are invalid');
  const digest = reviewDigest(base);
  if (raw.digest !== digest) throw new Refusal('native review digest conflicts with content');
  return { ...base, digest };
}
function recordFrom(value: unknown, id: string): NativeBranchRecord {
  const raw = object(value, 'native branch record');
  keys(raw, [
    'schemaVersion', 'id', 'kind', 'purpose', 'parentSessionId', 'childSessionId', 'workspaceId', 'cwd',
    'scope', 'parentSnapshot', 'childSnapshot', 'status', 'createdAt', 'updatedAt', 'error', 'result', 'review', 'rejoin',
  ], 'native branch record');
  if (raw.schemaVersion !== 1 || raw.id !== id || !['child', 'fork'].includes(String(raw.kind)) || !STATUSES.includes(String(raw.status))) {
    throw new Refusal('native branch record schema is invalid');
  }
  const scope = object(raw.scope, 'native branch scope');
  keys(scope, ['project', 'agent', 'task'], 'native branch scope');
  const childSnapshot = raw.childSnapshot === null ? null : snapshotFrom(raw.childSnapshot, 'native child snapshot');
  const branch: NativeBranchRecord = {
    schemaVersion: 1,
    id,
    kind: raw.kind as 'child' | 'fork',
    purpose: text(raw.purpose, 'native branch purpose', 4_000),
    parentSessionId: text(raw.parentSessionId, 'native parentSessionId'),
    childSessionId: raw.childSessionId === null ? null : text(raw.childSessionId, 'native childSessionId'),
    workspaceId: text(raw.workspaceId, 'native workspaceId'),
    cwd: text(raw.cwd, 'native cwd', 4_000),
    scope: { project: text(scope.project, 'scope.project'), agent: text(scope.agent, 'scope.agent'), task: text(scope.task, 'scope.task') },
    parentSnapshot: snapshotFrom(raw.parentSnapshot, 'native parent snapshot'),
    childSnapshot,
    status: raw.status as NativeBranchRecord['status'],
    createdAt: text(raw.createdAt, 'native createdAt', 40),
    updatedAt: text(raw.updatedAt, 'native updatedAt', 40),
    ...(raw.error === undefined ? {} : { error: text(raw.error, 'native error', 1_000) }),
  };
  if (['active', 'stale', 'rejoined'].includes(branch.status) && (!branch.childSessionId || !branch.childSnapshot)) throw new Refusal('active branch requires child identity and snapshot');
  if (raw.result !== undefined) {
    const result = resultFrom(branch, raw.result, true);
    const stored = object(raw.result, 'native stored result');
    branch.result = { ...result, digest: resultDigest(result), recordedAt: String(stored.recordedAt) };
  }
  if (raw.review !== undefined) {
    const review = reviewFrom(raw.review);
    if (review.branchId !== id || review.parentHistoryHash !== branch.parentSnapshot.historyHash
      || (branch.status !== 'stale' && review.childHistoryHash !== branch.childSnapshot?.historyHash)) {
      throw new Refusal('native review snapshot binding is stale');
    }
    branch.review = review;
  }
  if (raw.rejoin !== undefined) {
    const rejoin = object(raw.rejoin, 'native rejoin');
    keys(rejoin, ['status', 'reviewDigest', 'promptId', 'promptHash', 'intentAt', 'nativeMessageId', 'rejoinedAt', 'detail'], 'native rejoin');
    if (!['submitting', 'unknown', 'rejoined'].includes(String(rejoin.status))) throw new Refusal('native rejoin status is invalid');
    branch.rejoin = {
      status: rejoin.status as NonNullable<NativeBranchRecord['rejoin']>['status'],
      reviewDigest: hash(rejoin.reviewDigest, 'rejoin reviewDigest'),
      promptId: text(rejoin.promptId, 'rejoin promptId'),
      promptHash: hash(rejoin.promptHash, 'rejoin promptHash'),
      intentAt: text(rejoin.intentAt, 'rejoin intentAt', 40),
      ...(rejoin.nativeMessageId === undefined ? {} : { nativeMessageId: text(rejoin.nativeMessageId, 'rejoin nativeMessageId') }),
      ...(rejoin.rejoinedAt === undefined ? {} : { rejoinedAt: text(rejoin.rejoinedAt, 'rejoin rejoinedAt', 40) }),
      ...(rejoin.detail === undefined ? {} : { detail: text(rejoin.detail, 'rejoin detail', 1_000) }),
    };
  }
  return branch;
}
async function readBranchFile(home: string, id: string): Promise<NativeBranchRecord> {
  let value: unknown;
  try {
    value = JSON.parse(await readBounded(branchPath(home, id), MAX_NATIVE_BRANCH_RECORD_BYTES));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'EISDIR') {
      throw new Refusal('native branch record must be a regular file; symbolic links are refused');
    }
    if (error instanceof Refusal) throw error;
    throw new Refusal(`native branch record cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  return recordFrom(value, id);
}
async function commit(home: string, expected: NativeBranchRecord, next: NativeBranchRecord): Promise<NativeBranchRecord> {
  const current = await readBranchFile(home, expected.id);
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new CasConflict('native branch record changed');
  const parsed = recordFrom(next, expected.id);
  await writeJson(branchPath(home, expected.id), parsed, 0o600);
  return parsed;
}
async function homeFor(scope: NativeBranchScope): Promise<string> {
  const project = (await readProjects(scope.root)).projects.find((candidate) => candidate.name === scope.project);
  if (!project) throw new Refusal(`unknown project: ${scope.project}`);
  return project.home;
}
async function withBranchLock<T>(scope: NativeBranchScope, fn: (home: string) => Promise<T>): Promise<T> {
  return withProjectLock(scope.root, scope.project, async (project) => withTeamLock(project.home, () => fn(project.home)));
}
async function assertCurrentTeam(home: string, branch: NativeBranchRecord): Promise<void> {
  const matches = (await readTeam(home)).agents.filter((agent) => !agent.orchestrator && agent.name === branch.scope.agent
    && agent.task === branch.scope.task && agent.session_id === branch.parentSessionId);
  if (matches.length !== 1) throw new Refusal('native branch requires one current TeamEntry matching agent, task, and parent session');
}
export async function readNativeBranch(scope: NativeBranchScope, id: string): Promise<NativeBranchRecord> {
  const branch = await readBranchFile(await homeFor(scope), id);
  if (branch.scope.project !== scope.project) throw new Refusal('native branch project scope mismatch');
  return branch;
}
export async function listNativeBranches(root: string, project: string): Promise<NativeBranchRecord[]> {
  const home = await homeFor({ root, project });
  const entries = await fs.readdir(hivePath(home, 'branches'), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const records: NativeBranchRecord[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.json')) records.push(await readBranchFile(home, entry.name.slice(0, -5)));
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
function verifySession(branch: NativeBranchRecord, session: NativeSession, parent: boolean): void {
  if (!session || session.id !== (parent ? branch.parentSessionId : branch.childSessionId)
    || session.workspace_id !== branch.workspaceId || session.metadata?.cwd !== branch.cwd) throw new Diverged('native workspace or session identity changed');
  if (parent) return;
  if (session.metadata.hive_branch_id !== branch.id) throw new Diverged('native hive branch id changed');
  if (branch.kind === 'child' && (session.metadata.parent_session_id !== branch.parentSessionId || session.metadata.child_session_kind !== 'child')) {
    throw new Diverged('native child relationship changed');
  }
}
async function snapshotHistory(native: NativeBranchClient, sessionId: string): Promise<NativeBranchSnapshot> {
  const newest: NativeMessage[] = [];
  const ids = new Set<string>();
  let beforeId: string | undefined;
  for (;;) {
    const page = await native.listMessages(sessionId, { beforeId, pageSize: NATIVE_HISTORY_SNAPSHOT_CAP });
    if (!page || !Array.isArray(page.items) || typeof page.has_more !== 'boolean') throw new HistoryCap('native history page is malformed');
    if (page.has_more && page.items.length < NATIVE_HISTORY_SNAPSHOT_CAP) throw new HistoryCap('native history cap exhausted');
    for (const message of page.items) {
      if (!message || typeof message.id !== 'string' || !message.id || message.session_id !== sessionId
        || !Array.isArray(message.content) || typeof message.created_at !== 'string') throw new Diverged('native history message is malformed');
      if (ids.has(message.id)) throw new Diverged('native history has duplicate ids');
      ids.add(message.id);
      newest.push(message);
    }
    if (!page.has_more) break;
    if (newest.length >= NATIVE_HISTORY_SNAPSHOT_CAP || page.items.length === 0) throw new HistoryCap('native history cap exhausted');
    beforeId = page.items.at(-1)?.id;
    if (!beforeId) throw new HistoryCap('native history cursor is invalid');
  }
  const messages = newest.reverse().map((message) => ({ id: message.id, contentHash: sha(message.content) }));
  return { count: messages.length, headId: messages.at(-1)?.id ?? null, historyHash: sha(messages), messages };
}
function sameSnapshot(a: NativeBranchSnapshot, b: NativeBranchSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function sameForkSnapshot(branch: NativeBranchRecord, current: NativeBranchSnapshot): boolean {
  const baseline = branch.parentSnapshot;
  if (baseline.count !== current.count || !branch.childSessionId) return false;
  const sessionPrefixes = (sessionId: string) => [...new Set([`msg_${sessionId}_`, `msg_${sessionId.replace(/^session_/, '')}_`])];
  const parentPrefixes = sessionPrefixes(branch.parentSessionId);
  const childPrefixes = sessionPrefixes(branch.childSessionId);
  return baseline.messages.every((parent, index) => {
    const child = current.messages[index];
    if (!child || parent.contentHash !== child.contentHash) return false;
    if (parent.id === child.id) return true;
    return parentPrefixes.some((prefix, prefixIndex) => {
      const suffix = parent.id.startsWith(prefix) ? parent.id.slice(prefix.length) : '';
      return suffix.length > 0 && child.id === `${childPrefixes[prefixIndex]}${suffix}`;
    });
  });
}
function isPrefix(baseline: NativeBranchSnapshot, current: NativeBranchSnapshot): boolean {
  return baseline.count <= current.count && baseline.messages.every((entry, index) => {
    const candidate = current.messages[index];
    return candidate && candidate.id === entry.id && candidate.contentHash === entry.contentHash;
  });
}
async function refreshLocked(home: string, branch: NativeBranchRecord, native: NativeBranchClient, at: string): Promise<NativeBranchRecord> {
  if (branch.status === 'diverged' || branch.status === 'rejoined') return branch;
  try {
    const [parent, child] = await Promise.all([native.getSession(branch.parentSessionId), native.getSession(branch.childSessionId ?? '')]);
    verifySession(branch, parent, true);
    verifySession(branch, child, false);
    const [parentSnapshot, childSnapshot] = await Promise.all([
      snapshotHistory(native, branch.parentSessionId), snapshotHistory(native, branch.childSessionId!),
    ]);
    if (!sameSnapshot(branch.parentSnapshot, parentSnapshot)) throw new Diverged('parent history changed');
    if (!isPrefix(branch.childSnapshot!, childSnapshot)) throw new Diverged('child history was rewritten or shortened');
    const appended = !sameSnapshot(branch.childSnapshot!, childSnapshot);
    const status = branch.status === 'stale' || (appended && (branch.result || branch.review)) ? 'stale' : 'active';
    if (!appended && branch.status === status) return branch;
    return await commit(home, branch, { ...branch, childSnapshot, status, updatedAt: at, error: undefined });
  } catch (error) {
    if (error instanceof CasConflict || error instanceof Refusal) throw error;
    const status = error instanceof Diverged ? 'diverged' : 'unknown';
    return commit(home, branch, {
      ...branch, status, error: `${status}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1_000), updatedAt: at,
    });
  }
}
async function unknown(home: string, expected: NativeBranchRecord, at: string, error: unknown): Promise<NativeBranchRecord> {
  const next: NativeBranchRecord = {
    ...expected, status: 'unknown', error: `unknown: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1_000), updatedAt: at,
    ...(expected.rejoin ? { rejoin: { ...expected.rejoin, status: 'unknown', detail: String(error instanceof Error ? error.message : error).slice(0, 1_000) } } : {}),
  };
  try {
    return await commit(home, expected, next);
  } catch {
    return next;
  }
}
export async function createNativeBranch(
  scope: NativeBranchCreateScope,
  input: { kind: 'child' | 'fork'; purpose: string },
  native: NativeBranchClient,
  options: TimeOptions = {},
): Promise<NativeBranchRecord> {
  enabled();
  return withBranchLock(scope, async (home) => {
    await assertExecutionAllowed(scope.root, scope.project);
    const agents = (await readTeam(home)).agents.filter((agent) => agent.name === scope.agent && !agent.orchestrator);
    if (agents.length !== 1 || !agents[0].task || !agents[0].session_id) throw new Refusal('native branch requires one uniquely scoped TeamEntry');
    const agent = agents[0];
    const purpose = text(input.purpose, 'native branch purpose', 4_000);
    if (input.kind !== 'child' && input.kind !== 'fork') throw new Refusal('native branch kind must be child or fork');
    const parent = await native.getSession(agent.session_id!);
    if (!parent || parent.id !== agent.session_id || parent.metadata.cwd !== home) throw new Refusal('native parent workspace mismatch');
    const parentSnapshot = await snapshotHistory(native, parent.id);
    const at = now(options);
    const id = randomUUID();
    let current: NativeBranchRecord = {
      schemaVersion: 1, id, kind: input.kind, purpose,
      parentSessionId: parent.id, childSessionId: null, workspaceId: parent.workspace_id, cwd: home,
      scope: { project: scope.project, agent: scope.agent, task: agent.task! },
      parentSnapshot, childSnapshot: null, status: 'creating', createdAt: at, updatedAt: at,
    };
    await writeJson(branchPath(home, id), current, 0o600);
    try {
      const request = { title: `Hive branch ${id}`, metadata: { hive_branch_id: id, hive_purpose: purpose } };
      const child = input.kind === 'child'
        ? await native.createChild(parent.id, request)
        : await native.forkSession(parent.id, request);
      const identified = { ...current, childSessionId: child.id };
      verifySession(identified, child, false);
      current = await commit(home, current, identified);
      const childSnapshot = await snapshotHistory(native, child.id);
      if (childSnapshot.count === 0) throw new HistoryCap('native child head is absent');
      if (input.kind === 'fork' && !sameForkSnapshot(current, childSnapshot)) throw new Diverged('plain fork is not the current full-history snapshot');
      return await commit(home, current, { ...current, childSnapshot, status: 'active', updatedAt: at, error: undefined });
    } catch (error) {
      return unknown(home, current, at, error);
    }
  });
}
export async function reconcileNativeBranchCreation(
  scope: NativeBranchScope, id: string, native: NativeBranchClient, options: TimeOptions = {},
): Promise<NativeBranchRecord> {
  enabled();
  return withBranchLock(scope, async (home) => {
    await assertExecutionAllowed(scope.root, scope.project);
    let branch = await readNativeBranch(scope, id);
    await assertCurrentTeam(home, branch);
    if (branch.status === 'active') return branch;
    const expected = branch;
    const at = now(options);
    try {
      verifySession(branch, await native.getSession(branch.parentSessionId), true);
      if (!sameSnapshot(branch.parentSnapshot, await snapshotHistory(native, branch.parentSessionId))) throw new Diverged('parent history changed');
      if (!branch.childSessionId) {
        if (branch.kind !== 'child') throw new Diverged('plain fork cannot be rediscovered as a child');
        const children = await native.listChildren(branch.parentSessionId, { pageSize: 100 });
        if (children.has_more) throw new HistoryCap('native child discovery is truncated');
        const matches = children.items.filter((child) => child.metadata.hive_branch_id === id);
        if (matches.length !== 1) throw new Diverged('native child discovery is not unique');
        branch = { ...branch, childSessionId: matches[0].id };
      }
      const childSessionId = branch.childSessionId;
      if (!childSessionId) throw new Diverged('native child identity is unavailable');
      verifySession(branch, await native.getSession(childSessionId), false);
      const childSnapshot = await snapshotHistory(native, childSessionId);
      if (childSnapshot.count === 0) throw new HistoryCap('native child head is absent');
      if (branch.kind === 'fork' && !sameForkSnapshot(branch, childSnapshot)) throw new Diverged('plain fork is not the current full-history snapshot');
      return await commit(home, expected, { ...branch, childSnapshot, status: 'active', updatedAt: at, error: undefined });
    } catch (error) {
      return unknown(home, expected, at, error);
    }
  });
}
export async function refreshNativeBranch(
  scope: NativeBranchScope, id: string, native: NativeBranchClient, options: TimeOptions = {},
): Promise<NativeBranchRecord> {
  enabled();
  return withBranchLock(scope, async (home) => {
    await assertExecutionAllowed(scope.root, scope.project);
    const branch = await readNativeBranch(scope, id);
    await assertCurrentTeam(home, branch);
    return refreshLocked(home, branch, native, now(options));
  });
}
export function parseNativeBranchResult(branch: NativeBranchRecord, value: unknown): NativeBranchResult {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Refusal('native result schema is not serializable');
  }
  if (serialized === undefined) throw new Refusal('native result schema must be an object');
  if (Buffer.byteLength(serialized) > MAX_NATIVE_BRANCH_RESULT_BYTES) throw new Refusal('native result oversized');
  return resultFrom(branch, value, false);
}
export async function recordNativeBranchResult(
  scope: NativeBranchScope, id: string, value: unknown, native: NativeBranchClient, options: TimeOptions = {},
): Promise<NativeBranchRecord> {
  enabled();
  return withBranchLock(scope, async (home) => {
    await assertExecutionAllowed(scope.root, scope.project);
    let branch = await readNativeBranch(scope, id);
    await assertCurrentTeam(home, branch);
    if (branch.status !== 'active') throw new Refusal('native branch is not active');
    const parsed = parseNativeBranchResult(branch, value);
    const [parent, child] = await Promise.all([native.getSession(branch.parentSessionId), native.getSession(branch.childSessionId!)]);
    verifySession(branch, parent, true);
    verifySession(branch, child, false);
    const [parentSnapshot, childSnapshot] = await Promise.all([
      snapshotHistory(native, branch.parentSessionId), snapshotHistory(native, branch.childSessionId!),
    ]);
    if (!sameSnapshot(branch.parentSnapshot, parentSnapshot) || !sameSnapshot(branch.childSnapshot!, childSnapshot)) {
      throw new Refusal('native result snapshot is stale');
    }
    const evidence = new Map(childSnapshot.messages.map((entry) => [entry.id, entry.contentHash]));
    for (const finding of parsed.findings) {
      for (const reference of finding.nativeEvidence) {
        if (evidence.get(reference.messageId) !== reference.contentHash) throw new Refusal('native result evidence does not match the child snapshot');
      }
    }
    const digest = resultDigest(parsed);
    if (branch.result) {
      if (branch.result.digest !== digest) throw new Refusal('native branch terminal result conflicts');
      return branch;
    }
    const at = now(options);
    const expected = branch;
    return commit(home, expected, { ...expected, result: { ...parsed, digest, recordedAt: at }, updatedAt: at });
  });
}
async function grantValid(registry: Registry, row: RegistryRow, at: string): Promise<boolean> {
  const expiresAt = row.expiresAt;
  if (expiresAt !== undefined && expiresAt !== null) {
    const expiry = Number(expiresAt);
    if (!Number.isSafeInteger(expiry) || expiry < 0 || (expiry !== 0 && expiry <= Math.floor(Date.parse(at) / 1000))) return false;
  }
  return !await revoked(registry, row);
}
async function reviewAuthority(branch: NativeBranchRecord, input: AuthInput, at: string) {
  if (input.principal.kind !== 'human') throw new Refusal('native branch review requires a human principal');
  const task = branch.scope.task;
  const approver = await authorizeExact(input.principal, input.registry, 'execute', { project: branch.scope.project, task });
  const consumer = await exactGrant(input.registry, branch.scope.project, `agent:${branch.scope.agent}`, task);
  const profile = await input.registry.get(`AGENT#${branch.scope.agent}`, 'PROFILE');
  if (!consumer || !Array.isArray(consumer.actions) || !consumer.actions.includes('execute') || typeof consumer.grantId !== 'string'
    || !profile || profile.project !== branch.scope.project || await revoked(input.registry, profile) || typeof approver.grantId !== 'string'
    || !Number.isSafeInteger(Number(profile.aclEpoch)) || !Number.isSafeInteger(Number(approver.aclEpoch))
    || !await grantValid(input.registry, approver, at) || !await grantValid(input.registry, consumer, at)) {
    throw new Refusal('native branch review grant, expiry, project, or ACL authority is invalid');
  }
  return {
    reviewer: input.principal.subject,
    consumerGrantId: consumer.grantId,
    consumerAclEpoch: Number(profile.aclEpoch),
    approverGrantId: approver.grantId,
    approverAclEpoch: Number(approver.aclEpoch),
  };
}
export async function reviewNativeBranch(
  scope: NativeBranchScope, id: string,
  input: { findingIds: string[] } & AuthInput,
  native: NativeBranchClient,
  options: TimeOptions = {},
): Promise<NativeBranchRecord> {
  enabled();
  return withBranchLock(scope, async (home) => {
    await assertExecutionAllowed(scope.root, scope.project);
    let branch = await readNativeBranch(scope, id);
    await assertCurrentTeam(home, branch);
    if (branch.status !== 'active' || !branch.result || branch.rejoin) throw new Refusal('native branch has no active result to review');
    const authority = await reviewAuthority(branch, input, now(options));
    if (input.findingIds.length === 0 || new Set(input.findingIds).size !== input.findingIds.length
      || input.findingIds.some((findingId) => !branch.result!.findings.some((finding) => finding.id === findingId))) {
      throw new Refusal('native branch review selected invalid findings');
    }
    branch = await refreshLocked(home, branch, native, now(options));
    if (branch.status !== 'active' || !branch.result) throw new Refusal('native branch result is stale');
    const at = now(options);
    const base = {
      branchId: branch.id,
      findingIds: [...input.findingIds],
      parentHistoryHash: branch.parentSnapshot.historyHash,
      childHistoryHash: branch.childSnapshot!.historyHash,
      ...authority,
      createdAt: at,
      expiresAt: new Date(Date.parse(at) + REVIEW_TTL_MS).toISOString(),
    };
    const review: NativeBranchReview = { ...base, digest: reviewDigest(base) };
    return commit(home, branch, { ...branch, review, updatedAt: at });
  });
}
function selectedFindings(branch: NativeBranchRecord): NativeBranchFinding[] {
  return branch.review!.findingIds.map((findingId) => {
    const finding = branch.result!.findings.find((candidate) => candidate.id === findingId);
    if (!finding) throw new Refusal('native review finding is missing');
    return finding;
  });
}
function rejoinPrompt(branch: NativeBranchRecord, promptId: string): string {
  return JSON.stringify({
    kind: 'hive.native-branch.reviewed-findings',
    untrusted: true,
    branchId: branch.id,
    reviewDigest: branch.review!.digest,
    promptId,
    parentSessionId: branch.parentSessionId,
    childSessionId: branch.childSessionId,
    parentHistoryHash: branch.parentSnapshot.historyHash,
    childHistoryHash: branch.childSnapshot!.historyHash,
    findings: selectedFindings(branch),
  });
}
async function verifyReview(branch: NativeBranchRecord, input: AuthInput, at: string): Promise<void> {
  const expiresAt = branch.review ? Date.parse(branch.review.expiresAt) : NaN;
  if (!branch.review || !Number.isFinite(expiresAt) || expiresAt <= Date.parse(at)) throw new Refusal('native branch review is expired or stale');
  const authority = await reviewAuthority(branch, input, at);
  for (const key of Object.keys(authority) as (keyof typeof authority)[]) {
    if (branch.review[key] !== authority[key]) throw new Refusal('native branch reviewer, grant, or ACL epoch changed');
  }
}
async function exactDelivery(native: NativeBranchClient, branch: NativeBranchRecord, content: NativeMessage['content'], messageId: string) {
  const messages: NativeMessage[] = [];
  let beforeId: string | undefined;
  for (;;) {
    const page = await native.listMessages(branch.parentSessionId, { beforeId, pageSize: NATIVE_HISTORY_SNAPSHOT_CAP });
    if (page.has_more && page.items.length < NATIVE_HISTORY_SNAPSHOT_CAP) throw new HistoryCap('native delivery history cap exhausted');
    messages.push(...page.items);
    if (!page.has_more) break;
    if (messages.length >= NATIVE_HISTORY_SNAPSHOT_CAP) throw new HistoryCap('native delivery history cap exhausted');
    beforeId = page.items.at(-1)?.id;
  }
  return messages.filter((message) => message.id === messageId
    && message.session_id === branch.parentSessionId && message.role === 'user'
    && JSON.stringify(message.content) === JSON.stringify(content));
}
async function finishUnknown(home: string, intent: NativeBranchRecord, at: string, error: unknown): Promise<NativeBranchRecord> {
  return unknown(home, intent, at, error);
}
export async function rejoinNativeBranch(
  scope: NativeBranchScope, id: string, input: AuthInput, native: NativeBranchClient, options: TimeOptions = {},
): Promise<NativeBranchRecord> {
  enabled();
  return withBranchLock(scope, async (home) => {
    await assertExecutionAllowed(scope.root, scope.project);
    let branch = await readNativeBranch(scope, id);
    await assertCurrentTeam(home, branch);
    if (branch.rejoin?.status === 'rejoined' || branch.rejoin?.status === 'unknown') return branch;
    const at = now(options);
    if (branch.rejoin?.status === 'submitting') return unknown(home, branch, at, 'previous prompt outcome is unknown');
    if (branch.status !== 'active' || !branch.result || !branch.review) throw new Refusal(`native branch is ${branch.status}; no active review`);
    await verifyReview(branch, input, at);
    branch = await refreshLocked(home, branch, native, at);
    if (branch.status !== 'active' || !branch.result || !branch.review) throw new Refusal(`native branch is ${branch.status}; no current review`);
    await assertCurrentTeam(home, branch);
    await verifyReview(branch, input, at);
    const review = branch.review;
    const promptId = `hive-rejoin-${branch.id}-${review.digest.slice(0, 16)}`;
    const prompt = rejoinPrompt(branch, promptId);
    const intent = await commit(home, branch, {
      ...branch,
      rejoin: { status: 'submitting', reviewDigest: review.digest, promptId, promptHash: sha(prompt), intentAt: at },
      updatedAt: at,
    });
    let delivery = intent;
    const finalAt = now(options);
    try {
      await verifyReview(delivery, input, finalAt);
      await assertCurrentTeam(home, delivery);
    } catch (error) {
      await commit(home, intent, branch);
      throw error;
    }
    try {
      const content = [{ type: 'text' as const, text: prompt }];
      const ack = await native.submitPrompt(branch.parentSessionId, { promptId, content });
      if (ack.prompt_id !== promptId || !['queued', 'running', 'blocked'].includes(ack.status)
        || JSON.stringify(ack.content) !== JSON.stringify(content) || !ack.user_message_id) throw new Error('native acknowledgement conflicts with intent');
      delivery = await commit(home, delivery, {
        ...delivery,
        rejoin: { ...delivery.rejoin!, nativeMessageId: ack.user_message_id },
        updatedAt: finalAt,
      });
      const delivered = await exactDelivery(native, delivery, content, ack.user_message_id);
      if (delivered.length !== 1) throw new Error('native acknowledgement message proof is unavailable');
      return await commit(home, delivery, {
        ...delivery,
        status: 'rejoined',
        rejoin: { ...delivery.rejoin!, status: 'rejoined', nativeMessageId: delivered[0].id, rejoinedAt: finalAt },
        updatedAt: finalAt,
      });
    } catch (error) {
      return finishUnknown(home, delivery, finalAt, error);
    }
  });
}
export async function reconcileNativeBranchRejoin(
  scope: NativeBranchScope, id: string, native: NativeBranchClient, options: TimeOptions = {},
): Promise<NativeBranchRecord> {
  enabled();
  return withBranchLock(scope, async (home) => {
    await assertExecutionAllowed(scope.root, scope.project);
    const branch = await readNativeBranch(scope, id);
    await assertCurrentTeam(home, branch);
    if (branch.rejoin?.status === 'rejoined') return branch;
    if (!branch.rejoin || !branch.review || branch.review.digest !== branch.rejoin.reviewDigest) throw new Refusal('native branch has no rejoin intent');
    if (!branch.rejoin.nativeMessageId) return branch;
    const at = now(options);
    try {
      const prompt = rejoinPrompt(branch, branch.rejoin.promptId);
      if (sha(prompt) !== branch.rejoin.promptHash) throw new Error('native rejoin prompt proof changed');
      const delivered = await exactDelivery(native, branch, [{ type: 'text', text: prompt }], branch.rejoin.nativeMessageId);
      if (delivered.length !== 1) return branch;
      return await commit(home, branch, {
        ...branch,
        status: 'rejoined',
        rejoin: { ...branch.rejoin, status: 'rejoined', nativeMessageId: delivered[0].id, rejoinedAt: at },
        updatedAt: at,
      });
    } catch (error) {
      return unknown(home, branch, at, error);
    }
  });
}
