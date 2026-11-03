export type FixtureObservation =
  | { type: 'stdout'; bytes: Uint8Array }
  | { type: 'eof' }
  | { type: 'exit'; code: number }
  | { type: 'cancel' }
  | { type: 'receipt'; status: 'interrupted' | 'running' | 'missing' | 'conflicting' }
  | { type: 'deadline' }
  | { type: 'forced-stop' };

export type CanonicalState =
  | 'queued'
  | 'running'
  | 'cleanup-pending'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'cancelling'
  | 'cancelled';

type NativeEvent = {
  type: 'system' | 'text' | 'tool_use' | 'tool_result' | 'result';
  text?: string;
  exit_code?: number;
  tokens?: Record<string, number>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;
const isOptionalString = (value: unknown): boolean => value === undefined || typeof value === 'string';
const isOptionalBoolean = (value: unknown): boolean => value === undefined || typeof value === 'boolean';
const isNonNegativeNumber = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isTokenCount = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

function isTokens(value: unknown): boolean {
  return isRecord(value) && ['input', 'output', 'total', 'cache_read', 'cache_write']
    .every((key) => isTokenCount(value[key]));
}

function isNativeEvent(value: unknown): value is NativeEvent {
  if (!isRecord(value) || !isNonNegativeNumber(value.timestamp)) return false;
  switch (value.type) {
    case 'system':
      return value.subtype === 'init' && isNonEmptyString(value.session_id) && isNonEmptyString(value.model);
    case 'text':
      return typeof value.text === 'string';
    case 'tool_use':
      return isNonEmptyString(value.name) && isOptionalString(value.tool_call_id)
        && (value.input === undefined || isRecord(value.input));
    case 'tool_result':
      return isNonEmptyString(value.name) && typeof value.output === 'string'
        && isOptionalString(value.tool_call_id) && isNonNegativeNumber(value.duration_ms)
        && typeof value.is_error === 'boolean';
    case 'result':
      return isNonEmptyString(value.session_id) && isTokenCount(value.exit_code)
        && typeof value.text === 'string' && isTokens(value.tokens)
        && isNonNegativeNumber(value.duration_ms) && isOptionalString(value.error)
        && isOptionalBoolean(value.replay_gap);
    default:
      return false;
  }
}

export type FixtureOutcome = {
  state: CanonicalState;
  trace: { kind: string; state: CanonicalState }[];
  partialText: string;
  lateText: string[];
  rawStdout: Uint8Array;
  parserErrors: { kind: string; offset: number }[];
  finalText?: string;
  usage?: Record<string, number>;
  terminalTransitions: number;
  fenced: boolean;
};

class FixtureRun {
  private readonly trace: FixtureOutcome['trace'] = [];
  private readonly lateText: string[] = [];
  private readonly parserErrors: FixtureOutcome['parserErrors'] = [];
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private state: CanonicalState = 'queued';
  private pending = new Uint8Array();
  private pendingOffset = 0;
  private rawStdout = new Uint8Array();
  private nativeResult?: NativeEvent;
  private rawResult?: string;
  private sawEof = false;
  private exitCode?: number;
  private partialText = '';
  private finalText?: string;
  private usage?: Record<string, number>;
  private terminalTransitions = 0;
  private fenced = false;
  private interruptedReceipt = false;

  run(observations: FixtureObservation[]): FixtureOutcome {
    for (const observation of observations) this.onObservation(observation);
    return {
      state: this.state,
      trace: this.trace,
      partialText: this.partialText,
      lateText: this.lateText,
      rawStdout: this.rawStdout,
      parserErrors: this.parserErrors,
      finalText: this.finalText,
      usage: this.usage,
      terminalTransitions: this.terminalTransitions,
      fenced: this.fenced,
    };
  }

  private transition(next: CanonicalState) {
    if (this.state === next || (this.fenced && next !== 'unknown')) return;
    this.state = next;
    if (['succeeded', 'failed', 'unknown', 'cancelled'].includes(next)) this.terminalTransitions += 1;
  }

  private fence() {
    this.fenced = true;
    this.finalText = undefined;
    this.usage = undefined;
    this.transition('unknown');
  }

  private complete() {
    if (this.fenced) return;
    if (this.interruptedReceipt && this.nativeResult && this.nativeResult.exit_code !== 130) {
      this.fence();
      return;
    }
    if (!this.nativeResult || !this.sawEof || this.exitCode === undefined) return;
    if (this.nativeResult.exit_code !== this.exitCode) {
      this.fence();
    } else if (this.exitCode === 130) {
      if (this.interruptedReceipt) this.transition('cancelled');
    } else if (this.exitCode === 0) {
      this.finalText = this.nativeResult.text;
      this.usage = this.nativeResult.tokens;
      this.transition('succeeded');
    } else {
      this.transition('failed');
    }
  }

  private onNative(event: NativeEvent, raw: string) {
    if (event.type === 'result') {
      this.onResult(event, raw);
    } else {
      if (event.type === 'text' && event.text) {
        if (this.nativeResult) this.lateText.push(event.text);
        else this.partialText += event.text;
      }
      if (this.state === 'queued') this.transition('running');
    }
    this.trace.push({ kind: event.type, state: this.state });
  }

  private onResult(event: NativeEvent, raw: string) {
    if (this.nativeResult) {
      if (raw !== this.rawResult) this.fence();
      return;
    }
    this.nativeResult = event;
    this.rawResult = raw;
    if (!this.fenced) this.transition('cleanup-pending');
    this.complete();
  }

  private parserError(kind: string, offset: number) {
    this.parserErrors.push({ kind, offset });
    this.fence();
    this.trace.push({ kind: 'parser-error', state: this.state });
  }

  private parseLine(line: Uint8Array, offset: number, atEof: boolean) {
    let raw: string;
    let value: unknown;
    try {
      raw = this.decoder.decode(line);
    } catch {
      this.parserError(atEof ? 'truncated-utf8' : 'invalid-utf8', offset);
      return;
    }
    try {
      value = JSON.parse(raw);
    } catch {
      this.parserError(atEof ? 'truncated-json' : 'malformed-json', offset);
      return;
    }
    if (!isNativeEvent(value)) {
      this.parserError('invalid-schema', offset);
      return;
    }
    this.onNative(value, raw);
  }

  private onBytes(bytes: Uint8Array) {
    this.rawStdout = new Uint8Array([...this.rawStdout, ...bytes]);
    this.pending = new Uint8Array([...this.pending, ...bytes]);
    let newline = this.pending.indexOf(10);
    while (newline !== -1) {
      const line = this.pending.slice(0, newline);
      this.parseLine(line, this.pendingOffset, false);
      this.pending = this.pending.slice(newline + 1);
      this.pendingOffset += newline + 1;
      newline = this.pending.indexOf(10);
    }
  }

  private onReceipt(status: 'interrupted' | 'running' | 'missing' | 'conflicting') {
    if (status !== 'interrupted') {
      this.fence();
      return;
    }
    this.interruptedReceipt = true;
    this.complete();
    if (!this.nativeResult && !this.fenced) this.transition('cleanup-pending');
  }

  private onObservation(observation: FixtureObservation) {
    if (observation.type === 'stdout') {
      this.onBytes(observation.bytes);
      return;
    }
    if (observation.type === 'eof') {
      if (this.pending.length > 0) this.parseLine(this.pending, this.pendingOffset, true);
      this.pending = new Uint8Array();
      this.sawEof = true;
      if (!this.nativeResult) this.fence();
      else this.complete();
    } else if (observation.type === 'exit') {
      this.exitCode = observation.code;
      if (!this.nativeResult) this.fence();
      else this.complete();
    } else if (observation.type === 'cancel' || observation.type === 'deadline') {
      this.transition('cancelling');
    } else if (observation.type === 'forced-stop') {
      this.fence();
    } else if (observation.type === 'receipt') {
      this.onReceipt(observation.status);
    }
    this.trace.push({ kind: observation.type, state: this.state });
  }
}

export function runHermesFixture(observations: FixtureObservation[]): FixtureOutcome {
  return new FixtureRun().run(observations);
}
