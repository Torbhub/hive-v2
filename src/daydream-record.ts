import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { readBoundedFile } from './bounded-file.js';
import { parseDaydreamBrief } from './daydream-brief.js';
import { redactSecrets } from './logview.js';
import { parseNativeSnapshot } from './native-history.js';
import { Refusal, hivePath } from './state.js';
import type {
  DaydreamCompactionIntent,
  DaydreamForkIntent,
  DaydreamPromptIntent,
  DaydreamProvenance,
  DaydreamRecord,
  NativeBranchSnapshot,
} from './types.js';

const MAX_RECORD_BYTES = 256 * 1024;
const DAYDREAM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const STATUSES = ['creating', 'mining', 'mined', 'forked', 'compacting', 'compacted', 'recovering', 'recovered', 'unknown'];

class CasConflict extends Error {}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Refusal(`${field} must be an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], field: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Refusal(`${field}: unknown field ${key}`);
}
function text(value: unknown, field: string, cap = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > cap) throw new Refusal(`${field} is invalid`);
  return value;
}
function hash(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Refusal(`${field} is invalid`);
  return value;
}
function optionalId(value: unknown, field: string): string | null {
  return value === null ? null : text(value, field);
}
function snapshotFrom(value: unknown, field: string): NativeBranchSnapshot {
  try {
    return parseNativeSnapshot(value, field);
  } catch (error) {
    throw new Refusal(error instanceof Error ? error.message : String(error));
  }
}
function promptFrom(value: unknown): DaydreamPromptIntent {
  const raw = object(value, 'daydream prompt');
  keys(raw, ['phase', 'status', 'agentId', 'promptId', 'promptHash', 'intentAt', 'nativeMessageId'], 'daydream prompt');
  if (!['mine', 'recover'].includes(String(raw.phase)) || !['submitting', 'accepted', 'unknown'].includes(String(raw.status))) {
    throw new Refusal('daydream prompt phase or status is invalid');
  }
  return {
    phase: raw.phase as DaydreamPromptIntent['phase'],
    status: raw.status as DaydreamPromptIntent['status'],
    ...(raw.agentId === undefined ? {} : { agentId: text(raw.agentId, 'daydream prompt agentId') }),
    promptId: text(raw.promptId, 'daydream promptId'),
    promptHash: hash(raw.promptHash, 'daydream promptHash'),
    intentAt: text(raw.intentAt, 'daydream prompt intentAt', 40),
    ...(raw.nativeMessageId === undefined ? {} : { nativeMessageId: text(raw.nativeMessageId, 'daydream nativeMessageId') }),
  };
}
function provenanceFrom(value: unknown): DaydreamProvenance {
  const raw = object(value, 'daydream provenance');
  keys(raw, ['sessionId', 'agentId', 'promptId', 'turnId', 'stepId', 'frameId', 'frameHash'], 'daydream provenance');
  return {
    sessionId: text(raw.sessionId, 'daydream provenance sessionId'),
    agentId: text(raw.agentId, 'daydream provenance agentId'),
    promptId: text(raw.promptId, 'daydream provenance promptId'),
    turnId: text(raw.turnId, 'daydream provenance turnId'),
    stepId: text(raw.stepId, 'daydream provenance stepId'),
    frameId: text(raw.frameId, 'daydream provenance frameId'),
    frameHash: hash(raw.frameHash, 'daydream provenance frameHash'),
  };
}
function forkFrom(value: unknown): DaydreamForkIntent {
  const raw = object(value, 'daydream fork');
  keys(raw, ['status', 'intentAt'], 'daydream fork');
  if (!['forking', 'unknown', 'completed'].includes(String(raw.status))) throw new Refusal('daydream fork status is invalid');
  return { status: raw.status as DaydreamForkIntent['status'], intentAt: text(raw.intentAt, 'daydream fork intentAt', 40) };
}
function compactionFrom(value: unknown): DaydreamCompactionIntent {
  const raw = object(value, 'daydream compaction');
  keys(raw, ['status', 'instructionHash', 'nonce', 'intentAt', 'watermark', 'serverId', 'serverStartedAt'], 'daydream compaction');
  if (!['submitting', 'unknown', 'completed'].includes(String(raw.status))
    || !Number.isSafeInteger(raw.watermark) || Number(raw.watermark) < 0) throw new Refusal('daydream compaction is invalid');
  return {
    status: raw.status as DaydreamCompactionIntent['status'],
    instructionHash: hash(raw.instructionHash, 'daydream compaction instructionHash'),
    nonce: text(raw.nonce, 'daydream compaction nonce'),
    intentAt: text(raw.intentAt, 'daydream compaction intentAt', 40),
    watermark: Number(raw.watermark),
    serverId: text(raw.serverId, 'daydream compaction serverId'),
    serverStartedAt: text(raw.serverStartedAt, 'daydream compaction serverStartedAt', 40),
  };
}
export function briefBinding(record: DaydreamRecord, phase: 'mine' | 'recover') {
  return {
    id: record.id,
    phase,
    checkpointId: record.checkpointId,
    questionHash: record.questionHash,
    sourceHistoryHash: record.parentSnapshot.historyHash,
  };
}
function recordFrom(value: unknown, id: string): DaydreamRecord {
  const raw = object(value, 'daydream record');
  keys(raw, [
    'schemaVersion', 'id', 'status', 'parentSessionId', 'childSessionId', 'checkpointSessionId', 'workspaceId', 'cwd', 'scope',
    'checkpointId', 'questionHash', 'sourceTaskHash', 'handoffPathHash', 'handoffContentHash',
    'parentSnapshot', 'childSnapshot', 'prompt', 'fork', 'compaction', 'provenance', 'recoveryProvenance', 'minedBrief', 'recoveredBrief',
    'factsHash', 'createdAt', 'updatedAt', 'error',
  ], 'daydream record');
  if (raw.schemaVersion !== 1 || raw.id !== id || !STATUSES.includes(String(raw.status))) throw new Refusal('daydream record schema is invalid');
  const scope = object(raw.scope, 'daydream scope');
  keys(scope, ['project', 'agent', 'task'], 'daydream scope');
  const record = {
    schemaVersion: 1,
    id,
    status: raw.status,
    parentSessionId: text(raw.parentSessionId, 'daydream parentSessionId'),
    childSessionId: optionalId(raw.childSessionId, 'daydream childSessionId'),
    checkpointSessionId: optionalId(raw.checkpointSessionId, 'daydream checkpointSessionId'),
    workspaceId: text(raw.workspaceId, 'daydream workspaceId'),
    cwd: text(raw.cwd, 'daydream cwd', 4_000),
    scope: { project: text(scope.project, 'daydream scope.project'), agent: text(scope.agent, 'daydream scope.agent'), task: text(scope.task, 'daydream scope.task') },
    checkpointId: text(raw.checkpointId, 'daydream checkpointId'),
    questionHash: hash(raw.questionHash, 'daydream questionHash'),
    sourceTaskHash: hash(raw.sourceTaskHash, 'daydream sourceTaskHash'),
    handoffPathHash: hash(raw.handoffPathHash, 'daydream handoffPathHash'),
    handoffContentHash: hash(raw.handoffContentHash, 'daydream handoffContentHash'),
    parentSnapshot: snapshotFrom(raw.parentSnapshot, 'daydream parent snapshot'),
    childSnapshot: raw.childSnapshot === null ? null : snapshotFrom(raw.childSnapshot, 'daydream child snapshot'),
    ...(raw.prompt === undefined ? {} : { prompt: promptFrom(raw.prompt) }),
    ...(raw.fork === undefined ? {} : { fork: forkFrom(raw.fork) }),
    ...(raw.compaction === undefined ? {} : { compaction: compactionFrom(raw.compaction) }),
    ...(raw.provenance === undefined ? {} : { provenance: provenanceFrom(raw.provenance) }),
    ...(raw.recoveryProvenance === undefined ? {} : { recoveryProvenance: provenanceFrom(raw.recoveryProvenance) }),
    ...(raw.factsHash === undefined ? {} : { factsHash: hash(raw.factsHash, 'daydream factsHash') }),
    createdAt: text(raw.createdAt, 'daydream createdAt', 40),
    updatedAt: text(raw.updatedAt, 'daydream updatedAt', 40),
    ...(raw.error === undefined ? {} : { error: redactSecrets(text(raw.error, 'daydream error', 1_000)) }),
  } as DaydreamRecord;
  if (raw.minedBrief !== undefined) record.minedBrief = parseDaydreamBrief(raw.minedBrief, briefBinding(record, 'mine'));
  if (raw.recoveredBrief !== undefined) record.recoveredBrief = parseDaydreamBrief(raw.recoveredBrief, briefBinding(record, 'recover'));
  return record;
}
function daydreamPath(home: string, id: string): string {
  if (!DAYDREAM_ID.test(id)) throw new Refusal('invalid daydream id');
  return hivePath(home, 'daydreams', `${id}.json`);
}
export async function writeRecord(home: string, value: DaydreamRecord): Promise<DaydreamRecord> {
  const record = recordFrom(value, value.id);
  const directory = hivePath(home, 'daydreams');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Refusal('daydream record directory must be a real directory');
  await fs.chmod(directory, 0o700);
  const file = daydreamPath(home, record.id);
  const temporary = `${file}.tmp.${randomUUID()}`;
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, file);
    return record;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
export async function readRecord(home: string, id: string): Promise<DaydreamRecord> {
  let value: unknown;
  try {
    value = JSON.parse(await readBoundedFile(daydreamPath(home, id), MAX_RECORD_BYTES));
  } catch (error) {
    throw new Refusal(`daydream record must be a regular bounded non-symlink file: ${error instanceof Error ? error.message : String(error)}`);
  }
  return recordFrom(value, id);
}
export async function commit(home: string, expected: DaydreamRecord, next: DaydreamRecord): Promise<DaydreamRecord> {
  const current = await readRecord(home, expected.id);
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new CasConflict('daydream record changed');
  return writeRecord(home, next);
}
