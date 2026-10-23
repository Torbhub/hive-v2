import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Approvals, Checkpoint, Decision, HubTask, ProjectMode, TaskEvent, TeamEntry } from './types.js';
import { APPROVALS_MODES, NEEDS_OWNER_STATES, PROJECT_MODES, TASK_EVENTS } from './types.js';

export const HUB_DIR = '.hive-hub';
export const HIVE_DIR = '.hive';

// A deliberate refusal with an operator-safe message. The web layer shows
// these to the client; every other error is infrastructure and stays server-side.
export class Refusal extends Error {}

export function hubPath(root: string, ...parts: string[]): string {
  return path.join(root, HUB_DIR, ...parts);
}

export function hivePath(projectHome: string, ...parts: string[]): string {
  return path.join(projectHome, HIVE_DIR, ...parts);
}

// null means "absent"; a corrupt file throws so callers never overwrite real data.
export async function readJson<T>(file: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new Error(`corrupt JSON in ${file}: ${e instanceof Error ? e.message : e}`);
  }
}

// tmp + rename so a concurrent reader never sees a half-written file.
export async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(tmp, file);
}

export type ProjectsFile = {
  projects: { name: string; home: string; repos: { folder: string }[]; mode?: ProjectMode; approvals?: Approvals }[];
};

export async function readProjects(root: string): Promise<ProjectsFile> {
  return (await readJson<ProjectsFile>(hubPath(root, 'projects.json'))) ?? { projects: [] };
}

export async function writeProjects(root: string, pf: ProjectsFile): Promise<void> {
  for (const p of pf.projects) {
    if (p.mode !== undefined && !(PROJECT_MODES as readonly string[]).includes(p.mode)) {
      throw new Error(`a project mode is ask|yolo|auto: ${p.mode}`);
    }
    if (p.approvals !== undefined && !(APPROVALS_MODES as readonly string[]).includes(p.approvals)) {
      throw new Error(`project approvals is manual|safe|smart: ${p.approvals}`);
    }
  }
  await writeJson(hubPath(root, 'projects.json'), pf);
}

export async function appendTaskEvent(root: string, ev: TaskEvent): Promise<void> {
  if (!(TASK_EVENTS as readonly string[]).includes(ev.event)) {
    throw new Error(`unknown task event: ${ev.event}`);
  }
  await fs.mkdir(hubPath(root), { recursive: true });
  await fs.appendFile(hubPath(root, 'tasks.jsonl'), JSON.stringify(ev) + '\n');
}

export async function readTaskEvents(root: string): Promise<TaskEvent[]> {
  let raw: string;
  try {
    raw = await fs.readFile(hubPath(root, 'tasks.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const out: TaskEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as TaskEvent);
    } catch {
      // A torn last line (crashed append) is dropped, not fatal.
    }
  }
  return out;
}

export function foldTasks(events: TaskEvent[]): HubTask[] {
  const byId = new Map<string, HubTask & { decisions: { at: string; reason: string }[] }>();
  for (const ev of events) {
    let t = byId.get(ev.id);
    if (!t) {
      t = {
        id: ev.id, project: ev.project, asked: ev.at, state: ev.event,
        updated: ev.at, last_note: null, needs_owner: false, decisions: [],
        checkpoints: [], progress: {}, last_progress_at: null, plan_approved: false, checkpoint_accepts: {},
      };
      byId.set(ev.id, t);
    }
    t.updated = ev.at;
    // note, progress, and planaccept never rewrite the headline state.
    if (ev.event === 'note') {
      t.last_note = ev.note ?? null;
    } else if (ev.event === 'progress') {
      if (ev.checkpoint && ev.status) {
        t.progress![ev.checkpoint] = { status: ev.status, note: ev.note, at: ev.at };
        t.last_progress_at = ev.at;
        // A fresh fail needs a fresh accept; an earlier one does not carry over.
        if (ev.status === 'fail') delete t.checkpoint_accepts![ev.checkpoint];
      }
    } else if (ev.event === 'planaccept') {
      if (ev.checkpoint) t.checkpoint_accepts![ev.checkpoint] = ev.at;
    } else {
      const prev = t.state;
      t.state = ev.event;
      if (ev.event === 'plan') {
        // A fresh plan replaces the old one: checkpoints and their progress reset.
        t.checkpoints = validCheckpoints(ev.checkpoints) ?? [];
        t.progress = {};
        t.checkpoint_accepts = {};
        t.plan_approved = false;
      }
      if (ev.event === 'asked') {
        // A rebrief is an asked event on an existing task: the old plan, its
        // approval, and its trail must not carry over. On task creation these
        // fields already hold their initial values, so the reset is a no-op.
        t.checkpoints = [];
        t.progress = {};
        t.checkpoint_accepts = {};
        t.plan_approved = false;
        t.last_progress_at = null;
      }
      if (ev.event === 'answered' && prev === 'plan') t.plan_approved = true;
      if (ev.event === 'decided') t.decisions.push({ at: ev.at, reason: ev.note ?? '' });
      if (ev.note) t.last_note = ev.note;
    }
  }
  const out = [...byId.values()];
  for (const t of out) t.needs_owner = NEEDS_OWNER_STATES.has(t.state);
  out.sort((a, b) => a.asked.localeCompare(b.asked));
  return out;
}

// null means the checkpoint list fails the contract: at least one checkpoint,
// each with a non-empty unique id, a non-empty desc, and an etaMin above zero.
export function validCheckpoints(cps: unknown): Checkpoint[] | null {
  if (!Array.isArray(cps) || cps.length === 0) return null;
  const ids = new Set<string>();
  for (const c of cps) {
    if (!c || typeof c !== 'object') return null;
    const { id, desc, etaMin } = c as Checkpoint;
    if (typeof id !== 'string' || !id.trim()) return null;
    if (ids.has(id)) return null;
    ids.add(id);
    if (typeof desc !== 'string' || !desc.trim()) return null;
    if (typeof etaMin !== 'number' || !(etaMin > 0)) return null;
  }
  return cps as Checkpoint[];
}

// Why a task may not go done yet, one reason per blocking checkpoint.
export function doneBlockers(t: HubTask): string[] {
  const out: string[] = [];
  for (const c of t.checkpoints ?? []) {
    const p = t.progress?.[c.id];
    if (!p || p.status === 'started') {
      out.push(`${c.id} has no terminal progress`);
      continue;
    }
    if (p.status === 'ok') continue;
    if (p.status === 'skip') {
      if (!p.note?.trim()) out.push(`${c.id} was skipped without a note`);
      continue;
    }
    if (!t.checkpoint_accepts?.[c.id]) out.push(`${c.id} failed and the owner has not accepted it`);
  }
  return out;
}

// The command a permission dialog asks about, when it shows one.
export function extractCommand(dialogText: string): string | null {
  const m = dialogText.match(/^\s*(?:▶\s*)?\$\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

export async function nextTaskId(root: string, project: string): Promise<string> {
  const events = await readTaskEvents(root);
  let max = 0;
  for (const ev of events) {
    const m = ev.id.match(new RegExp(`^${project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${project}-${max + 1}`;
}

export async function readTeam(projectHome: string): Promise<{ agents: TeamEntry[] }> {
  return (await readJson<{ agents: TeamEntry[] }>(hivePath(projectHome, 'team.json'))) ?? { agents: [] };
}

const LOCK_STALE_MS = 10 * 60_000;

// mkdir is the lock: atomic on every filesystem hive runs on. A lock older
// than LOCK_STALE_MS is a crashed holder, not a live one.
async function withDirLock<T>(lock: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (Date.now() > deadline) throw new Error(`locked: ${lock}`);
      const st = await fs.stat(lock).catch(() => null);
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await fs.rmdir(lock).catch(() => {});
        continue;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rmdir(lock).catch(() => {});
  }
}

export async function withTeamLock<T>(projectHome: string, fn: () => Promise<T>): Promise<T> {
  return withDirLock(hivePath(projectHome, 'team.json.lock'), fn);
}

export async function withHubLock<T>(root: string, fn: () => Promise<T>): Promise<T> {
  return withDirLock(hubPath(root, 'lock'), fn);
}

export async function upsertTeamEntry(projectHome: string, entry: TeamEntry): Promise<void> {
  await withTeamLock(projectHome, async () => {
    const team = await readTeam(projectHome);
    const i = team.agents.findIndex((a) => a.name === entry.name);
    if (i >= 0) team.agents[i] = { ...team.agents[i], ...entry };
    else team.agents.push(entry);
    await writeJson(hivePath(projectHome, 'team.json'), team);
  });
}

export async function removeTeamEntry(projectHome: string, name: string): Promise<void> {
  await withTeamLock(projectHome, async () => {
    const team = await readTeam(projectHome);
    await writeJson(hivePath(projectHome, 'team.json'), {
      agents: team.agents.filter((a) => a.name !== name),
    });
  });
}

export type ManifestRecord = { kind: 'worktree' | 'jj-workspace' | 'tmux' | 'process'; at: string; [k: string]: unknown };

export async function manifestAdd(projectHome: string, rec: ManifestRecord): Promise<void> {
  await fs.mkdir(hivePath(projectHome), { recursive: true });
  await fs.appendFile(hivePath(projectHome, 'manifest.jsonl'), JSON.stringify(rec) + '\n');
}

export async function manifestRead(projectHome: string): Promise<ManifestRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(hivePath(projectHome, 'manifest.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const out: ManifestRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ManifestRecord);
    } catch {
      // A torn last line (crashed append) is dropped, not fatal.
    }
  }
  return out;
}

export async function manifestWrite(projectHome: string, recs: ManifestRecord[]): Promise<void> {
  await fs.writeFile(
    hivePath(projectHome, 'manifest.jsonl'),
    recs.map((r) => JSON.stringify(r)).join('\n') + (recs.length ? '\n' : ''),
  );
}

export type PendingPane = {
  pane: string; kind: string; at: string;
  typed?: boolean; sending?: boolean; question?: boolean; task?: string; line?: string;
};

export async function readPendingPane(root: string, project: string): Promise<PendingPane | null> {
  return readJson<PendingPane>(hubPath(root, 'panes', `${project}.json`));
}

export async function writePendingPane(root: string, project: string, p: PendingPane): Promise<void> {
  await writeJson(hubPath(root, 'panes', `${project}.json`), p);
}

export async function clearPendingPane(root: string, project: string): Promise<void> {
  await fs.rm(hubPath(root, 'panes', `${project}.json`), { force: true });
}

// The decisions log: append-only lore that survives every rotation.
export async function appendDecision(root: string, d: Omit<Decision, 'at'> & { at?: string }): Promise<void> {
  await fs.mkdir(hubPath(root), { recursive: true });
  await fs.appendFile(
    hubPath(root, 'decisions.jsonl'),
    JSON.stringify({ ...d, at: d.at ?? new Date().toISOString() }) + '\n',
  );
}

export async function readDecisions(root: string, latest = 8): Promise<Decision[]> {
  let raw: string;
  try {
    raw = await fs.readFile(hubPath(root, 'decisions.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const out: Decision[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Decision);
    } catch {
      // A torn last line (crashed append) is dropped, not fatal.
    }
  }
  return out.slice(-latest).reverse();
}
