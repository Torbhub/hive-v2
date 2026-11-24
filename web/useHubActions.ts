import { useCallback } from 'react';
import type { Approvals, ProjectMode, QuestionAnswer, QuestionBatch } from '../src/types';
import { orchestratorName } from '../src/ui/look';
import type { Route } from './routes';
import type { CreatedTask } from './task';
import { apiPath } from './api';

export type HubAction = (
  id: string,
  project: string,
  what: 'resuming' | 'continuing' | 'starting' | 'answering' | 'adding' | 'messaging' | 'resolving' | 'nudging' | 'interrupting' | 'killing' | 'deleting',
  who: string,
  runAction: () => Promise<string>,
  busyWho?: string,
) => Promise<boolean>;

async function post(pathname: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(apiPath(pathname), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as { ok?: boolean; detail?: string } & Record<string, unknown>;
  if (!response.ok || result.ok === false) throw new Error(result.detail ?? `HTTP ${response.status}`);
  return result;
}

export function useHubActions({ act, navigate, onCreatedTask }: {
  act: HubAction;
  navigate: (route: Route) => void;
  onCreatedTask: (task: CreatedTask) => void;
}) {
  const onWake = useCallback((project: string) => {
    void act(`wake-${project}`, project, 'resuming', project, async () => {
      const result = await post('api/wake', { project });
      return `${project}: ${typeof result.name === 'string' ? result.name : orchestratorName(project)} is coming up; it reports back when its team is up`;
    });
  }, [act]);

  const onContinue = useCallback((project: string) => {
    void act(`continue-${project}`, project, 'continuing', project, async () => {
      const result = await post('api/continue', { project });
      return `${project}: ${typeof result.name === 'string' ? result.name : orchestratorName(project)}'s first line was sent`;
    });
  }, [act]);

  const onAnswer = useCallback((project: string, agentRefArg: string | undefined, seen: string, choice: string, id: string) => {
    const who = agentRefArg ? `${project} · ${agentRefArg}` : project;
    void act(id, project, 'answering', who, async () => {
      const result = await post('api/answer', { project, agent: agentRefArg, choice, fingerprint: seen });
      return `${who}: answered "${result.option}"${result.dialog_gone ? '' : ' (the dialog is still on its screen)'}`;
    }, agentRefArg);
  }, [act]);

  const onStartTask = useCallback(async (project: string, text: string): Promise<boolean> => {
    let created: CreatedTask | undefined;
    const started = await act(`start-${project}`, project, 'starting', project, async () => {
      const task = await post('api/task', { project, text });
      const result = await post('api/start', { project, task: task.id });
      created = {
        id: String(task.id), project, brief: text, at: new Date().toISOString(),
        delivery: result.typed ? 'The running orchestrator received the task.' : 'The orchestrator launch was requested.',
      };
      if (result.typed) return `${project}: ${task.id} was sent to ${typeof result.name === 'string' ? result.name : orchestratorName(project)}`;
      return `${project}: ${typeof result.name === 'string' ? result.name : orchestratorName(project)} is coming up on ${task.id}; it reports back when its team is up`;
    });
    if (started && created) {
      onCreatedTask(created);
      navigate({ name: 'task', project, task: created.id });
    }
    return started;
  }, [act, navigate, onCreatedTask]);

  const onSetMode = useCallback((project: string, mode: ProjectMode) => {
    void act(`mode-${project}-${mode}`, project, 'answering', project, async () => {
      await post('api/mode', { project, mode });
      return `${project}: permission mode is ${mode} (applies to the next launch)`;
    });
  }, [act]);

  const onSetApprovals = useCallback((project: string, approvals: Approvals) => {
    void act(`approvals-${project}-${approvals}`, project, 'answering', project, async () => {
      await post('api/approvals', { project, approvals });
      return `${project}: approvals are ${approvals}`;
    });
  }, [act]);

  const onPlanAnswer = useCallback((project: string, taskId: string, verdict: 'approve' | 'sendback', feedback?: string) => {
    void act(`plan-${taskId}-${verdict}`, project, 'answering', taskId, async () => {
      await post('api/plan-answer', { project, task: taskId, verdict, feedback });
      return `${taskId}: plan ${verdict === 'approve' ? 'approved' : 'sent back'}`;
    }, taskId);
  }, [act]);

  const onResolve = useCallback((project: string, taskId: string, action: 'cancel' | 'rebrief', note?: string) => {
    void act(`resolve-${taskId}-${action}`, project, 'resolving', taskId, async () => {
      await post('api/task-resolve', { project, task: taskId, action, note });
      return `${taskId}: ${action === 'cancel' ? 'cancelled' : 'back to asked with the new brief'}`;
    }, taskId);
  }, [act]);

  const onNudge = useCallback((project: string, taskId: string) => {
    void act(`nudge-${taskId}`, project, 'nudging', taskId, async () => {
      await post('api/message', { project, text: `${taskId}: owner asks for status` });
      return `${taskId}: the orchestrator was asked for status`;
    });
  }, [act]);

  const onMessage = useCallback(async (project: string, text: string): Promise<boolean> => {
    return act(`message-${project}`, project, 'messaging', project, async () => {
      await post('api/message', { project, text });
      return `${project}: the message was typed to its orchestrator`;
    });
  }, [act]);

  const onReply = useCallback((project: string, taskId: string, text: string) => {
    void act(`reply-${taskId}`, project, 'answering', taskId, async () => {
      await post('api/message', { project, text: `${taskId}: ${text}` });
      return `${taskId}: answer sent to the orchestrator`;
    }, taskId);
  }, [act]);

  const onInterrupt = useCallback((project: string, ref?: string) => {
    const who = ref ? `${project} · ${ref}` : project;
    void act(`interrupt-${who}`, project, 'interrupting', who, async () => {
      const result = await post('api/interrupt', { project, agent: ref });
      return `interrupted ${String(result.target)}`;
    }, ref);
  }, [act]);

  const onKill = useCallback((project: string) => {
    void act(`kill-${project}`, project, 'killing', project, async () => {
      const result = await post('api/kill', { project });
      return String(result.summary);
    });
  }, [act]);

  const onDelete = useCallback((project: string) => {
    void act(`delete-${project}`, project, 'deleting', project, async () => {
      await post('api/project-delete', { project });
      return `${project}: project deleted`;
    }).then((deleted) => {
      if (deleted) navigate({ name: 'home', filter: 'all' });
    });
  }, [act, navigate]);

  const onAddProject = useCallback(async (name: string, folder: string, source: string): Promise<boolean> => {
    const added = await act('add-project', name, 'adding', name, async () => {
      const body = folder ? { name, path: folder } : { name, path: '', source };
      const result = await post('api/project', body);
      return `${name}: project added (${String(result.home)})`;
    });
    if (added) navigate({ name: 'project', project: name, tab: 'tasks' });
    return added;
  }, [act, navigate]);

  const onArchive = useCallback(async (project: string, tasks: string[]): Promise<boolean> => {
    return act(`archive-${project}`, project, 'resolving', project, async () => {
      await post('api/tasks-archive', { project, tasks });
      return `${project}: archived ${tasks.length} stale owner decisions`;
    });
  }, [act]);

  const onLogs = useCallback((project: string, agent?: string) => navigate({ name: 'logs', project, agent }), [navigate]);
  const onBranches = useCallback((project: string) => navigate({ name: 'branches', project }), [navigate]);

  const onQuestionAnswer = useCallback((batch: QuestionBatch, answers: QuestionAnswer[]) => {
    const who = `${batch.project} · ${batch.agent}`;
    void act(`question-answer-${batch.id}`, batch.project, 'answering', who, async () => {
      await post('api/questions/answer', { id: batch.id, answers });
      return `${batch.project}: question batch answered`;
    });
  }, [act]);

  const onQuestionCancel = useCallback(async (batch: QuestionBatch) => {
    const who = `${batch.project} · ${batch.agent}`;
    return act(`question-cancel-${batch.id}`, batch.project, 'answering', who, async () => {
      await post('api/questions/cancel', { id: batch.id });
      return `${batch.project}: question batch cancelled`;
    });
  }, [act]);

  return {
    onWake, onContinue, onAnswer, onStartTask, onSetMode, onSetApprovals, onPlanAnswer, onResolve, onNudge,
    onMessage, onReply, onInterrupt, onKill, onDelete, onAddProject, onArchive, onLogs, onBranches, onQuestionAnswer, onQuestionCancel,
  };
}
