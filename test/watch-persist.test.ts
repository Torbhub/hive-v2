import { promises as fs, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendDecision, hubPath } from '../src/state.js';
import { loadProcessedKeys, recordProcessedKey } from '../src/watch-persist.js';

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'hive-persist-'));
}

describe('watch-persist', () => {
  it('a missing file loads as an empty set', async () => {
    expect(await loadProcessedKeys(tmp())).toEqual(new Set());
  });

  it('recorded death keys round-trip through a load', async () => {
    const root = tmp();
    await recordProcessedKey(root, '%1:11');
    expect(await loadProcessedKeys(root)).toEqual(new Set(['%1:11']));
  });

  it('a stale decision restores its key without a processed-key file', async () => {
    const root = tmp();
    const staleKey = 'stale:session_b:%2:1762400000000';
    await appendDecision(root, {
      project: 'demo', by: 'watch', summary: 'stale: demo/builder no output for 20m', watch_key: staleKey,
    });
    expect(await loadProcessedKeys(root)).toEqual(new Set([staleKey]));
  });

  it('a torn last line is dropped, not fatal', async () => {
    const root = tmp();
    await recordProcessedKey(root, '%1:11');
    await fs.appendFile(hubPath(root, 'watch-processed.jsonl'), '{"key":"%2');
    expect(await loadProcessedKeys(root)).toEqual(new Set(['%1:11']));
  });
});
