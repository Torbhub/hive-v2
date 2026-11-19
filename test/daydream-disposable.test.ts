import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { selectBtwTurn } from '../src/btw.js';
import { compactionJournalDiagnostics, selectCompactionProof } from '../src/compaction-journal.js';
import { recoverDaydream } from '../src/daydream.js';
import { daydreamFactsHash } from '../src/daydream-brief.js';
import { writeRecord } from '../src/daydream-record.js';
import { KimiServerClient } from '../src/kimi-server.js';
import {
  sameNativeForkSnapshot,
  snapshotNativeHistory,
} from '../src/native-history.js';
import { appendTaskEvent, hivePath, hubPath, writeJson } from '../src/state.js';
import type {
  DaydreamBrief,
  DaydreamRecord,
  NativePrompt,
  NativeTranscriptFrame,
  NativeTranscriptTurn,
  TaskEvent,
} from '../src/types.js';
import {
  checkVersion,
  launchServer,
  stopProcessGroup,
} from '../tools/kimi-server-spike/probe.js';
import { disposableProviderBaseUrl } from './kimi-server-native-disposable.test.js';

const execFileAsync = promisify(execFile);
const describeDisposable = process.env.HIVE_DAYDREAM_DISPOSABLE === '1' ? describe : describe.skip;
const BINARY = '/usr/local/bin/kimi-real';
const CONTEXT = 'Cache boundary detail for deterministic compaction. '.repeat(100);
const MAX_PROMPT_TURNS = 3;

type SessionStatus = {
  main_turn_active?: boolean;
  last_turn_reason?: string;
  pending_interaction?: string;
};
type PromptQueue = {
  active: { prompt_id: string; status: string } | null;
  queued: { prompt_id: string; status: string }[];
};

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function routingEnvironment(stdout: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const assign = (key: string, value: unknown) => {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string') env[key] = value;
  };
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const values = parsed.env && typeof parsed.env === 'object' ? parsed.env as Record<string, unknown> : parsed;
    for (const [key, value] of Object.entries(values)) assign(key, value);
    return env;
  } catch {
    for (const line of stdout.split('\n')) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/.exec(line);
      if (!match) continue;
      let value = match[2]!.trim();
      if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1);
      assign(match[1]!, value);
    }
    return env;
  }
}

async function readJson(response: Response, maxBytes = 65_536): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('native-response-too-large');
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes) throw new Error('native-response-too-large');
  return JSON.parse(text);
}

async function apiData<T>(origin: string, token: string, pathname: string, init: RequestInit = {}, maxBytes = 65_536): Promise<T> {
  const response = await fetch(`${origin}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
    },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`native-api-http-${response.status}`);
  const envelope = await readJson(response, maxBytes) as { code?: number; data?: T };
  if (envelope.code !== 0) throw new Error(`native-api-code-${envelope.code}`);
  return envelope.data as T;
}

async function waitForTurn(
  client: KimiServerClient,
  origin: string,
  token: string,
  sessionId: string,
  promptId: string,
) {
  const deadline = Date.now() + 85_000;
  for (;;) {
    const [session, messages] = await Promise.all([
      apiData<SessionStatus>(origin, token, `/api/v1/sessions/${encodeURIComponent(sessionId)}`),
      client.listMessages(sessionId, { pageSize: 100 }),
    ]);
    if (session.pending_interaction && session.pending_interaction !== 'none') {
      throw new Error(`turn-interaction:${JSON.stringify({ status: session.pending_interaction })}`);
    }
    if (session.last_turn_reason === 'failed' || session.last_turn_reason === 'cancelled') {
      throw new Error(`turn-failed:${JSON.stringify({ status: session.last_turn_reason, count: messages.items.length })}`);
    }
    const userPresent = messages.items.some((message) => message.id === promptId || message.role === 'user');
    const assistantPresent = messages.items.some((message) => message.role === 'assistant');
    if (session.last_turn_reason === 'completed' && userPresent && assistantPresent) return messages.items;
    if (Date.now() >= deadline) {
      throw new Error(`turn-timeout:${JSON.stringify({ status: session.last_turn_reason ?? 'unknown', count: messages.items.length })}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function assertBtwReadOnly(turn: NativeTranscriptTurn): void {
  for (const step of turn.steps) {
    for (const frame of step.frames) {
      if (/write|edit|bash|agent|delegat|shell|command/i.test(frame.kind)) {
        throw new Error(`btw-forbidden-frame:${JSON.stringify({ status: 'forbidden-frame', count: step.frames.length })}`);
      }
      if (frame.kind === 'tool.call' && (typeof frame.text !== 'string' || !/Read|Grep|Glob/.test(frame.text))) {
        throw new Error(`btw-forbidden-tool:${JSON.stringify({ status: 'forbidden-tool', count: step.frames.length })}`);
      }
    }
  }
}

function assistantTextFrame(turn: NativeTranscriptTurn): NativeTranscriptFrame & { text: string } {
  const frames = turn.steps.flatMap((step) => step.frames).filter((frame): frame is NativeTranscriptFrame & { text: string } => (
    frame.kind === 'text' && frame.role === 'assistant' && typeof frame.text === 'string'
  ));
  expect(frames.length).toBe(1);
  return frames[0];
}

async function waitForBtw(
  client: KimiServerClient,
  sessionId: string,
  agentId: string,
  promptId: string,
  userMessageId: string,
  content: { type: 'text'; text: string }[],
): Promise<NativeTranscriptTurn> {
  const deadline = Date.now() + 85_000;
  for (;;) {
    const page = await client.getTranscript(sessionId, { agentId, pageSize: 100 });
    if (page.has_more) throw new Error(`btw-transcript-truncated:${JSON.stringify({ status: 'has-more', count: page.items.length })}`);
    const prompts = page.prompts.filter((prompt) => prompt.promptId === promptId);
    if (prompts.length > 1) throw new Error(`btw-prompt-ambiguous:${JSON.stringify({ status: 'ambiguous', count: prompts.length })}`);
    const turns = page.items.filter((item): item is NativeTranscriptTurn & { triggerPromptId: string } => (
      item.kind === 'turn' && item.triggerPromptId === promptId
    ));
    if (new Set(turns.map((turn) => turn.turnId)).size !== turns.length) {
      throw new Error(`btw-turn-id-conflict:${JSON.stringify({ status: 'turn-id-conflict', count: turns.length })}`);
    }
    const roster = page.agents.filter((agent) => agent.agentId === agentId);
    if (prompts.length === 1) {
      const prompt = prompts[0];
      if (prompt.userMessageId !== userMessageId) throw new Error(`btw-user-message-conflict:${JSON.stringify({ status: 'user-message-conflict', count: 1 })}`);
      if (sha(prompt.content) !== sha(content)) throw new Error(`btw-content-conflict:${JSON.stringify({ status: 'content-conflict', contentHash: sha(prompt.content) })}`);
      const selected = selectBtwTurn(prompt, turns, page.agents, agentId);
      if (selected.status === 'ready') {
        expect(selected.turn.turnId).toBeTruthy();
        assertBtwReadOnly(selected.turn);
        return selected.turn;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`btw-turn-timeout:${JSON.stringify({
        status: 'timeout',
        count: prompts.length + turns.length,
        promptStatus: prompts[0]?.status ?? 'missing',
        turns: turns.map((turn) => ({
          state: turn.state,
          wedged: turn.wedged === true,
          stepCount: turn.steps.length,
          frameCount: turn.steps.reduce((count, step) => count + step.frames.length, 0),
        })),
        rosterType: roster.length === 1 ? roster[0].type ?? 'missing' : 'unavailable',
        has_more: page.has_more,
      })}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function waitForDebugCompactionSummary(
  client: KimiServerClient,
  origin: string,
  token: string,
  sessionId: string,
  watermark: number,
  fact: string,
  instruction: string,
  compactingPath: string,
): Promise<{ text: string; hash: string }> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const [page, compacting] = await Promise.all([
      client.listTranscriptOps(sessionId, { agentId: 'main', sinceSeq: watermark }),
      apiData<unknown>(origin, token, compactingPath),
    ]);
    const { proof, summaries } = selectCompactionProof(page, compacting, watermark, fact, instruction);
    if (proof) return proof;
    if (Date.now() >= deadline) {
      const fullJournal = await client.listTranscriptOps(sessionId, { agentId: 'main', sinceSeq: 0 });
      throw new Error(`compaction-summary-timeout:${JSON.stringify({
        status: 'pending',
        count: page.batches.length,
        latest_seq: page.latest_seq,
        complete: page.complete,
        compacting: compacting === null ? 'null' : 'occupied',
        summaryCount: summaries.length,
        summaryHashes: summaries.map(sha),
        fullJournalMarkers: compactionJournalDiagnostics(fullJournal),
      })}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function abortActiveWork(origin: string, token: string, sessionIds: string[]): Promise<void> {
  for (const sessionId of sessionIds) {
    const queue = await apiData<PromptQueue>(origin, token, `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts`);
    for (const prompt of [...(queue.active ? [queue.active] : []), ...queue.queued]) {
      try {
        await apiData(origin, token, `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts/${encodeURIComponent(prompt.prompt_id)}:abort`, {
          method: 'POST', body: '{}',
        });
      } catch (error) {
        if (!(error instanceof Error && error.message.includes('40903'))) throw error;
      }
    }
    const deadline = Date.now() + 5_000;
    for (;;) {
      const [session, current] = await Promise.all([
        apiData<SessionStatus>(origin, token, `/api/v1/sessions/${encodeURIComponent(sessionId)}`),
        apiData<PromptQueue>(origin, token, `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts`),
      ]);
      if (!current.active && current.queued.length === 0 && session.main_turn_active === false) break;
      if (Date.now() >= deadline) throw new Error(`abort-timeout:${JSON.stringify({ status: session.last_turn_reason ?? 'unknown', count: current.queued.length })}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

describeDisposable('daydream native disposable compatibility', () => {
  it('requires fact-preserving compaction and exact recovery with three prompt turns at most', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'kimi-native-disposable-'));
    const sessionIds: string[] = [];
    let server: Awaited<ReturnType<typeof launchServer>> | undefined;
    let cleanupError: unknown;
    try {
      const routing = await execFileAsync('teamkimi', ['env', '--no-mitm'], {
        encoding: 'utf8', timeout: 10_000, maxBuffer: 65_536,
      });
      const env = { ...routingEnvironment(routing.stdout), HOME: home, KIMI_CODE_HOME: home, PATH: process.env.PATH ?? '' };
      if (typeof env.KIMI_BASE_URL !== 'string' || !env.KIMI_BASE_URL) throw new Error('native-routing-unavailable');
      const providerBaseUrl = disposableProviderBaseUrl(env.KIMI_BASE_URL);
      await fs.writeFile(path.join(home, 'config.toml'), `default_model = "kimi-code/k3.1-pro"
default_permission_mode = "auto"
telemetry = false
[providers."managed:kimi-code"]
type = "kimi"
api_key = "disposable-loopback"
base_url = ${JSON.stringify(providerBaseUrl)}
[models."kimi-code/k3.1-pro"]
provider = "managed:kimi-code"
model = "k3.1-pro-highspeed"
max_context_size = 1048576
capabilities = ["thinking", "always_thinking", "image_in", "video_in", "tool_use"]
`, { mode: 0o600 });
      await checkVersion(BINARY, home, env);
      server = await launchServer(BINARY, home, env, true);
      const channels = await apiData<{ name: string }[]>(server.origin, server.token, '/api/v1/debug/channels', {}, 2 * 1024 * 1024);
      const hasFullCompaction = channels.some((channel) => channel.name === 'agentFullCompactionService');
      if (!hasFullCompaction) {
        throw new Error(`debug-channel-missing:${JSON.stringify({ channelCount: channels.length, hasFullCompaction })}`);
      }
      let client = new KimiServerClient({ origin: server.origin, token: server.token, deadlineMs: 15_000 });
      const catalog = await apiData<{ items?: { model?: unknown }[] }>(server.origin, server.token, '/api/v1/models');
      expect(catalog.items?.some((item) => item.model === 'kimi-code/k3.1-pro')).toBe(true);

      const parent = await apiData<{ id: string; workspace_id: string }>(server.origin, server.token, '/api/v1/sessions', {
        method: 'POST',
        body: JSON.stringify({ title: 'Daydream disposable parent', metadata: { cwd: home } }),
      });
      sessionIds.push(parent.id);
      const daydreamId = randomUUID();
      const child = await client.createChild(parent.id, {
        title: 'Daydream disposable child', metadata: { hive_daydream_id: daydreamId },
      });
      sessionIds.push(child.id);
      expect(child.metadata.parent_session_id).toBe(parent.id);
      expect(child.metadata.child_session_kind).toBe('child');
      expect(child.metadata.hive_daydream_id).toBe(daydreamId);
      expect(child.workspace_id).toBe(parent.workspace_id);
      expect(sha(child.metadata.cwd)).toBe(sha(home));
      await apiData(server.origin, server.token, `/api/v1/sessions/${encodeURIComponent(child.id)}/profile`, {
        method: 'POST', body: JSON.stringify({ agent_config: { model: 'kimi-code/k3.1-pro' } }),
      });

      const fact = `fact_${randomUUID()}`;
      let promptTurns = 0;
      const setupPromptId = `daydream-setup-${randomUUID()}`;
      promptTurns++;
      const setupAck = await client.submitPrompt(child.id, {
        promptId: setupPromptId,
        content: [{ type: 'text', text: `Remember this exact fact: ${fact}. ${CONTEXT} Reply with only that fact.` }],
      });
      expect(setupAck.prompt_id).toBe(setupPromptId);
      const setupMessages = await waitForTurn(client, server.origin, server.token, child.id, setupAck.user_message_id);
      expect(setupMessages.some((message) => message.id === setupAck.user_message_id)).toBe(true);
      const setupEvidence = setupMessages.find((message) => message.role === 'assistant'
        && message.content.some((part) => part.type === 'text' && String(part.text).includes(fact)));
      if (!setupEvidence) throw new Error('daydream-setup-evidence-missing');

      const miningAgentId = (await client.createBtw(child.id)).agent_id;
      const miningPromptId = `hive-daydream-mine-${daydreamId}`;
      promptTurns++;
      const miningAck = await client.submitPrompt(child.id, {
        promptId: miningPromptId,
        content: [{ type: 'text', text: `Remember this exact fact: ${fact}. Reply with only that fact.` }],
        agentId: miningAgentId,
        permissionMode: 'manual',
      });
      expect(miningAck.prompt_id).toBe(miningPromptId);
      const miningTurn = await waitForBtw(client, child.id, miningAgentId, miningAck.prompt_id, miningAck.user_message_id, miningAck.content);
      expect(sha(assistantTextFrame(miningTurn).text)).toBe(sha(fact));

      const forkIntentAt = new Date().toISOString();
      const checkpoint = await client.forkSession(child.id, {
        title: 'Daydream disposable checkpoint', metadata: { hive_daydream_id: daydreamId },
      });
      const [parentSnapshot, sourceSnapshot, checkpointSnapshot] = await Promise.all([
        snapshotNativeHistory(client, parent.id),
        snapshotNativeHistory(client, child.id),
        snapshotNativeHistory(client, checkpoint.id),
      ]);
      expect(sameNativeForkSnapshot(sourceSnapshot, child.id, checkpoint.id, checkpointSnapshot)).toBe(true);

      const [incarnation, watermark] = await Promise.all([
        client.getServerMeta(),
        client.getTranscriptWatermark(child.id, { agentId: 'main', pageSize: 1 }),
      ]);
      const compactingPath = `/api/v1/debug/session/${encodeURIComponent(child.id)}/agent/main/agentFullCompactionService/compacting`;
      expect(await apiData<unknown>(server.origin, server.token, compactingPath)).toBeNull();
      const nonce = randomUUID();
      const compactionIntentAt = new Date().toISOString();
      const instruction = `Preserve the active mining question and verified fact structure. Do not answer owner questions or rejoin the parent. Include the nonce verbatim in the compaction summary. nonce=${nonce}`;
      let compactCalls = 0;
      compactCalls++;
      const began = await apiData<boolean>(
        server.origin,
        server.token,
        `/api/v1/debug/session/${encodeURIComponent(child.id)}/agent/main/agentFullCompactionService/begin`,
        { method: 'POST', body: JSON.stringify({ source: 'manual', instruction }) },
      );
      if (began !== true) throw new Error('daydream-compaction-begin-refused:{"status":"occupied-no-op"}');
      const summary = await waitForDebugCompactionSummary(
        client, server.origin, server.token, child.id, watermark.seq, fact, instruction, compactingPath,
      );
      const compactedSnapshot = await snapshotNativeHistory(client, child.id);
      expect(compactedSnapshot.count).toBeGreaterThan(0);
      expect(compactedSnapshot.historyHash).not.toBe(sourceSnapshot.historyHash);

      const project = 'daydream-live';
      const taskId = 'daydream-live-task';
      const scope = { root: path.join(home, 'hive-root'), project };
      const handoffPath = hivePath(home, 'handoffs', 'builder.md');
      const handoffContent = '# builder handoff\n\nThe current checkpoint is cp1.\n';
      await fs.mkdir(path.dirname(handoffPath), { recursive: true });
      await fs.writeFile(handoffPath, handoffContent, { mode: 0o600 });
      await writeJson(hubPath(scope.root, 'projects.json'), { projects: [{ name: project, home, repos: [] }] });
      await writeJson(hivePath(home, 'team.json'), {
        agents: [{ name: 'builder', session_id: parent.id, task: taskId, worktree: home, handoff: handoffPath }],
      });
      const taskEvents: TaskEvent[] = [
        { id: taskId, project, event: 'asked', at: compactionIntentAt, note: 'Investigate the cache boundary.' },
        { id: taskId, project, event: 'plan', at: compactionIntentAt, checkpoints: [{ id: 'cp1', desc: 'Preserve the cache fact', etaMin: 5 }] },
        { id: taskId, project, event: 'answered', at: compactionIntentAt, note: 'plan approved by owner' },
        { id: taskId, project, event: 'progress', at: compactionIntentAt, checkpoint: 'cp1', status: 'started', note: 'Start cp1.' },
      ];
      for (const event of taskEvents) await appendTaskEvent(scope.root, event);
      const question = 'Which exact cache fact survives compaction?';
      const briefFor = (phase: 'mine' | 'recover'): DaydreamBrief => ({
        schemaVersion: 1,
        daydreamId,
        phase,
        checkpointId: 'cp1',
        questionHash: sha(question),
        sourceHistoryHash: parentSnapshot.historyHash,
        facts: [{
          id: 'f1',
          answer: fact,
          whyNow: 'Recovery must preserve the cache invariant.',
          uncertainty: 'Eviction ordering remains unverified.',
          citations: [{ kind: 'native', messageId: setupEvidence.id, contentHash: sha(setupEvidence.content), quote: fact }],
        }],
        unknowns: [],
      });
      const minedBrief = briefFor('mine');
      const recoveredBrief = briefFor('recover');
      const miningFrame = assistantTextFrame(miningTurn);
      const miningStep = miningTurn.steps.find((step) => step.frames.some((frame) => frame.frameId === miningFrame.frameId));
      if (!miningStep) throw new Error('daydream-mining-provenance-step-missing');
      const record: DaydreamRecord = {
        schemaVersion: 1,
        id: daydreamId,
        status: 'compacting',
        parentSessionId: parent.id,
        childSessionId: child.id,
        checkpointSessionId: checkpoint.id,
        workspaceId: child.workspace_id,
        cwd: home,
        scope: { project, agent: 'builder', task: taskId },
        checkpointId: 'cp1',
        questionHash: sha(question),
        sourceTaskHash: sha(taskEvents),
        handoffPathHash: sha(handoffPath),
        handoffContentHash: sha(handoffContent),
        parentSnapshot,
        childSnapshot: sourceSnapshot,
        prompt: {
          phase: 'mine',
          status: 'accepted',
          agentId: miningAgentId,
          promptId: miningAck.prompt_id,
          promptHash: sha(miningAck.content),
          intentAt: miningAck.created_at,
          nativeMessageId: miningAck.user_message_id,
        },
        fork: { status: 'completed', intentAt: forkIntentAt },
        compaction: {
          status: 'submitting',
          instructionHash: sha(instruction),
          nonce,
          intentAt: compactionIntentAt,
          watermark: watermark.seq,
          serverId: incarnation.server_id,
          serverStartedAt: incarnation.started_at,
        },
        provenance: {
          sessionId: child.id,
          agentId: miningAgentId,
          promptId: miningAck.prompt_id,
          turnId: miningTurn.turnId,
          stepId: miningStep.stepId,
          frameId: miningFrame.frameId,
          frameHash: sha(miningFrame.text),
        },
        minedBrief,
        factsHash: daydreamFactsHash(minedBrief),
        createdAt: compactionIntentAt,
        updatedAt: compactionIntentAt,
      };
      await writeRecord(home, record);

      await stopProcessGroup(server.child);
      server = undefined;
      server = await launchServer(BINARY, home, env, true);
      client = new KimiServerClient({ origin: server.origin, token: server.token, deadlineMs: 15_000 });
      const restartedIncarnation = await client.getServerMeta();
      expect(restartedIncarnation.server_id).not.toBe(incarnation.server_id);
      await client.listMessages(child.id, { pageSize: 100 });
      const restartedSummary = await waitForDebugCompactionSummary(
        client, server.origin, server.token, child.id, 0, fact, instruction, compactingPath,
      );
      expect(restartedSummary.hash).toBe(summary.hash);
      expect(compactCalls).toBe(1);

      client.compactSession = async () => { throw new Error('daydream-unexpected-second-compaction'); };
      const recoveryAcks: NativePrompt[] = [];
      const submitPrompt = client.submitPrompt.bind(client);
      client.submitPrompt = async (sessionId, input) => {
        const ack = await submitPrompt(sessionId, input);
        if (input.promptId === `hive-daydream-recover-${daydreamId}`) recoveryAcks.push(ack);
        return ack;
      };
      const previousDaydream = process.env.HIVE_DAYDREAM;
      const previousNativeBranches = process.env.HIVE_NATIVE_BRANCHES;
      process.env.HIVE_DAYDREAM = '1';
      process.env.HIVE_NATIVE_BRANCHES = '1';
      try {
        promptTurns++;
        const recovering = await recoverDaydream(scope, daydreamId, undefined, client);
        expect(recovering.error).toBeUndefined();
        expect(recovering.status).toBe('recovering');
        expect(recovering.childSnapshot?.historyHash).toBe(compactedSnapshot.historyHash);
        const recoveryAck = recoveryAcks[0];
        if (!recoveryAck || !recovering.prompt?.agentId) throw new Error('daydream-production-recovery-prompt-missing');
        expect(recovering.prompt.promptHash).toBe(sha(recoveryAck.content));
        expect(recovering.prompt.nativeMessageId).toBe(recoveryAck.user_message_id);
        const recoveryTurn = await waitForBtw(
          client, child.id, recovering.prompt.agentId, recoveryAck.prompt_id, recoveryAck.user_message_id, recoveryAck.content,
        );
        const recoveryFrame = assistantTextFrame(recoveryTurn);
        let recoveryDiagnostic: Record<string, unknown>;
        try {
          const parsed = JSON.parse(recoveryFrame.text) as Record<string, unknown> | null;
          const facts = parsed && Array.isArray(parsed.facts) ? parsed.facts : undefined;
          const unknowns = parsed && Array.isArray(parsed.unknowns) ? parsed.unknowns : undefined;
          recoveryDiagnostic = {
            parseSuccess: true,
            phase: typeof parsed?.phase === 'string' ? parsed.phase : 'missing',
            factCount: facts?.length ?? null,
            unknownCount: unknowns?.length ?? null,
            citationCount: facts?.reduce((count, fact) => {
              const citations = fact && typeof fact === 'object' ? (fact as Record<string, unknown>).citations : undefined;
              return count + (Array.isArray(citations) ? citations.length : 0);
            }, 0) ?? null,
            textHash: sha(recoveryFrame.text),
          };
        } catch {
          throw new Error(`daydream-recovery-frame-mismatch:${JSON.stringify({ parseSuccess: false, textHash: sha(recoveryFrame.text) })}`);
        }
        const expectedCitationCount = recoveredBrief.facts.reduce((count, fact) => count + fact.citations.length, 0);
        if (recoveryDiagnostic.phase !== recoveredBrief.phase
          || recoveryDiagnostic.factCount !== recoveredBrief.facts.length
          || recoveryDiagnostic.unknownCount !== recoveredBrief.unknowns.length
          || recoveryDiagnostic.citationCount !== expectedCitationCount) {
          throw new Error(`daydream-recovery-frame-mismatch:${JSON.stringify(recoveryDiagnostic)}`);
        }
        const recovered = await recoverDaydream(scope, daydreamId, recoveredBrief, client);
        expect(recovered.status, JSON.stringify(recoveryDiagnostic)).toBe('recovered');
        expect(recovered.recoveredBrief).toEqual(recoveredBrief);
        expect(recovered.factsHash).toBe(daydreamFactsHash(recoveredBrief));
        expect(recovered.prompt?.nativeMessageId).toBe(recoveryAck.user_message_id);
        expect(recovered.recoveryProvenance).toMatchObject({
          sessionId: child.id,
          agentId: recovering.prompt.agentId,
          promptId: recoveryAck.prompt_id,
          turnId: recoveryTurn.turnId,
          frameId: recoveryFrame.frameId,
          frameHash: sha(recoveryFrame.text),
        });
        expect(recovered.recoveryProvenance?.agentId).not.toBe(miningAgentId);
      } finally {
        if (previousDaydream === undefined) delete process.env.HIVE_DAYDREAM;
        else process.env.HIVE_DAYDREAM = previousDaydream;
        if (previousNativeBranches === undefined) delete process.env.HIVE_NATIVE_BRANCHES;
        else process.env.HIVE_NATIVE_BRANCHES = previousNativeBranches;
      }
      expect(compactCalls).toBe(1);
      expect(promptTurns).toBe(MAX_PROMPT_TURNS);
    } finally {
      if (server) {
        try {
          await abortActiveWork(server.origin, server.token, sessionIds);
        } catch (error) {
          cleanupError = error;
        }
      }
      if (server) {
        try {
          await stopProcessGroup(server.child);
        } catch (error) {
          cleanupError ??= error;
        }
      }
      if (!cleanupError) await fs.rm(home, { recursive: true, force: true });
      if (cleanupError) throw cleanupError;
    }
  }, 480_000);
});
