import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const USED = 'USED';
export const PARTIAL = 'PARTIAL';
export const UNUSED = 'UNUSED';
const STATUSES = [USED, PARTIAL, UNUSED];

export interface Invariant {
  id: string;
  desc: string;
  evidence: string; // repo-relative test file, optionally ::test-name
}

export interface Journey {
  id: string;
  desc: string;
  status: string;
  tracer: string | null; // repo-relative test that proves it, null when UNUSED
  criteria: string[]; // invariant ids
  note?: string;
}

export const INVARIANTS: Invariant[] = [
  { id: 'distinct-task-ids', desc: 'concurrent task records never share an id',
    evidence: 'test/hub.test.ts::hubTask' },
  { id: 'start-validates-task-id', desc: 'start rejects a foreign or missing task id before anything runs',
    evidence: 'test/hub.test.ts::startProject task id' },
  { id: 'fingerprint-before-keys', desc: 'a stale dialog fingerprint refuses before any key is sent',
    evidence: 'test/hub.test.ts::answerDialog on menus' },
  { id: 'no-agent-guess', desc: 'a bare name matching two agents is an error, never a guess',
    evidence: 'test/hub.test.ts::readDialogFor same-named agents' },
  { id: 'decisions-logged', desc: 'every owner, watch, or orchestrator decision lands in decisions.jsonl',
    evidence: 'test/hub.test.ts::decisions from hub actions' },
  { id: 'gate-never-vacuous-green', desc: 'a gate log with no passing steps is RED, and GREEN needs the right commit on a clean tree',
    evidence: 'test/gate.test.ts::verifyLog' },
  { id: 'cleanup-trash-never-delete', desc: 'cleanup trashes only manifest-registered paths under the project home',
    evidence: 'test/cleanup.test.ts::cleanupProject worktree records' },
  { id: 'web-boundary-hardening', desc: 'names are validated at the API boundary, cross-site posts are 403, errors never leak paths',
    evidence: 'test/web.test.ts::request hardening' },
  { id: 'web-actions-serialized', desc: 'actions on one project never overlap',
    evidence: 'test/web.test.ts::action serialization' },
  { id: 'approve-once-only', desc: 'auto-approval only ever picks option 1, never a saves-rule option',
    evidence: 'test/watch.test.ts::watchCycle auto-approver' },
  { id: 'destructive-never-classified', desc: 'destructive commands are never approved and never reach the classifier',
    evidence: 'test/watch-e2e.test.ts::smart approvals against a decoy pane' },
  { id: 'watchdog-rewake-once', desc: 'a dead orchestrator is logged once and re-woken, a dead agent only logged',
    evidence: 'test/watch.test.ts::watchCycle watchdog' },
  { id: 'private-tmux-socket', desc: 'hive only ever drives its own tmux socket',
    evidence: 'test/tmux.test.ts::private socket' },
  { id: 'pane-identity-before-act', desc: 'a pane is killed or typed into only after pid and start time match',
    evidence: 'test/tmux.test.ts::assertPane / killWindow' },
];

export const JOURNEYS: Journey[] = [
  { id: 'TASK_TO_START', desc: 'record a task, start the orchestrator on it',
    status: USED, tracer: 'test/hub.test.ts',
    criteria: ['distinct-task-ids', 'start-validates-task-id'] },
  { id: 'DIALOG_ANSWER', desc: 'a dialog on any agent screen is read and answered under a fingerprint check',
    status: USED, tracer: 'test/hub.test.ts',
    criteria: ['fingerprint-before-keys', 'no-agent-guess', 'decisions-logged'] },
  { id: 'PLAN_REVIEW', desc: 'the owner approves or sends back an orchestrator plan and the verdict is typed in',
    status: USED, tracer: 'test/hub.test.ts',
    criteria: ['decisions-logged'] },
  { id: 'GATE_VERIFY_PUSH', desc: 'the gate runs the steps, gate-verify vouches the commit, push goes by hash',
    status: USED, tracer: 'test/gate.test.ts',
    criteria: ['gate-never-vacuous-green'] },
  { id: 'CLEANUP_TRASH', desc: 'cleanup trashes what hive created and touches nothing else',
    status: USED, tracer: 'test/cleanup.test.ts',
    criteria: ['cleanup-trash-never-delete'] },
  { id: 'AGENT_LIFECYCLE', desc: 'spawn, respawn, and close an agent pane',
    status: USED, tracer: 'test/spawn.test.ts',
    criteria: ['pane-identity-before-act'] },
  { id: 'WATCH_SAFE_TIER', desc: 'safe approvals: whitelisted read-only commands are approved, the rest held',
    status: USED, tracer: 'test/watch.test.ts',
    criteria: ['approve-once-only', 'destructive-never-classified', 'decisions-logged'] },
  { id: 'WATCH_SMART_TIER', desc: 'smart approvals: the classifier decides unknown commands against a decoy pane',
    status: USED, tracer: 'test/watch-e2e.test.ts',
    criteria: ['destructive-never-classified', 'approve-once-only', 'decisions-logged'] },
  { id: 'WATCHDOG_REWAKE', desc: 'dead panes are logged and a dead orchestrator is re-woken once',
    status: USED, tracer: 'test/watch.test.ts',
    criteria: ['watchdog-rewake-once', 'decisions-logged'] },
  { id: 'WEB_HUB_ACTIONS', desc: 'the web screen reads and acts like the CLI: task, start, wake, answer, mode, approvals',
    status: USED, tracer: 'test/web.test.ts',
    criteria: ['web-boundary-hardening', 'web-actions-serialized'] },
  { id: 'TMUX_ISOLATION', desc: 'every pane act stays on the private socket with identity re-verified',
    status: USED, tracer: 'test/tmux.test.ts',
    criteria: ['private-tmux-socket', 'pane-identity-before-act'] },
  { id: 'LIVE_SMOKE', desc: 'a real kimi session through the teamkimi proxy, end to end',
    status: PARTIAL, tracer: 'test/live-smoke.sh',
    criteria: ['private-tmux-socket'],
    note: 'runs by hand, spends API quota, not in the PR gate' },
  { id: 'ORCHESTRATOR_FULL_TASK', desc: 'one task driven record to cleanup by a real orchestrator in one run',
    status: UNUSED, tracer: null,
    criteria: ['gate-never-vacuous-green', 'decisions-logged'],
    note: 'no automated tracer; the pieces are covered separately' },
];

export function coherenceErrors(root: string): string[] {
  const errs: string[] = [];
  const seen = new Set<string>();
  for (const j of JOURNEYS) {
    if (seen.has(j.id)) errs.push(`duplicate journey id: ${j.id}`);
    seen.add(j.id);
    if (!STATUSES.includes(j.status)) errs.push(`${j.id}: unknown status ${j.status}`);
    if (j.criteria.length === 0) errs.push(`${j.id}: has no regression criterion`);
    for (const c of j.criteria) {
      if (!INVARIANTS.some((i) => i.id === c)) errs.push(`${j.id}: unknown criterion ${c}`);
    }
    if (j.status === USED && !j.tracer) errs.push(`${j.id}: marked USED with no tracer`);
    if (j.status === UNUSED && j.tracer) errs.push(`${j.id}: marked UNUSED but names a tracer`);
    if (j.tracer && !existsSync(path.join(root, j.tracer))) {
      errs.push(`${j.id}: tracer missing on disk -> ${j.tracer}`);
    }
  }
  const seenInv = new Set<string>();
  for (const inv of INVARIANTS) {
    if (seenInv.has(inv.id)) errs.push(`duplicate invariant id: ${inv.id}`);
    seenInv.add(inv.id);
    const [file, node] = inv.evidence.split('::');
    const full = path.join(root, file);
    if (!existsSync(full)) {
      errs.push(`invariant ${inv.id}: evidence missing on disk -> ${file}`);
    } else if (node && !readFileSync(full, 'utf8').includes(`describe('${node}'`)) {
      errs.push(`invariant ${inv.id}: evidence test not found in ${file} -> ${node}`);
    }
  }
  return errs;
}
