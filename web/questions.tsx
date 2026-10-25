import React, { useEffect, useState } from 'react';
import type { QuestionAnswer, QuestionBatch } from '../src/types';
import { Btn } from './action';
import { Badge } from './components/ui/badge';
import { Card, CardContent, CardHeader } from './components/ui/card';
import { Input } from './components/ui/input';
import { Separator } from './components/ui/separator';

type Draft = { choice: string; text: string };

function CancelBatch({ batch, onCancel }: { batch: QuestionBatch; onCancel: () => void }) {
  const [arming, setArming] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  useEffect(() => {
    if (!arming) return;
    setCooldown(true);
    const t = setTimeout(() => setCooldown(false), 500);
    return () => clearTimeout(t);
  }, [arming]);
  if (!arming) {
    return <Btn id={`question-cancel-${batch.id}`} onPress={() => setArming(true)}>Cancel batch</Btn>;
  }
  return (
    <>
      <Btn
        id={`question-cancel-go-${batch.id}`}
        disabled={cooldown}
        onPress={() => { setArming(false); onCancel(); }}
      >
        Cancel batch?
      </Btn>
      <Btn id={`question-cancel-back-${batch.id}`} onPress={() => setArming(false)}>Keep batch</Btn>
    </>
  );
}

function BatchCard({
  batch, onAnswer, onCancel,
}: {
  batch: QuestionBatch;
  onAnswer: (batch: QuestionBatch, answers: QuestionAnswer[]) => void;
  onCancel: (batch: QuestionBatch) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => Object.fromEntries(
    batch.questions.map((q) => [q.id, { choice: q.recommended, text: '' }]),
  ));
  const questions = [...batch.questions].sort((a, b) => a.priority - b.priority);
  const complete = questions.every((q) => {
    const draft = drafts[q.id];
    return draft.choice !== '' && (draft.choice !== 'other' || draft.text.trim() !== '');
  });
  const update = (question: string, patch: Partial<Draft>) => {
    setDrafts((current) => ({ ...current, [question]: { ...current[question], ...patch } }));
  };
  const submit = () => {
    const answers = questions.map((q): QuestionAnswer => {
      const draft = drafts[q.id];
      return draft.choice === 'other'
        ? { question: q.id, choice: 'other', text: draft.text }
        : { question: q.id, choice: draft.choice };
    });
    onAnswer(batch, answers);
  };
  return (
    <Card>
      <CardHeader className="flex-col items-start gap-1">
        <span className="font-medium text-white">{batch.context}</span>
        <span className="text-xs text-zinc-400">{`${batch.project} · ${batch.agent}`}</span>
        <time className="text-xs text-zinc-500" dateTime={batch.createdAt}>{batch.createdAt}</time>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={(e) => e.preventDefault()}>
          {questions.map((q) => {
            const draft = drafts[q.id];
            return (
              <fieldset key={q.id} className="rounded-md border border-zinc-800 p-3">
                <legend className="flex items-center gap-2 px-1 text-sm font-medium text-zinc-100">
                  <Badge>{`P${q.priority}`}</Badge>
                  <span>{q.question}</span>
                </legend>
                <p className="mb-3 text-xs text-zinc-500">{q.context}</p>
                <div className="flex flex-col gap-3">
                  {q.choices.map((choice) => {
                    const id = `${batch.id}-${q.id}-${choice.id}`;
                    return (
                      <div key={choice.id} className="flex items-start gap-2">
                        <input
                          id={id}
                          type="radio"
                          name={`${batch.id}-${q.id}`}
                          value={choice.id}
                          checked={draft.choice === choice.id}
                          onChange={() => update(q.id, { choice: choice.id })}
                          className="mt-1 accent-sky-400"
                        />
                        <label htmlFor={id} className="text-sm text-zinc-200">
                          <span className="flex flex-wrap items-center gap-2">
                            {choice.label}
                            {q.recommended === choice.id && <Badge variant="cyan">recommended</Badge>}
                          </span>
                          <span className="mt-0.5 block text-xs text-zinc-500">{choice.description}</span>
                        </label>
                      </div>
                    );
                  })}
                  <div className="flex items-start gap-2">
                    <input
                      id={`${batch.id}-${q.id}-other`}
                      type="radio"
                      name={`${batch.id}-${q.id}`}
                      value="other"
                      checked={draft.choice === 'other'}
                      onChange={() => update(q.id, { choice: 'other' })}
                      className="mt-1 accent-sky-400"
                    />
                    <div className="w-full">
                      <label htmlFor={`${batch.id}-${q.id}-other`} className="text-sm text-zinc-200">Other</label>
                      <Input
                        aria-label={`Other answer for ${q.id}`}
                        value={draft.text}
                        onChange={(e) => update(q.id, { text: e.target.value })}
                        disabled={draft.choice !== 'other'}
                        required={draft.choice === 'other'}
                        maxLength={4000}
                        className="mt-1 text-xs"
                      />
                    </div>
                  </div>
                </div>
              </fieldset>
            );
          })}
          <div className="flex flex-wrap gap-1.5">
            <Btn id={`question-answer-${batch.id}`} variant="primary" disabled={!complete} onPress={submit}>
              Submit
            </Btn>
            <CancelBatch batch={batch} onCancel={() => onCancel(batch)} />
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function Questions({
  batches, total, onBack, onAnswer, onCancel,
}: {
  batches: QuestionBatch[];
  total?: number;
  onBack: () => void;
  onAnswer: (batch: QuestionBatch, answers: QuestionAnswer[]) => void;
  onCancel: (batch: QuestionBatch) => void;
}) {
  const ordered = [...batches].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const open = total ?? batches.length;
  return (
    <div className="min-h-screen bg-zinc-950">
      <div className="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-8">
        <header className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="text-lg font-semibold tracking-tight text-white">Questions</span>
            <Badge>{`${open} open`}</Badge>
          </div>
          <Btn id="questions-back" variant="ghost" onPress={onBack}>back</Btn>
        </header>
        <Separator />
        {open > batches.length && (
          <div className="text-sm text-zinc-500">{`Showing the oldest ${batches.length} of ${open}. Answer or cancel these to see the rest.`}</div>
        )}
        {ordered.length === 0 && <div className="text-sm text-zinc-500">No open questions.</div>}
        {ordered.map((batch) => (
          <BatchCard key={batch.id} batch={batch} onAnswer={onAnswer} onCancel={onCancel} />
        ))}
      </div>
    </div>
  );
}
