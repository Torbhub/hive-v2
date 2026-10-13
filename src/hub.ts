import path from 'node:path';
import { promises as fs } from 'node:fs';
import type {
  HubAgent, HubDialog, HubFolder, HubOrchestrator, HubProject, HubStatus, HubTask, TaskEvent, TeamEntry,
} from './types.js';
import { CLOSED_STATES, PROJECT_MODES, TASK_EVENTS } from './types.js';
import type { ProjectMode } from './types.js';
import {
  capturePane, paneExists, paneIdentity, paneIs, run, sendArrow, sendEnter, sendEscape, sendLiteral, sleep,
} from './tmux.js';
import { lines, parseDialog, scrapeContext } from './screen.js';
import {
  appendTaskEvent, clearPendingPane, foldTasks, hivePath, hubPath, manifestAdd, nextTaskId,
  readPendingPane, readProjects, readTaskEvents, readTeam, withHubLock, writePendingPane,
  writeProjects, writeJson, readJson, upsertTeamEntry, type PendingPane, type ProjectsFile,
} from './state.js';
import {
  ensureAgentFiles, findLatestSession, launchWindow, orchestratorName, pickupLine, preflight, typeLine, waitIdle,
} from './spawn.js';

// A deliberate refusal with an operator-safe message (unknown project, stale
// fingerprint, already running…). The web layer shows these to the client;
// every other error is infrastructure and stays server-side.
export class Refusal extends Error {}

export async function hubInit(root: string, name = 'hub'): Promise<void> {
  await fs.mkdir(hubPath(root), { recursive: true });
  await fs.mkdir(hubPath(root, 'tasks'), { recursive: true });
  await fs.mkdir(hubPath(root, 'panes'), { recursive: true });
  const existing = await readJson<{ name?: string }>(hubPath(root, 'hub.json'));
  await writeJson(hubPath(root, 'hub.json'), { name: existing?.name ?? name });
  const pf = await readProjects(root);
  await writeProjects(root, pf);
}

export async function hubAdd(root: string, name: string, folder: string): Promise<void> {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) {
    throw new Error(`a project name is lowercase letters, digits, '-': ${name}`);
  }
  const home = path.resolve(root, folder);
  const st = await fs.stat(home).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`not a folder: ${home}`);
  const pf = await readProjects(root);
  if (pf.projects.some((p) => p.name === name)) throw new Error(`a project named ${name} exists`);
  pf.projects.push({ name, home, repos: [{ folder: home }] });
  await writeProjects(root, pf);
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

export async function hubTask(root: string, project: string, text: string): Promise<string> {
  const pf = await readProjects(root);
  if (!pf.projects.some((p) => p.name === project)) throw new Refusal(`unknown project: ${project}`);
  // The lock makes id allocation + task file + ledger append one step.
  return withHubLock(root, async () => {
    const id = await nextTaskId(root, project);
    await fs.mkdir(hubPath(root, 'tasks'), { recursive: true });
    await fs.writeFile(hubPath(root, 'tasks', `${id}.md`), `# ${id}\n\n${text}\n`);
    await appendTaskEvent(root, { id, project, event: 'asked', at: new Date().toISOString() });
    return id;
  });
}

export async function hubLog(root: string, id: string, event: string, note?: string): Promise<void> {
  const events = await readTaskEvents(root);
  if (!events.some((e) => e.id === id)) throw new Error(`unknown task: ${id}`);
  if (!(TASK_EVENTS as readonly string[]).includes(event)) throw new Error(`unknown task event: ${event}`);
  await appendTaskEvent(root, {
    id, project: id.replace(/-\d+$/, ''), event: event as TaskEvent['event'], at: new Date().toISOString(), note,
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

async function projectStatus(root: string, p: ProjectEntry, tasks: HubTask[]): Promise<HubProject> {
  const team = await readTeam(p.home);
  const pending = await readPendingPane(root, p.name);
  const orchEntry = team.agents.find((a) => a.orchestrator);

  const orchestrator: HubOrchestrator = { state: 'none', question: false };
  if (orchEntry) {
    orchestrator.name = orchEntry.name;
    if (orchEntry.session_id) orchestrator.session_id = orchEntry.session_id;
    const snap = await snapshot(orchEntry);
    orchestrator.state = snap.alive === 'running' ? 'running' : snap.alive === 'unknown' ? 'unknown' : 'stopped';
    if (snap.alive !== 'gone') {
      orchestrator.question = snap.dialog !== null;
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
        typed: Boolean(pending.typed), sending: false, question, task: pending.task,
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
      state: !a.pane ? 'unrecorded' : snap.alive === 'running' ? 'running' : snap.alive === 'unknown' ? 'unknown' : 'stopped',
      question: snap.alive !== 'gone' && snap.dialog !== null,
      worktree: a.worktree,
      ref: agentRef(a.name, nameCounts, a.worktree),
    };
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
  };
}

export async function buildStatus(root: string): Promise<HubStatus> {
  const hubJson = await readJson<{ name?: string }>(hubPath(root, 'hub.json'));
  const pf = await readProjects(root);
  const tasks = await listTasks(root);
  const projects = await Promise.all(pf.projects.map((p) => projectStatus(root, p, tasks)));

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
    entry = team.agents.find((a) => a.orchestrator);
    session = orchestratorName(project);
    if (!entry?.pane) {
      const pending = await readPendingPane(root, project);
      if (pending) entry = { name: session, pane: pending.pane };
    }
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
  return { answered: true, session: dialog.session, choice, option, dialog_gone: after === null };
}

type LaunchKind = 'wake' | 'start';

async function launchOrchestrator(
  root: string,
  project: string,
  kind: LaunchKind,
  task?: string,
): Promise<string> {
  const pf = await readProjects(root);
  const p = pf.projects.find((x) => x.name === project);
  if (!p) throw new Refusal(`unknown project: ${project}`);
  if (kind === 'start') {
    if (!task || !new RegExp(`^${project}-\\d+$`).test(task)) {
      throw new Refusal(`a task id is ${project}-<n>: ${task}`);
    }
    const taskFile = await fs.stat(hubPath(root, 'tasks', `${task}.md`)).catch(() => null);
    if (!taskFile?.isFile()) throw new Refusal(`no task file for ${task}`);
  }
  // Claim-then-launch under the hub lock: a second start for the same project
  // must see the pending record, never race past the check.
  const launched = await withHubLock(root, async () => {
    const existing = await readPendingPane(root, project);
    if (existing && (await paneExists(existing.pane))) {
      throw new Refusal(`${project} is already starting in ${existing.pane}; continue it or close the window`);
    }
    await preflight();

    const team = await readTeam(p.home);
    const old = team.agents.find((a) => a.orchestrator);
    const name = orchestratorName(project);
    const cwd = old?.worktree ?? p.home;
    const sessionId = kind === 'wake' ? old?.session_id ?? (await findLatestSession(cwd, name)) ?? undefined : undefined;
    if (kind === 'wake' && !sessionId) {
      throw new Refusal(`${project} has no recorded session to resume; start it instead`);
    }
    // start and wake both refuse a live orchestrator: a second window would orphan the first.
    if (old?.pane && (await paneIs(old.pane, { pid: old.pane_pid ?? 0, started: old.pane_started ?? '' }))) {
      throw new Refusal(`${project}'s orchestrator is already running`);
    }

    await ensureAgentFiles(cwd, name, 'orchestrator');
    const { pane, identity } = await launchWindow(project, name, cwd, sessionId, p.mode ?? 'ask');
    await manifestAdd(p.home, {
      kind: 'tmux', at: new Date().toISOString(), pane, window: `${project}:${name}`,
      pane_pid: identity.pid, pane_started: identity.started,
    });
    let line = pickupLine(project, name);
    if (task) line += ` The task: read ${hubPath(root, 'tasks', `${task}.md`)} and take it from there.`;
    const pending: PendingPane = { pane, kind, at: new Date().toISOString(), typed: false, task, line };
    await writePendingPane(root, project, pending);
    return { pane, identity, pending, sessionId, name, cwd };
  });
  const { pane, identity, pending, sessionId, name, cwd } = launched;
  const line = pending.line ?? '';

  const idle = await waitIdle(pane, { maxMs: 140_000 });
  if (idle !== 'idle') {
    if (idle === 'dialog') await writePendingPane(root, project, { ...pending, question: true });
    return pane;
  }
  await typeLine(pane, line, identity);
  await upsertTeamEntry(p.home, {
    name, orchestrator: true, pane, pane_pid: identity.pid, pane_started: identity.started,
    worktree: cwd, handoff: hivePath(cwd, 'handoffs', `${name}.md`),
  });
  await writePendingPane(root, project, { ...pending, typed: true });
  const sid = kind === 'wake' ? sessionId : await findLatestSession(cwd, name);
  if (sid) await upsertTeamEntry(p.home, { name, session_id: sid });
  return pane;
}

export async function wake(root: string, project: string): Promise<string> {
  return launchOrchestrator(root, project, 'wake');
}

export async function startProject(root: string, project: string, task: string): Promise<string> {
  return launchOrchestrator(root, project, 'start', task);
}

export async function continueProject(root: string, project: string): Promise<string> {
  const pending = await readPendingPane(root, project);
  if (!pending) throw new Refusal(`${project} is not waiting on a first line`);
  if (pending.typed) throw new Refusal(`${project}'s first line was already sent`);
  if (!pending.line) throw new Refusal(`${project}'s pending record has no line to type`);
  if (!(await paneExists(pending.pane))) {
    await clearPendingPane(root, project);
    throw new Refusal(`${project}'s starting pane ${pending.pane} is gone; start again`);
  }
  const raw = await capturePane(pending.pane);
  if (raw !== null && parseDialog(lines(raw)).kind !== 'none') {
    await writePendingPane(root, project, { ...pending, question: true });
    throw new Refusal(`a dialog is on the screen of ${pending.pane}; answer it, then continue`);
  }
  const idle = await waitIdle(pending.pane, { maxMs: 140_000 });
  if (idle !== 'idle') throw new Refusal(`${pending.pane} never went idle; nothing was typed`);
  const id = await paneIdentity(pending.pane);
  if (!id) throw new Refusal(`pane ${pending.pane} has no readable identity`);
  await typeLine(pending.pane, pending.line, id);

  const pf = await readProjects(root);
  const p = pf.projects.find((x) => x.name === project);
  if (p) {
    await upsertTeamEntry(p.home, {
      name: orchestratorName(project), orchestrator: true,
      pane: pending.pane, pane_pid: id.pid, pane_started: id.started,
      worktree: p.home, handoff: hivePath(p.home, 'handoffs', `${orchestratorName(project)}.md`),
    });
    const sid = await findLatestSession(p.home, orchestratorName(project));
    if (sid) await upsertTeamEntry(p.home, { name: orchestratorName(project), session_id: sid });
  }
  await writePendingPane(root, project, { ...pending, typed: true });
  return pending.pane;
}
