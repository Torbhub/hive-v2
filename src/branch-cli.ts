import { constants, promises as fs } from 'node:fs';
import {
  MAX_NATIVE_BRANCH_RESULT_BYTES,
  createNativeBranch,
  listNativeBranches,
  readNativeBranch,
  reconcileNativeBranchCreation,
  reconcileNativeBranchRejoin,
  recordNativeBranchResult,
  refreshNativeBranch,
} from './branches.js';
import { createNativeBranchClient } from './native-client.js';
import { checkName } from './names.js';
import { readProjects } from './state.js';
import { UsageError } from './usage.js';
import type { NativeBranchClient } from './types.js';

const USAGE = `usage: hive branch
  create <project> --agent <name> --purpose <text> [--fork]
  status [project]
  refresh <project> <branch>
  result <project> <branch> --file <json>
  reconcile <project> <branch>`;

type Dependencies = { native?: NativeBranchClient; now?: string };
type Parsed = { pos: string[]; flags: Record<string, string[]> };

function parse(args: string[], names: string[]): Parsed {
  const pos: string[] = [];
  const flags: Record<string, string[]> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      pos.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (!names.includes(name)) throw new UsageError(`unknown branch flag: ${arg}\n${USAGE}`);
    if (name === 'fork') {
      flags.fork = [...(flags.fork ?? []), 'true'];
      continue;
    }
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value\n${USAGE}`);
    flags[name] = [...(flags[name] ?? []), value];
  }
  return { pos, flags };
}
function one(parsed: Parsed, name: string): string | undefined {
  const values = parsed.flags[name];
  if (!values) return undefined;
  if (values.length !== 1) throw new UsageError(`--${name} can appear only once\n${USAGE}`);
  return values[0];
}
function required(value: string | undefined, name: string): string {
  if (!value) throw new UsageError(`--${name} is required\n${USAGE}`);
  return value;
}
function validName(kind: string, value: string | undefined): string {
  if (!value) throw new UsageError(USAGE);
  try {
    return checkName(kind, value);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}
function requireEnabled(): void {
  if (process.env.HIVE_NATIVE_BRANCHES !== '1') throw new UsageError('native branches are disabled; set HIVE_NATIVE_BRANCHES=1');
}
function nativeFor(dependencies: Dependencies): NativeBranchClient {
  return dependencies.native ?? createNativeBranchClient();
}
function branchPosition(parsed: Parsed): { project: string; id: string } {
  if (parsed.pos.length !== 2) throw new UsageError(USAGE);
  return { project: validName('project', parsed.pos[0]), id: parsed.pos[1] };
}
function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
async function readResult(file: string): Promise<unknown> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
    throw new UsageError(`cannot open regular result file: ${error instanceof Error ? error.message : String(error)}`);
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_NATIVE_BRANCH_RESULT_BYTES) throw new UsageError('native result must be a regular file within the byte limit');
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(16_384, MAX_NATIVE_BRANCH_RESULT_BYTES + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_NATIVE_BRANCH_RESULT_BYTES) throw new UsageError('native result oversized');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new UsageError('native result must be structured JSON, not prose');
    }
  } finally {
    await handle.close();
  }
}

export async function branchCommand(root: string, args: string[], dependencies: Dependencies = {}): Promise<void> {
  const command = args[0];
  if (!command || command === 'help') throw new UsageError(USAGE);
  if (command === 'status') {
    const parsed = parse(args.slice(1), []);
    if (parsed.pos.length > 1) throw new UsageError(USAGE);
    if (parsed.pos[0]) {
      print(await listNativeBranches(root, validName('project', parsed.pos[0])));
      return;
    }
    const projects = (await readProjects(root)).projects;
    print((await Promise.all(projects.map((project) => listNativeBranches(root, project.name)))).flat());
    return;
  }

  requireEnabled();
  switch (command) {
    case 'create': {
      const parsed = parse(args.slice(1), ['agent', 'purpose', 'fork']);
      if (parsed.pos.length !== 1) throw new UsageError(USAGE);
      const fork = one(parsed, 'fork') !== undefined;
      print(await createNativeBranch({
        root,
        project: validName('project', parsed.pos[0]),
        agent: validName('agent', required(one(parsed, 'agent'), 'agent')),
      }, {
        kind: fork ? 'fork' : 'child',
        purpose: required(one(parsed, 'purpose'), 'purpose'),
      }, nativeFor(dependencies), { now: dependencies.now }));
      return;
    }
    case 'refresh': {
      const { project, id } = branchPosition(parse(args.slice(1), []));
      print(await refreshNativeBranch({ root, project }, id, nativeFor(dependencies), { now: dependencies.now }));
      return;
    }
    case 'result': {
      const parsed = parse(args.slice(1), ['file']);
      const { project, id } = branchPosition(parsed);
      const value = await readResult(required(one(parsed, 'file'), 'file'));
      print(await recordNativeBranchResult({ root, project }, id, value, nativeFor(dependencies), { now: dependencies.now }));
      return;
    }
    case 'reconcile': {
      const { project, id } = branchPosition(parse(args.slice(1), []));
      const native = nativeFor(dependencies);
      const branch = await readNativeBranch({ root, project }, id);
      print(await (branch.rejoin
        ? reconcileNativeBranchRejoin({ root, project }, id, native, { now: dependencies.now })
        : reconcileNativeBranchCreation({ root, project }, id, native, { now: dependencies.now })));
      return;
    }
    default:
      throw new UsageError(USAGE);
  }
}
