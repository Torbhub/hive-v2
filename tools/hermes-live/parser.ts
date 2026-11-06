import { createHash } from 'node:crypto';

export type CanonicalState = 'queued' | 'running' | 'cleanup-pending' | 'succeeded' | 'failed' | 'unknown' | 'cancelling' | 'cancelled';
export type ParserErrorKind = 'malformed-json' | 'truncated-json' | 'invalid-utf8' | 'truncated-utf8' | 'invalid-schema' | 'line-too-large' | 'event-limit';
export type LifecycleObservation =
  | { type: 'stdout'; bytes: Uint8Array }
  | { type: 'stderr'; bytes: Uint8Array }
  | { type: 'eof' }
  | { type: 'exit'; code: number; signal?: string }
  | { type: 'deadline' }
  | { type: 'cancel' }
  | { type: 'forced-stop' }
  | { type: 'receipt'; status: 'interrupted' | 'running' | 'missing' | 'conflicting' };

type NativeEvent = {
  type: 'system' | 'text' | 'tool_use' | 'tool_result' | 'result';
  timestamp: number;
  subtype?: string;
  session_id?: string;
  model?: string;
  text?: string;
  name?: string;
  tool_call_id?: string;
  input?: Record<string, unknown>;
  output?: string;
  duration_ms?: number;
  is_error?: boolean;
  exit_code?: number;
  tokens?: Record<string, number>;
  error?: string;
  replay_gap?: boolean;
};

export type SanitizedNativeEvent = {
  type: NativeEvent['type'];
  timestamp: number;
  offset: number;
  length: number;
  sha256: string;
  subtype?: 'init';
  sessionId?: string;
  model?: string;
  textSha256?: string;
  textBytes?: number;
  late?: boolean;
  name?: string;
  toolCallSha256?: string;
  inputSha256?: string;
  outputSha256?: string;
  outputBytes?: number;
  durationMs?: number;
  isError?: boolean;
  errorCategory?: string;
  exitCode?: number;
  tokens?: Record<string, number>;
  replayGap?: boolean;
};

export type TraceEntry = {
  sequence: number;
  kind: string;
  state: CanonicalState;
  evidenceHash?: string;
  offset?: number;
  length?: number;
  signal?: string;
};

type ParsedRecord =
  | { kind: 'event'; event: SanitizedNativeEvent; native: NativeEvent }
  | { kind: 'error'; kindName: ParserErrorKind; offset: number };

const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown) => typeof value === 'string';
const isIdentifier = (value: unknown) => isString(value) && value.length > 0 && value.length <= 256;
const isOptionalIdentifier = (value: unknown) => value === undefined || isIdentifier(value);
const isNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isCount = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const tokenKeys = ['input', 'output', 'total', 'cache_read', 'cache_write'];
const isTokens = (value: unknown) => isRecord(value) && tokenKeys.every((key) => isCount(value[key]));

function isNativeEvent(value: unknown): value is NativeEvent {
  if (!isRecord(value) || !isNumber(value.timestamp)) return false;
  switch (value.type) {
    case 'system': return value.subtype === 'init' && isIdentifier(value.session_id) && isIdentifier(value.model);
    case 'text': return isString(value.text);
    case 'tool_use': return isIdentifier(value.name) && isOptionalIdentifier(value.tool_call_id) && (value.input === undefined || isRecord(value.input));
    case 'tool_result': return isIdentifier(value.name) && isString(value.output) && isOptionalIdentifier(value.tool_call_id) && isNumber(value.duration_ms) && typeof value.is_error === 'boolean';
    case 'result': return isIdentifier(value.session_id) && isCount(value.exit_code) && isString(value.text)
      && isTokens(value.tokens) && isNumber(value.duration_ms)
      && isOptionalIdentifier(value.error) && (value.replay_gap === undefined || typeof value.replay_gap === 'boolean');
    default: return false;
  }
}

function errorCategory(value: string | undefined) {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (normalized.includes('timeout')) return 'timeout';
  if (normalized.includes('interrupt') || normalized.includes('cancel')) return 'cancelled';
  if (normalized.includes('auth') || normalized.includes('credential')) return 'authentication';
  if (normalized.includes('rate') || normalized.includes('quota') || normalized.includes('billing')) return 'provider-limit';
  return 'provider';
}

export class HermesParser {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly maxLineBytes: number;
  private readonly maxEvents: number;
  private readonly digest = createHash('sha256');
  private pending: Uint8Array = new Uint8Array();
  private pendingOffset = 0;
  private offset = 0;
  private events = 0;
  private oversized = false;

  constructor(limits: { maxLineBytes?: number; maxEvents?: number } = {}) {
    this.maxLineBytes = limits.maxLineBytes ?? 64 * 1024;
    this.maxEvents = limits.maxEvents ?? 4096;
  }

  streamEvidence() {
    return { sha256: this.digest.copy().digest('hex'), bytes: this.offset };
  }

  push(bytes: Uint8Array): ParsedRecord[] {
    this.digest.update(bytes);
    this.offset += bytes.length;
    if (this.oversized) {
      const newline = bytes.indexOf(10);
      if (newline === -1) return [];
      this.pendingOffset += newline + 1;
      bytes = bytes.slice(newline + 1);
      this.oversized = false;
    }
    this.pending = this.concat(this.pending, bytes);
    const records: ParsedRecord[] = [];
    let newline = this.pending.indexOf(10);
    while (newline !== -1) {
      if (newline > this.maxLineBytes) {
        records.push(this.error('line-too-large', this.pendingOffset));
      } else {
        records.push(...this.parseLine(this.pending.slice(0, newline), this.pendingOffset, false));
      }
      this.pending = this.pending.slice(newline + 1);
      this.pendingOffset += newline + 1;
      newline = this.pending.indexOf(10);
    }
    if (this.pending.length > this.maxLineBytes) {
      records.push(this.error('line-too-large', this.pendingOffset));
      this.pending = new Uint8Array();
      this.oversized = true;
    }
    return records;
  }

  finish(): ParsedRecord[] {
    if (this.oversized) {
      this.oversized = false;
      return [];
    }
    if (this.pending.length === 0) return [];
    const pending = this.pending;
    const offset = this.pendingOffset;
    this.pending = new Uint8Array();
    return this.parseLine(pending, offset, true);
  }

  private concat(left: Uint8Array, right: Uint8Array) {
    if (left.length === 0) return right.slice();
    if (right.length === 0) return left;
    const joined = new Uint8Array(left.length + right.length);
    joined.set(left);
    joined.set(right, left.length);
    return joined;
  }

  private error(kind: ParserErrorKind, offset: number): ParsedRecord {
    return { kind: 'error', kindName: kind, offset };
  }

  private parseLine(line: Uint8Array, offset: number, atEof: boolean): ParsedRecord[] {
    if (this.events >= this.maxEvents) return [this.error('event-limit', offset)];
    let raw: string;
    let value: unknown;
    try { raw = this.decoder.decode(line); } catch {
      return [this.error(atEof ? 'truncated-utf8' : 'invalid-utf8', offset)];
    }
    try { value = JSON.parse(raw); } catch {
      return [this.error(atEof ? 'truncated-json' : 'malformed-json', offset)];
    }
    if (!isNativeEvent(value)) return [this.error('invalid-schema', offset)];
    this.events += 1;
    const event: SanitizedNativeEvent = {
      type: value.type, timestamp: value.timestamp, offset, length: line.length, sha256: hash(line),
    };
    if (value.session_id !== undefined) event.sessionId = value.session_id;
    if (value.type === 'system') Object.assign(event, { subtype: 'init', model: value.model });
    if (value.text !== undefined) Object.assign(event, { textSha256: hash(value.text), textBytes: new TextEncoder().encode(value.text).length });
    if (value.name !== undefined) event.name = value.name;
    if (value.tool_call_id !== undefined) event.toolCallSha256 = hash(value.tool_call_id);
    if (value.input !== undefined) event.inputSha256 = hash(JSON.stringify(value.input));
    if (value.output !== undefined) Object.assign(event, { outputSha256: hash(value.output), outputBytes: new TextEncoder().encode(value.output).length });
    if (value.duration_ms !== undefined) event.durationMs = value.duration_ms;
    if (value.is_error !== undefined) event.isError = value.is_error;
    if (value.error !== undefined) event.errorCategory = errorCategory(value.error);
    if (value.exit_code !== undefined) event.exitCode = value.exit_code;
    if (value.tokens !== undefined) event.tokens = { ...value.tokens };
    if (value.replay_gap !== undefined) event.replayGap = value.replay_gap;
    return [{ kind: 'event', event, native: value }];
  }
}

export class HermesLifecycle {
  private readonly parser: HermesParser;
  private readonly trace: TraceEntry[] = [];
  private readonly events: SanitizedNativeEvent[] = [];
  private readonly parserErrors: { kind: ParserErrorKind; offset: number }[] = [];
  private readonly stderrDigest = createHash('sha256');
  private state: CanonicalState = 'queued';
  private result?: SanitizedNativeEvent;
  private resultHash?: string;
  private sawEof = false;
  private exitCode?: number;
  private interruptedReceipt = false;
  private fenced = false;
  private terminalTransitions = 0;
  private stderrBytes = 0;

  constructor(parser = new HermesParser()) {
    this.parser = parser;
  }

  observe(observation: LifecycleObservation) {
    switch (observation.type) {
      case 'stdout':
        for (const record of this.parser.push(observation.bytes)) {
          if (record.kind === 'error') this.onParserError(record.kindName, record.offset);
          else this.onNative(record.event);
        }
        break;
      case 'stderr': {
        this.stderrDigest.update(observation.bytes);
        const offset = this.stderrBytes;
        this.stderrBytes += observation.bytes.length;
        this.addTrace('stderr', hash(observation.bytes), offset, observation.bytes.length);
        break;
      }
      case 'eof':
        for (const record of this.parser.finish()) {
          if (record.kind === 'error') this.onParserError(record.kindName, record.offset);
          else this.onNative(record.event);
        }
        this.sawEof = true;
        if (!this.result) this.fence(); else this.complete();
        this.addTrace('eof');
        break;
      case 'exit':
        this.exitCode = observation.code;
        if (!this.result) this.fence(); else this.complete();
        this.addTrace('exit', undefined, undefined, undefined, observation.signal);
        break;
      case 'deadline':
      case 'cancel':
        this.transition('cancelling');
        this.addTrace(observation.type);
        break;
      case 'forced-stop':
        this.fence();
        this.addTrace('forced-stop');
        break;
      case 'receipt':
        this.onReceipt(observation.status);
        this.addTrace('receipt');
        break;
    }
  }

  snapshot() {
    return {
      state: this.state,
      trace: this.trace,
      events: this.events,
      parserErrors: this.parserErrors,
      result: this.fenced ? undefined : this.result,
      usage: this.fenced ? undefined : this.result?.tokens,
      terminalTransitions: this.terminalTransitions,
      fenced: this.fenced,
      stdout: this.parser.streamEvidence(),
      stderr: { sha256: this.stderrDigest.copy().digest('hex'), bytes: this.stderrBytes },
      exitCode: this.exitCode,
      interruptedReceipt: this.interruptedReceipt,
    };
  }

  private transition(next: CanonicalState) {
    if (this.state === next || (this.fenced && next !== 'unknown')) return;
    this.state = next;
    if (['succeeded', 'failed', 'unknown', 'cancelled'].includes(next)) this.terminalTransitions += 1;
  }

  private fence() {
    this.fenced = true;
    this.transition('unknown');
  }

  private complete() {
    if (this.fenced) return;
    if (this.interruptedReceipt && this.result && this.result.exitCode !== 130) {
      this.fence();
      return;
    }
    if (!this.result || !this.sawEof || this.exitCode === undefined) return;
    if (this.result.exitCode !== this.exitCode) this.fence();
    else if (this.exitCode === 130) {
      if (this.interruptedReceipt) this.transition('cancelled');
    } else if (this.exitCode === 0) this.transition('succeeded');
    else this.transition('failed');
  }

  private onNative(event: SanitizedNativeEvent) {
    this.events.push(event);
    if (event.type === 'result') {
      if (this.result) {
        if (this.resultHash !== event.sha256) this.fence();
      } else {
        this.result = event;
        this.resultHash = event.sha256;
        if (!this.fenced) this.transition('cleanup-pending');
        this.complete();
      }
    } else {
      if (this.result && event.type === 'text') event.late = true;
      if (this.state === 'queued') this.transition('running');
    }
    this.addTrace(event.type, event.sha256, event.offset, event.length);
  }

  private onParserError(kind: ParserErrorKind, offset: number) {
    if (this.parserErrors.length < 64) this.parserErrors.push({ kind, offset });
    this.fence();
    this.addTrace('parser-error', undefined, offset);
  }

  private onReceipt(status: 'interrupted' | 'running' | 'missing' | 'conflicting') {
    if (status !== 'interrupted') {
      this.fence();
      return;
    }
    this.interruptedReceipt = true;
    this.complete();
    if (!this.result && !this.fenced) this.transition('cleanup-pending');
  }

  private addTrace(kind: string, evidenceHash?: string, offset?: number, length?: number, signal?: string) {
    if (this.trace.length >= 8192) {
      if (!this.fenced) this.fence();
      return;
    }
    this.trace.push({ sequence: this.trace.length + 1, kind, state: this.state, evidenceHash, offset, length, ...(signal ? { signal } : {}) });
  }
}
