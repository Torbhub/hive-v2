import React, {
  useCallback, useEffect, useRef, useState,
} from 'react';
import { Toaster, toast } from 'sonner';
import type { Approvals, HubView, ProjectMode, QuestionAnswer, QuestionBatch } from '../src/types';
import { ago, buildNeeds, homeTilde } from '../src/ui/look';
import { StretchText } from './Stretch';
import { ActionContext, Btn } from './action';
import { LogView } from './logview';
import { ProjectCard, StatusDot } from './project';
import { NeedCard } from './needs';
import { Questions } from './questions';
import { AddProjectRow } from './rows';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/badge';
import { Separator } from './components/ui/separator';

const EVERY_MS = 20_000;

const EMPTY_VIEW: HubView = { root: '', hubName: '', projects: [], tasks: [], dialogs: {}, decisions: [], questions: [], updatedAt: 0, error: '' };

async function post(pathname: string, body: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = (await r.json()) as { ok?: boolean; detail?: string } & Record<string, unknown>;
  if (!r.ok || j.ok === false) throw new Error(j.detail ?? `HTTP ${r.status}`);
  return j;
}

export function App() {
  const [view, setView] = useState<HubView>(EMPTY_VIEW);
  const [acting, setActing] = useState(false);
  const [busy, setBusy] = useState<{ project: string; what: 'resuming' | 'continuing' | 'starting' | 'answering' | 'adding' | 'messaging' | 'resolving' | 'nudging' | 'interrupting' | 'killing' | 'deleting'; who?: string } | null>(null);
  const [pressed, setPressed] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ project: string; agent?: string } | null>(null);
  const [questionsOpen, setQuestionsOpen] = useState(false);
  const actingRef = useRef(false);

  // A failed read (network error, or updatedAt 0 from the server) keeps the
  // old data and shows the error line, same as the Ink screen.
  const refresh = useCallback(async () => {
    let next: HubView;
    try {
      const r = await fetch('api/view');
      next = (await r.json()) as HubView;
    } catch (e) {
      setView((v) => ({ ...v, error: e instanceof Error ? e.message : String(e) }));
      return;
    }
    setView((v) => (next.updatedAt === 0 && next.error ? { ...v, error: next.error } : next));
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), EVERY_MS);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey) void refresh();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [refresh]);

  // One action at a time: a click while another runs is ignored. The pressed
  // button inverts and everything disables before the network round-trip.
  const act = useCallback(async (
    id: string,
    project: string,
    what: 'resuming' | 'continuing' | 'answering' | 'starting' | 'adding' | 'messaging' | 'resolving' | 'nudging' | 'interrupting' | 'killing' | 'deleting',
    who: string,
    runAction: () => Promise<string>,
    busyWho?: string,
  ): Promise<boolean> => {
    if (actingRef.current) return false;
    actingRef.current = true;
    setPressed(id);
    setActing(true);
    setBusy({ project, what, who: busyWho });
    try {
      toast(await runAction());
      return true;
    } catch (e) {
      toast(`${who}: ${e instanceof Error ? e.message.split('\n').pop() : String(e)}`);
      return false;
    } finally {
      actingRef.current = false;
      setActing(false);
      setBusy(null);
      setPressed(null);
      void refresh();
    }
  }, [refresh]);

  const onWake = useCallback((project: string) => {
    void act(`wake-${project}`, project, 'resuming', project, async () => {
      const j = await post('api/wake', { project });
      return `${project}: its orchestrator is coming up; it reports back when its team is up (pane ${j.pane})`;
    });
  }, [act]);

  const onContinue = useCallback((project: string) => {
    void act(`continue-${project}`, project, 'continuing', project, async () => {
      const j = await post('api/continue', { project });
      return `${project}: its first line was sent (pane ${j.pane})`;
    });
  }, [act]);

  const onAnswer = useCallback((project: string, agentRefArg: string | undefined, seen: string, choice: string, id: string) => {
    const who = agentRefArg ? `${project} · ${agentRefArg}` : project;
    void act(id, project, 'answering', who, async () => {
      const j = await post('api/answer', { project, agent: agentRefArg, choice, fingerprint: seen });
      return `${who}: answered "${j.option}"${j.dialog_gone ? '' : ' (the dialog is still on its screen)'}`;
    }, agentRefArg);
  }, [act]);

  const onStartTask = useCallback(async (project: string, text: string): Promise<boolean> => {
    return act(`start-${project}`, project, 'starting', project, async () => {
      const t = await post('api/task', { project, text });
      const j = await post('api/start', { project, task: t.id });
      return `${project}: its orchestrator is coming up on ${t.id}; it reports back when its team is up (pane ${j.pane})`;
    });
  }, [act]);

  const onSetMode = useCallback((project: string, mode: ProjectMode) => {
    void act(`mode-${project}-${mode}`, project, 'answering', project, async () => {
      await post('api/mode', { project, mode });
      return `${project}: permission mode is ${mode} (applies to the next launch)`;
    });
  }, [act]);

  const onSetApprovals = useCallback((project: string, approvals: Approvals) => {
    void act(`approvals-${project}-${approvals}`, project, 'answering', project, async () => {
      await post('api/approvals', { project, approvals });
      return `${project}: approvals are ${approvals}`;
    });
  }, [act]);

  const onPlanAnswer = useCallback((project: string, taskId: string, verdict: 'approve' | 'sendback', feedback?: string) => {
    void act(`plan-${taskId}-${verdict}`, project, 'answering', taskId, async () => {
      await post('api/plan-answer', { project, task: taskId, verdict, feedback });
      return verdict === 'approve' ? `${taskId}: plan approved` : `${taskId}: plan sent back`;
    }, taskId);
  }, [act]);

  const onResolve = useCallback((project: string, taskId: string, action: 'cancel' | 'rebrief', note?: string) => {
    void act(`resolve-${taskId}-${action}`, project, 'resolving', taskId, async () => {
      await post('api/task-resolve', { project, task: taskId, action, note });
      return action === 'cancel' ? `${taskId}: cancelled` : `${taskId}: back to asked with the new brief`;
    }, taskId);
  }, [act]);

  const onNudge = useCallback((project: string, taskId: string) => {
    void act(`nudge-${taskId}`, project, 'nudging', taskId, async () => {
      await post('api/message', { project, text: `${taskId}: owner asks for status` });
      return `${taskId}: the orchestrator was asked for status`;
    }, taskId);
  }, [act]);

  const onInterrupt = useCallback((project: string, ref?: string) => {
    const who = ref ? `${project} · ${ref}` : project;
    void act(`interrupt-${who}`, project, 'interrupting', who, async () => {
      const j = await post('api/interrupt', { project, agent: ref });
      return `interrupted ${String(j.target)}`;
    }, ref);
  }, [act]);

  const onKill = useCallback((project: string) => {
    void act(`kill-${project}`, project, 'killing', project, async () => {
      const j = await post('api/kill', { project });
      return String(j.summary);
    });
  }, [act]);

  const onDelete = useCallback((project: string) => {
    void act(`delete-${project}`, project, 'deleting', project, async () => {
      await post('api/project-delete', { project });
      return `${project}: project deleted`;
    });
  }, [act]);

  const onAddProject = useCallback(async (name: string, folder: string, source: string): Promise<boolean> => {
    return act('add-project', name, 'adding', name, async () => {
      const body = folder ? { name, path: folder } : { name, path: '', source };
      const j = await post('api/project', body);
      return `${name}: project added (${String(j.home)})`;
    });
  }, [act]);

  const onMessage = useCallback(async (project: string, text: string): Promise<boolean> => {
    return act(`message-${project}`, project, 'messaging', project, async () => {
      await post('api/message', { project, text });
      return `${project}: the message was typed to its orchestrator`;
    });
  }, [act]);

  const onLogs = useCallback((project: string, agent?: string) => setLogs({ project, agent }), []);

  const onQuestionAnswer = useCallback((batch: QuestionBatch, answers: QuestionAnswer[]) => {
    const who = `${batch.project} · ${batch.agent}`;
    void act(`question-answer-${batch.id}`, batch.project, 'answering', who, async () => {
      await post('api/questions/answer', { id: batch.id, answers });
      return `${batch.project}: question batch answered`;
    });
  }, [act]);

  const onQuestionCancel = useCallback((batch: QuestionBatch) => {
    const who = `${batch.project} · ${batch.agent}`;
    void act(`question-cancel-${batch.id}`, batch.project, 'answering', who, async () => {
      await post('api/questions/cancel', { id: batch.id });
      return `${batch.project}: question batch cancelled`;
    });
  }, [act]);

  if (logs) {
    return (
      <ActionContext.Provider value={{ acting, pressed }}>
        <LogView project={logs.project} agent={logs.agent} onBack={() => setLogs(null)} />
        <Toaster theme="dark" position="bottom-right" />
      </ActionContext.Provider>
    );
  }

  if (questionsOpen) {
    return (
      <ActionContext.Provider value={{ acting, pressed }}>
        <Questions
          batches={view.questions} total={view.questionsTotal ?? view.questions.length}
          onBack={() => setQuestionsOpen(false)}
          onAnswer={onQuestionAnswer}
          onCancel={onQuestionCancel}
        />
        <Toaster theme="dark" position="bottom-right" />
      </ActionContext.Provider>
    );
  }

  const now = Date.now();
  const where = homeTilde(view.root, '');
  const clock = view.updatedAt ? new Date(view.updatedAt).toTimeString().slice(0, 5) : 'reading…';
  const needs = buildNeeds(view, now);
  const sources = [...new Set(view.projects.flatMap((p) =>
    p.repos.filter((r) => r.kind === 'repo' || r.kind === 'worktree').map((r) => r.folder),
  ))];

  return (
    <ActionContext.Provider value={{ acting, pressed }}>
      <div className="min-h-screen bg-zinc-950">
        <div className="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-8">
          <header className="flex items-baseline justify-between gap-3">
            <div className="flex min-w-0 items-baseline gap-2.5">
              <span className="text-lg font-semibold tracking-tight text-white">hive</span>
              {where !== '' && <span className="truncate font-mono text-xs text-zinc-500">{where}</span>}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {view.updatedAt !== 0 && <Badge>relay</Badge>}
              <span className="text-xs text-zinc-500 tabular">{clock}</span>
            </div>
          </header>
          <Separator />

          {view.questions.length > 0 && (
            <div>
              <Btn id="questions-open" onPress={() => setQuestionsOpen(true)}>
                Questions {view.questionsTotal ?? view.questions.length}
              </Btn>
            </div>
          )}

          {view.error !== '' && (
            <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {view.error}
            </div>
          )}

          {needs.length > 0 && (
            <section className="flex flex-col gap-2">
              <div className="text-xs font-medium uppercase tracking-widest text-fuchsia-400">Needs you</div>
              {needs.map((n) => (
                <NeedCard
                  key={n.key}
                  need={n}
                  view={view}
                  busy={busy}
                  onAnswer={onAnswer}
                  onContinue={onContinue}
                  onPlanAnswer={onPlanAnswer}
                  onResolve={onResolve}
                  onNudge={onNudge}
                />
              ))}
            </section>
          )}

          {view.updatedAt !== 0 && view.projects.length === 0 && view.error === '' && (
            <div className="text-sm text-zinc-500">No projects yet: tell the hub which folders make up a project.</div>
          )}

          {view.decisions.length > 0 && (
            <section className="flex flex-col gap-1.5">
              <div className="text-xs font-medium uppercase tracking-widest text-zinc-500">Decisions</div>
              {view.decisions.map((d, i) => (
                <div key={`${d.at}-${i}`} className="flex items-baseline justify-between gap-3 text-sm">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-600" />
                    <span className="shrink-0 font-medium text-zinc-100">{d.task ?? d.project}</span>
                    <StretchText text={d.summary} pane={d.task ?? d.project} className="text-zinc-400" />
                  </div>
                  <span className="shrink-0 text-xs text-zinc-500 tabular">{ago(d.at, now)}</span>
                </div>
              ))}
            </section>
          )}

          {view.projects.map((p) => (
            <ProjectCard
              key={p.name}
              project={p}
              view={view}
              now={now}
              busy={busy}
              onWake={onWake}
              onStartTask={onStartTask}
              onSetMode={onSetMode}
              onSetApprovals={onSetApprovals}
              onMessage={onMessage}
              onNudge={onNudge}
              onInterrupt={onInterrupt}
              onLogs={onLogs}
              onKill={onKill}
              onDelete={onDelete}
            />
          ))}

          <AddProjectRow sources={sources} onAddProject={onAddProject} />

          <footer className="flex items-center justify-between pt-1">
            <span className="flex items-center gap-3 text-xs text-zinc-500">
              <span className="flex items-center gap-1.5"><StatusDot color="green" />running</span>
              <span className="flex items-center gap-1.5"><StatusDot color="yellow" />stopped</span>
              <span className="flex items-center gap-1.5"><StatusDot color="gray" />no team</span>
            </span>
            <Button variant="ghost" size="sm" onClick={() => void refresh()}>refresh</Button>
          </footer>
        </div>
      </div>
      <Toaster theme="dark" position="bottom-right" />
    </ActionContext.Provider>
  );
}
