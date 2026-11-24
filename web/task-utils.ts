import type { HubTask, HubView } from '../src/types';
import { taskProgress } from '../src/ui/look';

export function taskBrief(task: HubTask): string {
  return task.brief ?? task.contract?.objective ?? task.last_note ?? 'No brief recorded.';
}

export function taskStep(task: HubTask): string {
  if (task.state === 'plan') return 'Awaiting your plan approval';
  if (task.state === 'question') return 'Awaiting your answer';
  if (task.state === 'blocked') return 'Blocked on the owner';
  const progress = taskProgress(task);
  if (!progress) return 'No checkpoints recorded';
  if (progress.current) return `${progress.current} · ${progress.done}/${progress.total} complete`;
  return `${progress.done}/${progress.total} checkpoints complete`;
}

export function taskEvidence(task: HubTask, view: HubView): string {
  const node = view.workTree?.nodes.find((candidate) => candidate.task === task.id && candidate.kind === 'task');
  if (node?.registeredPass) return 'Evidence complete';
  if (node?.evidenceIncomplete) return 'Evidence incomplete';
  if (node && node.doneBlockers.length > 0) return 'Evidence blocked';
  if (task.last_receipt) return 'Receipt recorded';
  if (['done', 'already_fixed', 'no_op', 'duplicate'].includes(task.state)) return 'Result recorded';
  return 'No evidence yet';
}

export function taskNextAction(task: HubTask): string {
  if (task.state === 'plan') return 'Review plan';
  if (task.state === 'question' || task.state === 'blocked') return 'Resolve task';
  if (['done', 'cancelled', 'already_fixed', 'no_op', 'duplicate', 'superseded'].includes(task.state)) return 'View result';
  if (task.state === 'asked') return 'View delivery';
  return 'View progress';
}
