import type { OperatorQuestion, QuestionChoice } from './types.js';

export const DECISION_ACTIONS = ['push', 'pr', 'merge', 'deploy', 'paid_work', 'deletion', 'credentials'] as const;
export type DecisionAction = typeof DECISION_ACTIONS[number];
export type DecisionFacts = {
  action: DecisionAction | 'unknown';
  repository?: string;
  repositoryFingerprint?: string;
  branch?: string;
  commit?: string;
  diffSummary?: string;
  files?: string[];
  destination?: string;
  reason?: string;
  scope?: string;
  budget?: string;
  verifiedAt?: string;
  validUntil?: string;
};
export type DecisionCard = {
  action: DecisionAction | 'unknown';
  facts: DecisionFacts;
  missing: string[];
  consequences: string[];
  overview: string;
  overviewSource: 'deterministic' | 'model';
};
export type DecisionRewriter = (canonical: {
  action: DecisionAction;
  facts: DecisionFacts;
  missing: string[];
  consequences: string[];
}, signal: AbortSignal) => Promise<unknown>;

const STALE_MS = 15 * 60_000;
const FIELD_CAP = 240;
const DIFF_CAP = 2000;
const OVERVIEW_CAP = 280;
const FACT_FIELDS = [
  'action', 'repository', 'repositoryFingerprint', 'branch', 'commit', 'diffSummary', 'files', 'destination',
  'reason', 'scope', 'budget', 'verifiedAt', 'validUntil',
] as const;
const TEXT_FIELDS = [
  'repository', 'repositoryFingerprint', 'branch', 'commit', 'diffSummary', 'destination', 'reason', 'scope', 'budget',
  'verifiedAt', 'validUntil',
] as const;
const ACTION_LABEL: Record<DecisionAction, string> = {
  push: 'push', pr: 'pull request creation', merge: 'merge', deploy: 'deploy',
  paid_work: 'paid work', deletion: 'deletion', credentials: 'credential grant',
};
const APPROVE_LABEL: Record<DecisionAction, string> = {
  push: 'Approve push only', pr: 'Create pull request only', merge: 'Approve merge only',
  deploy: 'Approve deploy only', paid_work: 'Approve paid work only',
  deletion: 'Approve deletion only', credentials: 'Approve credential grant only',
};

const INTERNAL_CONTENT = /structured owner approval|tool result was interrupted|do not duplicate the request|internal handoff|stack trace:?|(?:^|\n)\s*Error(?::|\n)|(?:^|\n)\s*at\s+\S+/i;
const SECURITY_INSTRUCTION = /\b(safe|already approved|choose approve|approve everything|approve now|approval granted|approval is not required|approval not required|no cost|no risk|ignore (?:previous|prior|all|every)|proceed with|allow everything|must approve|should approve)\b/i;

export function containsInternalContent(value: string): boolean {
  return INTERNAL_CONTENT.test(value);
}

export function containsSecurityInstruction(value: string): boolean {
  return SECURITY_INSTRUCTION.test(value);
}

export function cleanAgentText(value: string): string {
  const normalized = value.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '');
  const internal = containsInternalContent(normalized);
  const clean = normalized
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return internal || containsInternalContent(clean) ? 'Internal content removed.' : clean;
}

function cleanText(value: unknown, at: string, max = FIELD_CAP): string {
  if (typeof value !== 'string') throw new Error(`${at}: a string is required`);
  const clean = cleanAgentText(value);
  if (!clean) throw new Error(`${at}: a non-empty string is required`);
  if (clean.length > max) throw new Error(`${at}: ${clean.length} chars exceeds the ${max} cap`);
  return clean;
}

function object(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${at}: an object is required`);
  }
  return value as Record<string, unknown>;
}

function timestamp(value: unknown, at: string): string {
  const text = cleanText(value, at, 40);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw new Error(`${at}: an ISO timestamp is required`);
  return new Date(parsed).toISOString();
}

function parseFacts(raw: unknown, at: string): DecisionFacts & { action: DecisionAction } {
  const input = object(raw, at);
  for (const key of Object.keys(input)) {
    if (!(FACT_FIELDS as readonly string[]).includes(key)) throw new Error(`${at}: unknown field ${key}`);
  }
  if (typeof input.action !== 'string' || !(DECISION_ACTIONS as readonly string[]).includes(input.action)) {
    throw new Error(`${at}.action: one of ${DECISION_ACTIONS.join(', ')} is required`);
  }
  const facts: DecisionFacts & { action: DecisionAction } = { action: input.action as DecisionAction };
  for (const field of TEXT_FIELDS) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new Error(`${at}.${field}: a string is required`);
    const normalized = cleanAgentText(value);
    if (containsSecurityInstruction(normalized)) continue;
    if (['reason', 'scope', 'diffSummary'].includes(field)
      && (normalized === 'Internal content removed.' || containsInternalContent(normalized))) continue;
    const max = field === 'diffSummary' ? DIFF_CAP : FIELD_CAP;
    facts[field] = field === 'verifiedAt' || field === 'validUntil'
      ? timestamp(value, `${at}.${field}`)
      : cleanText(value, `${at}.${field}`, max);
  }
  if (input.files !== undefined) {
    if (!Array.isArray(input.files) || input.files.length > 20) {
      throw new Error(`${at}.files: an array of at most 20 files is required`);
    }
    facts.files = input.files
      .map((file, i) => cleanText(file, `${at}.files[${i}]`, 200))
      .filter((file) => !containsSecurityInstruction(file));
  }
  if (facts.commit !== undefined && !/^[0-9a-f]{40}$/i.test(facts.commit)) {
    throw new Error(`${at}.commit: a full 40-character commit is required`);
  }
  return facts;
}

function requiredFields(action: DecisionAction): string[] {
  const common = ['destination', 'reason', 'verifiedAt', 'validUntil'];
  if (['push', 'pr', 'merge'].includes(action)) {
    return ['repository', 'branch', 'commit', 'diffSummary', ...common];
  }
  if (action === 'paid_work') return [...common, 'scope', 'budget'];
  return [...common, 'scope'];
}

function validity(card: DecisionCard | undefined, now: number): 'incomplete' | 'invalid' | 'expired' | 'stale' | 'current' {
  if (!card || card.action === 'unknown' || card.missing.length) return 'incomplete';
  const verified = Date.parse(card.facts.verifiedAt!);
  const until = Date.parse(card.facts.validUntil!);
  if (!Number.isFinite(verified) || !Number.isFinite(until) || verified > now || until <= verified) return 'invalid';
  if (now >= until) return 'expired';
  if (now - verified > STALE_MS) return 'stale';
  return 'current';
}

export function decisionValidity(question: OperatorQuestion, now = Date.now()): ReturnType<typeof validity> {
  return validity(question.decision, now);
}

export function decisionApprovalAllowed(question: OperatorQuestion, now = Date.now()): boolean {
  return validity(question.decision, now) === 'current';
}

function questionText(card: DecisionCard): string {
  const f = card.facts;
  switch (card.action) {
    case 'push': return `Push one commit to ${f.destination ?? 'the requested destination'}?`;
    case 'pr': return `Create one pull request from ${f.branch ?? 'the requested branch'} to ${f.destination ?? 'the requested destination'}?`;
    case 'merge': return `Merge one commit into ${f.destination ?? 'the requested destination'}?`;
    case 'deploy': return `Deploy the named change to ${f.destination ?? 'the requested destination'}?`;
    case 'paid_work': return `Start the named paid work with a fixed budget?`;
    case 'deletion': return 'Delete the named target?';
    case 'credentials': return 'Grant the named credential access?';
    case 'unknown': return 'More detail is needed before approval.';
  }
}

function consequences(action: DecisionAction): string[] {
  const only = 'This choice approves no other action.';
  switch (action) {
    case 'push': return ['Publish only the named commit to the named destination.', 'This does not create a pull request, merge, deploy, start paid work, delete data, or grant credentials.'];
    case 'pr': return ['Create only the named pull request at the named destination.', 'This does not push another commit, merge, deploy, start paid work, delete data, or grant credentials.'];
    case 'merge': return ['Merge only the named commit into the named destination.', `${only} A separate deploy still needs its own approval.`];
    case 'deploy': return ['Start only the named deploy to the named destination.', 'The live service can change. Paid work, deletion, and credential grants are not included.'];
    case 'paid_work': return ['Start only the named paid work within the stated budget.', 'The work can incur cost. Push, pull request creation, merge, deploy, deletion, and credential grants are not included.'];
    case 'deletion': return ['Delete only the named target.', 'The data can be unrecoverable. No deploy, paid work, or credential grant is included.'];
    case 'credentials': return ['Grant only the named credential access.', 'The grant can expose access. No secret value is shown or approved for disclosure. No other action is included.'];
  }
}

function choice(id: string, label: string, description: string): QuestionChoice {
  return { id, label, description };
}

function choices(card: DecisionCard, now: number): QuestionChoice[] {
  if (card.action === 'unknown' || card.missing.length) {
    const missing = card.missing.length ? ` Missing: ${card.missing.join(', ')}.` : '';
    return [
      choice('c1', 'Send back for details', `Ask for a complete, freshly verified request.${missing}`),
      choice('c2', 'Cancel request', 'Approve nothing and tell the waiting agent not to proceed.'),
    ];
  }
  const result = [choice('c1', 'Refresh facts first', 'Ask for current diff and status. Nothing changes.')];
  if (validity(card, now) === 'current') {
    result.push(choice('c2', APPROVE_LABEL[card.action], consequences(card.action)[0]));
  }
  result.push(choice(result.length === 2 ? 'c3' : 'c2', 'Cancel request', 'Approve nothing and tell the waiting agent not to proceed.'));
  return result;
}

function destinationFor(facts: DecisionFacts): string | undefined {
  if (['push', 'pr', 'merge', 'deploy'].includes(facts.action)) return facts.destination;
  if (facts.action === 'paid_work') return 'the named paid-work provider';
  if (facts.action === 'deletion') return 'the named deletion target';
  if (facts.action === 'credentials') return 'the named credential audience';
  return undefined;
}

export function buildDecision(raw: unknown, at: string, now = Date.now()): Omit<OperatorQuestion, 'id' | 'priority'> {
  const facts = parseFacts(raw, at);
  const destination = destinationFor(facts);
  if (destination === undefined) delete facts.destination;
  else facts.destination = destination;
  const missing = requiredFields(facts.action).filter((field) => facts[field as keyof DecisionFacts] === undefined);
  const card: DecisionCard = {
    action: facts.action, facts, missing, consequences: consequences(facts.action),
    overview: `Review one ${ACTION_LABEL[facts.action]} request. No action happens automatically.`,
    overviewSource: 'deterministic',
  };
  return {
    question: questionText(card), context: 'Review the verified facts, validity, and exact consequences before you choose.',
    choices: choices(card, now), recommended: 'c1', decision: card,
  };
}

export function isInternalHandoff(raw: Record<string, unknown>): boolean {
  const combined = `${String(raw.question ?? '')}\n${String(raw.context ?? '')}\n${JSON.stringify(raw.choices ?? '')}`;
  const text = cleanAgentText(combined);
  if (text === 'Internal content removed.') return true;
  const action = /\b(push|pull request|pr|merge|deploy|paid work|spend|delete|deletion|credential|secret|token|grant)\b/i;
  const approval = /\b(approve|approval|authorize|permission|allow|may i|can i|should i|proceed|go ahead|yes)\b/i;
  return containsSecurityInstruction(text) || (action.test(text) && approval.test(text));
}

export function buildHandoffFallback(): Omit<OperatorQuestion, 'id' | 'priority'> {
  const card: DecisionCard = {
    action: 'unknown', facts: { action: 'unknown' }, missing: [], consequences: [],
    overview: 'An internal handoff is not an approval request. Ask for one action and verified facts.',
    overviewSource: 'deterministic',
  };
  return {
    question: questionText(card), context: 'No raw tool result or agent instruction is used as the question.',
    choices: choices(card, Date.now()), recommended: 'c1', decision: card,
  };
}

export function ageLabel(question: OperatorQuestion, now = Date.now()): string {
  const at = question.decision?.facts.verifiedAt;
  const parsed = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(parsed)) return 'unknown age';
  const minutes = Math.max(0, Math.floor((now - parsed) / 60_000));
  if (minutes < 1) return 'less than a minute old';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} old`;
  return `${Math.floor(hours / 24)} days old`;
}

export async function applyDecisionRewrite(
  questions: OperatorQuestion[], rewrite?: DecisionRewriter, timeoutMs = 1500,
): Promise<OperatorQuestion[]> {
  if (!rewrite) return questions;
  return Promise.all(questions.map(async (question): Promise<OperatorQuestion> => {
    const card = question.decision;
    if (!card || card.action === 'unknown') return question;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      const canonical = structuredClone({
        action: card.action, facts: card.facts, missing: card.missing, consequences: card.consequences,
      });
      const result = await Promise.race([
        rewrite(canonical, controller.signal),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('rewrite timed out'));
          }, timeoutMs);
        }),
      ]);
      const output = object(result, 'rewrite');
      if (Object.keys(output).length !== 1 || typeof output.overview !== 'string') return question;
      const overview = output.overview.trim();
      const unsafe = /[\u0000-\u001f\u007f\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/;
      const securityClaim = /\b(approve|approved|approval|safe|no cost|no risk|free|ignore|proceed|deploy|merge|delete|credentials?|grant|execute|permission|required|must|should)\b/i;
      if (!overview || overview.length > OVERVIEW_CAP || unsafe.test(overview) || securityClaim.test(overview) || containsInternalContent(overview)) return question;
      return question;
    } catch {
      return question;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }));
}
