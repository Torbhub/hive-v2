const actionChains = new Map<string, Promise<void>>();

export function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = actionChains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const sweep = () => { if (actionChains.get(key) === tail) actionChains.delete(key); };
  const tail = run.then(sweep, sweep);
  actionChains.set(key, tail);
  return run;
}
