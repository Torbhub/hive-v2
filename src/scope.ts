import { promises as fs } from 'node:fs';
import { hubPath, readTeam } from './state.js';

// Structured task briefs: optional `---` frontmatter and a `## Files to
// touch` scope claim, ported from citadel's tools/next_chunk.py claim check.
// A scope that does not parse fails closed: a dropped path would silently
// parallelize a real collision.

const FRONTMATTER = /^---\n([\s\S]*?)\n---(?:\n|$)/;
const FILES_SECTION = /^## Files to touch\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m;
const BULLET = /^\s*-\s/;
// A bullet is `- [NEW] path`, optionally followed by an annotation opened
// with `—` or `(`. Anything else after the path (a second token, a comma
// list) fails closed: capturing just the first token would silently drop
// the rest of the claim.
const BULLET_PATH = /^\s*-\s+(?:NEW\s+)?`?([^\s`()]+)`?(\s+[—(].*)?\s*$/;

export type Scope =
  | { kind: 'none' }
  | { kind: 'invalid'; why: string }
  | { kind: 'claim'; paths: Set<string> };

export function taskScope(text: string): Scope {
  if (text.startsWith('---') && !FRONTMATTER.test(text)) {
    return { kind: 'invalid', why: 'the frontmatter never closes' };
  }
  const m = text.match(FILES_SECTION);
  if (!m) return { kind: 'none' };
  const paths = new Set<string>();
  for (const line of m[1].split('\n')) {
    if (!BULLET.test(line)) continue;
    const b = line.match(BULLET_PATH);
    if (!b || b[1].startsWith('—') || b[1] === 'NEW') {
      return { kind: 'invalid', why: `a Files to touch bullet has no path: ${line.trim()}` };
    }
    paths.add(b[1]);
  }
  if (paths.size === 0) return { kind: 'invalid', why: 'the Files to touch section is empty' };
  return { kind: 'claim', paths };
}

// Refuse to start agent on taskId when its declared scope overlaps another
// live agent's task scope. Two agents on the same task never collide; a task
// with no scope claim spawns unchecked.
export async function checkTaskScope(root: string, project: string, home: string, taskId: string): Promise<void> {
  if (!new RegExp(`^${project}-\\d+$`).test(taskId)) {
    throw new Error(`a task id is ${project}-<n>: ${taskId}`);
  }
  const text = await fs.readFile(hubPath(root, 'tasks', `${taskId}.md`), 'utf8').catch(() => null);
  if (text === null) throw new Error(`no task file for ${taskId}`);
  const claim = taskScope(text);
  if (claim.kind === 'invalid') throw new Error(`${taskId}: ${claim.why}; fix the brief before spawning on it`);
  if (claim.kind === 'none') return;
  const team = await readTeam(home);
  for (const a of team.agents) {
    if (!a.task || a.task === taskId) continue;
    const itext = await fs.readFile(hubPath(root, 'tasks', `${a.task}.md`), 'utf8').catch(() => null);
    const inc: Scope = itext === null ? { kind: 'invalid', why: 'the task file is gone' } : taskScope(itext);
    if (inc.kind === 'invalid') {
      throw new Error(`${a.task} (${a.name}) declares a scope that does not parse: ${inc.why}; refusing to guess it is disjoint`);
    }
    if (inc.kind === 'none') continue;
    const shared = [...claim.paths].filter((p) => inc.paths.has(p)).sort();
    if (shared.length) {
      throw new Error(`${taskId} overlaps ${a.name}'s task ${a.task}: ${shared.join(', ')}`);
    }
  }
}
