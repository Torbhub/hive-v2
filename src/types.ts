export type HubOrchestratorState =
  | 'running'
  | 'stopped'
  | 'unknown'
  | 'none'
  | 'unregistered'
  | 'resumable';

export type HubAgentState = 'running' | 'stopped' | 'unknown' | 'unrecorded' | 'wedged';

export type HubAgent = {
  name: string;
  state: HubAgentState;
  question?: boolean;
  context?: number;
  context_assumed?: boolean;
  context_unknown?: boolean;
  context_tokens?: number;
  worktree?: string;
  session_id?: string;
  ref?: string;
};

export type HubOrchestrator = {
  state: HubOrchestratorState;
  question?: boolean;
  name?: string;
  pid?: number;
  pane?: string;
  session_id?: string;
  context?: number;
  context_assumed?: boolean;
  context_unknown?: boolean;
  context_tokens?: number;
  starting?: {
    pane: string;
    kind: string;
    at: string;
    typed?: boolean;
    sending?: boolean;
    question?: boolean;
    task?: string;
  };
};

export type ProjectMode = 'ask' | 'yolo' | 'auto';
export const PROJECT_MODES = ['ask', 'yolo', 'auto'] as const;

export type Approvals = 'manual' | 'safe' | 'smart';
export const APPROVALS_MODES = ['manual', 'safe', 'smart'] as const;

export type Decision = {
  at: string;
  project: string;
  task?: string;
  by: 'owner' | 'watch' | 'orchestrator';
  summary: string;
};

export type HubFolder = { folder: string; kind: string; branch?: string; changed?: number };

export type HubProject = {
  name: string;
  home: string;
  repos: HubFolder[];
  orchestrator: HubOrchestrator;
  agents: HubAgent[];
  open_tasks: number;
  mode?: ProjectMode;
  approvals?: Approvals;
};

export type Checkpoint = { id: string; desc: string; etaMin: number };

export type ProgressStatus = 'started' | 'ok' | 'fail' | 'skip';
export const PROGRESS_STATUSES = ['started', 'ok', 'fail', 'skip'] as const;

export type HubTask = {
  id: string;
  project: string;
  asked: string;
  state: string;
  updated: string;
  last_note: string | null;
  needs_owner: boolean;
  decisions?: { at: string; reason: string }[];
  checkpoints?: Checkpoint[];
  progress?: Record<string, { status: ProgressStatus; note?: string; at: string }>;
  last_progress_at?: string | null;
  plan_approved?: boolean;
  checkpoint_accepts?: Record<string, string>;
};

export type HubDialogOption = {
  n: number;
  label: string;
  detail: string;
  offered: boolean;
  saves_rule: boolean;
};

export type HubDialog = {
  kind: 'numbered' | 'menu' | 'none';
  text: string;
  options: HubDialogOption[];
  cursor: number | null;
  esc: boolean;
  fingerprint: string;
};

export type HubView = {
  root: string;
  hubName: string;
  projects: HubProject[];
  tasks: HubTask[];
  dialogs: Record<string, HubDialog>;
  decisions: Decision[];
  updatedAt: number;
  error: string;
};

export type HubStatus = {
  hub: { root: string; name?: string };
  projects: HubProject[];
};

export type TeamEntry = {
  name: string;
  orchestrator?: boolean;
  pane?: string;
  pane_pid?: number;
  pane_started?: string;
  worktree?: string;
  session_id?: string;
  handoff?: string;
  // Stamped by a deliberate close (cleanup/close/respawn). A crash never
  // stamps, so watch treats a stamped pane as intentionally down.
  closed_at?: string;
  // Stamped by the watchdog when the pane is frozen on a spinner with a stale
  // wire log. Cleared when the pane moves again or is relaunched.
  wedged_at?: string;
  task?: string;
  model?: string;
};

export const TASK_EVENTS = [
  'asked', 'handed', 'plan', 'question', 'answered', 'blocked',
  'overnight', 'cleanup', 'decided', 'done', 'cancelled', 'note',
  'progress', 'planaccept',
] as const;

export type TaskEvent = {
  id: string;
  project: string;
  event: (typeof TASK_EVENTS)[number];
  at: string;
  note?: string;
  checkpoints?: Checkpoint[];
  checkpoint?: string;
  status?: ProgressStatus;
};

export const NEEDS_OWNER_STATES = new Set(['plan', 'question', 'blocked']);
export const CLOSED_STATES = new Set(['done', 'cancelled']);
