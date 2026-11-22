import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findSessionDir, SessionNotFoundError } from './death-bundle.js';
import { checkName } from './names.js';
import { readProjects, readTeam, Refusal } from './state.js';
import type { TeamEntry } from './types.js';

export type LogEntryKind = 'think' | 'text' | 'tool' | 'prompt';

export type LogEntry = { id: string; at: string; kind: LogEntryKind; text: string };
export type ParsedLogEntry = Omit<LogEntry, 'id'>;

export type AgentLog = {
  agent: string;
  session_id: string;
  fileGeneration: string | null;
  hasOlder: boolean;
  olderCursor: string | null;
  agents: { agentId: string; entries: LogEntry[] }[];
};

const LOG_CHUNK_BYTES = 256 * 1024;
const MAX_RECORD_BYTES = 256 * 1024;
const CURSOR_ANCHOR_BYTES = 128;
const MAX_ENTRIES = 100;
const TEXT_CAP = 500;
const CURSOR_KEY = randomBytes(32);

export function redactSecrets(text: string): string {
  return text
    .replace(/hva1\.(?:[a-z][a-z0-9-]{0,62})?(?:\.[0-9a-f]{0,16})?(?:\.[A-Za-z0-9_-]{0,256})?/g, '[redacted-agent-credential]')
    .replace(/(authorization\\?["']?\s*[:=]?\s*\\?["']?\s*(?:bearer|basic|token)\s+)[^\s"',}\\]+/gi, '$1[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g, '[redacted-gh-token]')
    .replace(/\bxox[bp]-[A-Za-z0-9-]{8,}/g, '[redacted-slack-token]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g, '[redacted-jwt]')
    .replace(/((?:api[_-]?key|token|secret|password)\w*\\?["']?\s*[:=]\s*)(?:(\\?["'])(?:\\.|[^"'\\]){3,}?(?<!\\)\2|[^"'\s,}\]\\[]{8,})/gi, '$1$2[redacted]$2')
    .replace(/(\/\/[^\s/"':@]+:)[^\s/"'@\\]+(?=@)/g, '$1[redacted]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted-aws-key]')
    .replace(/\b[0-9a-f]{32,}\b/gi, '[redacted-hex]');
}

function capText(text: string): string {
  const clean = redactSecrets(text).trim();
  return clean.length <= TEXT_CAP ? clean : `${clean.slice(0, TEXT_CAP)}…`;
}

function at(ms: unknown): string {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : '?';
}

export function parseWireLine(line: string): ParsedLogEntry | null {
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const stamp = at(rec.time);
  if (rec.type === 'context.append_loop_event') {
    const ev = rec.event as Record<string, unknown> | undefined;
    if (!ev || typeof ev !== 'object') return null;
    if (ev.type === 'content.part') {
      const part = ev.part as Record<string, unknown> | undefined;
      if (!part || typeof part !== 'object') return null;
      if (part.type === 'think' && typeof part.think === 'string') {
        return { at: stamp, kind: 'think', text: capText(part.think) };
      }
      if (part.type === 'text' && typeof part.text === 'string') {
        return { at: stamp, kind: 'text', text: capText(part.text) };
      }
      return null;
    }
    if (ev.type === 'tool.call' && typeof ev.name === 'string') {
      const display = ev.display as Record<string, unknown> | undefined;
      const summary = [display?.operation, display?.path]
        .filter((x): x is string => typeof x === 'string')
        .join(' ')
        || (ev.args === undefined ? '' : JSON.stringify(ev.args));
      return { at: stamp, kind: 'tool', text: capText(`${ev.name} ${summary}`.trim()) };
    }
    return null;
  }
  if (rec.type === 'context.append_message') {
    const msg = rec.message as Record<string, unknown> | undefined;
    if (!msg || msg.role !== 'user') return null;
    const content = Array.isArray(msg.content) ? msg.content : [];
    const text = content
      .map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string'
        ? (c as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n');
    return text ? { at: stamp, kind: 'prompt', text: capText(text) } : null;
  }
  return null;
}

export function parseWireText(raw: string): ParsedLogEntry[] {
  const out: ParsedLogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const entry = parseWireLine(line);
    if (entry) out.push(entry);
  }
  return out;
}

type LogCursor = {
  session: string;
  dev: string;
  ino: string;
  offset: number;
  anchor: string;
  anchorBytes: number;
};

type PositionedEntry = {
  entry: ParsedLogEntry;
  offset: number;
  anchor: string;
  anchorBytes: number;
};

type LogPage = { entries: LogEntry[]; fileGeneration: string | null; hasOlder: boolean; olderCursor: string | null };

function invalidCursor(): never {
  throw new Refusal('log cursor is stale or invalid');
}

function lineAnchor(line: Buffer): { anchor: string; anchorBytes: number } {
  const prefix = line.subarray(0, CURSOR_ANCHOR_BYTES);
  return { anchor: createHash('sha256').update(prefix).digest('hex'), anchorBytes: prefix.length };
}

function decodeCursor(raw: string, session: string): LogCursor {
  try {
    if (raw.length > 2048) throw new Error();
    const [encoded, supplied, extra] = raw.split('.');
    if (!encoded || !supplied || extra !== undefined || !/^[\w-]+$/.test(encoded) || !/^[\w-]+$/.test(supplied)) {
      throw new Error();
    }
    const expected = createHmac('sha256', CURSOR_KEY).update(encoded).digest();
    const signature = Buffer.from(supplied, 'base64url');
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw new Error();
    const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (value.v !== 1 || value.session !== session || typeof value.dev !== 'string' || !/^\d+$/.test(value.dev)
      || typeof value.ino !== 'string' || !/^\d+$/.test(value.ino)
      || typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) || value.offset <= 0
      || typeof value.anchor !== 'string' || !/^[0-9a-f]{64}$/.test(value.anchor)
      || typeof value.anchorBytes !== 'number' || !Number.isSafeInteger(value.anchorBytes)
      || value.anchorBytes <= 0 || value.anchorBytes > CURSOR_ANCHOR_BYTES) {
      throw new Error();
    }
    return {
      session, dev: value.dev, ino: value.ino, offset: value.offset,
      anchor: value.anchor, anchorBytes: value.anchorBytes,
    };
  } catch {
    return invalidCursor();
  }
}

function encodeCursor(session: string, stat: { dev: number; ino: number }, entry: PositionedEntry): string {
  const encoded = Buffer.from(JSON.stringify({
    v: 1, session, dev: String(stat.dev), ino: String(stat.ino), offset: entry.offset,
    anchor: entry.anchor, anchorBytes: entry.anchorBytes,
  })).toString('base64url');
  return `${encoded}.${createHmac('sha256', CURSOR_KEY).update(encoded).digest('base64url')}`;
}

async function readExact(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(buffer, read, length - read, position + read);
    if (result.bytesRead === 0) throw new Refusal('wire log changed while it was read');
    read += result.bytesRead;
  }
  return buffer;
}

async function validateCursor(handle: FileHandle, stat: { dev: number; ino: number; size: number },
  cursor: LogCursor): Promise<void> {
  if (String(stat.dev) !== cursor.dev || String(stat.ino) !== cursor.ino
    || cursor.offset >= stat.size || cursor.offset + cursor.anchorBytes > stat.size) {
    invalidCursor();
  }
  try {
    const prefix = await readExact(handle, cursor.anchorBytes, cursor.offset);
    if (createHash('sha256').update(prefix).digest('hex') !== cursor.anchor) invalidCursor();
  } catch {
    invalidCursor();
  }
}

async function readLogPage(handle: FileHandle, session: string, before?: string): Promise<LogPage> {
  const cursor = before === undefined ? undefined : decodeCursor(before, session);
  const stat = await handle.stat();
  if (!stat.isFile()) {
    if (cursor) invalidCursor();
    return { entries: [], fileGeneration: null, hasOlder: false, olderCursor: null };
  }
  if (cursor) await validateCursor(handle, stat, cursor);
  const fileGeneration = createHash('sha256').update(`${stat.dev}:${stat.ino}`).digest('hex').slice(0, 16);

  const found: PositionedEntry[] = [];
  let carry = Buffer.alloc(0);
  let insideOverLimitRecord = false;
  let end = cursor?.offset ?? stat.size;
  while (end > 0 && found.length <= MAX_ENTRIES) {
    const start = Math.max(0, end - LOG_CHUNK_BYTES);
    const chunk = await readExact(handle, end - start, start);
    const block = Buffer.concat([chunk, carry]);
    const lines: { line: Buffer; offset: number }[] = [];
    let lineStart = 0;
    for (let i = 0; i < block.length; i++) {
      if (block[i] !== 10) continue;
      lines.push({ line: block.subarray(lineStart, i), offset: start + lineStart });
      lineStart = i + 1;
    }
    if (lineStart < block.length) lines.push({ line: block.subarray(lineStart), offset: start + lineStart });

    const lastNewline = block.lastIndexOf(10);
    const trailingFragment = insideOverLimitRecord && lastNewline < block.length - 1 ? lines.length - 1 : -1;
    for (let i = lines.length - 1; i >= (start === 0 ? 0 : 1); i--) {
      if (i === trailingFragment) continue;
      const { line, offset } = lines[i];
      if (line.length === 0 || line.length > MAX_RECORD_BYTES) continue;
      const entry = parseWireLine(line.toString('utf8'));
      if (!entry) continue;
      found.push({ entry, offset, ...lineAnchor(line) });
      if (found.length > MAX_ENTRIES) break;
    }

    if (insideOverLimitRecord && lastNewline === -1) {
      carry = Buffer.alloc(0);
      if (start !== 0) {
        end = start;
        continue;
      }
    }
    insideOverLimitRecord = false;
    const firstNewline = block.indexOf(10);
    const firstLineLength = firstNewline === -1 ? block.length : firstNewline;
    if (start === 0) {
      carry = Buffer.alloc(0);
    } else if (firstLineLength > MAX_RECORD_BYTES) {
      carry = Buffer.alloc(0);
      insideOverLimitRecord = true;
    } else {
      carry = block.subarray(0, firstNewline === -1 ? block.length : firstNewline + 1);
    }
    end = start;
  }

  const hasOlder = found.length > MAX_ENTRIES;
  const selected = found.slice(0, MAX_ENTRIES).reverse();
  const entries = selected.map(({ entry, offset }) => ({ ...entry, id: `${fileGeneration}:${offset}` }));
  const oldest = selected[0];
  return {
    entries,
    fileGeneration,
    hasOlder,
    olderCursor: hasOlder && oldest ? encodeCursor(session, stat, oldest) : null,
  };
}

function nameOrRefusal(kind: string, value: string): void {
  try {
    checkName(kind, value);
  } catch (e) {
    throw new Refusal(e instanceof Error ? e.message : String(e));
  }
}

async function resolveEntry(
  root: string,
  project: string,
  agentRef?: string,
): Promise<{ entry: TeamEntry; name: string }> {
  nameOrRefusal('project', project);
  const pf = await readProjects(root);
  const p = pf.projects.find((x) => x.name === project);
  if (!p) throw new Refusal(`unknown project: ${project}`);
  const team = await readTeam(p.home);
  if (agentRef === undefined || agentRef === '') {
    const orch = team.agents.find((a) => a.orchestrator);
    if (!orch) throw new Refusal(`${project} has no orchestrator on record`);
    return { entry: orch, name: orch.name };
  }
  const [name, wt] = agentRef.split('@');
  nameOrRefusal('agent', name);
  const matches = team.agents.filter((a) => !a.orchestrator && a.name === name);
  const entry = wt ? matches.find((a) => a.worktree === wt)
    : matches.length === 1 ? matches[0] : undefined;
  if (!entry && matches.length > 1 && !wt) {
    throw new Refusal(`${project} has ${matches.length} agents named ${name}; say which: ${name}@<worktree>`);
  }
  if (!entry) throw new Refusal(`${project} has no agent named ${agentRef}`);
  return { entry, name };
}

export async function resolveLogTarget(root: string, project: string,
  agentRef?: string): Promise<{ name: string; task?: string }> {
  const { entry, name } = await resolveEntry(root, project, agentRef);
  return { name, task: entry.task };
}

export async function readAgentLog(
  root: string,
  project: string,
  agentRef?: string,
  home: string = os.homedir(),
  before?: string,
): Promise<AgentLog> {
  const { entry, name } = await resolveEntry(root, project, agentRef);
  if (!entry.session_id) throw new Refusal(`${name} has no recorded session yet`);
  if (/[/\\]/.test(entry.session_id)) throw new Refusal(`${name}'s session id is not a plain id`);
  let sessionDir: string;
  try {
    sessionDir = await findSessionDir(home, entry.session_id);
  } catch (e) {
    if (e instanceof SessionNotFoundError) {
      throw new Refusal(`${name}'s session ${entry.session_id} has no wire log under ~/.kimi-code/sessions`);
    }
    throw e;
  }
  const file = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
  const handle = await fs.open(file, 'r').catch((e: unknown) => {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  });
  let page: LogPage = { entries: [], fileGeneration: null, hasOlder: false, olderCursor: null };
  if (handle) {
    try {
      page = await readLogPage(handle, entry.session_id, before);
    } finally {
      await handle.close();
    }
  } else if (before !== undefined) {
    invalidCursor();
  }
  return {
    agent: name,
    session_id: entry.session_id,
    fileGeneration: page.fileGeneration,
    hasOlder: page.hasOlder,
    olderCursor: page.olderCursor,
    agents: page.entries.length > 0 ? [{ agentId: 'main', entries: page.entries }] : [],
  };
}
