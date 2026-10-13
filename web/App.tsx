import React, {
  createContext, useCallback, useContext, useEffect, useRef, useState,
} from 'react';
import type { HubDialog, HubProject, HubView, ProjectMode } from '../src/types';
import { PROJECT_MODES } from '../src/types';
import {
  agentGlyph, agentRef, ago, buildNeeds, homeTilde, orchestratorLook,
  ROTATE_AT_PERCENT, tasksLine, type Need,
} from '../src/ui/look';

const EVERY_MS = 20_000;

const EMPTY_VIEW: HubView = {
  root: '', hubName: '', projects: [], tasks: [], dialogs: {}, updatedAt: 0, error: '',
};

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

// Every action button reads this: while an action runs all of them disable,
// and the one that was pressed holds the inverse "active" look until it ends.
const ActionContext = createContext<{ acting: boolean; pressed: string | null }>({
  acting: false,
  pressed: null,
});

function Btn({
  id, label, variant, active, disabled, onPress,
}: {
  id: string;
  label: string;
  variant?: 'primary' | 'plain';
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { acting, pressed } = useContext(ActionContext);
  const cls = ['btn', variant ?? '', pressed === id || active ? 'active' : ''].filter(Boolean).join(' ');
  return (
    <button className={cls} disabled={disabled || acting} onClick={onPress}>
      {label}
    </button>
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
  const textLines = dialog.text
    .split('\n')
    .filter((l) => !/^[\s─╌]*$/.test(l))
    .slice(-14);
  const offered = dialog.options.filter((o) => o.offered);
  const notOffered = dialog.options.filter((o) => !o.offered);
  return (
    <div className="pl3">
      {textLines.map((l, i) => (
        <div key={i} className="gray truncate">{l}</div>
      ))}
      {answering && <div className="cyan">answering…</div>}
      {(offered.length > 0 || dialog.esc) && (
        <div className="need-actions">
          {offered.map((o) => (
            <Btn
              key={o.n}
              id={`${idPrefix}-${o.n}`}
              label={`${o.n} ${o.label}${o.saves_rule ? ' (saves a rule)' : ''}`}
              onPress={() => onAnswer(String(o.n))}
            />
          ))}
          {dialog.esc && <Btn id={`${idPrefix}-esc`} label="Esc" onPress={() => onAnswer('esc')} />}
        </div>
      )}
      {offered.filter((o) => o.detail !== '').map((o) => (
        <div key={o.n} className="gray truncate">{`${o.n}. ${o.label} ${o.detail}`}</div>
      ))}
      {(notOffered.length > 0 || offered.length === 0) && (
        <div className="yellow">
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

function ContinueNeed({
  project, busy, onContinue,
}: {
  project: string;
  busy: { project: string; what: string } | null;
  onContinue: (project: string) => void;
}) {
  return (
    <div className="pl2">
      {busy?.project === project && busy.what === 'continuing'
        ? <span className="cyan">continuing…</span>
        : <Btn id={`continue-${project}`} label="Continue" onPress={() => onContinue(project)} />}
    </div>
  );
}

function NewTaskRow({
  project, busy, onStartTask,
}: {
  project: string;
  busy: { project: string; what: string } | null;
  onStartTask: (project: string, text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  if (busy?.project === project && busy.what === 'starting') {
    return <div className="label-row"><span className="label">new task</span><span className="cyan">starting…</span></div>;
  }
  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    if (await onStartTask(project, t)) setText('');
  };
  return (
    <div className="label-row">
      <span className="label">new task</span>
      <span className="content">
        <span className="new-task">
          <input
            className="task-input"
            value={text}
            placeholder="describe the task…"
            aria-label={`new task for ${project}`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <Btn id={`start-${project}`} label="Start task" disabled={!text.trim()} onPress={() => void submit()} />
        </span>
      </span>
    </div>
  );
}

function ProjectCard({
  project: p, view, now, busy, onWake, onStartTask, onSetMode,
}: {
  project: HubProject;
  view: HubView;
  now: number;
  busy: { project: string; what: string } | null;
  onWake: (project: string) => void;
  onStartTask: (project: string, text: string) => Promise<boolean>;
  onSetMode: (project: string, mode: ProjectMode) => void;
}) {
  const look = orchestratorLook(p.orchestrator);
  const o = p.orchestrator;
  const orchName = o.state === 'none' ? 'none yet' : o.name ?? '?';
  const up = p.agents.filter((a) => a.state === 'running').length;
  const notRunning = p.agents.filter((a) => a.state !== 'running');
  const canResume =
    (o.state === 'stopped' || o.state === 'resumable') && Boolean(o.session_id) && !o.starting;
  const back = 1 + p.agents.filter((a) => a.state === 'stopped').length;

  return (
    <div className="mt">
      <div className="row">
        <span className="bold white">{p.name.toUpperCase()}</span>
        <span className={look.color}>{`${look.dot} ${look.word}`}</span>
      </div>
      <div className="label-row">
        <span className="label">orchestrator</span>
        <span className="content">
          <span>
            <span className="white">{orchName}</span>
            {o.state === 'unregistered' && o.pane && <span className="gray">{`  pane ${o.pane}`}</span>}
            {typeof o.context === 'number' && (
              <span className={o.context_assumed ? 'gray' : o.context >= ROTATE_AT_PERCENT ? 'yellow' : 'green'}>
                {`  ${o.context}%`}
              </span>
            )}
            {o.context_unknown && <span className="gray">  context unknown</span>}
          </span>
        </span>
      </div>
      <div className="label-row">
        <span className="label">agents</span>
        <span className="content">
          {p.agents.length === 0 ? (
            <span className="gray">none</span>
          ) : (
            <>
              <span>
                {p.agents.map((a) => {
                  const g = agentGlyph(a);
                  return <span key={a.ref ?? a.name} className={g.color}>{`${g.glyph} `}</span>;
                })}
                <span className="white">{` ${up} of ${p.agents.length}`}</span>
              </span>
              {notRunning.length > 0 && (
                <span className="yellow">{notRunning.map((a) => `${agentRef(a)} ${a.state}`).join(', ')}</span>
              )}
            </>
          )}
        </span>
      </div>
      <div className="label-row">
        <span className="label">tasks</span>
        <span className="content"><span className="white">{tasksLine(view.tasks, p.name, p.open_tasks, now)}</span></span>
      </div>
      <div className="label-row">
        <span className="label">folders</span>
        <span className="content">
          {p.repos.map((r) => (
            <span key={r.folder} className="white truncate">
              {`${r.folder}${r.changed ? `  ${r.changed} changed` : ''}`}
            </span>
          ))}
        </span>
      </div>
      <div className="label-row">
        <span className="label">mode</span>
        <span className="content">
          <span className="need-actions">
            {PROJECT_MODES.map((m) => (
              <Btn
                key={m}
                id={`mode-${p.name}-${m}`}
                label={m}
                active={(p.mode ?? 'ask') === m}
                onPress={() => onSetMode(p.name, m)}
              />
            ))}
          </span>
        </span>
      </div>
      {canResume && (
        <div className="pl15">
          {busy?.project === p.name && busy.what === 'resuming'
            ? <span className="cyan">resuming…</span>
            : (
              <Btn
                id={`wake-${p.name}`}
                label={`Resume · ${back} session${back === 1 ? '' : 's'}`}
                variant="primary"
                onPress={() => onWake(p.name)}
              />
            )}
        </div>
      )}
      <NewTaskRow project={p.name} busy={busy} onStartTask={onStartTask} />
    </div>
  );
}

export function App() {
  const [view, setView] = useState<HubView>(EMPTY_VIEW);
  const [acting, setActing] = useState(false);
  const [busy, setBusy] = useState<{ project: string; what: 'resuming' | 'continuing' | 'starting' | 'answering'; who?: string } | null>(null);
  const [pressed, setPressed] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const actingRef = useRef(false);

  // A failed read (network error, or updatedAt 0 from the server) keeps the
  // old data and shows the error line, same as the Ink screen.
  const refresh = useCallback(async () => {
    let next: HubView;
    try {
      const r = await fetch('/api/view');
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

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  // One action at a time: a click while another runs is ignored. The pressed
  // button inverts and everything disables before the network round-trip.
  const act = useCallback(async (
    id: string,
    project: string,
    what: 'resuming' | 'continuing' | 'answering' | 'starting',
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
      setToast(await runAction());
      return true;
    } catch (e) {
      setToast(`${who}: ${e instanceof Error ? e.message.split('\n').pop() : String(e)}`);
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
      const j = await post('/api/wake', { project });
      return `${project}: its orchestrator is coming up; it reports back when its team is up (pane ${j.pane})`;
    });
  }, [act]);

  const onContinue = useCallback((project: string) => {
    void act(`continue-${project}`, project, 'continuing', project, async () => {
      const j = await post('/api/continue', { project });
      return `${project}: its first line was sent (pane ${j.pane})`;
    });
  }, [act]);

  const onAnswer = useCallback((project: string, agentRefArg: string | undefined, seen: string, choice: string, id: string) => {
    const who = agentRefArg ? `${project} · ${agentRefArg}` : project;
    void act(id, project, 'answering', who, async () => {
      const j = await post('/api/answer', { project, agent: agentRefArg, choice, fingerprint: seen });
      return `${who}: answered "${j.option}"${j.dialog_gone ? '' : ' (the dialog is still on its screen)'}`;
    }, agentRefArg);
  }, [act]);

  const onStartTask = useCallback(async (project: string, text: string): Promise<boolean> => {
    return act(`start-${project}`, project, 'starting', project, async () => {
      const t = await post('/api/task', { project, text });
      const j = await post('/api/start', { project, task: t.id });
      return `${project}: its orchestrator is coming up on ${t.id}; it reports back when its team is up (pane ${j.pane})`;
    });
  }, [act]);

  const onSetMode = useCallback((project: string, mode: ProjectMode) => {
    void act(`mode-${project}-${mode}`, project, 'answering', project, async () => {
      await post('/api/mode', { project, mode });
      return `${project}: permission mode is ${mode} (applies to the next launch)`;
    });
  }, [act]);

  const now = Date.now();
  const where = homeTilde(view.root, '');
  const clock = view.updatedAt
    ? new Date(view.updatedAt).toTimeString().slice(0, 5)
    : 'reading…';
  const needs = buildNeeds(view, now);
  const rule = <div className="rule">{'─'.repeat(400)}</div>;

  return (
    <ActionContext.Provider value={{ acting, pressed }}>
      <div className="screen">
        <div className="row">
          <span className="shrink">
            <span className="bold white">HUB</span>
            {where !== '' && <span className="gray">{`  ·  ${where}`}</span>}
          </span>
          <span className="grow0">
            {view.updatedAt !== 0 && <span className="gray">relay  </span>}
            <span className="gray">{clock}</span>
          </span>
        </div>
        {rule}
        {view.error !== '' && <div className="red">{view.error}</div>}

        {needs.length > 0 && (
          <div className="mt">
            <div className="bold magenta">NEEDS YOU</div>
            {needs.map((n: Need) => (
              <div key={n.key} className="pl1">
                <div className="row">
                  <span className="shrink">
                    <span className={n.color}>{`${n.glyph} `}</span>
                    <span className="bold white">{n.who}</span>
                    <span className="white">{`  ${n.words}`}</span>
                  </span>
                  {n.when !== '' && <span className="gray">{n.when}</span>}
                </div>
                {n.dialogKey && (
                  <NeedDialog dialogKey={n.dialogKey} dialogs={view.dialogs} busy={busy} onAnswer={onAnswer} />
                )}
                {n.action === 'continue' && n.project && (
                  <ContinueNeed project={n.project} busy={busy} onContinue={onContinue} />
                )}
              </div>
            ))}
          </div>
        )}

        {view.updatedAt !== 0 && view.projects.length === 0 && view.error === '' && (
          <div className="mt gray">No projects yet: tell the hub which folders make up a project.</div>
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
          />
        ))}

        <div className="mt">
          {rule}
          <div className="row">
            <span className="gray">● running  ○ stopped  ◌ no team</span>
            <button className="btn plain" onClick={() => void refresh()}>refresh</button>
          </div>
        </div>
        {toast && <div className="toast">{toast}</div>}
      </div>
    </ActionContext.Provider>
  );
}
