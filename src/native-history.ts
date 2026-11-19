import { createHash } from 'node:crypto';
import type {
  NativeBranchClient,
  NativeBranchSnapshot,
  NativeMessage,
} from './types.js';

export const NATIVE_HISTORY_SNAPSHOT_CAP = 100;

export class NativeHistoryError extends Error {
  constructor(readonly kind: 'cap' | 'diverged', message: string) {
    super(message);
  }
}

export function nativeSha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function parseNativeSnapshot(value: unknown, field: string): NativeBranchSnapshot {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!raw) throw new Error(`${field} must be an object`);
  for (const key of Object.keys(raw)) if (!['count', 'headId', 'historyHash', 'messages'].includes(key)) throw new Error(`${field}: unknown field ${key}`);
  if (!Array.isArray(raw.messages) || raw.messages.length > NATIVE_HISTORY_SNAPSHOT_CAP || raw.count !== raw.messages.length) {
    throw new Error(`${field}.messages is invalid`);
  }
  const ids = new Set<string>();
  const messages = raw.messages.map((entry, index) => {
    const item = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : null;
    if (!item) throw new Error(`${field}.messages[${index}] must be an object`);
    for (const key of Object.keys(item)) if (!['id', 'contentHash'].includes(key)) throw new Error(`${field}.messages[${index}]: unknown field ${key}`);
    const id = item.id;
    const contentHash = item.contentHash;
    if (typeof id !== 'string' || !id.trim() || id.length > 200 || ids.has(id)) throw new Error(`${field} has invalid or duplicate message ids`);
    if (typeof contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(contentHash)) throw new Error(`${field}.messages[${index}].contentHash is invalid`);
    ids.add(id);
    return { id, contentHash };
  });
  const headId = raw.headId === null ? null : raw.headId;
  if (headId !== (messages.at(-1)?.id ?? null)) throw new Error(`${field}.headId conflicts with history`);
  if (typeof raw.historyHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.historyHash) || raw.historyHash !== nativeSha(messages)) {
    throw new Error(`${field}.historyHash conflicts with history`);
  }
  return { count: messages.length, headId: headId as string | null, historyHash: raw.historyHash, messages };
}

export async function readNativeHistory(native: NativeBranchClient, sessionId: string): Promise<NativeMessage[]> {
  const newest: NativeMessage[] = [];
  const ids = new Set<string>();
  let beforeId: string | undefined;
  for (;;) {
    const page = await native.listMessages(sessionId, { beforeId, pageSize: NATIVE_HISTORY_SNAPSHOT_CAP });
    if (!page || !Array.isArray(page.items) || typeof page.has_more !== 'boolean') {
      throw new NativeHistoryError('cap', 'native history page is malformed');
    }
    if (page.has_more && page.items.length < NATIVE_HISTORY_SNAPSHOT_CAP) {
      throw new NativeHistoryError('cap', 'native history cap exhausted');
    }
    for (const message of page.items) {
      if (!message || typeof message.id !== 'string' || !message.id || message.session_id !== sessionId
        || !Array.isArray(message.content) || typeof message.created_at !== 'string') {
        throw new NativeHistoryError('diverged', 'native history message is malformed');
      }
      if (ids.has(message.id)) throw new NativeHistoryError('diverged', 'native history has duplicate ids');
      ids.add(message.id);
      newest.push(message);
    }
    if (!page.has_more) break;
    if (newest.length >= NATIVE_HISTORY_SNAPSHOT_CAP || page.items.length === 0) {
      throw new NativeHistoryError('cap', 'native history cap exhausted');
    }
    beforeId = page.items.at(-1)?.id;
    if (!beforeId) throw new NativeHistoryError('cap', 'native history cursor is invalid');
  }
  return newest.reverse();
}

export async function snapshotNativeHistory(
  native: NativeBranchClient,
  sessionId: string,
): Promise<NativeBranchSnapshot> {
  const history = await readNativeHistory(native, sessionId);
  const messages = history.map((message) => ({ id: message.id, contentHash: nativeSha(message.content) }));
  return { count: messages.length, headId: messages.at(-1)?.id ?? null, historyHash: nativeSha(messages), messages };
}

export function sameNativeSnapshot(a: NativeBranchSnapshot, b: NativeBranchSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sessionPrefixes(sessionId: string): string[] {
  return [...new Set([`msg_${sessionId}_`, `msg_${sessionId.replace(/^session_/, '')}_`])];
}

export function mappedNativeMessageId(messageId: string, sourceSessionId: string, targetSessionId: string): string | null {
  const sourcePrefixes = sessionPrefixes(sourceSessionId);
  const targetPrefixes = sessionPrefixes(targetSessionId);
  for (const [index, prefix] of sourcePrefixes.entries()) {
    if (!messageId.startsWith(prefix)) continue;
    const suffix = messageId.slice(prefix.length);
    return suffix ? `${targetPrefixes[index]}${suffix}` : null;
  }
  return null;
}

export function sameNativeForkSnapshot(
  baseline: NativeBranchSnapshot,
  sourceSessionId: string,
  targetSessionId: string,
  current: NativeBranchSnapshot,
): boolean {
  if (baseline.count !== current.count) return false;
  return baseline.messages.every((source, index) => {
    const target = current.messages[index];
    if (!target || source.contentHash !== target.contentHash) return false;
    if (source.id === target.id) return true;
    return mappedNativeMessageId(source.id, sourceSessionId, targetSessionId) === target.id;
  });
}

export function nativeHistoryIsPrefix(baseline: NativeBranchSnapshot, current: NativeBranchSnapshot): boolean {
  return baseline.count <= current.count && baseline.messages.every((entry, index) => {
    const candidate = current.messages[index];
    return candidate && candidate.id === entry.id && candidate.contentHash === entry.contentHash;
  });
}

export async function exactNativeDelivery(
  native: NativeBranchClient,
  sessionId: string,
  content: NativeMessage['content'],
  messageId: string,
): Promise<NativeMessage[]> {
  const messages = await readNativeHistory(native, sessionId);
  return messages.filter((message) => message.id === messageId
    && message.session_id === sessionId && message.role === 'user'
    && JSON.stringify(message.content) === JSON.stringify(content));
}
