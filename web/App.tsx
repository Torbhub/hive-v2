import React, {
  useCallback, useContext, useEffect, useRef, useState,
} from 'react';
import { Toaster, toast } from 'sonner';
import type { Approvals, HubProject, HubView, ProjectMode } from '../src/types';
import { APPROVALS_MODES, CLOSED_STATES, PROJECT_MODES } from '../src/types';
import {
  agentGlyph, agentRef, ago, buildNeeds, homeTilde, orchestratorLook,
  ROTATE_AT_PERCENT, taskProgress, tasksLine, windowLabel,
} from '../src/ui/look';
import { cn } from './lib/utils';
import { StretchText } from './Stretch';
import { ActionContext, Btn } from './action';
import { NeedCard, ProgressRow } from './needs';
import { AddProjectRow, MessageRow, NewTaskRow } from './rows';
import { Button } from './components/ui/button';
import { Badge } from './components/ui/badge';
import { Card, CardContent, CardHeader } from './components/ui/card';
import { Separator } from './components/ui/separator';
import { ToggleGroup, ToggleGroupItem } from './components/ui/toggle-group';

const EVERY_MS = 20_000;

const EMPTY_VIEW: HubView = { root: '', hubName: '', projects: [], tasks: [], dialogs: {}, decisions: [], updatedAt: 0, error: '' };

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

function StatusDot({ color, className }: { color: string; className?: string }) {
  const cls = { green: 'bg-emerald-500', yellow: 'bg-amber-400', red: 'bg-red-500', gray: 'bg-zinc-600', cyan: 'bg-sky-400', magenta: 'bg-fuchsia-400' }[color] ?? 'bg-zinc-600';
  return <span className={cn('inline-block h-2 w-2 rounded-full shrink-0', cls, className)} />;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 text-sm">
      <span className="w-24 shrink-0 text-zinc-500">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

function ProjectCard({
  project: p, view, now, busy, onWake, onStartTask, onSetMode, onSetApprovals, onMessage, onNudge, onInterrupt,
}: {
  project: HubProject;
  view: HubView;
  now: number;
  busy: { project: string; what: string; who?: string } | null;
  onWake: (project: string) => void;
  onStartTask: (project: string, text: string) => Promise<boolean>;
  onSetMode: (project: string, mode: ProjectMode) => void;
  onSetApprovals: (project: string, approvals: Approvals) => void;
  onMessage: (project: string, text: string) => Promise<boolean>;
  onNudge: (project: string, taskId: string) => void;
  onInterrupt: (project: string, ref?: string) => void;
}) {
  const { acting } = useContext(ActionContext);
  const look = orchestratorLook(p.orchestrator);
  const o = p.orchestrator;
  const orchName = o.state === 'none' ? 'none yet' : o.name ?? '?';
  const up = p.agents.filter((a) => a.state === 'running').length;
  const notRunning = p.agents.filter((a) => a.state !== 'running');
  const canResume =
    (o.state === 'stopped' || o.state === 'resumable') && Boolean(o.session_id) && !o.starting;
  const back = 1 + p.agents.filter((a) => a.state === 'stopped').length;
  const resuming = busy?.project === p.name && busy.what === 'resuming';
  const trail = view.tasks.filter(
    (t) => t.project === p.name && !CLOSED_STATES.has(t.state) && taskProgress(t) !== null,
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <StatusDot color={look.color} />
          <span className="font-medium text-white">{p.name}</span>
        </div>
        <span className="text-xs text-zinc-500">{look.word}</span>
      </CardHeader>
      <CardContent>
        <Row label="orchestrator">
          <span>
            <span className="text-zinc-100">{orchName}</span>
            {o.name && <span className="text-zinc-500">{`  ${windowLabel(p.name, o.name)}`}</span>}
            {o.state === 'unregistered' && o.pane && <span className="text-zinc-500">{`  pane ${o.pane}`}</span>}
            {typeof o.context === 'number' && (
              <span className={o.context_assumed ? 'text-zinc-500' : o.context >= ROTATE_AT_PERCENT ? 'text-amber-300' : 'text-emerald-400'}>
                {`  ${o.context}%`}
              </span>
            )}
            {o.context_unknown && <span className="text-zinc-500">  context unknown</span>}
            {o.state === 'running' && (
              <span className="ml-2 inline-block">
                <Btn id={`interrupt-${p.name}`} onPress={() => onInterrupt(p.name)}>Interrupt</Btn>
              </span>
            )}
          </span>
        </Row>
        <Row label="agents">
          {p.agents.length === 0 ? (
            <span className="text-zinc-500">none</span>
          ) : (
            <span className="flex flex-col">
              <span className="flex items-center gap-1.5">
                {p.agents.map((a) => (
                  <StatusDot key={a.ref ?? a.name} color={agentGlyph(a).color} />
                ))}
                <span className="text-zinc-100">{` ${up} of ${p.agents.length}`}</span>
              </span>
              {notRunning.length > 0 && (
                <span className="text-amber-300 text-xs">{notRunning.map((a) => `${agentRef(a)} ${a.state}`).join(', ')}</span>
              )}
              <span className="text-zinc-500 text-xs">
                {p.agents.map((a) => windowLabel(p.name, a.name)).join(', ')}
              </span>
              {up > 0 && (
                <span className="mt-1 flex flex-wrap gap-1.5">
                  {p.agents.filter((a) => a.state === 'running').map((a) => (
                    <Btn
                      key={a.ref ?? a.name}
                      id={`interrupt-${p.name}-${agentRef(a)}`}
                      onPress={() => onInterrupt(p.name, agentRef(a))}
                    >
                      {`Interrupt ${agentRef(a)}`}
                    </Btn>
                  ))}
                </span>
              )}
            </span>
          )}
        </Row>
        <Row label="tasks">
          <span className="text-zinc-100">{tasksLine(view.tasks, p.name, p.open_tasks, now)}</span>
        </Row>
        {trail.length > 0 && (
          <Row label="progress">
            <span className="flex flex-col gap-1">
              {trail.map((t) => (
                <ProgressRow key={t.id} task={t} now={now} busy={busy} onNudge={onNudge} />
              ))}
            </span>
          </Row>
        )}
        <Row label="folders">
          <span className="flex flex-col">
            {p.repos.map((r) => (
              <span key={r.folder} className="truncate font-mono text-xs text-zinc-300">
                {`${r.folder}${r.changed ? `  ${r.changed} changed` : ''}`}
              </span>
            ))}
          </span>
        </Row>
        <Row label="mode">
          <ToggleGroup
            type="single"
            value={p.mode ?? 'ask'}
            disabled={acting}
            onValueChange={(m) => {
              if (m) onSetMode(p.name, m as ProjectMode);
            }}
            aria-label={`permission mode for ${p.name}`}
          >
            {PROJECT_MODES.map((m) => (
              <ToggleGroupItem key={m} value={m}>{m}</ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Row>
        <Row label="approvals">
          <ToggleGroup
            type="single"
            value={p.approvals ?? 'manual'}
            disabled={acting}
            onValueChange={(m) => {
              if (m) onSetApprovals(p.name, m as Approvals);
            }}
            aria-label={`approvals for ${p.name}`}
          >
            {APPROVALS_MODES.map((m) => (
              <ToggleGroupItem key={m} value={m}>{m}</ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Row>
        {canResume && (
          <div className="pt-1.5">
            {resuming
              ? <span className="text-xs text-sky-400">resuming…</span>
              : (
                <Btn id={`wake-${p.name}`} variant="primary" onPress={() => onWake(p.name)}>
                  {`Resume · ${back} session${back === 1 ? '' : 's'}`}
                </Btn>
              )}
          </div>
        )}
        <MessageRow project={p.name} busy={busy} onMessage={onMessage} />
        <NewTaskRow project={p.name} busy={busy} onStartTask={onStartTask} />
        <div className="mt-2 border-t border-zinc-800 pt-2.5 font-mono text-xs text-zinc-500">
          attach: tmux -L hive-v2 attach
        </div>
      </CardContent>
    </Card>
  );
}

export function App() {
  const [view, setView] = useState<HubView>(EMPTY_VIEW);
  const [acting, setActing] = useState(false);
  const [busy, setBusy] = useState<{ project: string; what: 'resuming' | 'continuing' | 'starting' | 'answering' | 'adding' | 'messaging' | 'resolving' | 'nudging' | 'interrupting'; who?: string } | null>(null);
  const [pressed, setPressed] = useState<string | null>(null);
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
    what: 'resuming' | 'continuing' | 'answering' | 'starting' | 'adding' | 'messaging' | 'resolving' | 'nudging' | 'interrupting',
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

  const onAddProject = useCallback(async (name: string, folder: string): Promise<boolean> => {
    return act('add-project', name, 'adding', name, async () => {
      await post('api/project', { name, path: folder });
      return `${name}: project added`;
    });
  }, [act]);

  const onMessage = useCallback(async (project: string, text: string): Promise<boolean> => {
    return act(`message-${project}`, project, 'messaging', project, async () => {
      await post('api/message', { project, text });
      return `${project}: the message was typed to its orchestrator`;
    });
  }, [act]);

  const now = Date.now();
  const where = homeTilde(view.root, '');
  const clock = view.updatedAt ? new Date(view.updatedAt).toTimeString().slice(0, 5) : 'reading…';
  const needs = buildNeeds(view, now);

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
            />
          ))}

          <AddProjectRow onAddProject={onAddProject} />

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
