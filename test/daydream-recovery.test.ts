import { mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/daydream.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/daydream.js')>();
  return { ...original, readDaydream: vi.fn(original.readDaydream) };
});

import { createDaydreamAutomationRunner } from '../src/daydream-automation-runner.js';
import {
  getDaydreamAutomationStatus,
  maybeDaydreamAutomation,
  reconcileDaydreamAutomation,
  reserveDaydreamAutomation,
  type DaydreamAutomationOutcome,
  type DaydreamAutomationRunner,
} from '../src/daydream-automation.js';
import { readDaydream } from '../src/daydream.js';
import { daydreamCommand } from '../src/daydream-cli.js';
import { writeRecord } from '../src/daydream-record.js';
import { nativeSha } from '../src/native-history.js';
import { hivePath, hubPath, writeJson } from '../src/state.js';
import type { DaydreamNativeClient, DaydreamRecord, TeamEntry } from '../src/types.js';

const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const AT = new Date(NOW).toISOString();
const IDLE = 30 * 60_000;
const ACTIVITY = NOW - IDLE;

function worker(): TeamEntry {
  return {
    name: 'builder',
    pane: '%2',
    pane_pid: 22,
    pane_started: 'start',
    session_id: 'session_builder',
    worktree: '/builder',
    handoff: '/builder/.hive/handoffs/builder.md',
    task: 'demo-1',
    daydream_automation: true,
  };
}

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'hive-daydream-recovery-'));
  const home = path.join(root, 'demo');
  const entry = worker();
  await fs.mkdir(hivePath(home), { recursive: true });
  await writeJson(hubPath(root, 'projects.json'), { projects: [{ name: 'demo', home, repos: [] }] });
  await writeJson(hivePath(home, 'team.json'), { agents: [entry] });
  return { root, home, entry };
}

function emptySnapshot() {
  return { count: 0, headId: null, historyHash: nativeSha([]), messages: [] };
}

function recoveredRecord(home: string, id: string): DaydreamRecord {
  return {
    schemaVersion: 1,
    id,
    status: 'recovered',
    parentSessionId: 'session_builder',
    childSessionId: 'session_daydream_child',
    checkpointSessionId: null,
    workspaceId: 'workspace_demo',
    cwd: home,
    scope: { project: 'demo', agent: 'builder', task: 'demo-1' },
    checkpointId: 'cp1',
    questionHash: nativeSha('automated daydream question'),
    sourceTaskHash: nativeSha([]),
    handoffPathHash: nativeSha('/builder/.hive/handoffs/builder.md'),
    handoffContentHash: nativeSha('handoff'),
    parentSnapshot: emptySnapshot(),
    childSnapshot: emptySnapshot(),
    createdAt: AT,
    updatedAt: AT,
  };
}

function options(runner?: DaydreamAutomationRunner, overrides: Record<string, unknown> = {}) {
  return {
    ...(runner ? { runner } : {}),
    now: NOW,
    idleMs: IDLE,
    activityAt: ACTIVITY,
    ...overrides,
  };
}

function outcome(status: 'recovered' | 'unknown'): DaydreamAutomationOutcome {
  return { daydreamId: '', status, prompts: 2, compactions: 1, tokens: 100 };
}

function nativeWithChildren() {
  return {
    listChildren: vi.fn(async () => ({ items: [], has_more: false })),
  } as unknown as DaydreamNativeClient;
}

type AutomationStateFile = { runs: Record<string, unknown>[] };
async function readAutomationState(home: string): Promise<AutomationStateFile> {
  return JSON.parse(await fs.readFile(hivePath(home, 'daydreams', 'automation', 'state.json'), 'utf8')) as AutomationStateFile;
}
async function writeAutomationState(home: string, state: AutomationStateFile): Promise<void> {
  await writeJson(hivePath(home, 'daydreams', 'automation', 'state.json'), state);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.stubEnv('HIVE_DAYDREAM_AUTOMATION', '1');
  vi.stubEnv('HIVE_DAYDREAM', '1');
  vi.stubEnv('HIVE_NATIVE_BRANCHES', '1');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('guarded reservation finalization', () => {
  it('missing-child reconcile terminates unknown and charges the full reservation exactly once', async () => {
    const { root, home, entry } = await setup();
    const reservation = await reserveDaydreamAutomation(root, 'demo', entry, options());
    if (!reservation) throw new Error('the first reservation must be admitted');
    const durable = await readAutomationState(home);
    durable.runs[0].ownerPid = 99_999_999;
    await writeAutomationState(home, durable);
    const native = nativeWithChildren();
    const runner = createDaydreamAutomationRunner(native);

    await reconcileDaydreamAutomation(root, 'demo', reservation.daydreamId, options(runner, { native }));

    let current = await getDaydreamAutomationStatus(root, 'demo');
    expect(current.runs[0]).toMatchObject({
      status: 'unknown', fenced: false, usageRecorded: true, prompts: 3, compactions: 1,
    });
    expect(current.daily.project).toMatchObject({ runs: 1, prompts: 3, compactions: 1 });
    expect(native.listChildren).toHaveBeenCalledTimes(1);
    const charged = current.daily.project;

    await reconcileDaydreamAutomation(root, 'demo', reservation.daydreamId, options(runner, { native }));
    current = await getDaydreamAutomationStatus(root, 'demo');
    expect(current.daily.project).toEqual(charged);
    expect(native.listChildren).toHaveBeenCalledTimes(1);
  });

  it('a live durable owner lease blocks reconcile and admission until owner death', async () => {
    const { root, home, entry } = await setup();
    const reservation = await reserveDaydreamAutomation(root, 'demo', entry, options());
    if (!reservation) throw new Error('the first reservation must be admitted');
    const native = nativeWithChildren();
    const runner = createDaydreamAutomationRunner(native);
    let durable = await readAutomationState(home);
    expect(durable.runs[0]).toMatchObject({ ownerPid: process.pid });
    expect(durable.runs[0].ownerStartTime).toEqual(expect.any(String));

    await reconcileDaydreamAutomation(root, 'demo', reservation.daydreamId, options(runner, { native }));

    let current = await getDaydreamAutomationStatus(root, 'demo');
    expect(current.runs[0]).toMatchObject({ status: 'reserved', fenced: true, usageRecorded: false });
    expect(current.daily.project).toMatchObject({ runs: 0, prompts: 0, compactions: 0 });
    expect(native.listChildren).not.toHaveBeenCalled();
    const nextRunner: DaydreamAutomationRunner = {
      run: vi.fn(async (input) => ({ ...outcome('recovered'), daydreamId: input.daydreamId })),
      reconcile: vi.fn(),
    };
    await maybeDaydreamAutomation(root, 'demo', entry, options(nextRunner, {
      now: NOW + IDLE + 60_000,
      activityAt: ACTIVITY + 60_000,
    }));
    expect(vi.mocked(nextRunner.run)).not.toHaveBeenCalled();
    expect((await getDaydreamAutomationStatus(root, 'demo')).runs).toHaveLength(1);

    durable = await readAutomationState(home);
    durable.runs[0].ownerPid = 99_999_999;
    await writeAutomationState(home, durable);
    await reconcileDaydreamAutomation(root, 'demo', reservation.daydreamId, options(runner, { native }));

    current = await getDaydreamAutomationStatus(root, 'demo');
    expect(current.runs[0]).toMatchObject({ status: 'unknown', fenced: false, prompts: 3, compactions: 1 });
    expect(current.daily.project).toMatchObject({ runs: 1, prompts: 3, compactions: 1 });
    expect(native.listChildren).toHaveBeenCalledTimes(1);
    await maybeDaydreamAutomation(root, 'demo', entry, options(nextRunner, {
      now: NOW + IDLE + 60_000,
      activityAt: ACTIVITY + 60_000,
    }));
    expect(vi.mocked(nextRunner.run)).toHaveBeenCalledTimes(1);
  });

  it.each(['0', 'not-a-start-time'])('an invalid durable owner start time fails closed: %s', async (ownerStartTime) => {
    const { root, home, entry } = await setup();
    const reservation = await reserveDaydreamAutomation(root, 'demo', entry, options());
    if (!reservation) throw new Error('the first reservation must be admitted');
    const durable = await readAutomationState(home);
    durable.runs[0].ownerStartTime = ownerStartTime;
    await writeAutomationState(home, durable);
    const native = nativeWithChildren();
    const runner = createDaydreamAutomationRunner(native);

    await reconcileDaydreamAutomation(root, 'demo', reservation.daydreamId, options(runner, { native }));

    const current = await getDaydreamAutomationStatus(root, 'demo');
    expect(current.runs[0]).toMatchObject({ status: 'reserved', fenced: true, usageRecorded: false });
    expect(current.agents[0].fencedDaydreamId).toBe(reservation.daydreamId);
    expect(native.listChildren).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'corruption', error: new Error('corrupt JSON') },
    { name: 'permission', error: Object.assign(new Error('permission denied'), { code: 'EACCES' }) },
    { name: 'invalid record', error: new Error('daydream record schema is invalid') },
    { name: 'transient I/O', error: Object.assign(new Error('transient read failure'), { code: 'EIO' }) },
  ])('$name never proves a missing child', async ({ error }) => {
    const { root, entry } = await setup();
    const reservation = await reserveDaydreamAutomation(root, 'demo', entry, options());
    if (!reservation) throw new Error('the first reservation must be admitted');
    const native = nativeWithChildren();
    const runner = createDaydreamAutomationRunner(native);
    vi.mocked(readDaydream).mockRejectedValueOnce(error);

    await reconcileDaydreamAutomation(root, 'demo', reservation.daydreamId, options(runner, { native }));

    const current = await getDaydreamAutomationStatus(root, 'demo');
    expect(current.runs[0]).toMatchObject({ status: 'reserved', fenced: true, usageRecorded: false });
    expect(current.agents[0].fencedDaydreamId).toBe(reservation.daydreamId);
    expect(current.daily.project).toMatchObject({ runs: 0, prompts: 0, compactions: 0 });
    expect(native.listChildren).not.toHaveBeenCalled();
  });

  it('recovered reconcile adds only the missing reservation counts', async () => {
    const { root, entry } = await setup();
    const runner: DaydreamAutomationRunner = {
      run: vi.fn(async (input) => ({
        daydreamId: input.daydreamId, status: 'unknown', prompts: 1, compactions: 1, tokens: 10, unknownStage: 'result',
      })),
      reconcile: vi.fn(async (input) => ({
        daydreamId: input.daydreamId, status: 'recovered', prompts: 3, compactions: 1, tokens: 100,
      })),
    };

    await maybeDaydreamAutomation(root, 'demo', entry, options(runner));
    const daydreamId = vi.mocked(runner.run).mock.calls[0][0].daydreamId;
    let current = await getDaydreamAutomationStatus(root, 'demo');
    expect(current.runs[0]).toMatchObject({ usageRecorded: true, prompts: 1, compactions: 1 });
    expect(current.daily.project).toMatchObject({ runs: 1, prompts: 1, compactions: 1 });

    await reconcileDaydreamAutomation(root, 'demo', daydreamId, options(runner));

    current = await getDaydreamAutomationStatus(root, 'demo');
    expect(current.runs[0]).toMatchObject({ status: 'recovered', prompts: 3, compactions: 1 });
    expect(current.daily.project).toMatchObject({ runs: 1, prompts: 3, compactions: 1 });
    const charged = current.daily.project;
    await reconcileDaydreamAutomation(root, 'demo', daydreamId, options(runner));
    expect((await getDaydreamAutomationStatus(root, 'demo')).daily.project).toEqual(charged);
  });

  it('a result-write crash after native work charges once and reconciles without another generation', async () => {
    const { root, home, entry } = await setup();
    const native = {
      createChild: vi.fn(),
      submitPrompt: vi.fn(),
      forkSession: vi.fn(),
      compactSession: vi.fn(),
    } as unknown as DaydreamNativeClient;
    let nativeWork = 0;
    const runner: DaydreamAutomationRunner = {
      run: vi.fn()
        .mockImplementationOnce(async (input) => {
          nativeWork += 1;
          await writeRecord(home, recoveredRecord(home, input.daydreamId));
          throw new Error('test crash before automation result write');
        })
        .mockImplementationOnce(async (input) => ({ ...outcome('recovered'), daydreamId: input.daydreamId })),
      reconcile: vi.fn(async (input) => {
        const record = await readDaydream({ root, project: 'demo' }, input.daydreamId);
        expect(record.status).toBe('recovered');
        return { ...outcome('recovered'), daydreamId: input.daydreamId };
      }),
    };

    await maybeDaydreamAutomation(root, 'demo', entry, options(runner, { native }));
    const daydreamId = vi.mocked(runner.run).mock.calls[0][0].daydreamId;
    await maybeDaydreamAutomation(root, 'demo', entry, options(runner, {
      native,
      now: NOW + IDLE + 60_000,
      activityAt: ACTIVITY + 60_000,
    }));

    let current = await getDaydreamAutomationStatus(root, 'demo');
    expect(current.runs[0]).toMatchObject({ status: 'unknown', usageRecorded: true, prompts: 3, compactions: 1 });
    expect(current.daily.project).toMatchObject({ runs: 1, prompts: 3, compactions: 1 });
    expect(vi.mocked(runner.run)).toHaveBeenCalledTimes(1);
    expect(nativeWork).toBe(1);
    const charged = current.daily.project;

    vi.stubEnv('HIVE_DAYDREAM_AUTOMATION', '0');
    await daydreamCommand(root, ['reconcile', 'demo', daydreamId], {
      native,
      automationRunner: runner,
      now: AT,
    });

    const reconcileInput = vi.mocked(runner.reconcile).mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(reconcileInput).not.toHaveProperty('agent');
    expect(reconcileInput).not.toHaveProperty('readOnly');
    expect(native.createChild).not.toHaveBeenCalled();
    expect(native.submitPrompt).not.toHaveBeenCalled();
    expect(native.forkSession).not.toHaveBeenCalled();
    expect(native.compactSession).not.toHaveBeenCalled();
    current = await getDaydreamAutomationStatus(root, 'demo');
    expect(current.runs[0].status).toBe('recovered');
    expect(current.daily.project).toEqual(charged);

    vi.stubEnv('HIVE_DAYDREAM_AUTOMATION', '1');
    await maybeDaydreamAutomation(root, 'demo', entry, options(runner, {
      native,
      now: NOW + IDLE + 60_000,
      activityAt: ACTIVITY + 60_000,
    }));
    expect(vi.mocked(runner.run)).toHaveBeenCalledTimes(2);
    expect(nativeWork).toBe(1);
  });
});
