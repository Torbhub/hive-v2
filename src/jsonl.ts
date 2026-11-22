import { promises as fs } from 'node:fs';

export function parseJsonl<T>(file: string, raw: string): T[] {
  const records: T[] = [];
  const lines = raw.split('\n');
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as T);
    } catch (error) {
      if (index === lines.length - 1 && !raw.endsWith('\n')) continue;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`corrupt JSONL in ${file}:${index + 1}: ${detail}`);
    }
  }
  return records;
}

export async function readJsonl<T>(file: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return parseJsonl<T>(file, raw);
}
