import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import type { OperatorQuestion, QuestionAnswer, QuestionBatch } from './types.js';
import { Refusal, appendDecision, hubPath, readJson, withHubLock, writeJson } from './state.js';

export const QUESTION_LIMITS = {
  questions: 20, choices: 8, context: 4000, question: 1000,
  label: 200, description: 2000, other: 4000,
} as const;

function text(value: unknown, at: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Refusal(`${at}: a non-empty string is required`);
  if (value.length > max) throw new Refusal(`${at}: ${value.length} chars exceeds the ${max} cap`);
  return value;
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

// The agent-facing contract is deliberately rigid: a batch the operator can
// skim has no optional context, no choice without a description, and exactly
// one recommendation per question.
export function validateBatchInput(raw: unknown): { context: string; questions: OperatorQuestion[] } {
  const input = exactKeys(raw, ['context', 'questions'], 'batch');
  const context = text(input.context, 'batch.context', QUESTION_LIMITS.context);
  if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > QUESTION_LIMITS.questions) {
    throw new Refusal(`batch.questions: an array of 1..${QUESTION_LIMITS.questions} questions is required`);
  }
  const questions = input.questions.map((q, i) => {
    const at = `questions[${i}]`;
    const obj = exactKeys(q, ['question', 'context', 'priority', 'choices', 'recommended'], at);
    if (!Number.isInteger(obj.priority) || (obj.priority as number) < 1) {
      throw new Refusal(`${at}.priority: an integer >= 1 is required (1 decides first)`);
    }
    if (!Array.isArray(obj.choices) || obj.choices.length < 2 || obj.choices.length > QUESTION_LIMITS.choices) {
      throw new Refusal(`${at}.choices: an array of 2..${QUESTION_LIMITS.choices} choices is required`);
    }
    const choices = obj.choices.map((c, j) => {
      const co = exactKeys(c, ['label', 'description'], `${at}.choices[${j}]`);
      return {
        id: `c${j + 1}`,
        label: text(co.label, `${at}.choices[${j}].label`, QUESTION_LIMITS.label),
        description: text(co.description, `${at}.choices[${j}].description`, QUESTION_LIMITS.description),
      };
    });
    const recommended = text(obj.recommended, `${at}.recommended`, 10);
    if (!choices.some((c) => c.id === recommended)) {
      throw new Refusal(`${at}.recommended: must be one of ${choices.map((c) => c.id).join(', ')} (c1 is the first choice)`);
    }
    return {
      id: `q${i + 1}`,
      question: text(obj.question, `${at}.question`, QUESTION_LIMITS.question),
      context: text(obj.context, `${at}.context`, QUESTION_LIMITS.context),
      priority: obj.priority as number,
      choices,
      recommended,
    };
  });
  return { context, questions };
}

export function validateAnswers(batch: QuestionBatch, raw: unknown): QuestionAnswer[] {
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
      return { question: qid, choice, text: text(obj.text, `answers[${i}].text (other)`, QUESTION_LIMITS.other) };
    }
    if (!q.choices.some((c) => c.id === choice)) {
      throw new Refusal(`answers[${i}].choice: ${qid} offers ${q.choices.map((c) => c.id).join(', ')} or other`);
    }
    if (obj.text !== undefined) throw new Refusal(`answers[${i}].text: only an other answer carries text`);
    return { question: qid, choice };
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
): Promise<QuestionBatch> {
  const { context, questions } = validateBatchInput(raw);
  const batch: QuestionBatch = {
    id: randomUUID(), project: meta.project, agent: meta.agent,
    context, questions, status: 'open', createdAt: new Date().toISOString(),
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

export async function readQuestionBatch(root: string, id: string): Promise<QuestionBatch> {
  const batch = await readJson<QuestionBatch>(batchPath(root, id))
    ?? await readJson<QuestionBatch>(batchPath(root, id, true));
  if (!batch) throw new Refusal(`no question batch ${id}`);
  return batch;
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

async function closeBatch(
  root: string, id: string, status: 'answered' | 'cancelled', rawAnswers?: unknown,
): Promise<QuestionBatch> {
  return withHubLock(root, async () => {
    const batch = await readQuestionBatch(root, id);
    if (batch.status !== 'open') throw new Refusal(`question batch ${id} is already ${batch.status}`);
    const answers = status === 'answered' ? validateAnswers(batch, rawAnswers) : undefined;
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
        summary: `${status} question batch ${id} from ${batch.agent} (${batch.questions.length} questions)`,
      });
    } catch (e) {
      // The close is already committed; an audit gap must not read as a
      // failed answer to the operator.
      console.error(`hive: question batch ${id} closed but its audit append failed:`, e);
    }
    return closed;
  });
}

export function answerQuestionBatch(root: string, id: string, answers: unknown): Promise<QuestionBatch> {
  return closeBatch(root, id, 'answered', answers);
}

export function cancelQuestionBatch(root: string, id: string): Promise<QuestionBatch> {
  return closeBatch(root, id, 'cancelled');
}
