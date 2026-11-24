import React, { useState } from 'react';
import { Btn } from './action';

export function DeleteProjectControl({
  project, busy, onDelete,
}: {
  project: string;
  busy: boolean;
  onDelete: (project: string) => void;
}) {
  const [armed, setArmed] = useState(false);
  if (busy) return <span className="text-xs text-sky-400">removing from Hive…</span>;
  if (!armed) {
    return <Btn id={`delete-${project}`} onPress={() => setArmed(true)}>Remove project from Hive</Btn>;
  }
  return (
    <span className="flex flex-col gap-2">
      <span className="text-xs text-muted-foreground">This removes only the Hive registration. Local Git files and task records remain untouched.</span>
      <span className="inline-flex flex-wrap gap-1.5">
        <Btn id={`delete-go-${project}`} onPress={() => { setArmed(false); onDelete(project); }}>Remove from Hive?</Btn>
        <Btn id={`delete-back-${project}`} onPress={() => setArmed(false)}>Keep project</Btn>
      </span>
    </span>
  );
}
