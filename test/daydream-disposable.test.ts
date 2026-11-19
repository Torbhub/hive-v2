import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { selectBtwTurn } from '../src/btw.js';
import { compactionJournalDiagnostics, selectCompactionProof } from '../src/compaction-journal.js';
import { readDaydream } from '../src/daydream.js';
import { createDaydreamAutomationRunner } from '../src/daydream-automation-runner.js';
import {
  getDaydreamAutomationStatus,
  maybeDaydreamAutomation,
  reconcileDaydreamAutomation,
} from '../src/daydream-automation.js';
import { daydreamFactsHash } from '../src/daydream-brief.js';
import { KimiServerClient } from '../src/kimi-server.js';
import {
  nativeHistoryIsPrefix,
  sameNativeForkSnapshot,
  snapshotNativeHistory,
} from '../src/native-history.js';
import { appendTaskEvent, hivePath, hubPath, writeJson } from '../src/state.js';
import type {
  DaydreamBrief,
  NativeMessage,
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
const BINARY = process.env.HIVE_KIMI_SERVER_BIN ?? '/usr/local/bin/kimi-real';
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

type AutomationStateFile = { runs: Record<string, unknown>[] };
async function readAutomationState(home: string): Promise<AutomationStateFile> {
  return JSON.parse(await fs.readFile(hivePath(home, 'daydreams', 'automation', 'state.json'), 'utf8')) as AutomationStateFile;
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
    if (prompts.length <= 1) {
      const prompt = prompts[0] ?? { promptId, status: 'completed', userMessageId, content };
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
      const fact = `fact_${randomUUID()}`;
      let daydreamId = '';
      let promptTurns = 0;
      let childCreations = 0;
      let setupEvidence: NativeMessage | undefined;
      const promptAcks: NativePrompt[] = [];
      const createChild = client.createChild.bind(client);
      const submitPrompt = client.submitPrompt.bind(client);
      client.submitPrompt = async (sessionId, input) => {
        const ack = await submitPrompt(sessionId, input);
        promptTurns++;
        promptAcks.push(ack);
        return ack;
      };
      client.createChild = async (parentId, input) => {
        childCreations++;
        if (childCreations > 1) throw new Error('daydream-unexpected-second-generation');
        const child = await createChild(parentId, input);
        sessionIds.push(child.id);
        daydreamId = String(child.metadata.hive_daydream_id);
        await apiData(server!.origin, server!.token, `/api/v1/sessions/${encodeURIComponent(child.id)}/profile`, {
          method: 'POST', body: JSON.stringify({ agent_config: { model: 'kimi-code/k3.1-pro' } }),
        });
        const setupAck = await client.submitPrompt(child.id, {
          promptId: `daydream-setup-${randomUUID()}`,
          content: [{ type: 'text', text: `Remember this exact fact: ${fact}. ${CONTEXT} Reply with only that fact.` }],
        });
        const setupMessages = await waitForTurn(client, server!.origin, server!.token, child.id, setupAck.user_message_id);
        setupEvidence = setupMessages.find((message) => message.role === 'assistant'
          && message.content.some((part) => part.type === 'text' && String(part.text).includes(fact)));
        if (!setupEvidence) throw new Error('daydream-setup-evidence-missing');
        return child;
      };

      const project = 'daydream-live';
      const taskId = 'daydream-live-task';
      const scope = { root: path.join(home, 'hive-root'), project };
      const handoffPath = hivePath(home, 'handoffs', 'builder.md');
      const handoffContent = '# builder handoff\n\nThe current checkpoint is cp1.\n';
      await fs.mkdir(path.dirname(handoffPath), { recursive: true });
      await fs.writeFile(handoffPath, handoffContent, { mode: 0o600 });
      await writeJson(hubPath(scope.root, 'projects.json'), { projects: [{ name: project, home, repos: [] }] });
      await writeJson(hivePath(home, 'team.json'), {
        agents: [{ name: 'builder', session_id: parent.id, task: taskId, worktree: home, handoff: handoffPath, daydream_automation: true }],
      });
      const automationAt = new Date().toISOString();
      const taskEvents: TaskEvent[] = [
        { id: taskId, project, event: 'asked', at: automationAt, note: 'Investigate the cache boundary.' },
        { id: taskId, project, event: 'plan', at: automationAt, checkpoints: [{ id: 'cp1', desc: 'Preserve the cache fact', etaMin: 5 }] },
        { id: taskId, project, event: 'answered', at: automationAt, note: 'plan approved by owner' },
        { id: taskId, project, event: 'progress', at: automationAt, checkpoint: 'cp1', status: 'started', note: 'Start cp1.' },
      ];
      for (const event of taskEvents) await appendTaskEvent(scope.root, event);

      const parentSnapshot = await snapshotNativeHistory(client, parent.id);
      const question = 'Which approved-plan and current-checkpoint facts must survive compaction? Return only cited facts and unknowns.';
      const briefFor = (phase: 'mine'): DaydreamBrief => ({
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
          citations: [{ kind: 'native', messageId: setupEvidence!.id, contentHash: sha(setupEvidence!.content), quote: fact }],
        }],
        unknowns: [],
      });
      const previousDaydream = process.env.HIVE_DAYDREAM;
      const previousNativeBranches = process.env.HIVE_NATIVE_BRANCHES;
      const previousAutomation = process.env.HIVE_DAYDREAM_AUTOMATION;
      process.env.HIVE_DAYDREAM = '1';
      process.env.HIVE_NATIVE_BRANCHES = '1';
      process.env.HIVE_DAYDREAM_AUTOMATION = '1';
      let compactCalls = 0;
      let automationRuns = 0;
      let automationRun: Awaited<ReturnType<typeof maybeDaydreamAutomation>> = null;
      let sourceSnapshot: Awaited<ReturnType<typeof snapshotNativeHistory>> | undefined;
      let summary: { text: string; hash: string } | undefined;
      let compactingPath = '';
      let instruction = '';
      let watermark = 0;
      try {
        const realRunner = createDaydreamAutomationRunner(client, {
          miningPrompt: () => [{ type: 'text', text: `Return only this exact JSON object with no prose:\n${JSON.stringify(briefFor('mine'))}` }],
        });
        client.compactSession = async (sessionId, input) => {
          compactCalls++;
          if (compactCalls > 1) throw new Error('daydream-unexpected-second-compaction');
          const compactingRecord = await readDaydream(scope, daydreamId);
          if (!compactingRecord.checkpointSessionId) throw new Error('daydream-checkpoint-missing');
          const [source, checkpoint] = await Promise.all([
            snapshotNativeHistory(client, sessionId),
            snapshotNativeHistory(client, compactingRecord.checkpointSessionId),
          ]);
          expect(sameNativeForkSnapshot(source, sessionId, compactingRecord.checkpointSessionId, checkpoint)).toBe(true);
          sourceSnapshot = source;
          watermark = (await client.getTranscriptWatermark(sessionId, { agentId: 'main', pageSize: 1 })).seq;
          compactingPath = `/api/v1/debug/session/${encodeURIComponent(sessionId)}/agent/main/agentFullCompactionService/compacting`;
          expect(await apiData<unknown>(server!.origin, server!.token, compactingPath)).toBeNull();
          instruction = input.instruction;
          const began = await apiData<boolean>(
            server!.origin,
            server!.token,
            `/api/v1/debug/session/${encodeURIComponent(sessionId)}/agent/main/agentFullCompactionService/begin`,
            { method: 'POST', body: JSON.stringify({ source: 'manual', instruction }) },
          );
          if (began !== true) throw new Error('daydream-compaction-begin-refused');
          summary = await waitForDebugCompactionSummary(
            client, server!.origin, server!.token, sessionId, watermark, fact, instruction, compactingPath,
          );
          return {};
        };
        const crashingRunner = {
          run: async (input: Parameters<typeof realRunner.run>[0]) => {
            automationRuns++;
            const result = await realRunner.run(input);
            if (result.status !== 'recovered') throw new Error('daydream-automation-not-recovered');
            throw new Error('daydream-simulated-result-write-crash');
          },
          reconcile: realRunner.reconcile,
        };
        const activityAt = Date.now();
        automationRun = await maybeDaydreamAutomation(scope.root, project, {
          name: 'builder', session_id: parent.id, task: taskId, worktree: home, handoff: handoffPath, daydream_automation: true,
        }, {
          native: client,
          runner: crashingRunner,
          now: activityAt,
          idleMs: 0,
          activityAt,
        });
      } finally {
        if (previousDaydream === undefined) delete process.env.HIVE_DAYDREAM;
        else process.env.HIVE_DAYDREAM = previousDaydream;
        if (previousNativeBranches === undefined) delete process.env.HIVE_NATIVE_BRANCHES;
        else process.env.HIVE_NATIVE_BRANCHES = previousNativeBranches;
        if (previousAutomation === undefined) delete process.env.HIVE_DAYDREAM_AUTOMATION;
        else process.env.HIVE_DAYDREAM_AUTOMATION = previousAutomation;
      }
      const diagnosticRecord = await readDaydream(scope, daydreamId);
      expect(diagnosticRecord.error).toBeUndefined();
      expect(automationRun, `diagnosticRecord.status=${diagnosticRecord.status}`).not.toBeNull();
      expect(sourceSnapshot, `diagnosticRecord.status=${diagnosticRecord.status}`).toBeDefined();
      expect(summary, `diagnosticRecord.status=${diagnosticRecord.status}`).toBeDefined();
      expect(automationRun.status).toBe('unknown');
      expect(automationRun.daydreamId).toBe(daydreamId);
      expect(automationRun.fingerprint).toBeTruthy();
      expect(automationRuns).toBe(1);
      expect(childCreations).toBe(1);
      expect(compactCalls).toBe(1);
      expect(promptTurns).toBe(MAX_PROMPT_TURNS);
      expect((await getDaydreamAutomationStatus(scope.root, project)).daily.project).toMatchObject({
        runs: 1, prompts: 3, compactions: 1,
      });
      const compactedRecord = await readDaydream(scope, daydreamId);
      expect(compactedRecord.status).toBe('recovered');
      expect(compactedRecord.childSessionId).toBeTruthy();
      const compactedSnapshot = await snapshotNativeHistory(client, compactedRecord.childSessionId!);
      expect(compactedSnapshot.historyHash).not.toBe(sourceSnapshot.historyHash);
      const incarnation = await client.getServerMeta();

      await stopProcessGroup(server.child);
      server = undefined;
      server = await launchServer(BINARY, home, env, true);
      client = new KimiServerClient({ origin: server.origin, token: server.token, deadlineMs: 15_000 });
      const restartedIncarnation = await client.getServerMeta();
      expect(restartedIncarnation.server_id).not.toBe(incarnation.server_id);
      await client.listMessages(compactedRecord.childSessionId!, { pageSize: 100 });
      const restartedSummary = await waitForDebugCompactionSummary(
        client, server.origin, server.token, compactedRecord.childSessionId!, 0, fact, instruction, compactingPath,
      );
      expect(restartedSummary.hash).toBe(summary.hash);
      expect(compactCalls).toBe(1);

      client.compactSession = async () => { throw new Error('daydream-unexpected-second-compaction'); };
      const durable = await readAutomationState(home);
      durable.runs[0].ownerPid = 99_999_999;
      await writeJson(hivePath(home, 'daydreams', 'automation', 'state.json'), durable);
      const reconciled = await reconcileDaydreamAutomation(scope.root, project, daydreamId, {
        native: client,
        now: Date.now(),
      });
      expect(reconciled).toMatchObject({
        status: 'recovered', fenced: false, usageRecorded: true, prompts: 3, compactions: 1,
      });
      expect((await getDaydreamAutomationStatus(scope.root, project)).daily.project).toMatchObject({
        runs: 1, prompts: 3, compactions: 1,
      });

      const recovered = await readDaydream(scope, daydreamId);
      expect(recovered.status).toBe('recovered');
      expect(recovered.minedBrief).toEqual(briefFor('mine'));
      expect(nativeHistoryIsPrefix(recovered.childSnapshot!, compactedSnapshot)).toBe(true);
      expect(recovered.compaction).toMatchObject({ status: 'completed', watermark });
      expect(recovered.compaction?.instructionHash).toBe(sha(instruction));
      expect(summary.text).toContain(recovered.compaction?.nonce);
      expect(recovered.recoveredBrief?.facts).toEqual(recovered.minedBrief?.facts);
      expect(recovered.recoveredBrief?.unknowns).toEqual(recovered.minedBrief?.unknowns);
      expect(recovered.factsHash).toBe(daydreamFactsHash(recovered.recoveredBrief!));
      const childId = recovered.childSessionId!;
      const miningAck = promptAcks.find((ack) => ack.prompt_id === `hive-daydream-mine-${daydreamId}`);
      const recoveryAck = promptAcks.find((ack) => ack.prompt_id === `hive-daydream-recover-${daydreamId}`);
      if (!miningAck || !recoveryAck || !recovered.provenance || !recovered.recoveryProvenance) {
        throw new Error('daydream-production-provenance-missing');
      }
      const miningTurn = await waitForBtw(
        client, childId, recovered.provenance.agentId, miningAck.prompt_id, miningAck.user_message_id, miningAck.content,
      );
      const recoveryTurn = await waitForBtw(
        client, childId, recovered.recoveryProvenance.agentId, recoveryAck.prompt_id, recoveryAck.user_message_id, recoveryAck.content,
      );
      expect(JSON.parse(assistantTextFrame(miningTurn).text)).toEqual(recovered.minedBrief);
      expect(JSON.parse(assistantTextFrame(recoveryTurn).text)).toEqual(recovered.recoveredBrief);
      expect(recovered.prompt?.nativeMessageId).toBe(recoveryAck.user_message_id);
      expect(recovered.recoveryProvenance).toMatchObject({
        sessionId: childId,
        promptId: recoveryAck.prompt_id,
        turnId: recoveryTurn.turnId,
        frameHash: sha(assistantTextFrame(recoveryTurn).text),
      });
      expect(recovered.recoveryProvenance.agentId).not.toBe(recovered.provenance.agentId);
      const nativeEvidence = setupEvidence;
      if (!nativeEvidence) throw new Error('daydream-setup-evidence-missing');
      expect(recovered.recoveredBrief!.facts.some((briefFact) => briefFact.citations.some((citation) => citation.kind === 'native'
        && citation.messageId === nativeEvidence.id
        && citation.contentHash === sha(nativeEvidence.content)
        && citation.quote.includes(fact)))).toBe(true);
      expect(await snapshotNativeHistory(client, parent.id)).toEqual(parentSnapshot);

      process.env.HIVE_DAYDREAM = '1';
      process.env.HIVE_NATIVE_BRANCHES = '1';
      process.env.HIVE_DAYDREAM_AUTOMATION = '1';
      try {
        const duplicate = await maybeDaydreamAutomation(scope.root, project, {
          name: 'builder', session_id: parent.id, task: taskId, worktree: home, handoff: handoffPath, daydream_automation: true,
        }, {
          native: client,
          now: Date.parse(automationRun.createdAt),
          idleMs: 0,
          activityAt: automationRun.activityAt,
        });
        expect(duplicate).toBeNull();
      } finally {
        if (previousDaydream === undefined) delete process.env.HIVE_DAYDREAM;
        else process.env.HIVE_DAYDREAM = previousDaydream;
        if (previousNativeBranches === undefined) delete process.env.HIVE_NATIVE_BRANCHES;
        else process.env.HIVE_NATIVE_BRANCHES = previousNativeBranches;
        if (previousAutomation === undefined) delete process.env.HIVE_DAYDREAM_AUTOMATION;
        else process.env.HIVE_DAYDREAM_AUTOMATION = previousAutomation;
      }
      expect(childCreations).toBe(1);
      expect(automationRuns).toBe(1);
      expect(compactCalls).toBe(1);
      expect(promptTurns).toBe(MAX_PROMPT_TURNS);
      expect((await getDaydreamAutomationStatus(scope.root, project)).runs).toHaveLength(1);
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
