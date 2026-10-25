import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { HubAgent, HubDialog, HubProject, HubTask, HubView } from '../types.js';
import { answerDialog, continueProject, planAnswer, wake } from '../hub.js';
import {
  ACTION_TIMEOUT_MS, ANSWER_TIMEOUT_MS, buildView, lastLine, withTimeout,
} from '../view.js';
import {
  agentGlyph, agentRef, ago, buildNeeds, homeTilde, orchestratorLook, tasksLine, type Need,
} from './look.js';
import { Button, ButtonScope } from './buttons.js';

const EVERY_MS = 20_000;
const ROTATE_AT_PERCENT = 50;

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

function NeedDialog({
  dialogKey, dialogs, onAnswer,
}: {
  dialogKey: string;
  dialogs: Record<string, HubDialog>;
  onAnswer: (project: string, agentRefArg: string | undefined, seen: string, choice: string) => void;
}) {
  const dialog = dialogs[dialogKey];
  if (!dialog) return null;
  const [project, agent] = dialogKey.split('/');
  return <DialogBlock dialog={dialog} onAnswer={(choice) => onAnswer(project, agent, dialog.fingerprint, choice)} />;
}

function NeedAction({
  need, acting, busy, onContinue,
}: {
  need: Need;
  acting: boolean;
  busy: { project: string; what: string } | null;
  onContinue: (project: string) => void;
}) {
  if (need.action !== 'continue' || !need.project) return null;
  const project = need.project;
  return (
    <Box paddingLeft={2}>
      {busy?.project === project && busy.what === 'continuing'
        ? <Text color="cyan">continuing…</Text>
        : <Button label="Continue" onPress={() => onContinue(project)} disabled={acting} />}
    </Box>
  );
}

// One-line text entry for the send-back verdict; Esc cancels, Enter sends.
function FeedbackPrompt({ onSubmit, onCancel }: { onSubmit: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState('');
  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      onSubmit(text);
      return;
    }
    if (key.backspace || key.delete) {
      setText((t) => t.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta && !key.tab) setText((t) => t + input);
  });
  return (
    <Box paddingLeft={2}>
      <Text color="white">feedback: </Text>
      {text === ''
        ? <Text color="gray">what should change? (optional)</Text>
        : <Text color="white">{text}</Text>}
      <Text inverse> </Text>
    </Box>
  );
}

function NeedPlan({
  need, acting, busy, feedbackOpen, onApprove, onSendBack, onFeedback, onCancelFeedback,
}: {
  need: Need;
  acting: boolean;
  busy: { project: string; what: string; who?: string } | null;
  feedbackOpen: boolean;
  onApprove: (project: string, taskId: string) => void;
  onSendBack: (taskId: string) => void;
  onFeedback: (project: string, taskId: string, text: string) => void;
  onCancelFeedback: () => void;
}) {
  if (need.action !== 'plan' || need.dialogKey || !need.project || !need.taskId) return null;
  const project = need.project;
  const taskId = need.taskId;
  if (busy?.what === 'answering' && busy.who === taskId) {
    return <Box paddingLeft={2}><Text color="cyan">answering…</Text></Box>;
  }
  if (feedbackOpen) {
    return <FeedbackPrompt onSubmit={(text) => onFeedback(project, taskId, text)} onCancel={onCancelFeedback} />;
  }
  return (
    <Box paddingLeft={2} columnGap={1}>
      <Button label="a approve plan" hotkey="a" onPress={() => onApprove(project, taskId)} disabled={acting} />
      <Button label="b send back" hotkey="b" onPress={() => onSendBack(taskId)} disabled={acting} />
    </Box>
  );
}

export function HubApp({ root }: { root: string }) {
  const [view, setView] = useState<HubView>({
    root, hubName: '', projects: [], tasks: [], dialogs: {}, decisions: [], questions: [], updatedAt: 0, error: '',
  });
  const [acting, setActing] = useState(false);
  const [busy, setBusy] = useState<{ project: string; what: 'resuming' | 'continuing' | 'answering'; who?: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [sendingBack, setSendingBack] = useState<string | null>(null);
  const actingRef = useRef(false);
  // Read at key-event time, so keys in the same stdin chunk as `b` already see it.
  const planInputActiveRef = useRef(false);

  // A failed status read (updatedAt 0) keeps the old data, shows the error.
  const refresh = useCallback(async () => {
    const next = await buildView(root);
    setView((v) => (next.updatedAt === 0 && next.error ? { ...v, error: next.error } : next));
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
    setBusy({ project, what, who });
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

  const onAnswer = useCallback((project: string, agentRefArg: string | undefined, seen: string, choice: string) => {
    const who = agentRefArg ? `${project} · ${agentRefArg}` : project;
    void act(project, 'answering', who, async () => {
      const r = await withTimeout(
        answerDialog(root, project, agentRefArg, choice, seen), ANSWER_TIMEOUT_MS, 'answer',
      );
      return `${who}: answered "${r.option}"${r.dialog_gone ? '' : ' (the dialog is still on its screen)'}`;
    });
  }, [act, root]);

  const onPlanAnswer = useCallback((project: string, taskId: string, verdict: 'approve' | 'sendback', feedback?: string) => {
    void act(project, 'answering', taskId, async () => {
      await withTimeout(planAnswer(root, project, taskId, verdict, feedback), ANSWER_TIMEOUT_MS, 'plan-answer');
      return verdict === 'approve' ? `${taskId}: plan approved` : `${taskId}: plan sent back`;
    });
  }, [act, root]);

  const onPlanApprove = useCallback((project: string, taskId: string) => {
    onPlanAnswer(project, taskId, 'approve');
  }, [onPlanAnswer]);

  const onSendBack = useCallback((taskId: string) => {
    planInputActiveRef.current = true;
    setSendingBack(taskId);
  }, []);

  const onFeedback = useCallback((project: string, taskId: string, text: string) => {
    planInputActiveRef.current = false;
    setSendingBack(null);
    onPlanAnswer(project, taskId, 'sendback', text.trim() || undefined);
  }, [onPlanAnswer]);

  const onCancelFeedback = useCallback(() => {
    planInputActiveRef.current = false;
    setSendingBack(null);
  }, []);

  const now = Date.now();
  const where = homeTilde(root, process.env.HOME ?? '');
  const clock = view.updatedAt
    ? new Date(view.updatedAt).toTimeString().slice(0, 5)
    : 'reading…';

  const needs = buildNeeds(view, now);

  const columns = process.stdout.columns || 60;
  const rows = process.stdout.rows || 24;
  const width = Math.max(36, columns);
  const inner = width - 2;
  const rule = <Text color="gray">{'─'.repeat(inner)}</Text>;

  return (
    <ButtonScope suspended={planInputActiveRef}>
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
                <NeedAction need={n} acting={acting} busy={busy} onContinue={onContinue} />
                <NeedPlan
                  need={n}
                  acting={acting}
                  busy={busy}
                  feedbackOpen={sendingBack === n.taskId}
                  onApprove={onPlanApprove}
                  onSendBack={onSendBack}
                  onFeedback={onFeedback}
                  onCancelFeedback={onCancelFeedback}
                />
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
              <Text color="yellow">{notRunning.map((a) => `${agentRef(a)} ${a.state}`).join(', ')}</Text>
            )}
          </>
        )}
      </Row>
      <Row label="tasks">
        <Text color="white">{tasksLine(tasks, p.name, p.open_tasks, now)}</Text>
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
