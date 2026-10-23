import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpError } from './http-error.js';

const STRETCH_FIELD_CAP = 200;

// The stretchtext skill reads this log to know which spans the owner opened.
function stretchLogPath(): string {
  return process.env.HIVE_STRETCH_LOG
    ?? path.join(os.homedir(), '.kimi-code', 'stretch-opened.jsonl');
}

export async function recordStretchOpened(body: Record<string, unknown>): Promise<unknown> {
  const short = String(body.short ?? '').trim();
  if (!short) throw new HttpError(400, 'short is empty');
  if (short.length > STRETCH_FIELD_CAP) {
    throw new HttpError(413, `short is capped at ${STRETCH_FIELD_CAP} characters`);
  }
  const pane = String(body.pane ?? '').slice(0, STRETCH_FIELD_CAP);
  const file = stretchLogPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify({ ts: Date.now(), short, pane })}\n`);
  return { ok: true };
}
