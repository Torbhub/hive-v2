import { promises as fs } from 'node:fs';
import { hubPath } from './state.js';

// Keys the watch already handled, so a restart never re-reports them.
// Death keys are `<pane>:<pid>`; stale-lane keys are `stale:<pane>:<hour>`.
const FILE = 'watch-processed.jsonl';

export async function loadProcessedKeys(root: string): Promise<Set<string>> {
  let raw: string;
  try {
    raw = await fs.readFile(hubPath(root, FILE), 'utf8');
  } catch {
    return new Set();
  }
  const out = new Set<string>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as { key?: unknown };
      if (typeof rec.key === 'string') out.add(rec.key);
    } catch {
      // A torn last line (crashed append) is dropped, not fatal.
    }
  }
  return out;
}

export async function recordProcessedKey(root: string, key: string): Promise<void> {
  await fs.mkdir(hubPath(root), { recursive: true });
  await fs.appendFile(hubPath(root, FILE), JSON.stringify({ key, at: new Date().toISOString() }) + '\n');
}
