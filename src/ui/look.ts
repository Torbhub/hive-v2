import type { Checkpoint, HubAgent, HubOrchestrator, HubTask, HubView, RootContract } from '../types.js';
import { orchestratorName, withoutPaneIds } from '../window-name.js';

export { orchestratorName, windowName as windowLabel } from '../window-name.js';

export const ROTATE_AT_PERCENT = 50;

export const STALE_MS = 4 * 60 * 60_000;

const STALE_STATES = new Set(['plan', 'question', 'blocked', 'handed']);

export function staleTask(t: HubTask, now: number): boolean {
  if (!STALE_STATES.has(t.state)) return false;
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
    case 'unknown': return { dot: '?', word: 'state unknown', color: 'red' };
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
  contract?: RootContract | null;
  planDigest?: string | null;
  stale?: boolean;
};

export function contractLines(need: Pick<Need, 'contract' | 'planDigest'>): string[] {
  const lines = ['Root contract', `Plan digest: ${need.planDigest ?? '(not recorded)'}`];
  const contract = need.contract;
  if (!contract) return [...lines, 'No root contract is recorded.'];
  lines.push(
    `Schema: ${contract.schema_version}`,
    `Kind: ${contract.kind}`,
    `Objective: ${contract.objective}`,
    `Consumer: ${contract.consumer}`,
    `Deliverable: ${contract.deliverable}`,
  );
  for (const acceptance of contract.acceptance) {
    const configuration = (JSON.stringify(acceptance.configuration, null, 2) ?? '{}').split('\n');
    lines.push(
      `Acceptance ${acceptance.id}: ${acceptance.predicate_id} v${acceptance.version}`,
      `  Required: ${acceptance.required !== false}`,
      `  Configuration: ${configuration[0]}`,
      ...configuration.slice(1).map((line) => `    ${line}`),
      `  Evidence: ${acceptance.required_evidence.join(', ')}`,
    );
  }
  const provenance = contract.provenance;
  lines.push(`Provenance kind: ${provenance.kind ?? 'code'}`);
  if (provenance.kind === 'research') {
    lines.push(`Source range: ${provenance.source_range.start} → ${provenance.source_range.end}`);
    for (const source of provenance.source_range.sources) {
      lines.push(`  Source ${source.id}: ${source.path} sha256=${source.sha256} observed_at=${source.observed_at}`);
    }
    lines.push(`Evidence window: ${provenance.evidence_window.starts_at} → ${provenance.evidence_window.ends_at}`);
  } else {
    lines.push(
      `Repository: ${provenance.repository}`,
      `Base revision: ${provenance.base_revision}`,
      `Artifact revision: ${provenance.artifact_revision}`,
    );
  }
  const budget = [
    `depth=${contract.budget.depth}`,
    `active_children=${contract.budget.active_children}`,
    `active_project_records=${contract.budget.active_project_records}`,
    `attempts=${contract.budget.attempts}`,
  ];
  if (contract.budget.wall_seconds !== undefined) budget.push(`wall_seconds=${contract.budget.wall_seconds}`);
  lines.push(
    `Write scope: ${contract.write_scope.join(', ') || '(none)'}`,
    `Action scope: ${contract.action_scope.join(', ') || '(none)'}`,
    `Budget: ${budget.join(', ')}`,
    `Delegated output claims: ${contract.delegation.output_claims.join(', ')}`,
    `Delegated adapters: ${contract.delegation.adapters.join(', ')}`,
  );
  if (contract.required_children !== undefined) {
    lines.push(`Required children: ${contract.required_children.join(', ') || '(none)'}`);
  }
  if (contract.preflight_snapshot !== undefined) lines.push(`Preflight snapshot: ${contract.preflight_snapshot}`);
  if (contract.defect_fingerprint !== undefined) lines.push(`Defect fingerprint: ${contract.defect_fingerprint}`);
  return lines;
}

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
  const planProjects = new Set(
    actionableTasks.filter((t) => t.state === 'plan').map((t) => t.project),
  );
  const absorbed = new Set<string>();
  for (const t of actionableTasks) {
    const look = waitLook(t.state);
    const p = view.projects.find((x) => x.name === t.project);
    const dialog = p?.orchestrator.screen_question
      ?? (p?.orchestrator.question === true && p.orchestrator.operator_question !== true);
    const absorb = t.state === 'plan' && dialog === true && !absorbed.has(t.project);
    if (absorb) absorbed.add(t.project);
    needs.push({
      key: `task-${t.id}`, glyph: look.glyph, color: look.color, who: t.id,
      words: look.words, when: ago(t.updated, now),
      dialogKey: absorb ? t.project : undefined,
      action: t.state === 'plan' ? 'plan' : 'resolve',
      project: t.project,
      taskId: t.id,
      detail: t.state === 'plan' && t.plan_text?.trim() ? withoutPaneIds(t.plan_text)
        : t.last_note?.trim() ? withoutPaneIds(t.last_note) : 'no reason recorded',
      checkpoints: t.state === 'plan' ? t.checkpoints ?? [] : undefined,
      contract: t.state === 'plan' ? t.contract ?? null : undefined,
      planDigest: t.state === 'plan' ? t.plan_digest ?? null : undefined,
      stale: staleTask(t, now),
    });
  }
  for (const p of view.projects) {
    const orchDialog = p.orchestrator.screen_question
      ?? (p.orchestrator.question === true && p.orchestrator.operator_question !== true);
    if (orchDialog && !planProjects.has(p.name)) {
      needs.push({
        key: `orch-${p.name}`, glyph: '?', color: 'yellow', who: p.name,
        words: 'its orchestrator has a question on its screen', when: '', dialogKey: p.name,
      });
    }
    for (const a of p.agents.filter((a) => a.screen_question ?? (a.question && !a.operator_question))) {
      needs.push({
        key: `agent-${p.name}-${a.ref}`, glyph: '?', color: 'yellow',
        who: `${p.name} · ${agentRef(a)}`, words: 'a question on its screen', when: '',
        dialogKey: `${p.name}/${a.ref}`,
      });
    }
    const s = p.orchestrator.starting;
    if (s && !s.typed && !s.sending) {
      const name = p.orchestrator.name ?? orchestratorName(p.name);
      needs.push({
        key: `starting-${p.name}`, glyph: '?', color: 'yellow', who: p.name,
        words: s.question
          ? `${name} has a question on its screen: answer it, then Continue`
          : `waiting for ${name}'s first line`,
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
