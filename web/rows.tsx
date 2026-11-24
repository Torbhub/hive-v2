import React, { useContext, useRef, useState } from 'react';
import { ActionContext, Btn } from './action';
import { Input } from './components/ui/input';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet } from './components/ui/field';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './components/ui/dialog';
import { NativeSelect, NativeSelectOption } from './components/ui/native-select';
import { Textarea } from './components/ui/textarea';
import type { Approvals, ProjectMode } from '../src/types';
import { DictationControl, type DictationEngine } from './dictation';

const PRESET_REVIEW = 'First present a plan for my approval. Do not perform AWS work, transfer data, or create a job before approval. After approval, use normal Hive execution.';

const TASK_PRESETS = [
  {
    label: 'Appen — mostly processed',
    description: 'Process selected recordings into Appen’s processed MCAP episode drop under a chosen destination. Optionally force task difficulty to hard.',
    prompt: 'Process selected recordings into Appen’s processed MCAP episode drop under a chosen destination. Optionally force task difficulty to hard. Use the existing minipipe profile sellable_raw_mostly_processed. Selected recordings: [REQUIRED SELECTED RECORDINGS]. Destination prefix: [REQUIRED DESTINATION PREFIX]. Force task difficulty to hard: [OPTIONAL YES OR NO].',
  },
  {
    label: 'Turing / OpenAI',
    description: 'Build and validate a Turing delivery drop with registry-issued sequential episode IDs, configured chunking, and any required calibration packages.',
    prompt: 'Build and validate a Turing delivery drop with registry-issued sequential episode IDs, configured chunking, and any required calibration packages. Use the existing minipipe profile turing_openai. Selected recordings: [REQUIRED SELECTED RECORDINGS]. Destination: [REQUIRED DESTINATION]. Vendor code: [REQUIRED VENDOR CODE]. Chunk length: [CONFIGURE CHUNK LENGTH]. Segment rule: [CONFIGURE SEGMENT RULE]. Previews: [CONFIGURE PREVIEWS]. Registry: [REQUIRED REGISTRY]. Calibration packages: [REQUIRED CALIBRATION PACKAGES OR NONE].',
  },
  {
    label: 'PixelsTwo — raw session transfer',
    description: 'Copy complete selected sessions—all raw MCAP files plus session.json—to the configured PixelsTwo R2 destination. Do not annotate or rebake.',
    prompt: 'Copy complete selected sessions—all raw MCAP files plus session.json—to the configured PixelsTwo R2 destination. Do not annotate or rebake. Source: [REQUIRED SOURCE]. R2 destination: [REQUIRED R2 DESTINATION].',
  },
  {
    label: 'Shrink anything',
    description: 'Run verified cuts on a GitHub-hosted runner after approval. Open a pull request and upload the report and judgment task.',
    prompt: 'Use the shrink-anything workflow as a normal Hive run. Target repository: [REQUIRED OWNER/REPOSITORY]. Base branch: [REQUIRED BASE BRANCH]. Exact reviewed target commit: [REQUIRED 40-CHARACTER COMMIT]. Target check: [REQUIRED CHECK COMMAND]. Setup command: [OPTIONAL SETUP COMMAND]. After approval, dispatch the shrink-anything GitHub workflow on the rented GitHub-hosted runner. Use @el4cteo/shrink-anything from the published npm package. Do not vendor upstream source. Require the environment approval. Return the branch, pull request, workflow run, report, and .shrink/TASK.md for orchestrator judgment. Do not merge the target pull request without my approval.',
  },
  {
    label: 'Encord — sample curation',
    description: 'Historical workflow for selecting and reviewing 20–30 minute clips and preparing transcode/crop work. Requires a source set, destination, and output contract.',
  },
  {
    label: 'SieveData',
    description: 'Not configured. No job contract is defined yet.',
  },
];

function PresetMenu({ onSelect, inputRef }: {
  onSelect: (prompt: string) => void;
  inputRef: React.RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
}) {
  const { acting } = useContext(ActionContext);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  return (
    <details ref={detailsRef} className="relative">
      <summary className="inline-flex min-h-9 cursor-pointer list-none items-center rounded-md border border-input bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent max-sm:min-h-10">Preset</summary>
      <div className="absolute left-0 z-20 mt-1 w-80 max-w-[80vw] overflow-hidden rounded-md border border-zinc-700 bg-zinc-950 shadow-lg">
        {TASK_PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            data-task-preset={preset.label}
            disabled={acting || !preset.prompt}
            className="block w-full border-b border-zinc-800 px-3 py-2 text-left last:border-b-0 hover:bg-zinc-900 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => {
              if (!preset.prompt) return;
              onSelect(`${preset.prompt} ${PRESET_REVIEW}`);
              detailsRef.current?.removeAttribute('open');
              inputRef.current?.focus();
            }}
          >
            <strong className="block text-xs font-medium text-zinc-100">{preset.label}</strong>
            <span className="mt-1 block text-xs text-zinc-400">{preset.description}</span>
          </button>
        ))}
      </div>
    </details>
  );
}

export function NewTaskRow({
  project, busy, onStartTask, dictationEngine, mode = 'ask', approvals = 'manual',
}: {
  project: string;
  busy: { project: string; what: string } | null;
  onStartTask: (project: string, text: string) => Promise<boolean>;
  dictationEngine?: DictationEngine;
  mode?: ProjectMode;
  approvals?: Approvals;
}) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
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
    <div className="flex flex-wrap gap-2 border-t pt-4">
      <Textarea
        ref={inputRef}
        className="min-h-24 w-full flex-1 basis-full font-mono text-sm"
        value={text}
        placeholder="describe the task…"
        aria-label={`new task for ${project}`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <PresetMenu
        inputRef={inputRef}
        onSelect={(prompt) => setText((current) => `${current}${current && !/\s$/.test(current) ? ' ' : ''}${prompt}`)}
      />
      <DictationControl
        inputRef={inputRef} value={text} onChange={setText} label={`new task for ${project}`}
        dictationEngine={dictationEngine}
      />
      <Btn id={`start-${project}`} variant="primary" disabled={!text.trim()} onPress={() => void submit()}>
        Start task
      </Btn>
      <span className="basis-full text-xs text-muted-foreground">{`Permissions ${mode} · Approvals ${approvals} · Ctrl/Cmd+Enter to submit`}</span>
    </div>
  );
}

export function MessageRow({
  project, busy, onMessage, dictationEngine, disabled = false,
}: {
  project: string;
  busy: { project: string; what: string } | null;
  onMessage: (project: string, text: string) => Promise<boolean>;
  dictationEngine?: DictationEngine;
  disabled?: boolean;
}) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  if (busy?.project === project && busy.what === 'messaging') {
    return (
      <div className="mt-2 border-t border-zinc-800 pt-2.5 text-xs text-sky-400">sending…</div>
    );
  }
  const submit = async () => {
    const t = text.trim();
    if (!t || disabled) return;
    if (await onMessage(project, t)) setText('');
  };
  return (
    <div className="flex flex-wrap gap-2 border-t pt-4">
      <Input
        ref={inputRef}
        className="min-w-0 flex-1 basis-48 font-mono text-sm"
        value={text}
        placeholder="message the orchestrator…"
        aria-label={`message for ${project}`}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <DictationControl
        inputRef={inputRef} value={text} onChange={setText} label={`message for ${project}`}
        dictationEngine={dictationEngine} disabled={disabled}
      />
      <Btn id={`message-${project}`} disabled={disabled || !text.trim()} onPress={() => void submit()}>
        Send
      </Btn>
    </div>
  );
}

export function AddProjectRow({
  sources, onAddProject, onAdded,
}: {
  sources: string[];
  onAddProject: (name: string, path: string, source: string) => Promise<boolean>;
  onAdded?: () => void;
}) {
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [source, setSource] = useState('');
  const [adding, setAdding] = useState(false);
  const submit = async () => {
    const n = name.trim();
    const p = folder.trim();
    if (!n || adding) return;
    setAdding(true);
    try {
      if (await onAddProject(n, p, p ? '' : source)) {
        setName('');
        setFolder('');
        setSource('');
        onAdded?.();
      }
    } finally {
      setAdding(false);
    }
  };
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
    }
  };
  return (
    <FieldSet className="w-full min-w-0 gap-3" data-testid="add-project-form">
      <FieldGroup className="gap-3">
        <Field className="gap-1.5">
          <FieldLabel htmlFor="new-project-name" className="text-xs font-medium">Name</FieldLabel>
          <FieldDescription className="text-xs">Lowercase letters, numbers, and hyphens. Start with a letter. Use at most 32 characters.</FieldDescription>
          <Input
            id="new-project-name"
            className="h-9 w-full px-3 font-mono text-sm"
            value={name}
            placeholder="name"
            aria-label="new project name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onEnter}
          />
        </Field>
        <Field className="gap-1.5">
          <FieldLabel htmlFor="new-project-path" className="text-xs font-medium">Absolute path</FieldLabel>
          <FieldDescription className="text-xs">Leave blank to create a project from a source or an empty Git repository.</FieldDescription>
          <Input
            id="new-project-path"
            className="h-9 w-full px-3 font-mono text-sm"
            value={folder}
            placeholder="/absolute/path or blank"
            aria-label="new project path"
            onChange={(e) => setFolder(e.target.value)}
            onKeyDown={onEnter}
          />
        </Field>
        {!folder.trim() && (
          <Field className="gap-1.5 [&_[data-slot=native-select-wrapper]]:w-full">
            <FieldLabel htmlFor="new-project-source" className="text-xs font-medium">Source</FieldLabel>
            <FieldDescription className="text-xs">Choose an existing repository or worktree, or create an empty Git repository.</FieldDescription>
            <NativeSelect
              id="new-project-source"
              className="h-9 w-full px-3 font-mono text-xs"
              value={source}
              aria-label="new project source"
              onChange={(e) => setSource(e.target.value)}
            >
              <NativeSelectOption value="" className="bg-popover text-popover-foreground">empty Git repository</NativeSelectOption>
              {sources.map((item) => (
                <NativeSelectOption key={item} value={item} className="bg-popover text-popover-foreground">{item}</NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        )}
        <Btn
          id="add-project"
          variant="primary"
          size="default"
          className="mt-1 w-full disabled:bg-primary/60 disabled:text-primary-foreground disabled:opacity-100"
          disabled={adding || !name.trim()}
          onPress={() => void submit()}
        >
          {adding ? 'Adding project…' : 'Add project'}
        </Btn>
      </FieldGroup>
    </FieldSet>
  );
}

export function AddProjectDialog({ sources, onAddProject }: {
  sources: string[];
  onAddProject: (name: string, path: string, source: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Btn id="add-project-open" variant="outline" size="default" className="w-full" onPress={() => setOpen(true)}>
        Add project
      </Btn>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add project</DialogTitle>
          <DialogDescription>Register an existing folder or create a project from a repository source.</DialogDescription>
        </DialogHeader>
        <AddProjectRow sources={sources} onAddProject={onAddProject} onAdded={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
