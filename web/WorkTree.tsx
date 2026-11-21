import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkTree, WorkTreeNode } from '../src/types';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';

type Row = { node: WorkTreeNode; depth: number };

function rows(nodes: WorkTreeNode[]): Row[] {
  const children = new Map<string, WorkTreeNode[]>();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    const parent = node.parentId && byId.has(node.parentId) ? node.parentId : '';
    children.set(parent, [...children.get(parent) ?? [], node]);
  }
  const result: Row[] = [];
  const seen = new Set<string>();
  const visit = (node: WorkTreeNode, depth: number) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    result.push({ node, depth });
    for (const child of children.get(node.id) ?? []) visit(child, depth + 1);
  };
  for (const node of children.get('') ?? []) visit(node, 0);
  for (const node of nodes) visit(node, 0);
  return result;
}

function stateLabel(node: WorkTreeNode): string {
  if (node.state === 'done' && node.evidenceIncomplete) return 'done · evidence incomplete';
  if (node.state === 'blocked_external:deadline_exceeded') return `${node.state} · quarantined`;
  if (node.state === 'blocked_external' || node.state === 'closing_external') return `${node.state} · active`;
  if (['failed', 'superseded', 'unknown'].includes(node.state)) return `${node.state} · not done`;
  if (['already_fixed', 'duplicate', 'no_op'].includes(node.state)) {
    return `${node.state} · evidence: ${node.evidenceOutcome ?? 'recorded'}`;
  }
  return node.state;
}

export function WorkTreeView({ tree, onChanged }: { tree: WorkTree; onChanged: () => Promise<void> }) {
  const [selected, setSelected] = useState(tree.nodes[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ nodeId: string; message: string } | null>(null);
  const refs = useRef(new Map<string, HTMLLIElement>());
  const visible = useMemo(() => rows(tree.nodes), [tree.nodes]);
  const current = tree.nodes.find((node) => node.id === selected) ?? tree.nodes[0];

  useEffect(() => {
    if (!tree.nodes.some((node) => node.id === selected)) setSelected(tree.nodes[0]?.id ?? '');
  }, [tree.nodes, selected]);

  const select = (id: string) => setSelected(id);
  const move = (index: number) => {
    const row = visible[Math.max(0, Math.min(index, visible.length - 1))];
    if (!row) return;
    select(row.node.id);
    refs.current.get(row.node.id)?.focus();
  };
  const keyDown = (event: React.KeyboardEvent, node: WorkTreeNode, index: number) => {
    if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(visible.length - 1);
    else if (event.key === 'Enter' || event.key === ' ') select(node.id);
    else return;
    event.preventDefault();
  };

  const markDone = async (node: WorkTreeNode) => {
    if (!node.doneEnabled || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('api/task-outcome', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project: node.project, task: node.task, outcome: 'done', plan_digest: node.planDigest, epoch: node.epoch,
        }),
      });
      const result = await response.json() as { ok?: boolean; detail?: string };
      if (!response.ok || result.ok === false) throw new Error(result.detail ?? `HTTP ${response.status}`);
      await onChanged();
    } catch (cause) {
      setError({ nodeId: node.id, message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  };

  if (tree.nodes.length === 0) return null;
  return (
    <section className="flex flex-col gap-3" aria-label="Work tree section">
      <div className="flex items-center gap-2">
        <div className="text-xs font-medium uppercase tracking-widest text-zinc-500">Work tree</div>
        {tree.truncated && <Badge>bounded view</Badge>}
      </div>
      <div className="flex flex-col gap-3 rounded-md border border-zinc-800 p-3 sm:flex-row">
        <ul role="tree" aria-label="Work tree" className="min-w-0 flex-1" data-work-tree>
          {visible.map(({ node, depth }, index) => (
            <li
              key={node.id}
              ref={(element) => {
                if (element) refs.current.set(node.id, element);
                else refs.current.delete(node.id);
              }}
              role="treeitem"
              aria-selected={current?.id === node.id}
              aria-level={depth + 1}
              tabIndex={current?.id === node.id ? 0 : -1}
              className="cursor-pointer rounded px-2 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
              style={{ paddingLeft: `${0.5 + Math.min(depth, 12)}rem` }}
              onClick={() => select(node.id)}
              onFocus={() => select(node.id)}
              onKeyDown={(event) => keyDown(event, node, index)}
              data-work-tree-node={node.id}
            >
              <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
                <span className="min-w-0 break-words font-medium text-zinc-100">{node.recordId}</span>
                <span className="shrink-0 text-xs text-zinc-400">{stateLabel(node)}</span>
              </div>
              <div className="text-xs text-zinc-500">{node.kind} · {node.adapter}</div>
            </li>
          ))}
        </ul>
        {current && (
          <aside className="min-w-0 flex-1 border-t border-zinc-800 pt-3 text-xs sm:border-l sm:border-t-0 sm:pl-3 sm:pt-0" aria-live="polite" data-work-tree-details>
            <div className="mb-2 font-medium text-zinc-100">{current.recordId}</div>
            <dl className="flex flex-col gap-1 text-zinc-400">
              <div><dt className="inline text-zinc-500">task: </dt><dd className="inline break-words">{current.task}</dd></div>
              {current.externalId && <div><dt className="inline text-zinc-500">external ID: </dt><dd className="inline break-words">{current.externalId}</dd></div>}
              {current.planDigest && <div><dt className="inline text-zinc-500">plan: </dt><dd className="inline break-all">{current.planDigest}</dd></div>}
              {current.lineageId && <div><dt className="inline text-zinc-500">lineage: </dt><dd className="inline break-words">{current.lineageId}</dd></div>}
              {current.attempts !== undefined && <div><dt className="inline text-zinc-500">attempts: </dt><dd className="inline">{current.attempts}</dd></div>}
              {current.scope.length > 0 && <div><dt className="inline text-zinc-500">scope: </dt><dd className="inline break-words">{current.scope.join(', ')}</dd></div>}
              {current.details.map((item) => (
                <div key={item.label}><dt className="inline text-zinc-500">{item.label}: </dt><dd className="inline break-words">{item.value}</dd></div>
              ))}
            </dl>
            {current.acceptance.length > 0 && (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-xs" aria-label="Acceptance evidence" data-acceptance-evidence>
                  <caption className="mb-2 text-left font-medium text-zinc-100">Acceptance evidence</caption>
                  <thead className="text-zinc-500">
                    <tr>
                      <th scope="col" className="pr-2 font-normal">acceptance</th>
                      <th scope="col" className="pr-2 font-normal">predicate</th>
                      <th scope="col" className="pr-2 font-normal">result</th>
                      <th scope="col" className="pr-2 font-normal">artifact digest</th>
                      <th scope="col" className="font-normal">target</th>
                    </tr>
                  </thead>
                  <tbody className="text-zinc-400">
                    {current.acceptance.map((row, index) => (
                      <React.Fragment key={index}>
                        <tr>
                          <td className="pr-2 align-top">{row.acceptanceId} · {row.required ? 'required' : 'optional'}</td>
                          <td className="pr-2 align-top">{row.predicateId}</td>
                          <td className="pr-2 align-top font-medium text-zinc-100">{row.result}</td>
                          <td className="max-w-32 break-all pr-2 align-top">{row.artifactDigest}</td>
                          <td className="max-w-32 break-all align-top">{row.target}</td>
                        </tr>
                        {row.blocker && (
                          <tr><td colSpan={5} className="break-words pb-2 text-amber-300">{row.blocker}</td></tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
                {current.acceptanceTruncated && <p className="mt-2 text-amber-300">acceptance evidence truncated</p>}
              </div>
            )}
            {current.blocker && <p className="mt-2 break-words text-amber-300">{current.blocker}</p>}
            {current.doneBlockers.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1 text-amber-300" aria-label="Done blockers">
                {current.doneBlockers.map((blocker, index) => <li key={index}>{blocker}</li>)}
              </ul>
            )}
            {current.kind === 'task' && current.active && (
              <Button
                className="mt-3"
                size="sm"
                disabled={!current.doneEnabled || busy}
                onClick={() => void markDone(current)}
                data-work-tree-done={current.task}
              >
                Done
              </Button>
            )}
            {error?.nodeId === current.id && <p role="alert" className="mt-2 text-red-300">{error.message}</p>}
          </aside>
        )}
      </div>
    </section>
  );
}
