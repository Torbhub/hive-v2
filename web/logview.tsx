import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
    <div className="flex gap-2 py-0.5 text-sm" data-log-entry={entry.id} tabIndex={-1}>
      <span className="shrink-0 text-xs text-zinc-600 tabular">{clockOf(entry.at)}</span>
      <span className="w-10 shrink-0 text-right text-xs text-zinc-600">{KIND_LABEL[entry.kind]}</span>
      <span className={cn('min-w-0 flex-1 whitespace-pre-wrap break-words', KIND_TEXT[entry.kind])}>
        {entry.text}
      </span>
    </div>
  );
}

function mainEntries(log: AgentLog): LogEntry[] {
  return log.agents.find((agent) => agent.agentId === 'main')?.entries ?? [];
}

function mergeEntries(first: LogEntry[], second: LogEntry[]): LogEntry[] {
  const seen = new Set<string>();
  return [...first, ...second].filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

function sameFile(left: AgentLog, right: AgentLog): boolean {
  return left.session_id === right.session_id && left.fileGeneration === right.fileGeneration;
}

function withMainEntries(log: AgentLog, entries: LogEntry[]): AgentLog {
  return { ...log, agents: entries.length > 0 ? [{ agentId: 'main', entries }] : [] };
}

function mergeLatest(current: AgentLog | null, next: AgentLog): AgentLog {
  if (!current || !sameFile(current, next)) return next;
  const currentEntries = mainEntries(current);
  const nextEntries = mainEntries(next);
  if (currentEntries.length === 0 || nextEntries.length === 0) return next;
  const currentIds = new Set(currentEntries.map((entry) => entry.id));
  if (!nextEntries.some((entry) => currentIds.has(entry.id))) return next;
  return {
    ...withMainEntries(next, mergeEntries(currentEntries, nextEntries)),
    hasOlder: current.hasOlder,
    olderCursor: current.olderCursor,
  };
}

function mergeOlder(current: AgentLog | null, older: AgentLog): AgentLog | null {
  if (!current || !sameFile(current, older)) return current;
  const merged = withMainEntries(current, mergeEntries(mainEntries(older), mainEntries(current)));
  return { ...merged, hasOlder: older.hasOlder, olderCursor: older.olderCursor };
}

function logUrl(project: string, agent?: string, before?: string): string {
  return `api/log?project=${encodeURIComponent(project)}${agent ? `&agent=${encodeURIComponent(agent)}` : ''}`
    + `${before ? `&before=${encodeURIComponent(before)}` : ''}`;
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
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const olderRequestRef = useRef(false);
  const requestSequenceRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);
  const pendingScrollRef = useRef<'tail' | { height: number; top: number } | null>(null);

  const beginRequest = useCallback(() => {
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    requestSequenceRef.current += 1;
    return { sequence: requestSequenceRef.current, signal: controller.signal };
  }, []);

  const refresh = useCallback(async () => {
    const { sequence, signal } = beginRequest();
    olderRequestRef.current = false;
    setLoadingOlder(false);
    try {
      const r = await fetch(logUrl(project, agent), { signal });
      const j = (await r.json()) as AgentLog & { ok?: boolean; detail?: string };
      if (sequence !== requestSequenceRef.current) return;
      if (!r.ok || j.ok === false) {
        setError(j.detail ?? `HTTP ${r.status}`);
        return;
      }
      setError('');
      if (atBottomRef.current) pendingScrollRef.current = 'tail';
      setLog((current) => mergeLatest(current, j));
    } catch (e) {
      if (sequence === requestSequenceRef.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [project, agent, beginRequest]);

  const loadOlder = useCallback(async () => {
    if (!log?.hasOlder || !log.olderCursor || olderRequestRef.current) return;
    const target = { session_id: log.session_id, fileGeneration: log.fileGeneration };
    const { sequence, signal } = beginRequest();
    olderRequestRef.current = true;
    setLoadingOlder(true);
    setAnnouncement('');
    try {
      const r = await fetch(logUrl(project, agent, log.olderCursor), { signal });
      const j = (await r.json()) as AgentLog & { ok?: boolean; detail?: string };
      if (sequence !== requestSequenceRef.current) return;
      if (!r.ok || j.ok === false) {
        if (r.status === 400) {
          setLog(null);
          setError('');
          await refresh();
        } else {
          setError(j.detail ?? `HTTP ${r.status}`);
        }
        return;
      }
      if (j.session_id !== target.session_id || j.fileGeneration !== target.fileGeneration) return;
      const existing = new Set(mainEntries(log).map((entry) => entry.id));
      const newEntries = mainEntries(j).filter((entry) => !existing.has(entry.id));
      const element = scrollRef.current;
      pendingScrollRef.current = element ? { height: element.scrollHeight, top: element.scrollTop } : null;
      setAnnouncement(newEntries.length === 0 ? 'No new older entries.'
        : `Loaded ${newEntries.length} older ${newEntries.length === 1 ? 'entry' : 'entries'}.`);
      setError('');
      setLog((current) => mergeOlder(current, j));
    } catch (e) {
      if (sequence === requestSequenceRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (sequence === requestSequenceRef.current) {
        olderRequestRef.current = false;
        setLoadingOlder(false);
      }
    }
  }, [project, agent, log, beginRequest, refresh]);

  useEffect(() => {
    setLog(null);
    setError('');
    setAnnouncement('');
    atBottomRef.current = true;
    pendingScrollRef.current = null;
    void refresh();
    const t = setInterval(() => void refresh(), EVERY_MS);
    return () => {
      clearInterval(t);
      requestSequenceRef.current += 1;
      requestControllerRef.current?.abort();
      olderRequestRef.current = false;
    };
  }, [refresh]);

  useLayoutEffect(() => {
    const pending = pendingScrollRef.current;
    const element = scrollRef.current;
    pendingScrollRef.current = null;
    if (!pending || !element) return;
    if (pending === 'tail') {
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      atBottomRef.current = true;
      return;
    }
    element.scrollTop = element.scrollHeight - pending.height + pending.top;
    atBottomRef.current = false;
    element.focus({ preventScroll: true });
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
        <div role="status" className="sr-only">{announcement}</div>

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

        {log !== null && log.agents.length > 0 && (
          <div
            ref={scrollRef}
            role="log"
            aria-label="wire log"
            aria-live="off"
            tabIndex={0}
            className="max-h-[70vh] overflow-y-auto"
            onScroll={(event) => {
              const element = event.currentTarget;
              atBottomRef.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 2;
            }}
          >
            {log.hasOlder && (
              <div className="mb-3 flex justify-center">
                <Button variant="ghost" size="sm" onClick={() => void loadOlder()} disabled={loadingOlder}>
                  {loadingOlder ? 'loading older…' : 'load older'}
                </Button>
              </div>
            )}
            {log.agents.map((a) => (
              <Card key={a.agentId}>
                <CardHeader>
                  <span className="font-medium text-white">{a.agentId}</span>
                  <span className="text-xs text-zinc-500">{`${a.entries.length} entries, newest last`}</span>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col divide-y divide-zinc-900">
                    {a.entries.map((entry) => <EntryRow key={entry.id} entry={entry} />)}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
