import { promises as fs, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hubPath } from '../src/state.js';
import { loadProcessedKeys, recordProcessedKey } from '../src/watch-persist.js';

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'hive-persist-'));
}

describe('watch-persist', () => {
  it('a missing file loads as an empty set', async () => {
    expect(await loadProcessedKeys(tmp())).toEqual(new Set());
  });

  it('recorded keys round-trip through a load', async () => {
    const root = tmp();
    await recordProcessedKey(root, '%1:11');
    await recordProcessedKey(root, 'stale:%2:489000');
    expect(await loadProcessedKeys(root)).toEqual(new Set(['%1:11', 'stale:%2:489000']));
  });

  it('a torn last line is dropped, not fatal', async () => {
    const root = tmp();
    await recordProcessedKey(root, '%1:11');
    await fs.appendFile(hubPath(root, 'watch-processed.jsonl'), '{"key":"%2');
    expect(await loadProcessedKeys(root)).toEqual(new Set(['%1:11']));
  });
});
