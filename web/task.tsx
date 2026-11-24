import React, { useMemo, useState } from 'react';
import { ArrowLeft, Braces, CheckCircle2, Clipboard, FileText, ScrollText } from 'lucide-react';
import type { HubTask, HubView } from '../src/types';
import { ago, buildNeeds, type Need } from '../src/ui/look';
import { NeedCard, PlanContractDetails } from './needs';
import { WorkTreeView } from './WorkTree';
import { taskBrief, taskEvidence, taskStep } from './task-utils';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card';
import { Separator } from './components/ui/separator';

export type CreatedTask = { id: string; project: string; brief: string; delivery: string; at: string };

export function TaskView({
  task, created, view, busy, now, refresh, onBack, onProject, onReplacement, onLogs, onBranches, onAnswer, onContinue,
  onPlanAnswer, onResolve, onNudge, onReply,
}: {
  task?: HubTask;
  created?: CreatedTask;
  view: HubView;
  busy: { project: string; what: string; who?: string } | null;
  now: number;
  refresh: () => Promise<void>;
  onBack: () => void;
  onProject: () => void;
  onReplacement: (taskId: string) => void;
  onLogs: (project: string, agent?: string) => void;
  onBranches: (project: string) => void;
  onAnswer: Parameters<typeof NeedCard>[0]['onAnswer'];
  onContinue: (project: string) => void;
  onPlanAnswer: Parameters<typeof NeedCard>[0]['onPlanAnswer'];
  onResolve: Parameters<typeof NeedCard>[0]['onResolve'];
  onNudge: (project: string, taskId: string) => void;
  onReply: (project: string, taskId: string, text: string) => void;
}) {
  const [copyNotice, setCopyNotice] = useState('');
  const id = task?.id ?? created?.id ?? '';
  const project = task?.project ?? created?.project ?? '';
  const needs = buildNeeds(view, now);
  const reviewNeed = needs.find((need) => need.taskId === id);
  const contractNeed = useMemo<Need | undefined>(() => {
    if (reviewNeed || !task?.contract) return undefined;
    return {
      key: `contract-${task.id}`, glyph: '▲', color: 'magenta', who: task.id, words: 'plan and root contract', when: '',
      project: task.project, taskId: task.id, detail: task.plan_text ?? task.last_note ?? task.contract.objective,
      checkpoints: task.checkpoints ?? [], contract: task.contract, planDigest: task.plan_digest,
    };
  }, [reviewNeed, task]);
  const timeline = useMemo(() => {
    if (!task) return [];
    const entries = [{ at: task.asked, label: 'Task created', detail: taskBrief(task) }];
    if (task.contract || (task.checkpoints?.length ?? 0) > 0) {
      entries.push({ at: task.updated, label: 'Plan recorded', detail: `${task.checkpoints?.length ?? 0} checkpoints` });
    }
    for (const [checkpoint, progress] of Object.entries(task.progress ?? {})) {
      entries.push({ at: progress.at, label: `Checkpoint ${checkpoint}`, detail: progress.note ?? progress.status });
    }
    for (const decision of task.decisions ?? []) entries.push({ at: decision.at, label: 'Decision', detail: decision.reason });
    return entries.sort((left, right) => right.at.localeCompare(left.at));
  }, [task]);

  if (!task && !created) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 md:p-6" data-testid="task-not-found">
        <Button variant="ghost" size="sm" className="w-fit" onClick={onBack}><ArrowLeft />Back</Button>
        <Card>
          <CardHeader><CardTitle>Task not found</CardTitle><CardDescription>{id}</CardDescription></CardHeader>
          <CardContent><Button onClick={onProject}>Open project</Button></CardContent>
        </Card>
      </div>
    );
  }

  const relatedNodes = view.workTree?.nodes.filter((node) => node.task === id) ?? [];
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 p-4 md:p-6" data-testid={`task-view-${id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft />Back</Button>
        <Button variant="ghost" size="sm" onClick={onProject}>{project}</Button>
        <span className="text-muted-foreground">/</span>
        <span className="font-mono text-xs text-muted-foreground">{id}</span>
      </div>
      <Card className="gap-0 py-0">
        <CardHeader className="border-b px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <Badge variant={task?.state === 'done' ? 'outline' : 'secondary'}>{task?.state ?? 'asked'}</Badge>
                {created && <Badge variant="outline" className="border-sky-500/40 text-sky-300">New task</Badge>}
              </div>
              <CardTitle className="font-mono text-xl">{id}</CardTitle>
              <CardDescription className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground">
                {task ? taskBrief(task) : created!.brief}
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (!navigator.clipboard) {
                  setCopyNotice('Copy the URL from the address bar');
                  return;
                }
                void navigator.clipboard.writeText(window.location.href).then(
                  () => setCopyNotice('Link copied'),
                  () => setCopyNotice('Copy the URL from the address bar'),
                );
              }}
            >
              <Clipboard />Copy link
            </Button>
          </div>
          <span role="status" className="text-xs text-muted-foreground">{copyNotice}</span>
        </CardHeader>
        <CardContent className="px-4 py-4 sm:px-5">
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-sm text-muted-foreground">Project</dt><dd className="mt-1 font-medium">{project}</dd></div>
            <div><dt className="text-sm text-muted-foreground">Current step</dt><dd className="mt-1 font-medium">{task ? taskStep(task) : 'Waiting for task registration'}</dd></div>
            <div><dt className="text-sm text-muted-foreground">Last activity</dt><dd className="mt-1 font-medium">{task ? ago(task.updated, now) : 'now'}</dd></div>
            <div><dt className="text-sm text-muted-foreground">Evidence</dt><dd className="mt-1 font-medium">{task ? taskEvidence(task, view) : 'No evidence yet'}</dd></div>
          </dl>
          {created && (
            <div className="mt-4 rounded-md border border-sky-500/30 bg-sky-500/5 p-3 text-sm" data-testid="task-delivery-state">
              <div className="font-medium text-sky-300">Delivery state</div>
              <div className="mt-1 text-muted-foreground">{created.delivery}</div>
              <div className="mt-1 text-xs text-muted-foreground">Next expected event: orchestrator progress or an owner question.</div>
            </div>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => onLogs(project)}><ScrollText />Orchestrator logs</Button>
            <Button variant="outline" size="sm" onClick={() => onBranches(project)}><Braces />Branches</Button>
          </div>
        </CardContent>
      </Card>

      {reviewNeed && (
        <NeedCard
          need={reviewNeed}
          view={view}
          busy={busy}
          onAnswer={onAnswer}
          onContinue={onContinue}
          onPlanAnswer={onPlanAnswer}
          onResolve={onResolve}
          onNudge={onNudge}
          onReply={onReply}
        />
      )}
      {task?.superseded_by && (
        <Card className="border-amber-500/40 bg-amber-500/5 py-4 shadow-none" data-testid="superseded-task">
          <CardContent className="flex flex-wrap items-center gap-3 px-4">
            <span className="text-sm text-amber-200">{`Superseded by ${task.superseded_by}. Approval is closed.`}</span>
            <Button size="sm" onClick={() => onReplacement(task.superseded_by!)}>Open replacement</Button>
          </CardContent>
        </Card>
      )}
      {contractNeed && <PlanContractDetails need={contractNeed} />}

      {relatedNodes.length > 0 && view.workTree && (
        <WorkTreeView tree={{ ...view.workTree, nodes: relatedNodes }} onChanged={refresh} />
      )}

      <section className="flex flex-col gap-3" aria-label="Task activity">
        <div className="flex items-center gap-2">
          <FileText className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Activity</h2>
        </div>
        <Separator />
        {timeline.length === 0 ? (
          <p className="text-sm text-muted-foreground">Waiting for the first task event.</p>
        ) : (
          <ol className="flex flex-col gap-3">
            {timeline.map((entry, index) => (
              <li key={`${entry.at}-${entry.label}-${index}`} className="flex gap-3">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-sm font-medium">{entry.label}</span>
                    <time className="font-mono text-sm text-muted-foreground" dateTime={entry.at}>{ago(entry.at, now)}</time>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">{entry.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
