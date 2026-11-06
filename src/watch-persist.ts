import { promises as fs } from 'node:fs';
import { hubPath, readDecisions } from './state.js';
import type { TeamEntry } from './types.js';

// Keys the watch already handled, so a restart never re-reports them.
// Death keys are `<pane>:<pid>`. Stale episode keys are
// `stale:<session>:<pane>:<wire-mtime>` on decisions or migrated records.
const FILE = 'watch-processed.jsonl';

type ProcessedRecord = { key: string; at: string | undefined };

async function readProcessedRecords(root: string): Promise<ProcessedRecord[]> {
  const raw = await fs.readFile(hubPath(root, FILE), 'utf8').catch(() => '');
  const out: ProcessedRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as { key?: unknown; at?: unknown };
      if (typeof rec.key === 'string') {
        out.push({ key: rec.key, at: typeof rec.at === 'string' ? rec.at : undefined });
      }
    } catch {
      // A torn last line (crashed append) is dropped, not fatal.
    }
  }
  return out;
}

export async function loadProcessedKeys(root: string): Promise<Set<string>> {
  const out = new Set((await readProcessedRecords(root)).map((record) => record.key));
  for (const decision of await readDecisions(root, Number.MAX_SAFE_INTEGER)) {
    if (typeof decision.watch_key === 'string') out.add(decision.watch_key);
  }
  return out;
}

export async function recordProcessedKey(root: string, key: string): Promise<void> {
  await fs.mkdir(hubPath(root), { recursive: true });
  await fs.appendFile(hubPath(root, FILE), JSON.stringify({ key, at: new Date().toISOString() }) + '\n');
}

export async function migrateLegacyStaleKey(
  root: string,
  project: string,
  agent: TeamEntry,
  wireAt: number,
  key: string,
  seen: Set<string>,
): Promise<boolean> {
  const pane = agent.pane;
  if (!pane) return false;
  const suffix = `:${pane}:${wireAt}`;
  for (const processed of seen) {
    if (processed !== key && processed.startsWith('stale:') && processed.split(':').length >= 4 && processed.endsWith(suffix)) {
      return false;
    }
  }
  const records = await readProcessedRecords(root);
  const prefix = `stale: ${project}/${agent.name} no output for `;
  for (const decision of await readDecisions(root, Number.MAX_SAFE_INTEGER)) {
    if (decision.project !== project || decision.by !== 'watch' || decision.watch_key) continue;
    if (!decision.summary.startsWith(prefix) || !decision.summary.endsWith('m')) continue;
    const minutes = Number(decision.summary.slice(prefix.length, -1));
    const at = Date.parse(decision.at);
    if (!Number.isInteger(minutes) || minutes < 0 || !Number.isFinite(at)) continue;
    const hour = Math.floor(at / 3_600_000);
    const legacyKeys = [`stale:${pane}:${hour}`, `stale:${pane}:${hour - 1}`];
    const recordAts = records
      .filter((record) => legacyKeys.includes(record.key) && seen.has(record.key))
      .map((record) => record.at === undefined ? Number.NaN : Date.parse(record.at));
    if (recordAts.length === 0) continue;
    const unchanged = [at, ...recordAts].some((timestamp) => (
      Number.isFinite(timestamp) && Math.floor((timestamp - wireAt) / 60_000) === minutes
    ));
    if (!unchanged) continue;
    await recordProcessedKey(root, key);
    return true;
  }
  return false;
}
