import { cleanAgentText, containsInternalContent, containsSecurityInstruction } from './decisions.js';
import { redactSecrets } from './logview.js';
import { nativeSha } from './native-history.js';
import { Refusal } from './state.js';
import type {
  DaydreamBrief,
  DaydreamCitation,
  DaydreamFact,
  NativeMessage,
  TaskEvent,
} from './types.js';

export const MAX_DAYDREAM_BRIEF_BYTES = 64 * 1024;
const HASH = /^[a-f0-9]{64}$/;

type Expected = {
  id: string;
  phase: 'mine' | 'recover';
  checkpointId: string;
  questionHash: string;
  sourceHistoryHash: string;
};
export type DaydreamEvidence = {
  nativeMessages: NativeMessage[];
  taskEvents: TaskEvent[];
  handoff: { pathHash: string; contentHash: string; content: string };
};

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Refusal(`${field} must be an object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], field: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Refusal(`${field}: unknown field ${key}`);
}
function hash(value: unknown, field: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Refusal(`${field} is invalid`);
  return value;
}
function text(value: unknown, field: string, cap = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > cap) throw new Refusal(`${field} is invalid`);
  return value;
}
function prose(value: unknown, field: string): string {
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Refusal(`${field} has unsafe controls`);
  }
  if (containsSecurityInstruction(value) || containsInternalContent(value)) throw new Refusal(`${field} has unsafe instructions`);
  const clean = cleanAgentText(value);
  if (!clean || clean === 'Internal content removed.' || containsSecurityInstruction(clean) || containsInternalContent(clean)) {
    throw new Refusal(`${field} has unsafe instructions`);
  }
  if (clean.length > 4_000) throw new Refusal(`${field} is too large`);
  return clean;
}
function citationQuote(value: unknown, field: string): string {
  const quote = prose(value, field);
  if (redactSecrets(quote) !== quote) throw new Refusal(`${field} requires redaction and cannot be a citation`);
  return quote;
}
function citationFrom(value: unknown): DaydreamCitation {
  const raw = object(value, 'daydream citation');
  const kind = text(raw.kind, 'daydream citation kind');
  if (kind === 'native') {
    keys(raw, ['kind', 'messageId', 'contentHash', 'quote'], 'native citation');
    return {
      kind,
      messageId: text(raw.messageId, 'native citation messageId'),
      contentHash: hash(raw.contentHash, 'native citation contentHash'),
      quote: citationQuote(raw.quote, 'native citation quote'),
    };
  }
  if (kind === 'task') {
    keys(raw, ['kind', 'eventHash', 'quote'], 'task citation');
    return { kind, eventHash: hash(raw.eventHash, 'task citation eventHash'), quote: citationQuote(raw.quote, 'task citation quote') };
  }
  if (kind === 'handoff') {
    keys(raw, ['kind', 'pathHash', 'contentHash', 'quote'], 'handoff citation');
    return {
      kind,
      pathHash: hash(raw.pathHash, 'handoff citation pathHash'),
      contentHash: hash(raw.contentHash, 'handoff citation contentHash'),
      quote: citationQuote(raw.quote, 'handoff citation quote'),
    };
  }
  throw new Refusal('daydream citation kind is invalid');
}
function factFrom(value: unknown, index: number): DaydreamFact {
  const raw = object(value, `daydream facts[${index}]`);
  keys(raw, ['id', 'answer', 'whyNow', 'uncertainty', 'citations'], `daydream facts[${index}]`);
  if (raw.id !== `f${index + 1}`) throw new Refusal('daydream fact ids must be sequential f1..f12');
  if (!Array.isArray(raw.citations) || raw.citations.length < 1 || raw.citations.length > 20) {
    throw new Refusal('daydream fact citations require 1..20 entries');
  }
  return {
    id: raw.id,
    answer: prose(raw.answer, `daydream facts[${index}].answer`),
    whyNow: prose(raw.whyNow, `daydream facts[${index}].whyNow`),
    uncertainty: prose(raw.uncertainty, `daydream facts[${index}].uncertainty`),
    citations: raw.citations.map(citationFrom),
  };
}
export function parseDaydreamBrief(value: unknown, expected: Expected): DaydreamBrief {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Refusal('daydream brief is not serializable');
  }
  if (serialized === undefined || Buffer.byteLength(serialized) > MAX_DAYDREAM_BRIEF_BYTES) {
    throw new Refusal('daydream brief is oversized');
  }
  const raw = object(value, 'daydream brief');
  keys(raw, ['schemaVersion', 'daydreamId', 'phase', 'checkpointId', 'questionHash', 'sourceHistoryHash', 'facts', 'unknowns'], 'daydream brief');
  if (raw.schemaVersion !== 1 || raw.daydreamId !== expected.id || raw.phase !== expected.phase
    || raw.checkpointId !== expected.checkpointId || raw.questionHash !== expected.questionHash
    || raw.sourceHistoryHash !== expected.sourceHistoryHash) {
    throw new Refusal('daydream brief schema, phase, checkpoint, question, or source history does not match');
  }
  hash(raw.questionHash, 'daydream questionHash');
  hash(raw.sourceHistoryHash, 'daydream sourceHistoryHash');
  if (!Array.isArray(raw.facts) || raw.facts.length < 1 || raw.facts.length > 12) throw new Refusal('daydream brief requires 1..12 facts');
  if (!Array.isArray(raw.unknowns) || raw.unknowns.length > 12) throw new Refusal('daydream brief allows at most 12 unknowns');
  return {
    schemaVersion: 1,
    daydreamId: expected.id,
    phase: expected.phase,
    checkpointId: expected.checkpointId,
    questionHash: expected.questionHash,
    sourceHistoryHash: expected.sourceHistoryHash,
    facts: raw.facts.map(factFrom),
    unknowns: raw.unknowns.map((entry, index) => prose(entry, `daydream unknowns[${index}]`)),
  };
}
export function daydreamFactsHash(brief: DaydreamBrief): string {
  return nativeSha({ facts: brief.facts, unknowns: brief.unknowns });
}
export function redactDaydreamBrief(brief: DaydreamBrief): DaydreamBrief {
  return {
    ...brief,
    facts: brief.facts.map((fact) => ({
      ...fact,
      answer: redactSecrets(fact.answer),
      whyNow: redactSecrets(fact.whyNow),
      uncertainty: redactSecrets(fact.uncertainty),
      citations: fact.citations.map((citation) => ({ ...citation, quote: redactSecrets(citation.quote) })),
    })),
    unknowns: brief.unknowns.map(redactSecrets),
  };
}
function messageText(message: NativeMessage): string {
  return message.content.filter((part) => part.type === 'text').map((part) => String(part.text ?? '')).join('\n');
}
function eventText(event: TaskEvent): string {
  return [event.note ?? '', ...(event.checkpoints ?? []).map((checkpoint) => checkpoint.desc)].join('\n');
}
export function verifyDaydreamCitations(brief: DaydreamBrief, evidence: DaydreamEvidence): void {
  for (const fact of brief.facts) {
    for (const citation of fact.citations) {
      if (citation.kind === 'native') {
        const matches = evidence.nativeMessages.filter((message) => message.id === citation.messageId && message.role === 'assistant');
        if (matches.length !== 1 || nativeSha(matches[0].content) !== citation.contentHash
          || !messageText(matches[0]).includes(citation.quote)) {
          throw new Refusal('native citation message, content hash, or exact quote does not match');
        }
      } else if (citation.kind === 'task') {
        const matches = evidence.taskEvents.filter((event) => nativeSha(event) === citation.eventHash);
        if (matches.length !== 1 || !eventText(matches[0]).includes(citation.quote)) {
          throw new Refusal('task citation event hash or exact quote does not match');
        }
      } else if (evidence.handoff.pathHash !== citation.pathHash || evidence.handoff.contentHash !== citation.contentHash
        || !evidence.handoff.content.includes(citation.quote)) {
        throw new Refusal('handoff citation path, content hash, or exact quote does not match');
      }
    }
  }
}
export function assertStandaloneBriefMessage(messages: NativeMessage[], value: unknown): void {
  const expected = JSON.stringify(value);
  const matches = messages.filter((message) => {
    if (message.role !== 'assistant' || message.content.length !== 1 || message.content[0].type !== 'text') return false;
    const raw = message.content[0].text;
    if (typeof raw !== 'string') return false;
    try {
      return JSON.stringify(JSON.parse(raw)) === expected;
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) throw new Refusal('standalone brief JSON must bind to exactly one native assistant message');
}
