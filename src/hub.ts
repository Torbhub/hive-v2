import path from 'node:path';
import { promises as fs } from 'node:fs';
import type {
  HubAgent, HubDialog, HubFolder, HubOrchestrator, HubProject, HubStatus, HubTask, TaskEvent, TeamEntry,
} from './types.js';
import { APPROVALS_MODES, CLOSED_STATES, PROJECT_MODES } from './types.js';
import type { Approvals, ProjectMode } from './types.js';
import {
  capturePane, paneExists, paneIdentity, paneIs, run, sendArrow, sendEnter, sendEscape, sendLiteral, sleep,
} from './tmux.js';
import { lines, parseDialog, scrapeContext } from './screen.js';
import {
  appendDecision, appendTaskEvent, clearPendingPane, extractCommand, foldTasks, hivePath, hubPath,
  nextTaskId, readPendingPane, readProjects, readTaskEvents, readTeam, Refusal, withHubLock, writePendingPane,
  writeProjects, writeJson, readJson, type ProjectsFile,
} from './state.js';
import { addProject } from './project.js';
import { listOpenQuestionBatches } from './questions.js';
import type { QuestionBatch } from './types.js';
import { orchestratorName, typeLine } from './spawn.js';
import { planVerdict } from './taskgate.js';
import { taskScope } from './scope.js';

export { Refusal } from './state.js';
export { hubAccept, hubLog, hubProgress, ledgerCommand } from './taskgate.js';

export async function hubInit(root: string, name = 'hub'): Promise<void> {
  await fs.mkdir(hubPath(root), { recursive: true });
  await fs.mkdir(hubPath(root, 'tasks'), { recursive: true });
  await fs.mkdir(hubPath(root, 'panes'), { recursive: true });
  const existing = await readJson<{ name?: string }>(hubPath(root, 'hub.json'));
  await writeJson(hubPath(root, 'hub.json'), { name: existing?.name ?? name });
  const pf = await readProjects(root);
  await writeProjects(root, pf);
}

export async function hubAdd(
  root: string, name: string, folder = '', source?: string,
): Promise<{ ok: true; name: string; home: string }> {
  return addProject(root, name, folder, { legacy: true, source });
}

export async function setProjectMode(root: string, project: string, mode: string): Promise<ProjectMode> {
  if (!(PROJECT_MODES as readonly string[]).includes(mode)) {
    throw new Refusal(`a mode is ask|yolo|auto: ${mode}`);
  }
  const pf = await readProjects(root);
  const p = pf.projects.find((x) => x.name === project);
  if (!p) throw new Refusal(`unknown project: ${project}`);
  p.mode = mode as ProjectMode;
  await writeProjects(root, pf);
  return p.mode;
}

export async function setProjectApprovals(root: string, project: string, approvals: string): Promise<Approvals> {
  if (!(APPROVALS_MODES as readonly string[]).includes(approvals)) {
    throw new Refusal(`approvals is manual|safe|smart: ${approvals}`);
  }
  const pf = await readProjects(root);
  const p = pf.projects.find((x) => x.name === project);
  if (!p) throw new Refusal(`unknown project: ${project}`);
  p.approvals = approvals as Approvals;
  await writeProjects(root, pf);
  return p.approvals;
}

export async function hubTask(root: string, project: string, text: string): Promise<string> {
  const pf = await readProjects(root);
  if (!pf.projects.some((p) => p.name === project)) throw new Refusal(`unknown project: ${project}`);
  const scope = taskScope(text);
  if (scope.kind === 'invalid') throw new Refusal(`the brief does not parse: ${scope.why}`);
  // The lock makes id allocation + task file + ledger append one step.
  return withHubLock(root, async () => {
    const id = await nextTaskId(root, project);
    await fs.mkdir(hubPath(root, 'tasks'), { recursive: true });
    // A brief keeps its frontmatter at the top of the file.
    const body = text.startsWith('---') ? `${text.trimEnd()}\n` : `# ${id}\n\n${text}\n`;
    await fs.writeFile(hubPath(root, 'tasks', `${id}.md`), body);
    await appendTaskEvent(root, { id, project, event: 'asked', at: new Date().toISOString() });
    return id;
  });
}

export async function listTasks(root: string): Promise<HubTask[]> {
  return foldTasks(await readTaskEvents(root));
}

type PaneSnapshot = {
  alive: 'running' | 'unknown' | 'gone';
  dialog: HubDialog | null;
  context: number | null;
};

async function snapshot(entry: TeamEntry): Promise<PaneSnapshot> {
  const none: PaneSnapshot = { alive: 'gone', dialog: null, context: null };
  if (!entry.pane || !entry.pane_pid || !entry.pane_started) return none;
  if (!(await paneExists(entry.pane))) return none;
  const same = await paneIs(entry.pane, { pid: entry.pane_pid, started: entry.pane_started });
  const raw = await capturePane(entry.pane);
  if (raw === null) return { alive: same ? 'running' : 'unknown', dialog: null, context: null };
  const ls = lines(raw);
  const dialog = parseDialog(ls);
  const ctx = scrapeContext(ls);
  return {
    alive: same ? 'running' : 'unknown',
    dialog: dialog.kind === 'none' ? null : dialog,
    context: ctx ? ctx.percent : null,
  };
}

function agentRef(name: string, names: Map<string, number>, worktree?: string): string {
  return (names.get(name) ?? 0) > 1 && worktree ? `${name}@${worktree}` : name;
}

async function folderStatus(root: string, folder: string): Promise<HubFolder> {
  const abs = path.isAbsolute(folder) ? folder : path.resolve(root, folder);
  const shown = abs.startsWith(root + path.sep) ? path.relative(root, abs) : abs;
  const st = await fs.stat(abs).catch(() => null);
  if (!st) return { folder: shown, kind: 'missing' };
  const gitDir = await fs.stat(path.join(abs, '.git')).catch(() => null);
  let kind = 'folder';
  if (gitDir?.isDirectory()) kind = 'repo';
  else if (gitDir?.isFile()) kind = 'worktree';
  if (kind === 'repo' || kind === 'worktree') {
    const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], abs);
    const dirty = await run('git', ['status', '--porcelain'], abs);
    const out: HubFolder = { folder: shown, kind };
    if (branch.code === 0) out.branch = branch.stdout.trim();
    if (dirty.code === 0) out.changed = dirty.stdout.split('\n').filter((l) => l.trim()).length;
    return out;
  }
  return { folder: shown, kind };
}

type ProjectEntry = ProjectsFile['projects'][number];

async function projectStatus(
  root: string, p: ProjectEntry, tasks: HubTask[], batches: QuestionBatch[],
): Promise<HubProject> {
  const team = await readTeam(p.home);
  const pending = await readPendingPane(root, p.name);
  const orchEntry = team.agents.find((a) => a.orchestrator);
  const projectBatches = batches.filter((b) => b.project === p.name);
  const waiting = new Set(projectBatches.map((b) => b.agent));
  const liveWaiting = new Set(projectBatches.filter((b) =>
    b.waitHeartbeatAt !== undefined && Date.now() - Date.parse(b.waitHeartbeatAt) < 30_000,
  ).map((b) => b.agent));

  const orchestrator: HubOrchestrator = {
    state: 'none',
    question: orchEntry ? waiting.has(orchEntry.name) : waiting.has(orchestratorName(p.name)),
    operator_question: orchEntry ? waiting.has(orchEntry.name) : waiting.has(orchestratorName(p.name)),
    operator_waiting: orchEntry ? liveWaiting.has(orchEntry.name) : liveWaiting.has(orchestratorName(p.name)),
  };
  if (orchEntry) {
    orchestrator.name = orchEntry.name;
    orchestrator.children = team.agents.filter((a) => !a.orchestrator && a.parent === orchEntry.name).length;
    if (orchEntry.session_id) orchestrator.session_id = orchEntry.session_id;
    const snap = await snapshot(orchEntry);
    orchestrator.state = snap.alive === 'running' ? 'running' : snap.alive === 'unknown' ? 'unknown' : 'stopped';
    if (snap.alive === 'running' && orchEntry.pane) orchestrator.pane = orchEntry.pane;
    if (snap.alive !== 'gone') {
      orchestrator.question = snap.dialog !== null || orchestrator.operator_question === true;
      orchestrator.screen_question = snap.dialog !== null;
      if (snap.context !== null) {
        orchestrator.context = snap.context;
        orchestrator.context_assumed = false;
      }
    }
  }
  if (pending) {
    // A pending pane whose team entry already owns it has registered; the record is stale.
    const registered =
      orchEntry?.pane === pending.pane &&
      (await paneIs(pending.pane, { pid: orchEntry.pane_pid ?? 0, started: orchEntry.pane_started ?? '' }));
    if (registered) {
      await clearPendingPane(root, p.name);
    } else if (!(await paneExists(pending.pane))) {
      await clearPendingPane(root, p.name);
    } else {
      const raw = await capturePane(pending.pane);
      const question = raw !== null && parseDialog(lines(raw)).kind !== 'none';
      orchestrator.starting = {
        pane: pending.pane, kind: pending.kind, at: pending.at,
        typed: Boolean(pending.typed), sending: Boolean(pending.sending), question, task: pending.task,
      };
      if (question && !pending.question) {
        await writePendingPane(root, p.name, { ...pending, question: true });
      }
    }
  }

  const nameCounts = new Map<string, number>();
  for (const a of team.agents.filter((x) => !x.orchestrator)) {
    nameCounts.set(a.name, (nameCounts.get(a.name) ?? 0) + 1);
  }
  const agents = await Promise.all(team.agents.filter((x) => !x.orchestrator).map(async (a) => {
    const snap = await snapshot(a);
    const agent: HubAgent = {
      name: a.name,
      state: !a.pane ? 'unrecorded'
        : snap.alive !== 'gone' && a.wedged_at ? 'wedged'
        : snap.alive === 'running' ? 'running'
        : snap.alive === 'unknown' ? 'unknown' : 'stopped',
      question: waiting.has(a.name) || (snap.alive !== 'gone' && snap.dialog !== null),
      operator_question: waiting.has(a.name),
      operator_waiting: liveWaiting.has(a.name),
      screen_question: snap.alive !== 'gone' && snap.dialog !== null,
      worktree: a.worktree,
      ref: agentRef(a.name, nameCounts, a.worktree),
    };
    if (a.session_id) agent.session_id = a.session_id;
    if (snap.context !== null && snap.alive !== 'gone') {
      agent.context = snap.context;
      agent.context_assumed = false;
    }
    return agent;
  }));

  const repos = await Promise.all(p.repos.map((r) => folderStatus(root, r.folder)));

  return {
    name: p.name,
    home: p.home,
    repos,
    orchestrator,
    agents,
    open_tasks: tasks.filter((t) => t.project === p.name && !CLOSED_STATES.has(t.state)).length,
    mode: p.mode ?? 'ask',
    approvals: p.approvals ?? 'manual',
  };
}

export async function buildStatus(root: string, batches?: QuestionBatch[]): Promise<HubStatus> {
  const hubJson = await readJson<{ name?: string }>(hubPath(root, 'hub.json'));
  const pf = await readProjects(root);
  const tasks = await listTasks(root);
  const openBatches = batches ?? await listOpenQuestionBatches(root);
  const projects = await Promise.all(pf.projects.map((p) => projectStatus(root, p, tasks, openBatches)));

  return {
    hub: hubJson?.name ? { root, name: hubJson.name } : { root },
    projects,
  };
}

export async function readDialogFor(
  root: string,
  project: string,
  agentRefArg?: string,
): Promise<(HubDialog & { project: string; session: string; pane: string }) | null> {
  const pf = await readProjects(root);
  const p = pf.projects.find((x) => x.name === project);
  if (!p) throw new Refusal(`unknown project: ${project}`);
  const team = await readTeam(p.home);

  let entry: TeamEntry | undefined;
  let session: string;
  if (agentRefArg) {
    const [name, wt] = agentRefArg.split('@');
    const matches = team.agents.filter((a) => !a.orchestrator && a.name === name);
    // Two same-named agents are told apart by worktree; a bare name that
    // matches more than one is an error, never a guess.
    if (wt) entry = matches.find((a) => a.worktree === wt);
    else if (matches.length === 1) entry = matches[0];
    else if (matches.length > 1) {
      throw new Refusal(`${project} has ${matches.length} agents named ${name}; say which: ${name}@<worktree>`);
    }
    if (!entry) throw new Refusal(`${project} has no agent named ${agentRefArg}`);
    session = name;
  } else {
    session = orchestratorName(project);
    const pending = await readPendingPane(root, project);
    if (pending && await paneExists(pending.pane)) entry = { name: session, pane: pending.pane };
    else entry = team.agents.find((a) => a.orchestrator);
  }
  if (!entry?.pane || !(await paneExists(entry.pane))) return null;
  const raw = await capturePane(entry.pane);
  if (raw === null) return null;
  const dialog = parseDialog(lines(raw));
  if (dialog.kind === 'none') return null;
  return { ...dialog, project, session, pane: entry.pane };
}

// A menu answer is a walk: from the cursor's option to the chosen one, then Enter.
export function menuKeys(choice: number, cursor: number): ('Up' | 'Down' | 'Enter')[] {
  const delta = choice - cursor;
  const keys: ('Up' | 'Down' | 'Enter')[] = Array.from(
    { length: Math.abs(delta) },
    () => (delta > 0 ? 'Down' : 'Up'),
  );
  keys.push('Enter');
  return keys;
}

export async function answerDialog(
  root: string,
  project: string,
  agentRefArg: string | undefined,
  choice: string,
  seen: string,
): Promise<{ answered: true; session: string; choice: string; option: string; dialog_gone: boolean }> {
  const dialog = await readDialogFor(root, project, agentRefArg);
  if (!dialog) throw new Refusal('no dialog is on that screen');
  if (dialog.fingerprint !== seen) {
    throw new Refusal('the dialog changed since it was read; read it again before answering');
  }
  let option = 'Esc';
  if (choice === 'esc') {
    await sendEscape(dialog.pane);
  } else {
    const opt = dialog.options.find((o) => String(o.n) === choice);
    if (!opt) throw new Refusal(`the dialog has no option ${choice}`);
    if (!opt.offered) throw new Refusal(`option ${choice} needs your own text; answer it in the pane`);
    option = opt.label;
    if (dialog.kind === 'menu') {
      for (const key of menuKeys(opt.n, dialog.cursor ?? 1)) {
        if (key === 'Enter') await sendEnter(dialog.pane);
        else await sendArrow(dialog.pane, key);
      }
    } else {
      await sendLiteral(dialog.pane, choice);
    }
  }
  await sleep(2000);
  const after = await readDialogFor(root, project, agentRefArg);
  // Lore: every owner answer lands in the permanent decisions log.
  const firstLine = dialog.text.split('\n').map((l) => l.trim()).find((l) => l && !/^[─╌-]+$/.test(l)) ?? '';
  const command = extractCommand(dialog.text);
  const subject = command ? `$ ${command}` : firstLine;
  try {
    await appendDecision(root, { project, by: 'owner', summary: `answered "${option}" for: ${subject}` });
  } catch (e) {
    console.error(`hive: the decision was not logged: ${e instanceof Error ? e.message : e}`);
  }
  return { answered: true, session: dialog.session, choice, option, dialog_gone: after === null };
}

const PLAN_FEEDBACK_CAP = 500;

// The plan card's fallback when no approval prompt is on the screen (a woken
// orchestrator loses it): type the verdict as the orchestrator's next line.
export async function planAnswer(
  root: string,
  project: string,
  taskId: string,
  verdict: string,
  feedback?: string,
): Promise<{ typed: string }> {
  if (verdict !== 'approve' && verdict !== 'sendback') {
    throw new Refusal(`a plan verdict is approve|sendback: ${verdict}`);
  }
  const pf = await readProjects(root);
  const p = pf.projects.find((x) => x.name === project);
  if (!p) throw new Refusal(`unknown project: ${project}`);
  const task = (await listTasks(root)).find((t) => t.id === taskId);
  if (!task || task.project !== project) throw new Refusal(`unknown task: ${taskId}`);
  if (task.state !== 'plan') {
    throw new Refusal(`${taskId} is ${task.state}, not waiting on a plan answer`);
  }

  const team = await readTeam(p.home);
  const orch = team.agents.find((a) => a.orchestrator);
  if (!orch?.pane || !(await paneExists(orch.pane))) {
    throw new Refusal(`${project}'s orchestrator has no live pane; wake it first`);
  }
  const raw = await capturePane(orch.pane);
  if (raw !== null && parseDialog(lines(raw)).kind !== 'none') {
    throw new Refusal('the plan prompt is on its screen; answer it there');
  }
  const identity = await paneIdentity(orch.pane);
  if (!identity) throw new Refusal(`cannot verify the identity of ${orch.pane}`);

  const fb = (feedback ?? '').replace(/\s+/g, ' ').trim().slice(0, PLAN_FEEDBACK_CAP);
  const v = planVerdict(task, verdict, fb);
  await typeLine(orch.pane, v.line, identity);

  await appendTaskEvent(root, {
    id: taskId, project, event: v.event, at: new Date().toISOString(), note: v.note,
  });
  try {
    await appendDecision(root, { project, task: taskId, by: 'owner', summary: v.summary });
  } catch (e) {
    console.error(`hive: the decision was not logged: ${e instanceof Error ? e.message : e}`);
  }
  return { typed: v.line };
}

export { continueProject, startProject, wake } from './launch.js';
