import React, { useEffect, useRef } from 'react';
import { Activity, AlertCircle, ExternalLink, Hexagon, Inbox, RefreshCw } from 'lucide-react';
import type { Approvals, HubProject, HubTask, HubView, ProjectMode, QuestionAnswer, QuestionBatch } from '../src/types';
import { ago, buildNeeds, homeTilde } from '../src/ui/look';
import { StretchText } from './Stretch';
import { ProjectCard } from './project';
import { NeedCard } from './needs';
import { BatchCard } from './questions';
import { AddProjectDialog } from './rows';
import { WorkTreeView } from './WorkTree';
import { NeedsHome } from './home';
import { TaskView, type CreatedTask } from './task';
import { routeUrl, type Route } from './routes';
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './components/ui/resizable';
import { ScrollArea } from './components/ui/scroll-area';
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel,
  SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider,
  SidebarSeparator, SidebarTrigger, useSidebar,
} from './components/ui/sidebar';
import { useMediaQuery } from './hooks/use-mobile';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';

type Busy = { project: string; what: string; who?: string } | null;

type DashboardProps = {
  view: HubView;
  route: Route;
  createdTask?: CreatedTask;
  busy: Busy;
  refreshing: boolean;
  refresh: () => Promise<void>;
  onNavigate: (route: Route) => void;
  onWake: (project: string) => void;
  onStartTask: (project: string, text: string) => Promise<boolean>;
  onSetMode: (project: string, mode: ProjectMode) => void;
  onSetApprovals: (project: string, approvals: Approvals) => void;
  onMessage: (project: string, text: string) => Promise<boolean>;
  onNudge: (project: string, taskId: string) => void;
  onReply: (project: string, taskId: string, text: string) => void;
  onAnswer: (project: string, agent: string | undefined, seen: string, choice: string, id: string) => void;
  onContinue: (project: string) => void;
  onPlanAnswer: (project: string, taskId: string, verdict: 'approve' | 'sendback', feedback?: string) => void;
  onResolve: (project: string, taskId: string, action: 'cancel' | 'rebrief', note?: string) => void;
  onInterrupt: (project: string, ref?: string) => void;
  onLogs: (project: string, ref?: string) => void;
  onBranches: (project: string) => void;
  onKill: (project: string) => void;
  onDelete: (project: string) => void;
  onAddProject: (name: string, folder: string, source: string) => Promise<boolean>;
  onArchive: (project: string, tasks: string[]) => Promise<boolean>;
  onQuestionAnswer: (batch: QuestionBatch, answers: QuestionAnswer[]) => void;
  onQuestionCancel: (batch: QuestionBatch) => Promise<boolean>;
};

function projectRouteName(route: Route): string | undefined {
  if (route.name === 'project' || route.name === 'task' || route.name === 'logs' || route.name === 'branches') return route.project;
  return undefined;
}

function ProjectNavigation({ view, route, sources, onNavigate, onAddProject }: {
  view: HubView;
  route: Route;
  sources: string[];
  onNavigate: (route: Route) => void;
  onAddProject: DashboardProps['onAddProject'];
}) {
  const { isMobile, openMobile, setOpenMobile } = useSidebar();
  const drawerWasOpen = useRef(false);
  const selectedProject = projectRouteName(route);
  useEffect(() => {
    const shouldRestore = drawerWasOpen.current && !openMobile;
    drawerWasOpen.current = openMobile;
    if (!shouldRestore) return;
    const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-sidebar="trigger"]')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [openMobile]);
  const go = (next: Route) => {
    onNavigate(next);
    if (isMobile) setOpenMobile(false);
  };
  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="border-b border-sidebar-border p-4">
        <a
          href={routeUrl({ name: 'home', filter: 'all' })}
          className="flex items-center gap-3 rounded-md focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            go({ name: 'home', filter: 'all' });
          }}
        >
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Hexagon className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="text-base font-semibold tracking-tight">hive</div>
            <div className="truncate font-mono text-xs text-muted-foreground" title={homeTilde(view.root, '')}>{homeTilde(view.root, '')}</div>
          </div>
        </a>
      </SidebarHeader>
      <SidebarContent className="px-3 py-4">
        <SidebarGroup className="p-0">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild isActive={route.name === 'home'} size="lg" className="min-h-10">
                  <a
                    href={routeUrl({ name: 'home', filter: 'all' })}
                    onClick={(event) => {
                      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                      event.preventDefault();
                      go({ name: 'home', filter: 'all' });
                    }}
                  >
                    <Inbox aria-hidden="true" />
                    <span>Needs you</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup className="mt-4 p-0">
          <SidebarGroupLabel className="h-7 px-2 text-[11px] font-semibold uppercase tracking-[0.14em]">Projects</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu data-testid="project-nav" className="gap-1">
              {view.projects.map((project) => {
                const next: Route = { name: 'project', project: project.name, tab: 'tasks' };
                return (
                  <SidebarMenuItem key={project.name}>
                    <SidebarMenuButton asChild size="lg" isActive={selectedProject === project.name} className="h-auto min-h-14 px-3 py-2.5">
                      <a
                        href={routeUrl(next)}
                        data-project-name={project.name}
                        onClick={(event) => {
                          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                          event.preventDefault();
                          go(next);
                        }}
                      >
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="truncate text-sm font-medium">{project.name}</span>
                          <span className="truncate text-xs font-normal text-muted-foreground">{`${project.agents.length} agents · ${project.open_tasks} open`}</span>
                        </span>
                      </a>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarSeparator className="mx-0" />
      <SidebarFooter className="shrink-0 bg-sidebar p-4">
        <AddProjectDialog sources={sources} onAddProject={onAddProject} />
      </SidebarFooter>
    </Sidebar>
  );
}

type ActivityActions = Pick<DashboardProps,
  'busy' | 'onAnswer' | 'onContinue' | 'onPlanAnswer' | 'onResolve' | 'onNudge' | 'onReply'
  | 'onQuestionAnswer' | 'onQuestionCancel' | 'onNavigate'
>;

function ActivityPanel({ view, project, now, refresh, actions }: {
  view: HubView;
  project?: HubProject;
  now: number;
  refresh: () => Promise<void>;
  actions: ActivityActions;
}) {
  const decisions = view.decisions.filter((decision) => !project || decision.project === project.name);
  const needs = project ? buildNeeds(view, now).filter((need) => need.project === project.name) : [];
  const questions = project ? view.questions.filter((batch) => batch.project === project.name) : [];
  const workTree = view.workTree && project ? {
    ...view.workTree,
    nodes: view.workTree.nodes.filter((node) => node.project === project.name),
  } : undefined;
  return (
    <div className="flex w-full min-w-0 max-w-full flex-col gap-4 p-4">
      {view.error !== '' && (
        <Alert variant="destructive" className="border-amber-500/40 bg-amber-500/5 text-amber-200">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>Refresh failed</AlertTitle>
          <AlertDescription className="break-words text-amber-100/80">
            <p>{view.error}</p>
            <p className="mt-1">{view.updatedAt ? `Showing data from ${new Date(view.updatedAt).toISOString().slice(11, 16)} UTC.` : 'No earlier data is available.'}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => void refresh()}><RefreshCw />Retry</Button>
          </AlertDescription>
        </Alert>
      )}
      {(needs.length > 0 || questions.length > 0) && (
        <section className="flex flex-col gap-3" aria-label="Needs you in this project">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-fuchsia-300">Needs you</h2>
          {needs.map((need) => {
            const taskRoute: Route | null = need.project && need.taskId ? { name: 'task', project: need.project, task: need.taskId } : null;
            return (
              <NeedCard
                key={need.key}
                need={need}
                view={view}
                busy={actions.busy}
                onAnswer={actions.onAnswer}
                onContinue={actions.onContinue}
                onPlanAnswer={actions.onPlanAnswer}
                onResolve={actions.onResolve}
                onNudge={actions.onNudge}
                onReply={actions.onReply}
                taskLink={taskRoute ? routeUrl(taskRoute) : undefined}
                onOpenTask={taskRoute ? () => actions.onNavigate(taskRoute) : undefined}
              />
            );
          })}
          {questions.map((batch) => (
            <BatchCard
              key={batch.id}
              batch={batch}
              onAnswer={actions.onQuestionAnswer}
              onCancel={actions.onQuestionCancel}
              batchLink={routeUrl({ name: 'questions', batch: batch.id })}
              onOpenBatch={() => actions.onNavigate({ name: 'questions', batch: batch.id })}
            />
          ))}
        </section>
      )}
      <section className="flex flex-col gap-3" aria-label="Recent activity">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Recent activity</h2>
        {decisions.length === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">No recent activity.</p>
        ) : decisions.map((decision, index) => (
          <Card key={`${decision.at}-${index}`} className="gap-3 py-4 shadow-none">
            <CardContent className="px-4">
              <div className="flex items-baseline gap-3">
                <div className="min-w-0 break-words text-sm font-semibold">{decision.task ?? decision.project}</div>
                <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground tabular">{ago(decision.at, now)}</span>
              </div>
              <StretchText text={decision.summary} pane={decision.task ?? decision.project} className="text-muted-foreground" />
            </CardContent>
          </Card>
        ))}
      </section>
      {workTree && workTree.nodes.length > 0 && <WorkTreeView tree={workTree} onChanged={refresh} />}
    </div>
  );
}

export function Dashboard(props: DashboardProps) {
  const {
    view, route, createdTask, busy, refreshing, refresh, onNavigate, onWake, onStartTask, onSetMode, onSetApprovals,
    onMessage, onNudge, onReply, onAnswer, onContinue, onPlanAnswer, onResolve, onInterrupt, onLogs, onBranches, onKill,
    onDelete, onAddProject, onArchive, onQuestionAnswer, onQuestionCancel,
  } = props;
  const selectedName = projectRouteName(route);
  const selected = view.projects.find((project) => project.name === selectedName);
  const task = route.name === 'task' ? view.tasks.find((candidate) => candidate.id === route.task && candidate.project === route.project) : undefined;
  const isStacked = useMediaQuery('(max-width: 1023px)');
  const isNarrow = useMediaQuery('(max-width: 899px)');
  const now = Date.now();
  const sources = [...new Set(view.projects.flatMap((project) =>
    project.repos.filter((repo) => repo.kind === 'repo' || repo.kind === 'worktree').map((repo) => repo.folder),
  ))];
  const updated = view.updatedAt ? new Date(view.updatedAt).toISOString().slice(11, 16) : 'never';
  const age = view.updatedAt ? ago(new Date(view.updatedAt).toISOString(), now) : 'never';
  const relativeAge = age === 'now' ? 'just now' : `${age} ago`;
  const fresh = view.updatedAt !== 0 && view.error === '' && now - view.updatedAt < 40_000;
  const syncText = view.error ? `Read failed · data synced ${relativeAge}` : fresh ? `Relay live · synced ${relativeAge}` : `Stale data · synced ${relativeAge}`;
  const title = route.name === 'home' ? 'Needs you'
    : route.name === 'task' ? route.task
      : selected?.name ?? 'Projects';

  const primaryContent = (
    <div className="min-w-0 p-4 md:p-6">
      {route.name === 'home' ? (
        <NeedsHome
          view={view}
          busy={busy}
          now={now}
          filter={route.filter}
          projectFilter={route.project}
          onFilter={(filter) => onNavigate({ name: 'home', filter, project: route.project })}
          onProjectFilter={(project) => onNavigate({ name: 'home', filter: route.filter, project })}
          onNavigate={onNavigate}
          onAnswer={onAnswer}
          onContinue={onContinue}
          onPlanAnswer={onPlanAnswer}
          onResolve={onResolve}
          onNudge={onNudge}
          onReply={onReply}
          onArchive={onArchive}
          onQuestionAnswer={onQuestionAnswer}
          onQuestionCancel={onQuestionCancel}
        />
      ) : selected ? (
        <ProjectCard
          project={selected}
          view={view}
          now={now}
          busy={busy}
          tab={route.name === 'project' ? route.tab : 'tasks'}
          onTabChange={(tab) => onNavigate({ name: 'project', project: selected.name, tab })}
          onOpenTask={(next: HubTask) => onNavigate({ name: 'task', project: next.project, task: next.id })}
          onWake={onWake}
          onStartTask={onStartTask}
          onSetMode={onSetMode}
          onSetApprovals={onSetApprovals}
          onMessage={onMessage}
          onNudge={onNudge}
          onInterrupt={onInterrupt}
          onLogs={onLogs}
          onBranches={onBranches}
          onKill={onKill}
          onDelete={onDelete}
        />
      ) : null}
    </div>
  );

  const main = route.name === 'task' ? (
    <ScrollArea className="h-full [&_[data-slot=scroll-area-viewport]>div]:!block [&_[data-slot=scroll-area-viewport]>div]:w-full">
      <TaskView
        task={task}
        created={createdTask?.id === route.task ? createdTask : undefined}
        view={view}
        busy={busy}
        now={now}
        refresh={refresh}
        onBack={() => onNavigate({ name: 'project', project: route.project, tab: 'tasks' })}
        onProject={() => onNavigate({ name: 'project', project: route.project, tab: 'tasks' })}
        onReplacement={(taskId) => onNavigate({ name: 'task', project: route.project, task: taskId })}
        onLogs={onLogs}
        onBranches={onBranches}
        onAnswer={onAnswer}
        onContinue={onContinue}
        onPlanAnswer={onPlanAnswer}
        onResolve={onResolve}
        onNudge={onNudge}
        onReply={onReply}
      />
    </ScrollArea>
  ) : route.name === 'project' && !selected ? (
    <div className="p-4 md:p-6">
      <Card><CardHeader><CardTitle>Project not found</CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground">Add the project in the sidebar or choose another project.</CardContent></Card>
    </div>
  ) : isNarrow ? (
    <Tabs key={routeUrl(route)} defaultValue="detail" className="h-full min-h-0" data-testid="mobile-workspace-tabs">
      <TabsList className="mx-4 mt-3 shrink-0" aria-label="Workspace sections">
        <TabsTrigger value="detail">{route.name === 'home' ? 'Queue' : 'Project'}</TabsTrigger>
        <TabsTrigger value="activity">Activity</TabsTrigger>
      </TabsList>
      <TabsContent value="detail" className="min-h-0">
        <ScrollArea data-testid="project-scroll" className="h-full [&_[data-slot=scroll-area-viewport]>div]:!block [&_[data-slot=scroll-area-viewport]>div]:w-full">
          {primaryContent}
        </ScrollArea>
      </TabsContent>
      <TabsContent value="activity" className="min-h-0">
        <ScrollArea data-testid="activity-scroll" className="h-full bg-muted/10 [&_[data-slot=scroll-area-viewport]>div]:!block [&_[data-slot=scroll-area-viewport]>div]:w-full">
          <ActivityPanel view={view} project={selected} now={now} refresh={refresh} actions={props} />
        </ScrollArea>
      </TabsContent>
    </Tabs>
  ) : (
    <ResizablePanelGroup orientation={isStacked ? 'vertical' : 'horizontal'}>
      <ResizablePanel defaultSize="66%" minSize={isStacked ? '35%' : 480} className="min-h-0 min-w-0">
        <ScrollArea data-testid="project-scroll" className="h-full [&_[data-slot=scroll-area-viewport]>div]:!block [&_[data-slot=scroll-area-viewport]>div]:w-full">
          {primaryContent}
        </ScrollArea>
      </ResizablePanel>
      <ResizableHandle withHandle data-testid="workspace-divider" className="bg-border/80 after:w-3 hover:bg-primary/50 aria-[orientation=horizontal]:after:h-3" />
      <ResizablePanel defaultSize="34%" minSize={isStacked ? '25%' : 360} className="min-h-0 min-w-0">
        <ScrollArea data-testid="activity-scroll" className="h-full bg-muted/10 [&_[data-slot=scroll-area-viewport]>div]:!block [&_[data-slot=scroll-area-viewport]>div]:w-full">
          <ActivityPanel view={view} project={selected} now={now} refresh={refresh} actions={props} />
        </ScrollArea>
      </ResizablePanel>
    </ResizablePanelGroup>
  );

  return (
    <SidebarProvider className="h-svh min-h-0 overflow-hidden" style={{ '--sidebar-width': '17rem' } as React.CSSProperties}>
      <ProjectNavigation view={view} route={route} sources={sources} onNavigate={onNavigate} onAddProject={onAddProject} />
      <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
        <header className="flex shrink-0 flex-wrap items-center gap-3 border-b bg-background px-4 py-3 sm:px-6">
          <SidebarTrigger className="size-9 shrink-0 max-sm:size-10" />
          <div className="min-w-28 flex-1"><h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1></div>
          <div className="ml-auto flex w-full flex-wrap items-center justify-between gap-2 sm:w-auto sm:justify-end">
            <Badge
              variant="outline"
              aria-label={fresh ? 'Live data' : 'Stale data'}
              className={fresh ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/40 bg-amber-500/10 text-amber-300'}
            >
              <Activity className="size-3" aria-hidden="true" />
              <span className="max-sm:hidden">{fresh ? 'Live' : view.error ? 'Read failed' : 'Stale data'}</span>
            </Badge>
            <span className="hidden font-mono text-xs text-muted-foreground tabular md:inline">{`${syncText} · Updated ${updated} UTC · 20 s polling`}</span>
            <Button asChild variant="ghost" size="sm" className="min-h-9 max-sm:min-h-10"><a href="/"><ExternalLink />Nexus</a></Button>
            <Button variant="outline" size="sm" className="min-h-9 max-sm:min-h-10" disabled={refreshing} onClick={() => void refresh()}>
              <RefreshCw className={refreshing ? 'animate-spin' : undefined} aria-hidden="true" />
              {refreshing ? 'Refreshing…' : 'refresh'}
            </Button>
            {view.questions.length > 0 && (
              <Button id="questions-open" size="sm" className="min-h-9 max-sm:min-h-10" onClick={() => onNavigate({ name: 'questions' })}>
                {`Questions ${view.questionsTotal ?? view.questions.length}`}
              </Button>
            )}
          </div>
        </header>
        <div className="sr-only" role="status" aria-live="polite">
          {refreshing ? 'Refreshing projects' : view.error ? 'Refresh failed. Showing earlier data.' : 'Projects up to date'}
        </div>
        {busy && <div className="shrink-0 border-b bg-sky-500/5 px-4 py-2 text-xs text-sky-300" role="status">{`${busy.what} · ${busy.project}`}</div>}
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{main}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
