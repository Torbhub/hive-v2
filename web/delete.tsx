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
  if (busy) return <span className="text-xs text-sky-400">deleting…</span>;
  if (!armed) {
    return <Btn id={`delete-${project}`} onPress={() => setArmed(true)}>Delete</Btn>;
  }
  return (
    <span className="inline-flex gap-1.5">
      <Btn id={`delete-go-${project}`} onPress={() => { setArmed(false); onDelete(project); }}>Delete project?</Btn>
      <Btn id={`delete-back-${project}`} onPress={() => setArmed(false)}>Keep project</Btn>
    </span>
  );
}
