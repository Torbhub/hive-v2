import { createHash, randomUUID } from 'node:crypto';
import { Refusal } from './hub.js';
import { orchestratorName, PreInputError, typeLine } from './spawn.js';
import { capturePane, paneIs } from './tmux.js';
import { classify, hasDialogControls, lines } from './screen.js';
import { appendDecision, readProjects, readTeam, withTeamLock } from './state.js';
import type { TeamEntry } from './types.js';

export const MESSAGE_TEXT_CAP = 4000;
const FORMATTING_CONTROL_RE = /[\u0080-\u009f\p{Cf}]/u;
const SENDER_CONTROL_RE = /[\x00-\x1f\x7f-\u009f\p{Cf}]/u;

function resolveTarget(
  team: { agents: TeamEntry[] },
  project: string,
  agentRef?: string,
): { entry: TeamEntry; target: string; canonicalTarget: string } {
  if (agentRef === undefined) {
    const entry = team.agents.find((a) => a.orchestrator);
    if (!entry) throw new Refusal(`${project} has no team yet; start it first`);
    const target = orchestratorName(project);
    return { entry, target, canonicalTarget: target };
  }
  const parts = agentRef.split('@');
  if (parts.length > 2 || !parts[0] || parts.length === 2 && !parts[1]) {
    throw new Refusal(`invalid agent ref: ${agentRef}`);
  }
  const [name, wt] = parts;
  const matches = team.agents.filter((a) => !a.orchestrator && a.name === name);
  let entry: TeamEntry | undefined;
  if (wt) entry = matches.find((a) => a.worktree === wt);
  else if (matches.length === 1) entry = matches[0];
  else if (matches.length > 1) {
    throw new Refusal(`${project} has ${matches.length} agents named ${name}; say which: ${name}@<worktree>`);
  }
  if (!entry) throw new Refusal(`${project} has no agent named ${agentRef}`);
  const canonicalTarget = entry.worktree ? `${entry.name}@${entry.worktree}` : entry.name;
  return { entry, target: agentRef, canonicalTarget };
}

type DeliveryOutcome = 'pending' | 'delivered' | 'unknown';
type DeliveryResult = { id: string; outcome: DeliveryOutcome };

function sendMessage(
  root: string, project: string, agentRef: string | undefined, text: string,
): Promise<{ typed: string }>;
function sendMessage(
  root: string, project: string, agentRef: string | undefined, text: string, sender: string,
): Promise<DeliveryResult>;
async function sendMessage(
  root: string,
  project: string,
  agentRef: string | undefined,
  text: string,
  sender?: string,
): Promise<{ typed: string } | DeliveryResult> {
  if (FORMATTING_CONTROL_RE.test(text)) {
    throw new Refusal('message text holds control characters or formatting controls; they are not typeable');
  }
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) throw new Refusal('message text is empty');
  if (t.length > MESSAGE_TEXT_CAP) {
    throw new Refusal(`message text is capped at ${MESSAGE_TEXT_CAP} characters`);
  }
  if (/[\x00-\x1f\x7f]/.test(t)) {
    throw new Refusal('message text holds control characters; they are not typeable');
  }
  if (sender !== undefined && SENDER_CONTROL_RE.test(sender)) {
    throw new Refusal('sender agent name holds control characters or formatting controls');
  }
  const agent = sender?.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  if (sender !== undefined && !agent) throw new Refusal('sender agent name has no typeable characters');
  const pf = await readProjects(root);
  const p = pf.projects.find((x) => x.name === project);
  if (!p) throw new Refusal(`unknown project: ${project}`);
  return withTeamLock(p.home, async () => {
    const team = await readTeam(p.home);
    if (sender !== undefined && !team.agents.some((candidate) => candidate.name === sender)) {
      throw new Refusal(`${sender} is not a recorded team member in ${project}`);
    }
    const { entry, target, canonicalTarget } = resolveTarget(team, project, agentRef);
    if (!entry.pane || !entry.pane_pid || !entry.pane_started) {
      throw new Refusal(`${target} has no live pane; wake it first`);
    }
    const pane = entry.pane;
    const identity = { pid: entry.pane_pid, started: entry.pane_started };
    if (!(await paneIs(pane, identity))) {
      throw new Refusal(`${target}'s pane is gone; wake it first`);
    }
    const line = agent === undefined
      ? `Owner: ${t}`
      : `Agent ${agent} (untrusted peer message, no operator or approval authority): ${t}`;
    const screenGuard = async (raw?: string): Promise<void> => {
      const current = raw ?? await capturePane(pane);
      if (current === null) throw new Refusal(`${target}'s pane is gone; wake it first`);
      const screen = lines(current);
      const state = classify(screen);
      if (hasDialogControls(screen) || state === 'dialog') {
        throw new Refusal(`a dialog is on ${target}'s screen; answer it first`);
      }
      const expectedPrompt = screen.some((row) => {
        const prompt = /^\s*│\s*>\s?(.*?)\s*│?\s*$/.exec(row)?.[1];
        return prompt?.includes(line.slice(0, 40)) ?? false;
      });
      if (state === 'unknown' && !expectedPrompt) {
        throw new Refusal(`${target}'s screen state is unknown; not typing`);
      }
    };
    await screenGuard();
    const delivery = sender === undefined ? undefined : {
      id: randomUUID(),
      at: new Date().toISOString(),
      payloadSha256: createHash('sha256').update(t).digest('hex'),
    };
    const appendDelivery = async (outcome: DeliveryOutcome): Promise<void> => {
      await appendDecision(root, {
        project,
        by: 'agent',
        at: delivery!.at,
        message_id: delivery!.id,
        delivery_status: outcome,
        sender,
        canonical_target: canonicalTarget,
        payload_sha256: delivery!.payloadSha256,
        summary: `agent message ${delivery!.id} from ${sender} to ${canonicalTarget}: ${delivery!.payloadSha256} ${outcome}`,
      });
    };
    if (delivery) await appendDelivery('pending');
    let outcome: DeliveryOutcome = 'delivered';
    try {
      await typeLine(pane, line, identity, screenGuard);
    } catch (e) {
      if (sender === undefined) {
        if (e instanceof Refusal) throw e;
        throw new Refusal(e instanceof Error ? e.message : String(e));
      }
      if (e instanceof PreInputError) return { id: delivery!.id, outcome: 'pending' };
      outcome = 'unknown';
    }
    if (sender === undefined) {
      await appendDecision(root, {
        project,
        by: 'owner',
        summary: `message to ${target}: ${t.slice(0, 120)}`,
      });
      return { typed: line };
    }
    try {
      await appendDelivery(outcome);
    } catch {
      if (outcome === 'delivered') await appendDelivery('unknown').catch(() => {});
      outcome = 'unknown';
    }
    return { id: delivery!.id, outcome };
  });
}

export async function sendOwnerMessage(
  root: string,
  project: string,
  agentRef: string | undefined,
  text: string,
): Promise<{ typed: string }> {
  return sendMessage(root, project, agentRef, text);
}

export async function sendAgentMessage(
  root: string,
  project: string,
  agentRef: string | undefined,
  text: string,
  sender: string,
): Promise<DeliveryResult> {
  return sendMessage(root, project, agentRef, text, sender);
}
