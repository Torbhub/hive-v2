import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import type { DecisionAnswer, OperatorQuestion, QuestionAnswer, QuestionBatch } from './types.js';
import { Refusal, appendDecision, hubPath, readJson, withHubLock, writeJson } from './state.js';
import {
  applyDecisionRewrite, buildDecision, buildHandoffFallback, cleanAgentText, containsSecurityInstruction,
  decisionApprovalAllowed, decisionValidity, isInternalHandoff, type DecisionRewriter,
} from './decisions.js';
import { decisionFingerprint, repositoryFingerprint, verifyDecisionFacts, verifyExecutionRepository } from './decision-verification.js';
import { credentialFromEnvironment } from './collaboration-credentials.js';
import { storedAgentTask } from './agent-target.js';
import { registryFromEnv } from './registry.js';
import { authenticateBearer, authorizeExact, exactGrant } from './security.js';

export const QUESTION_LIMITS = {
  questions: 20, choices: 8, context: 4000, question: 1000,
  label: 200, description: 2000, other: 4000,
} as const;

function text(value: unknown, at: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Refusal(`${at}: a non-empty string is required`);
  if (value.length > max) throw new Refusal(`${at}: ${value.length} chars exceeds the ${max} cap`);
  return value;
}

function agentContext(value: unknown, at: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Refusal(`${at}: a non-empty string is required`);
  if (value.length > max) throw new Refusal(`${at}: ${value.length} chars exceeds the ${max} cap`);
  const clean = cleanAgentText(value);
  if (clean === 'Internal content removed.') return clean;
  return containsSecurityInstruction(clean) ? 'Agent context removed.' : value;
}

function exactKeys(value: unknown, keys: string[], at: string, optional: string[] = []): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Refusal(`${at}: an object is required`);
  }
  const obj = value as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!keys.includes(k) && !optional.includes(k)) throw new Refusal(`${at}: unknown field ${k}`);
  }
  for (const k of keys) {
    if (!(k in obj)) throw new Refusal(`${at}: missing field ${k}`);
  }
  return obj;
}

export function validateBatchInput(raw: unknown, now = Date.now()): { context: string; questions: OperatorQuestion[] } {
  const input = exactKeys(raw, ['context', 'questions'], 'batch');
  const context = agentContext(input.context, 'batch.context', QUESTION_LIMITS.context);
  if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > QUESTION_LIMITS.questions) {
    throw new Refusal(`batch.questions: an array of 1..${QUESTION_LIMITS.questions} questions is required`);
  }
  const questions = input.questions.map((q, i): OperatorQuestion => {
    const at = `questions[${i}]`;
    const obj = exactKeys(q, ['priority'], at, ['question', 'context', 'choices', 'recommended', 'decision']);
    if (!Number.isInteger(obj.priority) || (obj.priority as number) < 1) {
      throw new Refusal(`${at}.priority: an integer >= 1 is required (1 decides first)`);
    }
    const common = { id: `q${i + 1}`, priority: obj.priority as number };
    if (obj.decision !== undefined) {
      return { ...common, ...buildDecision(obj.decision, `${at}.decision`, now) };
    }
    if (isInternalHandoff(obj)) {
      return { ...common, ...buildHandoffFallback() };
    }
    const general = exactKeys(q, ['question', 'context', 'priority', 'choices', 'recommended'], at, ['decision']);
    if (!Array.isArray(general.choices) || general.choices.length < 2 || general.choices.length > QUESTION_LIMITS.choices) {
      throw new Refusal(`${at}.choices: an array of 2..${QUESTION_LIMITS.choices} choices is required`);
    }
    const choices = general.choices.map((c, j) => {
      const co = exactKeys(c, ['label', 'description'], `${at}.choices[${j}]`);
      return {
        id: `c${j + 1}`,
        label: text(co.label, `${at}.choices[${j}].label`, QUESTION_LIMITS.label),
        description: text(co.description, `${at}.choices[${j}].description`, QUESTION_LIMITS.description),
      };
    });
    const recommended = text(general.recommended, `${at}.recommended`, 10);
    if (!choices.some((c) => c.id === recommended)) {
      throw new Refusal(`${at}.recommended: must be one of ${choices.map((c) => c.id).join(', ')} (c1 is the first choice)`);
    }
    return {
      ...common,
      question: text(general.question, `${at}.question`, QUESTION_LIMITS.question),
      context: text(general.context, `${at}.context`, QUESTION_LIMITS.context),
      choices,
      recommended,
    };
  });
  return { context, questions };
}

export type ApprovalAuthorization = {
  task?: string;
  consumerGrantId?: string;
  consumerAclEpoch?: number;
  approverSubject?: string;
  approverGrantId?: string;
  approverAclEpoch?: number;
};

function withDecisionAnswer(batch: QuestionBatch, question: OperatorQuestion, answer: QuestionAnswer,
  authorization?: ApprovalAuthorization): QuestionAnswer {
  const card = question.decision;
  if (!card) return answer;
  let outcome: DecisionAnswer['outcome'];
  if (answer.choice === 'other') outcome = 'other';
  else if (answer.choice === 'c1') outcome = card.action === 'unknown' || card.missing.length ? 'details' : 'refresh';
  else if (answer.choice === 'c2' && question.choices.length === 3) outcome = 'approve';
  else outcome = 'cancel';
  if (outcome === 'approve' && card.action === 'push' && authorization
    && !authorization.approverSubject?.startsWith('user:')) {
    throw new Refusal('execution approvals require a human approver');
  }
  const facts = structuredClone(card.facts);
  const grant = outcome === 'approve' ? {
    batch: batch.id, question: question.id, project: batch.project,
    fingerprint: decisionFingerprint(facts), expiresAt: facts.validUntil!,
    executionAuthority: card.action === 'push' ? 'push' as const : 'none' as const,
    agent: batch.agent, task: authorization?.task,
    grantId: authorization?.consumerGrantId, profileAclEpoch: authorization?.consumerAclEpoch,
    approverSubject: authorization?.approverSubject,
    approverGrantId: authorization?.approverGrantId,
    approverAclEpoch: authorization?.approverAclEpoch,
  } : undefined;
  return { ...answer, decision: { action: card.action, outcome, facts, grant } };
}

export function validateAnswers(batch: QuestionBatch, raw: unknown, now = Date.now(),
  authorization?: ApprovalAuthorization): QuestionAnswer[] {
  if (!Array.isArray(raw)) throw new Refusal('answers: an array with one answer per question is required');
  const seen = new Set<string>();
  const answers = raw.map((a, i): QuestionAnswer => {
    const obj = exactKeys(a, ['question', 'choice'], `answers[${i}]`, ['text']);
    const qid = text(obj.question, `answers[${i}].question`, 20);
    const q = batch.questions.find((x) => x.id === qid);
    if (!q) throw new Refusal(`answers[${i}].question: unknown question ${qid}`);
    if (seen.has(qid)) throw new Refusal(`answers[${i}].question: ${qid} is answered twice`);
    seen.add(qid);
    const choice = text(obj.choice, `answers[${i}].choice`, 20);
    if (choice === 'other') {
      return withDecisionAnswer(
        batch, q,
        { question: qid, choice, text: text(obj.text, `answers[${i}].text (other)`, QUESTION_LIMITS.other) },
        authorization,
      );
    }
    if (!q.choices.some((c) => c.id === choice)) {
      throw new Refusal(`answers[${i}].choice: ${qid} offers ${q.choices.map((c) => c.id).join(', ')} or other`);
    }
    if (q.decision && q.choices.length === 3 && choice === 'c2' && !decisionApprovalAllowed(q, now)) {
      throw new Refusal(`${qid}: ${decisionValidity(q, now)} approval is not allowed; refresh facts first`);
    }
    if (obj.text !== undefined) throw new Refusal(`answers[${i}].text: only an other answer carries text`);
    return withDecisionAnswer(batch, q, { question: qid, choice }, authorization);
  });
  const missing = batch.questions.filter((q) => !seen.has(q.id)).map((q) => q.id);
  if (missing.length) throw new Refusal(`answers: no answer for ${missing.join(', ')}`);
  return answers;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const OPEN_BATCH_CAP = 200;

function checkId(id: string): void {
  if (!UUID_RE.test(id)) {
    throw new Refusal(`a batch id is the uuid the tool returned: ${id}`);
  }
}

function batchPath(root: string, id: string, closed = false): string {
  checkId(id);
  return hubPath(root, 'questions', ...(closed ? ['closed'] : []), `${id}.json`);
}

// Operator decisions are sensitive: restrictive file and directory modes.
async function writeBatch(root: string, id: string, batch: QuestionBatch): Promise<void> {
  await fs.mkdir(hubPath(root, 'questions'), { recursive: true, mode: 0o700 });
  await writeJson(batchPath(root, id), batch, 0o600);
}

export async function createQuestionBatch(
  root: string, meta: { project: string; agent: string }, raw: unknown,
  opts: { rewrite?: DecisionRewriter; rewriteTimeoutMs?: number } = {},
): Promise<QuestionBatch> {
  const now = Date.now();
  const { context, questions } = validateBatchInput(raw, now);
  const verified = await Promise.all(questions.map(async (question): Promise<OperatorQuestion> => {
    const card = question.decision;
    if (!card || card.action === 'unknown') return question;
    const requested = { ...card.facts, action: card.action };
    try {
      const facts = await verifyDecisionFacts(root, meta, requested, now);
      return { id: question.id, priority: question.priority, ...buildDecision(facts, 'verified decision', now) };
    } catch {
      const safe = { action: card.action, reason: card.facts.reason, scope: card.facts.scope, budget: card.facts.budget };
      return { id: question.id, priority: question.priority, ...buildDecision(safe, 'unverified decision', now) };
    }
  }));
  const presented = await applyDecisionRewrite(verified, opts.rewrite, opts.rewriteTimeoutMs);
  const batch: QuestionBatch = {
    id: randomUUID(), project: meta.project, agent: meta.agent,
    context, questions: presented, status: 'open', createdAt: new Date(now).toISOString(),
    waitHeartbeatAt: new Date(now).toISOString(),
  };
  await withHubLock(root, async () => {
    const open = await listOpenQuestionBatches(root);
    if (open.length >= OPEN_BATCH_CAP) {
      throw new Refusal(`${OPEN_BATCH_CAP} batches are already open; the operator must clear the Questions screen first`);
    }
    await writeBatch(root, batch.id, batch);
  });
  return batch;
}

export async function heartbeatQuestionBatch(root: string, id: string): Promise<void> {
  await withHubLock(root, async () => {
    const batch = await readQuestionBatch(root, id);
    if (batch.status !== 'open') return;
    await writeBatch(root, id, { ...batch, waitHeartbeatAt: new Date().toISOString() });
  });
}

function hasConsumedGrant(batch: QuestionBatch): boolean {
  return Boolean(batch.answers?.some((answer) => answer.decision?.grant?.consumedAt));
}

export async function readQuestionBatch(root: string, id: string): Promise<QuestionBatch> {
  const open = await readJson<QuestionBatch>(batchPath(root, id));
  const closed = await readJson<QuestionBatch>(batchPath(root, id, true));
  if (open && open.status !== 'open' && closed) {
    if (JSON.stringify(open) !== JSON.stringify(closed)) throw new Refusal(`duplicate terminal question batch ${id}`);
    await fs.rm(batchPath(root, id), { force: true });
    return closed;
  }
  if (open?.status !== 'open' && open) {
    await fs.mkdir(hubPath(root, 'questions', 'closed'), { recursive: true, mode: 0o700 });
    try {
      await fs.rename(batchPath(root, id), batchPath(root, id, true));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const moved = await readJson<QuestionBatch>(batchPath(root, id, true));
      if (!moved) throw e;
      if (JSON.stringify(open) !== JSON.stringify(moved)) throw new Refusal(`duplicate terminal question batch ${id}`);
      return moved;
    }
    return open;
  }
  const batch = open ?? closed;
  if (!batch) throw new Refusal(`no question batch ${id}`);
  return batch;
}

async function authorizePushConsumption(root: string, batch: QuestionBatch,
  grant: {
    agent?: string; task?: string; grantId?: string; profileAclEpoch?: number;
    approverSubject?: string; approverGrantId?: string; approverAclEpoch?: number;
  }, env: NodeJS.ProcessEnv): Promise<void> {
  if (env.HIVE_COLLABORATION_ENABLED !== '1') return;
  const credential = await credentialFromEnvironment(env);
  if (!credential) throw new Refusal('consuming agent credential required');
  const registry = registryFromEnv(env);
  const principal = await authenticateBearer(credential, registry, env);
  if (principal.kind !== 'agent' || !principal.agentId) throw new Refusal('consuming agent required');
  const agentRef = env.HIVE_AGENT_REF ?? principal.agentId;
  if (agentRef.split('@')[0] !== principal.agentId || batch.agent !== agentRef || grant.agent !== batch.agent) {
    throw new Refusal('approval agent does not match');
  }
  const task = await storedAgentTask(root, batch.project, agentRef);
  if (grant.task !== task) throw new Refusal('approval task does not match');
  const current = await authorizeExact(principal, registry, 'execute', { project: batch.project, task });
  if (grant.grantId !== current.grantId) throw new Refusal('execute grant identity does not match');
  const profile = await registry.get(`AGENT#${principal.agentId}`, 'PROFILE');
  if (!profile || Number(profile.aclEpoch) !== grant.profileAclEpoch) {
    throw new Refusal('agent profile ACL epoch is stale');
  }
  if (!grant.approverSubject) throw new Refusal('approver identity is required');
  if (!grant.approverSubject.startsWith('user:')) {
    throw new Refusal('execution approvals require a human approver');
  }
  const approver = await exactGrant(registry, batch.project, grant.approverSubject, task);
  if (!approver || approver.grantId !== grant.approverGrantId
    || Number(approver.aclEpoch) !== grant.approverAclEpoch) {
    throw new Refusal('approver authorization changed');
  }
  const account = await registry.delegatedApprovalAccount(principal.agentId, credential, {
    project: batch.project, task, consumerGrantId: grant.grantId ?? '',
    approverSubject: grant.approverSubject, approverGrantId: grant.approverGrantId ?? '',
  });
  if (!account || account.accountStatus !== 'active') {
    throw new Refusal('approver account is not active');
  }
}

export async function consumePushApproval(
  root: string,
  reference: { project: string; batch: string; question: string },
  remote: string,
  sha: string,
  branch: string,
  cwd: string,
  now = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return withHubLock(root, async () => {
    const [open, closed] = await Promise.all([
      readJson<QuestionBatch>(batchPath(root, reference.batch)),
      readJson<QuestionBatch>(batchPath(root, reference.batch, true)),
    ]);
    if ((open && hasConsumedGrant(open)) || (closed && hasConsumedGrant(closed))) {
      throw new Refusal('approval is already consumed');
    }
    const batch = await readQuestionBatch(root, reference.batch);
    const answer = batch.answers?.find((entry) => entry.question === reference.question);
    const decision = answer?.decision;
    const grant = decision?.grant;
    if (batch.status !== 'answered' || batch.project !== reference.project) throw new Refusal('approval project does not match');
    if (!answer || !decision || !grant || decision.action !== 'push' || decision.outcome !== 'approve') {
      throw new Refusal('a push approval is required');
    }
    if (grant.batch !== batch.id || grant.question !== answer.question || grant.project !== reference.project) {
      throw new Refusal('approval identity does not match');
    }
    if (grant.executionAuthority !== 'push') throw new Refusal('approval has no push execution authority');
    if (grant.consumedAt) throw new Refusal('approval is already consumed');
    const expiresAt = Date.parse(grant.expiresAt);
    if (!Number.isFinite(expiresAt) || now >= expiresAt) throw new Refusal('approval is expired');
    await authorizePushConsumption(root, batch, grant, env);
    const fresh = await verifyDecisionFacts(root, { project: batch.project, agent: batch.agent }, {
      ...decision.facts, action: 'push',
    }, now);
    const canonical = buildDecision(fresh, 'consume approval', now).decision!;
    if (decisionFingerprint(canonical.facts) !== grant.fingerprint) throw new Refusal('verified facts changed after approval');
    const executionUrl = await verifyExecutionRepository(root, { project: batch.project, agent: batch.agent }, cwd);
    if (repositoryFingerprint(executionUrl) !== fresh.repositoryFingerprint) throw new Refusal('push origin does not match the approved repository');
    if (remote !== 'origin' || sha !== fresh.commit || branch !== fresh.branch || fresh.destination !== `origin/${branch}`) {
      throw new Refusal('push arguments do not match the approved commit and branch');
    }
    grant.consumedAt = new Date(now).toISOString();
    await writeJson(batchPath(root, batch.id, true), batch, 0o600);
    return executionUrl;
  });
}

export async function listOpenQuestionBatches(root: string): Promise<QuestionBatch[]> {
  const dir = hubPath(root, 'questions');
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((e) => {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [] as Dirent[];
    throw e;
  });
  const batches: QuestionBatch[] = [];
  for (const entry of entries) {
    // Only regular files with a uuid name: no symlinks, dirs, or temp files.
    if (!entry.isFile() || !UUID_RE.test(entry.name.replace(/\.json$/, '')) || !entry.name.endsWith('.json')) continue;
    const batch = await readJson<QuestionBatch>(hubPath(root, 'questions', entry.name));
    if (batch?.status === 'open') batches.push(batch);
  }
  return batches.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function closeBatchLocked(
  root: string, id: string, status: 'answered' | 'cancelled', rawAnswers?: unknown, audit?: string,
  authorization?: ApprovalAuthorization,
): Promise<QuestionBatch> {
  const batch = await readQuestionBatch(root, id);
  if (batch.status !== 'open') throw new Refusal(`question batch ${id} is already ${batch.status}`);
  const answers = status === 'answered' ? validateAnswers(batch, rawAnswers, Date.now(), authorization) : undefined;
  const closed: QuestionBatch = { ...batch, status, answers, closedAt: new Date().toISOString() };
  // The terminal state lands at the open path first. A crash before the
  // move still leaves a terminal file: the listing filters it out and the
  // waiter reads it, so no answer is ever shadowed by a stale open copy.
  await writeBatch(root, id, closed);
  await fs.mkdir(hubPath(root, 'questions', 'closed'), { recursive: true, mode: 0o700 });
  await fs.rename(batchPath(root, id), batchPath(root, id, true));
  try {
    await appendDecision(root, {
      project: batch.project, by: 'owner',
      summary: audit ?? `${status} question batch ${id} from ${batch.agent} (${batch.questions.length} questions)`,
    });
  } catch (e) {
    // The close is already committed; an audit gap must not read as a
    // failed answer to the operator.
    console.error(`hive: question batch ${id} closed but its audit append failed:`, e);
  }
  return closed;
}

async function closeBatch(
  root: string, id: string, status: 'answered' | 'cancelled', rawAnswers?: unknown,
  authorization?: ApprovalAuthorization,
): Promise<QuestionBatch> {
  return withHubLock(root, () => closeBatchLocked(root, id, status, rawAnswers, undefined, authorization));
}

export function answerQuestionBatch(root: string, id: string, answers: unknown,
  authorization?: ApprovalAuthorization): Promise<QuestionBatch> {
  return closeBatch(root, id, 'answered', answers, authorization);
}

export function cancelQuestionBatch(root: string, id: string): Promise<QuestionBatch> {
  return closeBatch(root, id, 'cancelled');
}

export const OPEN_BATCH_TTL_MS = 7 * 24 * 60 * 60_000;
export const CLOSED_BATCH_CAP = 200;
export const VIEW_BATCH_CAP = 50;

// Lazy expiry and retention, driven by the hub view: an open batch older
// than the wait limit is abandoned, so it cancels with an audit note.
// Closed history is capped so the archive never grows without bound.
export async function sweepQuestionBatches(root: string, now = Date.now()): Promise<void> {
  // Nothing on disk means nothing to expire or prune, and no writes at all.
  const present = await fs.stat(hubPath(root, 'questions')).catch(() => null);
  if (!present?.isDirectory()) return;
  await withHubLock(root, async () => {
    for (const batch of await listOpenQuestionBatches(root)) {
      if (now - Date.parse(batch.createdAt) > OPEN_BATCH_TTL_MS) {
        await closeBatchLocked(root, batch.id, 'cancelled', undefined,
          `expired question batch ${batch.id} from ${batch.agent} (open over 7 days without an answer)`);
      }
    }
    const dir = hubPath(root, 'questions', 'closed');
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((e) => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [] as Dirent[];
      throw e;
    });
    const files = entries.filter((e) => e.isFile() && UUID_RE.test(e.name.replace(/\.json$/, '')) && e.name.endsWith('.json'));
    if (files.length <= CLOSED_BATCH_CAP) return;
    const ages = await Promise.all(files.map(async (f) => ({
      name: f.name, mtime: (await fs.stat(hubPath(root, 'questions', 'closed', f.name))).mtimeMs,
    })));
    ages.sort((a, b) => a.mtime - b.mtime);
    for (const old of ages.slice(0, ages.length - CLOSED_BATCH_CAP)) {
      await fs.rm(hubPath(root, 'questions', 'closed', old.name), { force: true });
    }
  });
}
