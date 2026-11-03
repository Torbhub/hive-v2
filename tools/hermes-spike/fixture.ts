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
  type: string;
  text?: string;
  exit_code?: number;
  tokens?: Record<string, number>;
};

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
    if (this.state === next) return;
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
    if (this.fenced) {
      this.transition('unknown');
      return;
    }
    if (!this.nativeResult || !this.sawEof || this.exitCode === undefined) return;
    if (this.nativeResult.exit_code !== this.exitCode) {
      this.fence();
    } else if (this.exitCode === 0) {
      this.finalText = this.nativeResult.text;
      this.usage = this.nativeResult.tokens;
      this.transition('succeeded');
    } else if (this.exitCode !== 130) {
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
      if (!this.nativeResult && !this.fenced) this.transition('running');
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
    let event: NativeEvent;
    try {
      raw = this.decoder.decode(line);
    } catch {
      this.parserError(atEof ? 'truncated-utf8' : 'invalid-utf8', offset);
      return;
    }
    try {
      event = JSON.parse(raw) as NativeEvent;
    } catch {
      this.parserError(atEof ? 'truncated-json' : 'malformed-json', offset);
      return;
    }
    this.onNative(event, raw);
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
      if (observation.status !== 'interrupted') this.fence();
      else if (this.nativeResult?.exit_code === 130 && this.sawEof && this.exitCode === 130) {
        this.transition('cancelled');
      } else this.transition('cleanup-pending');
    }
    this.trace.push({ kind: observation.type, state: this.state });
  }
}

export function runHermesFixture(observations: FixtureObservation[]): FixtureOutcome {
  return new FixtureRun().run(observations);
}
