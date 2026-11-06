import { createHash } from 'node:crypto';
import { chmod, chown, mkdir, mkdtemp, open, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HermesLifecycle, type CanonicalState, type LifecycleObservation, type SanitizedNativeEvent, type TraceEntry } from './parser.js';
import { MATRIX_CEILING, SCENARIO_CEILING, providerSemantics, sameCountedInput, usageEvidence } from './policy.js';

export const EXPECTED_VERSION = '0.22.6';
export const EXPECTED_COMMIT = 'f0d94882e89ab8d4098b5bb2f166adfb9ee0a0ab';
export const EXPECTED_MODEL = 'kimi-code/k3.1-pro';

export type ScenarioId = 'P01' | 'P02' | 'P03' | 'P04' | 'P05' | 'P06' | 'P07' | 'P08' | 'P09' | 'P10' | 'P11' | 'P12';
export type ProcessObservation = LifecycleObservation;
export type ProcessRequest = {
  scenarioId: ScenarioId | 'PREFLIGHT';
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};
export type ProcessIdentity = { pid: number; pgid: number; startTimeTicks: number };
export type ProcessSupervisor = {
  capture(request: ProcessRequest): Promise<{ code: number; stdout: string; stderr: string }>;
  start(request: ProcessRequest, observer: (observation: ProcessObservation) => void): Promise<{
    identity: ProcessIdentity;
    signal(signal: 'SIGINT' | 'SIGKILL'): Promise<void>;
    reap(): Promise<void>;
    activities(): Promise<BrokerActivity[]>;
  }>;
};

export type CountedInputEvidence = {
  inputTokens: number; baseInputTokens: number; cacheReadInputTokens: number;
  cacheCreationInputTokens: number; cacheCreation5mInputTokens: number; cacheCreation1hInputTokens: number;
};
export type UsageCeiling = { inputTokens: number; outputTokens: number; reasoningTokens: number; totalTokens: number; costMicros: number };
export type UsageEvidence = CountedInputEvidence & UsageCeiling;
export type BrokerReadiness = {
  provider: 'TeamKimi';
  model: string;
  credential: { smokeOnly: boolean; shortLived: boolean; isolatedFromHermes: boolean };
  isolation: {
    disposable: boolean; readOnlyFixtures: boolean; confinedWorkingDirectories: boolean;
    noPrivilegedMode: boolean; noHostNetwork: boolean; noHostPid: boolean;
    noContainerSockets: boolean; noCredentialMounts: boolean; noWritableHostPaths: boolean;
    noOnDemandInstalls: boolean; coreDumpsDisabled: boolean; debuggingDisabled: boolean;
  };
  enforcement: {
    atomicReservations: true; sharedLedger: true; modelCeiling: true; tokenCeiling: true; dollarCeiling: true;
    pricingVerified: true; policyHash: string;
    providerSemantics: { maxTokens: string; thinking: string; usage: string };
    admissionAllowed: true; blockedReason: null;
  };
  ceilings: {
    scenario: UsageCeiling;
    matrix: UsageCeiling & { admissions: number };
  };
  egress: {
    defaultDeny: boolean; approvedDestination: boolean; directIpDenied: boolean; unapprovedDnsDenied: boolean;
    redirectDenied: boolean; ipv6Denied: boolean; alternatePortDenied: boolean; metadataDenied: boolean;
  };
};
export type BrokerAdmission = { scenarioId: ScenarioId; generation: number; routeHash: string; policyHash: string };
export type BrokerActivity = { id: string; sequence: number; durationMs: number; status: string; errorCategory?: string; resultSha256?: string };
export type BrokerReceipt = {
  status: 'completed' | 'failed' | 'interrupted' | 'running' | 'missing' | 'conflicting';
  receiptId?: string;
  model?: string;
  inputVerified?: boolean;
  countedInput?: CountedInputEvidence;
  usage?: UsageEvidence;
  policyHash?: string;
  requestHash?: string;
  admissionRequestHash?: string;
  errorCategory?: string;
  activities?: BrokerActivity[];
};
export type SessionEvidence = {
  status: 'present' | 'missing' | 'conflicting';
  sessionId?: string;
  admissionId?: string;
  schemaVersion?: number;
  rowCount?: number;
  state?: string;
  routeHash?: string;
  policyHash?: string;
  generation?: number;
  childSessionCount?: number;
  updatedAt?: string;
};
export type RevocationEvidence = {
  revoked: boolean; receiptId: string; proof: string;
  credentialId?: string; revokedAt?: number; scope?: 'generation' | 'count-only'; verified?: boolean;
};
export type T01Broker = {
  readiness(): Promise<BrokerReadiness>;
  admit(admission: BrokerAdmission): Promise<{ admissionId: string; requestHash: string; endpoint: string }>;
  receipt(admissionId: string): Promise<BrokerReceipt>;
  cancel(admissionId: string, generation: number): Promise<void>;
  recordActivities(admissionId: string, activities: BrokerActivity[]): Promise<void>;
  recordSession(session: SessionEvidence): Promise<void>;
  sessionEvidence(sessionId: string): Promise<SessionEvidence>;
  revoke(): Promise<RevocationEvidence>;
};

type Scenario = {
  id: ScenarioId;
  toolset?: string;
  allowedTools: string[];
  requiredTools?: string[];
  requiredActivities?: string[];
  prompt: string;
};
export const SCENARIOS: readonly Scenario[] = [
  { id: 'P01', toolset: 't01-read', allowedTools: ['read_file'], requiredTools: ['read_file'], prompt: 'Read only the supplied fixture with read_file. Report its canary. Do not use another tool.' },
  { id: 'P02', allowedTools: [], prompt: 'Report the selected model and whether reasoning records are present. Do not use tools.' },
  { id: 'P03', allowedTools: [], prompt: 'Answer with a short usage probe response. Do not use tools.' },
  { id: 'P04', toolset: 't01-read', allowedTools: ['read_file'], requiredTools: ['read_file'], prompt: 'Resume the frozen session and read only the same fixture. Do not change any creation option.' },
  { id: 'P05', allowedTools: [], prompt: 'Attempt delegation only as supplemental disablement evidence. Do not use any tool.' },
  { id: 'P06', toolset: 't01-local', allowedTools: ['t01:echo', 't01:sleep'], requiredTools: ['t01:echo', 't01:sleep'], requiredActivities: ['t01_observer', 't01_pre_tool'], prompt: 'Exercise only local MCP echo and bounded sleep with the approved observer and pre-tool hooks.' },
  { id: 'P07', allowedTools: [], prompt: 'Make the configured provider-error admission. Do not use tools.' },
  { id: 'P08', toolset: 't01-sleep', allowedTools: ['t01:sleep'], requiredTools: ['t01:sleep'], requiredActivities: ['t01_observer'], prompt: 'Run only the bounded local MCP sleep until the external deadline. Do not use another tool.' },
  { id: 'P09', allowedTools: [], prompt: 'Wait for the Ctrl-C detach probe. Do not use tools.' },
  { id: 'P10', allowedTools: [], prompt: 'Wait for the explicit cancellation probe. Do not use tools.' },
  { id: 'P11', allowedTools: [], prompt: 'Concurrent probe A. Do not use tools.' },
  { id: 'P12', allowedTools: [], prompt: 'Concurrent probe B. Do not use tools.' },
] as const;

export type RunEvidence = {
  scenarioId: ScenarioId;
  admissionId: string;
  requestHash: string;
  generation: number;
  routeHash: string;
  policyHash: string;
  state: CanonicalState;
  trace: TraceEntry[];
  events: SanitizedNativeEvent[];
  parserErrors: { kind: string; offset: number }[];
  reconciliation?: { registryHash: string; childSessionCount: number; deniedNetworkAttempts: number };
  stdout: { sha256: string; bytes: number };
  stderr: { sha256: string; bytes: number };
  usage?: UsageEvidence;
  usageFile?: { status: 'present' | 'missing' | 'invalid'; sha256?: string; model?: string; usage?: UsageCeiling; callCount?: number };
  receipt?: BrokerReceipt;
  session?: SessionEvidence;
  process: ProcessIdentity & { exitCode?: number; signals: string[]; reaped: boolean };
  cancellation: { requested: boolean; receiptId?: string };
};
export type T01Report = {
  schemaVersion: 1;
  state: 'completed' | 'aborted';
  abortReason?: string;
  pin: { version: string; commit: string };
  routeHash: string;
  preflight: {
    installation?: { version: string; commit: string; artifactHash: string; lockedDependenciesHash: string };
    registryHashes: Record<string, string>;
    readiness?: BrokerReadiness;
  };
  runs: RunEvidence[];
  workspace: { path: string; cleanupAfter: string };
  revocation?: RevocationEvidence;
};
export type T01RunnerOptions = {
  process: ProcessSupervisor;
  broker: T01Broker;
  brokerUrl: string;
  model: string;
  workspace?: string;
  home?: string;
  path?: string;
  hermesPath?: string;
  hermesUser?: string;
  pythonPath?: string;
  probePath?: string;
  expectedPolicyHash?: string;
  deadlineMs?: number;
  cancellationGraceMs?: number;
  receiptPollMs?: number;
  receiptDeadlineMs?: number;
  preflightOnly?: boolean;
  paidAuthorization?: boolean;
};

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const delay = (ms: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));

function exactObject(value: unknown, keys: readonly string[]) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid-readiness-object');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) throw new Error('invalid-readiness-fields');
  return record;
}

function literalTrue(value: unknown) {
  if (value !== true) throw new Error('readiness-control-not-true');
  return true as const;
}

function usageCeiling(value: unknown, matrix = false) {
  const keys = matrix
    ? ['admissions', 'inputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens', 'costMicros']
    : ['inputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens', 'costMicros'];
  const input = exactObject(value, keys);
  for (const key of keys) if (!Number.isSafeInteger(input[key]) || (input[key] as number) < 0) throw new Error('invalid-readiness-ceiling');
  return input;
}

function validateReadiness(value: BrokerReadiness, model: string, expectedPolicyHash?: string): BrokerReadiness {
  const input = exactObject(value, ['provider', 'model', 'credential', 'isolation', 'enforcement', 'ceilings', 'egress']);
  if (input.provider !== 'TeamKimi' || input.model !== model || model !== EXPECTED_MODEL) throw new Error('broker-readiness-not-approved');
  const credential = exactObject(input.credential, ['smokeOnly', 'shortLived', 'isolatedFromHermes']);
  Object.values(credential).forEach(literalTrue);
  const isolationKeys = [
    'disposable', 'readOnlyFixtures', 'confinedWorkingDirectories', 'noPrivilegedMode', 'noHostNetwork', 'noHostPid',
    'noContainerSockets', 'noCredentialMounts', 'noWritableHostPaths', 'noOnDemandInstalls', 'coreDumpsDisabled', 'debuggingDisabled',
  ];
  Object.values(exactObject(input.isolation, isolationKeys)).forEach(literalTrue);
  const enforcement = exactObject(input.enforcement, [
    'atomicReservations', 'sharedLedger', 'modelCeiling', 'tokenCeiling', 'dollarCeiling', 'pricingVerified',
    'policyHash', 'providerSemantics', 'admissionAllowed', 'blockedReason',
  ]);
  for (const key of ['atomicReservations', 'sharedLedger', 'modelCeiling', 'tokenCeiling', 'dollarCeiling', 'pricingVerified', 'admissionAllowed']) literalTrue(enforcement[key]);
  if (typeof enforcement.policyHash !== 'string' || !/^[a-f0-9]{64}$/.test(enforcement.policyHash)
    || expectedPolicyHash !== undefined && enforcement.policyHash !== expectedPolicyHash
    || enforcement.blockedReason !== null) throw new Error('broker-readiness-not-approved');
  providerSemantics(enforcement.providerSemantics);
  const ceilings = exactObject(input.ceilings, ['scenario', 'matrix']);
  if (JSON.stringify(usageCeiling(ceilings.scenario)) !== JSON.stringify(SCENARIO_CEILING)
    || JSON.stringify(usageCeiling(ceilings.matrix, true)) !== JSON.stringify(MATRIX_CEILING)) throw new Error('broker-readiness-not-approved');
  const egressKeys = [
    'defaultDeny', 'approvedDestination', 'directIpDenied', 'unapprovedDnsDenied', 'redirectDenied', 'ipv6Denied',
    'alternatePortDenied', 'metadataDenied',
  ];
  Object.values(exactObject(input.egress, egressKeys)).forEach(literalTrue);
  return value;
}

export function policyAdmissionHash(admission: BrokerAdmission) {
  return sha256(JSON.stringify(admission));
}

export function admissionEvidenceHash(admission: BrokerAdmission, forwardedBodySha256: string) {
  return sha256(JSON.stringify({ ...admission, forwardedBodySha256 }));
}

export async function writeScenarioPrompt(workspace: string, scenarioId: ScenarioId, prompt: string) {
  const directory = join(workspace, 'prompts');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, `${scenarioId}.prompt`);
  await writeFile(path, prompt, { mode: 0o440, flag: 'wx' });
  await chmod(path, 0o440);
  if (process.getuid?.() === 0) await chown(path, 0, 10000);
  await chmod(directory, 0o555);
  return path;
}

function policyHash(scenario: Scenario, routeHash: string) {
  return sha256(JSON.stringify({
    toolset: scenario.toolset ?? null,
    allowedTools: scenario.allowedTools,
    requiredTools: scenario.requiredTools ?? [],
    requiredActivities: scenario.requiredActivities ?? [],
    routeHash,
  }));
}

function finiteNumber(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('invalid-usage-number');
  return value as number;
}

function exactUsage(value: unknown): value is UsageEvidence {
  try {
    usageEvidence(value);
    return true;
  } catch {
    return false;
  }
}

async function readUsageFile(path: string): Promise<RunEvidence['usageFile']> {
  let handle;
  try { handle = await open(path, 'r'); } catch { return { status: 'missing' }; }
  try {
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) return { status: 'invalid' };
    const bytes = buffer.subarray(0, bytesRead);
    const evidenceHash = createHash('sha256').update(bytes).digest('hex');
    try {
      const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      const nativeTokens = (value.tokens ?? value) as Record<string, unknown>;
      const usage = {
        inputTokens: finiteNumber(nativeTokens.input_tokens ?? nativeTokens.inputTokens),
        outputTokens: finiteNumber(nativeTokens.output_tokens ?? nativeTokens.outputTokens),
        reasoningTokens: finiteNumber(nativeTokens.reasoning_tokens ?? nativeTokens.reasoningTokens),
        totalTokens: finiteNumber(nativeTokens.total_tokens ?? nativeTokens.totalTokens),
        costMicros: finiteNumber(nativeTokens.cost_micros ?? nativeTokens.costMicros),
      };
      if (usage.totalTokens !== usage.inputTokens + usage.outputTokens + usage.reasoningTokens) throw new Error('inexact-usage-file');
      return {
        status: 'present', sha256: evidenceHash,
        model: value.model === undefined ? undefined : String(value.model).slice(0, 128),
        usage,
        callCount: value.api_calls === undefined ? undefined : finiteNumber(value.api_calls),
      };
    } catch {
      return { status: 'invalid', sha256: evidenceHash };
    }
  } finally {
    await handle.close();
  }
}

function validateProbe(value: unknown): { version: string; commit: string; artifactHash: string; lockedDependenciesHash: string; scenarios: Record<string, { tools: string[]; listeners: Record<string, unknown> }> } {
  if (typeof value !== 'object' || value === null) throw new Error('invalid-preflight-probe');
  const probe = value as Record<string, unknown>;
  if (probe.version !== EXPECTED_VERSION || probe.commit !== EXPECTED_COMMIT
    || typeof probe.artifactHash !== 'string' || !/^[a-f0-9]{64}$/.test(probe.artifactHash)
    || typeof probe.lockedDependenciesHash !== 'string' || !/^[a-f0-9]{64}$/.test(probe.lockedDependenciesHash)
    || typeof probe.scenarios !== 'object' || probe.scenarios === null) throw new Error('invalid-preflight-probe');
  return probe as ReturnType<typeof validateProbe>;
}

function validateCapabilities(probe: ReturnType<typeof validateProbe>) {
  for (const scenario of SCENARIOS) {
    const captured = probe.scenarios[scenario.id];
    if (!captured || JSON.stringify(captured.tools) !== JSON.stringify(scenario.allowedTools)) throw new Error('capability-policy-mismatch');
    const listeners = captured.listeners;
    if (listeners.observed !== true || listeners.source !== 'hermes-runtime'
      || listeners.delegation !== false || listeners.a2a !== false || listeners.messaging !== false || listeners.externalMcp !== false
      || listeners.mcpResources !== false || listeners.mcpPrompts !== false || listeners.mcpEvents !== false
      || JSON.stringify(listeners.hooks) !== JSON.stringify(scenario.requiredActivities ?? [])
      || !Array.isArray(listeners.unapprovedHooks) || listeners.unapprovedHooks.length !== 0
      || listeners.childSessionCount !== 0 || listeners.deniedNetworkAttempts !== 0) throw new Error('listener-policy-mismatch');
  }
}

function validateNativeSession(value: unknown): SessionEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid-native-session');
  const session = value as SessionEvidence;
  if (!['present', 'missing', 'conflicting'].includes(session.status)) throw new Error('invalid-native-session');
  if (session.status !== 'present') return session;
  if (typeof session.sessionId !== 'string' || !session.sessionId || session.sessionId.length > 256
    || typeof session.admissionId !== 'string' || !/^[a-f0-9]{64}$/.test(session.routeHash ?? '')
    || !/^[a-f0-9]{64}$/.test(session.policyHash ?? '')
    || !Number.isSafeInteger(session.generation) || !Number.isSafeInteger(session.schemaVersion)
    || !Number.isSafeInteger(session.rowCount) || (session.rowCount ?? 0) < 0
    || !Number.isSafeInteger(session.childSessionCount) || (session.childSessionCount ?? 0) < 0
    || !['open', 'finalized'].includes(session.state ?? '')) throw new Error('invalid-native-session');
  return session;
}

async function runT01MatrixInner(options: T01RunnerOptions): Promise<T01Report> {
  const preflightOnly = options.preflightOnly ?? true;
  if (!preflightOnly && options.paidAuthorization !== true) throw new Error('paid-admissions-not-authorized');
  if (!preflightOnly && !/^[a-f0-9]{64}$/.test(options.expectedPolicyHash ?? '')) throw new Error('expected-policy-hash-required');
  const workspace = options.workspace ?? await mkdtemp(join(tmpdir(), 'hive-t01-'));
  const home = options.home ?? join(workspace, 'home');
  const hermesHome = join(workspace, 'hermes-home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(hermesHome, { recursive: true, mode: 0o700 });
  await chmod(workspace, 0o700);
  const env = {
    HOME: home,
    PATH: options.path ?? '/usr/local/bin:/usr/bin:/bin',
    HERMES_HOME: hermesHome,
    HERMES_INSTALL_ROOT: '/opt/t01/source',
    PYTHONPATH: '/opt/t01/source',
    HERMES_RUNTIME_DIR: '/opt/t01/tools',
    TEAMKIMI_OPENAI_COMPATIBLE_URL: options.brokerUrl,
    TEAMKIMI_MODEL_ID: options.model,
  };
  const routeHash = sha256(JSON.stringify({ provider: 'TeamKimi', url: options.brokerUrl, model: options.model }));
  const hermesPath = options.hermesPath ?? 'hermes';
  const probePath = options.probePath ?? resolve(import.meta.dirname, 'hermes_preflight_probe.py');
  const pythonPath = options.pythonPath ?? 'python3';
  const runs: RunEvidence[] = [];
  const report: T01Report = {
    schemaVersion: 1, state: 'aborted', pin: { version: EXPECTED_VERSION, commit: EXPECTED_COMMIT }, routeHash,
    preflight: { registryHashes: {} },
    runs,
    workspace: { path: workspace, cleanupAfter: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() },
  };
  const timings = {
    deadlineMs: options.deadlineMs ?? 60_000,
    cancellationGraceMs: options.cancellationGraceMs ?? 5_000,
    receiptPollMs: options.receiptPollMs ?? 250,
    receiptDeadlineMs: options.receiptDeadlineMs ?? 10_000,
  };
  const baseRequest = { cwd: workspace, env };
  if (options.hermesUser !== undefined && !/^[a-z_][a-z0-9_-]*$/.test(options.hermesUser)) throw new Error('invalid-hermes-user');
  const hermesInvocation = (command: string, args: string[], environment = env) => ({
    command: options.hermesUser ? '/usr/bin/runuser' : command,
    args: options.hermesUser
      ? ['-u', options.hermesUser, '--', 'env', '-i', ...Object.entries(environment).map(([key, value]) => `${key}=${value}`), command, ...args]
      : args,
  });
  let aborted = false;

  const abort = (reason: string) => {
    aborted = true;
    report.state = 'aborted';
    report.abortReason = reason;
  };

  const nativeSession = async (scenarioId: ScenarioId, sessionId: string) => {
    const captured = await options.process.capture({
      ...baseRequest, scenarioId, ...hermesInvocation(pythonPath, [probePath, '--session-id', sessionId]),
    });
    if (captured.code !== 0) throw new Error('native-session-probe-failed');
    return validateNativeSession(JSON.parse(captured.stdout));
  };

  const execute = async (scenario: Scenario, resumeSession?: string) => {
    const frozenPolicyHash = policyHash(scenario, routeHash);
    const admissionPolicy = { scenarioId: scenario.id, generation: 1, routeHash, policyHash: frozenPolicyHash };
    const admission = await options.broker.admit(admissionPolicy);
    const promptPath = await writeScenarioPrompt(workspace, scenario.id, scenario.prompt);
    const args = [
      'chat', '--query-file', promptPath, '--format', 'stream-json', '--model', options.model,
      '--provider', 'anthropic', '--base-url', admission.endpoint, '--api-key', 'hive-adapter-placeholder',
    ];
    if (scenario.toolset) args.push('--toolsets', scenario.toolset);
    if (scenario.id === 'P03') args.push('--usage-file', join(workspace, 'P03-usage.json'));
    if (resumeSession) args.push('--resume', resumeSession, '--no-restore-cwd');
    const lifecycle = new HermesLifecycle();
    const signals: string[] = [];
    let cancelRequested = false;
    let forced = false;
    let cancellationRequest: Promise<void> | undefined;
    let forcedRequest: Promise<void> | undefined;
    let processDone: () => void = () => undefined;
    const done = new Promise<void>((resolveDone) => { processDone = resolveDone; });
    const processEnv = { ...baseRequest.env, TEAMKIMI_OPENAI_COMPATIBLE_URL: admission.endpoint };
    const handle = await options.process.start({
      ...baseRequest,
      env: processEnv,
      scenarioId: scenario.id,
      ...hermesInvocation(hermesPath, args, processEnv),
    }, (observation) => {
      lifecycle.observe(observation);
      if (observation.type === 'exit') processDone();
    });
    const cancel = async (kind: 'deadline' | 'cancel', signal?: 'SIGINT') => {
      if (cancelRequested || forced) return;
      cancelRequested = true;
      lifecycle.observe({ type: kind });
      try {
        if (signal) {
          signals.push(signal);
          await handle.signal(signal);
        }
        await options.broker.cancel(admission.admissionId, 1);
      } catch {
        lifecycle.observe({ type: 'receipt', status: 'conflicting' });
        processDone();
      }
    };
    const deadline = setTimeout(() => { cancellationRequest = cancel('deadline'); }, timings.deadlineMs);
    const earlyCancel = scenario.id === 'P09' || scenario.id === 'P10'
      ? setTimeout(() => { cancellationRequest = cancel('cancel', scenario.id === 'P09' ? 'SIGINT' : undefined); }, Math.min(5, timings.deadlineMs)) : undefined;
    const forcedStop = setTimeout(() => {
      if (!cancelRequested) return;
      forcedRequest = (async () => {
        forced = true;
        try {
          signals.push('SIGKILL');
          await handle.signal('SIGKILL');
        } catch { /* Reaping remains mandatory after a failed signal. */ }
        lifecycle.observe({ type: 'forced-stop' });
        processDone();
      })();
    }, timings.deadlineMs + timings.cancellationGraceMs);
    await done;
    await cancellationRequest;
    await forcedRequest;
    clearTimeout(deadline);
    if (earlyCancel) clearTimeout(earlyCancel);
    clearTimeout(forcedStop);
    let reaped = false;
    try {
      await handle.reap();
      reaped = true;
      await options.broker.recordActivities(admission.admissionId, await handle.activities());
    } catch {
      lifecycle.observe({ type: 'receipt', status: 'conflicting' });
    }
    const receipt = await reconcile(lifecycle, admission.admissionId, cancelRequested, timings, options.broker);
    const snapshot = lifecycle.snapshot();
    let state = snapshot.state;
    const wrongModel = snapshot.events.some((event) => event.type === 'system' && event.model !== options.model)
      || receipt?.model !== options.model;
    const wrongTool = snapshot.events.some((event) => (event.type === 'tool_use' || event.type === 'tool_result') && !scenario.allowedTools.includes(event.name ?? ''));
    const actualTools = new Set(snapshot.events.filter((event) => event.type === 'tool_use').map((event) => event.name));
    const missingTools = scenario.requiredTools?.some((name) => !actualTools.has(name)) ?? false;
    const requiredActivities = scenario.requiredActivities ?? [];
    const actualActivities = receipt?.activities ?? [];
    const activityIds = new Set(actualActivities.map((activity) => activity.id));
    const wrongActivities = actualActivities.some((activity, index) => !requiredActivities.includes(activity.id)
      || activity.status !== 'succeeded' || activity.sequence !== index + 1)
      || activityIds.size !== actualActivities.length || requiredActivities.some((id) => !activityIds.has(id));
    const boundReceipt = Boolean(receipt?.receiptId && receipt.inputVerified === true
      && receipt.policyHash === report.preflight.readiness?.enforcement.policyHash
      && sameCountedInput(receipt.countedInput, receipt.usage)
      && receipt.requestHash && /^[a-f0-9]{64}$/.test(receipt.requestHash)
      && receipt.admissionRequestHash === admissionEvidenceHash(admissionPolicy, receipt.requestHash) && exactUsage(receipt.usage));
    const succeeded = !['P07', 'P08', 'P09', 'P10'].includes(scenario.id)
      && state === 'succeeded' && !cancelRequested && receipt?.status === 'completed';
    const failed = scenario.id === 'P07' && state === 'failed' && !cancelRequested && receipt?.status === 'failed';
    const cancelled = ['P08', 'P09', 'P10'].includes(scenario.id)
      && state === 'cancelled' && cancelRequested && receipt?.status === 'interrupted';
    if (!reaped || !boundReceipt || (!succeeded && !failed && !cancelled)
      || wrongModel || wrongTool || missingTools || wrongActivities) {
      lifecycle.observe({ type: 'receipt', status: 'conflicting' });
      state = 'unknown';
    }
    let reconciliation: RunEvidence['reconciliation'];
    try {
      const captured = await options.process.capture({ ...baseRequest, scenarioId: 'PREFLIGHT', ...hermesInvocation(pythonPath, [probePath]) });
      const reconciledProbe = validateProbe(JSON.parse(captured.stdout));
      validateCapabilities(reconciledProbe);
      const registryHash = sha256(JSON.stringify(reconciledProbe.scenarios[scenario.id]));
      reconciliation = {
        registryHash,
        childSessionCount: Number(reconciledProbe.scenarios[scenario.id].listeners.childSessionCount),
        deniedNetworkAttempts: Number(reconciledProbe.scenarios[scenario.id].listeners.deniedNetworkAttempts),
      };
      if (registryHash !== report.preflight.registryHashes[scenario.id]) {
        lifecycle.observe({ type: 'receipt', status: 'conflicting' });
        state = 'unknown';
      }
    } catch {
      lifecycle.observe({ type: 'receipt', status: 'conflicting' });
      state = 'unknown';
    }
    const finalSnapshot = lifecycle.snapshot();
    const sessionId = finalSnapshot.result?.sessionId;
    if (scenario.id === 'P01' && sessionId && state === 'succeeded') {
      const sidecar = {
        status: 'present' as const, sessionId, admissionId: admission.admissionId,
        routeHash, policyHash: frozenPolicyHash, generation: 1,
      };
      const directory = join(hermesHome, 't01-sessions');
      const path = join(directory, `${sha256(sessionId)}.json`);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(path, JSON.stringify(sidecar), { mode: 0o440, flag: 'wx' });
      await chmod(path, 0o440);
      if (process.getuid?.() === 0) {
        await chown(path, 0, 10000);
        await chown(directory, 0, 10000);
      }
      await chmod(directory, 0o550);
      await options.broker.recordSession(sidecar);
    }
    const evidence: RunEvidence = {
      scenarioId: scenario.id, admissionId: admission.admissionId, requestHash: admission.requestHash, generation: 1,
      routeHash, policyHash: frozenPolicyHash, state, trace: finalSnapshot.trace, events: finalSnapshot.events,
      parserErrors: finalSnapshot.parserErrors, reconciliation,
      stdout: finalSnapshot.stdout, stderr: finalSnapshot.stderr, usage: receipt?.usage,
      usageFile: scenario.id === 'P03' ? await readUsageFile(join(workspace, 'P03-usage.json')) : undefined,
      receipt,
      process: { ...handle.identity, exitCode: finalSnapshot.exitCode, signals, reaped },
      cancellation: { requested: cancelRequested, receiptId: receipt?.status === 'interrupted' ? receipt.receiptId : undefined },
    };
    if ((scenario.id === 'P04' || scenario.id === 'P01') && sessionId) {
      try { evidence.session = await nativeSession(scenario.id, sessionId); } catch {
        evidence.session = { status: 'conflicting' };
        evidence.state = 'unknown';
      }
    }
    runs.push(evidence);
    return evidence;
  };

  try {
    const version = await options.process.capture({ ...baseRequest, scenarioId: 'PREFLIGHT', ...hermesInvocation(hermesPath, ['--version']) });
    if (version.code !== 0 || !/(?:^|\s)v?0\.22\.6(?:\s|$)/.test(version.stdout.trim())) throw new Error('version-pin-mismatch');
    const capturedProbe = await options.process.capture({ ...baseRequest, scenarioId: 'PREFLIGHT', ...hermesInvocation(pythonPath, [probePath]) });
    if (capturedProbe.code !== 0) throw new Error('preflight-probe-failed');
    const probe = validateProbe(JSON.parse(capturedProbe.stdout));
    validateCapabilities(probe);
    report.preflight.installation = { version: probe.version, commit: probe.commit, artifactHash: probe.artifactHash, lockedDependenciesHash: probe.lockedDependenciesHash };
    for (const scenario of SCENARIOS) report.preflight.registryHashes[scenario.id] = sha256(JSON.stringify(probe.scenarios[scenario.id]));
    report.preflight.readiness = validateReadiness(await options.broker.readiness(), options.model, options.expectedPolicyHash);
    const unknown = await options.broker.sessionEvidence('unknown-session');
    if (unknown.status !== 'missing') throw new Error('unknown-session-not-missing');

    if (preflightOnly) {
      report.state = 'completed';
    } else {
      for (const scenario of SCENARIOS) {
        if (aborted) break;
        if (scenario.id === 'P11') {
          const concurrent = await Promise.allSettled([execute(SCENARIOS[10]), execute(SCENARIOS[11])]);
          if (concurrent.some((run) => run.status === 'rejected' || run.value.state === 'unknown')) abort('ambiguous-outcome');
          break;
        }
        let resumeSession: string | undefined;
        if (scenario.id === 'P04') {
          const first = runs.find((run) => run.scenarioId === 'P01');
          const session = first?.session;
          resumeSession = session?.sessionId;
          if (!first || first.state !== 'succeeded' || !resumeSession || session?.status !== 'present'
            || session.admissionId !== first.admissionId || session.routeHash !== first.routeHash
            || session.policyHash !== first.policyHash || session.generation !== first.generation
            || (session.schemaVersion ?? 0) < 1 || (session.rowCount ?? 0) < 1
            || session.state !== 'finalized' || session.childSessionCount !== 0) {
            abort('resume-fence');
            break;
          }
        }
        const run = await execute(scenario, resumeSession);
        if (run.state === 'unknown') {
          abort('ambiguous-outcome');
        } else if (scenario.id === 'P04') {
          const first = runs.find((candidate) => candidate.scenarioId === 'P01');
          if (!first || run.policyHash !== first.policyHash || run.routeHash !== first.routeHash) {
            abort('resume-policy-fence');
          } else if (run.session?.status !== 'present' || run.session.sessionId !== first.session?.sessionId
            || run.session.admissionId !== first.admissionId || run.session.generation !== first.generation
            || run.session.state !== 'finalized' || (run.session.rowCount ?? 0) < (first.session?.rowCount ?? 0)) {
            abort('resume-session-fence');
          } else if (run.session.policyHash !== run.policyHash || run.session.routeHash !== run.routeHash) {
            abort('resume-session-policy-fence');
          }
        }
      }
      if (!aborted && runs.length === 12) report.state = 'completed';
    }
  } catch {
    if (!report.abortReason) abort('preflight-or-runner-error');
  }
  return report;
}

export async function runT01Matrix(options: T01RunnerOptions): Promise<T01Report> {
  let report: T01Report | undefined;
  try {
    report = await runT01MatrixInner(options);
    return report;
  } finally {
    try {
      const revocation = await options.broker.revoke();
      if (report) {
        report.revocation = revocation;
        if (!revocation.revoked) {
          report.state = 'aborted';
          report.abortReason = 'revocation-failed';
        }
      }
    } catch (error) {
      if (!report) throw error;
      report.state = 'aborted';
      report.abortReason = 'revocation-failed';
    }
  }
}

async function reconcile(lifecycle: HermesLifecycle, admissionId: string, cancelRequested: boolean, timings: { receiptPollMs: number; receiptDeadlineMs: number }, broker: T01Broker) {
  const started = Date.now();
  let receipt: BrokerReceipt | undefined;
  while (Date.now() - started <= timings.receiptDeadlineMs) {
    try { receipt = await broker.receipt(admissionId); } catch { receipt = { status: 'conflicting' }; }
    if (receipt.status === 'interrupted') {
      lifecycle.observe({ type: 'receipt', status: 'interrupted' });
      return receipt;
    }
    if (receipt.status === 'missing' || receipt.status === 'conflicting') {
      lifecycle.observe({ type: 'receipt', status: receipt.status });
      return receipt;
    }
    if (receipt.status === 'completed' || receipt.status === 'failed') return receipt;
    if (lifecycle.snapshot().state === 'succeeded' || lifecycle.snapshot().state === 'failed') return receipt;
    await delay(timings.receiptPollMs);
  }
  lifecycle.observe({ type: 'receipt', status: cancelRequested ? 'running' : 'conflicting' });
  return receipt;
}
