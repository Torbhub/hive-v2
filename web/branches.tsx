import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { NativeBranchDetail, NativeBranchSummary } from '../src/types';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Card, CardContent, CardHeader } from './components/ui/card';
import { Separator } from './components/ui/separator';

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function json<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { ok?: boolean; detail?: string };
  if (!response.ok || body.ok === false) throw new Error(body.detail ?? `HTTP ${response.status}`);
  return body;
}

type Busy = 'list' | 'detail' | 'review' | 'rejoin' | null;

function BranchDetail({
  detail, findingIds, busy, armedDigest, onToggleFinding, onReview, onArm, onRejoin, onRefresh,
}: {
  detail: NativeBranchDetail;
  findingIds: string[];
  busy: Busy;
  armedDigest: string | null;
  onToggleFinding: (id: string) => void;
  onReview: () => void;
  onArm: (digest: string) => void;
  onRejoin: () => void;
  onRefresh: () => void;
}) {
  const actionable = detail.status === 'active' && !detail.rejoin;
  const canReview = Boolean(actionable && detail.hasResult && findingIds.length > 0 && busy === null);
  const canRejoin = Boolean(actionable && detail.review && busy === null);
  return (
    <Card>
      <CardHeader>
        <span className="font-medium text-white">{detail.purpose}</span>
        <Badge>{detail.status}</Badge>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4" data-branch-detail>
          <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-zinc-500">agent</dt><dd>{detail.agent}</dd>
            <dt className="text-zinc-500">task</dt><dd>{detail.task}</dd>
            <dt className="text-zinc-500">created</dt><dd>{detail.createdAt}</dd>
            <dt className="text-zinc-500">updated</dt><dd>{detail.updatedAt}</dd>
          </dl>
          {detail.error && <div className="text-sm text-amber-300">{detail.error}</div>}

          <section className="flex flex-col gap-3" aria-label="branch findings">
            <div className="text-xs font-medium uppercase tracking-widest text-zinc-500">Findings</div>
            {detail.findings.length === 0 && <div className="text-sm text-zinc-500">No result findings.</div>}
            {detail.findings.map((finding) => (
              <label key={finding.id} className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  aria-label={`select finding ${finding.id}`}
                  checked={findingIds.includes(finding.id)}
                  disabled={!actionable || busy !== null}
                  onChange={() => onToggleFinding(finding.id)}
                  className="mt-1"
                />
                <span className="min-w-0 flex-1">
                  <span className="block whitespace-pre-wrap text-zinc-100">{finding.answer}</span>
                  <span className="mt-1 block whitespace-pre-wrap text-zinc-300">{finding.recommendation}</span>
                  <span className="mt-1 block whitespace-pre-wrap text-zinc-500">{finding.uncertainty}</span>
                </span>
              </label>
            ))}
          </section>

          {detail.review && (
            <section className="flex flex-col gap-2" aria-label="reviewed rejoin prompt">
              <div className="text-xs font-medium uppercase tracking-widest text-zinc-500">Reviewed prompt</div>
              <div className="break-all font-mono text-xs text-zinc-500">{detail.review.digest}</div>
              <div className="break-all font-mono text-xs text-zinc-500">{detail.review.promptId}</div>
              <div className="text-xs text-zinc-500">{`${detail.review.createdAt} · expires ${detail.review.expiresAt}`}</div>
              <pre data-branch-prompt className="max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-zinc-800 bg-zinc-900 p-3 font-mono text-xs text-zinc-300">{detail.review.prompt}</pre>
            </section>
          )}

          {detail.rejoin?.status === 'unknown' && (
            <div className="text-sm text-amber-300">Rejoin delivery is unknown. Reconcile before any retry.</div>
          )}
          {detail.rejoin?.status === 'rejoined' && (
            <section data-branch-receipt className="flex flex-col gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
              <div className="font-medium text-emerald-300">Rejoined</div>
              <div>{`nativeMessageId ${detail.rejoin.nativeMessageId ?? ''}`}</div>
              <div>{`time ${detail.rejoin.rejoinedAt ?? ''}`}</div>
              <div className="break-all font-mono text-xs">{`promptId ${detail.rejoin.promptId}`}</div>
              <div className="break-all font-mono text-xs">{`digest ${detail.rejoin.reviewDigest}`}</div>
            </section>
          )}

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={!canReview} onClick={onReview}>
              {busy === 'review' ? 'Reviewing…' : 'Review'}
            </Button>
            {armedDigest === null ? (
              <Button
                variant="outline"
                size="sm"
                disabled={!canRejoin}
                onClick={() => {
                  if (detail.review) onArm(detail.review.digest);
                }}
              >
                Rejoin
              </Button>
            ) : (
              <Button variant="primary" size="sm" disabled={busy !== null} onClick={onRejoin}>
                {busy === 'rejoin' ? 'Rejoining…' : 'Confirm rejoin'}
              </Button>
            )}
            <Button variant="ghost" size="sm" disabled={busy !== null} onClick={onRefresh}>Refresh</Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function Branches({ project, onBack }: { project: string; onBack: () => void }) {
  const [items, setItems] = useState<NativeBranchSummary[] | null>(null);
  const [detail, setDetail] = useState<NativeBranchDetail | null>(null);
  const [findingIds, setFindingIds] = useState<string[]>([]);
  const [armedDigest, setArmedDigest] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState('');
  const detailRequest = useRef(0);

  const loadList = useCallback(async () => {
    setBusy('list');
    try {
      const response = await fetch(`/api/branches?project=${encodeURIComponent(project)}`);
      const body = await json<{ branches: NativeBranchSummary[] }>(response);
      setItems(body.branches);
      setError('');
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(null);
    }
  }, [project]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  async function loadDetail(id: string) {
    const request = ++detailRequest.current;
    setBusy('detail');
    setArmedDigest(null);
    try {
      const response = await fetch(`/api/branch?project=${encodeURIComponent(project)}&branch=${encodeURIComponent(id)}`);
      const body = await json<{ branch: NativeBranchDetail }>(response);
      if (request !== detailRequest.current) return;
      setDetail(body.branch);
      setFindingIds(body.branch.review?.findingIds ?? []);
      setError('');
    } catch (cause) {
      if (request !== detailRequest.current) return;
      setDetail(null);
      setFindingIds([]);
      setError(message(cause));
    } finally {
      if (request === detailRequest.current) setBusy(null);
    }
  }

  function selectBranch(id: string) {
    setDetail(null);
    setFindingIds([]);
    setArmedDigest(null);
    setError('');
    void loadDetail(id);
  }

  function toggleFinding(id: string) {
    setFindingIds((current) => current.includes(id) ? current.filter((candidate) => candidate !== id) : [...current, id]);
    setDetail((current) => current ? { ...current, review: undefined } : current);
    setArmedDigest(null);
  }

  async function review() {
    if (!detail) return;
    setBusy('review');
    setArmedDigest(null);
    try {
      const response = await fetch('/api/branch-review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project, branch: detail.id, findingIds }),
      });
      const body = await json<{ branch: NativeBranchDetail }>(response);
      setDetail(body.branch);
      setFindingIds(body.branch.review?.findingIds ?? []);
      setError('');
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(null);
    }
  }

  async function rejoin() {
    if (!detail || armedDigest === null) return;
    setBusy('rejoin');
    try {
      const response = await fetch('/api/branch-rejoin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project, branch: detail.id, reviewDigest: armedDigest }),
      });
      const body = await json<{ branch: NativeBranchDetail }>(response);
      setDetail(body.branch);
      setError('');
    } catch (cause) {
      setError(message(cause));
    } finally {
      setArmedDigest(null);
      setBusy(null);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950">
      <div className="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-8">
        <header className="flex items-baseline justify-between gap-3">
          <div className="flex min-w-0 items-baseline gap-2.5">
            <span className="text-lg font-semibold tracking-tight text-white">{project}</span>
            <span className="truncate text-sm text-zinc-400">branches</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {items !== null && <Badge>{items.length}</Badge>}
            <Button variant="ghost" size="sm" onClick={onBack}>back</Button>
          </div>
        </header>
        <Separator />

        {error !== '' && (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">{error}</div>
        )}
        {items === null && error === '' && <div className="text-sm text-zinc-500">reading branches…</div>}
        {items?.length === 0 && <div className="text-sm text-zinc-500">No native branches.</div>}

        {items && items.length > 0 && (
          <section className="flex flex-col gap-2" aria-label="native branches">
            {items.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => selectBranch(item.id)}
                disabled={busy !== null}
                className="rounded-md border border-zinc-800 px-3 py-2 text-left hover:border-zinc-600 disabled:opacity-40"
              >
                <span className="flex items-center justify-between gap-3">
                  <span className="font-medium text-zinc-100">{item.purpose}</span>
                  <Badge>{item.status}</Badge>
                </span>
                <span className="mt-1 block text-xs text-zinc-500">{`${item.agent} · ${item.task}`}</span>
              </button>
            ))}
          </section>
        )}

        {busy === 'detail' && detail === null && error === '' && <div className="text-sm text-zinc-500">reading branch detail…</div>}

        {detail && (
          <BranchDetail
            detail={detail}
            findingIds={findingIds}
            busy={busy}
            armedDigest={armedDigest}
            onToggleFinding={toggleFinding}
            onReview={() => void review()}
            onArm={setArmedDigest}
            onRejoin={() => void rejoin()}
            onRefresh={() => void loadDetail(detail.id)}
          />
        )}
      </div>
    </div>
  );
}
