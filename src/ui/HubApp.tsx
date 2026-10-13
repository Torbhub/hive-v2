import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import type { HubAgent, HubDialog, HubOrchestrator, HubProject, HubTask, HubView } from '../types.js';
import { answerDialog, buildStatus, continueProject, listTasks, readDialogFor, wake } from '../hub.js';
import { Button, ButtonScope } from './buttons.js';

const EVERY_MS = 20_000;
const READ_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 150_000;
const ANSWER_TIMEOUT_MS = 30_000;
const ROTATE_AT_PERCENT = 50;

export function ago(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export type OrchestratorLook = { dot: string; word: string; color: string };

export function orchestratorLook(o: HubOrchestrator): OrchestratorLook {
  if (o.starting && o.state !== 'running') {
    return o.starting.typed || o.starting.sending
      ? { dot: '◐', word: 'coming up', color: 'cyan' }
      : { dot: '◐', word: 'waiting on you', color: 'magenta' };
  }
  switch (o.state) {
    case 'running': return { dot: '●', word: 'running', color: 'green' };
    case 'stopped': return { dot: '○', word: 'stopped', color: 'yellow' };
    case 'unknown': return { dot: '?', word: 'cannot tell', color: 'red' };
    case 'none': return { dot: '◌', word: 'no team', color: 'gray' };
    case 'unregistered': return { dot: '◑', word: 'not registered', color: 'magenta' };
    case 'resumable': return { dot: '○', word: 'stopped, not registered', color: 'yellow' };
    default: return { dot: '?', word: 'cannot tell', color: 'red' };
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

function lastLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const line = msg.split('\n').filter((l) => l.trim()).pop() ?? msg;
  return line.replace(/^hive: /, '');
}

function waitLook(state: string): { glyph: string; words: string; color: string } {
  switch (state) {
    case 'plan': return { glyph: '▲', words: 'plan to approve', color: 'magenta' };
    case 'question': return { glyph: '?', words: 'question', color: 'yellow' };
    case 'blocked': return { glyph: '✖', words: 'blocked', color: 'red' };
    default: return { glyph: '•', words: state, color: 'white' };
  }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box paddingLeft={1}>
      <Box width={14} flexShrink={0}>
        <Text color="gray">{label}</Text>
      </Box>
      <Box flexDirection="column" flexShrink={1}>
        {children}
      </Box>
    </Box>
  );
}

function DialogBlock({
  dialog, onAnswer,
}: {
  dialog: HubDialog;
  onAnswer: (choice: string) => void;
}) {
  const textLines = dialog.text
    .split('\n')
    .filter((l) => !/^[\s─╌]*$/.test(l))
    .slice(-14);
  const offered = dialog.options.filter((o) => o.offered);
  const notOffered = dialog.options.filter((o) => !o.offered);
  return (
    <Box flexDirection="column" paddingLeft={3}>
      {textLines.map((l, i) => (
        <Text key={i} color="gray" wrap="truncate-end">{l}</Text>
      ))}
      {(offered.length > 0 || dialog.esc) && (
        <Box flexWrap="wrap" columnGap={1}>
          {offered.map((o) => (
            <Button
              key={o.n}
              label={`${o.n} ${o.label}${o.saves_rule ? ' (saves a rule)' : ''}`}
              onPress={() => onAnswer(String(o.n))}
            />
          ))}
          {dialog.esc && <Button label="Esc" onPress={() => onAnswer('esc')} />}
        </Box>
      )}
      {offered.filter((o) => o.detail !== '').map((o) => (
        <Text key={o.n} color="gray" wrap="truncate-end">{`${o.n}. ${o.label} ${o.detail}`}</Text>
      ))}
      {(notOffered.length > 0 || offered.length === 0) && (
        <Text color="yellow">
          {dialog.options.length === 0
            ? 'answer it in the pane'
            : `${notOffered.map((o) => o.label).join(', ') || 'this dialog'}: answer it in the pane`}
        </Text>
      )}
    </Box>
  );
}

type Need = {
  key: string;
  glyph: string;
  color: string;
  who: string;
  words: string;
  when: string;
  dialogKey?: string;
  action?: 'continue';
  project?: string;
};

export function HubApp({ root }: { root: string }) {
  const [view, setView] = useState<HubView>({
    root, hubName: '', projects: [], tasks: [], dialogs: {}, updatedAt: 0, error: '',
  });
  const [acting, setActing] = useState(false);
  const [busy, setBusy] = useState<{ project: string; what: 'resuming' | 'continuing' } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const actingRef = useRef(false);

  const refresh = useCallback(async () => {
    let status;
    try {
      status = await withTimeout(buildStatus(root), READ_TIMEOUT_MS, 'status');
    } catch (e) {
      setView((v) => ({ ...v, error: lastLine(e) }));
      return;
    }
    let tasks: HubTask[] | null = null;
    let error = '';
    try {
      tasks = await withTimeout(listTasks(root), READ_TIMEOUT_MS, 'tasks');
    } catch (e) {
      error = `tasks not read: ${lastLine(e)}`;
    }
    const dialogs: Record<string, HubDialog> = {};
    const jobs: Promise<void>[] = [];
    for (const p of status.projects) {
      if (p.orchestrator.question || p.orchestrator.starting?.question) {
        jobs.push(readDialogFor(root, p.name).then((d) => {
          if (d) dialogs[p.name] = d;
        }).catch(() => {}));
      }
      for (const a of p.agents) {
        if (a.question && a.ref) {
          jobs.push(readDialogFor(root, p.name, a.ref).then((d) => {
            if (d) dialogs[`${p.name}/${a.ref}`] = d;
          }).catch(() => {}));
        }
      }
    }
    await Promise.all(jobs);
    setView((v) => ({
      ...v,
      hubName: status.hub.name ?? '',
      projects: status.projects,
      tasks: tasks ?? v.tasks,
      dialogs,
      updatedAt: Date.now(),
      error,
    }));
  }, [root]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), EVERY_MS);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  // One action at a time: a press while another runs is ignored.
  const act = useCallback(async (
    project: string,
    what: 'resuming' | 'continuing' | 'answering',
    who: string,
    runAction: () => Promise<string>,
  ) => {
    if (actingRef.current) return;
    actingRef.current = true;
    setActing(true);
    if (what !== 'answering') setBusy({ project, what });
    try {
      setToast(await runAction());
    } catch (e) {
      setToast(`${who}: ${lastLine(e)}`);
    } finally {
      actingRef.current = false;
      setActing(false);
      setBusy(null);
      void refresh();
    }
  }, [refresh]);

  const onWake = useCallback((project: string) => {
    void act(project, 'resuming', project, async () => {
      const pane = await withTimeout(wake(root, project), ACTION_TIMEOUT_MS, 'wake');
      return `${project}: its orchestrator is coming up; it reports back when its team is up (pane ${pane})`;
    });
  }, [act, root]);

  const onContinue = useCallback((project: string) => {
    void act(project, 'continuing', project, async () => {
      const pane = await withTimeout(continueProject(root, project), ACTION_TIMEOUT_MS, 'continue');
      return `${project}: its first line was sent (pane ${pane})`;
    });
  }, [act, root]);

  const onAnswer = useCallback((project: string, agentRef: string | undefined, seen: string, choice: string) => {
    const who = agentRef ? `${project} · ${agentRef}` : project;
    void act(project, 'answering', who, async () => {
      const r = await withTimeout(
        answerDialog(root, project, agentRef, choice, seen), ANSWER_TIMEOUT_MS, 'answer',
      );
      return `${who}: answered "${r.option}"${r.dialog_gone ? '' : ' (the dialog is still on its screen)'}`;
    });
  }, [act, root]);

  const now = Date.now();
  const home = process.env.HOME ?? '';
  const where = home && (root === home || root.startsWith(home + '/')) ? `~${root.slice(home.length)}` : root;
  const clock = view.updatedAt
    ? new Date(view.updatedAt).toTimeString().slice(0, 5)
    : 'reading…';

  const needs: Need[] = [];
  if (view.updatedAt && !view.hubName) {
    needs.push({
      key: 'hub', glyph: '!', color: 'red', who: 'hub',
      words: 'has not recorded its session, so nobody can reply to it', when: '',
    });
  }
  for (const t of view.tasks.filter((t) => t.needs_owner)) {
    const look = waitLook(t.state);
    needs.push({
      key: `task-${t.id}`, glyph: look.glyph, color: look.color, who: t.id,
      words: look.words, when: ago(t.updated, now),
    });
  }
  for (const p of view.projects) {
    if (p.orchestrator.question) {
      needs.push({
        key: `orch-${p.name}`, glyph: '?', color: 'yellow', who: p.name,
        words: 'its orchestrator has a question on its screen', when: '', dialogKey: p.name,
      });
    }
    for (const a of p.agents.filter((a) => a.question)) {
      needs.push({
        key: `agent-${p.name}-${a.ref}`, glyph: '?', color: 'yellow',
        who: `${p.name} · ${a.ref}`, words: 'a question on its screen', when: '',
        dialogKey: `${p.name}/${a.ref}`,
      });
    }
    const s = p.orchestrator.starting;
    if (s && !s.typed && !s.sending) {
      needs.push({
        key: `starting-${p.name}`, glyph: '?', color: 'yellow', who: p.name,
        words: s.question
          ? `a question on the screen of pane ${s.pane}: answer it, then Continue`
          : `waiting in pane ${s.pane} for its first line`,
        when: ago(s.at, now),
        dialogKey: s.question ? p.name : undefined,
        action: 'continue', project: p.name,
      });
    }
  }

  const columns = process.stdout.columns || 60;
  const rows = process.stdout.rows || 24;
  const width = Math.max(36, columns);
  const inner = width - 2;
  const rule = <Text color="gray">{'─'.repeat(inner)}</Text>;

  return (
    <ButtonScope>
      <Box flexDirection="column" backgroundColor="black" width={width} minHeight={rows} paddingX={1}>
        <Box justifyContent="space-between">
          <Box flexShrink={1}>
            <Text bold color="white">HUB</Text>
            {where !== '' && <Text color="gray" wrap="truncate-start">{`  ·  ${where}`}</Text>}
          </Box>
          <Box flexShrink={0} paddingLeft={2}>
            {view.updatedAt !== 0 && <Text color="gray">relay  </Text>}
            <Text color="gray">{clock}</Text>
          </Box>
        </Box>
        {rule}
        {view.error !== '' && <Text color="red">{view.error}</Text>}

        {needs.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="magenta">NEEDS YOU</Text>
            {needs.map((n) => (
              <Box key={n.key} flexDirection="column" paddingLeft={1}>
                <Box justifyContent="space-between">
                  <Box flexShrink={1}>
                    <Text color={n.color}>{`${n.glyph} `}</Text>
                    <Text bold color="white">{n.who}</Text>
                    <Text color="white" wrap="wrap">{`  ${n.words}`}</Text>
                  </Box>
                  {n.when !== '' && <Text color="gray">{n.when}</Text>}
                </Box>
                {n.dialogKey && (
                  <NeedDialog dialogKey={n.dialogKey} dialogs={view.dialogs} onAnswer={onAnswer} />
                )}
                {n.action === 'continue' && n.project && (
                  <Box paddingLeft={2}>
                    {busy?.project === n.project && busy.what === 'continuing'
                      ? <Text color="cyan">continuing…</Text>
                      : <Button label="Continue" onPress={() => onContinue(n.project!)} disabled={acting} />}
                  </Box>
                )}
              </Box>
            ))}
          </Box>
        )}

        {view.updatedAt !== 0 && view.projects.length === 0 && view.error === '' && (
          <Box marginTop={1}>
            <Text color="gray">No projects yet: tell the hub which folders make up a project.</Text>
          </Box>
        )}

        {view.projects.map((p) => (
          <ProjectCard
            key={p.name}
            project={p}
            tasks={view.tasks}
            now={now}
            acting={acting}
            busy={busy}
            onWake={onWake}
          />
        ))}

        <Box flexDirection="column" marginTop={1}>
          {rule}
          <Box justifyContent="space-between">
            <Text color="gray">● running  ○ stopped  ◌ no team</Text>
            <Button label="refresh" variant="plain" hotkey="r" onPress={() => void refresh()} />
          </Box>
        </Box>
        {toast && (
          <Box marginTop={1}>
            <Text color="cyan">{toast}</Text>
          </Box>
        )}
      </Box>
    </ButtonScope>
  );
}

function NeedDialog({
  dialogKey, dialogs, onAnswer,
}: {
  dialogKey: string;
  dialogs: Record<string, HubDialog>;
  onAnswer: (project: string, agentRef: string | undefined, seen: string, choice: string) => void;
}) {
  const dialog = dialogs[dialogKey];
  if (!dialog) return null;
  const [project, agent] = dialogKey.split('/');
  return <DialogBlock dialog={dialog} onAnswer={(choice) => onAnswer(project, agent, dialog.fingerprint, choice)} />;
}

function agentGlyph(a: HubAgent): { glyph: string; color: string } {
  if (a.state === 'running') return { glyph: '●', color: 'green' };
  if (a.state === 'stopped') return { glyph: '○', color: 'yellow' };
  return { glyph: '?', color: 'red' };
}

function ProjectCard({
  project: p, tasks, now, acting, busy, onWake,
}: {
  project: HubProject;
  tasks: HubTask[];
  now: number;
  acting: boolean;
  busy: { project: string; what: string } | null;
  onWake: (project: string) => void;
}) {
  const look = orchestratorLook(p.orchestrator);
  const o = p.orchestrator;

  const orchName = o.state === 'none' ? 'none yet' : o.name ?? '?';
  const mine = tasks.filter((t) => t.project === p.name);
  const overnight = mine.filter((t) => t.state === 'overnight').length;
  const cleanup = mine.filter((t) => t.state === 'cleanup').length;
  const today = new Date(now).toDateString();
  const doneToday = mine.filter(
    (t) => t.state === 'done' && new Date(t.updated).toDateString() === today,
  ).length;
  let tasksLine = `${p.open_tasks} open`;
  if (overnight) tasksLine += ` · ${overnight} overnight run${overnight === 1 ? '' : 's'}`;
  if (cleanup) tasksLine += ` · ${cleanup} cleanup`;
  if (doneToday) tasksLine += ` · ${doneToday} done today`;

  const up = p.agents.filter((a) => a.state === 'running').length;
  const notRunning = p.agents.filter((a) => a.state !== 'running');

  const canResume =
    (o.state === 'stopped' || o.state === 'resumable') && Boolean(o.session_id) && !o.starting;
  const back = 1 + p.agents.filter((a) => a.state === 'stopped').length;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box justifyContent="space-between">
        <Text bold color="white">{p.name.toUpperCase()}</Text>
        <Text color={look.color}>{`${look.dot} ${look.word}`}</Text>
      </Box>
      <Row label="orchestrator">
        <Box>
          <Text color="white">{orchName}</Text>
          {o.state === 'unregistered' && o.pane && <Text color="gray">{`  pane ${o.pane}`}</Text>}
          {typeof o.context === 'number' && (
            <Text color={o.context_assumed ? 'gray' : o.context >= ROTATE_AT_PERCENT ? 'yellow' : 'green'}>
              {`  ${o.context}%`}
            </Text>
          )}
          {o.context_unknown && <Text color="gray">  context unknown</Text>}
        </Box>
      </Row>
      <Row label="agents">
        {p.agents.length === 0 ? (
          <Text color="gray">none</Text>
        ) : (
          <>
            <Box>
              {p.agents.map((a) => {
                const g = agentGlyph(a);
                return <Text key={a.ref ?? a.name} color={g.color}>{`${g.glyph} `}</Text>;
              })}
              <Text color="white">{` ${up} of ${p.agents.length}`}</Text>
            </Box>
            {notRunning.length > 0 && (
              <Text color="yellow">{notRunning.map((a) => `${a.ref} ${a.state}`).join(', ')}</Text>
            )}
          </>
        )}
      </Row>
      <Row label="tasks">
        <Text color="white">{tasksLine}</Text>
      </Row>
      <Row label="folders">
        {p.repos.map((r) => (
          <Text key={r.folder} color="white" wrap="truncate-end">
            {`${r.folder}${r.changed ? `  ${r.changed} changed` : ''}`}
          </Text>
        ))}
      </Row>
      {canResume && (
        <Box paddingLeft={15}>
          {busy?.project === p.name && busy.what === 'resuming'
            ? <Text color="cyan">resuming…</Text>
            : (
              <Button
                label={`Resume · ${back} session${back === 1 ? '' : 's'}`}
                variant="primary"
                onPress={() => onWake(p.name)}
                disabled={acting}
              />
            )}
        </Box>
      )}
    </Box>
  );
}
