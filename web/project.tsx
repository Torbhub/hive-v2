import React, { useContext, useState } from 'react';
import { ListTodo, Plus } from 'lucide-react';
import type { Approvals, HubProject, HubTask, HubView, ProjectMode } from '../src/types';
import { APPROVALS_MODES, CLOSED_STATES, PROJECT_MODES } from '../src/types';
import {
  agentGlyph, agentRef, ago, orchestratorLook, ROTATE_AT_PERCENT, taskProgress, tasksLine, windowLabel,
} from '../src/ui/look';
import { cn } from './lib/utils';
import { ActionContext, Btn } from './action';
import { KillControl } from './kill';
import { DeleteProjectControl } from './delete';
import { ProgressRow } from './needs';
import { MessageRow, NewTaskRow } from './rows';
import { routeUrl, PROJECT_TABS, type ProjectTab } from './routes';
import { taskBrief, taskEvidence, taskNextAction, taskStep } from './task-utils';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card';
import { Input } from './components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from './components/ui/toggle-group';
import { TeamMap } from './TeamMap';

export function StatusDot({ color, className }: { color: string; className?: string }) {
  const cls = { green: 'bg-emerald-500', yellow: 'bg-amber-400', red: 'bg-red-500', gray: 'bg-zinc-600', cyan: 'bg-sky-400', magenta: 'bg-fuchsia-400' }[color] ?? 'bg-zinc-600';
  return <span className={cn('inline-block h-2 w-2 rounded-full shrink-0', cls, className)} />;
}

function taskAgent(task: HubTask): string {
  return task.receipt_actor ?? task.admissions?.at(-1)?.agent ?? 'No agent recorded';
}

function TaskInventory({
  project, view, now, busy, onNudge, onOpenTask,
}: {
  project: HubProject;
  view: HubView;
  now: number;
  busy: { project: string; what: string; who?: string } | null;
  onNudge: (project: string, taskId: string) => void;
  onOpenTask: (task: HubTask) => void;
}) {
  const [query, setQuery] = useState('');
  const tasks = view.tasks.filter((task) => task.project === project.name)
    .filter((task) => `${task.id} ${taskBrief(task)} ${task.state} ${taskAgent(task)}`.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((left, right) => right.updated.localeCompare(left.updated));
  const total = view.tasks.filter((task) => task.project === project.name).length;
  if (total === 0) {
    return (
      <div className="flex items-center gap-3 rounded-md border border-dashed p-4 text-sm text-muted-foreground" data-testid="empty-tasks">
        <ListTodo className="size-4" />
        No tasks yet. Use New task to start work.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <Input value={query} aria-label={`Search tasks for ${project.name}`} placeholder="Search tasks, states, or agents" onChange={(event) => setQuery(event.target.value)} />
      <span className="text-sm text-muted-foreground">{`Showing ${tasks.length} of ${total} recorded tasks`}</span>
      {tasks.length === 0 ? (
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          No tasks match this search. <Button variant="ghost" size="sm" onClick={() => setQuery('')}>Clear search</Button>
        </div>
      ) : (
    <div className="overflow-hidden rounded-md border" data-testid="task-inventory">
      <div className="hidden grid-cols-[minmax(0,2fr)_minmax(6rem,0.7fr)_minmax(0,1.4fr)_minmax(5rem,0.6fr)] gap-3 border-b bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground md:grid">
        <span>Task and brief</span><span>State</span><span>Current step and evidence</span><span>Next action</span>
      </div>
      <div className="divide-y">
        {tasks.map((task) => {
          const progress = taskProgress(task);
          const age = ago(task.updated, now);
          const showProgress = project.orchestrator.state !== 'none' && !CLOSED_STATES.has(task.state) && !task.needs_owner && progress;
          return (
            <a
              key={task.id}
              href={routeUrl({ name: 'task', project: project.name, task: task.id })}
              data-task-id={task.id}
              className="grid gap-3 px-3 py-3 transition-colors hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring md:grid-cols-[minmax(0,2fr)_minmax(6rem,0.7fr)_minmax(0,1.4fr)_minmax(5rem,0.6fr)] md:items-center"
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                onOpenTask(task);
              }}
            >
              <span className="min-w-0">
                <span className="block font-mono text-xs font-semibold text-foreground">{task.id}</span>
                <span className="mt-1 block break-words text-sm text-muted-foreground">{taskBrief(task)}</span>
                {task.superseded_by && <span className="mt-1 block text-xs text-amber-300">{`Superseded by ${task.superseded_by}`}</span>}
                <span className="mt-1 block text-sm text-muted-foreground">{`${taskAgent(task)} · ${age === 'now' ? 'now' : `${age} ago`}`}</span>
                <span className="mt-1 block font-mono text-sm text-muted-foreground">{`Updated ${new Date(task.updated).toISOString().slice(0, 16).replace('T', ' ')} UTC`}</span>
              </span>
              <Badge variant="outline" className="w-fit">{task.state}</Badge>
              <span className="min-w-0 text-sm text-muted-foreground">
                {showProgress ? (
                  <ProgressRow task={task} now={now} busy={busy} onNudge={onNudge} />
                ) : (
                  <span className="block">{project.orchestrator.state === 'none' ? 'Progress unavailable without a team' : taskStep(task)}</span>
                )}
                <span className="mt-1 block">{taskEvidence(task, view)}</span>
              </span>
              <span className="text-sm font-medium text-sky-300">{taskNextAction(task)}</span>
            </a>
          );
        })}
      </div>
    </div>
      )}
    </div>
  );
}

function AgentSummary({ project, onLogs, onBranches, onInterrupt }: {
  project: HubProject;
  onLogs: (project: string, agent?: string) => void;
  onBranches: (project: string) => void;
  onInterrupt: (project: string, agent?: string) => void;
}) {
  const orchestrator = project.orchestrator;
  return (
    <section className="flex flex-col gap-3 rounded-md border p-3" aria-label="Agent summary">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusDot color={orchestratorLook(orchestrator).color} />
        <span className="font-medium">{orchestrator.state === 'none' ? 'none yet' : orchestrator.name ?? `${project.name}-orchestrator`}</span>
        <span className="text-xs text-muted-foreground">{orchestrator.state}</span>
        {orchestrator.session_id && (
          <span className="ml-auto flex flex-wrap gap-2">
            <Btn id={`logs-${project.name}`} onPress={() => onLogs(project.name)}>Logs</Btn>
            <Btn id={`branches-${project.name}`} onPress={() => onBranches(project.name)}>Branches</Btn>
          </span>
        )}
      </div>
      {project.agents.map((agent) => (
        <div key={agent.ref ?? agent.name} className="flex flex-wrap items-center gap-2 border-t pt-3 text-sm">
          <StatusDot color={agentGlyph(agent).color} />
          <span className="font-medium">{agentRef(agent)}</span>
          <span className="text-xs text-muted-foreground">{agent.state}</span>
          <span className="ml-auto flex flex-wrap gap-2">
            {agent.state === 'running' && (
              <Btn id={`interrupt-${project.name}-${agentRef(agent)}`} onPress={() => onInterrupt(project.name, agentRef(agent))}>
                {`Interrupt ${agentRef(agent)}`}
              </Btn>
            )}
            {agent.state === 'running' && agent.session_id && (
              <Btn id={`logs-${project.name}-${agentRef(agent)}`} onPress={() => onLogs(project.name, agentRef(agent))}>
                {`Logs ${agentRef(agent)}`}
              </Btn>
            )}
          </span>
        </div>
      ))}
    </section>
  );
}

function TeamPanel({ project, onLogs, onBranches, onInterrupt, onKill }: {
  project: HubProject;
  onLogs: (project: string, agent?: string) => void;
  onBranches: (project: string) => void;
  onInterrupt: (project: string, agent?: string) => void;
  onKill: (project: string) => void;
}) {
  const orchestrator = project.orchestrator;
  const [copyNotice, setCopyNotice] = useState('');
  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{orchestrator.name ?? 'none yet'}</span>
        {orchestrator.name && <span className="font-mono text-xs text-muted-foreground">{windowLabel(project.name, orchestrator.name)}</span>}
        {typeof orchestrator.context === 'number' && (
          <span className={orchestrator.context_assumed ? 'text-muted-foreground' : orchestrator.context >= ROTATE_AT_PERCENT ? 'text-amber-300' : 'text-muted-foreground'}>
            {`${orchestrator.context}% context`}
          </span>
        )}
        {orchestrator.context_unknown && <span className="text-muted-foreground">context unknown</span>}
        {orchestrator.state === 'running' && <Btn id={`interrupt-${project.name}`} onPress={() => onInterrupt(project.name)}>Interrupt</Btn>}
        {orchestrator.session_id && <Btn id={`team-logs-${project.name}`} onPress={() => onLogs(project.name)}>Logs</Btn>}
        {orchestrator.session_id && <Btn id={`team-branches-${project.name}`} onPress={() => onBranches(project.name)}>Branches</Btn>}
        {orchestrator.state === 'running' && <KillControl project={project.name} children={orchestrator.children ?? 0} onKill={onKill} />}
      </section>
      {orchestrator.state === 'unknown' && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm" role="alert">
          <p className="text-amber-200">Orchestrator state unknown — Hive could not verify the tmux or relay state.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Btn id={`unknown-logs-${project.name}`} onPress={() => onLogs(project.name)}>Check Logs</Btn>
            <Btn
              id={`copy-attach-${project.name}`}
              onPress={() => {
                const command = 'tmux -L hive-v2 attach';
                if (navigator.clipboard) void navigator.clipboard.writeText(command);
                setCopyNotice(navigator.clipboard ? 'Attach command copied' : command);
              }}
            >
              Copy tmux attach
            </Btn>
          </div>
          <span role="status" className="mt-2 block text-xs text-muted-foreground">{copyNotice}</span>
        </div>
      )}
      <div className="break-words font-mono text-xs text-muted-foreground">
        {project.agents.map((agent) => windowLabel(project.name, agent.name)).join(', ') || 'No agent windows recorded.'}
      </div>
      {(orchestrator.state !== 'none' || project.agents.length > 0) && <TeamMap project={project} onOpenAgent={onLogs} />}
      <section className="flex flex-col gap-1">
        <h3 className="text-xs font-medium text-muted-foreground">Folders</h3>
        {project.repos.map((repo) => (
          <div key={repo.folder} className="truncate font-mono text-xs" title={repo.folder}>
            {`${repo.folder}${repo.changed ? `  ${repo.changed} changed` : ''}`}
          </div>
        ))}
      </section>
      <div className="break-words border-t pt-3 font-mono text-xs text-muted-foreground">
        {orchestrator.state === 'running' && orchestrator.pane && orchestrator.name ? `attach: hive attach ${project.name}` : 'attach: tmux -L hive-v2 attach'}
      </div>
    </div>
  );
}

const MODE_HELP: Record<ProjectMode, string> = {
  ask: 'Ask before each action. Applies to the next launch.',
  yolo: 'Allow all actions. Applies to the next launch.',
  auto: 'Use managed automatic permissions. Applies to the next launch.',
};
const APPROVAL_HELP: Record<Approvals, string> = {
  manual: 'The operator answers approval prompts.',
  safe: 'Allow deterministic read-only commands.',
  smart: 'Use safe rules and classifier review for other commands.',
};

export function ProjectCard({
  project, view, now, busy, tab, onTabChange, onOpenTask, onWake, onStartTask, onSetMode, onSetApprovals, onMessage, onNudge, onInterrupt, onLogs, onBranches, onKill, onDelete,
}: {
  project: HubProject;
  view: HubView;
  now: number;
  busy: { project: string; what: string; who?: string } | null;
  tab: ProjectTab;
  onTabChange: (tab: ProjectTab) => void;
  onOpenTask: (task: HubTask) => void;
  onWake: (project: string) => void;
  onStartTask: (project: string, text: string) => Promise<boolean>;
  onSetMode: (project: string, mode: ProjectMode) => void;
  onSetApprovals: (project: string, approvals: Approvals) => void;
  onMessage: (project: string, text: string) => Promise<boolean>;
  onNudge: (project: string, taskId: string) => void;
  onInterrupt: (project: string, ref?: string) => void;
  onLogs: (project: string, ref?: string) => void;
  onBranches: (project: string) => void;
  onKill: (project: string) => void;
  onDelete: (project: string) => void;
}) {
  const { acting } = useContext(ActionContext);
  const look = orchestratorLook(project.orchestrator);
  const orchestrator = project.orchestrator;
  const running = project.agents.filter((agent) => agent.state === 'running').length;
  const canResume = (orchestrator.state === 'stopped' || orchestrator.state === 'resumable')
    && Boolean(orchestrator.session_id) && !orchestrator.starting;
  const canDelete = orchestrator.state === 'none' && project.agents.length === 0 && !orchestrator.starting;
  const back = 1 + project.agents.filter((agent) => agent.state === 'stopped').length;
  const resuming = busy?.project === project.name && busy.what === 'resuming';
  const canMessage = orchestrator.state === 'running' && Boolean(orchestrator.pane);
  const mode = project.mode ?? 'ask';
  const approvals = project.approvals ?? 'manual';

  return (
    <Card data-testid={`project-card-${project.name}`} className="min-w-0 gap-0 overflow-visible py-0">
      <CardHeader className="border-b px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-xl tracking-tight">
              <StatusDot color={look.color} /><span className="truncate">{project.name}</span>
            </CardTitle>
            <CardDescription className="mt-1.5 text-xs">
              {`${look.word} · ${running} of ${project.agents.length} agents running · ${tasksLine(view.tasks, project.name, project.open_tasks, now)}`}
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            {canResume && (
              resuming ? <span className="text-xs text-sky-400">resuming…</span> : (
                <Btn id={`wake-${project.name}`} onPress={() => onWake(project.name)}>
                  {`Resume · ${back} session${back === 1 ? '' : 's'}`}
                </Btn>
              )
            )}
            <Button
              id={`new-task-${project.name}`}
              size="sm"
              className="max-sm:min-h-10"
              onClick={() => {
                onTabChange('tasks');
                requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`input[aria-label="new task for ${project.name}"]`)?.focus());
              }}
            >
              <Plus />New task
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-4 py-4 sm:px-5 sm:py-5">
        <Tabs value={tab} onValueChange={(value) => onTabChange(value as ProjectTab)}>
          <TabsList className="h-auto w-full flex-wrap justify-start" aria-label={`${project.name} project sections`}>
            {PROJECT_TABS.map((item) => <TabsTrigger key={item} value={item} className="min-h-9 flex-none capitalize max-sm:min-h-10">{item}</TabsTrigger>)}
          </TabsList>
          <TabsContent value="tasks" className="mt-5 flex flex-col gap-5">
            <section aria-label="New task">
              <h2 className="mb-3 text-sm font-semibold">New task</h2>
              <NewTaskRow project={project.name} busy={busy} onStartTask={onStartTask} mode={mode} approvals={approvals} />
            </section>
            <section aria-label="Task inventory">
              <h2 className="mb-3 text-sm font-semibold">Tasks</h2>
              <TaskInventory project={project} view={view} now={now} busy={busy} onNudge={onNudge} onOpenTask={onOpenTask} />
            </section>
            <AgentSummary project={project} onLogs={onLogs} onBranches={onBranches} onInterrupt={onInterrupt} />
          </TabsContent>
          <TabsContent value="activity" className="mt-5 flex flex-col gap-4">
            <section>
              <h2 className="mb-3 text-sm font-semibold">Message orchestrator</h2>
              <MessageRow project={project.name} busy={busy} onMessage={onMessage} disabled={!canMessage} />
              {!canMessage && <p className="mt-2 text-xs text-muted-foreground">Start or resume the orchestrator to send a message.</p>}
            </section>
          </TabsContent>
          <TabsContent value="team" className="mt-5">
            <TeamPanel project={project} onLogs={onLogs} onBranches={onBranches} onInterrupt={onInterrupt} onKill={onKill} />
          </TabsContent>
          <TabsContent value="settings" className="mt-5 flex flex-col gap-5">
            <section>
              <h2 className="text-sm font-semibold">Agent permissions</h2>
              <p className="mt-1 text-xs text-muted-foreground">{MODE_HELP[mode]}</p>
              <ToggleGroup
                type="single" variant="outline" size="sm" className="mt-3 max-w-full flex-wrap" value={mode} disabled={acting}
                onValueChange={(value) => { if (value) onSetMode(project.name, value as ProjectMode); }}
                aria-label={`Agent permissions for ${project.name}`}
              >
                {PROJECT_MODES.map((item) => <ToggleGroupItem key={item} value={item} className="min-w-16 max-sm:min-h-10">{item}</ToggleGroupItem>)}
              </ToggleGroup>
            </section>
            <section>
              <h2 className="text-sm font-semibold">Approval policy</h2>
              <p className="mt-1 text-xs text-muted-foreground">{APPROVAL_HELP[approvals]}</p>
              <ToggleGroup
                type="single" variant="outline" size="sm" className="mt-3 max-w-full flex-wrap" value={approvals} disabled={acting}
                onValueChange={(value) => { if (value) onSetApprovals(project.name, value as Approvals); }}
                aria-label={`Approval policy for ${project.name}`}
              >
                {APPROVALS_MODES.map((item) => <ToggleGroupItem key={item} value={item} className="min-w-16 max-sm:min-h-10">{item}</ToggleGroupItem>)}
              </ToggleGroup>
            </section>
            {canDelete && (
              <section className="border-t pt-4">
                <h2 className="mb-3 text-sm font-semibold">Project registration</h2>
                <DeleteProjectControl project={project.name} busy={busy?.project === project.name && busy.what === 'deleting'} onDelete={onDelete} />
              </section>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
