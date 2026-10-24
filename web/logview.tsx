import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentLog, LogEntry } from '../src/logview';
import { cn } from './lib/utils';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Card, CardContent, CardHeader } from './components/ui/card';
import { Separator } from './components/ui/separator';

const EVERY_MS = 20_000;

const KIND_LABEL: Record<LogEntry['kind'], string> = {
  think: 'think', text: 'say', tool: 'tool', prompt: 'you',
};

const KIND_TEXT: Record<LogEntry['kind'], string> = {
  think: 'text-zinc-500',
  text: 'text-zinc-200',
  tool: 'font-mono text-xs text-zinc-400',
  prompt: 'text-sky-300',
};

function clockOf(at: string): string {
  const t = new Date(at);
  return Number.isNaN(t.getTime()) ? '' : t.toTimeString().slice(0, 8);
}

function EntryRow({ entry }: { entry: LogEntry }) {
  return (
    <div className="flex gap-2 py-0.5 text-sm">
      <span className="shrink-0 text-xs text-zinc-600 tabular">{clockOf(entry.at)}</span>
      <span className="w-10 shrink-0 text-right text-xs text-zinc-600">{KIND_LABEL[entry.kind]}</span>
      <span className={cn('min-w-0 flex-1 whitespace-pre-wrap break-words', KIND_TEXT[entry.kind])}>
        {entry.text}
      </span>
    </div>
  );
}

export function LogView({
  project, agent, onBack,
}: {
  project: string;
  agent?: string;
  onBack: () => void;
}) {
  const [log, setLog] = useState<AgentLog | null>(null);
  const [error, setError] = useState('');
  const tailRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const qs = `api/log?project=${encodeURIComponent(project)}${agent ? `&agent=${encodeURIComponent(agent)}` : ''}`;
    try {
      const r = await fetch(qs);
      const j = (await r.json()) as AgentLog & { ok?: boolean; detail?: string };
      if (!r.ok || j.ok === false) {
        setError(j.detail ?? `HTTP ${r.status}`);
        return;
      }
      setError('');
      setLog(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [project, agent]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), EVERY_MS);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    tailRef.current?.scrollIntoView({ block: 'end' });
  }, [log]);

  const who = agent ?? 'orchestrator';
  return (
    <div className="min-h-screen bg-zinc-950">
      <div className="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-8">
        <header className="flex items-baseline justify-between gap-3">
          <div className="flex min-w-0 items-baseline gap-2.5">
            <span className="text-lg font-semibold tracking-tight text-white">{project}</span>
            <span className="truncate text-sm text-zinc-400">{`logs · ${who}`}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {log && <Badge>{`${log.agents.reduce((n, a) => n + a.entries.length, 0)} entries`}</Badge>}
            <Button variant="ghost" size="sm" onClick={onBack}>back</Button>
          </div>
        </header>
        <Separator />

        {error !== '' && (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        {log === null && error === '' && (
          <div className="text-sm text-zinc-500">reading the wire log…</div>
        )}

        {log !== null && log.agents.length === 0 && error === '' && (
          <div className="text-sm text-zinc-500">
            {`no thinking recorded yet under session ${log.session_id}`}
          </div>
        )}

        {log?.agents.map((a) => (
          <Card key={a.agentId}>
            <CardHeader>
              <span className="font-medium text-white">{a.agentId}</span>
              <span className="text-xs text-zinc-500">{`${a.entries.length} entries, newest last`}</span>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col divide-y divide-zinc-900">
                {a.entries.map((e, i) => <EntryRow key={`${e.at}-${i}`} entry={e} />)}
              </div>
            </CardContent>
          </Card>
        ))}
        <div ref={tailRef} />
      </div>
    </div>
  );
}
