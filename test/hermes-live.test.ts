import { spawnSync } from 'node:child_process';
import { chmod, chown, lutimes, mkdir, mkdtemp, readFile, readdir, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approveEvidenceExport,
  cleanupEvidence,
  cleanupManifest,
  cleanupWorkspace,
  exportEvidence,
  verifyEvidenceExport,
  verifyEvidenceReport,
} from '../tools/hermes-live/evidence.js';
import { attestation, matrixUsage, policyHash as expectedPolicyHash } from './hermes-live-fixtures.js';
import { HermesLifecycle, HermesParser } from '../tools/hermes-live/parser.js';
import {
  EXPECTED_COMMIT,
  EXPECTED_MODEL,
  SCENARIOS,
  admissionEvidenceHash,
  policyAdmissionHash,
  runT01Matrix,
  type BrokerAdmission,
  type BrokerReceipt,
  type BrokerReadiness,
  type ProcessObservation,
  type ProcessRequest,
  type ProcessSupervisor,
  type SessionEvidence,
  type T01Broker,
} from '../tools/hermes-live/runner.js';

const tokens = { input: 3, output: 2, total: 5, cache_read: 0, cache_write: 0 };
const result = (exitCode = 0, sessionId = 'session-1') => ({
  timestamp: 1,
  type: 'result',
  session_id: sessionId,
  exit_code: exitCode,
  text: 'sensitive final response',
  tokens,
  duration_ms: 10,
});
const encode = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);

function lifecycle(observations: Parameters<HermesLifecycle['observe']>[0][]) {
  const parser = new HermesParser();
  const run = new HermesLifecycle(parser);
  for (const observation of observations) run.observe(observation);
  return run.snapshot();
}

const usage = matrixUsage;
const counted = {
  inputTokens: usage.inputTokens, baseInputTokens: usage.baseInputTokens,
  cacheReadInputTokens: usage.cacheReadInputTokens, cacheCreationInputTokens: usage.cacheCreationInputTokens,
  cacheCreation5mInputTokens: usage.cacheCreation5mInputTokens, cacheCreation1hInputTokens: usage.cacheCreation1hInputTokens,
};

function readiness(): BrokerReadiness {
  return {
    provider: 'TeamKimi', model: EXPECTED_MODEL,
    credential: { smokeOnly: true, shortLived: true, isolatedFromHermes: true },
    isolation: {
      disposable: true, readOnlyFixtures: true, confinedWorkingDirectories: true,
      noPrivilegedMode: true, noHostNetwork: true, noHostPid: true,
      noContainerSockets: true, noCredentialMounts: true, noWritableHostPaths: true,
      noOnDemandInstalls: true, coreDumpsDisabled: true, debuggingDisabled: true,
    },
    enforcement: {
      atomicReservations: true, sharedLedger: true, modelCeiling: true, tokenCeiling: true, dollarCeiling: true,
      pricingVerified: true, policyHash: expectedPolicyHash,
      providerSemantics: {
        maxTokens: 'independent-output-ceiling', thinking: 'independent-reasoning-ceiling',
        usage: 'messages-total-input-output-reasoning-v1',
      },
      admissionAllowed: true, blockedReason: null,
    },
    ceilings: {
      scenario: { inputTokens: 16000, outputTokens: 2000, reasoningTokens: 4000, totalTokens: 22000, costMicros: 500000 },
      matrix: { admissions: 12, inputTokens: 96000, outputTokens: 12000, reasoningTokens: 24000, totalTokens: 132000, costMicros: 5000000 },
    },
    egress: {
      defaultDeny: true, approvedDestination: true, directIpDenied: true, unapprovedDnsDenied: true,
      redirectDenied: true, ipv6Denied: true, alternatePortDenied: true, metadataDenied: true,
    },
  };
}

class FakeBroker implements T01Broker {
  readonly admissions: BrokerAdmission[] = [];
  readonly cancellations: string[] = [];
  readonly activityRecords = new Map<string, { id: string; sequence: number; durationMs: number; status: string }[]>();
  readonly sessions = new Map<string, SessionEvidence>();
  revoked = false;
  receiptOverrides = new Map<string, BrokerReceipt[]>();
  sessionOverrides = new Map<string, SessionEvidence>();
  readinessValue = readiness();
  unknownSession: SessionEvidence = { status: 'missing' };

  async readiness() { return this.readinessValue; }
  async admit(admission: BrokerAdmission) {
    this.admissions.push(admission);
    return { admissionId: `admission-${admission.scenarioId}`, requestHash: policyAdmissionHash(admission), endpoint: 'http://127.0.0.1:9999' };
  }
  async receipt(admissionId: string): Promise<BrokerReceipt> {
    const overrides = this.receiptOverrides.get(admissionId);
    if (overrides) return overrides.length ? overrides.shift()! : { status: 'running' };
    const scenarioId = admissionId.replace('admission-', '');
    const common = {
      receiptId: `receipt-${scenarioId}`, model: EXPECTED_MODEL, inputVerified: true, usage,
      countedInput: counted, policyHash: expectedPolicyHash, requestHash: 'd'.repeat(64),
      admissionRequestHash: admissionEvidenceHash(this.admissions.find((entry) => entry.scenarioId === scenarioId)!, 'd'.repeat(64)),
      activities: this.activityRecords.get(admissionId) ?? [],
    };
    if (['P08', 'P09', 'P10'].includes(scenarioId)) return { status: 'interrupted', ...common };
    if (scenarioId === 'P07') return { status: 'failed', ...common, errorCategory: 'provider' };
    return { status: 'completed', ...common };
  }
  async cancel(admissionId: string, generation: number) {
    if (generation !== 1) throw new Error('generation');
    this.cancellations.push(admissionId);
  }
  async recordActivities(admissionId: string, activities: { id: string; sequence: number; durationMs: number; status: string }[]) {
    this.activityRecords.set(admissionId, activities);
  }
  async recordSession(session: SessionEvidence) {
    if (session.sessionId) this.sessions.set(session.sessionId, session);
  }
  async sessionEvidence(sessionId: string): Promise<SessionEvidence> {
    if (sessionId === 'unknown-session') return this.unknownSession;
    return this.sessionOverrides.get(sessionId) ?? this.sessions.get(sessionId) ?? { status: 'missing' };
  }
  async revoke() {
    this.revoked = true;
    return {
      revoked: true, receiptId: '0'.repeat(32), credentialId: '0'.repeat(32), revokedAt: 1,
      proof: 'e'.repeat(64), scope: 'generation' as const, verified: true,
    };
  }
}

class FakeProcess implements ProcessSupervisor {
  readonly requests: ProcessRequest[] = [];
  readonly captures: ProcessRequest[] = [];
  readonly signals = new Map<string, string[]>();
  readonly reaped = new Map<string, boolean>();
  broker?: FakeBroker;
  extraHooks: string[] = [];
  externalChildSocket = false;
  overrides = new Map<string, ProcessObservation[]>();

  async capture(request: ProcessRequest) {
    this.captures.push(request);
    if (request.args.includes('--version')) return { code: 0, stdout: 'hermes 0.22.6\n', stderr: '' };
    if (request.args.includes('--session-id')) {
      const sessionId = request.args.at(-1)!;
      const override = this.broker?.sessionOverrides.get(sessionId);
      const sidecar = override ?? this.broker?.sessions.get(sessionId);
      const native = sidecar ? {
        ...sidecar, schemaVersion: 7, rowCount: request.scenarioId === 'P04' ? 6 : 4,
        state: 'finalized', childSessionCount: 0,
      } : { status: 'missing' };
      return { code: 0, stdout: JSON.stringify(native), stderr: '' };
    }
    const scenarios = Object.fromEntries(SCENARIOS.map((scenario) => [scenario.id, {
      tools: scenario.allowedTools,
      listeners: {
        observed: true, source: 'hermes-runtime',
        hooks: [...scenario.requiredActivities ?? [], ...this.extraHooks],
        delegation: false, a2a: this.externalChildSocket, messaging: this.externalChildSocket,
        externalMcp: this.externalChildSocket,
        mcpResources: false, mcpPrompts: false, mcpEvents: false,
        unapprovedHooks: this.extraHooks, childSessionCount: 0,
        deniedNetworkAttempts: this.externalChildSocket ? 1 : 0,
      },
    }]));
    return {
      code: 0,
      stdout: JSON.stringify({
        version: '0.22.6', commit: EXPECTED_COMMIT, artifactHash: 'b'.repeat(64),
        runtimeDescribe: {
          instance_id: 'fixture-instance', profile_id: 't01', authority_epoch: 1,
          capabilities: [], session_create: {}, skin: 'cli',
        },
        lockedDependenciesHash: 'c'.repeat(64), scenarios,
      }),
      stderr: '',
    };
  }

  async start(request: ProcessRequest, observer: (observation: ProcessObservation) => void) {
    this.requests.push(request);
    this.signals.set(request.scenarioId, []);
    const scenarioId = request.scenarioId;
    const emit = () => {
      const observations = this.overrides.get(scenarioId) ?? this.defaultObservations(scenarioId);
      for (const observation of observations) observer(observation);
    };
    if (scenarioId === 'P08') setTimeout(emit, 60);
    else if (['P09', 'P10'].includes(scenarioId)) setTimeout(emit, 10);
    else queueMicrotask(emit);
    const pid = 1000 + this.requests.length;
    return {
      identity: { pid, pgid: pid, startTimeTicks: 100 },
      signal: async (signal: 'SIGINT' | 'SIGKILL') => { this.signals.get(scenarioId)!.push(signal); },
      reap: async () => { this.reaped.set(scenarioId, true); },
      activities: async () => (SCENARIOS.find((entry) => entry.id === scenarioId)?.requiredActivities ?? [])
        .map((id, index) => ({ id, sequence: index + 1, durationMs: 1, status: 'succeeded' })),
    };
  }

  private defaultObservations(scenarioId: string): ProcessObservation[] {
    const sessionId = scenarioId === 'P01' || scenarioId === 'P04' ? 'session-1' : `session-${scenarioId}`;
    const scenario = SCENARIOS.find((entry) => entry.id === scenarioId)!;
    const toolEvents = scenario.allowedTools.flatMap((name, index): ProcessObservation[] => [
      { type: 'stdout', bytes: encode({ timestamp: 1, type: 'tool_use', name, tool_call_id: `tool-${index}` }) },
      { type: 'stdout', bytes: encode({ timestamp: 1, type: 'tool_result', name, tool_call_id: `tool-${index}`, output: 'private tool output', duration_ms: 1, is_error: false }) },
    ]);
    if (['P08', 'P09', 'P10'].includes(scenarioId)) {
      return [
        ...toolEvents,
        { type: 'stdout', bytes: encode(result(130, sessionId)) },
        { type: 'eof' }, { type: 'exit', code: 130 },
      ];
    }
    const exitCode = scenarioId === 'P07' ? 1 : 0;
    return [
      { type: 'stdout', bytes: encode({ timestamp: 1, type: 'system', subtype: 'init', session_id: sessionId, model: EXPECTED_MODEL }) },
      { type: 'stdout', bytes: encode({ timestamp: 1, type: 'text', text: 'private reasoning and response' }) },
      ...toolEvents,
      { type: 'stdout', bytes: encode(result(exitCode, sessionId)) },
      { type: 'stderr', bytes: new TextEncoder().encode('Authorization: Bearer super-secret\n') },
      { type: 'eof' }, { type: 'exit', code: exitCode },
    ];
  }
}

async function matrix(process = new FakeProcess(), broker = new FakeBroker()) {
  process.broker = broker;
  return runT01Matrix({
    process, broker, brokerUrl: 'https://broker.invalid/v1', model: EXPECTED_MODEL,
    preflightOnly: false, paidAuthorization: true, expectedPolicyHash: expectedPolicyHash,
    deadlineMs: 50, cancellationGraceMs: 20, receiptPollMs: 1, receiptDeadlineMs: 10,
  });
}

afterEach(() => vi.useRealTimers());

describe('Hermes live parser and lifecycle', () => {
  it('keeps ordered native, result, EOF, and exit evidence without text', () => {
    const outcome = lifecycle([
      { type: 'stdout', bytes: encode({ timestamp: 1, type: 'text', text: 'private' }) },
      { type: 'stdout', bytes: encode(result()) }, { type: 'eof' }, { type: 'exit', code: 0 },
    ]);
    expect(outcome.state).toBe('succeeded');
    expect(outcome.trace.map((entry) => entry.kind)).toEqual(['text', 'result', 'eof', 'exit']);
    expect(JSON.stringify(outcome)).not.toContain('private');
    expect(outcome.stdout?.sha256).toHaveLength(64);
  });

  it.each([
    ['malformed', new TextEncoder().encode('not json\n'), 'malformed-json'],
    ['truncated JSON', new TextEncoder().encode('{"type":"result"'), 'truncated-json'],
    ['truncated UTF-8', new Uint8Array([0xe2, 0x82]), 'truncated-utf8'],
  ])('fences %s streams', (_name, bytes, kind) => {
    const outcome = lifecycle([{ type: 'stdout', bytes }, { type: 'eof' }, { type: 'exit', code: 0 }]);
    expect(outcome.state).toBe('unknown');
    expect(outcome.parserErrors[0]?.kind).toBe(kind);
    expect(outcome.fenced).toBe(true);
  });

  it('bounds an oversized line and discards its bytes', () => {
    const parser = new HermesParser({ maxLineBytes: 32, maxEvents: 8 });
    const run = new HermesLifecycle(parser);
    run.observe({ type: 'stdout', bytes: new Uint8Array(100).fill(65) });
    run.observe({ type: 'stdout', bytes: new TextEncoder().encode('\n') });
    run.observe({ type: 'eof' });
    expect(run.snapshot().state).toBe('unknown');
    expect(run.snapshot().parserErrors[0]?.kind).toBe('line-too-large');
  });
});

describe('Hermes live matrix', () => {
  it('runs every Hermes executable and probe as t01hermes with a scrubbed environment', async () => {
    const process = new FakeProcess();
    const broker = new FakeBroker();
    process.broker = broker;
    const report = await runT01Matrix({
      process, broker, brokerUrl: 'https://broker.invalid/v1', model: EXPECTED_MODEL,
      hermesUser: 't01hermes', preflightOnly: false, paidAuthorization: true, expectedPolicyHash,
      deadlineMs: 50, cancellationGraceMs: 20, receiptPollMs: 1, receiptDeadlineMs: 10,
    });
    expect(report.state).toBe('completed');
    expect(process.captures.some((request) => request.args.includes('--version'))).toBe(true);
    expect(process.captures.some((request) => request.args.some((arg) => arg.endsWith('hermes_preflight_probe.py')) && !request.args.includes('--session-id'))).toBe(true);
    expect(process.captures.some((request) => request.args.includes('--session-id'))).toBe(true);
    for (const request of [...process.captures, ...process.requests]) {
      expect(request.command).toBe('/usr/bin/runuser');
      expect(request.args.slice(0, 5)).toEqual(['-u', 't01hermes', '--', 'env', '-i']);
      const environment = request.args.slice(5, 5 + Object.keys(request.env).length);
      expect(environment).toEqual(Object.entries(request.env).map(([key, value]) => `${key}=${value}`));
      expect(request.env).toMatchObject({
        HERMES_INSTALL_ROOT: '/opt/t01/source',
        PYTHONPATH: '/opt/t01/source',
        HERMES_RUNTIME_DIR: '/opt/t01/tools',
      });
      expect(environment.join('\n')).not.toMatch(/AWS|PROXY|CREDENTIAL/);
      expect(request.args.length).toBeGreaterThan(5 + environment.length);
    }
  });

  it('runs exactly P01-P12, freezes resume, and runs only P11/P12 concurrently', async () => {
    const process = new FakeProcess();
    const broker = new FakeBroker();
    const report = await matrix(process, broker);
    expect(report.abortReason).toBeUndefined();
    const first = report.runs.find((run) => run.scenarioId === 'P01')!;
    const resumed = report.runs.find((run) => run.scenarioId === 'P04')!;
    expect({
      firstState: first.state, resumedState: resumed.state,
      samePolicy: resumed.policyHash === first.policyHash, sameRoute: resumed.routeHash === first.routeHash,
      firstSession: first.session, resumedSession: resumed.session,
    }).toEqual({
      firstState: 'succeeded', resumedState: 'succeeded', samePolicy: true, sameRoute: true,
      firstSession: expect.objectContaining({ sessionId: 'session-1', policyHash: first.policyHash, routeHash: first.routeHash }),
      resumedSession: expect.objectContaining({ sessionId: 'session-1', policyHash: first.policyHash, routeHash: first.routeHash }),
    });
    expect(report.abortReason).toBeUndefined();
    expect(report.state).toBe('completed');
    expect(Object.fromEntries(report.runs.map((run) => [run.scenarioId, run.state]))).toEqual({
      P01: 'succeeded', P02: 'succeeded', P03: 'succeeded', P04: 'succeeded',
      P05: 'succeeded', P06: 'succeeded', P07: 'failed', P08: 'cancelled',
      P09: 'cancelled', P10: 'cancelled', P11: 'succeeded', P12: 'succeeded',
    });
    expect(report.runs.find((run) => run.scenarioId === 'P03')?.usageFile?.status).toBe('missing');
    expect(report.runs.find((run) => run.scenarioId === 'P06')?.receipt?.activities).toHaveLength(2);
    expect(broker.admissions.map((entry) => entry.scenarioId)).toEqual(SCENARIOS.map((entry) => entry.id));
    expect(broker.admissions).toHaveLength(12);
    expect(broker.admissions[3].policyHash).toBe(broker.admissions[0].policyHash);
    expect(broker.admissions[3].routeHash).toBe(broker.admissions[0].routeHash);
    expect(process.requests[3].args).toContain('--resume');
    expect(process.requests[3].args).toContain('session-1');
    expect(process.requests.every((request) => !request.args.includes('--run-budget'))).toBe(true);
    for (const request of process.requests) {
      expect(Object.keys(request.env).sort()).toEqual([
        'HERMES_HOME', 'HERMES_INSTALL_ROOT', 'HERMES_RUNTIME_DIR', 'HOME', 'PATH', 'PYTHONPATH',
        'TEAMKIMI_MODEL_ID', 'TEAMKIMI_OPENAI_COMPATIBLE_URL',
      ]);
    }
    expect(report.runs.find((run) => run.scenarioId === 'P07')?.state).toBe('failed');
    expect(broker.revoked).toBe(true);
  });

  it('writes P01 native-session files with read-only t01hermes group access under umask 077', async () => {
    const previousUmask = process.umask(0o077);
    try {
      const report = await matrix();
      const directory = join(report.workspace.path, 'hermes-home', 't01-sessions');
      const [name] = await readdir(directory);
      const sidecarPath = join(directory, name);
      const directoryMetadata = await stat(directory);
      const sidecarMetadata = await stat(sidecarPath);
      const expectedGroup = process.getuid?.() === 0 ? 10000 : process.getgid?.();
      expect(directoryMetadata.uid).toBe(process.getuid?.());
      expect(directoryMetadata.gid).toBe(expectedGroup);
      expect(directoryMetadata.mode & 0o777).toBe(0o550);
      expect(sidecarMetadata.uid).toBe(process.getuid?.());
      expect(sidecarMetadata.gid).toBe(expectedGroup);
      expect(sidecarMetadata.mode & 0o777).toBe(0o440);
      expect(JSON.parse(await readFile(sidecarPath, 'utf8'))).toMatchObject({ sessionId: 'session-1', admissionId: 'admission-P01' });
    } finally {
      process.umask(previousUmask);
    }
  });

  const rootIt = process.getuid?.() === 0 ? it : it.skip;
  rootIt('reads the P01 sidecar through the real native probe as UID 10000', async () => {
    const process = new FakeProcess();
    const broker = new FakeBroker();
    const report = await matrix(process, broker);
    expect(report.state).toBe('completed');
    const workspace = report.workspace.path;
    const hermesHome = join(workspace, 'hermes-home');
    const directory = join(hermesHome, 't01-sessions');
    const [name] = await readdir(directory);
    expect((await stat(directory)).mode & 0o777).toBe(0o550);
    expect((await stat(join(directory, name))).mode & 0o777).toBe(0o440);
    await chown(workspace, 10000, 10000);
    await chown(hermesHome, 10000, 10000);

    const database = join(hermesHome, 'state.db');
    const created = spawnSync('python3', ['-c', `
import sqlite3
import sys
connection = sqlite3.connect(sys.argv[1])
connection.execute('CREATE TABLE sessions (id TEXT PRIMARY KEY, ended_at INTEGER, parent_session_id TEXT)')
connection.execute('CREATE TABLE messages (session_id TEXT)')
connection.execute('INSERT INTO sessions VALUES (?, 1, NULL)', ('session-1',))
connection.execute('INSERT INTO messages VALUES (?)', ('session-1',))
connection.execute('PRAGMA user_version = 7')
connection.commit()
connection.close()
`, database], { encoding: 'utf8' });
    expect(created.status).toBe(0);
    await chown(database, 10000, 10000);
    await chmod(database, 0o600);

    const stubs = join(workspace, 'probe-stubs');
    await mkdir(join(stubs, 'hermes_cli'), { recursive: true, mode: 0o555 });
    await mkdir(join(stubs, 'pm'), { recursive: true, mode: 0o555 });
    const modules = {
      'psutil.py': '',
      'model_tools.py': 'def get_tool_definitions(**kwargs): return []\n',
      'hermes_cli/__init__.py': '',
      'hermes_cli/config.py': 'def load_config(): pass\n',
      'hermes_cli/gateway_runtime_discovery.py': 'def query_identify(*args, **kwargs): raise RuntimeError("unused")\n',
      'hermes_cli/gateway_session_store.py': 'def session_store(): raise RuntimeError("unused")\n',
      'hermes_cli/plugins.py': 'VALID_HOOKS = set()\ndef iter_hook_callbacks(event): return []\n',
      'hermes_cli/version_info.py': 'def get_version_info(): raise RuntimeError("unused")\n',
      'pm/__init__.py': '',
      'pm/paths.py': 'def install_stamp_path(value): return value\ndef repo_root(): return None\n',
    };
    for (const [path, source] of Object.entries(modules)) await writeFile(join(stubs, path), source);
    const inspected = spawnSync('setpriv', [
      '--reuid=10000', '--regid=10000', '--clear-groups', 'env', '-i',
      'PATH=/usr/bin:/bin', `HERMES_HOME=${hermesHome}`, `PYTHONPATH=${stubs}`,
      'python3', join(import.meta.dirname, '../tools/hermes-live/hermes_preflight_probe.py'),
      '--session-id', 'session-1',
    ], { encoding: 'utf8' });
    expect(inspected.stderr).toBe('');
    expect(inspected.status).toBe(0);
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      status: 'present', sessionId: 'session-1', admissionId: 'admission-P01',
      schemaVersion: 7, rowCount: 1, state: 'finalized', childSessionCount: 0,
    });
  });

  it('verifies readiness before the first admission', async () => {
    const process = new FakeProcess();
    const broker = new FakeBroker();
    broker.readinessValue.egress.redirectDenied = false;
    const report = await matrix(process, broker);
    expect(report.state).toBe('aborted');
    expect(broker.admissions).toHaveLength(0);
    expect(broker.revoked).toBe(true);
  });

  it('rejects unexpected post-expansion capabilities before admission', async () => {
    const process = new FakeProcess();
    const capture = process.capture.bind(process);
    process.capture = async (request) => {
      const captured = await capture(request);
      if (request.args.includes('--version')) return captured;
      const probe = JSON.parse(captured.stdout);
      probe.scenarios.P02.tools = ['delegate_task'];
      return { ...captured, stdout: JSON.stringify(probe) };
    };
    const broker = new FakeBroker();
    const report = await matrix(process, broker);
    expect(report.state).toBe('aborted');
    expect(broker.admissions).toHaveLength(0);
  });

  it('detects a malicious hook on an omitted event', async () => {
    const process = new FakeProcess();
    process.extraHooks = ['post_tool_call'];
    const report = await matrix(process);
    expect(report.state).toBe('aborted');
    expect(report.abortReason).toBe('preflight-or-runner-error');
  });

  it('rejects an external listener on a recursive child socket', async () => {
    const process = new FakeProcess();
    process.externalChildSocket = true;
    const report = await matrix(process);
    expect(report.state).toBe('aborted');
    expect(report.abortReason).toBe('preflight-or-runner-error');
  });

  it('aborts after malformed output and blocks every later admission', async () => {
    const process = new FakeProcess();
    process.overrides.set('P01', [
      { type: 'stdout', bytes: new TextEncoder().encode('not json\n') },
      { type: 'eof' }, { type: 'exit', code: 0 },
    ]);
    const broker = new FakeBroker();
    const report = await matrix(process, broker);
    expect(report.state).toBe('aborted');
    expect(report.abortReason).toBe('ambiguous-outcome');
    expect(broker.admissions.map((entry) => entry.scenarioId)).toEqual(['P01']);
    expect(broker.revoked).toBe(true);
  });

  it('uses an external deadline, generation-fenced cancellation, and forced stop', async () => {
    const process = new FakeProcess();
    process.overrides.set('P01', []);
    const broker = new FakeBroker();
    broker.receiptOverrides.set('admission-P01', [{ status: 'running' }, { status: 'interrupted', receiptId: 'late' }]);
    const report = await matrix(process, broker);
    expect(report.state).toBe('aborted');
    expect(broker.cancellations).toEqual(['admission-P01']);
    expect(process.signals.get('P01')).toContain('SIGKILL');
    expect(report.runs[0].state).toBe('unknown');
  });

  it('does not treat Ctrl-C detachment as cancellation without a receipt', async () => {
    const process = new FakeProcess();
    process.overrides.set('P09', [
      { type: 'stdout', bytes: encode(result(130, 'session-P09')) },
      { type: 'eof' }, { type: 'exit', code: 130 },
    ]);
    const broker = new FakeBroker();
    broker.receiptOverrides.set('admission-P09', [{ status: 'running' }]);
    const report = await matrix(process, broker);
    expect(report.state).toBe('aborted');
    expect(report.runs.find((run) => run.scenarioId === 'P09')?.state).toBe('unknown');
    expect(process.signals.get('P09')).toContain('SIGINT');
  });

  it('fails closed for unknown sessions and resume policy drift', async () => {
    const process = new FakeProcess();
    const broker = new FakeBroker();
    broker.unknownSession = { status: 'present', sessionId: 'unknown-session', state: 'finalized', schemaVersion: 1, rowCount: 1, childSessionCount: 0 };
    expect((await matrix(process, broker)).state).toBe('aborted');
    expect(broker.admissions).toHaveLength(0);

    const secondBroker = new FakeBroker();
    secondBroker.sessionOverrides.set('session-1', {
      status: 'present', sessionId: 'session-1', admissionId: 'admission-P01',
      schemaVersion: 7, rowCount: 4, state: 'finalized', policyHash: 'different',
      generation: 1, childSessionCount: 0,
    });
    const report = await matrix(new FakeProcess(), secondBroker);
    expect(report.state).toBe('aborted');
    expect(secondBroker.admissions.map((entry) => entry.scenarioId)).toEqual(['P01']);
  });

  it('fences P11/P12 on one ambiguous concurrent outcome', async () => {
    const process = new FakeProcess();
    process.overrides.set('P12', [{ type: 'exit', code: 0 }, { type: 'eof' }]);
    const broker = new FakeBroker();
    const report = await matrix(process, broker);
    expect(report.state).toBe('aborted');
    expect(broker.admissions.slice(-2).map((entry) => entry.scenarioId).sort()).toEqual(['P11', 'P12']);
    expect(report.runs.find((run) => run.scenarioId === 'P12')?.state).toBe('unknown');
  });
});

describe('sanitized evidence export', () => {
  it('writes only reviewed structured metadata with mode 0600 and cleans after seven days', async () => {
    const process = new FakeProcess();
    const broker = new FakeBroker();
    const report = await matrix(process, broker);
    const root = await mkdtemp(join(tmpdir(), 't01-evidence-'));
    const manifest = await exportEvidence(root, report);
    const serialized = await readFile(manifest, 'utf8');
    expect(JSON.parse(serialized).review.status).toBe('pending');
    for (const name of await readdir(root)) {
      const artifact = await readFile(join(root, name), 'utf8');
      expect(artifact).not.toContain('super-secret');
      expect(artifact).not.toContain('sensitive final response');
      expect(artifact).not.toContain('private reasoning');
      expect((await stat(join(root, name))).mode & 0o777).toBe(0o600);
    }
    await approveEvidenceExport(manifest, 'operator');
    expect(JSON.parse(await readFile(manifest, 'utf8')).review.status).toBe('approved');
    const ancient = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    for (const name of await readdir(root)) await utimes(join(root, name), ancient, ancient);
    await cleanupEvidence(root);
    expect(await readdir(root)).toEqual([]);
  });

  it('verifies the external manifest, scenario outcomes, receipt arithmetic, and revocation', async () => {
    const report = await matrix();
    const root = await mkdtemp(join(tmpdir(), 't01-evidence-'));
    const manifest = await exportEvidence(root, report);
    const options = { attestation, expectedPolicyHash, credentialId: '0'.repeat(32) };
    await verifyEvidenceExport(manifest, options);
    verifyEvidenceReport(report, options);

    const wrongOutcome = structuredClone(report);
    wrongOutcome.runs.find((run) => run.scenarioId === 'P07')!.state = 'succeeded';
    expect(() => verifyEvidenceReport(wrongOutcome, options)).toThrow('scenario-outcome');

    const wrongCost = structuredClone(report);
    wrongCost.runs[0].receipt!.usage!.costMicros++;
    expect(() => verifyEvidenceReport(wrongCost, options)).toThrow('receipt-cost-mismatch');

    const wrongRevocation = structuredClone(report);
    wrongRevocation.revocation!.credentialId = '1'.repeat(32);
    expect(() => verifyEvidenceReport(wrongRevocation, options)).toThrow('revocation');
  });

  it('rejects an artifact changed after export before approval', async () => {
    const report = await matrix();
    const root = await mkdtemp(join(tmpdir(), 't01-evidence-'));
    const manifest = await exportEvidence(root, report);
    await writeFile(join(root, 'P01.json'), '{"secret":"raw"}\n', { mode: 0o600 });
    await expect(approveEvidenceExport(manifest, 'operator')).rejects.toThrow('evidence-hash-mismatch');
    await writeFile(join(root, 'raw.txt'), 'unlisted raw artifact', { mode: 0o600 });
    await expect(approveEvidenceExport(manifest, 'operator')).rejects.toThrow('evidence-manifest-membership-mismatch');
    expect(JSON.parse(await readFile(manifest, 'utf8')).review.status).toBe('pending');
  });

  it('cleans prompts, native sessions, usage, and symlinks without touching their targets', async () => {
    const parent = await mkdtemp(join(tmpdir(), 't01-workspace-cleanup-'));
    const workspace = join(parent, 'workspace');
    await mkdir(join(workspace, 'prompts'), { recursive: true });
    await mkdir(join(workspace, 'native'), { recursive: true });
    const outside = join(parent, 'outside.txt');
    await writeFile(outside, 'keep');
    await writeFile(join(workspace, 'prompts', 'P01.prompt'), 'private prompt');
    await writeFile(join(workspace, 'native', 'sessions.db'), 'private native database');
    await writeFile(join(workspace, 'P03-usage.json'), '{"private":true}');
    await symlink(outside, join(workspace, 'native-link'));
    const ancient = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    for (const path of [workspace, outside, join(workspace, 'prompts'), join(workspace, 'native'), join(workspace, 'prompts', 'P01.prompt'), join(workspace, 'native', 'sessions.db'), join(workspace, 'P03-usage.json')]) {
      await utimes(path, ancient, ancient);
    }
    await lutimes(join(workspace, 'native-link'), ancient, ancient);
    await cleanupWorkspace(workspace);
    await expect(stat(workspace)).rejects.toThrow();
    expect(await readFile(outside, 'utf8')).toBe('keep');
  });

  it('discovers default workspace cleanup from the evidence manifest', async () => {
    const report = await matrix();
    const root = await mkdtemp(join(tmpdir(), 't01-evidence-'));
    const manifest = await exportEvidence(root, report);
    expect(JSON.parse(await readFile(manifest, 'utf8')).workspace.path).toBe(report.workspace.path);
    const ancient = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const age = async (path: string): Promise<void> => {
      await utimes(path, ancient, ancient);
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isDirectory()) await age(join(path, entry.name));
        else await utimes(join(path, entry.name), ancient, ancient);
      }
    };
    await age(report.workspace.path);
    for (const name of await readdir(root)) await utimes(join(root, name), ancient, ancient);
    await cleanupManifest(manifest);
    await expect(stat(report.workspace.path)).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });
});

describe('T01 security and lifecycle regressions', () => {
  it('defaults the public API to preflight and requires explicit paid authorization', async () => {
    const process = new FakeProcess();
    const broker = new FakeBroker();
    const report = await runT01Matrix({ process, broker, brokerUrl: 'http://127.0.0.1', model: EXPECTED_MODEL });
    expect(report.state).toBe('completed');
    expect(broker.admissions).toHaveLength(0);
    expect(broker.revoked).toBe(true);
    await expect(runT01Matrix({ process, broker, brokerUrl: 'http://127.0.0.1', model: EXPECTED_MODEL, preflightOnly: false }))
      .rejects.toThrow('paid-admissions-not-authorized');
  });

  it('rejects truthy strings in nested readiness fields before admission', async () => {
    const process = new FakeProcess();
    const broker = new FakeBroker();
    broker.readinessValue.isolation.disposable = 'false' as unknown as boolean;
    const report = await matrix(process, broker);
    expect(report.state).toBe('aborted');
    expect(broker.admissions).toHaveLength(0);
  });

  it('rejects extra runtime activities and freezes the scenario', async () => {
    const process = new FakeProcess();
    const broker = new FakeBroker();
    const record = broker.recordActivities.bind(broker);
    broker.recordActivities = async (admissionId, activities) => record(admissionId, admissionId === 'admission-P06'
      ? [...activities, { id: 'unapproved_hook', sequence: 3, durationMs: 1, status: 'succeeded' }] : activities);
    const report = await matrix(process, broker);
    expect(report.state).toBe('aborted');
    expect(broker.admissions.at(-1)?.scenarioId).toBe('P06');
    expect(report.runs.at(-1)?.state).toBe('unknown');
  });

  it.each(['P07', 'P08', 'P09', 'P10'] as const)('rejects unexpected success in %s', async (scenarioId) => {
    const process = new FakeProcess();
    const broker = new FakeBroker();
    const sessionId = `session-${scenarioId}`;
    const events: ProcessObservation[] = [
      { type: 'stdout', bytes: encode({ timestamp: 1, type: 'system', subtype: 'init', session_id: sessionId, model: EXPECTED_MODEL }) },
      { type: 'stdout', bytes: encode(result(0, sessionId)) },
      { type: 'eof' }, { type: 'exit', code: 0 },
    ];
    if (scenarioId === 'P08') {
      events.splice(1, 0,
        { type: 'stdout', bytes: encode({ timestamp: 1, type: 'tool_use', name: 't01:sleep', tool_call_id: 'sleep-1' }) },
        { type: 'stdout', bytes: encode({ timestamp: 1, type: 'tool_result', name: 't01:sleep', tool_call_id: 'sleep-1', output: 'done', duration_ms: 1, is_error: false }) });
    }
    process.overrides.set(scenarioId, events);
    const receive = broker.receipt.bind(broker);
    broker.receipt = async (admissionId) => {
      const valid = await receive(admissionId);
      return admissionId === `admission-${scenarioId}` ? { ...valid, status: 'completed' } : valid;
    };
    const report = await matrix(process, broker);
    expect(report.state).toBe('aborted');
    expect(report.abortReason).toBe('ambiguous-outcome');
    expect(report.runs.at(-1)?.scenarioId).toBe(scenarioId);
    expect(broker.admissions.at(-1)?.scenarioId).toBe(scenarioId);
  });

  it('rejects a failed outcome for a scenario that must succeed', async () => {
    const process = new FakeProcess();
    process.overrides.set('P01', [
      { type: 'stdout', bytes: encode({ timestamp: 1, type: 'system', subtype: 'init', session_id: 'session-1', model: EXPECTED_MODEL }) },
      { type: 'stdout', bytes: encode({ timestamp: 1, type: 'tool_use', name: 'read_file', tool_call_id: 'read-1' }) },
      { type: 'stdout', bytes: encode({ timestamp: 1, type: 'tool_result', name: 'read_file', tool_call_id: 'read-1', output: 'done', duration_ms: 1, is_error: false }) },
      { type: 'stdout', bytes: encode(result(1, 'session-1')) },
      { type: 'eof' }, { type: 'exit', code: 1 },
    ]);
    const broker = new FakeBroker();
    const receive = broker.receipt.bind(broker);
    broker.receipt = async (admissionId) => {
      const valid = await receive(admissionId);
      return admissionId === 'admission-P01' ? { ...valid, status: 'failed' } : valid;
    };
    const report = await matrix(process, broker);
    expect(report.state).toBe('aborted');
    expect(report.abortReason).toBe('ambiguous-outcome');
    expect(broker.admissions.map((entry) => entry.scenarioId)).toEqual(['P01']);
    expect(report.runs[0].state).toBe('unknown');
  });

  it('rejects receipt hashes, policy drift, counted-input gaps, and incomplete usage', async () => {
    for (const mutation of ['hash', 'usage', 'inputVerified', 'policy', 'counted'] as const) {
      const process = new FakeProcess();
      const broker = new FakeBroker();
      const valid = await broker.receipt('admission-P01');
      const changed = mutation === 'hash' ? { ...valid, admissionRequestHash: '0'.repeat(64) }
        : mutation === 'inputVerified' ? { ...valid, inputVerified: false }
          : mutation === 'policy' ? { ...valid, policyHash: '0'.repeat(64) }
            : mutation === 'counted' ? { ...valid, countedInput: { ...counted, baseInputTokens: 0 } }
              : { ...valid, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costMicros: 1 } as never };
      broker.receiptOverrides.set('admission-P01', [changed]);
      const report = await matrix(process, broker);
      expect(report.state).toBe('aborted');
      expect(broker.admissions.map((entry) => entry.scenarioId)).toEqual(['P01']);
      expect(report.runs[0].state).toBe('unknown');
    }
  });

  it('blocks P04 before admission when P01 session evidence is conflicting', async () => {
    const process = new FakeProcess();
    const broker = new FakeBroker();
    broker.sessionOverrides.set('session-1', { status: 'conflicting' });
    const report = await matrix(process, broker);
    expect(report.state).toBe('aborted');
    expect(broker.admissions.map((entry) => entry.scenarioId)).toEqual(['P01', 'P02', 'P03']);
  });

  it('caps retained parser errors and verifies process reaping', async () => {
    const bytes = new TextEncoder().encode('not json\n'.repeat(80));
    const outcome = lifecycle([{ type: 'stdout', bytes }, { type: 'eof' }, { type: 'exit', code: 0 }]);
    expect(outcome.parserErrors).toHaveLength(64);
    expect(outcome.state).toBe('unknown');
    const process = new FakeProcess();
    const report = await matrix(process);
    expect(report.runs).toHaveLength(12);
    expect(report.runs.every((run) => run.process.reaped && run.process.pgid === run.process.pid)).toBe(true);
  });
});
