// Thin client for the Agent Memory stack on the box (docs/memory.md).
// Every call is fail-open: memory down, slow, or unconfigured returns
// null/undefined and never throws into the spawn or lane flow.
// The default URL is the auth relay, which holds the instance key; the
// caller only ever holds the scoped user key.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeNoFollow } from './safe-write.js';
import { hubPath } from './state.js';

const TIMEOUT_MS = 3000;
const BLOCK_CAP = 2000;
const QUERY_CAP = 300;

// Two agent buckets under team_id hive-<project>: `team` holds promoted
// memory that recall searches, `candidates` holds private proposals until
// the owner promotes them. The v3 data plane has no per-memory visibility
// field, so the buckets are the write gate.
const TEAM_AGENT = 'team';
const CANDIDATES_AGENT = 'candidates';

const teamId = (project: string): string => `hive-${project}`;

export function memoryEnabled(): boolean {
  return Boolean(process.env.HIVE_MEMORY_KEY);
}

type Envelope<T> = { code?: number; data?: T };

async function post<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
  const key = process.env.HIVE_MEMORY_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`${process.env.HIVE_MEMORY_URL ?? 'http://127.0.0.1:8421'}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
        'x-tdai-user-key': key,
        'x-tdai-service-id': process.env.HIVE_MEMORY_SERVICE_ID ?? 'default',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const envelope = (await res.json()) as Envelope<T>;
    if (envelope.code !== 0 || envelope.data === undefined) return null;
    return envelope.data;
  } catch {
    return null;
  }
}

export type MemoryHit = { id: string; content: string; background?: string };

// The recall block for a spawn brief: one bullet per hit, capped so a
// memory flood cannot blow up a brief.
export async function searchMemory(project: string, query: string, limit = 5): Promise<string | null> {
  const data = await post<{ items?: MemoryHit[] }>('/v3/atomic/search', {
    team_id: teamId(project), agent_id: TEAM_AGENT, user_id: 'hive',
    query: query.slice(0, QUERY_CAP), limit,
  });
  if (!data?.items || data.items.length === 0) return null;
  let out = '';
  for (const hit of data.items) {
    const line = `- ${hit.content.trim()}\n`;
    if (out.length + line.length > BLOCK_CAP) break;
    out += line;
  }
  if (out === '' && data.items[0]) out = `- ${data.items[0].content.trim().slice(0, BLOCK_CAP - 3)}\n`;
  return out === '' ? null : out.trimEnd();
}

export type MemoryProvenance = { session?: string };

// The data plane creates atomic notes only through the extraction pipeline,
// so candidates are written as conversation entries and distilled in place.
// The text carries its provenance on a trailing line; it survives promote
// into the team bucket, where it helps the distiller and the audit trail.
// Returns the server-assigned entry id, or null when memory is down.
export async function proposeMemory(
  project: string,
  agent: string,
  text: string,
  provenance: MemoryProvenance = {},
): Promise<string | null> {
  const meta = [`project: ${project}`, `agent: ${agent}`];
  if (provenance.session) meta.push(`session: ${provenance.session}`);
  const content = `${text.slice(0, 7800)}\n— ${meta.join(', ')}`;
  const data = await post<{ accepted_ids?: string[] }>('/v3/conversation/add', {
    team_id: teamId(project), agent_id: CANDIDATES_AGENT, user_id: 'hive',
    session_id: CANDIDATES_AGENT,
    messages: [{ role: 'user', content }],
  });
  return data?.accepted_ids?.[0] ?? null;
}

// conversation/query pages at 100 rows; candidates are few, but page anyway
// so a stuffed bucket cannot hide a candidate from promote.
export async function listCandidates(project: string, limit = 50): Promise<MemoryHit[] | null> {
  const out: MemoryHit[] = [];
  let offset = 0;
  while (out.length < limit) {
    const page = Math.min(100, limit - out.length);
    const data = await post<{ messages?: MemoryHit[] }>('/v3/conversation/query', {
      team_id: teamId(project), agent_id: CANDIDATES_AGENT, user_id: 'hive',
      session_id: CANDIDATES_AGENT, limit: page, offset,
    });
    if (!data?.messages) return out.length > 0 ? out : null;
    out.push(...data.messages.map((m) => ({ id: m.id, content: m.content })));
    if (data.messages.length < page) break;
    offset += data.messages.length;
  }
  return out;
}

export type PromoteResult =
  | { kind: 'promoted'; id: string }
  | { kind: 'missing' }
  | { kind: 'unavailable' };

// Promote is copy across buckets: write the candidate into the team bucket,
// then delete the candidate. Team first, so a failure mid-way duplicates
// instead of losing the memory.
export async function promoteCandidate(project: string, id: string): Promise<PromoteResult> {
  const candidates = await listCandidates(project, 500);
  if (candidates === null) return { kind: 'unavailable' };
  const cand = candidates.find((c) => c.id === id);
  if (!cand) return { kind: 'missing' };
  const written = await post<{ accepted_ids?: string[] }>('/v3/conversation/add', {
    team_id: teamId(project), agent_id: TEAM_AGENT, user_id: 'hive',
    session_id: TEAM_AGENT,
    messages: [{ role: 'user', content: cand.content }],
  });
  const teamId2 = written?.accepted_ids?.[0];
  if (!teamId2) return { kind: 'unavailable' };
  await post('/v3/conversation/delete', {
    team_id: teamId(project), agent_id: CANDIDATES_AGENT, user_id: 'hive',
    message_ids: [id],
  });
  return { kind: 'promoted', id: teamId2 };
}

// The recall query is the task brief itself, capped. Returns the block to
// append to the spawn handoff, or null when there is nothing to add.
export async function memoryBlockFor(root: string, project: string, task: string): Promise<string | null> {
  try {
    const text = await fs.readFile(hubPath(root, 'tasks', `${task}.md`), 'utf8');
    const found = await searchMemory(project, text);
    return found ? `## Memory\n\n${found}\n` : null;
  } catch {
    return null;
  }
}

const MEMORY_HEADING = '\n## Memory\n';

// The block is always the last section of the handoff, so replacing from the
// heading down refreshes it without touching the handoff proper.
export async function applyMemoryBlock(handoffFile: string, block: string): Promise<void> {
  try {
    const current = await fs.readFile(handoffFile, 'utf8');
    const cut = current.indexOf(MEMORY_HEADING);
    const base = (cut === -1 ? current : current.slice(0, cut)).trimEnd();
    const worktree = path.dirname(path.dirname(path.dirname(handoffFile)));
    await writeNoFollow(handoffFile, `${base}\n\n${block}`, worktree);
  } catch {
    // A handoff that cannot be read or written must not fail a spawn.
  }
}
