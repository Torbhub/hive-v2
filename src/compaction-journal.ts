import { nativeSha } from './native-history.js';
import type { NativeTranscriptItem, NativeTranscriptOps } from './types.js';

function validCompletedResult(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return typeof result.summary === 'string' && result.summary.trim().length > 0 && result.summary.length <= 16_000
    && Number.isSafeInteger(result.compactedCount) && Number(result.compactedCount) >= 0
    && Number.isSafeInteger(result.tokensBefore) && Number(result.tokensBefore) >= 0
    && Number.isSafeInteger(result.tokensAfter) && Number(result.tokensAfter) >= 0;
}

export function scanCompactionLifecycle(page: NativeTranscriptOps, watermark: number, instruction: string): void {
  if (!page.complete || page.agent_id !== 'main' || page.batches.length === 0) throw new Error('daydream compaction journal is incomplete');
  let expectedSeq = watermark + 1;
  const markers: { phase: string; trigger?: string; agentId: string; instruction?: string; result?: unknown }[] = [];
  for (const batch of page.batches) {
    if (batch.seq !== expectedSeq++) throw new Error('daydream compaction journal has a sequence gap');
    for (const op of batch.ops) {
      if (op.op !== 'marker.upsert' || !op.item || typeof op.item !== 'object') continue;
      const item = op.item as Record<string, unknown>;
      if (item.marker !== 'compaction' || !item.payload || typeof item.payload !== 'object') continue;
      const payload = item.payload as Record<string, unknown>;
      markers.push({
        phase: payload.phase as string,
        trigger: payload.trigger as string | undefined,
        agentId: payload.agentId as string,
        instruction: payload.instruction as string | undefined,
        result: payload.result,
      });
    }
  }
  if (page.latest_seq !== page.batches.at(-1)?.seq || markers.length !== 2) throw new Error('daydream compaction requires two official markers');
  const [started, completed] = markers;
  if (started.phase !== 'started' || started.trigger !== 'manual' || started.agentId !== 'main' || started.instruction !== instruction) {
    throw new Error('daydream started marker trigger, agent, nonce, or instruction conflicts');
  }
  if (completed.phase !== 'completed' || completed.agentId !== 'main' || !validCompletedResult(completed.result)) {
    throw new Error('daydream completed marker agent or result conflicts');
  }
}

export type CompactionLifecycleEvidence = 'none' | 'started' | 'pair';

export function scanCompactionLifecycleEvidence(
  page: NativeTranscriptOps,
  watermark: number,
  instruction: string,
): CompactionLifecycleEvidence {
  let expectedSeq = watermark + 1;
  const markers: Record<string, unknown>[] = [];
  for (const batch of page.batches) {
    if (batch.seq !== expectedSeq++) throw new Error('daydream compaction journal has a sequence gap');
    for (const op of batch.ops) {
      if (op.op !== 'marker.upsert' || !op.item || typeof op.item !== 'object') continue;
      const item = op.item as Record<string, unknown>;
      if (item.marker !== 'compaction' || !item.payload || typeof item.payload !== 'object') continue;
      markers.push(item.payload as Record<string, unknown>);
    }
  }
  if (markers.some((marker) => ['cancelled', 'failed', 'error'].includes(String(marker.phase)))) {
    throw new Error('daydream compaction lifecycle was cancelled or failed');
  }
  const started = markers.filter((marker) => marker.phase === 'started');
  if (started.length > 1) throw new Error('daydream compaction has duplicate start markers');
  for (const marker of started) {
    if (marker.trigger !== 'manual' || marker.agentId !== 'main' || marker.instruction !== instruction) {
      throw new Error('daydream started marker trigger, agent, nonce, or instruction conflicts');
    }
  }
  const completed = markers.filter((marker) => marker.phase === 'completed');
  if (completed.length > 1) throw new Error('daydream compaction has conflicting completed markers');
  if (completed.length === 1) {
    if (markers.length !== 2 || markers[0].phase !== 'started' || markers[1].phase !== 'completed'
      || completed[0].agentId !== 'main' || !validCompletedResult(completed[0].result)) {
      throw new Error('daydream completed marker agent or result conflicts');
    }
    return 'pair';
  }
  if (markers.some((marker) => marker.phase !== 'started')) throw new Error('daydream compaction lifecycle phase conflicts');
  return started.length === 1 ? 'started' : 'none';
}

export function countCompactionBackfillSummaries(items: NativeTranscriptItem[], nonce: string): number {
  let summaries = 0;
  for (const item of items) {
    if (item.kind !== 'marker') continue;
    const marker = item as Record<string, unknown>;
    if (marker.marker !== 'compaction' || !marker.payload || typeof marker.payload !== 'object') continue;
    const payload = marker.payload as Record<string, unknown>;
    const origin = payload.origin;
    if (payload.phase !== undefined || !origin || typeof origin !== 'object'
      || (origin as Record<string, unknown>).kind !== 'compaction_summary' || typeof payload.text !== 'string'
      || !payload.text.includes(`nonce=${nonce}`)) continue;
    summaries++;
  }
  return summaries;
}

export function scanCompactionBackfill(items: NativeTranscriptItem[], nonce: string): void {
  if (countCompactionBackfillSummaries(items, nonce) !== 1) {
    throw new Error('daydream compaction backfill summary is missing or ambiguous');
  }
}

export type CompactionProof = { text: string; hash: string };
export type CompactionProofSelection = { proof: CompactionProof | null; summaries: string[] };

export function selectCompactionProof(
  page: NativeTranscriptOps,
  compacting: unknown,
  watermark: number,
  fact: string,
  instruction: string,
): CompactionProofSelection {
  const lifecycle: Record<string, unknown>[] = [];
  const summaries: string[] = [];
  let expectedSeq = watermark + 1;
  for (const batch of page.batches) {
    if (page.complete && batch.seq !== expectedSeq) throw new Error(`compaction-journal-gap:${JSON.stringify({ status: 'gap', count: batch.seq })}`);
    expectedSeq++;
    for (const op of batch.ops) {
      if (op.op !== 'marker.upsert' || !op.item || typeof op.item !== 'object') continue;
      const item = op.item as Record<string, unknown>;
      if (item.marker !== 'compaction' || !item.payload || typeof item.payload !== 'object') continue;
      const payload = item.payload as Record<string, unknown>;
      if (payload.phase !== undefined) lifecycle.push(payload);
      const summaryOrigin = payload.origin;
      if (payload.phase === undefined && summaryOrigin && typeof summaryOrigin === 'object'
        && (summaryOrigin as Record<string, unknown>).kind === 'compaction_summary' && typeof payload.text === 'string') {
        summaries.push(payload.text);
      }
    }
  }
  if ((lifecycle.length > 0 && summaries.length > 0) || lifecycle.length > 2 || summaries.length > 1) {
    throw new Error(`compaction-proof-ambiguous:${JSON.stringify({
      status: 'ambiguous', lifecycleCount: lifecycle.length, summaryCount: summaries.length, summaryHashes: summaries.map(nativeSha),
    })}`);
  }
  if (lifecycle.some((marker) => ['cancelled', 'failed', 'error'].includes(String(marker.phase)))) {
    throw new Error(`compaction-cancelled:${JSON.stringify({ status: 'cancelled', count: lifecycle.length })}`);
  }
  if (lifecycle.filter((marker) => marker.phase === 'started').length > 1) {
    throw new Error(`compaction-duplicate:${JSON.stringify({ status: 'duplicate', count: lifecycle.length })}`);
  }
  let proof: CompactionProof | null = null;
  if (lifecycle.length > 0) {
    const [started, completed] = lifecycle;
    if (started.phase !== 'started' || started.trigger !== 'manual' || started.agentId !== 'main' || started.instruction !== instruction) {
      throw new Error(`compaction-start-conflict:${JSON.stringify({ status: 'start-conflict', count: lifecycle.length })}`);
    }
    if (lifecycle.length === 2) {
      if (completed.phase !== 'completed' || completed.agentId !== 'main') {
        throw new Error(`compaction-completion-conflict:${JSON.stringify({ status: 'completion-conflict', count: lifecycle.length })}`);
      }
      const result = completed.result;
      if (!validCompletedResult(result)) throw new Error(`compaction-result-schema:${JSON.stringify({ status: 'result-schema', count: lifecycle.length })}`);
      const summary = (result as { summary: string }).summary;
      if (!summary.includes(fact)) {
        throw new Error(`daydream-fact-missing:${JSON.stringify({ status: 'fact-missing', summaryHash: nativeSha(summary) })}`);
      }
      proof = { text: summary, hash: nativeSha(summary) };
    }
  }
  if (summaries.length === 1) {
    const text = summaries[0];
    if (!text.trim()) throw new Error(`compaction-summary-empty:${JSON.stringify({ status: 'empty', summaryHash: nativeSha(text) })}`);
    if (!text.includes(fact)) {
      throw new Error(`daydream-fact-missing:${JSON.stringify({ status: 'fact-missing', summaryHash: nativeSha(text) })}`);
    }
    proof = { text, hash: nativeSha(text) };
  }
  return { proof: page.complete && compacting === null ? proof : null, summaries };
}

export function compactionJournalDiagnostics(page: NativeTranscriptOps) {
  const markers: { originKind: string | null; phase: string | null; textHash: string | null }[] = [];
  for (const batch of page.batches) {
    for (const op of batch.ops) {
      if (op.op !== 'marker.upsert' || !op.item || typeof op.item !== 'object') continue;
      const item = op.item as Record<string, unknown>;
      if (item.marker !== 'compaction') continue;
      const payload = item.payload && typeof item.payload === 'object' ? item.payload as Record<string, unknown> : undefined;
      const origin = payload?.origin;
      const originKind = origin && typeof origin === 'object' ? (origin as Record<string, unknown>).kind : undefined;
      markers.push({
        originKind: typeof originKind === 'string' ? originKind : null,
        phase: typeof payload?.phase === 'string' ? payload.phase : null,
        textHash: typeof payload?.text === 'string' ? nativeSha(payload.text) : null,
      });
    }
  }
  return markers;
}
