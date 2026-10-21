import type { HubAgent, HubOrchestrator, HubView } from '../types.js';

export const ROTATE_AT_PERCENT = 50;

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
  action?: 'continue' | 'plan';
  project?: string;
  taskId?: string;
};

export function buildNeeds(view: HubView, now: number): Need[] {
  const needs: Need[] = [];
  if (view.updatedAt && !view.hubName) {
    needs.push({
      key: 'hub', glyph: '!', color: 'red', who: 'hub',
      words: 'has not recorded its session, so nobody can reply to it', when: '',
    });
  }
  // A live orchestrator dialog belongs on the plan card when a plan waits:
  // one card with one answer, not two rows for the same question.
  const planProjects = new Set(
    view.tasks.filter((t) => t.needs_owner && t.state === 'plan').map((t) => t.project),
  );
  const absorbed = new Set<string>();
  for (const t of view.tasks.filter((t) => t.needs_owner)) {
    const look = waitLook(t.state);
    const p = view.projects.find((x) => x.name === t.project);
    const absorb = t.state === 'plan' && p?.orchestrator.question === true && !absorbed.has(t.project);
    if (absorb) absorbed.add(t.project);
    needs.push({
      key: `task-${t.id}`, glyph: look.glyph, color: look.color, who: t.id,
      words: look.words, when: ago(t.updated, now),
      dialogKey: absorb ? t.project : undefined,
      action: t.state === 'plan' ? 'plan' : undefined,
      project: t.state === 'plan' ? t.project : undefined,
      taskId: t.state === 'plan' ? t.id : undefined,
    });
  }
  for (const p of view.projects) {
    if (p.orchestrator.question && !planProjects.has(p.name)) {
      needs.push({
        key: `orch-${p.name}`, glyph: '?', color: 'yellow', who: p.name,
        words: 'its orchestrator has a question on its screen', when: '', dialogKey: p.name,
      });
    }
    for (const a of p.agents.filter((a) => a.question)) {
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
