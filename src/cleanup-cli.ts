import path from 'node:path';
import { promises as fs } from 'node:fs';
import { cleanupProject } from './cleanup.js';
import { checkName } from './names.js';
import { UsageError } from './usage.js';

const CLEANUP_USAGE = 'usage: hive cleanup <project> [--dry-run] [--reclaim-trash --owner-approved]';
const CLEANUP_FLAGS = new Set(['dry-run', 'reclaim-trash', 'owner-approved']);

function validProject(value: string): string {
  try {
    return checkName('project', value);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function parseCleanup(args: string[]) {
  const flags = new Set<string>();
  const pos: string[] = [];
  for (const arg of args) {
    if (arg.startsWith('--')) {
      if (!CLEANUP_FLAGS.has(arg.slice(2))) throw new UsageError(`unknown flag: ${arg}`);
      flags.add(arg.slice(2));
    } else {
      pos.push(arg);
    }
  }
  const project = pos[0];
  if (!project || pos.length > 1 || flags.has('owner-approved') && !flags.has('reclaim-trash')) {
    throw new UsageError(CLEANUP_USAGE);
  }
  return {
    project,
    dryRun: flags.has('dry-run'),
    reclaimTrash: flags.has('reclaim-trash'),
    ownerApproved: flags.has('owner-approved'),
  };
}

async function initializedRoot(): Promise<string> {
  const configured = path.resolve(process.env.HIVE_HUB_ROOT ?? process.cwd());
  let root: string;
  try {
    root = await fs.realpath(configured);
  } catch (error) {
    throw new Error(`cleanup Hub root is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const marker = JSON.parse(await fs.readFile(path.join(root, '.hive-hub', 'hub.json'), 'utf8')) as { name?: unknown };
    if (typeof marker.name !== 'string' || !marker.name) throw new Error('the Hub name is missing');
  } catch (error) {
    throw new Error(`cleanup requires an initialized Hub at ${root}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return root;
}

export async function cleanupCommand(args: string[]): Promise<void> {
  const { project, dryRun, reclaimTrash, ownerApproved } = parseCleanup(args);
  const actions = await cleanupProject(await initializedRoot(), validProject(project), {
    dryRun, reclaimTrash, ownerApproved,
  });
  if (actions.length === 0) console.log(`hive: nothing to clean for ${project}`);
  for (const action of actions) console.log(`${dryRun ? 'would ' : ''}${action.action}`);
}
