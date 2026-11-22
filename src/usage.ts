import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findSessionLocation, SessionNotFoundError, type SessionLocation } from './death-bundle.js';
import { readWireUsage, type WireUsage } from './logview.js';
import { foldTasks, readProjects, readTaskEvents, readTeam, Refusal } from './state.js';
import type { TeamEntry, TmuxAdmission } from './types.js';

export class UsageError extends Error {}

export type TaskUsageAttempt = WireUsage & {
  task: string;
  agent: string;
  session_id: string;
  lease_id: string;
  lineage_id: string;
  attempt: number | 'unknown';
  attribution: 'attributed' | 'orphan';
};

export type TaskUsage = { task: string; attempts: TaskUsageAttempt[] };

type AttemptIdentity = Pick<TaskUsageAttempt, 'task' | 'agent' | 'lease_id' | 'lineage_id' | 'attempt'>;

const UNKNOWN_USAGE: WireUsage = {
  turns: 'unknown', tool_calls: 'unknown', input_tokens: 'unknown', output_tokens: 'unknown',
  total_tokens: 'unknown', cost_usd: 'unknown',
};

function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[/\\]/.test(value);
}

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY | constants.O_NONBLOCK;

function descriptorPath(handle: FileHandle, child: string): string {
  return path.join('/proc/self/fd', String(handle.fd), child);
}

async function readSessionWire(location: SessionLocation): Promise<WireUsage | null> {
  let session: FileHandle | undefined;
  let agents: FileHandle | undefined;
  let main: FileHandle | undefined;
  try {
    session = await fs.open(location.path, DIRECTORY_FLAGS);
    const identity = await session.stat();
    if (identity.dev !== location.dev || identity.ino !== location.ino) return null;
    agents = await fs.open(descriptorPath(session, 'agents'), DIRECTORY_FLAGS);
    main = await fs.open(descriptorPath(agents, 'main'), DIRECTORY_FLAGS);
    return await readWireUsage(descriptorPath(main, 'wire.jsonl'));
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR') return null;
    throw error;
  } finally {
    if (main) await main.close();
    if (agents) await agents.close();
    if (session) await session.close();
  }
}

async function readEntryUsage(home: string, entry: TeamEntry): Promise<{ sessionId: string; usage: WireUsage }> {
  if (!validSessionId(entry.session_id) || typeof entry.worktree !== 'string' || !entry.worktree) {
    return { sessionId: validSessionId(entry.session_id) ? entry.session_id : 'unknown', usage: UNKNOWN_USAGE };
  }
  try {
    const location = await findSessionLocation(home, entry.session_id, entry.worktree);
    const usage = await readSessionWire(location);
    return { sessionId: entry.session_id, usage: usage ?? UNKNOWN_USAGE };
  } catch (error) {
    if (error instanceof SessionNotFoundError
      || error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { sessionId: entry.session_id, usage: UNKNOWN_USAGE };
    }
    throw error;
  }
}

function attempt(
  identity: AttemptIdentity,
  attribution: TaskUsageAttempt['attribution'],
  sessionId: string,
  usage: WireUsage,
): TaskUsageAttempt {
  return { ...identity, session_id: sessionId, attribution, ...usage };
}

function admissionIdentity(admission: TmuxAdmission): AttemptIdentity {
  return {
    task: admission.task, agent: admission.agent, lease_id: admission.lease_id,
    lineage_id: admission.lineage_id, attempt: admission.attempts_used,
  };
}

function entryIdentity(entry: TeamEntry): AttemptIdentity {
  return {
    task: entry.task!, agent: entry.name, lease_id: entry.lease_id ?? 'unknown',
    lineage_id: entry.lineage_id ?? 'unknown', attempt: entry.attempts_used ?? 'unknown',
  };
}

function exactEntries(admission: TmuxAdmission, entries: TeamEntry[]): TeamEntry[] {
  return entries.filter((entry) => entry.task === admission.task
    && entry.name === admission.agent
    && entry.lease_id === admission.lease_id
    && entry.plan_digest === admission.plan_digest
    && entry.root_lease_epoch === admission.root_lease_epoch
    && entry.lease_epoch === admission.lease_epoch
    && entry.lineage_id === admission.lineage_id
    && entry.attempts_used === admission.attempts_used);
}

export async function readTaskUsage(root: string, taskId: string, home = os.homedir()): Promise<TaskUsage> {
  const [events, projects] = await Promise.all([readTaskEvents(root), readProjects(root)]);
  const task = foldTasks(events).find((candidate) => candidate.id === taskId);
  if (!task) throw new Refusal(`unknown task: ${taskId}`);
  const project = projects.projects.find((candidate) => candidate.name === task.project);
  if (!project) throw new Refusal(`unknown project: ${task.project}`);
  const entries = (await readTeam(project.home)).agents;
  const matched = new Set<TeamEntry>();
  const attempts: TaskUsageAttempt[] = [];

  for (const admission of task.admissions ?? []) {
    const exact = exactEntries(admission, entries);
    for (const entry of exact) matched.add(entry);
    const identity = admissionIdentity(admission);
    if (admission.retry_of !== undefined) {
      const sessionId = exact.length === 1 && validSessionId(exact[0].session_id) ? exact[0].session_id : 'unknown';
      attempts.push(attempt(identity, 'orphan', sessionId, UNKNOWN_USAGE));
      continue;
    }
    if (exact.length !== 1 || !validSessionId(exact[0].session_id)) {
      attempts.push(attempt(identity, 'orphan', 'unknown', UNKNOWN_USAGE));
      continue;
    }
    const measured = await readEntryUsage(home, exact[0]);
    attempts.push(attempt(identity, 'attributed', measured.sessionId, measured.usage));
  }

  for (const entry of entries) {
    if (entry.task !== taskId || matched.has(entry)) continue;
    if (entry.retry_of !== undefined) {
      const sessionId = validSessionId(entry.session_id) ? entry.session_id : 'unknown';
      attempts.push(attempt(entryIdentity(entry), 'orphan', sessionId, UNKNOWN_USAGE));
      continue;
    }
    const measured = await readEntryUsage(home, entry);
    attempts.push(attempt(entryIdentity(entry), 'orphan', measured.sessionId, measured.usage));
  }
  return { task: taskId, attempts };
}

export async function usageCommand(root: string, args: string[]): Promise<string> {
  if (args.length !== 2 || args[1].startsWith('--')) throw new UsageError('usage: hive hub usage <task>');
  return JSON.stringify(await readTaskUsage(root, args[1]), null, 2);
}
