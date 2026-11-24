import React, {
  useCallback, useEffect, useRef, useState,
} from 'react';
import { Toaster, toast } from 'sonner';
import type { HubView } from '../src/types';
import { ActionContext } from './action';
import { Branches } from './branches';
import { LogView } from './logview';
import { Questions } from './questions';
import { Dashboard } from './Dashboard';
import { LoadErrorShell, LoadingShell } from './LoadingShell';
import { readRoute, routeUrl, type Route } from './routes';
import type { CreatedTask } from './task';
import { apiPath } from './api';
import { useHubActions } from './useHubActions';

const EVERY_MS = 20_000;

const EMPTY_VIEW: HubView = { root: '', hubName: '', projects: [], tasks: [], dialogs: {}, decisions: [], questions: [], updatedAt: 0, error: '' };

export function App() {
  const [view, setView] = useState<HubView>(EMPTY_VIEW);
  const [route, setRoute] = useState<Route>(readRoute);
  const [createdTask, setCreatedTask] = useState<CreatedTask>();
  const [refreshing, setRefreshing] = useState(false);
  const [loadingStage, setLoadingStage] = useState<'access' | 'projects'>('access');
  const [acting, setActing] = useState(false);
  const [busy, setBusy] = useState<{ project: string; what: 'resuming' | 'continuing' | 'starting' | 'answering' | 'adding' | 'messaging' | 'resolving' | 'nudging' | 'interrupting' | 'killing' | 'deleting'; who?: string } | null>(null);
  const [pressed, setPressed] = useState<string | null>(null);
  const actingRef = useRef(false);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);

  const navigate = useCallback((next: Route, replace = false) => {
    window.history[replace ? 'replaceState' : 'pushState']({ hive: true }, '', routeUrl(next));
    setRoute(next);
  }, []);

  useEffect(() => {
    window.history.replaceState({ hive: true }, '', window.location.href);
    const onPopState = () => setRoute(readRoute());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (view.updatedAt !== 0 || view.error) return;
    const timer = setTimeout(() => setLoadingStage('projects'), 350);
    return () => clearTimeout(timer);
  }, [view.updatedAt, view.error]);

  const refresh = useCallback(() => {
    if (refreshPromiseRef.current) return refreshPromiseRef.current;
    const pending = (async () => {
      setRefreshing(true);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      try {
        const response = await fetch(apiPath('api/view'), { signal: controller.signal });
        const body = await response.json() as HubView & { detail?: string };
        if (!response.ok) throw new Error(body.detail ?? `HTTP ${response.status}`);
        setView((current) => (body.updatedAt === 0 && body.error ? { ...current, error: body.error } : body));
      } catch (error) {
        const message = error instanceof Error && error.name === 'AbortError' ? 'The read timed out after 8 seconds.' : error instanceof Error ? error.message : String(error);
        setView((current) => ({ ...current, error: message }));
      } finally {
        clearTimeout(timeout);
        setRefreshing(false);
        refreshPromiseRef.current = null;
      }
    })();
    refreshPromiseRef.current = pending;
    return pending;
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), EVERY_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'r' && !event.metaKey && !event.ctrlKey && !event.altKey) void refresh();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [refresh]);

  const act = useCallback(async (
    id: string,
    project: string,
    what: 'resuming' | 'continuing' | 'starting' | 'answering' | 'adding' | 'messaging' | 'resolving' | 'nudging' | 'interrupting' | 'killing' | 'deleting',
    who: string,
    runAction: () => Promise<string>,
    busyWho?: string,
  ): Promise<boolean> => {
    if (actingRef.current) return false;
    actingRef.current = true;
    setPressed(id);
    setActing(true);
    setBusy({ project, what, who: busyWho });
    try {
      toast(await runAction());
      return true;
    } catch (error) {
      toast(`${who}: ${error instanceof Error ? error.message.split('\n').pop() : String(error)}`);
      return false;
    } finally {
      actingRef.current = false;
      setActing(false);
      setBusy(null);
      setPressed(null);
      await refresh();
    }
  }, [refresh]);

  const actions = useHubActions({ act, navigate, onCreatedTask: setCreatedTask });

  if (view.updatedAt === 0 && !view.error) return <LoadingShell stage={loadingStage} />;
  if (view.updatedAt === 0 && view.error) return <LoadErrorShell error={view.error} retry={refresh} />;

  let content: React.ReactNode;
  if (route.name === 'branches') {
    content = (
      <Branches
        project={route.project}
        branchId={route.branch}
        onBack={() => navigate({ name: 'project', project: route.project, tab: 'team' })}
        onSelect={(branch) => navigate({ name: 'branches', project: route.project, branch })}
      />
    );
  } else if (route.name === 'logs') {
    content = <LogView project={route.project} agent={route.agent} onBack={() => navigate({ name: 'project', project: route.project, tab: 'tasks' })} />;
  } else if (route.name === 'questions') {
    content = (
      <Questions
        batches={view.questions}
        total={view.questionsTotal ?? view.questions.length}
        batchId={route.batch}
        onBack={() => navigate({ name: 'home', filter: 'all' })}
        onAnswer={actions.onQuestionAnswer}
        onCancel={actions.onQuestionCancel}
        onOpenBatch={(batch) => navigate({ name: 'questions', batch: batch.id })}
      />
    );
  } else {
    content = (
      <Dashboard
        view={view}
        route={route}
        createdTask={createdTask}
        busy={busy}
        refreshing={refreshing}
        refresh={refresh}
        onNavigate={navigate}
        {...actions}
      />
    );
  }

  return (
    <ActionContext.Provider value={{ acting, pressed }}>
      {content}
      <Toaster theme="dark" position="bottom-right" />
    </ActionContext.Provider>
  );
}
