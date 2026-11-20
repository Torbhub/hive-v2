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
  { id: 'watchdog-rewake-once', desc: 'a dead orchestrator is logged once and re-woken, a dead agent resumes its session',
    evidence: 'test/watch.test.ts::watchCycle watchdog' },
  { id: 'private-tmux-socket', desc: 'hive only ever drives its own tmux socket',
    evidence: 'test/tmux.test.ts::private socket' },
  { id: 'pane-identity-before-act', desc: 'a pane is killed or typed into only after pid and start time match',
    evidence: 'test/tmux.test.ts::assertPane / killWindow' },
  { id: 'plan-needs-checkpoints', desc: 'a plan without valid checkpoints is rejected and cannot be approved',
    evidence: 'test/hub.test.ts::plan gate' },
  { id: 'locked-task-transitions', desc: 'task fold, guard, and append stay under one hub lock',
    evidence: 'test/hub.test.ts::atomic task transitions' },
  { id: 'plan-answer-current-lease', desc: 'a delayed answer needs the same plan digest and lease epoch',
    evidence: 'test/hub.test.ts::atomic task transitions' },
  { id: 'receipt-current-evidence', desc: 'only the current reconciling receipt with bound evidence passes',
    evidence: 'test/hub.test.ts::task receipts' },
  { id: 'revocation-fences-receipts', desc: 'cancellation fences actors until fresh admission',
    evidence: 'test/hub.test.ts::task receipts' },
  { id: 'hard-deny-before-auto', desc: 'hard denies run before auto, cache, and tiered approvals',
    evidence: 'test/watch.test.ts::watchCycle hard denies in auto mode' },
  { id: 'no-spawn-before-plan-approval', desc: 'task workers never spawn without an approved plan',
    evidence: 'test/spawn.test.ts::spawn gate' },
  { id: 'normalized-writer-leases', desc: 'only one active writer covers an overlapping normalized path prefix',
    evidence: 'test/admission.test.ts::tmux admission leases' },
  { id: 'attempt-lineage-budget', desc: 'replacement and restart attempts accumulate across IDs and cap changes',
    evidence: 'test/admission.test.ts::tmux replacement lineage' },
  { id: 'current-grant-before-launch', desc: 'registration and typing need the current digest, epoch, and lease',
    evidence: 'test/spawn.test.ts::spawn gate' },
  { id: 'scope-diff-fences-lease', desc: 'an out-of-scope Git change revokes the writer lease and fails',
    evidence: 'test/scope.test.ts::git_diff_scope' },
  { id: 'locked-team-mutations', desc: 'kill and maintenance writes compare the full record before mutation',
    evidence: 'test/kill.test.ts::killAgent one agent' },
  { id: 'wake-current-lease', desc: 'a dead tasked worker re-wakes only through its current lease',
    evidence: 'test/spawn.test.ts::spawn gate' },
  { id: 'public-contract-intake', desc: 'public plan intake validates and persists the root contract digest',
    evidence: 'test/web.test.ts::POST /api/task-plan' },
  { id: 'exact-lease-revocation', desc: 'evidence, cancellation, and scope release target only the exact lease',
    evidence: 'test/admission.test.ts::worker evidence and cancellation' },
  { id: 'relaunch-cleanup', desc: 'a failed relaunch kills its new pane and leaves a closed outcome',
    evidence: 'test/spawn.test.ts::tasked relaunch cleanup' },
  { id: 'owned-lock-release', desc: 'a live stalled lock holder stays exclusive and an old holder cannot remove its successor',
    evidence: 'test/state.test.ts::withTeamLock' },
  { id: 'done-needs-all-checkpoints', desc: 'done is rejected until every checkpoint is terminal',
    evidence: 'test/hub.test.ts::done gate' },
  { id: 'fail-needs-owner-accept', desc: 'a failed checkpoint blocks done until the owner accepts it',
    evidence: 'test/hub.test.ts::done gate' },
  { id: 'progress-never-changes-state', desc: 'progress events never rewrite the headline task state',
    evidence: 'test/tasks.test.ts::progress folding' },
  { id: 'registered-evidence-done', desc: 'done needs current registered evidence, successful operations, children, and no writers',
    evidence: 'test/evidence.test.ts::evidence outcomes' },
  { id: 'terminal-outcome-guards', desc: 'terminal outcomes name their cover or replacement and never hide live operations',
    evidence: 'test/evidence.test.ts::evidence outcomes' },
  { id: 'push-operation-binding', desc: 'push grants bind the current contract and lease, and one operation pushes at most once',
    evidence: 'test/push-consumption.test.ts::contract-bound push operations' },
  { id: 'scoped-auto-push', desc: 'auto cancels native mutations and dispatches only declared push grants through the real registry',
    evidence: 'test/watch.test.ts::watchCycle auto-approver' },
  { id: 'root-delta-version', desc: 'one root delta changes digest and epoch and re-admits only valid child lineages',
    evidence: 'test/questions.test.ts::root scope deltas' },
  { id: 'legacy-auto-fenced', desc: 'legacy auto panes keep their processes but lose every watch action until explicit migration',
    evidence: 'test/watch.test.ts::watchCycle auto-approver' },
  { id: 'managed-auto-no-yolo', desc: 'managed auto launch and resume omit -y while explicit yolo keeps it',
    evidence: 'test/spawn.test.ts::launchCommand' },
  { id: 'strict-auto-routing', desc: 'auto allows only vetted read-only or exact declared commands; diff, show, and every JJ command route through a root delta',
    evidence: 'test/watch.test.ts::watchCycle auto-approver' },
  { id: 'pending-launch-provenance', desc: 'pending and direct orchestrator input needs recorded scoped-launch provenance before typing',
    evidence: 'test/watch.test.ts::watchCycle pending launch' },
  { id: 'delta-read-acl', desc: 'root-delta visibility uses the root task ACL and hides contract provenance from other readers',
    evidence: 'test/web.test.ts::root-delta question read authorization' },
  { id: 'agent-text-redacted', desc: 'command text is redacted in cards and logs without changing the approved digest',
    evidence: 'test/watch.test.ts::watchCycle auto-approver' },
  { id: 'trust-lane-identity', desc: 'only an exact new-lane trust menu receives identity-checked keys',
    evidence: 'test/spawn.test.ts::trust dialog at spawn' },
  { id: 'approved-command-consumption', desc: 'only the exact approved command is declared after a root delta and different commands need a new delta',
    evidence: 'test/watch.test.ts::watchCycle auto-approver' },
  { id: 'native-read-admission', desc: 'native branches reserve read-only leases from the root contract before creation',
    evidence: 'test/admission.test.ts::native admission leases' },
  { id: 'native-result-evidence', desc: 'native results pass only exact stored history and evidence hashes',
    evidence: 'test/evidence.test.ts::native result evidence' },
  { id: 'native-exact-rejoin', desc: 'human review and exact delivery proof govern native rejoin and lease release',
    evidence: 'test/branches.test.ts::selective rejoin and exact delivery fencing' },
  { id: 'github-external-identity', desc: 'GitHub checks recover by identity and resume one durable record without a second dispatch',
    evidence: 'test/supervision.test.ts::github check supervision' },
  { id: 'external-close-proof', desc: 'external cancel and transfer stay nonterminal until matching remote proof',
    evidence: 'test/supervision.test.ts::github check supervision' },
  { id: 'work-tree-read-only', desc: 'the work tree includes stored descendants with unique lineage and no writes',
    evidence: 'test/supervision.test.ts::read-only work-tree projection' },
  { id: 'work-tree-acl', desc: 'every work-tree node and external ID follows its stored task ACL',
    evidence: 'test/web.test.ts::work-tree read authorization' },
  { id: 'honest-work-tree-outcomes', desc: 'browser states distinguish active waits, evidence outcomes, and non-done terminals',
    evidence: 'test/browser-e2e.test.ts::real Chrome work tree E2E' },
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
    criteria: ['decisions-logged', 'locked-task-transitions', 'plan-answer-current-lease'] },
  { id: 'PLAN_GATE', desc: 'a task moves only plan with checkpoints, owner approval, then spawn and hand',
    status: USED, tracer: 'test/hub.test.ts',
    criteria: ['plan-needs-checkpoints', 'no-spawn-before-plan-approval'] },
  { id: 'TASK_RECEIPT_RECOVERY', desc: 'receipts use current evidence and recovery stays fenced after revocation',
    status: USED, tracer: 'test/hub.test.ts',
    criteria: ['receipt-current-evidence', 'revocation-fences-receipts', 'locked-task-transitions'] },
  { id: 'PROGRESS_TRAIL', desc: 'checkpoints report progress and done needs every one terminal',
    status: USED, tracer: 'test/tasks.test.ts',
    criteria: ['done-needs-all-checkpoints', 'fail-needs-owner-accept', 'progress-never-changes-state'] },
  { id: 'EVIDENCE_DONE', desc: 'registered evidence and reconciled dependencies govern every terminal outcome',
    status: USED, tracer: 'test/evidence.test.ts',
    criteria: ['registered-evidence-done', 'terminal-outcome-guards'] },
  { id: 'GATE_VERIFY_PUSH', desc: 'the gate runs the steps, gate-verify vouches the commit, push goes by hash',
    status: USED, tracer: 'test/gate.test.ts',
    criteria: ['gate-never-vacuous-green', 'push-operation-binding'] },
  { id: 'CLEANUP_TRASH', desc: 'cleanup trashes what hive created and touches nothing else',
    status: USED, tracer: 'test/cleanup.test.ts',
    criteria: ['cleanup-trash-never-delete'] },
  { id: 'AGENT_LIFECYCLE', desc: 'spawn, respawn, and close an agent pane',
    status: USED, tracer: 'test/spawn.test.ts',
    criteria: ['pane-identity-before-act'] },
  { id: 'DELEGATE_WORK', desc: 'a root contract admits scoped workers and cumulative replacement attempts',
    status: USED, tracer: 'test/admission.test.ts',
    criteria: ['normalized-writer-leases', 'attempt-lineage-budget', 'current-grant-before-launch',
      'scope-diff-fences-lease', 'locked-team-mutations', 'public-contract-intake', 'exact-lease-revocation',
      'relaunch-cleanup', 'owned-lock-release'] },
  { id: 'NATIVE_REVIEW_REJOIN', desc: 'a read-only native child produces evidence, human review, and exact rejoin',
    status: USED, tracer: 'test/branches.test.ts',
    criteria: ['native-read-admission', 'native-result-evidence', 'native-exact-rejoin'] },
  { id: 'GITHUB_CHECK_SUPERVISION', desc: 'a real GitHub check dispatches once and closes only on remote proof',
    status: USED, tracer: 'test/supervision.test.ts',
    criteria: ['github-external-identity', 'external-close-proof'] },
  { id: 'PROCESS_TREE_MONITOR', desc: 'an ACL-filtered read-only tree shows every stored descendant and honest outcome',
    status: USED, tracer: 'test/browser-e2e.test.ts',
    criteria: ['work-tree-read-only', 'work-tree-acl', 'honest-work-tree-outcomes'] },
  { id: 'WATCH_SAFE_TIER', desc: 'safe approvals: whitelisted read-only commands are approved, the rest held',
    status: USED, tracer: 'test/watch.test.ts',
    criteria: ['approve-once-only', 'destructive-never-classified', 'decisions-logged'] },
  { id: 'WATCH_SMART_TIER', desc: 'smart approvals: the classifier decides unknown commands against a decoy pane',
    status: USED, tracer: 'test/watch-e2e.test.ts',
    criteria: ['destructive-never-classified', 'approve-once-only', 'decisions-logged'] },
  { id: 'WATCH_AUTO_HARD_DENY', desc: 'auto and cached approvals still refuse destructive text',
    status: USED, tracer: 'test/watch.test.ts',
    criteria: ['hard-deny-before-auto', 'destructive-never-classified'] },
  { id: 'WATCH_SCOPED_AUTO', desc: 'auto executes declared push grants and routes undeclared mutations through one root delta',
    status: USED, tracer: 'test/watch.test.ts',
    criteria: ['scoped-auto-push', 'root-delta-version', 'legacy-auto-fenced', 'managed-auto-no-yolo',
      'strict-auto-routing', 'pending-launch-provenance', 'delta-read-acl', 'agent-text-redacted',
      'trust-lane-identity', 'approved-command-consumption'] },
  { id: 'WATCHDOG_REWAKE', desc: 'dead panes resume only through the current worker lease',
    status: USED, tracer: 'test/watch.test.ts',
    criteria: ['watchdog-rewake-once', 'wake-current-lease', 'decisions-logged'] },
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
