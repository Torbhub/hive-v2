import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

export async function readBoundedHandle(handle: FileHandle, cap: number, label: string): Promise<string> {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.size > cap) throw new Error(`not a regular bounded file: ${label}`);
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const buffer = Buffer.alloc(Math.min(16_384, cap + 1 - total));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > cap) throw new Error(`file exceeds byte cap: ${label}`);
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readBoundedFile(file: string, cap: number): Promise<string> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await readBoundedHandle(handle, cap, file);
  } finally {
    await handle.close();
  }
}

export async function readBoundedJson(file: string, cap: number): Promise<unknown> {
  const raw = await readBoundedFile(file, cap);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('bounded file must be structured JSON, not prose');
  }
}
