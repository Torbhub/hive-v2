import { mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reservationMutation = vi.hoisted(() => ({ afterWrite: undefined as (() => Promise<void>) | undefined }));
vi.mock('../src/state.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/state.js')>();
  return {
    ...original,
    writeJson: vi.fn(async (file: string, value: unknown, mode?: number) => {
      await original.writeJson(file, value, mode);
      if (file.endsWith('daydreams/automation/state.json') && reservationMutation.afterWrite) {
        const mutate = reservationMutation.afterWrite;
        reservationMutation.afterWrite = undefined;
        await mutate();
      }
    }),
  };
});

import {
  getDaydreamAutomationStatus,
  maybeDaydreamAutomation,
  setDaydreamAutomation,
  reconcileDaydreamAutomation,
  type DaydreamAutomationBudgets,
  type DaydreamAutomationOutcome,
  type DaydreamAutomationRunner,
} from '../src/daydream-automation.js';
import { daydreamCommand } from '../src/daydream-cli.js';
import { hivePath, hubPath, readTeam, upsertTeamEntry, writeJson } from '../src/state.js';
import type { TeamEntry } from '../src/types.js';

const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const IDLE = 30 * 60_000;
const ACTIVITY = NOW - IDLE;

function worker(name = 'builder'): TeamEntry {
  return {
    name,
    pane: '%2',
    pane_pid: 22,
    pane_started: 'start',
    session_id: `session_${name}`,
    worktree: `/${name}`,
    handoff: `/${name}/.hive/handoffs/${name}.md`,
    task: 'demo-1',
    daydream_automation: true,
  };
}

async function setup(agents: TeamEntry[] = [worker()]) {
  const root = mkdtempSync(path.join(tmpdir(), 'hive-daydream-automation-'));
  const home = path.join(root, 'demo');
  await fs.mkdir(hivePath(home), { recursive: true });
  await writeJson(hubPath(root, 'projects.json'), { projects: [{ name: 'demo', home, repos: [] }] });
  await writeJson(hivePath(home, 'team.json'), { agents });
  return { root, home, agents };
}

function outcome(status: 'recovered' | 'unknown' = 'recovered'): DaydreamAutomationOutcome {
  return {
    daydreamId: '',
    status,
    prompts: status === 'recovered' ? 2 : 1,
    compactions: status === 'recovered' ? 1 : 0,
    tokens: 100,
  };
}

function fakeRunner(...outcomes: DaydreamAutomationOutcome[]) {
  let index = 0;
  return {
    run: vi.fn(async (input: Parameters<DaydreamAutomationRunner['run']>[0]) => {
      const next = outcomes[Math.min(index++, outcomes.length - 1)] ?? outcome();
      return { ...next, daydreamId: input.daydreamId };
    }),
    reconcile: vi.fn(async (input: { daydreamId: string }) => ({ ...outcome(), daydreamId: input.daydreamId })),
  } satisfies DaydreamAutomationRunner;
}

function options(runner: DaydreamAutomationRunner, overrides: Record<string, unknown> = {}) {
  return {
    runner,
    now: NOW,
    idleMs: IDLE,
    activityAt: ACTIVITY,
    ...overrides,
  };
}

function budgets(
  agent: Partial<DaydreamAutomationBudgets['perAgent']> = {},
  project: Partial<DaydreamAutomationBudgets['perProject']> = {},
): DaydreamAutomationBudgets {
  return {
    perAgent: { runs: 20, prompts: 60, compactions: 20, ...agent },
    perProject: { runs: 40, prompts: 120, compactions: 40, ...project },
  };
}

async function status(root: string) {
  return getDaydreamAutomationStatus(root, 'demo');
}

beforeEach(() => {
  vi.clearAllMocks();
  reservationMutation.afterWrite = undefined;
  vi.stubEnv('HIVE_DAYDREAM_AUTOMATION', '1');
  vi.stubEnv('HIVE_DAYDREAM', '1');
  vi.stubEnv('HIVE_NATIVE_BRANCHES', '1');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('daydream automation admission', () => {
  it.each([
    { global: 'unset', agent: true, autoCompact: false },
    { global: '0', agent: true, autoCompact: false },
    { global: '1', agent: false, autoCompact: false },
    { global: '0', agent: false, autoCompact: true },
    { global: '1', agent: false, autoCompact: true },
  ])('requires both opt-ins, independently of auto_compact: %o', async ({ global, agent, autoCompact }) => {
    if (global === 'unset') delete process.env.HIVE_DAYDREAM_AUTOMATION;
    else vi.stubEnv('HIVE_DAYDREAM_AUTOMATION', global);
    const entry = { ...worker(), daydream_automation: agent, auto_compact: autoCompact };
    const { root } = await setup([entry]);
    const runner = fakeRunner();

    await maybeDaydreamAutomation(root, 'demo', entry, options(runner));

    expect(runner.run).not.toHaveBeenCalled();
    expect((await status(root)).runs).toEqual([]);
  });

  it('does not admit a non-Hive session or a closed worker', async () => {
    const nonHive = { ...worker(), session_id: undefined };
    const closed = { ...worker('closed'), closed_at: new Date(NOW).toISOString() };
    const { root } = await setup([nonHive, closed]);
    const runner = fakeRunner();

    await maybeDaydreamAutomation(root, 'demo', nonHive, options(runner));
    await maybeDaydreamAutomation(root, 'demo', closed, options(runner));

    expect(runner.run).not.toHaveBeenCalled();
    expect((await status(root)).runs).toEqual([]);
  });

  it.each([
    { name: 'respawn', patch: { session_id: 'session_respawned' } },
    { name: 'same-name different worktree', patch: { worktree: '/different-worktree' } },
  ])('revalidates the reserved identity after a $name before native work', async ({ patch }) => {
    const { root, home, agents: [entry] } = await setup();
    const runner = fakeRunner();
    reservationMutation.afterWrite = async () => {
      await upsertTeamEntry(home, { name: 'builder', ...patch });
    };

    await maybeDaydreamAutomation(root, 'demo', entry, options(runner));

    expect((await readTeam(home)).agents[0]).toMatchObject(patch);
    expect(runner.run).not.toHaveBeenCalled();
    expect((await status(root)).runs.every((run) => run.status !== 'recovered')).toBe(true);
  });

  it('waits for a genuine idle epoch and deduplicates session, epoch, and reason after reload', async () => {
    const { root, agents: [entry] } = await setup();
    const runner = fakeRunner();

    await maybeDaydreamAutomation(root, 'demo', entry, options(runner, { activityAt: NOW - IDLE + 1 }));
    expect(runner.run).not.toHaveBeenCalled();

    await maybeDaydreamAutomation(root, 'demo', entry, options(runner));
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(runner.run.mock.calls[0][0]).toMatchObject({
      sessionId: 'session_builder', activityAt: ACTIVITY, reason: 'idle',
    });

    await maybeDaydreamAutomation(root, 'demo', entry, options(runner, { now: NOW + 5_000 }));
    await maybeDaydreamAutomation(root, 'demo', entry, options(runner, { now: NOW + 10_000 }));
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect((await status(root)).runs).toHaveLength(1);

    await maybeDaydreamAutomation(root, 'demo', entry, options(runner, {
      now: NOW + IDLE + 60_000,
      activityAt: ACTIVITY + 60_000,
    }));
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(new Set((await status(root)).runs.map((run) => run.fingerprint)).size).toBe(2);
  });

  it('deduplicates by reason and allows before-compaction without waiting for idle', async () => {
    const { root, agents: [entry] } = await setup();
    const runner = fakeRunner();

    await maybeDaydreamAutomation(root, 'demo', entry, options(runner));
    await maybeDaydreamAutomation(root, 'demo', entry, options(runner, { trigger: 'before_compaction' }));
    await maybeDaydreamAutomation(root, 'demo', entry, options(runner, {
      activityAt: NOW,
      trigger: 'before_compaction',
    }));

    expect(runner.run).toHaveBeenCalledTimes(3);
    expect(runner.run.mock.calls.map((call) => call[0].reason)).toEqual(['idle', 'before_compaction', 'before_compaction']);
    expect(runner.run.mock.calls[2][0]).toMatchObject({ activityAt: NOW, reason: 'before_compaction' });
    expect(new Set((await status(root)).runs.map((run) => run.fingerprint)).size).toBe(3);
  });

  it('serializes one fingerprint and one project under overlapping polls', async () => {
    const { root, agents: [entry] } = await setup();
    const runner = fakeRunner();
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    runner.run.mockImplementation(async (input) => {
      await gate;
      return { ...outcome(), daydreamId: input.daydreamId };
    });

    const first = maybeDaydreamAutomation(root, 'demo', entry, options(runner));
    const second = maybeDaydreamAutomation(root, 'demo', entry, options(runner));
    release();
    await Promise.all([first, second]);

    expect(runner.run).toHaveBeenCalledTimes(1);
    expect((await status(root)).runs).toHaveLength(1);
  });

  it('keeps project concurrency at one while allowing sequential agents', async () => {
    const { root, agents } = await setup([worker('one'), worker('two')]);
    let active = 0;
    let maximum = 0;
    const runner = fakeRunner();
    runner.run.mockImplementation(async (input) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return { ...outcome(), daydreamId: input.daydreamId };
    });

    await Promise.all(agents.map((agent) => maybeDaydreamAutomation(root, 'demo', agent, options(runner))));

    expect(maximum).toBe(1);
    expect(runner.run).toHaveBeenCalledTimes(2);
  });
});

describe('atomic daily budgets', () => {
  it.each([
    { scope: 'agent', field: 'runs', ceiling: 1 },
    { scope: 'agent', field: 'prompts', ceiling: 3 },
    { scope: 'agent', field: 'compactions', ceiling: 1 },
    { scope: 'project', field: 'runs', ceiling: 1 },
    { scope: 'project', field: 'prompts', ceiling: 3 },
    { scope: 'project', field: 'compactions', ceiling: 1 },
  ] as const)('reserves the $scope $field ceiling before any native effect', async ({ scope, field, ceiling }) => {
    const agents = [worker('one'), worker('two')];
    const { root } = await setup(agents);
    const runner = fakeRunner();
    const limits = budgets(
      scope === 'agent' ? { [field]: ceiling } : {},
      scope === 'project' ? { [field]: ceiling } : {},
    );

    if (scope === 'agent') {
      await maybeDaydreamAutomation(root, 'demo', agents[0], options(runner, { budgets: limits }));
      await maybeDaydreamAutomation(root, 'demo', agents[0], options(runner, {
        budgets: limits,
        now: NOW + IDLE + 60_000,
        activityAt: ACTIVITY + 60_000,
      }));
    } else {
      await Promise.all(agents.map((agent) => maybeDaydreamAutomation(root, 'demo', agent, options(runner, { budgets: limits }))));
    }

    expect(runner.run).toHaveBeenCalledTimes(1);
    expect((await status(root)).runs).toHaveLength(1);
  });

  it('records token usage as evidence without treating it as a budget', async () => {
    const { root, agents: [entry] } = await setup();
    const runner = fakeRunner({ ...outcome(), tokens: 1_000_000_000_000 });

    await maybeDaydreamAutomation(root, 'demo', entry, options(runner));
    await maybeDaydreamAutomation(root, 'demo', entry, options(runner, {
      now: NOW + IDLE + 60_000,
      activityAt: ACTIVITY + 60_000,
    }));

    expect(runner.run).toHaveBeenCalledTimes(2);
    expect((await status(root)).daily.project).toMatchObject({ runs: 2, prompts: 4, compactions: 2 });
    expect((await status(root)).runs.every((run) => run.tokens === 1_000_000_000_000)).toBe(true);
  });

  it('starts a fresh daily budget window without resetting fingerprint dedupe', async () => {
    const { root, agents: [entry] } = await setup();
    const runner = fakeRunner();
    const limits = budgets({ runs: 1, prompts: 3, compactions: 1 }, { runs: 1, prompts: 3, compactions: 1 });

    await maybeDaydreamAutomation(root, 'demo', entry, options(runner, { budgets: limits }));
    const later = {
      budgets: limits,
      now: NOW + IDLE + 60_000,
      activityAt: ACTIVITY + 60_000,
    };
    await maybeDaydreamAutomation(root, 'demo', entry, options(runner, later));
    expect(runner.run).toHaveBeenCalledTimes(1);

    await maybeDaydreamAutomation(root, 'demo', entry, options(runner, {
      ...later,
      now: NOW + 24 * 60 * 60_000,
    }));
    expect(runner.run).toHaveBeenCalledTimes(2);

    await maybeDaydreamAutomation(root, 'demo', entry, options(runner, {
      ...later,
      now: NOW + 24 * 60 * 60_000 + 5_000,
    }));
    expect(runner.run).toHaveBeenCalledTimes(2);
  });
});

describe('unknown outcomes and lifecycle boundaries', () => {
  it.each(['prompt', 'fork', 'compaction'] as const)('fences an ambiguous %s until read-only reconcile', async (stage) => {
    const { root, agents: [entry] } = await setup();
    const runner = fakeRunner({ ...outcome('unknown'), unknownStage: stage });

    await maybeDaydreamAutomation(root, 'demo', entry, options(runner));
    const daydreamId = runner.run.mock.calls[0][0].daydreamId;
    await maybeDaydreamAutomation(root, 'demo', entry, options(runner, {
      now: NOW + IDLE + 60_000,
      activityAt: ACTIVITY + 60_000,
    }));

    expect(runner.run).toHaveBeenCalledTimes(1);
    expect((await status(root)).agents[0]).toMatchObject({ fencedDaydreamId: daydreamId });
    expect((await status(root)).runs[0]).toMatchObject({ status: 'unknown', unknownStage: stage });

    runner.reconcile.mockResolvedValueOnce({ ...outcome('unknown'), daydreamId, unknownStage: stage });
    await reconcileDaydreamAutomation(root, 'demo', daydreamId, options(runner));
    await maybeDaydreamAutomation(root, 'demo', entry, options(runner, {
      now: NOW + 2 * IDLE,
      activityAt: ACTIVITY + 2 * 60_000,
    }));
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(runner.reconcile).toHaveBeenCalledTimes(1);
  });

  it('does not report a fourth prompt as a successful run', async () => {
    const { root, agents: [entry] } = await setup();
    const runner = fakeRunner({ ...outcome(), prompts: 4 });

    await maybeDaydreamAutomation(root, 'demo', entry, options(runner));

    expect((await status(root)).runs[0].status).toBe('unknown');
  });
});

describe('manual automation CLI', () => {
  it('sets and reports one agent without enabling automation globally or native daydreams', async () => {
    vi.stubEnv('HIVE_DAYDREAM_AUTOMATION', '0');
    vi.stubEnv('HIVE_DAYDREAM', '0');
    vi.stubEnv('HIVE_NATIVE_BRANCHES', '0');
    const entry = { ...worker(), daydream_automation: false };
    const { root, home } = await setup([entry]);

    await daydreamCommand(root, ['automation', 'demo', 'builder', 'on']);
    expect((await readTeam(home)).agents[0].daydream_automation).toBe(true);
    await daydreamCommand(root, ['automation', 'demo', 'builder', 'status']);
    expect(vi.mocked(console.log)).toHaveBeenLastCalledWith(expect.stringContaining('"daydreamAutomation": true'));
    expect((await status(root)).agents[0]).not.toHaveProperty('enabled');
    await daydreamCommand(root, ['automation', 'demo', 'builder', 'off']);
    expect((await readTeam(home)).agents[0].daydream_automation).toBe(false);
    expect((await status(root)).runs).toEqual([]);
  });

  it('rejects orchestrator opt-in at the control boundary but allows project status', async () => {
    const orchestrator = { ...worker('demo-orchestrator'), orchestrator: true, daydream_automation: false };
    const { root, home } = await setup([orchestrator]);

    await expect(daydreamCommand(root, ['automation', 'demo', 'on'])).rejects.toThrow(/orchestrator|worker|agent/i);
    await expect(setDaydreamAutomation(root, 'demo', undefined, true)).rejects.toThrow(/orchestrator|worker|agent/i);
    expect((await readTeam(home)).agents[0].daydream_automation).toBe(false);
    expect((await status(root)).runs).toEqual([]);

    await daydreamCommand(root, ['automation', 'demo', 'status']);
    expect(vi.mocked(console.log)).toHaveBeenLastCalledWith(expect.stringContaining('demo-orchestrator'));
  });

  it('keeps automation independent from the existing auto_compact control', async () => {
    const entry = { ...worker(), auto_compact: true, daydream_automation: false };
    const { root, home } = await setup([entry]);

    await setDaydreamAutomation(root, 'demo', 'builder', true);

    expect((await readTeam(home)).agents[0]).toMatchObject({ auto_compact: true, daydream_automation: true });
  });
});
