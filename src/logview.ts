import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findSessionDir, readTailBytes } from './death-bundle.js';
import { checkName } from './names.js';
import { readProjects, readTeam, Refusal } from './state.js';
import type { TeamEntry } from './types.js';

export type LogEntryKind = 'think' | 'text' | 'tool' | 'prompt';

export type LogEntry = { at: string; kind: LogEntryKind; text: string };

export type AgentLog = {
  agent: string;
  session_id: string;
  agents: { agentId: string; entries: LogEntry[] }[];
};

const TAIL_BYTES = 256 * 1024;
const MAX_ENTRIES = 100;
const TEXT_CAP = 500;

// Wire logs can hold secrets the agent saw mid-turn. These go out over the
// wire to any browser that reaches the hub, so the common key shapes die here.
// The kv rule keeps a secret's key name, so it runs before the generic hex
// rule that would otherwise eat the value. The kv and Authorization rules
// tolerate backslash-escaped quotes because the tool.call renderer embeds
// JSON.stringify output, which manufactures exactly those.
export function redactSecrets(text: string): string {
  return text
    // Authorization header shapes: the scheme stays, the credential dies.
    .replace(/(authorization\\?["']?\s*[:=]?\s*\\?["']?\s*(?:bearer|basic|token)\s+)[^\s"',}\\]+/gi, '$1[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g, '[redacted-gh-token]')
    .replace(/\bxox[bp]-[A-Za-z0-9-]{8,}/g, '[redacted-slack-token]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g, '[redacted-jwt]')
    // kv: a quoted value (plain or \"-escaped, 3+ chars) runs to its closing
    // quote — \\. is one escape pair and the closer may not follow a
    // backslash, so an interior escaped quote does not end it; a bare value
    // (8+ chars) ends at space, quote, comma, brace, bracket, or backslash.
    .replace(/((?:api[_-]?key|token|secret|password)\w*\\?["']?\s*[:=]\s*)(?:(\\?["'])(?:\\.|[^"'\\]){3,}?(?<!\\)\2|[^"'\s,}\]\\[]{8,})/gi, '$1$2[redacted]$2')
    // URL userinfo: //user:pass@ — the user stays, the pass dies.
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

// One wire.jsonl line → one entry, or null for anything that is not part of
// the thinking view (steps, usage, results) or does not parse.
export function parseWireLine(line: string): LogEntry | null {
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

export function parseWireText(raw: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const entry = parseWireLine(line);
    if (entry) out.push(entry);
  }
  return out;
}

// Name validation failures are operator input problems, not infrastructure:
// they answer as a 400 Refusal, never a 500.
function nameOrRefusal(kind: string, value: string): void {
  try {
    checkName(kind, value);
  } catch (e) {
    throw new Refusal(e instanceof Error ? e.message : String(e));
  }
}

// Resolve which team entry the operator asked about; a bare name that matches
// two agents is an error, never a guess (same rule as readDialogFor).
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

export async function readAgentLog(
  root: string,
  project: string,
  agentRef?: string,
  home: string = os.homedir(),
): Promise<AgentLog> {
  const { entry, name } = await resolveEntry(root, project, agentRef);
  if (!entry.session_id) throw new Refusal(`${name} has no recorded session yet`);
  if (/[/\\]/.test(entry.session_id)) throw new Refusal(`${name}'s session id is not a plain id`);
  let sessionDir: string;
  try {
    sessionDir = await findSessionDir(home, entry.session_id);
  } catch {
    // A rotated session or a box without ~/.kimi-code/sessions: a stale
    // record is operator-facing state, not a server fault.
    throw new Refusal(`${name}'s session ${entry.session_id} has no wire log under ~/.kimi-code/sessions`);
  }
  const file = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
  const st = await fs.stat(file).catch(() => null);
  const entries = st?.isFile()
    ? parseWireText(await readTailBytes(file, TAIL_BYTES)).slice(-MAX_ENTRIES)
    : [];
  return {
    agent: name,
    session_id: entry.session_id,
    agents: entries.length > 0 ? [{ agentId: 'main', entries }] : [],
  };
}
