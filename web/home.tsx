import React, { useState } from 'react';
import { Inbox } from 'lucide-react';
import type { HubView, QuestionAnswer, QuestionBatch } from '../src/types';
import { buildNeeds, STALE_MS, type Need } from '../src/ui/look';
import { NeedCard } from './needs';
import { BatchCard } from './questions';
import { NEED_FILTERS, routeUrl, type NeedFilter, type Route } from './routes';
import { Card, CardContent } from './components/ui/card';
import { Button } from './components/ui/button';
import { NativeSelect, NativeSelectOption } from './components/ui/native-select';
import { ToggleGroup, ToggleGroupItem } from './components/ui/toggle-group';

function included(need: Need, filter: NeedFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'fresh') return need.stale !== true;
  if (filter === 'plans') return need.action === 'plan';
  if (filter === 'questions') return need.color === 'yellow';
  if (filter === 'blocked') return need.action === 'resolve' && need.color === 'red';
  return need.stale === true;
}

export function NeedsHome({
  view, busy, now, filter, projectFilter, onFilter, onProjectFilter, onNavigate, onAnswer, onContinue,
  onPlanAnswer, onResolve, onNudge, onReply, onArchive, onQuestionAnswer, onQuestionCancel,
}: {
  view: HubView;
  busy: { project: string; what: string; who?: string } | null;
  now: number;
  filter: NeedFilter;
  projectFilter?: string;
  onFilter: (filter: NeedFilter) => void;
  onProjectFilter: (project?: string) => void;
  onNavigate: (route: Route) => void;
  onAnswer: Parameters<typeof NeedCard>[0]['onAnswer'];
  onContinue: (project: string) => void;
  onPlanAnswer: Parameters<typeof NeedCard>[0]['onPlanAnswer'];
  onResolve: Parameters<typeof NeedCard>[0]['onResolve'];
  onNudge: (project: string, taskId: string) => void;
  onReply: (project: string, taskId: string, text: string) => void;
  onArchive: (project: string, tasks: string[]) => Promise<boolean>;
  onQuestionAnswer: (batch: QuestionBatch, answers: QuestionAnswer[]) => void;
  onQuestionCancel: (batch: QuestionBatch) => Promise<boolean>;
}) {
  const [archiveArming, setArchiveArming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const allNeeds = buildNeeds(view, now).filter((need) => !projectFilter || need.project === projectFilter)
    .sort((left, right) => Number(Boolean(left.stale)) - Number(Boolean(right.stale)));
  const needs = allNeeds.filter((need) => included(need, filter));
  const batches = view.questions.filter((batch) => !projectFilter || batch.project === projectFilter);
  const freshBatches = batches.filter((batch) => now - Date.parse(batch.createdAt) <= STALE_MS);
  const staleBatches = batches.filter((batch) => now - Date.parse(batch.createdAt) > STALE_MS);
  const visibleBatches = filter === 'all' || filter === 'questions' ? batches
    : filter === 'fresh' ? freshBatches : filter === 'stale' ? staleBatches : [];
  const plans = allNeeds.filter((need) => need.action === 'plan').length;
  const stale = allNeeds.filter((need) => need.stale).length;
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5" data-testid="needs-home">
      <section className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold tracking-tight">Decision queue</h2>
        <p className="text-sm text-muted-foreground">Unblock agent work across every project. Open a task for its full outcome and evidence.</p>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span>{`${plans} plans`}</span>
          <span>{`${batches.length} question batches`}</span>
          <span>{`${allNeeds.filter((need) => need.action === 'resolve').length} blocked or waiting`}</span>
          <span>{`${stale} stale`}</span>
        </div>
      </section>
      <section className="flex flex-col gap-3" aria-label="Queue filters">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={filter}
          className="max-w-full flex-wrap"
          onValueChange={(value) => { if (value) onFilter(value as NeedFilter); }}
          aria-label="Filter needs"
        >
          {NEED_FILTERS.map((item) => (
            <ToggleGroupItem key={item} value={item} className="min-w-16 capitalize max-sm:min-h-10">{item}</ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="flex items-center gap-2">
          <label htmlFor="queue-project-filter" className="shrink-0 text-xs font-medium text-muted-foreground">Project</label>
          <div className="w-full max-w-xs [&_[data-slot=native-select-wrapper]]:w-full">
            <NativeSelect id="queue-project-filter" value={projectFilter ?? ''} onChange={(event) => onProjectFilter(event.target.value || undefined)}>
              <NativeSelectOption value="" className="bg-popover text-popover-foreground">All projects</NativeSelectOption>
              {view.projects.map((project) => (
                <NativeSelectOption key={project.name} value={project.name} className="bg-popover text-popover-foreground">{project.name}</NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        </div>
      </section>
      {filter === 'stale' && (stale > 0 || staleBatches.length > 0) && (
        <Card className="gap-3 py-4 shadow-none" data-testid="stale-cleanup">
          <CardContent className="px-4">
            <h2 className="text-sm font-semibold">Stale queue cleanup</h2>
            <p className="mt-1 text-sm text-muted-foreground">Archive only current stale owner decisions. Fresh work stays unchanged.</p>
            {!archiveArming ? (
              <Button className="mt-3" variant="outline" size="sm" onClick={() => setArchiveArming(true)}>Archive stale</Button>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={archiving}
                  onClick={() => {
                    void (async () => {
                      const byProject = new Map<string, string[]>();
                      for (const need of allNeeds) {
                        if (!need.stale || !need.project || !need.taskId) continue;
                        byProject.set(need.project, [...byProject.get(need.project) ?? [], need.taskId]);
                      }
                      setArchiving(true);
                      try {
                        let complete = true;
                        for (const [project, tasks] of byProject) complete = await onArchive(project, tasks) && complete;
                        for (const batch of staleBatches) complete = await onQuestionCancel(batch) && complete;
                        if (complete) setArchiveArming(false);
                      } finally {
                        setArchiving(false);
                      }
                    })();
                  }}
                >
                  {archiving ? 'Archiving…' : `Archive ${stale + staleBatches.length} stale ${stale + staleBatches.length === 1 ? 'item' : 'items'}?`}
                </Button>
                <Button variant="ghost" size="sm" disabled={archiving} onClick={() => setArchiveArming(false)}>Keep tasks</Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
      {needs.length === 0 && visibleBatches.length === 0 ? (
        <Card className="border-dashed py-8 text-center shadow-none" data-testid="empty-needs">
          <CardContent className="flex flex-col items-center gap-2 px-4">
            <Inbox className="size-5 text-muted-foreground" />
            <h2 className="text-base font-semibold">{view.projects.length === 0 ? 'No projects yet' : 'Nothing needs you'}</h2>
            <p className="text-sm text-muted-foreground">
              {view.projects.length === 0 ? 'Add a project in the sidebar to start work.' : view.updatedAt ? `Last successful refresh ${new Date(view.updatedAt).toISOString().slice(11, 16)} UTC.` : 'No successful refresh yet.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4" data-testid="needs-queue">
          {needs.map((need) => {
            const route: Route | null = need.project && need.taskId ? { name: 'task', project: need.project, task: need.taskId } : null;
            return (
              <NeedCard
                key={need.key}
                need={need}
                view={view}
                busy={busy}
                onAnswer={onAnswer}
                onContinue={onContinue}
                onPlanAnswer={onPlanAnswer}
                onResolve={onResolve}
                onNudge={onNudge}
                onReply={onReply}
                taskLink={route ? routeUrl(route) : undefined}
                onOpenTask={route ? () => onNavigate(route) : undefined}
              />
            );
          })}
          {visibleBatches.map((batch) => (
            <BatchCard
              key={batch.id}
              batch={batch}
              onAnswer={onQuestionAnswer}
              onCancel={onQuestionCancel}
              batchLink={routeUrl({ name: 'questions', batch: batch.id })}
              onOpenBatch={() => onNavigate({ name: 'questions', batch: batch.id })}
            />
          ))}
        </div>
      )}
    </div>
  );
}
