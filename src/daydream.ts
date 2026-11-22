import { randomUUID } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { readBoundedFile, readBoundedHandle } from './bounded-file.js';
import { selectBtwTurn } from './btw.js';
import { countCompactionBackfillSummaries, scanCompactionBackfill, scanCompactionLifecycle, scanCompactionLifecycleEvidence } from './compaction-journal.js';
import {
  daydreamFactsHash,
  parseDaydreamBrief,
  redactDaydreamBrief,
  verifyDaydreamCitations,
} from './daydream-brief.js';
import { briefBinding, commit, readRecord, writeRecord } from './daydream-record.js';
import { parseJsonl } from './jsonl.js';
import { redactSecrets } from './logview.js';
import {
  mappedNativeMessageId,
  nativeHistoryIsPrefix,
  nativeSha,
  readNativeHistory,
  sameNativeForkSnapshot,
  sameNativeSnapshot,
  snapshotNativeHistory,
} from './native-history.js';
import { withProjectLock } from './project.js';
import { assertExecutionAllowed } from './rollout.js';
import { Refusal, foldTasks, hivePath, hubPath, readProjects, readTeam, withTeamLock } from './state.js';
import type {
  DaydreamBrief,
  DaydreamCompactionIntent,
  DaydreamNativeClient,
  DaydreamProvenance,
  DaydreamRecord,
  NativeBranchScope,
  NativeBranchSnapshot,
  NativeSession,
  NativeTextPart,
  NativeTranscriptTurn,
  TaskEvent,
  TeamEntry,
} from './types.js';

export { MAX_DAYDREAM_BRIEF_BYTES } from './daydream-brief.js';
export type { DaydreamRecord } from './types.js';

const MAX_TASK_LOG_BYTES = 256 * 1024;
const MAX_HANDOFF_BYTES = 64 * 1024;
const MAX_PROMPT_BYTES = 128 * 1024;
const COMPACT_PREFIX = 'Preserve the active mining question and verified fact structure. Do not answer owner questions or rejoin the parent. Include the nonce verbatim in the compaction summary.';

type Scope = NativeBranchScope;
type CreateScope = Scope & { agent: string };
type TimeOptions = { now?: string; proofContent?: NativeTextPart[] };
type Capture = {
  agent: TeamEntry;
  taskEvents: TaskEvent[];
  handoffPath: string;
  handoffContent: string;
  handoffPathHash: string;
  handoffContentHash: string;
  taskHash: string;
};
function now(options: TimeOptions): string {
  const parsed = options.now === undefined ? new Date() : new Date(options.now);
  if (Number.isNaN(parsed.getTime())) throw new Refusal('invalid daydream timestamp');
  return parsed.toISOString();
}
function enabled(): void {
  if (process.env.HIVE_DAYDREAM !== '1') throw new Refusal('daydream is disabled; set HIVE_DAYDREAM=1');
  if (process.env.HIVE_NATIVE_BRANCHES !== '1') throw new Refusal('native branches are disabled; set HIVE_NATIVE_BRANCHES=1');
}
async function homeFor(scope: Scope): Promise<string> {
  const project = (await readProjects(scope.root)).projects.find((candidate) => candidate.name === scope.project);
  if (!project) throw new Refusal(`unknown project: ${scope.project}`);
  return project.home;
}
async function withDaydreamLock<T>(scope: Scope, fn: (home: string) => Promise<T>): Promise<T> {
  return withProjectLock(scope.root, scope.project, async (project) => withTeamLock(project.home, () => fn(project.home)));
}
async function unknown(home: string, expected: DaydreamRecord, at: string, cause?: unknown): Promise<DaydreamRecord> {
  const detail = cause instanceof Error ? cause.message : 'a native daydream effect did not have a verified outcome';
  const next: DaydreamRecord = {
    ...expected,
    status: 'unknown',
    error: redactSecrets(`unknown: ${detail}`).slice(0, 1_000),
    updatedAt: at,
    ...(expected.fork?.status === 'forking' ? { fork: { ...expected.fork, status: 'unknown' as const } } : {}),
    ...(expected.compaction?.status === 'submitting' ? { compaction: { ...expected.compaction, status: 'unknown' as const } } : {}),
  };
  try {
    return await commit(home, expected, next);
  } catch {
    return next;
  }
}
async function unknownWithoutEffect(home: string, record: DaydreamRecord, at: string, cause: Error): Promise<DaydreamRecord> {
  if (record.status === 'unknown') return record;
  return commit(home, record, {
    ...record,
    status: 'unknown',
    error: redactSecrets(`unknown: ${cause.message}`).slice(0, 1_000),
    updatedAt: at,
  });
}
async function readTaskEvents(root: string): Promise<TaskEvent[]> {
  const file = hubPath(root, 'tasks.jsonl');
  let raw: string;
  try {
    raw = await readBoundedFile(file, MAX_TASK_LOG_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Refusal(`task evidence must be bounded and regular: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseJsonl<TaskEvent>(file, raw);
}
async function readHandoff(agent: TeamEntry, home: string) {
  const file = path.resolve(agent.handoff ?? hivePath(agent.worktree ?? home, 'handoffs', `${agent.name}.md`));
  const root = await fs.realpath(agent.worktree ?? home);
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
    throw new Refusal(`registered handoff cannot be opened: ${error instanceof Error ? error.message : String(error)}`);
  });
  try {
    const canonical = await fs.realpath(`/proc/self/fd/${handle.fd}`);
    if (canonical !== root && !canonical.startsWith(`${root}${path.sep}`)) throw new Refusal('registered handoff escapes the agent worktree');
    const handoffContent = await readBoundedHandle(handle, MAX_HANDOFF_BYTES, file);
    return { handoffPath: file, handoffContent, handoffPathHash: nativeSha(file), handoffContentHash: nativeSha(handoffContent) };
  } catch (error) {
    if (error instanceof Refusal) throw error;
    throw new Refusal(`registered handoff must be a bounded regular non-symlink file: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await handle.close();
  }
}
async function capture(
  scope: CreateScope,
  home: string,
  expected: { sessionId?: string; worktree?: string } = {},
): Promise<Capture> {
  const agents = (await readTeam(home)).agents.filter((agent) => agent.name === scope.agent && !agent.orchestrator
    && (!('sessionId' in expected) || agent.session_id === expected.sessionId)
    && (!('worktree' in expected) || agent.worktree === expected.worktree));
  if (agents.length !== 1 || !agents[0].task || !agents[0].session_id) throw new Refusal('daydream requires one uniquely scoped TeamEntry');
  const agent = agents[0];
  const taskEvents = (await readTaskEvents(scope.root)).filter((event) => event.project === scope.project && event.id === agent.task);
  const task = foldTasks(taskEvents).find((candidate) => candidate.id === agent.task && candidate.project === scope.project);
  if (!task?.plan_approved) throw new Refusal('daydream requires an approved task plan');
  return { agent, taskEvents, taskHash: nativeSha(taskEvents), ...(await readHandoff(agent, home)) };
}
function assertStarted(capture: Capture, checkpointId: string): void {
  const task = foldTasks(capture.taskEvents).find((candidate) => candidate.id === capture.agent.task);
  const lastProgress = capture.taskEvents.filter((event) => event.event === 'progress').at(-1);
  if (!task?.checkpoints?.some((checkpoint) => checkpoint.id === checkpointId)
    || task.progress?.[checkpointId]?.status !== 'started'
    || lastProgress?.checkpoint !== checkpointId || lastProgress.status !== 'started') {
    throw new Refusal('daydream requires the current started checkpoint');
  }
}
async function currentCapture(record: DaydreamRecord, scope: Scope, home: string): Promise<Capture> {
  const captured = await capture({ ...scope, agent: record.scope.agent }, home);
  if (captured.agent.task !== record.scope.task || captured.agent.session_id !== record.parentSessionId) {
    throw new Refusal('daydream TeamEntry is stale');
  }
  if (captured.taskHash !== record.sourceTaskHash || captured.handoffPathHash !== record.handoffPathHash
    || captured.handoffContentHash !== record.handoffContentHash) throw new Refusal('daydream task or handoff evidence is stale');
  return captured;
}
function verifyParent(record: DaydreamRecord, session: NativeSession): void {
  if (!session || session.id !== record.parentSessionId || session.workspace_id !== record.workspaceId || session.metadata.cwd !== record.cwd) {
    throw new Refusal('daydream parent session or workspace is stale');
  }
}
function verifyChild(record: DaydreamRecord, session: NativeSession, checkpoint = false): void {
  const expected = checkpoint ? record.checkpointSessionId : record.childSessionId;
  if (!session || session.id !== expected || session.workspace_id !== record.workspaceId || session.metadata.cwd !== record.cwd
    || session.metadata.hive_daydream_id !== record.id) throw new Error('daydream native session identity changed');
  if (!checkpoint && (session.metadata.parent_session_id !== record.parentSessionId || session.metadata.child_session_kind !== 'child')) {
    throw new Error('daydream native child lineage changed');
  }
}
async function assertParentCurrent(record: DaydreamRecord, native: DaydreamNativeClient): Promise<void> {
  verifyParent(record, await native.getSession(record.parentSessionId));
  if (!sameNativeSnapshot(record.parentSnapshot, await snapshotNativeHistory(native, record.parentSessionId))) {
    throw new Refusal('daydream parent history is stale');
  }
}
function promptContent(value: unknown): NativeTextPart[] {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MAX_PROMPT_BYTES) throw new Refusal('daydream prompt is oversized');
  return [{ type: 'text', text: serialized }];
}
async function readBtwTranscript(native: DaydreamNativeClient, sessionId: string, agentId: string) {
  let page = await native.getTranscript(sessionId, { agentId, pageSize: 100 });
  if (page.seq === undefined && page.items.length === 0) page = await native.getTranscript(sessionId, { agentId, pageSize: 100 });
  if (page.agent_id !== agentId) throw new Error('daydream transcript agent_id conflicts with the persisted BTW agent');
  if (page.has_more) throw new Error('daydream BTW transcript exceeds the bounded page');
  return page;
}
async function btwPromptTurn(native: DaydreamNativeClient, record: DaydreamRecord, proofContent?: NativeTextPart[]) {
  const intent = record.prompt;
  if (!intent?.agentId || !record.childSessionId) throw new Error('daydream BTW prompt intent is incomplete');
  if (intent.promptId !== `hive-daydream-${intent.phase}-${record.id}`) throw new Error('daydream prompt phase or promptId conflicts');
  const page = await readBtwTranscript(native, record.childSessionId, intent.agentId);
  const prompts = page.prompts.filter((candidate) => candidate.promptId === intent.promptId);
  if (prompts.length > 1 || (prompts.length === 0 && page.prompts.length > 0)) {
    throw new Error('daydream BTW promptId is missing or ambiguous');
  }
  if (proofContent && Buffer.byteLength(JSON.stringify(proofContent)) > MAX_PROMPT_BYTES) throw new Refusal('daydream prompt is oversized');
  const prompt = prompts[0] ?? (intent.nativeMessageId && proofContent && nativeSha(proofContent) === intent.promptHash ? {
    promptId: intent.promptId,
    status: 'completed',
    userMessageId: intent.nativeMessageId,
    content: proofContent,
  } : null);
  if (!prompt) throw new Error('daydream BTW promptId is missing or ambiguous');
  if (intent.nativeMessageId && prompt.userMessageId !== intent.nativeMessageId) {
    throw new Error('daydream BTW user message id conflicts with acknowledgement');
  }
  if (nativeSha(prompt.content) !== intent.promptHash) throw new Error('daydream BTW prompt content conflicts with intent');
  const turns = page.items.filter((item): item is NativeTranscriptTurn & { triggerPromptId: string } => (
    item.kind === 'turn' && item.triggerPromptId === intent.promptId
  ));
  return selectBtwTurn(prompt, turns, page.agents, intent.agentId);
}
async function completedBtwPromptTurn(native: DaydreamNativeClient, record: DaydreamRecord, proofContent?: NativeTextPart[]) {
  const selected = await btwPromptTurn(native, record, proofContent);
  if (selected.status === 'pending') throw new Refusal('daydream BTW prompt or turn is pending');
  return selected;
}
async function submitDaydreamPrompt(
  home: string,
  record: DaydreamRecord,
  phase: 'mine' | 'recover',
  content: NativeTextPart[],
  native: DaydreamNativeClient,
  at: string,
): Promise<DaydreamRecord> {
  const childSessionId = record.childSessionId;
  if (!childSessionId) throw new Error('daydream child identity is unavailable');
  if (record.prompt?.phase === phase) {
    if (record.prompt.status !== 'accepted') return unknownWithoutEffect(home, record, at, new Error('daydream prompt has no acknowledgement ID'));
    return reconcileAcknowledgedPrompt(home, record, native, at);
  }
  const promptId = `hive-daydream-${phase}-${record.id}`;
  let current = await commit(home, record, {
    ...record,
    prompt: { phase, status: 'unknown', promptId, promptHash: nativeSha(content), intentAt: at },
    updatedAt: at,
  });
  try {
    const { agent_id: agentId } = await native.createBtw(childSessionId);
    current = await commit(home, current, {
      ...current,
      prompt: { ...current.prompt!, status: 'submitting', agentId },
      updatedAt: at,
    });
    const ack = await native.submitPrompt(childSessionId, { promptId, content, agentId, permissionMode: 'manual' });
    if (ack.prompt_id !== promptId || !ack.user_message_id || !['queued', 'running', 'blocked'].includes(ack.status)
      || JSON.stringify(ack.content) !== JSON.stringify(content)) throw new Error('daydream prompt acknowledgement conflicts with intent');
    current = await commit(home, current, {
      ...current,
      prompt: { ...current.prompt!, status: 'accepted', nativeMessageId: ack.user_message_id },
      updatedAt: at,
    });
    return await reconcileAcknowledgedPrompt(home, current, native, at);
  } catch (error) {
    const failed = await unknown(home, current, at, error);
    if (error instanceof Refusal) throw error;
    return failed;
  }
}
function miningPrompt(record: DaydreamRecord, capture: Capture, question: string): NativeTextPart[] {
  return promptContent({
    kind: 'hive.daydream.mine',
    untrusted: true,
    daydreamId: record.id,
    checkpointId: record.checkpointId,
    question,
    taskEvents: capture.taskEvents,
    handoff: { path: capture.handoffPath, content: capture.handoffContent },
    instructions: 'Return only the requested strict JSON brief. Cite exact evidence. Never answer owner questions or rejoin the parent.',
  });
}
function recoveryPrompt(record: DaydreamRecord, capture: Capture): NativeTextPart[] {
  return promptContent({
    kind: 'hive.daydream.recover',
    untrusted: true,
    daydreamId: record.id,
    checkpointId: record.checkpointId,
    questionHash: record.questionHash,
    minedBrief: record.minedBrief,
    taskEvents: capture.taskEvents,
    handoff: { path: capture.handoffPath, content: capture.handoffContent },
    instructions: `Return only JSON with no prose. Required output: schemaVersion=1, daydreamId=${record.id}, phase='recover', checkpointId=${record.checkpointId}, questionHash=${record.questionHash}, sourceHistoryHash=${record.parentSnapshot.historyHash}. facts and unknowns must be identical to minedBrief. Citations must be native {kind:'native',messageId,contentHash,quote}, task {kind:'task',eventHash,quote}, or handoff {kind:'handoff',pathHash,contentHash,quote} with exact evidence values. Never answer owner questions or rejoin the parent.`,
  });
}
function buildDaydreamRecord(
  scope: CreateScope,
  home: string,
  captured: Capture,
  checkpointId: string,
  question: string,
  parent: NativeSession,
  parentSnapshot: NativeBranchSnapshot,
  at: string,
  daydreamId = randomUUID(),
): DaydreamRecord {
  return {
    schemaVersion: 1,
    id: daydreamId,
    status: 'creating',
    parentSessionId: parent.id,
    childSessionId: null,
    checkpointSessionId: null,
    workspaceId: parent.workspace_id,
    cwd: home,
    scope: { project: scope.project, agent: scope.agent, task: captured.agent.task! },
    checkpointId,
    questionHash: nativeSha(question),
    sourceTaskHash: captured.taskHash,
    handoffPathHash: captured.handoffPathHash,
    handoffContentHash: captured.handoffContentHash,
    parentSnapshot,
    childSnapshot: null,
    createdAt: at,
    updatedAt: at,
  };
}
export async function mineDaydream(
  scope: CreateScope,
  input: {
    checkpointId?: string;
    question: string;
    daydreamId?: string;
    sessionId?: string;
    worktree?: string;
    miningPrompt?: (record: DaydreamRecord) => NativeTextPart[];
  },
  native: DaydreamNativeClient,
  options: TimeOptions = {},
): Promise<DaydreamRecord> {
  enabled();
  return withDaydreamLock(scope, async (home) => {
    await assertExecutionAllowed(scope.root, scope.project);
    if (typeof input.question !== 'string' || !input.question.trim() || input.question.length > 4_000
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.question)) throw new Refusal('daydream question is invalid or oversized');
    if (input.daydreamId !== undefined
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.daydreamId)) {
      throw new Refusal('invalid daydream id');
    }
    const daydreamId = input.daydreamId as ReturnType<typeof randomUUID> | undefined;
    const expected = input.sessionId === undefined && input.worktree === undefined
      ? {}
      : { sessionId: input.sessionId, worktree: input.worktree };
    const captured = await capture(scope, home, expected);
    const checkpointId = input.checkpointId ?? captured.taskEvents.filter((event) => event.event === 'progress').at(-1)?.checkpoint;
    if (!checkpointId) throw new Refusal('daydream requires the current started checkpoint');
    assertStarted(captured, checkpointId);
    const parent = await native.getSession(captured.agent.session_id!);
    if (!parent || parent.id !== captured.agent.session_id || parent.metadata.cwd !== home) throw new Refusal('daydream parent workspace mismatch');
    const parentSnapshot = await snapshotNativeHistory(native, parent.id);
    const at = now(options);
    let current = buildDaydreamRecord(scope, home, captured, checkpointId, input.question, parent, parentSnapshot, at, daydreamId);
    await writeRecord(home, current);
    try {
      const child = await native.createChild(parent.id, { title: `Hive daydream ${current.id}`, metadata: { hive_daydream_id: current.id } });
      const identified = { ...current, childSessionId: child.id };
      verifyChild(identified, child);
      current = await commit(home, current, { ...identified, status: 'mining', updatedAt: at });
      const content = input.miningPrompt?.(current) ?? miningPrompt(current, captured, input.question);
      if (Buffer.byteLength(JSON.stringify(content)) > MAX_PROMPT_BYTES) throw new Refusal('daydream prompt is oversized');
      current = await submitDaydreamPrompt(home, current, 'mine', content, native, at);
      if (current.status === 'unknown') return current;
      const childSnapshot = await snapshotNativeHistory(native, current.childSessionId!);
      return await commit(home, current, { ...current, childSnapshot, status: 'mining', updatedAt: at, error: undefined });
    } catch (error) {
      const failed = await unknown(home, current, at, error);
      if (error instanceof Refusal) throw error;
      return failed;
    }
  });
}
export async function readDaydream(scope: Scope, id: string): Promise<DaydreamRecord> {
  const record = await readRecord(await homeFor(scope), id);
  if (record.scope.project !== scope.project) throw new Refusal('daydream project scope mismatch');
  return record;
}
export async function listDaydreams(root: string, project: string): Promise<DaydreamRecord[]> {
  const home = await homeFor({ root, project });
  const entries = await fs.readdir(hivePath(home, 'daydreams'), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const records: DaydreamRecord[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.json')) records.push(await readRecord(home, entry.name.slice(0, -5)));
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
function btwBriefProvenance(
  record: DaydreamRecord,
  value: unknown,
  turn: NativeTranscriptTurn & { triggerPromptId: string },
): DaydreamProvenance {
  const expected = JSON.stringify(value);
  const matches = turn.steps.flatMap((step) => step.frames.map((frame) => ({ step, frame }))).filter(({ frame }) => {
    if (frame.kind !== 'text' || frame.role !== 'assistant' || typeof frame.text !== 'string') return false;
    try {
      return JSON.stringify(JSON.parse(frame.text)) === expected;
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) throw new Refusal('daydream brief requires exactly one unambiguous assistant JSON text frame');
  const { step, frame } = matches[0];
  return {
    sessionId: record.childSessionId!,
    agentId: record.prompt!.agentId!,
    promptId: turn.triggerPromptId,
    turnId: turn.turnId,
    stepId: step.stepId,
    frameId: frame.frameId,
    frameHash: nativeSha(frame.text),
  };
}
async function verifyMinedBrief(record: DaydreamRecord, value: unknown, captured: Capture, native: DaydreamNativeClient, proofContent?: NativeTextPart[]) {
  const brief = parseDaydreamBrief(value, briefBinding(record, 'mine'));
  const { turn } = await completedBtwPromptTurn(native, record, proofContent);
  const provenance = btwBriefProvenance(record, value, turn);
  const nativeMessages = await readNativeHistory(native, record.childSessionId!);
  verifyDaydreamCitations(brief, {
    nativeMessages,
    taskEvents: captured.taskEvents,
    handoff: { pathHash: captured.handoffPathHash, contentHash: captured.handoffContentHash, content: captured.handoffContent },
  });
  return { brief, provenance };
}
async function forkDaydreamCheckpoint(home: string, record: DaydreamRecord, native: DaydreamNativeClient, at: string): Promise<DaydreamRecord> {
  let current = record;
  try {
    if (!current.checkpointSessionId) {
      if (current.fork?.status === 'unknown') return current;
      if (current.fork?.status === 'forking') {
        return unknownWithoutEffect(home, current, at, new Error('daydream fork intent has no checkpoint ID'));
      }
      current = await commit(home, current, { ...current, fork: { status: 'forking', intentAt: at }, updatedAt: at });
      const fork = await native.forkSession(current.childSessionId!, { title: `Hive daydream checkpoint ${current.id}`, metadata: { hive_daydream_id: current.id } });
      const identified = { ...current, checkpointSessionId: fork.id };
      verifyChild(identified, fork, true);
      current = await commit(home, current, { ...identified, updatedAt: at });
    }
    verifyChild(current, await native.getSession(current.checkpointSessionId!), true);
    const [source, checkpoint] = await Promise.all([
      snapshotNativeHistory(native, current.childSessionId!),
      snapshotNativeHistory(native, current.checkpointSessionId!),
    ]);
    if (!sameNativeForkSnapshot(source, current.childSessionId!, current.checkpointSessionId!, checkpoint)) {
      throw new Error('daydream checkpoint fork is not the current full-history snapshot');
    }
    return await commit(home, current, {
      ...current,
      fork: { status: 'completed', intentAt: current.fork?.intentAt ?? at },
      status: 'forked',
      updatedAt: at,
    });
  } catch (error) {
    return unknown(home, current, at, error);
  }
}
function compactionInstruction(record: DaydreamRecord): string {
  if (!record.compaction) throw new Error('daydream compaction nonce is unavailable');
  return `${COMPACT_PREFIX} nonce=${record.compaction.nonce}`;
}
async function proveCompaction(native: DaydreamNativeClient, record: DaydreamRecord): Promise<NativeBranchSnapshot | null> {
  const intent = record.compaction;
  if (!intent || !record.childSessionId) throw new Error('daydream compaction intent is unavailable');
  const instruction = compactionInstruction(record);
  if (nativeSha(instruction) !== intent.instructionHash) throw new Error('daydream compaction instruction hash conflicts with its nonce');
  const [meta, page] = await Promise.all([
    native.getServerMeta(),
    native.listTranscriptOps(record.childSessionId, { agentId: 'main', sinceSeq: intent.watermark }),
  ]);
  const incarnationChanged = meta.server_id !== intent.serverId || meta.started_at !== intent.serverStartedAt;
  if (page.agent_id !== 'main') throw new Error('daydream compaction journal agent_id conflicts with main');
  const lifecycleEvidence = scanCompactionLifecycleEvidence(page, intent.watermark, instruction);
  if (!incarnationChanged && page.complete) {
    scanCompactionLifecycle(page, intent.watermark, instruction);
    return null;
  }
  const transcript = await native.getTranscript(record.childSessionId, { agentId: 'main', pageSize: 100 });
  if (transcript.agent_id !== 'main') throw new Error('daydream backfill transcript agent_id conflicts with main');
  if (transcript.has_more) throw new Error('daydream backfill transcript exceeds the bounded page');
  if (lifecycleEvidence === 'pair' && page.complete && countCompactionBackfillSummaries(transcript.items, intent.nonce) === 0) {
    scanCompactionLifecycle(page, intent.watermark, instruction);
    return null;
  }
  scanCompactionBackfill(transcript.items, intent.nonce);
  return snapshotNativeHistory(native, record.childSessionId);
}
async function compactDaydreamChild(home: string, record: DaydreamRecord, native: DaydreamNativeClient, at: string): Promise<DaydreamRecord> {
  let current = record;
  try {
    if (!current.compaction) {
      const [meta, watermark] = await Promise.all([
        native.getServerMeta(),
        native.getTranscriptWatermark(current.childSessionId!, { agentId: 'main', pageSize: 1 }),
      ]);
      const nonce = randomUUID();
      const intent: DaydreamCompactionIntent = {
        status: 'submitting',
        instructionHash: nativeSha(`${COMPACT_PREFIX} nonce=${nonce}`),
        nonce,
        intentAt: at,
        watermark: watermark.seq,
        serverId: meta.server_id,
        serverStartedAt: meta.started_at,
      };
      current = await commit(home, current, { ...current, status: 'compacting', compaction: intent, updatedAt: at });
      await native.compactSession(current.childSessionId!, { instruction: compactionInstruction(current) });
    }
    const backfillSnapshot = await proveCompaction(native, current);
    return await commit(home, current, {
      ...current,
      ...(backfillSnapshot ? { childSnapshot: backfillSnapshot } : {}),
      status: 'compacted',
      compaction: { ...current.compaction!, status: 'completed' },
      updatedAt: at,
      error: undefined,
    });
  } catch (error) {
    return unknown(home, current, at, error);
  }
}
export async function verifyDaydreamBrief(
  scope: Scope,
  id: string,
  value: unknown,
  native: DaydreamNativeClient,
  options: TimeOptions = {},
): Promise<DaydreamRecord> {
  enabled();
  return withDaydreamLock(scope, async (home) => {
    await assertExecutionAllowed(scope.root, scope.project);
    let record = await readDaydream(scope, id);
    const at = now(options);
    if (record.status === 'compacted' || record.status === 'recovered') {
      const brief = parseDaydreamBrief(value, briefBinding(record, 'mine'));
      if (daydreamFactsHash(brief) !== record.factsHash) throw new Refusal('daydream mined facts conflict with the terminal brief');
      return record;
    }
    if (record.status !== 'mining' && record.status !== 'mined' && record.status !== 'forked') throw new Refusal(`daydream is ${record.status}; mining verification is blocked`);
    const captured = await currentCapture(record, scope, home);
    await assertParentCurrent(record, native);
    const childSnapshot = await snapshotNativeHistory(native, record.childSessionId!);
    if (!record.childSnapshot || !nativeHistoryIsPrefix(record.childSnapshot, childSnapshot)) throw new Refusal('daydream child history was rewritten');
    const { brief, provenance } = await verifyMinedBrief(record, value, captured, native, options.proofContent);
    const minedBrief = redactDaydreamBrief(brief);
    const factsHash = daydreamFactsHash(minedBrief);
    if (record.factsHash && record.factsHash !== factsHash) throw new Refusal('daydream mined facts conflict with the terminal brief');
    if (!record.minedBrief) {
      record = await commit(home, record, { ...record, minedBrief, provenance, factsHash, status: 'mined', updatedAt: at });
    }
    record = await forkDaydreamCheckpoint(home, record, native, at);
    if (record.status === 'unknown') return record;
    return compactDaydreamChild(home, record, native, at);
  });
}
async function reconcileAcknowledgedPrompt(home: string, record: DaydreamRecord, native: DaydreamNativeClient, at: string, proofContent?: NativeTextPart[]): Promise<DaydreamRecord> {
  const prompt = record.prompt;
  if (!prompt || prompt.status !== 'accepted' || !record.childSessionId) return record;
  const selected = await btwPromptTurn(native, record, proofContent);
  if (selected.status === 'pending' && !prompt.nativeMessageId) throw new Error('daydream BTW prompt is pending without an acknowledgement');
  return commit(home, record, {
    ...record,
    prompt: { ...prompt, nativeMessageId: prompt.nativeMessageId ?? selected.prompt.userMessageId },
    status: prompt.phase === 'mine' ? 'mining' : 'recovering',
    error: undefined,
    updatedAt: at,
  });
}
async function reconcileAcceptedMiningSnapshot(
  home: string,
  record: DaydreamRecord,
  native: DaydreamNativeClient,
  at: string,
  proofContent?: NativeTextPart[],
): Promise<DaydreamRecord> {
  const reconciled = await reconcileAcknowledgedPrompt(home, record, native, at, proofContent);
  if (reconciled.status === 'unknown' || reconciled.childSnapshot) return reconciled;
  const childSnapshot = await snapshotNativeHistory(native, reconciled.childSessionId!);
  return commit(home, reconciled, { ...reconciled, childSnapshot, status: 'mining', updatedAt: at });
}
async function reconcileDaydreamNative(home: string, record: DaydreamRecord, native: DaydreamNativeClient, at: string, proofContent?: NativeTextPart[]): Promise<DaydreamRecord> {
  let current = record;
  try {
    if (!current.childSessionId) {
      const children = await native.listChildren(current.parentSessionId, { pageSize: 100 });
      if (children.has_more) throw new Error('daydream child discovery is truncated');
      const matches = children.items.filter((child) => child.metadata.hive_daydream_id === current.id);
      if (matches.length !== 1) throw new Error('daydream native child discovery is not unique');
      const identified = { ...current, childSessionId: matches[0].id };
      verifyChild(identified, matches[0]);
      current = await commit(home, current, { ...identified, status: 'mining', error: undefined, updatedAt: at });
    }
    verifyChild(current, await native.getSession(current.childSessionId!), false);
    if (current.fork?.status === 'unknown' && !current.checkpointSessionId) return current;
    if (current.fork?.status === 'forking' && !current.checkpointSessionId) {
      return unknownWithoutEffect(home, current, at, new Error('daydream fork intent has no checkpoint ID'));
    }
    if (current.prompt && !current.prompt.nativeMessageId && current.prompt.status !== 'accepted') {
      const { prompt: transcriptPrompt } = await completedBtwPromptTurn(native, current, proofContent);
      current = await commit(home, current, {
        ...current,
        prompt: { ...current.prompt, status: 'accepted', nativeMessageId: transcriptPrompt.userMessageId },
        updatedAt: at,
      });
    }
    if (current.prompt?.phase === 'recover' && current.prompt.status === 'accepted') {
      return reconcileAcknowledgedPrompt(home, current, native, at, proofContent);
    }
    if (current.prompt?.phase === 'mine' && current.prompt.status === 'accepted' && !current.fork && !current.compaction
      && (current.status === 'unknown' || (current.status === 'mining' && !current.childSnapshot))) {
      current = await reconcileAcceptedMiningSnapshot(home, current, native, at, proofContent);
    }
    if (current.compaction && (current.status === 'compacting' || current.status === 'unknown')) {
      const backfillSnapshot = await proveCompaction(native, current);
      current = await commit(home, current, {
        ...current,
        ...(backfillSnapshot ? { childSnapshot: backfillSnapshot } : {}),
        status: 'compacted',
        compaction: { ...current.compaction, status: 'completed' },
        error: undefined,
        updatedAt: at,
      });
    }
    return current;
  } catch (error) {
    return unknown(home, current, at, error);
  }
}
async function verifyRecoveryBrief(
  home: string,
  record: DaydreamRecord,
  value: unknown,
  captured: Capture,
  native: DaydreamNativeClient,
  at: string,
  proofContent?: NativeTextPart[],
): Promise<DaydreamRecord> {
  const brief = parseDaydreamBrief(value, briefBinding(record, 'recover'));
  if (!record.factsHash || daydreamFactsHash(brief) !== record.factsHash) {
    throw new Refusal('recovery facts and unknowns must match the mined brief exactly');
  }
  const { turn } = await completedBtwPromptTurn(native, record, proofContent);
  const recoveryProvenance = btwBriefProvenance(record, value, turn);
  const checkpointMessages = await readNativeHistory(native, record.checkpointSessionId!);
  const nativeMessages = checkpointMessages.map((message) => {
    const sourceId = mappedNativeMessageId(message.id, record.checkpointSessionId!, record.childSessionId!);
    return sourceId ? { ...message, id: sourceId } : message;
  });
  verifyDaydreamCitations(brief, {
    nativeMessages,
    taskEvents: captured.taskEvents,
    handoff: { pathHash: captured.handoffPathHash, contentHash: captured.handoffContentHash, content: captured.handoffContent },
  });
  return commit(home, record, {
    ...record,
    recoveredBrief: redactDaydreamBrief(brief),
    recoveryProvenance,
    status: 'recovered',
    updatedAt: at,
    error: undefined,
  });
}
export async function recoverDaydream(
  scope: Scope,
  id: string,
  value: unknown,
  native: DaydreamNativeClient,
  options: TimeOptions = {},
): Promise<DaydreamRecord> {
  enabled();
  return withDaydreamLock(scope, async (home) => {
    await assertExecutionAllowed(scope.root, scope.project);
    let record = await readDaydream(scope, id);
    const at = now(options);
    if (record.status === 'recovered') {
      if (value === undefined) return record;
      const brief = parseDaydreamBrief(value, briefBinding(record, 'recover'));
      if (daydreamFactsHash(brief) !== record.factsHash) throw new Refusal('recovery facts conflict with the terminal brief');
      return record;
    }
    if (record.status === 'mining' && record.prompt?.phase === 'mine'
      && record.prompt.status === 'accepted' && !record.childSnapshot) {
      return reconcileAcceptedMiningSnapshot(home, record, native, at, options.proofContent);
    }
    record = await reconcileDaydreamNative(home, record, native, at, options.proofContent);
    if (value === undefined && record.status === 'mining') return record;
    if (record.status === 'unknown') return record;
    const captured = await currentCapture(record, scope, home);
    await assertParentCurrent(record, native);
    if (record.status === 'compacted') {
      record = await submitDaydreamPrompt(home, record, 'recover', recoveryPrompt(record, captured), native, at);
      if (record.status === 'unknown') return record;
      record = await commit(home, record, { ...record, status: 'recovering', updatedAt: at });
    }
    if (record.status !== 'recovering') throw new Refusal(`daydream is ${record.status}; recovery is blocked until native compaction proof`);
    if (value === undefined) return record;
    return verifyRecoveryBrief(home, record, value, captured, native, at, options.proofContent);
  });
}
