import { spawnSync } from 'node:child_process';
import { promises as fs, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendTaskEvent, hivePath, hubPath, writeJson } from '../src/state.js';
import type { TeamEntry, TmuxAdmission } from '../src/types.js';
import { readTaskUsage } from '../src/usage.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AT = '2026-11-22T12:00:00.000Z';

afterEach(() => vi.restoreAllMocks());

const CORPUS = JSON.parse(readFileSync(path.join(repository, 'test', 'fixtures', 'usage-main-wire-corpus.json'), 'utf8')) as {
  provenance: string;
  expected_shares: { attributed: number; orphan: number; unpriced: number };
  runs: {
    attribution: 'attributed' | 'orphan';
    events: Record<string, unknown>[];
    expected: Record<string, number | string>;
  }[];
};

function turnEnd(type = 'turn.ended', turnId = 'turn-1'): string {
  return JSON.stringify({ type, agentId: 'main', turnId, time: 1_763_000_000_000 });
}

function toolCall(payload: string): string {
  return JSON.stringify({
    type: 'context.append_loop_event', agentId: 'main', time: 1_763_000_000_001,
    event: { type: 'tool.call', name: 'Bash', args: { command: payload } },
  });
}

function usage(inputOther: number, output: number, inputCacheRead = 0, inputCacheCreation = 0): string {
  return JSON.stringify({
    type: 'usage.record', agentId: 'main', model: 'kimi-code/k3', usageScope: 'turn',
    usage: { inputOther, output, inputCacheRead, inputCacheCreation }, time: 1_763_000_000_002,
  });
}

function admission(agent: string, leaseId: string, attempt: number, lineage = `lineage-${leaseId}`): TmuxAdmission {
  return {
    task: 'demo-1', project: 'demo', agent, parent_id: 'demo-1', plan_digest: 'plan-1',
    root_lease_epoch: 1, lease_id: leaseId, lease_epoch: 1, lease_revoked: false,
    output_claim: 'fixture', acceptance_ids: ['fixture'], write_scope: [], adapter: 'tmux',
    provenance: { repository: 'octo/demo', base_revision: '0'.repeat(40), artifact_revision: '1'.repeat(40) },
    provenance_digest: 'provenance-1', lineage_id: lineage, attempts_used: attempt,
    status: 'running', retry_of: attempt === 1 ? undefined : 'lease-1',
  };
}

function attemptEntry(agent: string, leaseId: string, attempt: number, lineage = `lineage-${leaseId}`): TeamEntry {
  return {
    name: agent, task: 'demo-1', session_id: `session_${leaseId}`, lease_id: leaseId,
    parent_id: 'demo-1', plan_digest: 'plan-1', root_lease_epoch: 1, lease_epoch: 1,
    lineage_id: lineage, attempts_used: attempt, worktree: `/wt/${leaseId}`,
    admission_status: 'running', retry_of: attempt === 1 ? undefined : 'lease-1',
  };
}

async function setup(entries: TeamEntry[], wires: Record<string, string[]>) {
  const root = mkdtempSync(path.join(tmpdir(), 'hive-usage-root-'));
  const home = mkdtempSync(path.join(tmpdir(), 'hive-usage-home-'));
  const projectHome = path.join(root, 'demo');
  await writeJson(hubPath(root, 'projects.json'), { projects: [{ name: 'demo', home: projectHome, repos: [] }] });
  await writeJson(hivePath(projectHome, 'team.json'), { agents: entries });
  await appendTaskEvent(root, { id: 'demo-1', project: 'demo', event: 'asked', at: AT, lease_epoch: 1 });
  for (const [sessionId, lines] of Object.entries(wires)) {
    const sessionDir = path.join(home, '.kimi-code', 'sessions', 'wd_fixture', sessionId);
    const dir = path.join(sessionDir, 'agents', 'main');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'wire.jsonl'), `${lines.join('\n')}\n`);
    const entry = entries.find((candidate) => candidate.session_id === sessionId);
    if (entry?.worktree) await fs.writeFile(path.join(sessionDir, 'state.json'), JSON.stringify({ cwd: entry.worktree, updatedAt: 1 }));
  }
  return { root, home, projectHome };
}

function cli(root: string, home: string, args: string[]) {
  const tsx = path.join(repository, 'node_modules', '.bin', 'tsx');
  return spawnSync(tsx, [path.join(repository, 'src', 'cli.ts'), ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, HOME: home },
  });
}

describe('per-attempt task usage', () => {
  it('joins independent first attempts and exposes the same metadata through the CLI JSON seam', async () => {
    const entries = [attemptEntry('builder-a', 'lease-1', 1), attemptEntry('builder-b', 'lease-2', 1)];
    const { root, home } = await setup(entries, {
      'session_lease-1': [turnEnd(), toolCall('private-first-payload'), usage(10, 3, 2, 1)],
      'session_lease-2': [
        turnEnd('turn.ended', 'turn-2a'), turnEnd('turn.ended', 'turn-2b'),
        turnEnd('agent.turn.ended', 'turn-2b'), toolCall('private-second-payload'), usage(20, 5, 4),
      ],
    });
    for (const entry of entries) {
      await appendTaskEvent(root, {
        id: 'demo-1', project: 'demo', event: 'admission', at: AT,
        admission: admission(entry.name, entry.lease_id!, entry.attempts_used!),
      });
    }

    const result = await readTaskUsage(root, 'demo-1', home);

    expect(result).toEqual({
      task: 'demo-1',
      attempts: [
        {
          task: 'demo-1', agent: 'builder-a', session_id: 'session_lease-1', lease_id: 'lease-1',
          lineage_id: 'lineage-lease-1', attempt: 1, attribution: 'attributed',
          turns: 1, tool_calls: 1, input_tokens: 13, output_tokens: 3, total_tokens: 16, cost_usd: 'unknown',
        },
        {
          task: 'demo-1', agent: 'builder-b', session_id: 'session_lease-2', lease_id: 'lease-2',
          lineage_id: 'lineage-lease-2', attempt: 1, attribution: 'attributed',
          turns: 2, tool_calls: 1, input_tokens: 24, output_tokens: 5, total_tokens: 29, cost_usd: 'unknown',
        },
      ],
    });
    const rendered = cli(root, home, ['hub', 'usage', 'demo-1']);
    expect(rendered.status).toBe(0);
    expect(JSON.parse(rendered.stdout)).toEqual(result);
    expect(rendered.stdout).not.toContain('private-first-payload');
    expect(rendered.stdout).not.toContain('private-second-payload');
  });

  it('marks an incomplete attempt as an orphan and does not mutate state or wire files', async () => {
    const orphan: TeamEntry = { name: 'detached', task: 'demo-1', session_id: 'session_orphan', worktree: '/wt/orphan' };
    const foreign = { ...attemptEntry('foreign', 'lease-foreign', 1), task: 'demo-2' };
    const { root, home, projectHome } = await setup([orphan, foreign], {
      session_orphan: [turnEnd()],
      'session_lease-foreign': [turnEnd(), toolCall('foreign-private-payload'), usage(99, 99)],
    });
    const files = [
      hubPath(root, 'projects.json'), hubPath(root, 'tasks.jsonl'), hivePath(projectHome, 'team.json'),
      path.join(home, '.kimi-code', 'sessions', 'wd_fixture', 'session_orphan', 'agents', 'main', 'wire.jsonl'),
    ];
    const before = await Promise.all(files.map((file) => fs.readFile(file, 'utf8')));

    const result = await readTaskUsage(root, 'demo-1', home);

    expect(result).toEqual({
      task: 'demo-1',
      attempts: [{
        task: 'demo-1', agent: 'detached', session_id: 'session_orphan', lease_id: 'unknown',
        lineage_id: 'unknown', attempt: 'unknown', attribution: 'orphan',
        turns: 1, tool_calls: 0, input_tokens: 'unknown', output_tokens: 'unknown',
        total_tokens: 'unknown', cost_usd: 'unknown',
      }],
    });
    expect(JSON.stringify(result)).not.toContain('foreign-private-payload');
    expect(await Promise.all(files.map((file) => fs.readFile(file, 'utf8')))).toEqual(before);
  });

  it('orphans a reused-session replacement and its missing prior current entry', async () => {
    const lineage = 'lineage-shared';
    const current = {
      ...attemptEntry('builder', 'lease-2', 2, lineage), session_id: 'session_shared', worktree: '/wt/shared',
    };
    const { root, home } = await setup([current], { session_shared: [turnEnd(), usage(50, 5)] });
    await appendTaskEvent(root, {
      id: 'demo-1', project: 'demo', event: 'admission', at: AT, admission: admission('builder', 'lease-1', 1, lineage),
    });
    await appendTaskEvent(root, {
      id: 'demo-1', project: 'demo', event: 'admission', at: AT,
      admission: admission('builder', 'lease-2', 2, lineage), supersedes: ['lease-1'],
    });

    const result = await readTaskUsage(root, 'demo-1', home);

    expect(result).toEqual({
      task: 'demo-1',
      attempts: [
        {
          task: 'demo-1', agent: 'builder', session_id: 'unknown', lease_id: 'lease-1', lineage_id: lineage,
          attempt: 1, attribution: 'orphan', turns: 'unknown', tool_calls: 'unknown', input_tokens: 'unknown',
          output_tokens: 'unknown', total_tokens: 'unknown', cost_usd: 'unknown',
        },
        {
          task: 'demo-1', agent: 'builder', session_id: 'session_shared', lease_id: 'lease-2', lineage_id: lineage,
          attempt: 2, attribution: 'orphan', turns: 'unknown', tool_calls: 'unknown', input_tokens: 'unknown',
          output_tokens: 'unknown', total_tokens: 'unknown', cost_usd: 'unknown',
        },
      ],
    });
  });

  it.each(['incomplete', 'mismatched'] as const)('keeps a %s unmatched retry orphan unmeasured', async (kind) => {
    const entry = attemptEntry('builder', 'lease-2', 2);
    const { root, home } = await setup([entry], { 'session_lease-2': [turnEnd(), usage(50, 5)] });
    if (kind === 'mismatched') {
      await appendTaskEvent(root, {
        id: 'demo-1', project: 'demo', event: 'admission', at: AT,
        admission: admission('other', 'lease-2', 2, 'lineage-other'),
      });
    }

    const result = await readTaskUsage(root, 'demo-1', home);

    expect(result.attempts).toHaveLength(kind === 'mismatched' ? 2 : 1);
    expect(result.attempts.at(-1)).toMatchObject({
      agent: 'builder', session_id: 'session_lease-2', attribution: 'orphan',
      turns: 'unknown', tool_calls: 'unknown', input_tokens: 'unknown',
      output_tokens: 'unknown', total_tokens: 'unknown', cost_usd: 'unknown',
    });
  });

  it.each([
    { field: 'agent', change: (entry: TeamEntry) => ({ ...entry, name: 'other' }) },
    { field: 'lease', change: (entry: TeamEntry) => ({ ...entry, lease_id: 'lease-other' }) },
    { field: 'plan digest', change: (entry: TeamEntry) => ({ ...entry, plan_digest: 'plan-other' }) },
    { field: 'root epoch', change: (entry: TeamEntry) => ({ ...entry, root_lease_epoch: 2 }) },
    { field: 'lease epoch', change: (entry: TeamEntry) => ({ ...entry, lease_epoch: 2 as const }) },
    { field: 'lineage', change: (entry: TeamEntry) => ({ ...entry, lineage_id: 'lineage-other' }) },
    { field: 'attempt', change: (entry: TeamEntry) => ({ ...entry, attempts_used: 2 }) },
  ])('rejects a $field identity mismatch', async ({ change }) => {
    const original = attemptEntry('builder', 'lease-1', 1);
    const entry = change(original);
    const { root, home } = await setup([entry], { 'session_lease-1': [turnEnd(), usage(1, 1)] });
    await appendTaskEvent(root, {
      id: 'demo-1', project: 'demo', event: 'admission', at: AT, admission: admission('builder', 'lease-1', 1),
    });

    const result = await readTaskUsage(root, 'demo-1', home);

    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({
      attribution: 'orphan', session_id: 'unknown', turns: 'unknown', tool_calls: 'unknown',
      input_tokens: 'unknown', output_tokens: 'unknown', total_tokens: 'unknown', cost_usd: 'unknown',
    });
    expect(result.attempts[1]).toMatchObject({
      attribution: 'orphan', session_id: 'session_lease-1', turns: 1,
      input_tokens: 1, output_tokens: 1, total_tokens: 2, cost_usd: 'unknown',
    });
  });

  it('returns unknown when the session identity changes after cwd validation', async () => {
    const entry = attemptEntry('builder', 'lease-1', 1);
    const { root, home } = await setup([entry], { 'session_lease-1': [turnEnd(), usage(1, 1)] });
    await appendTaskEvent(root, {
      id: 'demo-1', project: 'demo', event: 'admission', at: AT, admission: admission('builder', 'lease-1', 1),
    });
    const sessionDir = path.join(home, '.kimi-code', 'sessions', 'wd_fixture', 'session_lease-1');
    const open = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (file, flags) => {
      if (String(file) === sessionDir) {
        await fs.rename(sessionDir, `${sessionDir}-old`);
        await fs.cp(`${sessionDir}-old`, sessionDir, { recursive: true });
      }
      return open(file, flags);
    });

    const result = await readTaskUsage(root, 'demo-1', home);

    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({
      attribution: 'attributed', turns: 'unknown', tool_calls: 'unknown', input_tokens: 'unknown',
      output_tokens: 'unknown', total_tokens: 'unknown', cost_usd: 'unknown',
    });
  });

  it.each(['duplicate', 'cwd', 'workdir-symlink', 'state-symlink', 'agents-symlink', 'main-symlink'] as const)('rejects a %s session candidate', async (kind) => {
    const entry = attemptEntry('builder', 'lease-1', 1);
    const { root, home } = await setup([entry], { 'session_lease-1': [turnEnd(), usage(1, 1)] });
    await appendTaskEvent(root, {
      id: 'demo-1', project: 'demo', event: 'admission', at: AT, admission: admission('builder', 'lease-1', 1),
    });
    const base = path.join(home, '.kimi-code', 'sessions');
    const sessionDir = path.join(base, 'wd_fixture', 'session_lease-1');
    if (kind === 'duplicate') await fs.cp(sessionDir, path.join(base, 'wd_other', 'session_lease-1'), { recursive: true });
    if (kind === 'cwd') await fs.writeFile(path.join(sessionDir, 'state.json'), JSON.stringify({ cwd: '/wt/other', updatedAt: 2 }));
    if (kind === 'workdir-symlink') {
      const outside = path.join(home, 'outside');
      await fs.rename(path.join(base, 'wd_fixture'), outside);
      await fs.symlink(outside, path.join(base, 'wd_fixture'), 'dir');
    }
    if (kind === 'state-symlink') {
      const state = path.join(sessionDir, 'state.json');
      const target = path.join(sessionDir, 'state-target.json');
      await fs.rename(state, target);
      await fs.symlink(target, state);
    }
    if (kind === 'agents-symlink' || kind === 'main-symlink') {
      const parent = kind === 'agents-symlink' ? sessionDir : path.join(sessionDir, 'agents');
      const name = kind === 'agents-symlink' ? 'agents' : 'main';
      await fs.rename(path.join(parent, name), path.join(parent, `${name}-real`));
      await fs.symlink(path.join(parent, `${name}-real`), path.join(parent, name), 'dir');
    }

    const result = await readTaskUsage(root, 'demo-1', home);

    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({
      attribution: 'attributed', turns: 'unknown', tool_calls: 'unknown', input_tokens: 'unknown',
      output_tokens: 'unknown', total_tokens: 'unknown', cost_usd: 'unknown',
    });
  });

  it('replays a checked-in metadata corpus with independent expectations', async () => {
    expect(['synthetic-contract-fixture', '20-real-recorded-kimi-main-wire-runs']).toContain(CORPUS.provenance);
    expect(CORPUS.runs).toHaveLength(20);
    const entries = CORPUS.runs.map((_, index) => attemptEntry(`builder-${index}`, `lease-${index}`, 1));
    const wires = Object.fromEntries(CORPUS.runs.map((run, index) => [
      entries[index].session_id!, run.events.map((event) => JSON.stringify(event)),
    ]));
    const { root, home } = await setup(entries, wires);
    for (const [index, run] of CORPUS.runs.entries()) {
      if (run.attribution === 'orphan') continue;
      const entry = entries[index];
      await appendTaskEvent(root, {
        id: 'demo-1', project: 'demo', event: 'admission', at: AT,
        admission: admission(entry.name, entry.lease_id!, entry.attempts_used!),
      });
    }

    const result = await readTaskUsage(root, 'demo-1', home);

    expect(result.attempts).toHaveLength(20);
    expect(new Set(result.attempts.map((row) => row.session_id)).size).toBe(20);
    expect({
      attributed: result.attempts.filter((row) => row.attribution === 'attributed').length,
      orphan: result.attempts.filter((row) => row.attribution === 'orphan').length,
      unpriced: result.attempts.filter((row) => row.cost_usd === 'unknown').length,
    }).toEqual(CORPUS.expected_shares);
    for (const [index, run] of CORPUS.runs.entries()) {
      const row = result.attempts.find((candidate) => candidate.agent === `builder-${index}`)!;
      expect(row.attribution).toBe(run.attribution);
      expect(row).toMatchObject(run.expected);
    }
  });

  it('propagates a non-ENOENT wire read failure', async () => {
    const entry: TeamEntry = { name: 'broken', task: 'demo-1', session_id: 'session_broken', worktree: '/wt/broken' };
    const { root, home } = await setup([entry], { session_broken: [] });
    const wire = path.join(home, '.kimi-code', 'sessions', 'wd_fixture', 'session_broken', 'agents', 'main', 'wire.jsonl');
    await fs.unlink(wire);
    await fs.mkdir(wire, { recursive: true });

    await expect(readTaskUsage(root, 'demo-1', home)).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('rejects bad CLI arity and an unknown task without repeating the full fixture matrix', async () => {
    const { root, home } = await setup([], {});
    for (const args of [['hub', 'usage'], ['hub', 'usage', 'demo-1', 'extra']]) {
      const result = cli(root, home, args);
      expect(result.status).toBe(64);
      expect(result.stderr).toMatch(/usage: hive hub usage <task>/);
    }
    const missing = cli(root, home, ['hub', 'usage', 'demo-99']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/unknown task: demo-99/);
  });
});
