import { Refusal } from './hub.js';
import { orchestratorName, typeLine } from './spawn.js';
import { capturePane, paneIs } from './tmux.js';
import { lines, parseDialog } from './screen.js';
import { appendDecision, readProjects, readTeam } from './state.js';
import type { TeamEntry } from './types.js';

// Same cap as a task brief.
export const MESSAGE_TEXT_CAP = 4000;

function resolveTarget(
  team: { agents: TeamEntry[] },
  project: string,
  agentRef?: string,
): { entry: TeamEntry; target: string } {
  if (!agentRef) {
    const entry = team.agents.find((a) => a.orchestrator);
    if (!entry) throw new Refusal(`${project} has no team yet; start it first`);
    return { entry, target: orchestratorName(project) };
  }
  const [name, wt] = agentRef.split('@', 2);
  const matches = team.agents.filter((a) => !a.orchestrator && a.name === name);
  let entry: TeamEntry | undefined;
  if (wt) entry = matches.find((a) => a.worktree === wt);
  else if (matches.length === 1) entry = matches[0];
  else if (matches.length > 1) {
    throw new Refusal(`${project} has ${matches.length} agents named ${name}; say which: ${name}@<worktree>`);
  }
  if (!entry) throw new Refusal(`${project} has no agent named ${agentRef}`);
  return { entry, target: agentRef };
}

// Types one owner line into a live agent pane. The recorded identity must
// still match the pane before anything is typed; typeLine re-checks it again.
export async function sendOwnerMessage(
  root: string,
  project: string,
  agentRef: string | undefined,
  text: string,
): Promise<{ typed: string }> {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) throw new Refusal('message text is empty');
  if (t.length > MESSAGE_TEXT_CAP) {
    throw new Refusal(`message text is capped at ${MESSAGE_TEXT_CAP} characters`);
  }
  // The fold already took \t \n \r; a control byte left over is hostile or
  // broken input, and send-keys -l would deliver it raw (ESC, Ctrl-C, NUL).
  if (/[\x00-\x1f\x7f]/.test(t)) {
    throw new Refusal('message text holds control characters; they are not typeable');
  }
  const pf = await readProjects(root);
  const p = pf.projects.find((x) => x.name === project);
  if (!p) throw new Refusal(`unknown project: ${project}`);
  const { entry, target } = resolveTarget(await readTeam(p.home), project, agentRef);
  if (!entry.pane || !entry.pane_pid || !entry.pane_started) {
    throw new Refusal(`${target} has no live pane; wake it first`);
  }
  const identity = { pid: entry.pane_pid, started: entry.pane_started };
  if (!(await paneIs(entry.pane, identity))) {
    throw new Refusal(`${target}'s pane is gone; wake it first`);
  }
  const raw = await capturePane(entry.pane);
  if (raw !== null && parseDialog(lines(raw)).kind !== 'none') {
    throw new Refusal(`a dialog is on ${target}'s screen; answer it first`);
  }
  const line = `Owner: ${t}`;
  try {
    await typeLine(entry.pane, line, identity);
  } catch (e) {
    // typeLine's errors name only the pane, so they are safe to show.
    throw new Refusal(e instanceof Error ? e.message : String(e));
  }
  // A send that cannot be logged is an error, not a success.
  await appendDecision(root, { project, by: 'owner', summary: `message to ${target}: ${t.slice(0, 120)}` });
  return { typed: line };
}
