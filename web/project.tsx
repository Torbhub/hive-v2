import React, { useContext } from 'react';
import type { Approvals, HubProject, HubView, ProjectMode } from '../src/types';
import { APPROVALS_MODES, CLOSED_STATES, PROJECT_MODES } from '../src/types';
import {
  agentGlyph, agentRef, orchestratorLook, ROTATE_AT_PERCENT, taskProgress, tasksLine, windowLabel,
} from '../src/ui/look';
import { cn } from './lib/utils';
import { ActionContext, Btn } from './action';
import { KillControl } from './kill';
import { DeleteProjectControl } from './delete';
import { ProgressRow } from './needs';
import { MessageRow, NewTaskRow } from './rows';
import { Card, CardContent, CardHeader } from './components/ui/card';
import { ToggleGroup, ToggleGroupItem } from './components/ui/toggle-group';

export function StatusDot({ color, className }: { color: string; className?: string }) {
  const cls = { green: 'bg-emerald-500', yellow: 'bg-amber-400', red: 'bg-red-500', gray: 'bg-zinc-600', cyan: 'bg-sky-400', magenta: 'bg-fuchsia-400' }[color] ?? 'bg-zinc-600';
  return <span className={cn('inline-block h-2 w-2 rounded-full shrink-0', cls, className)} />;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 text-sm">
      <span className="w-24 shrink-0 text-zinc-500">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

export function ProjectCard({
  project: p, view, now, busy, onWake, onStartTask, onSetMode, onSetApprovals, onMessage, onNudge, onInterrupt, onLogs, onKill, onDelete,
}: {
  project: HubProject;
  view: HubView;
  now: number;
  busy: { project: string; what: string; who?: string } | null;
  onWake: (project: string) => void;
  onStartTask: (project: string, text: string) => Promise<boolean>;
  onSetMode: (project: string, mode: ProjectMode) => void;
  onSetApprovals: (project: string, approvals: Approvals) => void;
  onMessage: (project: string, text: string) => Promise<boolean>;
  onNudge: (project: string, taskId: string) => void;
  onInterrupt: (project: string, ref?: string) => void;
  onLogs: (project: string, ref?: string) => void;
  onKill: (project: string) => void;
  onDelete: (project: string) => void;
}) {
  const { acting } = useContext(ActionContext);
  const look = orchestratorLook(p.orchestrator);
  const o = p.orchestrator;
  const orchName = o.state === 'none' ? 'none yet' : o.name ?? '?';
  const up = p.agents.filter((a) => a.state === 'running').length;
  const notRunning = p.agents.filter((a) => a.state !== 'running');
  const canResume =
    (o.state === 'stopped' || o.state === 'resumable') && Boolean(o.session_id) && !o.starting;
  const canDelete = o.state === 'none' && p.agents.length === 0 && !o.starting;
  const back = 1 + p.agents.filter((a) => a.state === 'stopped').length;
  const resuming = busy?.project === p.name && busy.what === 'resuming';
  const trail = o.state === 'none' ? [] : view.tasks.filter(
    (t) => t.project === p.name && !CLOSED_STATES.has(t.state) && taskProgress(t) !== null,
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <StatusDot color={look.color} />
          <span className="font-medium text-white">{p.name}</span>
        </div>
        <span className="text-xs text-zinc-500">{look.word}</span>
      </CardHeader>
      <CardContent>
        <Row label="orchestrator">
          <span>
            <span className="text-zinc-100">{orchName}</span>
            {o.name && <span className="text-zinc-500">{`  ${windowLabel(p.name, o.name)}`}</span>}
            {o.state === 'unregistered' && o.pane && <span className="text-zinc-500">{`  pane ${o.pane}`}</span>}
            {typeof o.context === 'number' && (
              <span className={o.context_assumed ? 'text-zinc-500' : o.context >= ROTATE_AT_PERCENT ? 'text-amber-300' : 'text-emerald-400'}>
                {`  ${o.context}%`}
              </span>
            )}
            {o.context_unknown && <span className="text-zinc-500">  context unknown</span>}
            {o.state === 'running' && (
              <span className="ml-2 inline-block">
                <Btn id={`interrupt-${p.name}`} onPress={() => onInterrupt(p.name)}>Interrupt</Btn>
              </span>
            )}
            {o.session_id && (
              <span className="ml-2 inline-block">
                <Btn id={`logs-${p.name}`} onPress={() => onLogs(p.name)}>Logs</Btn>
              </span>
            )}
            {o.state === 'running' && (
              <KillControl project={p.name} children={o.children ?? 0} onKill={onKill} />
            )}
          </span>
        </Row>
        <Row label="agents">
          {p.agents.length === 0 ? (
            <span className="text-zinc-500">none</span>
          ) : (
            <span className="flex flex-col">
              <span className="flex items-center gap-1.5">
                {p.agents.map((a) => (
                  <StatusDot key={a.ref ?? a.name} color={agentGlyph(a).color} />
                ))}
                <span className="text-zinc-100">{` ${up} of ${p.agents.length}`}</span>
              </span>
              {notRunning.length > 0 && (
                <span className="text-amber-300 text-xs">{notRunning.map((a) => `${agentRef(a)} ${a.state}`).join(', ')}</span>
              )}
              <span className="text-zinc-500 text-xs">
                {p.agents.map((a) => windowLabel(p.name, a.name)).join(', ')}
              </span>
              {up > 0 && (
                <span className="mt-1 flex flex-wrap gap-1.5">
                  {p.agents.filter((a) => a.state === 'running').map((a) => (
                    <Btn
                      key={`int-${a.ref ?? a.name}`}
                      id={`interrupt-${p.name}-${agentRef(a)}`}
                      onPress={() => onInterrupt(p.name, agentRef(a))}
                    >
                      {`Interrupt ${agentRef(a)}`}
                    </Btn>
                  ))}
                  {p.agents.filter((a) => a.state === 'running' && a.session_id).map((a) => (
                    <Btn
                      key={`log-${a.ref ?? a.name}`}
                      id={`logs-${p.name}-${agentRef(a)}`}
                      onPress={() => onLogs(p.name, agentRef(a))}
                    >
                      {`Logs ${agentRef(a)}`}
                    </Btn>
                  ))}
                </span>
              )}
            </span>
          )}
        </Row>
        <Row label="tasks">
          <span className="text-zinc-100">{tasksLine(view.tasks, p.name, p.open_tasks, now)}</span>
        </Row>
        {trail.length > 0 && (
          <Row label="progress">
            <span className="flex flex-col gap-1">
              {trail.map((t) => (
                <ProgressRow key={t.id} task={t} now={now} busy={busy} onNudge={onNudge} />
              ))}
            </span>
          </Row>
        )}
        <Row label="folders">
          <span className="flex flex-col">
            {p.repos.map((r) => (
              <span key={r.folder} className="truncate font-mono text-xs text-zinc-300">
                {`${r.folder}${r.changed ? `  ${r.changed} changed` : ''}`}
              </span>
            ))}
          </span>
        </Row>
        <Row label="mode">
          <ToggleGroup
            type="single"
            value={p.mode ?? 'ask'}
            disabled={acting}
            onValueChange={(m) => {
              if (m) onSetMode(p.name, m as ProjectMode);
            }}
            aria-label={`permission mode for ${p.name}`}
          >
            {PROJECT_MODES.map((m) => (
              <ToggleGroupItem key={m} value={m}>{m}</ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Row>
        <Row label="approvals">
          <ToggleGroup
            type="single"
            value={p.approvals ?? 'manual'}
            disabled={acting}
            onValueChange={(m) => {
              if (m) onSetApprovals(p.name, m as Approvals);
            }}
            aria-label={`permission mode for ${p.name}`}
          >
            {APPROVALS_MODES.map((m) => (
              <ToggleGroupItem key={m} value={m}>{m}</ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Row>
        {canResume && (
          <div className="pt-1.5">
            {resuming
              ? <span className="text-xs text-sky-400">resuming…</span>
              : (
                <Btn id={`wake-${p.name}`} variant="primary" onPress={() => onWake(p.name)}>
                  {`Resume · ${back} session${back === 1 ? '' : 's'}`}
                </Btn>
              )}
          </div>
        )}
        <MessageRow project={p.name} busy={busy} onMessage={onMessage} />
        <NewTaskRow project={p.name} busy={busy} onStartTask={onStartTask} />
        {canDelete && (
          <div className="pt-1.5">
            <DeleteProjectControl
              project={p.name}
              busy={busy?.project === p.name && busy.what === 'deleting'}
              onDelete={onDelete}
            />
          </div>
        )}
        <div className="mt-2 border-t border-zinc-800 pt-2.5 font-mono text-xs text-zinc-500">
          {`attach: tmux -L hive-v2 attach${o.state === 'running' && o.pane ? ` -t hive \\; select-window -t ${o.pane} \\; select-pane -t ${o.pane}` : ''}`}
        </div>
      </CardContent>
    </Card>
  );
}
