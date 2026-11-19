import type {
  NativeTranscriptPrompt,
  NativeTranscriptRosterAgent,
  NativeTranscriptTurn,
} from './types.js';

export type LinkedBtwTurn = NativeTranscriptTurn & { triggerPromptId: string };
export type BtwTurnSelection =
  | { status: 'pending'; prompt: NativeTranscriptPrompt }
  | { status: 'ready'; turn: LinkedBtwTurn; prompt: NativeTranscriptPrompt };

export function selectBtwTurn(
  prompt: NativeTranscriptPrompt,
  turns: LinkedBtwTurn[],
  rosterEntries: NativeTranscriptRosterAgent[],
  agentId: string,
): BtwTurnSelection {
  if (new Set(turns.map((turn) => turn.turnId)).size !== turns.length) throw new Error('daydream BTW turnId is duplicated or conflicts');
  const roster = rosterEntries.filter((agent) => agent.agentId === agentId);
  if (roster.length !== 1 || roster[0].type !== 'sub') throw new Error('daydream selected agent is not a BTW agent');
  if (['queued', 'running', 'blocked'].includes(prompt.status)) return { status: 'pending', prompt };
  if (prompt.status !== 'completed') throw new Error('daydream BTW prompt is not terminal');
  const candidates = turns.filter((turn) => turn.steps.some((step) => step.frames.length > 0));
  if (candidates.some((turn) => ['queued', 'running'].includes(turn.state))) return { status: 'pending', prompt };
  if (candidates.some((turn) => !['completed', 'failed', 'cancelled'].includes(turn.state))) {
    throw new Error('daydream BTW trigger turn is not terminal');
  }
  const completed = candidates.filter((turn) => turn.state === 'completed');
  if (completed.length !== 1 || completed[0].wedged === true) {
    throw new Error('daydream BTW assistant output frame is missing, wedged, or ambiguous');
  }
  return { status: 'ready', turn: completed[0], prompt };
}
