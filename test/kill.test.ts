import { promises as fs, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/tmux.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/tmux.js')>();
  return {
    ...orig,
    paneExists: vi.fn(async () => true),
    killWindow: vi.fn(async () => {}),
  };
});

import { cascadeTargets, killAgent, killLine } from '../src/kill.js';
import { hivePath, hubPath, readDecisions, readTeam, writeJson } from '../src/state.js';
import { killWindow, paneExists } from '../src/tmux.js';

const ORCH = { name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 1, pane_started: 'x' };
const TEAM = [
  ORCH,
  { name: 'builder', pane: '%2', pane_pid: 2, pane_started: 'y', parent: 'demo-orchestrator' },
  { name: 'fixer', pane: '%3', pane_pid: 3, pane_started: 'z', parent: 'demo-orchestrator' },
  { name: 'lone', pane: '%4', pane_pid: 4, pane_started: 'w' },
];

async function setup(agents: Record<string, unknown>[]) {
  const root = mkdtempSync(path.join(tmpdir(), 'hive-kill-'));
  const home = path.join(root, 'demo');
  await fs.mkdir(home, { recursive: true });
  await writeJson(hubPath(root, 'projects.json'), {
    projects: [{ name: 'demo', home, repos: [{ folder: home }] }],
  });
  await writeJson(hivePath(home, 'team.json'), { agents });
  return { root, home };
}

beforeEach(() => {
  vi.mocked(paneExists).mockClear().mockImplementation(async () => true);
  vi.mocked(killWindow).mockClear().mockImplementation(async () => {});
});

describe('cascadeTargets', () => {
  it('orders children first, the orchestrator last, and skips parentless agents', () => {
    const ts = cascadeTargets({ agents: TEAM as never });
    expect(ts.map((t) => t.name)).toEqual(['builder', 'fixer', 'demo-orchestrator']);
  });

  it('is empty without an orchestrator', () => {
    expect(cascadeTargets({ agents: [] })).toEqual([]);
  });
});

describe('killAgent cascade', () => {
  it('kills children first, the orchestrator last, and leaves parentless agents alone', async () => {
    const { root, home } = await setup(TEAM);
    const r = await killAgent(root, 'demo');
    expect(r).toMatchObject({ target: 'demo-orchestrator', killed: ['builder', 'fixer', 'demo-orchestrator'] });
    expect(vi.mocked(killWindow).mock.calls.map((c) => c[0])).toEqual(['%2', '%3', '%1']);
    expect((await readTeam(home)).agents.map((a) => a.name)).toEqual(['lone']);
  });

  it('stamps every target closed before the first pane dies', async () => {
    const { root, home } = await setup(TEAM);
    let stampedAtFirstKill = false;
    vi.mocked(killWindow).mockImplementation(async () => {
      const team = await readTeam(home);
      stampedAtFirstKill = team.agents
        .filter((a) => a.name !== 'lone')
        .every((a) => typeof a.closed_at === 'string');
    });
    await killAgent(root, 'demo');
    expect(stampedAtFirstKill).toBe(true);
  });

  it('un-stamps the survivors when a kill fails mid-cascade', async () => {
    const { root, home } = await setup(TEAM);
    vi.mocked(killWindow).mockImplementation(async (pane) => {
      if (pane === '%3') throw new Error('tmux down');
    });
    await expect(killAgent(root, 'demo')).rejects.toThrow('tmux down');
    const team = await readTeam(home);
    expect(team.agents.map((a) => a.name)).toEqual(['demo-orchestrator', 'fixer', 'lone']);
    expect(team.agents.find((a) => a.name === 'fixer')?.closed_at).toBeUndefined();
    expect(team.agents.find((a) => a.name === 'demo-orchestrator')?.closed_at).toBeUndefined();
  });

  it('logs what died when the cascade fails partway', async () => {
    const { root } = await setup(TEAM);
    vi.mocked(killWindow).mockImplementation(async (pane) => {
      if (pane === '%3') throw new Error('tmux down');
    });
    await expect(killAgent(root, 'demo')).rejects.toThrow('tmux down');
    const decisions = await readDecisions(root);
    expect(decisions[0]).toMatchObject({
      by: 'owner',
      project: 'demo',
      summary: 'killed builder of the demo-orchestrator cascade before tmux down; not killed: fixer, demo-orchestrator',
    });
  });

  it('stamps by name and worktree: a same-named twin elsewhere stays visible to the watch', async () => {
    const { root, home } = await setup([
      ORCH,
      { name: 'builder', pane: '%2', pane_pid: 2, pane_started: 'y', parent: 'demo-orchestrator', worktree: '/wt/a' },
      { name: 'builder', pane: '%7', pane_pid: 7, pane_started: 'u', worktree: '/wt/b' },
    ]);
    await killAgent(root, 'demo');
    const team = await readTeam(home);
    expect(team.agents).toHaveLength(1);
    expect(team.agents[0]).toMatchObject({ name: 'builder', worktree: '/wt/b', pane: '%7' });
    expect(team.agents[0].closed_at).toBeUndefined();
  });

  it('keeps an entry a respawn re-identified between the stamp and the drop', async () => {
    const { root, home } = await setup(TEAM);
    vi.mocked(killWindow).mockImplementation(async (pane) => {
      if (pane === '%2') {
        // A respawn landed mid-cascade: same name and worktree, fresh pane.
        const team = await readTeam(home);
        await writeJson(hivePath(home, 'team.json'), {
          agents: team.agents.map((a) => (a.name === 'builder'
            ? { ...a, pane: '%9', pane_pid: 9, pane_started: 'new', closed_at: undefined }
            : a)),
        });
      }
    });
    const r = await killAgent(root, 'demo');
    const team = await readTeam(home);
    expect(team.agents.map((a) => a.name).sort()).toEqual(['builder', 'lone']);
    expect(team.agents.find((a) => a.name === 'builder')?.pane).toBe('%9');
    // The kept entry is not named as killed: the toast and the log name what died.
    expect(r.killed).toEqual(['fixer', 'demo-orchestrator']);
    const decisions = await readDecisions(root);
    expect(decisions[0]).toMatchObject({ summary: 'killed demo-orchestrator + 1 agent' });
  });

  it('refuses a pane with no recorded identity before anything dies', async () => {
    const { root } = await setup([...TEAM, { name: 'ghost', pane: '%5', parent: 'demo-orchestrator' }]);
    await expect(killAgent(root, 'demo')).rejects.toThrow(/no recorded pane identity/);
    expect(vi.mocked(killWindow).mock.calls).toEqual([]);
  });

  it('skips panes that are already dead', async () => {
    const { root } = await setup(TEAM);
    vi.mocked(paneExists).mockImplementation(async (pane) => pane !== '%2');
    await killAgent(root, 'demo');
    expect(vi.mocked(killWindow).mock.calls.map((c) => c[0])).toEqual(['%3', '%1']);
  });

  it('refuses a project with no orchestrator', async () => {
    const { root } = await setup([{ name: 'lone', pane: '%4', pane_pid: 4, pane_started: 'w' }]);
    await expect(killAgent(root, 'demo')).rejects.toThrow(/no orchestrator/);
  });

  it('refuses an unknown project', async () => {
    const { root } = await setup(TEAM);
    await expect(killAgent(root, 'nope')).rejects.toThrow(/unknown project/);
  });

  it('logs an owner decision with the cascade size', async () => {
    const { root } = await setup(TEAM);
    await killAgent(root, 'demo');
    const decisions = await readDecisions(root);
    expect(decisions[0]).toMatchObject({ by: 'owner', project: 'demo', summary: 'killed demo-orchestrator + 2 agents' });
  });
});

describe('killAgent one agent', () => {
  it('kills only that agent and its pane', async () => {
    const { root, home } = await setup(TEAM);
    const r = await killAgent(root, 'demo', 'builder');
    expect(r.killed).toEqual(['builder']);
    expect(vi.mocked(killWindow).mock.calls.map((c) => c[0])).toEqual(['%2']);
    expect((await readTeam(home)).agents.map((a) => a.name)).toEqual(['demo-orchestrator', 'fixer', 'lone']);
  });

  it('refuses a bare name that matches two agents, takes name@worktree', async () => {
    const { root } = await setup([
      ORCH,
      { name: 'builder', pane: '%2', pane_pid: 2, pane_started: 'y', worktree: '/wt/a' },
      { name: 'builder', pane: '%3', pane_pid: 3, pane_started: 'z', worktree: '/wt/b' },
    ]);
    await expect(killAgent(root, 'demo', 'builder')).rejects.toThrow(/say which/);
    await killAgent(root, 'demo', 'builder@/wt/b');
    expect(vi.mocked(killWindow).mock.calls.map((c) => c[0])).toEqual(['%3']);
  });

  it('refuses an unknown agent', async () => {
    const { root } = await setup(TEAM);
    await expect(killAgent(root, 'demo', 'ghost')).rejects.toThrow(/no agent named ghost/);
  });
});

describe('killLine', () => {
  it('prints one line for the CLI', async () => {
    const { root } = await setup(TEAM);
    expect(await killLine(root, 'demo')).toBe('hive: killed demo-orchestrator + 2 agents');
  });
});
