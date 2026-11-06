import React, { useEffect, useRef, useState } from 'react';
import type { OperatorQuestion, QuestionAnswer, QuestionBatch } from '../src/types';
import { ageLabel, decisionApprovalAllowed, decisionValidity } from '../src/decisions';
import { Btn } from './action';
import { Badge } from './components/ui/badge';
import { Card, CardContent, CardHeader } from './components/ui/card';
import { Input } from './components/ui/input';
import { Separator } from './components/ui/separator';
import { DictationControl, type DictationEngine } from './dictation';

type Draft = { choice: string; text: string };

function OtherAnswer({
  batchId, questionId, draft, onSelect, onText, dictationEngine,
}: {
  batchId: string;
  questionId: string;
  draft: Draft;
  onSelect: () => void;
  onText: (text: string) => void;
  dictationEngine?: DictationEngine;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-start gap-2">
      <input
        id={`${batchId}-${questionId}-other`}
        type="radio"
        name={`${batchId}-${questionId}`}
        value="other"
        checked={draft.choice === 'other'}
        onChange={onSelect}
        className="mt-1 accent-sky-400"
      />
      <div className="w-full">
        <label htmlFor={`${batchId}-${questionId}-other`} className="text-sm text-zinc-200">Other</label>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <Input
            ref={inputRef}
            aria-label={`Other answer for ${questionId}`}
            value={draft.text}
            onChange={(event) => onText(event.target.value)}
            disabled={draft.choice !== 'other'}
            required={draft.choice === 'other'}
            maxLength={4000}
            className="text-xs"
          />
          {draft.choice === 'other' && (
            <DictationControl
              inputRef={inputRef} value={draft.text} onChange={onText} label={`Other answer for ${questionId}`}
              dictationEngine={dictationEngine}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function useDecisionNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

function DecisionDetails({ question, now }: { question: OperatorQuestion; now: number }) {
  const card = question.decision;
  if (!card) return null;
  const state = decisionValidity(question, now);
  const stateLabel = { current: 'Current', stale: 'Stale', expired: 'Expired', invalid: 'Invalid', incomplete: 'Incomplete' }[state];
  const facts = [
    ['Repository', card.facts.repository],
    ['Branch', card.facts.branch],
    ['Commit', card.facts.commit?.slice(0, 8)],
    ['Diff', card.facts.diffSummary],
    ['Destination', card.facts.destination],
    ['Agent reason (untrusted)', card.facts.reason],
    ['Agent scope (untrusted)', card.facts.scope],
    ['Agent budget (untrusted)', card.facts.budget],
  ].filter((row): row is [string, string] => Boolean(row[1]));
  return (
    <div className="mb-3 flex flex-col gap-3 rounded-md bg-zinc-900/60 p-3">
      <div>
        <p className="text-sm text-zinc-200">{card.overview}</p>
        {card.overviewSource === 'model' && (
          <p className="mt-1 text-xs text-zinc-500">Model overview. The verified facts and choices below stay authoritative.</p>
        )}
      </div>
      {card.missing.length > 0 && (
        <p className="text-sm text-amber-300">{`Required facts missing: ${card.missing.join(', ')}. Approval is unavailable.`}</p>
      )}
      <dl className="grid grid-cols-1 gap-x-3 gap-y-2 text-xs sm:grid-cols-[8rem_minmax(0,1fr)]">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-zinc-500">{label}</dt>
            <dd className="break-words text-zinc-300">{value}</dd>
          </div>
        ))}
        {card.facts.files && card.facts.files.length > 0 && (
          <div className="contents">
            <dt className="text-zinc-500">Changed files</dt>
            <dd className="break-words text-zinc-300">{card.facts.files.join(', ')}</dd>
          </div>
        )}
      </dl>
      {card.consequences.length > 0 && (
        <div>
          <span className="text-xs font-medium text-zinc-300">Exact consequences</span>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-zinc-400">
            {card.consequences.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      )}
      <p className="text-xs text-zinc-400">
        <span className={state === 'current' ? 'text-emerald-300' : 'text-amber-300'}>{stateLabel}</span>
        {` · Verification ${ageLabel(question, now)}`}
        {card.facts.validUntil ? ` · Valid until ${card.facts.validUntil}` : ''}
      </p>
    </div>
  );
}


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

export function BatchCard({
  batch, onAnswer, onCancel, dictationEngine,
}: {
  batch: QuestionBatch;
  onAnswer: (batch: QuestionBatch, answers: QuestionAnswer[]) => void;
  onCancel: (batch: QuestionBatch) => void;
  dictationEngine?: DictationEngine;
}) {
  const now = useDecisionNow(batch.questions.some((q) => q.decision !== undefined));
  const [notice, setNotice] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => Object.fromEntries(
    batch.questions.map((q) => [q.id, { choice: q.recommended, text: '' }]),
  ));
  const questions = [...batch.questions].sort((a, b) => a.priority - b.priority);
  const expiredSelection = (q: OperatorQuestion, draft: Draft): boolean =>
    Boolean(q.decision && q.choices.length === 3 && draft.choice === 'c2' && !decisionApprovalAllowed(q, now));
  const completeAt = (time: number): boolean => questions.every((q) => {
    const draft = drafts[q.id];
    if (q.decision && q.choices.length === 3 && draft.choice === 'c2' && !decisionApprovalAllowed(q, time)) return false;
    return draft.choice !== '' && (draft.choice !== 'other' || draft.text.trim() !== '');
  });
  const complete = completeAt(now);
  useEffect(() => {
    const expired = questions.filter((q) => expiredSelection(q, drafts[q.id]));
    if (expired.length === 0) return;
    setDrafts((current) => Object.fromEntries(Object.entries(current).map(([id, draft]) => {
      const question = questions.find((q) => q.id === id);
      return [id, question && expired.includes(question) ? { ...draft, choice: question.recommended } : draft];
    })));
    setNotice('Approval expired. Refresh facts first was selected.');
  }, [now]);
  const update = (question: string, patch: Partial<Draft>) => {
    setDrafts((current) => ({ ...current, [question]: { ...current[question], ...patch } }));
  };
  const submit = () => {
    const submittedAt = Date.now();
    if (!completeAt(submittedAt)) {
      setDrafts((current) => Object.fromEntries(Object.entries(current).map(([id, draft]) => {
        const question = questions.find((q) => q.id === id);
        const expired = question?.decision && question.choices.length === 3 && draft.choice === 'c2' && !decisionApprovalAllowed(question, submittedAt);
        return [id, expired && question ? { ...draft, choice: question.recommended } : draft];
      })));
      setNotice('Approval expired. Refresh facts first was selected.');
      return;
    }
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
        <span className="font-medium text-white">{`Agent context (untrusted): ${batch.context}`}</span>
        {batch.questions.some((q) => q.decision) && (
          <span className="text-xs text-sky-300">Review each requested action separately. No approval happens automatically.</span>
        )}
        <span className="text-xs text-zinc-400">{`${batch.project} · ${batch.agent}`}</span>
        <time className="text-xs text-zinc-500" dateTime={batch.createdAt}>{batch.createdAt}</time>
        <span role="status" aria-live="polite" aria-atomic="true" className="text-xs text-amber-300">{notice}</span>
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
                <DecisionDetails question={q} now={now} />
                <div className="flex flex-col gap-3">
                  {q.choices.map((choice) => {
                    const id = `${batch.id}-${q.id}-${choice.id}`;
                    const approval = Boolean(q.decision && q.choices.length === 3 && choice.id === 'c2');
                    const disabled = approval && !decisionApprovalAllowed(q, now);
                    return (
                      <div key={choice.id} className="flex items-start gap-2">
                        <input
                          id={id}
                          type="radio"
                          name={`${batch.id}-${q.id}`}
                          value={choice.id}
                          checked={draft.choice === choice.id}
                          disabled={disabled}
                          onChange={() => update(q.id, { choice: choice.id })}
                          className="mt-1 accent-sky-400"
                        />
                        <label htmlFor={id} className="text-sm text-zinc-200">
                          <span className="flex flex-wrap items-center gap-2">
                            {choice.label}
                            {q.recommended === choice.id && <Badge variant="cyan">Recommended</Badge>}
                            {disabled && <Badge variant="amber">Approval unavailable</Badge>}
                          </span>
                          <span className="mt-0.5 block text-xs text-zinc-500">{choice.description}</span>
                        </label>
                      </div>
                    );
                  })}
                  <OtherAnswer
                    batchId={batch.id}
                    questionId={q.id}
                    draft={draft}
                    onSelect={() => update(q.id, { choice: 'other' })}
                    onText={(text) => update(q.id, { text })}
                    dictationEngine={dictationEngine}
                  />
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
