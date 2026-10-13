import React from 'react';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import { Button, ButtonScope } from '../src/ui/buttons.js';

function fakeStreams() {
  const stdout = new PassThrough() as PassThrough & { columns: number; rows: number };
  stdout.columns = 80;
  stdout.rows = 24;
  // ink only attaches its input reader when stdin looks like a TTY.
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean; setRawMode: (m: boolean) => void; ref: () => unknown; unref: () => unknown;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  return { stdout, stdin };
}

function App({ showA, a, b }: { showA: boolean; a: () => void; b: () => void }) {
  return (
    <ButtonScope>
      {showA && <Button label="A" onPress={a} />}
      <Button label="B" onPress={b} />
    </ButtonScope>
  );
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Button registration', () => {
  it('an unmounted button unregisters; Enter fires the live button, never the ghost', async () => {
    const a = vi.fn();
    const b = vi.fn();
    const { stdout, stdin } = fakeStreams();
    const inst = render(<App showA a={a} b={b} />, { stdout, stdin, debug: true, patchConsole: false });
    await tick(150);
    inst.rerender(<App showA={false} a={a} b={b} />);
    await tick(150);
    stdin.write('\r');
    await tick(150);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    inst.unmount();
  });
});
