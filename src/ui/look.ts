import type { Checkpoint, HubAgent, HubOrchestrator, HubTask, HubView } from '../types.js';

export const ROTATE_AT_PERCENT = 50;

// A task with no progress sign in this window reads as stale.
export const STALE_MS = 4 * 60 * 60_000;

const STALE_STATES = new Set(['plan', 'question', 'blocked', 'handed']);

export function staleTask(t: HubTask, now: number): boolean {
  if (!STALE_STATES.has(t.state)) return false;
  // No progress yet: the clock starts at the latest activity, so a rebriefed
  // old task is not instantly stale.
  const at = Date.parse(t.last_progress_at ?? t.updated);
  return !Number.isNaN(at) && now - at > STALE_MS;
}

type TaskProgress = {
  done: number;
  total: number;
  current: string | null;
  lastAt: string | null;
  failed: string[];
};

// The checkpoint trail of one task. null when the task has no plan checkpoints.
export function taskProgress(t: HubTask): TaskProgress | null {
  const cps = t.checkpoints ?? [];
  if (cps.length === 0) return null;
  const progress = t.progress ?? {};
  const terminal = new Set(['ok', 'fail', 'skip']);
  const done = cps.filter((c) => terminal.has(progress[c.id]?.status ?? '')).length;
  let current: string | null = null;
  let currentAt = '';
  for (const c of cps) {
    const p = progress[c.id];
    if (p?.status === 'started' && p.at >= currentAt) {
      current = c.id;
      currentAt = p.at;
    }
  }
  return {
    done,
    total: cps.length,
    current,
    lastAt: t.last_progress_at ?? null,
    failed: cps.filter((c) => progress[c.id]?.status === 'fail').map((c) => c.id),
  };
}

// tmux window names are "<project>:<agent>" (src/tmux.ts windowName); look.ts
// stays web-bundled, so the format is repeated here instead of imported.
export function windowLabel(project: string, agent: string): string {
  return `${project}:${agent}`;
}

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

export function untilLabel(ms: number, now: number): string {
  const d = new Date(ms);
  const hm = d.toTimeString().slice(0, 5);
  return d.toDateString() === new Date(now).toDateString() ? hm : `${d.toDateString().slice(0, 3)} ${hm}`;
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

export function waitLook(state: string): { glyph: string; words: string; color: string } {
  switch (state) {
    case 'plan': return { glyph: '▲', words: 'plan to approve', color: 'magenta' };
    case 'question': return { glyph: '?', words: 'question', color: 'yellow' };
    case 'blocked': return { glyph: '✖', words: 'blocked', color: 'red' };
    default: return { glyph: '•', words: state, color: 'white' };
  }
}

export function agentRef(a: HubAgent): string {
  return a.ref ?? a.name;
}

export function agentGlyph(a: HubAgent): { glyph: string; color: string } {
  if (a.state === 'running') return { glyph: '●', color: 'green' };
  if (a.state === 'stopped') return { glyph: '○', color: 'yellow' };
  if (a.state === 'wedged') return { glyph: '✖', color: 'red' };
  return { glyph: '?', color: 'red' };
}

export function homeTilde(root: string, home: string): string {
  return home && (root === home || root.startsWith(home + '/')) ? `~${root.slice(home.length)}` : root;
}

export type Need = {
  key: string;
  glyph: string;
  color: string;
  who: string;
  words: string;
  when: string;
  dialogKey?: string;
  action?: 'continue' | 'plan' | 'resolve';
  project?: string;
  taskId?: string;
  detail?: string;
  checkpoints?: Checkpoint[];
  stale?: boolean;
};

export function buildNeeds(view: HubView, now: number): Need[] {
  const needs: Need[] = [];
  if (view.updatedAt && !view.hubName) {
    needs.push({
      key: 'hub', glyph: '!', color: 'red', who: 'hub',
      words: 'has not recorded its session, so nobody can reply to it', when: '',
    });
  }
  const actionableProjects = new Set(
    view.projects.filter((p) => p.orchestrator.state !== 'none').map((p) => p.name),
  );
  const actionableTasks = view.tasks.filter((t) => t.needs_owner && actionableProjects.has(t.project));
  // A live orchestrator dialog belongs on the plan card when a plan waits:
  // one card with one answer, not two rows for the same question.
  const planProjects = new Set(
    actionableTasks.filter((t) => t.state === 'plan').map((t) => t.project),
  );
  const absorbed = new Set<string>();
  for (const t of actionableTasks) {
    const look = waitLook(t.state);
    const p = view.projects.find((x) => x.name === t.project);
    const absorb = t.state === 'plan' && p?.orchestrator.question === true
      && p.orchestrator.operator_question !== true && !absorbed.has(t.project);
    if (absorb) absorbed.add(t.project);
    needs.push({
      key: `task-${t.id}`, glyph: look.glyph, color: look.color, who: t.id,
      words: look.words, when: ago(t.updated, now),
      dialogKey: absorb ? t.project : undefined,
      action: t.state === 'plan' ? 'plan' : 'resolve',
      project: t.project,
      taskId: t.id,
      detail: t.last_note?.trim() ? t.last_note : 'no reason recorded',
      checkpoints: t.state === 'plan' ? t.checkpoints ?? [] : undefined,
      stale: staleTask(t, now),
    });
  }
  for (const p of view.projects) {
    if (p.orchestrator.question && p.orchestrator.operator_question !== true && !planProjects.has(p.name)) {
      needs.push({
        key: `orch-${p.name}`, glyph: '?', color: 'yellow', who: p.name,
        words: 'its orchestrator has a question on its screen', when: '', dialogKey: p.name,
      });
    }
    for (const a of p.agents.filter((a) => a.question && a.operator_question !== true)) {
      needs.push({
        key: `agent-${p.name}-${a.ref}`, glyph: '?', color: 'yellow',
        who: `${p.name} · ${agentRef(a)}`, words: 'a question on its screen', when: '',
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
  return needs;
}

export function tasksLine(tasks: { project: string; state: string; updated: string }[], project: string, openTasks: number, now: number): string {
  const mine = tasks.filter((t) => t.project === project);
  const overnight = mine.filter((t) => t.state === 'overnight').length;
  const cleanup = mine.filter((t) => t.state === 'cleanup').length;
  const today = new Date(now).toDateString();
  const doneToday = mine.filter(
    (t) => t.state === 'done' && new Date(t.updated).toDateString() === today,
  ).length;
  let line = `${openTasks} open`;
  if (overnight) line += ` · ${overnight} overnight run${overnight === 1 ? '' : 's'}`;
  if (cleanup) line += ` · ${cleanup} cleanup`;
  if (doneToday) line += ` · ${doneToday} done today`;
  return line;
}
