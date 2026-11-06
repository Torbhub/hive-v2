// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionContext } from '../web/action';
import { browserEngine } from '../web/dictation';
import { NewTaskRow } from '../web/rows';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

class FakeTrack {
  stopped = false;
  stop = vi.fn(() => { this.stopped = true; });
}

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  state: RecordingState = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onstop: (() => void) | null = null;
  start = vi.fn(() => { this.state = 'recording'; });
  stop = vi.fn(() => {
    this.data(32);
    this.state = 'inactive';
    this.onstop?.();
  });

  constructor() {
    FakeRecorder.instances.push(this);
  }

  data(size: number): void {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(size)]) });
  }
}

class FakeAudioContext {
  static decodeError = false;
  decodeAudioData = vi.fn(async () => {
    if (FakeAudioContext.decodeError) throw new Error('decode failed');
    return { duration: 1 };
  });
  close = vi.fn(async () => {});
}

class FakeOfflineAudioContext {
  destination = {};
  createBufferSource() {
    return { buffer: null, connect: vi.fn(), start: vi.fn() };
  }
  async startRendering() {
    return { getChannelData: () => new Float32Array(16_000) };
  }
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let mounted: boolean;
let track: FakeTrack;
let getUserMedia: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext);
  FakeRecorder.instances = [];
  FakeAudioContext.decodeError = false;
  track = new FakeTrack();
  getUserMedia = vi.fn(async () => ({ getTracks: () => [track] }));
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
  fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/health')) return new Response('{}', { status: 200 });
    if (url.endsWith('/cancel')) return new Response('{}', { status: 200 });
    return new Response(JSON.stringify({ text: 'fake browser transcript' }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(Blob.prototype, 'arrayBuffer', {
    configurable: true,
    value: async () => new ArrayBuffer(0),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mounted = true;
});

afterEach(() => {
  if (mounted) act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function render(acting = false): void {
  act(() => root.render(
    <ActionContext.Provider value={{ acting, pressed: null }}>
      <NewTaskRow project="demo" busy={null} onStartTask={vi.fn()} dictationEngine={browserEngine()} />
    </ActionContext.Provider>,
  ));
}

function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((item) => item.textContent === text);
  if (!found) throw new Error(`No button named ${text}`);
  return found as HTMLButtonElement;
}

function status(): string {
  return container.querySelector('[data-dictation-state]')?.getAttribute('data-dictation-state') ?? '';
}

async function start(): Promise<void> {
  await act(async () => button('Dictate').click());
  expect(status()).toBe('recording');
}

describe('MediaRecorder adapter', () => {
  it('stops tracks after getUserMedia, stop, decode, and fake HTTP transcription', async () => {
    const session = await browserEngine().start(vi.fn());
    expect(await session.stop()).toBe('fake browser transcript');
    expect(track.stopped).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/transcribe'))).toBe(true);
  });

  it('cancel during recording stops tracks immediately without a transcription request', async () => {
    render();
    await start();
    await act(async () => button('Cancel dictation').click());
    expect(status()).toBe('cancelled');
    expect(track.stopped).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/transcribe'))).toBe(false);
  });

  it('unmount during recording stops tracks immediately', async () => {
    render();
    await start();
    act(() => root.unmount());
    mounted = false;
    expect(track.stopped).toBe(true);
  });

  it('cancel during startup aborts health before microphone access', async () => {
    fetchMock.mockImplementation((_input: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    render();
    await act(async () => button('Dictate').click());
    expect(status()).toBe('starting');
    await act(async () => button('Cancel dictation').click());
    expect(status()).toBe('cancelled');
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('double-clicking start creates only one health request and recording', async () => {
    let health: ((response: Response) => void) | undefined;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { health = resolve; }));
    render();
    await act(async () => {
      button('Dictate').click();
      button('Dictate').click();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => health!(new Response('{}', { status: 200 })));
    expect(status()).toBe('recording');
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('invokes the time-limit callback and stops tracks on cancel', async () => {
    vi.useFakeTimers();
    const limited = vi.fn();
    const session = await browserEngine().start(limited);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(limited).toHaveBeenCalledTimes(1);
    await session.cancel();
    expect(track.stopped).toBe(true);
  });

  it('fails the size path without fetching transcription and stops tracks', async () => {
    const limited = vi.fn();
    const session = await browserEngine().start(limited);
    FakeRecorder.instances[0].data(8 * 1024 * 1024 + 1);
    expect(limited).toHaveBeenCalled();
    await expect(session.stop()).rejects.toThrow('recording size limit');
    expect(track.stopped).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/transcribe'))).toBe(false);
  });

  it('fails the recorder error path and stops tracks', async () => {
    const limited = vi.fn();
    const session = await browserEngine().start(limited);
    FakeRecorder.instances[0].onerror?.(new Event('error'));
    expect(limited).toHaveBeenCalled();
    await expect(session.stop()).rejects.toThrow('browser recorder failed');
    expect(track.stopped).toBe(true);
  });

  it('fails decode without fetching transcription and stops tracks', async () => {
    FakeAudioContext.decodeError = true;
    render();
    await start();
    await act(async () => button('Stop').click());
    expect(status()).toBe('failure');
    expect(track.stopped).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/transcribe'))).toBe(false);
  });

  it('shows unavailable on fetch failure and stops tracks without inserting', async () => {
    fetchMock.mockImplementation((input: unknown) => {
      if (String(input).endsWith('/health')) return Promise.resolve(new Response('{}', { status: 200 }));
      return Promise.reject(new Error('offline'));
    });
    render();
    await start();
    await act(async () => button('Stop').click());
    expect(status()).toBe('unavailable');
    expect(track.stopped).toBe(true);
    expect(container.querySelector('input')!.value).toBe('');
  });
});

describe('dictation recovery and Hub action interaction', () => {
  it('restores an editable token prompt on 401 and accepts a corrected token', async () => {
    let healthy = false;
    fetchMock.mockImplementation((input: unknown) => {
      if (String(input).endsWith('/health')) {
        return Promise.resolve(new Response('{}', { status: healthy ? 200 : 401 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ text: 'corrected' }), { status: 200 }));
    });
    render();
    await act(async () => button('Dictate').click());
    expect(status()).toBe('authentication');
    const token = container.querySelector('input[type="password"]') as HTMLInputElement;
    expect(token).not.toBeNull();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    healthy = true;
    await act(async () => {
      setter.call(token, 'corrected-token-with-more-than-32-characters');
      token.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Connect and dictate').click());
    expect(status()).toBe('recording');
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  it('keeps Stop and Cancel available and stops tracks when Hub acting becomes true', async () => {
    render(false);
    await start();
    render(true);
    expect(button('Stop').disabled).toBe(false);
    expect(button('Cancel dictation').disabled).toBe(false);
    await act(async () => button('Cancel dictation').click());
    expect(track.stopped).toBe(true);
    expect(status()).toBe('cancelled');
  });

  it('waits for server cancellation before offering another start', async () => {
    let cancelResponse: ((response: Response) => void) | undefined;
    fetchMock.mockImplementation((input: unknown) => {
      const url = String(input);
      if (url.endsWith('/health')) return Promise.resolve(new Response('{}', { status: 200 }));
      if (url.endsWith('/cancel')) return new Promise<Response>((resolve) => { cancelResponse = resolve; });
      return new Promise<Response>(() => {});
    });
    render();
    await start();
    await act(async () => button('Stop').click());
    await act(async () => button('Cancel dictation').click());
    expect(status()).toBe('cancelling');
    expect(track.stopped).toBe(true);
    expect([...container.querySelectorAll('button')].some((item) => item.textContent === 'Dictate')).toBe(false);
    await act(async () => cancelResponse!(new Response('{}', { status: 200 })));
    expect(status()).toBe('cancelled');
    expect(button('Dictate')).toBeTruthy();
  });

  it('double-clicking Stop sends only one transcription request', async () => {
    render();
    await start();
    const stop = button('Stop');
    await act(async () => {
      stop.click();
      stop.click();
    });
    expect(status()).toBe('success');
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/transcribe'))).toHaveLength(1);
  });
});
