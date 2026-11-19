import { KimiServerClient } from './kimi-server.js';
import type { NativeBranchClient } from './types.js';
import { UsageError } from './usage.js';

export function createNativeBranchClient(): NativeBranchClient {
  const token = process.env.HIVE_KIMI_SERVER_TOKEN;
  if (!token) throw new UsageError('HIVE_KIMI_SERVER_TOKEN is required for a native branch operation');
  return new KimiServerClient({
    origin: process.env.HIVE_KIMI_SERVER_ORIGIN ?? 'http://127.0.0.1:58627',
    token,
  });
}
