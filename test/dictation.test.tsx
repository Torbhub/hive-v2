// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubView } from '../src/types.js';
import type { Need } from '../src/ui/look.js';
import { BatchCard } from '../web/questions';
import { MessageRow, NewTaskRow } from '../web/rows';
import { NeedCard } from '../web/needs';
import { DictationError, type DictationEngine, type DictationRecording } from '../web/dictation';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(element: React.ReactNode): void {
  act(() => root.render(element));
}

function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((item) => item.textContent === text);
  if (!found) throw new Error(`No button named ${text}`);
  return found as HTMLButtonElement;
}

function input(label: string): HTMLInputElement {
  const found = container.querySelector(`input[aria-label="${label}"]`);
  if (!found) throw new Error(`No input named ${label}`);
  return found as HTMLInputElement;
}

function typeInto(field: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function fakeEngine(transcript = 'dictated text'): DictationEngine & { recording: DictationRecording } {
  const recording: DictationRecording = {
    stop: vi.fn(async () => transcript),
    cancel: vi.fn(),
  };
  return { start: vi.fn(async () => recording), recording };
}

async function startDictation(): Promise<void> {
  await act(async () => button('Dictate').click());
  expect(container.textContent).toContain('Recording');
}

async function stopDictation(): Promise<void> {
  await act(async () => button('Stop').click());
  expect(container.textContent).toContain('Dictation added');
}

const EMPTY_VIEW: HubView = {
  root: '/r', hubName: 'hub', projects: [], tasks: [], dialogs: {}, decisions: [], questions: [],
  updatedAt: Date.now(), error: '',
};

const NEED_BASE: Need = {
  key: 'demo-1', glyph: '!', color: 'magenta', who: 'demo-1', words: 'plan to approve', when: '',
  project: 'demo', taskId: 'demo-1',
};

describe('task and message dictation', () => {
  it('records, transcribes, inserts at the cursor, and leaves the task draft editable without submitting', async () => {
    const onStartTask = vi.fn(async () => true);
    const engine = fakeEngine('dictated');
    render(<NewTaskRow project="demo" busy={null} onStartTask={onStartTask} dictationEngine={engine} />);
    const field = input('new task for demo');
    typeInto(field, 'write docs');
    act(() => field.setSelectionRange(6, 6));

    await startDictation();
    expect((field as HTMLInputElement).disabled).toBe(false);
    await stopDictation();

    expect(input('new task for demo').value).toBe('write dictated docs');
    expect(container.textContent).toContain('Review and edit');
    expect(onStartTask).not.toHaveBeenCalled();
    typeInto(input('new task for demo'), 'edited draft');
    expect(input('new task for demo').value).toBe('edited draft');
    expect(onStartTask).not.toHaveBeenCalled();
  });

  it('replaces the selected message text and never calls the message action', async () => {
    const onMessage = vi.fn(async () => true);
    const engine = fakeEngine('new words');
    render(<MessageRow project="demo" busy={null} onMessage={onMessage} dictationEngine={engine} />);
    const field = input('message for demo');
    typeInto(field, 'keep old words here');
    act(() => field.setSelectionRange(5, 14));

    await startDictation();
    await stopDictation();
    expect(input('message for demo').value).toBe('keep new words here');
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('cancel during recording discards audio and keeps normal typing usable', async () => {
    const engine = fakeEngine();
    render(<NewTaskRow project="demo" busy={null} onStartTask={vi.fn()} dictationEngine={engine} />);
    const field = input('new task for demo');
    typeInto(field, 'typed draft');
    await startDictation();

    await act(async () => button('Cancel dictation').click());
    expect(engine.recording.cancel).toHaveBeenCalledTimes(1);
    expect(engine.recording.stop).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Dictation cancelled');
    expect(input('new task for demo').value).toBe('typed draft');
    typeInto(input('new task for demo'), 'typing still works');
    expect(input('new task for demo').value).toBe('typing still works');
  });

  it('cancel during transcription ignores a late result', async () => {
    let resolveStop: ((text: string) => void) | undefined;
    const recording: DictationRecording = {
      stop: vi.fn(() => new Promise<string>((resolve) => { resolveStop = resolve; })),
      cancel: vi.fn(),
    };
    const engine: DictationEngine = { start: vi.fn(async () => recording) };
    render(<NewTaskRow project="demo" busy={null} onStartTask={vi.fn()} dictationEngine={engine} />);
    await startDictation();
    await act(async () => button('Stop').click());
    expect(container.textContent).toContain('Transcribing locally');

    await act(async () => button('Cancel dictation').click());
    await act(async () => resolveStop!('late transcript'));
    expect(recording.cancel).toHaveBeenCalledTimes(1);
    expect(input('new task for demo').value).toBe('');
    expect(container.textContent).toContain('Dictation cancelled');
  });

  it.each([
    ['permission-denied', 'Microphone permission was denied'],
    ['unavailable', 'Handy is unavailable'],
    ['failure', 'Dictation failed'],
  ] as const)('shows the %s state without disabling typing', async (kind, message) => {
    const engine: DictationEngine = {
      start: vi.fn(async () => { throw new DictationError(kind, 'engine detail'); }),
    };
    render(<NewTaskRow project="demo" busy={null} onStartTask={vi.fn()} dictationEngine={engine} />);
    await act(async () => button('Dictate').click());
    expect(container.textContent).toContain(message);
    expect(container.textContent).not.toContain('engine detail');
    expect(input('new task for demo').disabled).toBe(false);
    typeInto(input('new task for demo'), 'ordinary typing');
    expect(input('new task for demo').value).toBe('ordinary typing');
  });
});

describe('feedback and question dictation', () => {
  it('inserts plan feedback without approving or sending back the plan', async () => {
    const onPlanAnswer = vi.fn();
    const engine = fakeEngine('more detail');
    render(
      <NeedCard
        need={{ ...NEED_BASE, action: 'plan' }} view={EMPTY_VIEW} busy={null}
        onAnswer={vi.fn()} onContinue={vi.fn()} onPlanAnswer={onPlanAnswer}
        onResolve={vi.fn()} onNudge={vi.fn()} dictationEngine={engine}
      />,
    );
    act(() => button('Send back').click());
    await startDictation();
    await stopDictation();
    const fields = [...container.querySelectorAll('input')] as HTMLInputElement[];
    expect(fields[0].value).toBe('more detail');
    expect(onPlanAnswer).not.toHaveBeenCalled();

    act(() => button('Approve plan').click());
    expect(onPlanAnswer).toHaveBeenCalledWith('demo', 'demo-1', 'approve');
  });

  it('inserts a rebrief without resolving the task', async () => {
    const onResolve = vi.fn();
    const engine = fakeEngine('new brief');
    render(
      <NeedCard
        need={{ ...NEED_BASE, action: 'resolve', words: 'blocked' }} view={EMPTY_VIEW} busy={null}
        onAnswer={vi.fn()} onContinue={vi.fn()} onPlanAnswer={vi.fn()}
        onResolve={onResolve} onNudge={vi.fn()} dictationEngine={engine}
      />,
    );
    act(() => button('Rebrief').click());
    await startDictation();
    await stopDictation();
    expect(input('new brief for demo-1').value).toBe('new brief');
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('inserts an Other answer without submitting the question batch or changing its choice', async () => {
    const onAnswer = vi.fn();
    const engine = fakeEngine('my own answer');
    render(
      <BatchCard
        batch={{
          id: 'batch-1', project: 'demo', agent: 'worker', context: 'Choose an approach',
          questions: [{
            id: 'q1', question: 'Which approach?', context: 'Pick one', priority: 1,
            choices: [{ id: 'c1', label: 'First', description: 'Use the first approach' }],
            recommended: 'c1',
          }],
          status: 'open', createdAt: '2026-11-06T00:00:00Z',
        }}
        onAnswer={onAnswer} onCancel={vi.fn()} dictationEngine={engine}
      />,
    );
    const other = container.querySelector('input[type="radio"][value="other"]') as HTMLInputElement;
    act(() => other.click());
    await startDictation();
    await stopDictation();
    expect(input('Other answer for q1').value).toBe('my own answer');
    expect(other.checked).toBe(true);
    expect(onAnswer).not.toHaveBeenCalled();
  });
});
