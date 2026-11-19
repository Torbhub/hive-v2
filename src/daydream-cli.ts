import { readBoundedJson } from './bounded-file.js';
import {
  MAX_DAYDREAM_BRIEF_BYTES,
  listDaydreams,
  mineDaydream,
  recoverDaydream,
  verifyDaydreamBrief,
} from './daydream.js';
import {
  getDaydreamAutomationStatus,
  reconcileDaydreamAutomation,
  setDaydreamAutomation,
} from './daydream-automation.js';
import { pruneDaydreamArtifacts, type DaydreamRetentionOptions } from './daydream-retention.js';
import { KimiServerClient } from './kimi-server.js';
import { checkName } from './names.js';
import { readProjects } from './state.js';
import { UsageError } from './usage.js';
import type { DaydreamAutomationRunner, DaydreamNativeClient, NativeTextPart } from './types.js';

const USAGE = `usage: hive daydream
  mine <project> --agent <name> --checkpoint <id> --question <text>
  verify <project> <daydream> --file <brief.json>
  recover <project> <daydream> [--file <brief.json>]
  status [project]
  automation <project> [agent] on|off|status
  reconcile <project> <daydream>
  prune <project> [--dry-run]`;

type Dependencies = {
  native?: DaydreamNativeClient;
  now?: string;
  proofContent?: NativeTextPart[];
  automationRunner?: DaydreamAutomationRunner;
  retention?: Omit<DaydreamRetentionOptions, 'dryRun'>;
};
type Parsed = { pos: string[]; flags: Record<string, string[]> };

function parse(args: string[], names: string[], valueless: string[] = []): Parsed {
  const pos: string[] = [];
  const flags: Record<string, string[]> = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      pos.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (!names.includes(name)) throw new UsageError(`unknown daydream flag: ${arg}\n${USAGE}`);
    if (valueless.includes(name)) {
      flags[name] = [...(flags[name] ?? []), 'true'];
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
  if (process.env.HIVE_DAYDREAM !== '1') throw new UsageError('daydream is disabled; set HIVE_DAYDREAM=1');
  if (process.env.HIVE_NATIVE_BRANCHES !== '1') throw new UsageError('native branches are disabled; set HIVE_NATIVE_BRANCHES=1');
}
function nativeFor(dependencies: Dependencies): DaydreamNativeClient {
  if (dependencies.native) return dependencies.native;
  const token = process.env.HIVE_KIMI_SERVER_TOKEN;
  if (!token) throw new UsageError('HIVE_KIMI_SERVER_TOKEN is required for a native daydream operation');
  return new KimiServerClient({ origin: process.env.HIVE_KIMI_SERVER_ORIGIN ?? 'http://127.0.0.1:58627', token });
}
function position(parsed: Parsed): { project: string; id: string } {
  if (parsed.pos.length !== 2) throw new UsageError(USAGE);
  return { project: validName('project', parsed.pos[0]), id: parsed.pos[1] };
}
function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
async function readBrief(file: string): Promise<unknown> {
  try {
    return await readBoundedJson(file, MAX_DAYDREAM_BRIEF_BYTES);
  } catch (error) {
    throw new UsageError(`daydream brief must be a regular bounded non-symlink JSON file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function daydreamCommand(root: string, args: string[], dependencies: Dependencies = {}): Promise<void> {
  const command = args[0];
  if (!command || command === 'help') throw new UsageError(USAGE);
  if (command === 'status') {
    const parsed = parse(args.slice(1), []);
    if (parsed.pos.length > 1) throw new UsageError(USAGE);
    if (parsed.pos[0]) {
      print(await listDaydreams(root, validName('project', parsed.pos[0])));
      return;
    }
    const projects = (await readProjects(root)).projects;
    print((await Promise.all(projects.map((project) => listDaydreams(root, project.name)))).flat());
    return;
  }
  if (command === 'automation') {
    const parsed = parse(args.slice(1), []);
    const [projectName, agentOrState, explicitState, extra] = parsed.pos;
    const state = explicitState ?? agentOrState;
    if (!projectName || extra || state === undefined || !['on', 'off', 'status'].includes(state)) throw new UsageError(USAGE);
    const project = validName('project', projectName);
    const agentRef = explicitState === undefined ? undefined : agentOrState;
    if (agentRef) checkName('agent', agentRef.split('@')[0]);
    if (state === 'on' || state === 'off') {
      await setDaydreamAutomation(root, project, agentRef, state === 'on');
      console.log(`hive: daydream automation ${state} for ${project}/${agentRef ?? `${project}-orchestrator`}`);
      return;
    }
    const current = await getDaydreamAutomationStatus(root, project);
    if (!agentRef) {
      print(current);
      return;
    }
    const [name, worktree] = agentRef.split('@');
    const agent = current.agents.find((candidate) => candidate.name === name
      && (worktree === undefined || candidate.worktree === worktree));
    if (!agent) throw new UsageError(`${project} has no agent named ${agentRef}`);
    print({ ...agent, daily: current.daily });
    return;
  }
  if (command === 'prune') {
    const parsed = parse(args.slice(1), ['dry-run'], ['dry-run']);
    if (parsed.pos.length !== 1) throw new UsageError(USAGE);
    print(await pruneDaydreamArtifacts(root, validName('project', parsed.pos[0]), {
      ...dependencies.retention,
      dryRun: one(parsed, 'dry-run') === 'true',
    }));
    return;
  }

  requireEnabled();
  switch (command) {
    case 'mine': {
      const parsed = parse(args.slice(1), ['agent', 'checkpoint', 'question']);
      if (parsed.pos.length !== 1) throw new UsageError(USAGE);
      print(await mineDaydream({
        root,
        project: validName('project', parsed.pos[0]),
        agent: validName('agent', required(one(parsed, 'agent'), 'agent')),
      }, {
        checkpointId: required(one(parsed, 'checkpoint'), 'checkpoint'),
        question: required(one(parsed, 'question'), 'question'),
      }, nativeFor(dependencies), { now: dependencies.now }));
      return;
    }
    case 'verify': {
      const parsed = parse(args.slice(1), ['file']);
      const { project, id } = position(parsed);
      const value = await readBrief(required(one(parsed, 'file'), 'file'));
      print(await verifyDaydreamBrief({ root, project }, id, value, nativeFor(dependencies), {
        now: dependencies.now,
        proofContent: dependencies.proofContent,
      }));
      return;
    }
    case 'reconcile': {
      const parsed = parse(args.slice(1), []);
      const { project, id } = position(parsed);
      print(await reconcileDaydreamAutomation(root, project, id, {
        native: dependencies.automationRunner ? dependencies.native : nativeFor(dependencies),
        runner: dependencies.automationRunner,
        now: dependencies.now === undefined ? undefined : Date.parse(dependencies.now),
      }));
      return;
    }
    case 'recover': {
      const parsed = parse(args.slice(1), ['file']);
      const { project, id } = position(parsed);
      const file = one(parsed, 'file');
      const value = file === undefined ? undefined : await readBrief(file);
      print(await recoverDaydream({ root, project }, id, value, nativeFor(dependencies), {
        now: dependencies.now,
        proofContent: dependencies.proofContent,
      }));
      return;
    }
    default:
      throw new UsageError(USAGE);
  }
}
