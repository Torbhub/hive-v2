import React, { useContext, useEffect, useRef, useState } from 'react';
import { ActionContext } from './action';
import { Button } from './components/ui/button';

const BRIDGE_URL = 'http://127.0.0.1:7685';
const MAX_RECORDING_MS = 60_000;
const MAX_ENCODED_BYTES = 8 * 1024 * 1024;
const MAX_SAMPLES = 60 * 16_000;

type FailureKind = 'permission-denied' | 'unavailable' | 'authentication' | 'failure';
type Phase = 'idle' | 'starting' | 'recording' | 'transcribing' | 'cancelling' | 'success' | 'cancelled' | FailureKind;

export class DictationError extends Error {
  constructor(readonly kind: FailureKind, message: string) {
    super(message);
  }
}

export type DictationRecording = {
  stop: () => Promise<string>;
  cancel: () => Promise<void>;
};

export type DictationEngine = {
  start: (onTimeLimit: () => void, controller?: AbortController) => Promise<DictationRecording>;
};

let pairingToken = '';

function failureKind(error: unknown): FailureKind {
  return error instanceof DictationError ? error.kind : 'failure';
}

export function pcmWav(samples: Float32Array): ArrayBuffer {
  if (samples.length === 0 || samples.length > MAX_SAMPLES) throw new DictationError('failure', 'invalid recording length');
  const output = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(output);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return output;
}

async function recordingWav(chunks: Blob[], mimeType: string): Promise<ArrayBuffer> {
  const context = new AudioContext();
  let decoded: AudioBuffer;
  try {
    const bytes = await new Blob(chunks, { type: mimeType }).arrayBuffer();
    decoded = await context.decodeAudioData(bytes);
  } catch {
    throw new DictationError('failure', 'browser audio decode failed');
  } finally {
    await context.close();
  }
  if (decoded.duration <= 0 || decoded.duration > 60) throw new DictationError('failure', 'recording duration limit');
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16_000), 16_000);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return pcmWav(rendered.getChannelData(0));
}

class BrowserRecording implements DictationRecording {
  private chunks: Blob[] = [];
  private size = 0;
  private cancelled = false;
  private limitError: DictationError | null = null;
  private transcriptionStarted = false;
  private rejectAudio: ((error: Error) => void) | null = null;

  constructor(
    private recorder: MediaRecorder,
    private stream: MediaStream,
    private controller: AbortController,
    onTimeLimit: () => void,
  ) {
    const timer = window.setTimeout(onTimeLimit, MAX_RECORDING_MS);
    this.stopTimer = () => window.clearTimeout(timer);
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0 || this.cancelled) return;
      this.size += event.data.size;
      if (this.size > MAX_ENCODED_BYTES) {
        this.limitError = new DictationError('failure', 'recording size limit');
        onTimeLimit();
        return;
      }
      this.chunks.push(event.data);
    };
    recorder.onerror = () => {
      this.limitError = new DictationError('failure', 'browser recorder failed');
      onTimeLimit();
    };
    recorder.start();
  }

  private stopTimer: () => void;

  private stopTracks(): void {
    this.stopTimer();
    for (const track of this.stream.getTracks()) track.stop();
  }

  private audio(): Promise<Blob[]> {
    this.stopTimer();
    if (this.recorder.state === 'inactive') {
      this.stopTracks();
      return Promise.resolve(this.chunks);
    }
    return new Promise((resolve, reject) => {
      this.rejectAudio = reject;
      this.recorder.onstop = () => {
        this.stopTracks();
        resolve(this.chunks);
      };
      this.recorder.stop();
    });
  }

  async stop(): Promise<string> {
    const chunks = await this.audio();
    if (this.cancelled) throw new DictationError('failure', 'cancelled');
    if (this.limitError) throw this.limitError;
    if (chunks.length === 0) throw new DictationError('failure', 'empty recording');
    const wav = await recordingWav(chunks, this.recorder.mimeType);
    let response: Response;
    this.transcriptionStarted = true;
    try {
      response = await fetch(`${BRIDGE_URL}/transcribe`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${pairingToken}`,
          'content-type': 'audio/wav',
        },
        body: wav,
        signal: this.controller.signal,
      });
    } catch {
      throw new DictationError('unavailable', 'bridge connection failed');
    }
    if (response.status === 401) throw new DictationError('authentication', 'pairing failed');
    if (response.status === 503) throw new DictationError('unavailable', 'engine unavailable');
    if (!response.ok) throw new DictationError('failure', 'transcription request failed');
    const result = await response.json() as { text?: unknown };
    if (typeof result.text !== 'string') throw new DictationError('failure', 'invalid bridge response');
    return result.text;
  }

  async cancel(): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    this.controller.abort();
    this.stopTracks();
    this.rejectAudio?.(new DictationError('failure', 'cancelled'));
    this.recorder.ondataavailable = null;
    this.recorder.onstop = null;
    this.recorder.onerror = null;
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    if (!this.transcriptionStarted) return;
    let response: Response;
    try {
      response = await fetch(`${BRIDGE_URL}/cancel`, {
        method: 'POST',
        headers: { authorization: `Bearer ${pairingToken}` },
        cache: 'no-store',
      });
    } catch {
      throw new DictationError('unavailable', 'cancellation was not confirmed');
    }
    if (!response.ok) throw new DictationError('failure', 'cancellation was not confirmed');
  }
}

export function browserEngine(): DictationEngine {
  return {
    async start(onTimeLimit, suppliedController) {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined'
        || typeof AudioContext === 'undefined' || typeof OfflineAudioContext === 'undefined') {
        throw new DictationError('unavailable', 'browser dictation is unsupported');
      }
      const controller = suppliedController ?? new AbortController();
      let health: Response;
      try {
        health = await fetch(`${BRIDGE_URL}/health`, {
          headers: { authorization: `Bearer ${pairingToken}` },
          signal: controller.signal,
          cache: 'no-store',
        });
      } catch {
        throw new DictationError('unavailable', 'bridge connection failed');
      }
      if (health.status === 401) throw new DictationError('authentication', 'pairing failed');
      if (!health.ok) throw new DictationError('unavailable', 'engine unavailable');
      if (controller.signal.aborted) throw new DictationError('failure', 'cancelled');
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (error) {
        if (error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name)) {
          throw new DictationError('permission-denied', 'microphone permission denied');
        }
        throw new DictationError('unavailable', 'microphone unavailable');
      }
      try {
        return new BrowserRecording(new MediaRecorder(stream), stream, controller, onTimeLimit);
      } catch {
        for (const track of stream.getTracks()) track.stop();
        throw new DictationError('failure', 'recorder startup failed');
      }
    },
  };
}

const STATUS: Record<Exclude<Phase, 'idle'>, string> = {
  starting: 'Requesting microphone permission.',
  recording: 'Recording. Stop when you finish. The limit is 60 seconds.',
  transcribing: 'Transcribing locally with Handy.',
  cancelling: 'Cancelling transcription. Wait before starting again.',
  success: 'Dictation added. Review and edit it before sending.',
  cancelled: 'Dictation cancelled. No text was added.',
  'permission-denied': 'Microphone permission was denied. Allow it in the browser or keep typing.',
  authentication: 'Pairing failed. Enter the token from your Handy bridge.',
  unavailable: 'Handy is unavailable, or no microphone is available. Start the local bridge or keep typing.',
  failure: 'Dictation failed. Check Handy and the pairing token, then try again.',
};

export function DictationControl({
  inputRef, value, onChange, label, dictationEngine,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (next: string) => void;
  label: string;
  dictationEngine?: DictationEngine;
}) {
  const { acting } = useContext(ActionContext);
  const [phase, setPhase] = useState<Phase>('idle');
  const [needsToken, setNeedsToken] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [cancelUnconfirmed, setCancelUnconfirmed] = useState(false);
  const session = useRef<DictationRecording | null>(null);
  const startup = useRef<AbortController | null>(null);
  const operation = useRef(0);
  const starting = useRef(false);
  const finishing = useRef(false);

  useEffect(() => () => {
    operation.current += 1;
    startup.current?.abort();
    void Promise.resolve(session.current?.cancel()).catch(() => {});
  }, []);

  const showError = (error: unknown) => {
    const kind = failureKind(error);
    if (kind === 'authentication') {
      pairingToken = '';
      setTokenDraft('');
      setNeedsToken(true);
    }
    setPhase(kind);
  };

  const finish = async () => {
    const current = session.current;
    if (!current || finishing.current) return;
    const ownOperation = operation.current;
    finishing.current = true;
    setPhase('transcribing');
    try {
      const transcript = (await current.stop()).trim();
      if (!transcript) throw new DictationError('failure', 'empty transcript');
      if (operation.current !== ownOperation) return;
      const field = inputRef.current;
      const draft = field?.value ?? value;
      const start = field?.selectionStart ?? draft.length;
      const end = field?.selectionEnd ?? start;
      const prefix = draft.slice(0, start);
      const suffix = draft.slice(end);
      const before = prefix && !/\s$/.test(prefix) ? ' ' : '';
      const after = suffix && !/^\s/.test(suffix) ? ' ' : '';
      const insertion = `${before}${transcript}${after}`;
      onChange(`${prefix}${insertion}${suffix}`);
      setPhase('success');
      const placeCaret = () => {
        if (!field) return;
        const caret = prefix.length + insertion.length;
        field.focus();
        field.setSelectionRange(caret, caret);
      };
      if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(placeCaret);
      else window.setTimeout(placeCaret, 0);
    } catch (error) {
      if (operation.current === ownOperation) showError(error);
    } finally {
      if (operation.current === ownOperation) {
        session.current = null;
        finishing.current = false;
      }
    }
  };

  const start = async (token?: string) => {
    if (acting || cancelUnconfirmed || starting.current || session.current) return;
    if (!dictationEngine && !(token ?? pairingToken)) {
      setNeedsToken(true);
      setPhase('unavailable');
      return;
    }
    if (token !== undefined) pairingToken = token;
    const ownOperation = ++operation.current;
    const controller = new AbortController();
    startup.current = controller;
    starting.current = true;
    setNeedsToken(false);
    setPhase('starting');
    try {
      const engine = dictationEngine ?? browserEngine();
      const next = await engine.start(() => void finish(), controller);
      if (operation.current !== ownOperation) {
        void Promise.resolve(next.cancel()).catch(() => {});
        return;
      }
      session.current = next;
      setPhase('recording');
    } catch (error) {
      if (operation.current === ownOperation) showError(error);
    } finally {
      if (operation.current === ownOperation) {
        startup.current = null;
        starting.current = false;
      }
    }
  };

  const cancel = async () => {
    if (!['starting', 'recording', 'transcribing'].includes(phase)) return;
    operation.current += 1;
    startup.current?.abort();
    const current = session.current;
    session.current = null;
    starting.current = false;
    finishing.current = false;
    setPhase(phase === 'transcribing' ? 'cancelling' : 'cancelled');
    try {
      await current?.cancel();
      if (phase === 'transcribing') setPhase('cancelled');
    } catch (error) {
      setCancelUnconfirmed(true);
      showError(error);
    }
  };

  const connect = () => {
    const token = tokenDraft.trim();
    if (token.length < 32) {
      setPhase('failure');
      return;
    }
    void start(token);
  };

  return (
    <>
      {['starting', 'recording', 'transcribing', 'cancelling'].includes(phase) ? (
        <>
          {phase === 'recording' && (
            <Button type="button" variant="outline" size="sm" aria-label={`Stop dictation for ${label}`} onClick={() => void finish()}>
              Stop
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" disabled={phase === 'cancelling'} aria-label={`Cancel dictation for ${label}`} onClick={() => void cancel()}>
            Cancel dictation
          </Button>
        </>
      ) : (
        <Button type="button" variant="ghost" size="sm" disabled={acting || cancelUnconfirmed} aria-label={`Start dictation for ${label}`} onClick={() => void start()}>
          Dictate
        </Button>
      )}
      {needsToken && (
        <>
          <input
            type="password"
            value={tokenDraft}
            onChange={(event) => setTokenDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                connect();
              }
            }}
            aria-label={`Handy pairing token for ${label}`}
            autoComplete="off"
            className="h-7 min-w-48 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-100"
          />
          <Button type="button" variant="outline" size="sm" disabled={acting} onClick={connect}>Connect and dictate</Button>
        </>
      )}
      {phase !== 'idle' && (
        <span role="status" aria-live="polite" data-dictation-state={phase} className="basis-full text-xs text-zinc-400">
          {STATUS[phase]}
        </span>
      )}
    </>
  );
}
