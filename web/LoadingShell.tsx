import React from 'react';
import { AlertCircle, Check, Hexagon, LoaderCircle, RefreshCw } from 'lucide-react';
import { Button } from './components/ui/button';

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <div className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
        <Hexagon className="size-5" aria-hidden="true" />
      </div>
      <div>
        <div className="text-sm font-semibold tracking-tight">hive</div>
        <div className="text-xs text-muted-foreground">Opening through Nexus</div>
      </div>
    </div>
  );
}

function TransitionFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="flex h-[73px] shrink-0 items-center border-b px-5 sm:px-8"><Brand /></header>
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-[272px] shrink-0 border-r p-4 md:block" aria-hidden="true">
          <div className="h-10 animate-pulse rounded-md bg-muted" />
          <div className="mt-6 h-4 w-20 rounded bg-muted" />
          <div className="mt-3 h-14 animate-pulse rounded-md bg-muted" />
          <div className="mt-2 h-14 animate-pulse rounded-md bg-muted" />
        </aside>
        <main className="min-w-0 flex-1 p-4 md:p-6">
          <div className="mx-auto flex h-full max-w-5xl flex-col gap-5">
            <div className="h-8 w-56 animate-pulse rounded bg-muted" aria-hidden="true" />
            <div className="h-4 w-full max-w-lg animate-pulse rounded bg-muted" aria-hidden="true" />
            <section className="flex flex-1 items-center justify-center rounded-xl border bg-card/40 p-6">{children}</section>
          </div>
        </main>
      </div>
    </div>
  );
}

export function LoadingShell({ stage }: { stage: 'access' | 'projects' }) {
  return (
    <div data-testid="hive-loading-shell">
      <TransitionFrame>
        <div className="w-full max-w-sm" role="status" aria-live="polite">
          <LoaderCircle className="mb-5 size-6 animate-spin text-sky-400" aria-hidden="true" />
          <h1 className="text-2xl font-semibold tracking-tight">Opening Hive</h1>
          <p className="mt-2 text-sm text-muted-foreground">Your projects and decisions will appear here.</p>
          <div className="mt-8 flex flex-col gap-3 text-sm">
            <div className="flex items-center gap-3 text-muted-foreground">
              {stage === 'projects' ? <Check className="size-4 text-emerald-400" /> : <LoaderCircle className="size-4 animate-spin" />}
              Checking access
            </div>
            <div className={stage === 'projects' ? 'flex items-center gap-3 text-foreground' : 'flex items-center gap-3 text-muted-foreground'}>
              {stage === 'projects' ? <LoaderCircle className="size-4 animate-spin" /> : <span className="size-4 rounded-full border" />}
              Loading projects
            </div>
          </div>
        </div>
      </TransitionFrame>
    </div>
  );
}

export function LoadErrorShell({ error, retry }: { error: string; retry: () => Promise<void> }) {
  return (
    <div data-testid="hive-error-shell">
      <TransitionFrame>
        <div className="w-full max-w-md" role="alert">
          <AlertCircle className="mb-5 size-6 text-amber-300" aria-hidden="true" />
          <h1 className="text-2xl font-semibold tracking-tight">Could not load projects</h1>
          <p className="mt-3 break-words text-sm text-muted-foreground">{error}</p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Button className="min-h-10" onClick={() => void retry()}><RefreshCw />Retry</Button>
            <Button asChild variant="outline" className="min-h-10"><a href="/">Back to Nexus</a></Button>
          </div>
          <p className="mt-5 font-mono text-xs text-muted-foreground">Terminal fallback: tmux -L hive-v2 attach</p>
        </div>
      </TransitionFrame>
    </div>
  );
}
