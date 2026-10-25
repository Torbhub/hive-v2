import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  OPEN_BATCH_CAP, answerQuestionBatch, cancelQuestionBatch, createQuestionBatch,
  listOpenQuestionBatches, readQuestionBatch, validateAnswers, validateBatchInput,
} from '../src/questions.js';
import { hubPath, writeJson } from '../src/state.js';

const meta = { project: 'demo', agent: 'demo-orchestrator' };

function input(): unknown {
  return {
    context: 'We are choosing a database for the hub.',
    questions: [
      {
        question: 'Which store do we use?', context: 'The current JSON files do not scale.',
        priority: 1, recommended: 'c2',
        choices: [
          { label: 'SQLite', description: 'Local file, no server, easy backup.' },
          { label: 'Postgres', description: 'Real server, more operations work.' },
        ],
      },
      {
        question: 'When do we migrate?', context: 'Migration means a short write pause.',
        priority: 2, recommended: 'c1',
        choices: [
          { label: 'Tonight', description: 'Low traffic, operator is around.' },
          { label: 'Weekend', description: 'Slower response if it breaks.' },
        ],
      },
    ],
  };
}

async function root(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'hive-questions-'));
}

describe('validateBatchInput', () => {
  it('assigns question and choice ids and keeps the fields', () => {
    const v = validateBatchInput(input());
    expect(v.questions.map((q) => q.id)).toEqual(['q1', 'q2']);
    expect(v.questions[0].choices.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(v.questions[0].recommended).toBe('c2');
  });

  it('rejects a missing or blank overarching context', () => {
    expect(() => validateBatchInput({ questions: [] })).toThrow(/missing field context/);
    const bad = input() as { context: string };
    bad.context = '  ';
    expect(() => validateBatchInput(bad)).toThrow(/batch.context/);
  });

  it('rejects unknown fields at every level', () => {
    const bad = input() as Record<string, unknown>;
    bad.extra = 1;
    expect(() => validateBatchInput(bad)).toThrow(/batch: unknown field extra/);
    const q = (input() as { questions: Record<string, unknown>[] });
    q.questions[0].other = true;
    expect(() => validateBatchInput(q)).toThrow(/questions\[0\]: unknown field other/);
    const c = input() as { questions: { choices: Record<string, unknown>[] }[] };
    c.questions[0].choices[0].id = 'custom';
    expect(() => validateBatchInput(c)).toThrow(/unknown field id/);
  });

  it('rejects bad counts, types, and caps', () => {
    expect(() => validateBatchInput({ context: 'x', questions: [] })).toThrow(/1\.\.20/);
    expect(() => validateBatchInput({ context: 'x', questions: 'many' })).toThrow(/1\.\.20/);
    const one = input() as { questions: { choices: unknown[] }[] };
    one.questions[0].choices = one.questions[0].choices.slice(0, 1);
    expect(() => validateBatchInput(one)).toThrow(/2\.\.8/);
    const pri = input() as { questions: { priority: unknown }[] };
    pri.questions[0].priority = 0;
    expect(() => validateBatchInput(pri)).toThrow(/priority/);
    pri.questions[0].priority = 1.5;
    expect(() => validateBatchInput(pri)).toThrow(/priority/);
    const long = input() as { context: string };
    long.context = 'x'.repeat(4001);
    expect(() => validateBatchInput(long)).toThrow(/4000 cap/);
    const noDesc = input() as { questions: { choices: { description: string }[] }[] };
    noDesc.questions[0].choices[0].description = '';
    expect(() => validateBatchInput(noDesc)).toThrow(/description/);
  });

  it('rejects a recommendation that names no choice', () => {
    const bad = input() as { questions: { recommended: string }[] };
    bad.questions[0].recommended = 'c9';
    expect(() => validateBatchInput(bad)).toThrow(/recommended: must be one of c1, c2/);
  });
});

describe('storage and transitions', () => {
  it('creates, lists open only, and answers with an owner audit', async () => {
    const r = await root();
    const batch = await createQuestionBatch(r, meta, input());
    expect(batch.status).toBe('open');
    expect((await listOpenQuestionBatches(r)).map((b) => b.id)).toEqual([batch.id]);

    const closed = await answerQuestionBatch(r, batch.id, [
      { question: 'q1', choice: 'c2' },
      { question: 'q2', choice: 'other', text: 'Next week instead' },
    ]);
    expect(closed.status).toBe('answered');
    expect(closed.answers).toHaveLength(2);
    expect(await listOpenQuestionBatches(r)).toEqual([]);
    const stored = await readQuestionBatch(r, batch.id);
    expect(stored.answers?.[1].text).toBe('Next week instead');
    expect(existsSync(hubPath(r, 'questions', `${batch.id}.json`))).toBe(false);
    expect(existsSync(hubPath(r, 'questions', 'closed', `${batch.id}.json`))).toBe(true);
    const audit = await readFile(hubPath(r, 'decisions.jsonl'), 'utf8');
    expect(audit).toContain(`answered question batch ${batch.id}`);
    expect(audit).toContain('"by":"owner"');
    await expect(answerQuestionBatch(r, batch.id, [])).rejects.toThrow(/already answered/);
  });

  it('cancels an open batch and refuses a second terminal transition', async () => {
    const r = await root();
    const batch = await createQuestionBatch(r, meta, input());
    await cancelQuestionBatch(r, batch.id);
    expect((await readQuestionBatch(r, batch.id)).status).toBe('cancelled');
    await expect(cancelQuestionBatch(r, batch.id)).rejects.toThrow(/already cancelled/);
    await expect(listOpenQuestionBatches(r)).resolves.toEqual([]);
  });

  it('allows exactly one terminal transition under racing calls', async () => {
    const r = await root();
    const batch = await createQuestionBatch(r, meta, input());
    const answers = [
      { question: 'q1', choice: 'c1' }, { question: 'q2', choice: 'c1' },
    ];
    const results = await Promise.allSettled([
      answerQuestionBatch(r, batch.id, answers),
      cancelQuestionBatch(r, batch.id),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((x) => x.status === 'rejected')).toHaveLength(1);
  });

  it('refuses traversal-shaped and unknown ids', async () => {
    const r = await root();
    await expect(readQuestionBatch(r, '../tasks')).rejects.toThrow(/batch id/);
    await expect(readQuestionBatch(r, crypto.randomUUID())).rejects.toThrow(/no question batch/);
  });

  it('writes batch files with owner-only modes', async () => {
    const r = await root();
    const batch = await createQuestionBatch(r, meta, input());
    const st = await stat(hubPath(r, 'questions', `${batch.id}.json`));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('open listing skips non-uuid names and symlinks', async () => {
    const r = await root();
    const batch = await createQuestionBatch(r, meta, input());
    await writeJson(hubPath(r, 'questions', 'notes.json'), { status: 'open' });
    const external = hubPath(r, 'external.json');
    await writeJson(external, { status: 'open' });
    await symlink(external, hubPath(r, 'questions', `${randomUUID()}.json`));
    expect((await listOpenQuestionBatches(r)).map((b) => b.id)).toEqual([batch.id]);
  });

  it('refuses to create beyond the open cap', async () => {
    const r = await root();
    for (let i = 0; i < OPEN_BATCH_CAP; i++) {
      const id = randomUUID();
      await writeJson(hubPath(r, 'questions', `${id}.json`), { id, status: 'open', createdAt: 'x' });
    }
    await expect(createQuestionBatch(r, meta, input())).rejects.toThrow(/open/);
    expect(await listOpenQuestionBatches(r)).toHaveLength(OPEN_BATCH_CAP);
  });

  it('a terminal file left at the open path after a crash is still honored', async () => {
    const r = await root();
    const batch = await createQuestionBatch(r, meta, input());
    // Simulate a crash between the terminal write and the move to closed/.
    await writeJson(hubPath(r, 'questions', `${batch.id}.json`), {
      ...batch, status: 'answered', answers: [{ question: 'q1', choice: 'c1' }, { question: 'q2', choice: 'c2' }],
    });
    expect((await readQuestionBatch(r, batch.id)).status).toBe('answered');
    expect(await listOpenQuestionBatches(r)).toEqual([]);
    await expect(answerQuestionBatch(r, batch.id, [])).rejects.toThrow(/already answered/);
  });

  it('a non-ENOENT read failure surfaces instead of looking like no questions', async () => {
    const r = await root();
    // A plain file where the questions dir belongs: readdir throws ENOTDIR.
    await writeJson(hubPath(r, 'questions'), 'not a dir');
    await expect(listOpenQuestionBatches(r)).rejects.toThrow(/ENOTDIR/);
  });

  it('a corrupt stored file fails instead of being overwritten', async () => {
    const r = await root();
    const batch = await createQuestionBatch(r, meta, input());
    const file = hubPath(r, 'questions', `${batch.id}.json`);
    await writeFile(file, '{not json');
    await expect(readQuestionBatch(r, batch.id)).rejects.toThrow(/corrupt JSON/);
  });
});

describe('validateAnswers', () => {
  it('enforces one valid answer per question and the other-text rules', async () => {
    const r = await root();
    const batch = await createQuestionBatch(r, meta, input());
    const ok = [{ question: 'q1', choice: 'c1' }, { question: 'q2', choice: 'c2' }];
    expect(validateAnswers(batch, ok)).toHaveLength(2);
    expect(() => validateAnswers(batch, ok.slice(0, 1))).toThrow(/no answer for q2/);
    expect(() => validateAnswers(batch, [...ok, { question: 'q1', choice: 'c2' }])).toThrow(/twice/);
    expect(() => validateAnswers(batch, [ok[0], { question: 'q9', choice: 'c1' }])).toThrow(/unknown question/);
    expect(() => validateAnswers(batch, [ok[0], { question: 'q2', choice: 'c8' }])).toThrow(/offers c1, c2 or other/);
    expect(() => validateAnswers(batch, [ok[0], { question: 'q2', choice: 'other' }])).toThrow(/text/);
    expect(() => validateAnswers(batch, [ok[0], { question: 'q2', choice: 'other', text: '  ' }])).toThrow(/text/);
    expect(() => validateAnswers(batch, [{ question: 'q1', choice: 'c1', text: 'no' }, ok[1]])).toThrow(/only an other answer/);
    expect(() => validateAnswers(batch, 'yes')).toThrow(/an array/);
  });
});

describe('sweepQuestionBatches', () => {
  it('expires an orphaned open batch with an audit note and spares a fresh one', async () => {
    const r = await root();
    const old = await createQuestionBatch(r, meta, input());
    const fresh = await createQuestionBatch(r, meta, input());
    const staleDate = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
    await writeJson(hubPath(r, 'questions', `${old.id}.json`), { ...old, createdAt: staleDate });
    const { sweepQuestionBatches } = await import('../src/questions.js');
    await sweepQuestionBatches(r);
    expect((await readQuestionBatch(r, old.id)).status).toBe('cancelled');
    expect((await readQuestionBatch(r, fresh.id)).status).toBe('open');
    const audit = await readFile(hubPath(r, 'decisions.jsonl'), 'utf8');
    expect(audit).toContain(`expired question batch ${old.id}`);
  });

  it('prunes closed history to the cap, oldest first', async () => {
    const r = await root();
    const { sweepQuestionBatches, CLOSED_BATCH_CAP } = await import('../src/questions.js');
    const dir = hubPath(r, 'questions', 'closed');
    const { utimes, mkdir, readdir } = await import('node:fs/promises');
    await mkdir(dir, { recursive: true });
    const extra = 5;
    for (let i = 0; i < CLOSED_BATCH_CAP + extra; i++) {
      const id = randomUUID();
      const file = `${dir}/${id}.json`;
      await writeJson(file, { id, status: 'answered' });
      await utimes(file, new Date(i * 1000), new Date(i * 1000));
    }
    await sweepQuestionBatches(r);
    const left = await readdir(dir);
    expect(left).toHaveLength(CLOSED_BATCH_CAP);
    const { stat } = await import('node:fs/promises');
    const oldestLeft = Math.min(...await Promise.all(left.map(async (f) => (await stat(`${dir}/${f}`)).mtimeMs)));
    expect(oldestLeft).toBeGreaterThanOrEqual(extra * 1000);
  });
});
