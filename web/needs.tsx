import React, { useState } from 'react';
import type { HubDialog, HubTask, HubView } from '../src/types';
import { ago, staleTask, taskProgress, type Need } from '../src/ui/look';
import { cn } from './lib/utils';
import { Btn } from './action';
import { Input } from './components/ui/input';

const NEED_ACCENT: Record<string, string> = { magenta: 'border-l-fuchsia-400', yellow: 'border-l-amber-400', red: 'border-l-red-500' };

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-zinc-700 bg-zinc-800 px-1 font-mono text-[10px] text-zinc-400">
      {children}
    </kbd>
  );
}

function DialogBlock({
  dialog, answering, idPrefix, onAnswer,
}: {
  dialog: HubDialog;
  answering: boolean;
  idPrefix: string;
  onAnswer: (choice: string) => void;
}) {
  const textLines = dialog.text.split('\n').filter((l) => !/^[\s─╌]*$/.test(l)).slice(-14);
  const offered = dialog.options.filter((o) => o.offered);
  const notOffered = dialog.options.filter((o) => !o.offered);
  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-2 font-mono text-xs text-zinc-400">
        {textLines.map((l, i) => (
          <div key={i} className="truncate">{l}</div>
        ))}
      </div>
      {answering && <div className="text-xs text-sky-400">answering…</div>}
      {(offered.length > 0 || dialog.esc) && (
        <div className="flex flex-wrap gap-1.5">
          {offered.map((o) => (
            <Btn key={o.n} id={`${idPrefix}-${o.n}`} onPress={() => onAnswer(String(o.n))}>
              <Kbd>{o.n}</Kbd>
              {`${o.label}${o.saves_rule ? ' (saves a rule)' : ''}`}
            </Btn>
          ))}
          {dialog.esc && <Btn id={`${idPrefix}-esc`} onPress={() => onAnswer('esc')}>Esc</Btn>}
        </div>
      )}
      {offered.filter((o) => o.detail !== '').map((o) => (
        <div key={o.n} className="text-xs text-zinc-500 truncate">{`${o.n}. ${o.label} ${o.detail}`}</div>
      ))}
      {(notOffered.length > 0 || offered.length === 0) && (
        <div className="text-xs text-amber-300">
          {dialog.options.length === 0
            ? 'answer it in the pane'
            : `${notOffered.map((o) => o.label).join(', ') || 'this dialog'}: answer it in the pane`}
        </div>
      )}
    </div>
  );
}

function NeedDialog({
  dialogKey, dialogs, busy, onAnswer,
}: {
  dialogKey: string;
  dialogs: Record<string, HubDialog>;
  busy: { project: string; what: string; who?: string } | null;
  onAnswer: (project: string, agentRefArg: string | undefined, seen: string, choice: string, id: string) => void;
}) {
  const dialog = dialogs[dialogKey];
  if (!dialog) return null;
  const [project, agent] = dialogKey.split('/');
  const answering = busy?.what === 'answering' && busy.project === project && busy.who === agent;
  return (
    <DialogBlock
      dialog={dialog}
      answering={answering}
      idPrefix={dialogKey}
      onAnswer={(choice) => onAnswer(project, agent, dialog.fingerprint, choice, `${dialogKey}-${choice}`)}
    />
  );
}

export function NeedCard({
  need, view, busy, onAnswer, onContinue, onPlanAnswer, onResolve, onNudge,
}: {
  need: Need;
  view: HubView;
  busy: { project: string; what: string; who?: string } | null;
  onAnswer: (project: string, agentRefArg: string | undefined, seen: string, choice: string, id: string) => void;
  onContinue: (project: string) => void;
  onPlanAnswer: (project: string, taskId: string, verdict: 'approve' | 'sendback', feedback?: string) => void;
  onResolve: (project: string, taskId: string, action: 'cancel' | 'rebrief', note?: string) => void;
  onNudge: (project: string, taskId: string) => void;
}) {
  const accent = NEED_ACCENT[need.color] ?? 'border-l-zinc-600';
  const continuing = need.action === 'continue' && need.project
    && busy?.project === need.project && busy.what === 'continuing';
  const nudging = need.taskId !== undefined
    && busy?.what === 'nudging' && busy.who === need.taskId;
  return (
    <div className={cn('rounded-md border border-zinc-800 border-l-2 bg-zinc-900/60 px-3 py-2', accent)}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0 text-sm">
          <span className="font-medium text-white">{need.who}</span>
          <span className="text-zinc-300">{`  ${need.words}`}</span>
          {need.stale && <span className="text-amber-300">{`  stale`}</span>}
        </div>
        {need.when !== '' && <span className="shrink-0 text-xs text-zinc-500 tabular">{need.when}</span>}
      </div>
      {need.detail && <div className="mt-1 text-xs text-zinc-500">{need.detail}</div>}
      {need.checkpoints && need.checkpoints.length > 0 && (
        <div className="mt-1 flex flex-col text-xs text-zinc-400">
          {need.checkpoints.map((c) => (
            <span key={c.id} className="truncate">{`${c.id}: ${c.desc} (~${c.etaMin}m)`}</span>
          ))}
        </div>
      )}
      {need.dialogKey && (
        <NeedDialog dialogKey={need.dialogKey} dialogs={view.dialogs} busy={busy} onAnswer={onAnswer} />
      )}
      {need.action === 'plan' && need.project && need.taskId && !need.dialogKey && (
        <PlanActions need={need} busy={busy} onPlanAnswer={onPlanAnswer} />
      )}
      {need.action === 'resolve' && need.project && need.taskId && (
        <ResolveActions need={need} busy={busy} onResolve={onResolve} />
      )}
      {need.action === 'continue' && need.project && (
        <div className="mt-2">
          {continuing
            ? <span className="text-xs text-sky-400">continuing…</span>
            : <Btn id={`continue-${need.project}`} onPress={() => onContinue(need.project!)}>Continue</Btn>}
        </div>
      )}
      {need.stale && need.project && need.taskId && (
        <div className="mt-2">
          {nudging
            ? <span className="text-xs text-sky-400">nudging…</span>
            : (
              <Btn id={`nudge-${need.taskId}`} onPress={() => onNudge(need.project!, need.taskId!)}>
                Nudge
              </Btn>
            )}
        </div>
      )}
    </div>
  );
}

function ResolveActions({
  need, busy, onResolve,
}: {
  need: Need;
  busy: { project: string; what: string; who?: string } | null;
  onResolve: (project: string, taskId: string, action: 'cancel' | 'rebrief', note?: string) => void;
}) {
  const [rebriefing, setRebriefing] = useState(false);
  const [brief, setBrief] = useState('');
  const project = need.project!;
  const taskId = need.taskId!;
  if (busy?.what === 'resolving' && busy.who === taskId) {
    return <div className="mt-2 text-xs text-sky-400">resolving…</div>;
  }
  if (rebriefing) {
    return (
      <form
        className="mt-2 flex gap-1.5"
        // Block the native reload; the Send button's onPress is the one
        // submit path (Enter in the input clicks the submit button).
        onSubmit={(e) => e.preventDefault()}
      >
        <Input
          autoFocus
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="the new brief"
          aria-label={`new brief for ${taskId}`}
          className="h-8 text-xs"
        />
        <Btn
          id={`rebrief-go-${taskId}`}
          disabled={!brief.trim()}
          onPress={() => onResolve(project, taskId, 'rebrief', brief.trim())}
        >
          Send
        </Btn>
        <Btn id={`rebrief-back-${taskId}`} onPress={() => setRebriefing(false)}>Back</Btn>
      </form>
    );
  }
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      <Btn id={`rebrief-${taskId}`} onPress={() => setRebriefing(true)}>Rebrief</Btn>
      <Btn id={`cancel-${taskId}`} onPress={() => onResolve(project, taskId, 'cancel')}>Cancel</Btn>
    </div>
  );
}

function PlanActions({
  need, busy, onPlanAnswer,
}: {
  need: Need;
  busy: { project: string; what: string; who?: string } | null;
  onPlanAnswer: (project: string, taskId: string, verdict: 'approve' | 'sendback', feedback?: string) => void;
}) {
  const [sendingBack, setSendingBack] = useState(false);
  const [feedback, setFeedback] = useState('');
  const project = need.project!;
  const taskId = need.taskId!;
  if (busy?.project === project && busy.what === 'answering' && busy.who === taskId) {
    return <div className="mt-2 text-xs text-sky-400">answering…</div>;
  }
  return (
    <div className="mt-2 flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        <Btn id={`plan-approve-${taskId}`} variant="primary" onPress={() => onPlanAnswer(project, taskId, 'approve')}>
          Approve plan
        </Btn>
        {!sendingBack && (
          <Btn id={`plan-sendback-${taskId}`} onPress={() => setSendingBack(true)}>Send back</Btn>
        )}
      </div>
      {sendingBack && (
        <form
          className="flex gap-1.5"
          // Block the native reload; the Send button's onPress is the one
          // submit path (Enter in the input clicks the submit button).
          onSubmit={(e) => e.preventDefault()}
        >
          <Input
            autoFocus
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="what should change? (optional)"
            className="h-8 text-xs"
          />
          <Btn id={`plan-sendback-go-${taskId}`} onPress={() => onPlanAnswer(project, taskId, 'sendback', feedback.trim() || undefined)}>
            Send
          </Btn>
        </form>
      )}
    </div>
  );
}

// One task's checkpoint trail line on the project card.
export function ProgressRow({
  task: t, now, busy, onNudge,
}: {
  task: HubTask;
  now: number;
  busy: { project: string; what: string; who?: string } | null;
  onNudge: (project: string, taskId: string) => void;
}) {
  const prog = taskProgress(t)!;
  const stale = staleTask(t, now);
  const nudging = busy?.what === 'nudging' && busy.who === t.id;
  return (
    <span className="flex flex-wrap items-baseline gap-x-1.5 text-xs">
      <span className="font-medium text-zinc-100">{t.id}</span>
      <span className="text-zinc-300">{`${prog.done}/${prog.total} checkpoints`}</span>
      {prog.current && <span className="text-zinc-300">{`on ${prog.current}`}</span>}
      <span className="text-zinc-500">
        {prog.lastAt ? `last progress ${ago(prog.lastAt, now)} ago` : 'no progress yet'}
      </span>
      {prog.failed.length > 0 && (
        <span className="text-red-400">{`failed: ${prog.failed.join(', ')}`}</span>
      )}
      {stale && <span className="text-amber-300">stale</span>}
      {stale && (
        nudging
          ? <span className="text-sky-400">nudging…</span>
          : <Btn id={`nudge-${t.id}`} onPress={() => onNudge(t.project, t.id)}>Nudge</Btn>
      )}
    </span>
  );
}
