// `hive memory` subcommands. Kept out of cli.ts: that file is at its
// line-count baseline (scripts/discipline-gate.mjs).
import { listCandidates, memoryEnabled, promoteCandidate, proposeMemory } from './memory.js';

const USAGE = 'usage: hive memory propose <project> <text...> | ls <project> | promote <project> <id>';

const PROJECT_RE = /^[a-z][a-z0-9-]{0,31}$/;

function needEnabled(): void {
  if (!memoryEnabled()) {
    throw new Error('memory is not configured: set HIVE_MEMORY_KEY (docs/memory.md)');
  }
}

export async function memoryCommand(args: string[]): Promise<void> {
  const [sub, project, ...rest] = args;
  if (!sub || !project || !PROJECT_RE.test(project)) throw new Error(USAGE);
  switch (sub) {
    case 'propose': {
      const text = rest.join(' ').trim();
      if (!text) throw new Error(USAGE);
      needEnabled();
      const agent = process.env.HIVE_AGENT ?? 'unknown';
      const id = await proposeMemory(project, agent, text, { session: process.env.HIVE_SESSION });
      if (!id) throw new Error('memory did not take the candidate; is hive-memory-core up? (hive doctor checks port 8420)');
      console.log(id);
      return;
    }
    case 'ls': {
      needEnabled();
      const items = await listCandidates(project);
      if (!items) throw new Error('memory did not answer; is hive-memory-core up?');
      if (items.length === 0) {
        console.log(`hive: no memory candidates for ${project}`);
        return;
      }
      for (const it of items) console.log(`${it.id}  ${it.content.split('\n')[0]}`);
      return;
    }
    case 'promote': {
      const id = rest[0];
      if (!id) throw new Error(USAGE);
      needEnabled();
      const r = await promoteCandidate(project, id);
      if (r.kind === 'unavailable') throw new Error('memory did not answer; is hive-memory-core up?');
      if (r.kind === 'missing') throw new Error(`no candidate ${id} for ${project} (hive memory ls ${project})`);
      console.log(`hive: ${id} is now team memory ${r.id}`);
      return;
    }
    default:
      throw new Error(USAGE);
  }
}
