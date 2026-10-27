import React, { useState } from 'react';
import { Btn } from './action';
import { Input } from './components/ui/input';

export function NewTaskRow({
  project, busy, onStartTask,
}: {
  project: string;
  busy: { project: string; what: string } | null;
  onStartTask: (project: string, text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  if (busy?.project === project && busy.what === 'starting') {
    return (
      <div className="mt-2 border-t border-zinc-800 pt-2.5 text-xs text-sky-400">starting…</div>
    );
  }
  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    if (await onStartTask(project, t)) setText('');
  };
  return (
    <div className="mt-2 flex gap-2 border-t border-zinc-800 pt-2.5">
      <Input
        className="font-mono text-xs"
        value={text}
        placeholder="describe the task…"
        aria-label={`new task for ${project}`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <Btn id={`start-${project}`} variant="primary" disabled={!text.trim()} onPress={() => void submit()}>
        Start task
      </Btn>
    </div>
  );
}

export function MessageRow({
  project, busy, onMessage,
}: {
  project: string;
  busy: { project: string; what: string } | null;
  onMessage: (project: string, text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  if (busy?.project === project && busy.what === 'messaging') {
    return (
      <div className="mt-2 border-t border-zinc-800 pt-2.5 text-xs text-sky-400">sending…</div>
    );
  }
  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    if (await onMessage(project, t)) setText('');
  };
  return (
    <div className="mt-2 flex gap-2 border-t border-zinc-800 pt-2.5">
      <Input
        className="font-mono text-xs"
        value={text}
        placeholder="message the orchestrator…"
        aria-label={`message for ${project}`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <Btn id={`message-${project}`} disabled={!text.trim()} onPress={() => void submit()}>
        Send
      </Btn>
    </div>
  );
}

export function AddProjectRow({
  sources, onAddProject,
}: {
  sources: string[];
  onAddProject: (name: string, path: string, source: string) => Promise<boolean>;
}) {
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [source, setSource] = useState('');
  const submit = async () => {
    const n = name.trim();
    const p = folder.trim();
    if (!n) return;
    if (await onAddProject(n, p, p ? '' : source)) {
      setName('');
      setFolder('');
      setSource('');
    }
  };
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
    }
  };
  return (
    <div className="mt-2 flex flex-wrap gap-2 border-t border-zinc-800 pt-2.5">
      <Input
        className="w-36 font-mono text-xs"
        value={name}
        placeholder="name"
        aria-label="new project name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={onEnter}
      />
      <Input
        className="flex-1 font-mono text-xs"
        value={folder}
        placeholder="/absolute/path or blank"
        aria-label="new project path"
        onChange={(e) => setFolder(e.target.value)}
        onKeyDown={onEnter}
      />
      {!folder.trim() && (
        <select
          className="flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-100"
          value={source}
          aria-label="new project source"
          onChange={(e) => setSource(e.target.value)}
        >
          <option value="">empty Git repository</option>
          {sources.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      )}
      <Btn
        id="add-project"
        variant="primary"
        disabled={!name.trim()}
        onPress={() => void submit()}
      >
        Add project
      </Btn>
    </div>
  );
}
