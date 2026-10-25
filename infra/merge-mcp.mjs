#!/usr/bin/env node
// Merge the hive-operator MCP registration into a kimi mcp.json without
// disturbing any other server or top-level field. Idempotent, atomic, and
// never writes when the existing file is malformed.
// usage: node infra/merge-mcp.mjs <path-to-mcp.json>
import { readFileSync, writeFileSync, renameSync, mkdirSync, statSync, lstatSync, rmSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const HIVE_OPERATOR_ENTRY = {
  command: '/usr/local/bin/hive',
  args: ['mcp'],
  // Human batches wait for a human: 7 days, not the 60s default.
  toolTimeoutMs: 604800000,
};

export function mergeMcpText(raw, entry = HIVE_OPERATOR_ENTRY) {
  const config = raw === null ? {} : JSON.parse(raw);
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error('mcp.json must be a JSON object');
  }
  const servers = config.mcpServers === undefined ? {} : config.mcpServers;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
    throw new Error('mcp.json mcpServers must be a JSON object');
  }
  return JSON.stringify({ ...config, mcpServers: { ...servers, 'hive-operator': entry } }, null, 2) + '\n';
}

function main() {
  const file = process.argv[2];
  if (!file) throw new Error('usage: node infra/merge-mcp.mjs <path-to-mcp.json>');
  let raw = null;
  let mode;
  try {
    const st = lstatSync(file);
    if (!st.isFile()) throw new Error(`${file} is not a regular file; refusing to merge`);
    raw = readFileSync(file, 'utf8');
    mode = statSync(file).mode;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  let merged;
  try {
    merged = mergeMcpText(raw);
  } catch (e) {
    // Native parse errors quote the source; other servers' keys must not
    // land in provision logs.
    if (e instanceof SyntaxError) throw new Error('mcp.json is malformed; no changes written');
    throw e;
  }
  if (raw === merged) return;
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${randomUUID()}`;
  try {
    writeFileSync(tmp, merged, { flag: 'wx', mode: (mode ?? 0o600) & 0o777 });
    // The creation mode is umask-masked; chmod preserves the old file's mode.
    chmodSync(tmp, (mode ?? 0o600) & 0o777);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
