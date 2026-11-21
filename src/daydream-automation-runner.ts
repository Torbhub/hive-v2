import { parseDaydreamBrief } from './daydream-brief.js';
import { briefBinding } from './daydream-record.js';
import {
  mineDaydream,
  readDaydream,
  recoverDaydream,
  verifyDaydreamBrief,
} from './daydream.js';
import { selectBtwTurn } from './btw.js';
import { processLeaseStatus } from './process-lease.js';
import type {
  DaydreamAutomationOutcome,
  DaydreamAutomationReconcileInput,
  DaydreamAutomationRunInput,
  DaydreamAutomationRunner,
  DaydreamAutomationUnknownStage,
  DaydreamNativeClient,
  DaydreamRecord,
  NativeTextPart,
  NativeTranscriptTurn,
} from './types.js';

const QUESTION = 'Which approved-plan and current-checkpoint facts must survive compaction? Return only cited facts and unknowns.';
const BRIEF_WAIT_MS = 60_000;
const BRIEF_POLL_MS = 250;

function outcome(
  input: { daydreamId: string },
  status: DaydreamAutomationOutcome['status'],
  prompts: number,
  compactions: number,
  unknownStage?: DaydreamAutomationUnknownStage,
): DaydreamAutomationOutcome {
  return { daydreamId: input.daydreamId, status, prompts, compactions, tokens: 0, ...(unknownStage ? { unknownStage } : {}) };
}

function unknownStage(record: DaydreamRecord): DaydreamAutomationUnknownStage {
  if (record.compaction && record.compaction.status !== 'completed') return 'compaction';
  if (record.fork && record.fork.status !== 'completed') return 'fork';
  if (record.status === 'creating') return 'child';
  if (record.prompt && record.prompt.status !== 'accepted') return 'prompt';
  return 'result';
}

function promptCount(record: DaydreamRecord): number {
  return record.prompt ? 1 : 0;
}

async function readBriefFrame(
  native: DaydreamNativeClient,
  record: DaydreamRecord,
  phase: 'mine' | 'recover',
): Promise<unknown | undefined> {
  const intent = record.prompt;
  if (!intent?.agentId || !record.childSessionId) throw new Error('daydream automation prompt identity is incomplete');
  const page = await native.getTranscript(record.childSessionId, { agentId: intent.agentId, pageSize: 100 });
  if (page.agent_id !== intent.agentId || page.has_more) throw new Error('daydream automation transcript is ambiguous');
  const prompts = page.prompts.filter((candidate) => candidate.promptId === intent.promptId);
  if (prompts.length !== 1) throw new Error('daydream automation prompt proof is missing or duplicated');
  const turns = page.items.filter((item): item is NativeTranscriptTurn & { triggerPromptId: string } => (
    item.kind === 'turn' && item.triggerPromptId === intent.promptId
  ));
  const selected = selectBtwTurn(prompts[0], turns, page.agents, intent.agentId);
  if (selected.status === 'pending') return undefined;
  const candidates: unknown[] = [];
  for (const step of selected.turn.steps) {
    for (const frame of step.frames) {
      if (frame.kind !== 'text' || frame.role !== 'assistant' || typeof frame.text !== 'string') continue;
      try {
        candidates.push(parseDaydreamBrief(JSON.parse(frame.text), briefBinding(record, phase)));
      } catch {
      }
    }
  }
  if (candidates.length !== 1) throw new Error('daydream automation brief is missing or ambiguous');
  return candidates[0];
}

async function waitForBrief(
  native: DaydreamNativeClient,
  record: DaydreamRecord,
  phase: 'mine' | 'recover',
): Promise<unknown> {
  const deadline = Date.now() + BRIEF_WAIT_MS;
  for (;;) {
    const brief = await readBriefFrame(native, record, phase);
    if (brief !== undefined) return brief;
    if (Date.now() >= deadline) throw new Error('daydream automation brief remained pending');
    await new Promise((resolve) => setTimeout(resolve, BRIEF_POLL_MS));
  }
}

type AutomationRunOptions = {
  miningPrompt?: (record: DaydreamRecord) => NativeTextPart[];
};

async function run(input: DaydreamAutomationRunInput & AutomationRunOptions): Promise<DaydreamAutomationOutcome> {
  const native = input.native;
  if (!native) throw new Error('daydream automation requires a native client');
  const scope = { root: input.root, project: input.project };
  const at = new Date(input.now).toISOString();
  let record = await mineDaydream(
    { ...scope, agent: input.agent.name },
    {
      question: QUESTION,
      daydreamId: input.daydreamId,
      sessionId: input.sessionId,
      worktree: input.agent.worktree,
      ...(input.miningPrompt ? { miningPrompt: input.miningPrompt } : {}),
    },
    native,
    { now: at },
  );
  if (record.status === 'unknown') return outcome(input, 'unknown', promptCount(record), 0, unknownStage(record));

  const minedBrief = await waitForBrief(native, record, 'mine');
  record = await verifyDaydreamBrief(scope, input.daydreamId, minedBrief, native, { now: at });
  if (record.status === 'unknown') {
    return outcome(input, 'unknown', promptCount(record), record.compaction ? 1 : 0, unknownStage(record));
  }

  record = await recoverDaydream(scope, input.daydreamId, undefined, native, { now: at });
  if (record.status === 'unknown') return outcome(input, 'unknown', 2, 1, unknownStage(record));
  const recoveredBrief = await waitForBrief(native, record, 'recover');
  record = await recoverDaydream(scope, input.daydreamId, recoveredBrief, native, { now: at });
  if (record.status !== 'recovered') return outcome(input, 'unknown', 2, 1, unknownStage(record));
  return outcome(input, 'recovered', 2, 1);
}

async function missingChildProof(input: DaydreamAutomationReconcileInput): Promise<DaydreamAutomationOutcome> {
  if (await processLeaseStatus(input.ownerPid, input.ownerStartTime) !== 'dead') {
    return outcome(input, 'unknown', 0, 0, 'child');
  }
  if (!input.native) return outcome(input, 'unknown', 0, 0, 'child');
  const children = await input.native.listChildren(input.parentSessionId, { pageSize: 100 });
  if (children.has_more) return outcome(input, 'unknown', 0, 0, 'child');
  const matches = children.items.filter((child) => child.metadata.hive_daydream_id === input.daydreamId);
  return matches.length === 0
    ? outcome(input, 'missing', 0, 0)
    : outcome(input, 'unknown', 0, 0, 'child');
}

function isEnoent(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown };
  return candidate.code === 'ENOENT'
    || (typeof candidate.message === 'string' && /\bENOENT\b/.test(candidate.message));
}

async function reconcile(input: DaydreamAutomationReconcileInput): Promise<DaydreamAutomationOutcome> {
  try {
    const record = await readDaydream({ root: input.root, project: input.project }, input.daydreamId);
    if (record.status === 'recovered') return outcome(input, 'recovered', 0, 0);
    if (record.status === 'creating' && !record.childSessionId && !record.prompt) return missingChildProof(input);
    return outcome(input, 'unknown', 0, 0, unknownStage(record));
  } catch (error) {
    return isEnoent(error)
      ? missingChildProof(input)
      : outcome(input, 'unknown', 0, 0, 'child');
  }
}

export function createDaydreamAutomationRunner(
  native: DaydreamNativeClient,
  options: AutomationRunOptions = {},
): DaydreamAutomationRunner {
  return {
    run: (input) => run({ ...input, native, ...options }),
    reconcile: (input) => reconcile({ ...input, native }),
  };
}
