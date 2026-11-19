import type { DecisionCard } from './decisions.js';

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
  operator_question?: boolean;
  operator_waiting?: boolean;
  screen_question?: boolean;
  context?: number;
  context_assumed?: boolean;
  context_unknown?: boolean;
  context_tokens?: number;
  auto_compact?: boolean;
  compaction?: Omit<CompactionState, 'instruction'>;
  worktree?: string;
  session_id?: string;
  ref?: string;
};

export type HubOrchestrator = {
  state: HubOrchestratorState;
  question?: boolean;
  operator_question?: boolean;
  operator_waiting?: boolean;
  screen_question?: boolean;
  name?: string;
  pid?: number;
  pane?: string;
  session_id?: string;
  children?: number;
  context?: number;
  context_assumed?: boolean;
  context_unknown?: boolean;
  context_tokens?: number;
  auto_compact?: boolean;
  compaction?: Omit<CompactionState, 'instruction'>;
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
  watch_key?: string;
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

export type QuestionChoice = { id: string; label: string; description: string };

export type OperatorQuestion = {
  id: string;
  question: string;
  context: string;
  priority: number;
  choices: QuestionChoice[];
  recommended: string;
  decision?: DecisionCard;
};

export type DecisionGrant = {
  batch: string;
  question: string;
  project: string;
  fingerprint: string;
  expiresAt: string;
  executionAuthority: 'push' | 'none';
  agent?: string;
  task?: string;
  grantId?: string;
  profileAclEpoch?: number;
  approverSubject?: string;
  approverGrantId?: string;
  approverAclEpoch?: number;
  consumedAt?: string;
};

export type DecisionAnswer = {
  action: DecisionCard['action'];
  outcome: 'refresh' | 'approve' | 'cancel' | 'details' | 'other';
  facts: DecisionCard['facts'];
  grant?: DecisionGrant;
};

export type QuestionAnswer = { question: string; choice: string; text?: string; decision?: DecisionAnswer };

export type QuestionBatch = {
  id: string;
  project: string;
  agent: string;
  context: string;
  questions: OperatorQuestion[];
  status: 'open' | 'answered' | 'cancelled';
  createdAt: string;
  waitHeartbeatAt?: string;
  closedAt?: string;
  answers?: QuestionAnswer[];
};

export type HubView = {
  root: string;
  hubName: string;
  projects: HubProject[];
  tasks: HubTask[];
  dialogs: Record<string, HubDialog>;
  decisions: Decision[];
  questions: QuestionBatch[];
  // Total open batches, including any beyond the view's first 50. Optional
  // so older fixtures and callers without a count stay valid.
  questionsTotal?: number;
  updatedAt: number;
  error: string;
};

export type HubStatus = {
  hub: { root: string; name?: string };
  projects: HubProject[];
};

export type CompactionStatus = 'sending' | 'submitted' | 'queued' | 'in_progress' | 'compacted' | 'failed' | 'ambiguous';

export type CompactionState = {
  session_id: string;
  status: CompactionStatus;
  at: string;
  attempts: number;
  activity_at?: number;
  instruction_hash?: string;
  rejection_before?: number;
  completion_before?: number;
  pre_input?: boolean;
  retry_at?: string;
  detail?: string;
};

export type DaydreamAutomationReason = 'idle' | 'before_compaction';
export type DaydreamAutomationUnknownStage = 'reservation' | 'child' | 'prompt' | 'fork' | 'compaction' | 'result';
export type DaydreamAutomationUsage = { runs: number; prompts: number; compactions: number; tokens: number };
export type DaydreamAutomationCeilings = { runs: number; prompts: number; compactions: number };
export type DaydreamAutomationBudgets = { perAgent: DaydreamAutomationCeilings; perProject: DaydreamAutomationCeilings };
export type DaydreamAutomationOutcome = {
  daydreamId: string;
  status: 'recovered' | 'unknown' | 'missing';
  prompts: number;
  compactions: number;
  tokens: number;
  unknownStage?: DaydreamAutomationUnknownStage;
};
export type DaydreamAutomationRunInput = {
  root: string;
  project: string;
  agent: TeamEntry;
  daydreamId: string;
  sessionId: string;
  activityAt: number;
  reason: DaydreamAutomationReason;
  native?: DaydreamNativeClient;
  now: number;
};
export type DaydreamAutomationReconcileInput = {
  root: string;
  project: string;
  daydreamId: string;
  parentSessionId: string;
  ownerPid?: number;
  ownerStartTime?: string;
  native?: DaydreamNativeClient;
  now: number;
};
export type DaydreamAutomationRunner = {
  run(input: DaydreamAutomationRunInput): Promise<DaydreamAutomationOutcome>;
  reconcile(input: DaydreamAutomationReconcileInput): Promise<DaydreamAutomationOutcome>;
};
export type DaydreamAutomationOptions = {
  runner?: DaydreamAutomationRunner;
  native?: DaydreamNativeClient;
  now?: number;
  idleMs?: number;
  activityAt?: number | null;
  trigger?: DaydreamAutomationReason;
  budgets?: DaydreamAutomationBudgets;
};
export type DaydreamAutomationRun = {
  schemaVersion: 1;
  fingerprint: string;
  daydreamId: string;
  project: string;
  agentKey: string;
  agentName: string;
  sessionId: string;
  ownerPid?: number;
  ownerStartTime?: string;
  worktree?: string;
  activityAt: number;
  reason: DaydreamAutomationReason;
  status: 'reserved' | 'recovered' | 'unknown';
  fenced: boolean;
  usageRecorded: boolean;
  reservedPrompts: number;
  reservedCompactions: number;
  prompts: number;
  compactions: number;
  tokens: number;
  createdAt: string;
  updatedAt: string;
  unknownStage?: DaydreamAutomationUnknownStage;
  error?: string;
  reconciledAt?: string;
};
export type DaydreamAutomationReservation = DaydreamAutomationRun;
export type DaydreamAutomationAgentStatus = {
  name: string;
  worktree?: string;
  daydreamAutomation: boolean;
  fencedDaydreamId: string | null;
};
export type DaydreamAutomationProjectStatus = {
  project: string;
  agents: DaydreamAutomationAgentStatus[];
  runs: DaydreamAutomationRun[];
  daily: { project: DaydreamAutomationUsage; agents: Record<string, DaydreamAutomationUsage> };
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
  // The agent that spawned this one (the pane's HIVE_AGENT). A spawn from the
  // owner's shell has none; the orchestrator's children carry its name.
  parent?: string;
  // Stamped by a deliberate close (cleanup/close/respawn). A crash never
  // stamps, so watch treats a stamped pane as intentionally down.
  closed_at?: string;
  // Stamped by the watchdog when the pane is frozen on a spinner with a stale
  // wire log. Cleared when the pane moves again or is relaunched.
  wedged_at?: string;
  task?: string;
  model?: string;
  auto_compact?: boolean;
  daydream_automation?: boolean;
  compaction?: CompactionState;
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

export type NativeBranchScope = { root: string; project: string };
export type NativeBranchCreateScope = NativeBranchScope & { agent: string };
export type NativeBranchSnapshotEntry = { id: string; contentHash: string };
export type NativeBranchSnapshot = {
  count: number;
  headId: string | null;
  historyHash: string;
  messages: NativeBranchSnapshotEntry[];
};
export type NativeBranchEvidence = { messageId: string; contentHash: string };
export type NativeBranchFinding = {
  id: string;
  answer: string;
  recommendation: string;
  uncertainty: string;
  nativeEvidence: NativeBranchEvidence[];
};
export type NativeBranchResult = {
  schemaVersion: 1;
  branchId: string;
  childHistoryHash: string;
  findings: NativeBranchFinding[];
};
export type NativeBranchReview = {
  branchId: string;
  findingIds: string[];
  digest: string;
  parentHistoryHash: string;
  childHistoryHash: string;
  reviewer: string;
  consumerGrantId: string;
  consumerAclEpoch: number;
  approverGrantId: string;
  approverAclEpoch: number;
  createdAt: string;
  expiresAt: string;
};
export type NativeBranchRejoin = {
  status: 'submitting' | 'unknown' | 'rejoined';
  reviewDigest: string;
  promptId: string;
  promptHash: string;
  intentAt: string;
  nativeMessageId?: string;
  rejoinedAt?: string;
  detail?: string;
};
export type NativeBranchRecord = {
  schemaVersion: 1;
  id: string;
  kind: 'child' | 'fork';
  purpose: string;
  parentSessionId: string;
  childSessionId: string | null;
  workspaceId: string;
  cwd: string;
  scope: { project: string; agent: string; task: string };
  parentSnapshot: NativeBranchSnapshot;
  childSnapshot: NativeBranchSnapshot | null;
  status: 'creating' | 'active' | 'stale' | 'diverged' | 'unknown' | 'rejoined';
  createdAt: string;
  updatedAt: string;
  error?: string;
  result?: NativeBranchResult & { digest: string; recordedAt: string };
  review?: NativeBranchReview;
  rejoin?: NativeBranchRejoin;
};

export type NativeBranchFindingDto = Pick<NativeBranchFinding, 'id' | 'answer' | 'recommendation' | 'uncertainty'>;
export type NativeBranchSummary = {
  id: string;
  status: NativeBranchRecord['status'];
  purpose: string;
  agent: string;
  task: string;
  createdAt: string;
  updatedAt: string;
  hasResult: boolean;
  error?: string;
};
export type NativeBranchReviewDto = {
  digest: string;
  findingIds: string[];
  createdAt: string;
  expiresAt: string;
  promptId: string;
  prompt: string;
};
export type NativeBranchRejoinDto = {
  status: NativeBranchRejoin['status'];
  reviewDigest: string;
  promptId: string;
  nativeMessageId?: string;
  rejoinedAt?: string;
};
export type NativeBranchDetail = NativeBranchSummary & {
  kind: NativeBranchRecord['kind'];
  findings: NativeBranchFindingDto[];
  review?: NativeBranchReviewDto;
  rejoin?: NativeBranchRejoinDto;
};

export type NativeTextPart = { type: 'text'; text: string };
export type NativeSession = {
  id: string;
  workspace_id: string;
  metadata: {
    cwd: string;
    hive_branch_id?: string;
    hive_daydream_id?: string;
    parent_session_id?: string;
    child_session_kind?: string;
    [key: string]: unknown;
  };
};
export type NativeMessage = {
  id: string;
  session_id: string;
  role: string;
  content: { type: string; [key: string]: unknown }[];
  created_at: string;
};
export type NativePrompt = {
  prompt_id: string;
  user_message_id: string;
  status: string;
  content: NativeTextPart[];
  created_at: string;
};
export type NativeBranchClient = {
  getSession(sessionId: string): Promise<NativeSession>;
  createChild(sessionId: string, input: { title: string; metadata: Record<string, unknown> }): Promise<NativeSession>;
  forkSession(sessionId: string, input: { title: string; metadata: Record<string, unknown> }): Promise<NativeSession>;
  listChildren(sessionId: string, options?: { pageSize?: number }): Promise<{ items: NativeSession[]; has_more: boolean }>;
  listMessages(sessionId: string, options?: {
    beforeId?: string;
    pageSize?: number;
    role?: 'user' | 'assistant' | 'tool' | 'system';
  }): Promise<{ items: NativeMessage[]; has_more: boolean }>;
  submitPrompt(sessionId: string, input: NativePromptInput): Promise<NativePrompt>;
};

export type NativePromptInput = {
  promptId: string;
  content: NativeTextPart[];
  agentId?: string;
  permissionMode?: 'manual';
};
export type NativeTranscriptOp = { type?: string; [key: string]: unknown };
export type NativeTranscriptBatch = { seq: number; ops: NativeTranscriptOp[] };
export type NativeTranscriptOps = {
  agent_id: string;
  batches: NativeTranscriptBatch[];
  latest_seq: number;
  complete: boolean;
};
export type NativeTranscriptFrame = { frameId: string; kind: string; role?: string; text?: string };
export type NativeTranscriptStep = { stepId: string; frames: NativeTranscriptFrame[] };
export type NativeTranscriptPrompt = {
  promptId: string;
  status: string;
  userMessageId: string;
  content: NativeTextPart[];
};
export type NativeTranscriptTurn = {
  kind: 'turn';
  turnId: string;
  triggerPromptId?: string;
  state: string;
  wedged?: boolean;
  steps: NativeTranscriptStep[];
};
export type NativeTranscriptMarker = { kind: string; [key: string]: unknown };
export type NativeTranscriptItem = NativeTranscriptTurn | NativeTranscriptMarker;
export type NativeTranscriptRosterAgent = { agentId: string; type?: 'main' | 'sub' | 'independent' };
export type NativeTranscriptPage = {
  agent_id: string;
  prompts: NativeTranscriptPrompt[];
  items: NativeTranscriptItem[];
  has_more: boolean;
  agents: NativeTranscriptRosterAgent[];
  seq?: number;
};
export type NativeServerMeta = { server_id: string; started_at: string };
export type NativeTranscriptWatermark = { agent_id: string; seq: number };
export type DaydreamNativeClient = NativeBranchClient & {
  createBtw(sessionId: string): Promise<{ agent_id: string }>;
  getTranscript(sessionId: string, input: { agentId: string; pageSize: number }): Promise<NativeTranscriptPage>;
  getServerMeta(): Promise<NativeServerMeta>;
  getTranscriptWatermark(sessionId: string, input: { agentId: string; pageSize: number }): Promise<NativeTranscriptWatermark>;
  compactSession(sessionId: string, input: { instruction: string }): Promise<Record<string, never>>;
  listTranscriptOps(sessionId: string, input: { agentId: string; sinceSeq: number }): Promise<NativeTranscriptOps>;
};

export type DaydreamCitation =
  | { kind: 'native'; messageId: string; contentHash: string; quote: string }
  | { kind: 'task'; eventHash: string; quote: string }
  | { kind: 'handoff'; pathHash: string; contentHash: string; quote: string };
export type DaydreamFact = {
  id: string;
  answer: string;
  whyNow: string;
  uncertainty: string;
  citations: DaydreamCitation[];
};
export type DaydreamBrief = {
  schemaVersion: 1;
  daydreamId: string;
  phase: 'mine' | 'recover';
  checkpointId: string;
  questionHash: string;
  sourceHistoryHash: string;
  facts: DaydreamFact[];
  unknowns: string[];
};
export type DaydreamProvenance = {
  sessionId: string;
  agentId: string;
  promptId: string;
  turnId: string;
  stepId: string;
  frameId: string;
  frameHash: string;
};
export type DaydreamPromptIntent = {
  phase: 'mine' | 'recover';
  status: 'submitting' | 'accepted' | 'unknown';
  agentId?: string;
  promptId: string;
  promptHash: string;
  intentAt: string;
  nativeMessageId?: string;
};
export type DaydreamForkIntent = { status: 'forking' | 'unknown' | 'completed'; intentAt: string };
export type DaydreamCompactionIntent = {
  status: 'submitting' | 'unknown' | 'completed';
  instructionHash: string;
  nonce: string;
  intentAt: string;
  watermark: number;
  serverId: string;
  serverStartedAt: string;
};
export type DaydreamStatus =
  | 'creating'
  | 'mining'
  | 'mined'
  | 'forked'
  | 'compacting'
  | 'compacted'
  | 'recovering'
  | 'recovered'
  | 'unknown';
export type DaydreamRecord = {
  schemaVersion: 1;
  id: string;
  status: DaydreamStatus;
  parentSessionId: string;
  childSessionId: string | null;
  checkpointSessionId: string | null;
  workspaceId: string;
  cwd: string;
  scope: { project: string; agent: string; task: string };
  checkpointId: string;
  questionHash: string;
  sourceTaskHash: string;
  handoffPathHash: string;
  handoffContentHash: string;
  parentSnapshot: NativeBranchSnapshot;
  childSnapshot: NativeBranchSnapshot | null;
  prompt?: DaydreamPromptIntent;
  fork?: DaydreamForkIntent;
  compaction?: DaydreamCompactionIntent;
  provenance?: DaydreamProvenance;
  recoveryProvenance?: DaydreamProvenance;
  minedBrief?: DaydreamBrief;
  recoveredBrief?: DaydreamBrief;
  factsHash?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
};
