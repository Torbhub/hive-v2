import React, { useMemo, useState } from 'react';
import { isOpenable, parse, type Segment, type Stretch } from '../src/stretch';
import { cn } from './lib/utils';

// The open record is fire-and-forget: a missed line must never break the UI.
function recordOpen(short: string, pane: string): void {
  void fetch('api/stretch-opened', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ short, pane }),
  }).catch(() => {});
}

// A span, not a button: an open stretch's long form can hold further
// stretches, and nested buttons are invalid HTML.
function StretchSpan({
  stretch, open, onToggle,
}: {
  stretch: Stretch;
  open: ReadonlySet<string>;
  onToggle: (s: Stretch) => void;
}) {
  const isOpen = open.has(stretch.key);
  const toggle = () => onToggle(stretch);
  return (
    <span
      role="button"
      tabIndex={0}
      aria-expanded={isOpen}
      onClick={toggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      }}
      className={cn(
        'cursor-pointer underline decoration-dotted decoration-zinc-600 underline-offset-2',
        'focus-visible:outline-1 focus-visible:outline-sky-400',
        isOpen ? 'text-zinc-300 hover:text-zinc-100' : 'text-zinc-200 hover:text-white',
      )}
    >
      {isOpen ? renderSegments(stretch.long ?? [], open, onToggle) : stretch.short}
    </span>
  );
}

function renderSegments(
  segments: Segment[],
  open: ReadonlySet<string>,
  onToggle: (s: Stretch) => void,
): React.ReactNode {
  return segments.map((segment, i) => {
    if (typeof segment === 'string') return <React.Fragment key={i}>{segment}</React.Fragment>;
    if (!isOpenable(segment)) {
      return (
        <React.Fragment key={segment.key || i}>
          {segment.short}
          {segment.long ? renderSegments(segment.long, open, onToggle) : null}
        </React.Fragment>
      );
    }
    return <StretchSpan key={segment.key} stretch={segment} open={open} onToggle={onToggle} />;
  });
}

export function StretchText({ text, pane, className }: { text: string; pane: string; className?: string }) {
  const segments = useMemo(() => parse(text), [text]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const onToggle = (s: Stretch) => {
    if (!open.has(s.key)) recordOpen(s.short.trim(), pane);
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(s.key)) next.delete(s.key);
      else next.add(s.key);
      return next;
    });
  };
  // Truncation only holds while everything is closed; an open long form wraps.
  return (
    <span className={cn(className, open.size === 0 && 'truncate')}>
      {renderSegments(segments, open, onToggle)}
    </span>
  );
}
