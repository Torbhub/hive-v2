import { promises as fs, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const DIALOG = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dialog-permission.txt'),
  'utf8',
);

vi.mock('../src/tmux.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/tmux.js')>();
  return {
    ...orig,
    newWindow: vi.fn(async () => '%9'),
    paneExists: vi.fn(async () => true),
    paneIdentity: vi.fn(async (pane: string) => pane === '%7'
      ? { pid: 7, started: 'pending' }
      : { pid: 1, started: 'x' }),
    paneIs: vi.fn(async () => true),
    capturePane: vi.fn(async () => DIALOG),
    run: vi.fn(orig.run),
    killWindow: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
    sendEnter: vi.fn(async () => {}),
    sendEscape: vi.fn(async () => {}),
    sendArrow: vi.fn(async () => {}),
    sendLiteral: vi.fn(async () => {}),
  };
});

vi.mock('../src/spawn.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/spawn.js')>();
  return {
    ...orig,
    preflight: vi.fn(async () => {}),
    waitIdle: vi.fn(async () => 'idle' as const),
    typeLine: vi.fn(async () => {}),
    findLatestSession: vi.fn(async () => null),
  };
});

import { capturePane, killWindow, newWindow, paneExists, paneIdentity, paneIs, run, sendArrow, sendEnter, sendLiteral } from '../src/tmux.js';
import {
  answerDialog, buildStatus, continueProject, hubAccept, hubAdd, hubInit, hubLog, hubProgress, hubTask, listTasks, menuKeys, planAnswer,
  readDialogFor, setProjectApprovals, setProjectMode, startProject, wake,
} from '../src/hub.js';
import { handleCurrentOrchestratorDialog } from '../src/watch.js';
import { findLatestSession, preflight, typeLine, waitIdle } from '../src/spawn.js';
import { killAgent } from '../src/kill.js';
import { removeProject } from '../src/project.js';
import { lines, parseDialog } from '../src/screen.js';
import { appendTaskEvent, hubPath, hivePath, readDecisions, readPendingPane, readProjects, readTeam, writeJson, writePendingPane, writeProjects } from '../src/state.js';
import type { Checkpoint } from '../src/types.js';
import { disableExecution } from '../src/rollout.js';

afterEach(() => {
  delete process.env.HIVE_COLLABORATION_ENABLED;
});

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'hive-hub-'));
  const home = path.join(root, 'demo');
  await fs.mkdir(home, { recursive: true });
  await hubInit(root);
  await hubAdd(root, 'demo', home);
  return { root, home };
}

describe('buildStatus pane identity', () => {
  it('reports cannot tell when a live pane has a different process identity', async () => {
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 11, pane_started: 'old' }],
    });
    vi.mocked(paneExists).mockResolvedValue(true);
    vi.mocked(paneIs).mockResolvedValueOnce(false);
    const status = await buildStatus(root);
    expect(status.projects[0].orchestrator.state).toBe('unknown');
    expect(status.projects[0].orchestrator.pane).toBeUndefined();
    expect(paneIs).toHaveBeenCalledWith('%1', { pid: 11, started: 'old' });
  });

  it('exposes the pane only when its recorded process identity matches', async () => {
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'citadel-orchestrator', orchestrator: true, pane: '%15', pane_pid: 11, pane_started: 'fresh' }],
    });
    vi.mocked(paneExists).mockResolvedValue(true);
    vi.mocked(paneIs).mockResolvedValueOnce(true);
    const status = await buildStatus(root);
    expect(status.projects[0].orchestrator).toMatchObject({ state: 'running', pane: '%15' });
  });
  it('exposes compaction status without the preservation instruction', async () => {
    const { root, home } = await setup();
    const compaction = {
      session_id: 'session_b', status: 'ambiguous', at: '2026-11-06T12:00:00Z', attempts: 1,
      instruction: '/compact private task details', detail: 'delivery is unknown',
    };
    await writeJson(hivePath(home, 'team.json'), {
      agents: [
        { name: 'demo-orchestrator', orchestrator: true, compaction: { ...compaction, instruction: undefined } },
        { name: 'builder', pane: '%2', pane_pid: 22, pane_started: 'b', auto_compact: false, compaction },
      ],
    });
    const status = await buildStatus(root);
    expect(status.projects[0].orchestrator.auto_compact).toBe(true);
    expect(status.projects[0].agents[0]).toMatchObject({ auto_compact: false, compaction: { status: 'ambiguous', detail: 'delivery is unknown' } });
    expect(status.projects[0].agents[0].compaction).not.toHaveProperty('instruction');
  });
});

describe('buildStatus structured questions', () => {
  it('marks only agents with an open batch, including when no tmux dialog exists', async () => {
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [
        { name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 11, pane_started: 'a' },
        { name: 'builder', pane: '%2', pane_pid: 22, pane_started: 'b', worktree: '/wt/b' },
        { name: 'other', pane: '%3', pane_pid: 33, pane_started: 'c', worktree: '/wt/c' },
      ],
    });
    vi.mocked(capturePane)
      .mockResolvedValueOnce('│ >\n')
      .mockResolvedValueOnce('│ >\n')
      .mockResolvedValueOnce('│ >\n');
    const batch = (id: string, agent: string) => ({
      id, project: 'demo', agent, context: 'Choose.', status: 'open', createdAt: '2026-10-27T10:00:00Z',
      questions: [{ id: 'q1', question: 'Continue?', context: 'Context.', priority: 1, recommended: 'c1', choices: [
        { id: 'c1', label: 'Yes', description: 'Continue.' }, { id: 'c2', label: 'No', description: 'Stop.' },
      ] }],
    });
    await writeJson(hubPath(root, 'questions', '11111111-1111-4111-8111-111111111111.json'), batch('11111111-1111-4111-8111-111111111111', 'demo-orchestrator'));
    await writeJson(hubPath(root, 'questions', '22222222-2222-4222-8222-222222222222.json'), batch('22222222-2222-4222-8222-222222222222', 'builder'));

    const status = await buildStatus(root);
    expect(status.projects[0].orchestrator).toMatchObject({ question: true, operator_question: true });
    expect(status.projects[0].agents).toEqual([
      expect.objectContaining({ name: 'builder', question: true, operator_question: true }),
      expect.objectContaining({ name: 'other', question: false, operator_question: false }),
    ]);
  });

  it('tracks a native dialog separately when a structured batch is also open', async () => {
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'builder', pane: '%2', pane_pid: 22, pane_started: 'b', worktree: '/wt/b' }],
    });
    await writeJson(hubPath(root, 'questions', '33333333-3333-4333-8333-333333333333.json'), {
      id: '33333333-3333-4333-8333-333333333333', project: 'demo', agent: 'builder',
      context: 'Choose.', status: 'open', createdAt: '2026-10-27T10:00:00Z',
      waitHeartbeatAt: new Date().toISOString(),
      questions: [{ id: 'q1', question: 'Continue?', context: 'Context.', priority: 1, recommended: 'c1', choices: [
        { id: 'c1', label: 'Yes', description: 'Continue.' }, { id: 'c2', label: 'No', description: 'Stop.' },
      ] }],
    });
    const status = await buildStatus(root);
    expect(status.projects[0].agents[0]).toMatchObject({
      question: true, operator_question: true, operator_waiting: true, screen_question: true,
    });
  });
});

describe('hubAdd', () => {
  it('keeps legacy explicit folders and returns the resolved home', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hive-hub-add-'));
    const home = path.join(root, 'plain');
    await fs.mkdir(home, { recursive: true });
    await hubInit(root);
    const result = await hubAdd(root, 'plain', 'plain');
    expect(result).toEqual({ ok: true, name: 'plain', home });
    await expect(hubAdd(root, 'alias', path.join(root, '.', 'plain'))).rejects.toThrow(/already registered/);
  });

  it('allocates an empty repository for a name-only add', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'hive-hub-add-auto-'));
    await hubInit(root);
    const result = await hubAdd(root, 'fresh');
    expect(result.home).toBe(path.join(root, 'fresh'));
    expect((await fs.stat(path.join(result.home, '.git'))).isDirectory()).toBe(true);
  });
});

describe('hubTask', () => {
  it('allocates distinct ids under a concurrent storm', async () => {
    const { root } = await setup();
    const ids = await Promise.all([
      hubTask(root, 'demo', 'first'),
      hubTask(root, 'demo', 'second'),
      hubTask(root, 'demo', 'third'),
    ]);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^demo-\d+$/);
  });
});

describe('startProject task id', () => {
  it('rejects a traversal-shaped id before anything runs', async () => {
    const { root } = await setup();
    await expect(startProject(root, 'demo', '../../x')).rejects.toThrow(/task id/);
    await expect(startProject(root, 'demo', 'other-1')).rejects.toThrow(/task id/);
  });
  it('rejects a well-formed id with no task file', async () => {
    const { root } = await setup();
    await expect(startProject(root, 'demo', 'demo-99')).rejects.toThrow(/no task file/);
  });
});

describe('readDialogFor same-named agents', () => {
  async function setupTwins() {
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [
        { name: 'builder', pane: '%1', pane_pid: 11, pane_started: 'a', worktree: '/wt/a' },
        { name: 'builder', pane: '%2', pane_pid: 22, pane_started: 'b', worktree: '/wt/b' },
      ],
    });
    return root;
  }

  it('a bare name that matches two agents is an error, never a guess', async () => {
    const root = await setupTwins();
    await expect(readDialogFor(root, 'demo', 'builder')).rejects.toThrow(/say which/);
  });

  it('the @worktree form reads the matching pane', async () => {
    const root = await setupTwins();
    const d = await readDialogFor(root, 'demo', 'builder@/wt/b');
    expect(d).not.toBeNull();
    expect(d!.pane).toBe('%2');
    expect(d!.kind).toBe('numbered');
  });
});

const MENU = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dialog-trust-menu.txt'),
  'utf8',
);

const MENU3 = [
  'teamkimi run',
  ' ────────────────────────────',
  '  Pick one?',
  '  ↑↓ navigate · Enter select · Esc exit',
  '',
  '   ❯ Alpha',
  '     the first',
  '',
  '     Beta',
  '     the second',
  '',
  '     Gamma',
  '     the third',
  ' ────────────────────────────',
  '',
].join('\n');

describe('menuKeys', () => {
  it('computes the arrow walk from cursor to choice, then Enter', () => {
    expect(menuKeys(1, 1)).toEqual(['Enter']);
    expect(menuKeys(3, 1)).toEqual(['Down', 'Down', 'Enter']);
    expect(menuKeys(1, 3)).toEqual(['Up', 'Up', 'Enter']);
  });
});

describe('answerDialog on menus', () => {
  async function setupOrchestrator(screenText: string) {
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 1, pane_started: 'x' }],
    });
    vi.mocked(capturePane).mockImplementation(async () => screenText);
    vi.mocked(sendArrow).mockClear();
    vi.mocked(sendEnter).mockClear();
    return root;
  }

  it("answering '1' on the trust menu (cursor on 1) sends just Enter", async () => {
    const root = await setupOrchestrator(MENU);
    const fp = parseDialog(lines(MENU)).fingerprint;
    const r = await answerDialog(root, 'demo', undefined, '1', fp);
    expect(r.answered).toBe(true);
    expect(r.option).toBe('Trust this folder');
    expect(vi.mocked(sendArrow).mock.calls).toEqual([]);
    expect(vi.mocked(sendEnter).mock.calls).toEqual([['%1', { pid: 1, started: 'x' }]]);
  });

  it("answering '3' with the cursor on 1 sends Down Down Enter", async () => {
    const root = await setupOrchestrator(MENU3);
    const events: string[] = [];
    vi.mocked(sendArrow).mockImplementation(async (_pane, key) => {
      events.push(key);
    });
    vi.mocked(sendEnter).mockImplementation(async () => {
      events.push('Enter');
    });
    const fp = parseDialog(lines(MENU3)).fingerprint;
    const r = await answerDialog(root, 'demo', undefined, '3', fp);
    expect(r.option).toBe('Gamma');
    expect(events).toEqual(['Down', 'Down', 'Enter']);
  });

  it('refuses a paused answer before reading the dialog or sending keys', async () => {
    const root = await setupOrchestrator(MENU);
    await disableExecution(root, 'demo');
    process.env.HIVE_COLLABORATION_ENABLED = '1';
    vi.mocked(capturePane).mockClear();
    const fp = parseDialog(lines(MENU)).fingerprint;
    await expect(answerDialog(root, 'demo', undefined, '1', fp)).rejects.toThrow('rollout paused for demo');
    expect(vi.mocked(capturePane)).not.toHaveBeenCalled();
    expect(vi.mocked(sendArrow)).not.toHaveBeenCalled();
    expect(vi.mocked(sendEnter)).not.toHaveBeenCalled();
  });

  it('rechecks a pause during dialog read before sending keys', async () => {
    const root = await setupOrchestrator(MENU);
    process.env.HIVE_COLLABORATION_ENABLED = '1';
    vi.mocked(capturePane).mockImplementation(async () => {
      await disableExecution(root, 'demo');
      return MENU;
    });
    vi.mocked(sendArrow).mockClear();
    vi.mocked(sendEnter).mockClear();
    const fp = parseDialog(lines(MENU)).fingerprint;
    await expect(answerDialog(root, 'demo', undefined, '1', fp)).rejects.toThrow('rollout paused for demo');
    expect(vi.mocked(sendArrow)).not.toHaveBeenCalled();
    expect(vi.mocked(sendEnter)).not.toHaveBeenCalled();
  });

  it('a stale fingerprint refuses before any key is sent', async () => {
    const root = await setupOrchestrator(MENU);
    await expect(answerDialog(root, 'demo', undefined, '1', 'bogus')).rejects.toThrow(/dialog changed/);
    expect(vi.mocked(sendArrow).mock.calls).toEqual([]);
    expect(vi.mocked(sendEnter).mock.calls).toEqual([]);
  });
});

describe('decisions from hub actions', () => {
  it('answerDialog appends an owner decision', async () => {
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 1, pane_started: 'x' }],
    });
    vi.mocked(capturePane).mockImplementation(async () => DIALOG);
    const fp = parseDialog(lines(DIALOG)).fingerprint;
    await answerDialog(root, 'demo', undefined, '1', fp);
    const raw = await fs.readFile(hubPath(root, 'decisions.jsonl'), 'utf8');
    const d = JSON.parse(raw.trim());
    expect(d.by).toBe('owner');
    expect(d.project).toBe('demo');
    expect(d.summary).toMatch(/^answered "Approve once" for: /);
  });

  it('hub log decided mirrors into decisions.jsonl as orchestrator', async () => {
    const { root } = await setup();
    const id = await hubTask(root, 'demo', 'pick a schema');
    await hubLog(root, id, 'decided', 'postgres per the brief');
    const decisions = await readDecisions(root);
    expect(decisions[0]).toMatchObject({ by: 'orchestrator', project: 'demo', task: id, summary: 'postgres per the brief' });
    await hubLog(root, id, 'note', 'just a note');
    expect(await readDecisions(root)).toHaveLength(1);
  });
});

const IDLE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'idle-empty-prompt.txt'),
  'utf8',
);

const CPS: Checkpoint[] = [
  { id: 'c1', desc: 'first step', etaMin: 5 },
  { id: 'c2', desc: 'second step', etaMin: 10 },
];

describe('planAnswer', () => {
  async function setupPlan() {
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 1, pane_started: 'x' }],
    });
    const id = await hubTask(root, 'demo', 'build it');
    await hubLog(root, id, 'plan', 'the plan', CPS);
    return { root, id };
  }

  it('approve types the verdict and moves the task to answered', async () => {
    const { root, id } = await setupPlan();
    vi.mocked(capturePane).mockImplementation(async () => IDLE);
    const r = await planAnswer(root, 'demo', id, 'approve');
    expect(r.typed).toBe(`${id}: the plan is approved — go ahead.`);
    expect((await listTasks(root)).find((t) => t.id === id)?.state).toBe('answered');
    const decisions = await readDecisions(root);
    expect(decisions[0]).toMatchObject({ by: 'owner', project: 'demo', task: id, summary: 'approved the plan' });
  });

  it('sendback hands the task back with single-line feedback', async () => {
    const { root, id } = await setupPlan();
    vi.mocked(capturePane).mockImplementation(async () => IDLE);
    const r = await planAnswer(root, 'demo', id, 'sendback', 'too big\nsplit it');
    expect(r.typed).toBe(`${id}: the plan is sent back — too big split it.`);
    const t = (await listTasks(root)).find((x) => x.id === id);
    expect(t?.state).toBe('handed');
    expect(t?.needs_owner).toBe(false);
  });

  it('refuses while a dialog is on the screen', async () => {
    const { root, id } = await setupPlan();
    vi.mocked(capturePane).mockImplementation(async () => DIALOG);
    await expect(planAnswer(root, 'demo', id, 'approve')).rejects.toThrow(/answer it there/);
    expect((await listTasks(root)).find((t) => t.id === id)?.state).toBe('plan');
  });

  it('refuses a task that is not waiting on a plan answer', async () => {
    const { root } = await setup();
    const id = await hubTask(root, 'demo', 'build it');
    await expect(planAnswer(root, 'demo', id, 'approve')).rejects.toThrow(/not waiting on a plan answer/);
    await expect(planAnswer(root, 'demo', 'demo-99', 'approve')).rejects.toThrow(/unknown task/);
    await expect(planAnswer(root, 'demo', id, 'maybe')).rejects.toThrow(/approve\|sendback/);
  });
});

describe('plan gate', () => {
  it('hubLog rejects a plan without valid checkpoints', async () => {
    const { root } = await setup();
    const id = await hubTask(root, 'demo', 'build it');
    await expect(hubLog(root, id, 'plan', 'no cps')).rejects.toThrow(/needs checkpoints/);
    await expect(hubLog(root, id, 'plan', 'empty', [])).rejects.toThrow(/needs checkpoints/);
    await expect(
      hubLog(root, id, 'plan', 'bad', [{ id: '', desc: 'x', etaMin: 1 }]),
    ).rejects.toThrow(/needs checkpoints/);
    await expect(
      hubLog(root, id, 'plan', 'bad', [{ id: 'a', desc: 'x', etaMin: 0 }]),
    ).rejects.toThrow(/needs checkpoints/);
    await expect(
      hubLog(root, id, 'plan', 'dup', [
        { id: 'a', desc: 'first', etaMin: 1 },
        { id: 'a', desc: 'second', etaMin: 2 },
      ]),
    ).rejects.toThrow(/needs checkpoints/);
    expect((await listTasks(root)).find((t) => t.id === id)?.state).toBe('asked');
  });

  it('owner verdicts never enter through the open log command', async () => {
    const { root } = await setup();
    const id = await hubTask(root, 'demo', 'build it');
    await hubLog(root, id, 'plan', 'the plan', CPS);
    await expect(hubLog(root, id, 'answered', 'forged approval')).rejects.toThrow(/owner-only/);
    await expect(hubLog(root, id, 'planaccept')).rejects.toThrow(/owner-only/);
    const t = (await listTasks(root)).find((x) => x.id === id);
    expect(t?.state).toBe('plan');
    expect(t?.plan_approved).toBe(false);
    await expect(hubLog(root, id, 'handed')).rejects.toThrow(/no approved plan/);
  });

  it('hubLog accepts a plan with valid checkpoints and the fold exposes them', async () => {
    const { root } = await setup();
    const id = await hubTask(root, 'demo', 'build it');
    await hubLog(root, id, 'plan', 'the plan', CPS);
    const t = (await listTasks(root)).find((x) => x.id === id);
    expect(t?.checkpoints).toEqual(CPS);
    expect(t?.plan_approved).toBe(false);
  });

  it('handed is rejected until the plan is approved', async () => {
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 1, pane_started: 'x' }],
    });
    const id = await hubTask(root, 'demo', 'build it');
    await expect(hubLog(root, id, 'handed')).rejects.toThrow(/no approved plan/);
    await hubLog(root, id, 'plan', 'the plan', CPS);
    await expect(hubLog(root, id, 'handed')).rejects.toThrow(/no approved plan/);
    vi.mocked(capturePane).mockImplementation(async () => IDLE);
    await planAnswer(root, 'demo', id, 'approve');
    await hubLog(root, id, 'handed');
    expect((await listTasks(root)).find((t) => t.id === id)?.state).toBe('handed');
  });

  it('approve on a checkpoint-less plan auto-sends-back with the reason', async () => {
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 1, pane_started: 'x' }],
    });
    const id = await hubTask(root, 'demo', 'build it');
    await appendTaskEvent(root, {
      id, project: 'demo', event: 'plan', at: new Date().toISOString(), note: 'no cps',
    });
    vi.mocked(capturePane).mockImplementation(async () => IDLE);
    const r = await planAnswer(root, 'demo', id, 'approve');
    expect(r.typed).toBe(`${id}: the plan is sent back — plan has no checkpoints.`);
    const t = (await listTasks(root)).find((x) => x.id === id);
    expect(t?.state).toBe('handed');
    expect(t?.plan_approved).toBe(false);
    const decisions = await readDecisions(root);
    expect(decisions[0].summary).toBe('sent the plan back: plan has no checkpoints');
  });
});

describe('done gate', () => {
  async function setupApproved() {
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 1, pane_started: 'x' }],
    });
    const { execFileSync } = await import('node:child_process');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: home, encoding: 'utf8' }).trim();
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    await fs.mkdir(path.join(home, 'src'), { recursive: true });
    await fs.writeFile(path.join(home, 'src', 'a.ts'), 'base\n');
    git('add', 'src/a.ts');
    git('commit', '-m', 'feat: base');
    const base = git('rev-parse', 'HEAD');
    await fs.writeFile(path.join(home, 'src', 'a.ts'), 'artifact\n');
    git('commit', '-am', 'feat: artifact');
    const artifact = git('rev-parse', 'HEAD');
    const id = await hubTask(root, 'demo', 'build it');
    const contract: import('../src/types.js').RootContract = {
      schema_version: 1, objective: 'Build it.', consumer: 'demo-orchestrator', deliverable: 'a diff', kind: 'build',
      acceptance: [{ id: 'diff', predicate_id: 'git_diff_scope', version: 1, configuration: {}, required_evidence: ['diff'] }],
      provenance: { repository: home, base_revision: base, artifact_revision: artifact },
      write_scope: ['src'], action_scope: [],
      budget: { depth: 1, active_children: 2, active_project_records: 2, attempts: 2 },
      delegation: { output_claims: ['a diff'], adapters: ['tmux'] },
    };
    await hubLog(root, id, 'plan', 'the plan', CPS, undefined, contract);
    vi.mocked(capturePane).mockImplementation(async () => IDLE);
    await planAnswer(root, 'demo', id, 'approve');
    const { admitTmux } = await import('../src/admission.js');
    const { contractDigest } = await import('../src/state.js');
    await admitTmux(root, home, id, 'builder', {
      parent_id: id, plan_digest: contractDigest(contract), output_claim: 'a diff', acceptance_ids: ['diff'],
      provenance: contract.provenance, write_scope: ['src'], adapter: 'tmux',
    });
    return { root, id };
  }

  async function completeDone(root: string, id: string) {
    const task = (await listTasks(root)).find((candidate) => candidate.id === id)!;
    const admission = task.admissions![0];
    if (admission.provenance.kind === 'research') throw new Error('code fixture required');
    const { transitionTmuxAdmission } = await import('../src/admission.js');
    await transitionTmuxAdmission(root, admission.provenance.repository, id, 'builder', admission.lease_id, 'released');
    const { evaluateTaskPredicate } = await import('../src/hub.js');
    await expect(evaluateTaskPredicate(root, id, 'git_diff_scope', {
      lease_id: admission.lease_id, base_revision: admission.provenance.base_revision,
      artifact_revision: admission.provenance.artifact_revision,
    })).resolves.toBe(true);
    await hubLog(root, id, 'done');
  }

  it('done is rejected without an approved plan', async () => {
    const { root } = await setup();
    const id = await hubTask(root, 'demo', 'build it');
    await expect(hubLog(root, id, 'done')).rejects.toThrow(/no approved plan/);
  });

  it('done is rejected until every checkpoint is terminal', async () => {
    const { root, id } = await setupApproved();
    await expect(hubLog(root, id, 'done')).rejects.toThrow(/c1 has no terminal progress/);
    await hubProgress(root, id, 'c1', 'ok');
    await expect(hubLog(root, id, 'done')).rejects.toThrow(/c2 has no terminal progress/);
    await hubProgress(root, id, 'c2', 'started');
    await expect(hubLog(root, id, 'done')).rejects.toThrow(/c2 has no terminal progress/);
    await hubProgress(root, id, 'c2', 'ok');
    await completeDone(root, id);
    expect((await listTasks(root)).find((t) => t.id === id)?.state).toBe('done');
  });

  it('a skip needs a note, then counts as terminal', async () => {
    const { root, id } = await setupApproved();
    await hubProgress(root, id, 'c1', 'ok');
    await expect(hubProgress(root, id, 'c2', 'skip')).rejects.toThrow(/needs a note/);
    await hubProgress(root, id, 'c2', 'skip', 'not needed on this repo');
    await completeDone(root, id);
    expect((await listTasks(root)).find((t) => t.id === id)?.state).toBe('done');
  });

  it('a failed checkpoint blocks done until the owner accepts it', async () => {
    const { root, id } = await setupApproved();
    await hubProgress(root, id, 'c1', 'ok');
    await hubProgress(root, id, 'c2', 'fail', 'flaky fixture');
    await expect(hubLog(root, id, 'done')).rejects.toThrow(/c2 failed and the owner has not accepted it/);
    await hubAccept(root, id, 'c2');
    await completeDone(root, id);
    expect((await listTasks(root)).find((t) => t.id === id)?.state).toBe('done');
  });

  it('an accept from before the fail does not count', async () => {
    const { root, id } = await setupApproved();
    await hubProgress(root, id, 'c1', 'ok');
    await hubProgress(root, id, 'c2', 'fail', 'first failure');
    await hubAccept(root, id, 'c2');
    await hubProgress(root, id, 'c2', 'fail', 'failed again');
    await expect(hubLog(root, id, 'done')).rejects.toThrow(/has not accepted/);
    await hubAccept(root, id, 'c2');
    await completeDone(root, id);
  });

  it('progress and accept validate the task, the checkpoint, and the status', async () => {
    const { root, id } = await setupApproved();
    await expect(hubProgress(root, id, 'nope', 'ok')).rejects.toThrow(/no checkpoint nope/);
    await expect(hubProgress(root, id, 'c1', 'maybe')).rejects.toThrow(/started\|ok\|fail\|skip/);
    await expect(hubProgress(root, 'demo-99', 'c1', 'ok')).rejects.toThrow(/unknown task/);
    await expect(hubAccept(root, id, 'c1')).rejects.toThrow(/nothing to accept/);
    await expect(hubAccept(root, id, 'nope')).rejects.toThrow(/no checkpoint nope/);
    await expect(hubAccept(root, 'demo-99', 'c1')).rejects.toThrow(/unknown task/);
  });
});

describe('feed line', () => {
  it('an owner answer on a command dialog logs the command, not the title', async () => {
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 1, pane_started: 'x' }],
    });
    vi.mocked(capturePane).mockImplementation(async () => DIALOG);
    const fp = parseDialog(lines(DIALOG)).fingerprint;
    await answerDialog(root, 'demo', undefined, '1', fp);
    const decisions = await readDecisions(root);
    expect(decisions[0].summary).toBe('answered "Approve once" for: $ echo hive-calibration');
  });
});

describe('paused automatic approvals', () => {
  it.each(['mode', 'approvals'] as const)('commits %s changes without a watchdog 409', async (action) => {
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 1, pane_started: 'x' }],
    });
    if (action === 'mode') await setProjectApprovals(root, 'demo', 'safe');
    else await setProjectMode(root, 'demo', 'auto');
    await disableExecution(root, 'demo');
    process.env.HIVE_COLLABORATION_ENABLED = '1';
    if (action === 'mode') await setProjectMode(root, 'demo', 'auto');
    else await setProjectApprovals(root, 'demo', 'safe');

    await expect(handleCurrentOrchestratorDialog(root, 'demo')).resolves.toBeUndefined();
    const project = (await readProjects(root)).projects[0];
    expect(project.collaboration_execution_disabled_at).toEqual(expect.any(String));
    if (action === 'mode') expect(project.mode).toBe('auto');
    else expect(project.approvals).toBe('safe');
  });
});

describe('orchestrator dialog pane resolution', () => {
  afterEach(() => {
    vi.mocked(paneExists).mockResolvedValue(true);
    vi.mocked(capturePane).mockResolvedValue(DIALOG);
  });

  it('Auto answers a live pending approval instead of the stale registered pane', async () => {
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{
        name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 1, pane_started: 'old',
        model: 'kimi-code/k3.1-pro-highspeed', launch_mode: 'auto', launch_scoped_auto: true,
      }],
    });
    await writePendingPane(root, 'demo', {
      pane: '%2', pane_pid: 2, pane_started: 'pending', kind: 'wake', launch_mode: 'ask', launch_scoped_auto: false, model: 'kimi-code/k3.1-pro-highspeed', at: new Date().toISOString(), typed: false, line: 'You are demo-orchestrator.',
    });
    await setProjectMode(root, 'demo', 'auto');
    vi.mocked(paneExists).mockImplementation(async (pane) => pane === '%2');
    vi.mocked(capturePane).mockImplementation(async (pane) => pane === '%2' ? DIALOG : IDLE);
    vi.mocked(sendLiteral).mockClear();

    await handleCurrentOrchestratorDialog(root, 'demo');

    expect(sendLiteral).toHaveBeenCalledTimes(1);
    expect(sendLiteral).toHaveBeenCalledWith('%2', '1', { pid: 2, started: 'pending' });
  });

  it('a dead pending pane does not hide a live registered orchestrator', async () => {
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 1, pane_started: 'current' }],
    });
    await writePendingPane(root, 'demo', {
      pane: '%2', kind: 'wake', launch_mode: 'ask', launch_scoped_auto: false, model: 'kimi-code/k3.1-pro-highspeed', at: new Date().toISOString(), typed: false, line: 'You are demo-orchestrator.',
    });
    vi.mocked(paneExists).mockImplementation(async (pane) => pane === '%1');
    vi.mocked(capturePane).mockResolvedValue(DIALOG);

    await expect(readDialogFor(root, 'demo')).resolves.toMatchObject({ pane: '%1' });
  });
});

describe('continue sending claim', () => {
  async function setupPending() {
    const { root } = await setup();
    await writePendingPane(root, 'demo', {
      pane: '%7', pane_pid: 7, pane_started: 'pending', kind: 'start', launch_mode: 'ask', launch_scoped_auto: false, model: 'kimi-code/k3.1-pro-highspeed', at: new Date().toISOString(), typed: false, line: 'You are demo-orchestrator.',
    });
    vi.mocked(capturePane).mockImplementation(async () => IDLE);
    vi.mocked(typeLine).mockClear();
    return root;
  }

  it('registers and discovers the session in the actual pending worktree', async () => {
    const { root, home } = await setup();
    const worktree = hivePath(home, 'lanes', 'demo-orchestrator');
    await fs.mkdir(worktree, { recursive: true });
    const pending = {
      pane: '%7', pane_pid: 7, pane_started: 'pending', kind: 'start', launch_mode: 'ask', launch_scoped_auto: false,
      model: 'kimi-code/k3.1-pro-highspeed', at: new Date().toISOString(), typed: false,
      line: 'You are demo-orchestrator.', worktree,
    };
    await writePendingPane(root, 'demo', pending);
    vi.mocked(capturePane).mockImplementation(async () => IDLE);
    vi.mocked(findLatestSession).mockClear();

    await expect(continueProject(root, 'demo')).resolves.toBe('%7');

    expect((await readTeam(home)).agents[0]).toMatchObject({
      name: 'demo-orchestrator', orchestrator: true, worktree,
      handoff: hivePath(worktree, 'handoffs', 'demo-orchestrator.md'),
    });
    expect(findLatestSession).toHaveBeenCalledWith(worktree, 'demo-orchestrator');
  });

  async function setupIdentifiedPending() {
    const { root, home } = await setup();
    const worktree = hivePath(home, 'lanes', 'demo-orchestrator');
    await fs.mkdir(worktree, { recursive: true });
    await writePendingPane(root, 'demo', {
      pane: '%7', pane_pid: 7, pane_started: 'pending', kind: 'start', launch_mode: 'ask', launch_scoped_auto: false,
      model: 'kimi-code/k3.1-pro-highspeed', at: new Date().toISOString(), typed: false,
      line: 'You are demo-orchestrator.', worktree,
    });
    vi.mocked(capturePane).mockClear();
    vi.mocked(paneIdentity).mockClear();
    vi.mocked(typeLine).mockClear();
    return { root, home, worktree };
  }

  it('verifies pending pane identity before capture', async () => {
    const { root, home } = await setupIdentifiedPending();
    vi.mocked(paneIdentity).mockResolvedValueOnce({ pid: 99, started: 'reused' });

    await expect(continueProject(root, 'demo')).rejects.toThrow(/identity|stale|pending/);

    expect(capturePane).not.toHaveBeenCalled();
    expect(typeLine).not.toHaveBeenCalled();
    expect((await readTeam(home)).agents.some((agent) => agent.orchestrator)).toBe(false);
  });

  it('rejects a pending pane whose identity changes before the locked registration', async () => {
    const { root, home } = await setupIdentifiedPending();
    vi.mocked(paneIdentity)
      .mockResolvedValueOnce({ pid: 7, started: 'pending' })
      .mockResolvedValueOnce({ pid: 99, started: 'reused' });

    await expect(continueProject(root, 'demo')).rejects.toThrow(/identity|stale|pending/);

    expect(paneIdentity).toHaveBeenCalledTimes(2);
    expect(typeLine).not.toHaveBeenCalled();
    expect((await readTeam(home)).agents.some((agent) => agent.orchestrator)).toBe(false);
  });

  it('fences a legacy pending record without a verified identity', async () => {
    const { root, home } = await setupIdentifiedPending();
    const current = (await readPendingPane(root, 'demo'))!;
    await writePendingPane(root, 'demo', {
      ...current, pane_pid: undefined, pane_started: undefined,
    });

    await expect(continueProject(root, 'demo')).rejects.toThrow(/identity|migration|pending/);

    expect(capturePane).not.toHaveBeenCalled();
    expect(typeLine).not.toHaveBeenCalled();
    expect((await readTeam(home)).agents.some((agent) => agent.orchestrator)).toBe(false);
  });

  it('refuses a pending worktree owned by another live agent', async () => {
    const { root, home, worktree } = await setupIdentifiedPending();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'builder', worktree, pane: '%2', pane_pid: 22, pane_started: 'live' }],
    });

    await expect(continueProject(root, 'demo')).rejects.toThrow(/shared|worktree|in use/);

    expect(typeLine).not.toHaveBeenCalled();
    expect((await readTeam(home)).agents).toHaveLength(1);
    expect((await readTeam(home)).agents[0].name).toBe('builder');
  });

  it('rejects duplicate orchestrators before pending capture or typing', async () => {
    const { root, home, worktree } = await setupIdentifiedPending();
    const agents = [1, 2].map((id) => ({
      name: 'demo-orchestrator', orchestrator: true, worktree: path.join(worktree, `legacy-${id}`),
      pane: `%${id}`, pane_pid: id, pane_started: `old-${id}`, model: 'kimi-code/k3.1-pro-highspeed',
    }));
    await writeJson(hivePath(home, 'team.json'), { agents });

    await expect(continueProject(root, 'demo')).rejects.toThrow(/duplicate|ambiguous/);

    expect(capturePane).not.toHaveBeenCalled();
    expect(typeLine).not.toHaveBeenCalled();
    expect((await readTeam(home)).agents).toEqual(agents);
  });

  it('rejects a distinct live orchestrator before pending capture or typing', async () => {
    const { root, home, worktree } = await setupIdentifiedPending();
    const orchestrator = {
      name: 'demo-orchestrator', orchestrator: true, worktree,
      pane: '%1', pane_pid: 11, pane_started: 'live', model: 'kimi-code/k3.1-pro-highspeed',
    };
    await writeJson(hivePath(home, 'team.json'), { agents: [orchestrator] });
    vi.mocked(paneIs).mockImplementation(async () => true);

    await expect(continueProject(root, 'demo')).rejects.toThrow(/live|already running|distinct/);

    expect(capturePane).not.toHaveBeenCalled();
    expect(typeLine).not.toHaveBeenCalled();
    expect((await readTeam(home)).agents).toEqual([orchestrator]);
  });

  it('rechecks a pause after the pending wait before typing', async () => {
    const root = await setupPending();
    process.env.HIVE_COLLABORATION_ENABLED = '1';
    vi.mocked(waitIdle).mockImplementationOnce(async () => {
      await disableExecution(root, 'demo');
      return 'idle';
    });
    await expect(continueProject(root, 'demo')).rejects.toThrow('rollout paused for demo');
    expect(typeLine).not.toHaveBeenCalled();
    expect(await readPendingPane(root, 'demo')).toMatchObject({ typed: false, sending: false });
  });

  it('revalidates launch provenance immediately before typing', async () => {
    const root = await setupPending();
    vi.mocked(waitIdle).mockImplementationOnce(async () => {
      const current = (await readPendingPane(root, 'demo'))!;
      await writePendingPane(root, 'demo', { ...current, launch_scoped_auto: undefined, migration_state: 'legacy_auto_blocked' });
      return 'idle';
    });

    await expect(continueProject(root, 'demo')).rejects.toThrow(/provenance|migration/);

    expect(typeLine).not.toHaveBeenCalled();
    expect((await readPendingPane(root, 'demo'))?.typed).not.toBe(true);
  });

  it('refuses a pending model that differs from the recorded orchestrator model', async () => {
    const root = await setupPending();
    const home = path.join(root, 'demo');
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'demo-orchestrator', orchestrator: true, model: 'kimi-code/k3.1-pro-highspeed' }],
    });
    const current = (await readPendingPane(root, 'demo'))!;
    await writePendingPane(root, 'demo', { ...current, model: 'kimi-code/k3.1-pro' });
    await expect(continueProject(root, 'demo')).rejects.toThrow(/provenance|migration/);
    expect(typeLine).not.toHaveBeenCalled();
  });

  it('lets only one overlapping continuation reach typeLine', async () => {
    const root = await setupPending();
    let markTyping!: () => void;
    let releaseTyping!: () => void;
    const typing = new Promise<void>((resolve) => { markTyping = resolve; });
    const release = new Promise<void>((resolve) => { releaseTyping = resolve; });
    vi.mocked(typeLine)
      .mockImplementationOnce(async () => { markTyping(); await release; })
      .mockImplementation(async () => {});
    const first = continueProject(root, 'demo');
    let second: ReturnType<typeof continueProject> | undefined;
    try {
      await typing;
      const status = await buildStatus(root);
      expect(status.projects[0].orchestrator.starting?.sending).toBe(true);
      second = continueProject(root, 'demo');
      expect(typeLine).toHaveBeenCalledTimes(1);
      releaseTyping();
      await first;
      await expect(second).rejects.toThrow(/already sent/);
    } finally {
      releaseTyping();
      await Promise.allSettled(second ? [first, second] : [first]);
    }
    expect(await readPendingPane(root, 'demo')).toMatchObject({ typed: true, sending: false });
  });

  it('refuses a recent durable sending claim', async () => {
    const root = await setupPending();
    const at = new Date().toISOString();
    await writePendingPane(root, 'demo', {
      pane: '%7', pane_pid: 7, pane_started: 'pending', kind: 'start', launch_mode: 'ask', launch_scoped_auto: false, at, typed: false, sending: true, line: 'You are demo-orchestrator.',
    });

    await expect(continueProject(root, 'demo')).rejects.toThrow(/already sending/);

    expect(typeLine).not.toHaveBeenCalled();
    expect(await readPendingPane(root, 'demo')).toMatchObject({ at, typed: false, sending: true });
  });

  it('reclaims an orphaned sending claim and refreshes its activity timestamp', async () => {
    const root = await setupPending();
    const staleAt = new Date(Date.now() - 11 * 60_000).toISOString();
    await writePendingPane(root, 'demo', {
      pane: '%7', pane_pid: 7, pane_started: 'pending', kind: 'start', launch_mode: 'ask', launch_scoped_auto: false, model: 'kimi-code/k3.1-pro-highspeed', at: staleAt, typed: false, sending: true, line: 'You are demo-orchestrator.',
    });

    await expect(continueProject(root, 'demo')).resolves.toBe('%7');

    expect(typeLine).toHaveBeenCalledTimes(1);
    const claimed = await readPendingPane(root, 'demo');
    expect(claimed).toMatchObject({ typed: true, sending: false });
    expect(Date.parse(claimed!.at)).toBeGreaterThan(Date.parse(staleAt));
  });

  it('releases a failed claim without overwriting changed pending state', async () => {
    const root = await setupPending();
    vi.mocked(typeLine)
      .mockImplementationOnce(async () => {
        const current = await readPendingPane(root, 'demo');
        await writePendingPane(root, 'demo', { ...current!, question: true });
        throw new Error('type failed');
      })
      .mockImplementation(async () => {});

    await expect(continueProject(root, 'demo')).rejects.toThrow('type failed');

    expect(await readPendingPane(root, 'demo')).toMatchObject({
      typed: false, sending: false, question: true, line: 'You are demo-orchestrator.',
    });
    await expect(continueProject(root, 'demo')).resolves.toBe('%7');
    expect(typeLine).toHaveBeenCalledTimes(2);
    expect(await readPendingPane(root, 'demo')).toMatchObject({ typed: true, sending: false });
  });
});

describe('original launch sending claim', () => {
  async function setupStart() {
    const { root } = await setup();
    await hubTask(root, 'demo', 'do it');
    vi.mocked(capturePane).mockImplementation(async () => IDLE);
    vi.mocked(typeLine).mockClear();
    return { root };
  }

  it('rechecks a pause after the original launch wait before typing', async () => {
    const { root } = await setupStart();
    const home = path.join(root, 'demo');
    const credentialFile = hivePath(home, 'team', 'demo-orchestrator', 'credential.env');
    await fs.mkdir(path.dirname(credentialFile), { recursive: true });
    await fs.writeFile(credentialFile, "HIVE_AGENT_CREDENTIAL='hva1.demo-orchestrator.fedcba9876543210.test-secret-with-high-entropy'\n", { mode: 0o600 });
    process.env.HIVE_COLLABORATION_ENABLED = '1';
    vi.mocked(waitIdle).mockImplementationOnce(async () => {
      await disableExecution(root, 'demo');
      return 'idle';
    });
    await expect(startProject(root, 'demo', 'demo-1')).rejects.toThrow('rollout paused for demo');
    expect(typeLine).not.toHaveBeenCalled();
  });

  it('lets only the original launcher reach typeLine when Continue overlaps', async () => {
    const { root } = await setupStart();
    let markWaiting!: () => void;
    let releaseWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => { markWaiting = resolve; });
    const release = new Promise<void>((resolve) => { releaseWaiting = resolve; });
    vi.mocked(waitIdle)
      .mockImplementationOnce(async () => { markWaiting(); await release; return 'idle' as const; })
      .mockImplementation(async () => 'idle' as const);
    const original = startProject(root, 'demo', 'demo-1');
    try {
      await waiting;
      await expect(continueProject(root, 'demo')).rejects.toThrow(/already sending/);
      expect(typeLine).not.toHaveBeenCalled();
    } finally {
      releaseWaiting();
      await original;
    }
    expect(typeLine).toHaveBeenCalledTimes(1);
    expect(await readPendingPane(root, 'demo')).toMatchObject({ typed: true, sending: false });
  });

  it('fences a stale original owner after a replacement claim', async () => {
    const { root } = await setupStart();
    let markOriginalWaiting!: () => void;
    let releaseOriginalWaiting!: () => void;
    let markReplacementWaiting!: () => void;
    let releaseReplacementWaiting!: () => void;
    const originalWaiting = new Promise<void>((resolve) => { markOriginalWaiting = resolve; });
    const originalRelease = new Promise<void>((resolve) => { releaseOriginalWaiting = resolve; });
    const replacementWaiting = new Promise<void>((resolve) => { markReplacementWaiting = resolve; });
    const replacementRelease = new Promise<void>((resolve) => { releaseReplacementWaiting = resolve; });
    vi.mocked(waitIdle)
      .mockImplementationOnce(async () => { markOriginalWaiting(); await originalRelease; return 'idle' as const; })
      .mockImplementationOnce(async () => { markReplacementWaiting(); await replacementRelease; return 'idle' as const; })
      .mockImplementation(async () => 'idle' as const);
    vi.mocked(typeLine).mockImplementation(async () => {});
    const original = startProject(root, 'demo', 'demo-1');
    let replacement: ReturnType<typeof continueProject> | undefined;
    try {
      await originalWaiting;
      const originalClaim = (await readPendingPane(root, 'demo'))!;
      await writePendingPane(root, 'demo', {
        ...originalClaim, at: new Date(Date.now() - 11 * 60_000).toISOString(),
      });
      replacement = continueProject(root, 'demo');
      await replacementWaiting;

      releaseOriginalWaiting();
      await expect(original).rejects.toThrow(/no longer active/);

      expect(typeLine).not.toHaveBeenCalled();
      const replacementClaim = await readPendingPane(root, 'demo');
      expect(replacementClaim).toMatchObject({ typed: false, sending: true });
      expect(replacementClaim?.claim_token).toBeTruthy();
      expect(replacementClaim?.claim_token).not.toBe(originalClaim.claim_token);
      await expect(continueProject(root, 'demo')).rejects.toThrow(/already sending/);
      expect(typeLine).not.toHaveBeenCalled();

      releaseReplacementWaiting();
      await expect(replacement).resolves.toBe('%9');
      expect(typeLine).toHaveBeenCalledTimes(1);
    } finally {
      releaseOriginalWaiting();
      releaseReplacementWaiting();
      await Promise.allSettled(replacement ? [original, replacement] : [original]);
    }
    expect(await readPendingPane(root, 'demo')).toMatchObject({ typed: true, sending: false });
  });

  it('releases the claim on a dialog return so Continue can resume', async () => {
    const { root } = await setupStart();
    vi.mocked(waitIdle)
      .mockResolvedValueOnce('dialog')
      .mockImplementation(async () => 'idle' as const);

    await expect(startProject(root, 'demo', 'demo-1')).resolves.toBe('%9');

    expect(typeLine).not.toHaveBeenCalled();
    expect(await readPendingPane(root, 'demo')).toMatchObject({ typed: false, sending: false, question: true });
    await expect(continueProject(root, 'demo')).resolves.toBe('%9');
    expect(typeLine).toHaveBeenCalledTimes(1);
  });

  it('releases a failed original claim without overwriting fresh pending fields', async () => {
    const { root } = await setupStart();
    vi.mocked(waitIdle).mockImplementation(async () => 'idle' as const);
    vi.mocked(typeLine)
      .mockImplementationOnce(async () => {
        const current = await readPendingPane(root, 'demo');
        await writePendingPane(root, 'demo', { ...current!, question: true });
        throw new Error('original type failed');
      })
      .mockImplementation(async () => {});

    await expect(startProject(root, 'demo', 'demo-1')).rejects.toThrow('original type failed');

    expect(await readPendingPane(root, 'demo')).toMatchObject({ typed: false, sending: false, question: true });
    await expect(continueProject(root, 'demo')).resolves.toBe('%9');
    expect(typeLine).toHaveBeenCalledTimes(2);
  });
});

describe('wake racing a cascade kill', () => {
  it('a cascade landing mid-wake stops the final upsert and the fresh pane dies', async () => {
    vi.mocked(killWindow).mockClear();
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'demo-orchestrator', orchestrator: true, session_id: 'session_abc', model: 'kimi-code/k3.1-pro-highspeed' }],
    });
    vi.mocked(waitIdle).mockImplementationOnce(async () => {
      await killAgent(root, 'demo');
      return 'idle';
    });
    await expect(wake(root, 'demo')).rejects.toThrow(/killed while its new pane came up/);
    expect(vi.mocked(killWindow).mock.calls.map((c) => c[0])).toEqual(['%9']);
    expect((await readTeam(home)).agents).toEqual([]);
    const decisions = await readDecisions(root);
    expect(decisions.some((d) => d.summary === 'killed demo-orchestrator')).toBe(true);
  });

  it('a cascade landing mid-continue stops the upsert and the pending pane dies', async () => {
    vi.mocked(killWindow).mockClear();
    vi.mocked(capturePane).mockImplementation(async () => IDLE);
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'demo-orchestrator', orchestrator: true, session_id: 'session_abc', model: 'kimi-code/k3.1-pro-highspeed' }],
    });
    await writePendingPane(root, 'demo', {
      pane: '%7', pane_pid: 7, pane_started: 'pending', kind: 'wake', launch_mode: 'ask', launch_scoped_auto: false, model: 'kimi-code/k3.1-pro-highspeed', at: new Date().toISOString(), typed: false, line: 'You are demo-orchestrator.',
    });
    vi.mocked(waitIdle).mockImplementationOnce(async () => {
      await killAgent(root, 'demo');
      return 'idle';
    });
    await expect(continueProject(root, 'demo')).rejects.toThrow(/killed while its new pane came up/);
    expect(vi.mocked(killWindow).mock.calls.map((c) => c[0])).toEqual(['%7']);
    expect((await readTeam(home)).agents).toEqual([]);
  });
});

describe('orchestrator registration failure', () => {
  it('kills only the new pane with its verified identity', async () => {
    const { root, home } = await setup();
    const old = {
      name: 'demo-orchestrator', orchestrator: true, worktree: hivePath(home, 'lanes', 'demo-orchestrator'),
      pane: '%1', pane_pid: 11, pane_started: 'old', session_id: 'session_abc',
      model: 'kimi-code/k3.1-pro-highspeed',
    };
    await fs.mkdir(old.worktree, { recursive: true });
    await writeJson(hivePath(home, 'team.json'), { agents: [old] });
    vi.mocked(paneIs).mockResolvedValueOnce(false);
    const defaultTypeLine = vi.mocked(typeLine).getMockImplementation()!;
    vi.mocked(typeLine).mockImplementationOnce(async () => {
      await writeJson(hivePath(home, 'team.json'), {
        agents: [{ ...old, session_id: 'session_replacement' }],
      });
    });
    vi.mocked(killWindow).mockClear();
    try {
      await expect(wake(root, 'demo')).rejects.toThrow(/changed while its launch was being recorded/);
    } finally {
      vi.mocked(typeLine).mockImplementation(defaultTypeLine);
    }

    expect(vi.mocked(killWindow).mock.calls).toEqual([['%9', { pid: 1, started: 'x' }]]);
    expect((await readTeam(home)).agents).toEqual([{ ...old, session_id: 'session_replacement' }]);
  });
});

describe('stale orchestrator identity recovery', () => {
  it('refuses another wake when a verified live replacement is already recorded', async () => {
    const { root, home } = await setup();
    const worktree = hivePath(home, 'lanes', 'demo-orchestrator');
    await fs.mkdir(worktree, { recursive: true });
    const old = {
      name: 'demo-orchestrator', orchestrator: true, worktree,
      pane: '%1', pane_pid: 11, pane_started: 'old', session_id: 'session_abc',
      model: 'kimi-code/k3.1-pro-highspeed',
    };
    await writeJson(hivePath(home, 'team.json'), { agents: [old] });
    await fs.writeFile(hivePath(home, 'manifest.jsonl'), `${[
      { kind: 'tmux', at: '2026-11-23T00:00:00Z', pane: '%1', window: 'demo:demo-orchestrator', pane_pid: 11, pane_started: 'old' },
      { kind: 'tmux', at: '2026-11-23T00:01:00Z', pane: '%2', window: 'demo:demo-orchestrator', pane_pid: 22, pane_started: 'replacement' },
    ].map((record) => JSON.stringify(record)).join('\n')}\n`);
    const defaultPaneIs = vi.mocked(paneIs).getMockImplementation()!;
    vi.mocked(paneIs).mockImplementation(async (pane) => pane === '%2');
    const windowsBefore = vi.mocked(newWindow).mock.calls.length;
    const killsBefore = vi.mocked(killWindow).mock.calls.length;
    try {
      await expect(wake(root, 'demo')).rejects.toThrow(/live replacement|already running|duplicate/);

      expect(paneIs).toHaveBeenCalledWith('%2', { pid: 22, started: 'replacement' });
      expect(vi.mocked(newWindow).mock.calls).toHaveLength(windowsBefore);
      expect(vi.mocked(killWindow).mock.calls).toHaveLength(killsBefore);
      expect((await readTeam(home)).agents).toEqual([old]);
    } finally {
      vi.mocked(paneIs).mockImplementation(defaultPaneIs);
    }
  });
  it('checks every identity when a replacement reuses a pane id', async () => {
    const { root, home } = await setup();
    const worktree = hivePath(home, 'lanes', 'demo-orchestrator');
    await fs.mkdir(worktree, { recursive: true });
    const old = {
      name: 'demo-orchestrator', orchestrator: true, worktree,
      pane: '%1', pane_pid: 11, pane_started: 'old', session_id: 'session_abc',
      model: 'kimi-code/k3.1-pro-highspeed',
    };
    await writeJson(hivePath(home, 'team.json'), { agents: [old] });
    await fs.writeFile(hivePath(home, 'manifest.jsonl'), `${[
      { kind: 'tmux', at: '2026-11-23T00:00:00Z', pane: '%1', window: 'demo:demo-orchestrator', pane_pid: 11, pane_started: 'old' },
      { kind: 'tmux', at: '2026-11-23T00:01:00Z', pane: '%2', window: 'demo:demo-orchestrator', pane_pid: 22, pane_started: 'stale' },
      { kind: 'tmux', at: '2026-11-23T00:02:00Z', pane: '%2', window: 'demo:demo-orchestrator', pane_pid: 23, pane_started: 'live' },
    ].map((record) => JSON.stringify(record)).join('\n')}\n`);
    const defaultPaneIs = vi.mocked(paneIs).getMockImplementation()!;
    vi.mocked(paneIs).mockImplementation(async (pane, identity) => pane === '%2' && identity?.started === 'live');
    const windowsBefore = vi.mocked(newWindow).mock.calls.length;
    try {
      await expect(wake(root, 'demo')).rejects.toThrow(/live replacement|duplicate/);

      expect(paneIs).toHaveBeenCalledWith('%2', { pid: 23, started: 'live' });
      expect(vi.mocked(newWindow).mock.calls).toHaveLength(windowsBefore);
      expect((await readTeam(home)).agents).toEqual([old]);
    } finally {
      vi.mocked(paneIs).mockImplementation(defaultPaneIs);
    }
  });
});

describe('start after a cleanup stamp', () => {
  it('start on a stamped project succeeds and clears the stamp', async () => {
    const { root, home } = await setup();
    await hubTask(root, 'demo', 'do it');
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'demo-orchestrator', orchestrator: true, session_id: 'session_abc', model: 'kimi-code/k3.1-pro-highspeed', closed_at: new Date().toISOString() }],
    });
    const pane = await startProject(root, 'demo', 'demo-1');
    expect(pane).toBe('%9');
    const team = await readTeam(home);
    expect(team.agents[0]).toMatchObject({ name: 'demo-orchestrator', pane: '%9' });
    expect(team.agents[0].closed_at).toBeUndefined();
  });
});

describe('orchestrator workspace isolation', () => {
  it.each(['git', 'empty-git', 'jj'] as const)('allocates an isolated lane for a fresh %s start', async (kind) => {
    const { root, home } = await setup();
    const task = await hubTask(root, 'demo', 'start the orchestrator');
    const worktree = hivePath(home, 'lanes', 'demo-orchestrator');
    const defaultRun = vi.mocked(run).getMockImplementation()!;
    vi.mocked(run).mockImplementation(async (cmd, args) => {
      if (kind === 'jj') return { code: 0, stdout: '', stderr: '' };
      if (cmd === 'jj') return { code: 1, stdout: '', stderr: 'no jj here' };
      if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--verify') {
        return kind === 'empty-git'
          ? { code: 1, stdout: '', stderr: 'unknown revision' }
          : { code: 0, stdout: 'base\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    try {
      await expect(startProject(root, 'demo', task)).resolves.toBe('%9');

      expect(vi.mocked(newWindow).mock.calls.at(-1)?.[1]).toBe(worktree);
      expect((await readTeam(home)).agents[0]).toMatchObject({
        name: 'demo-orchestrator', orchestrator: true, worktree,
      });
      const add = vi.mocked(run).mock.calls.find((call) => call[2] === home && (kind === 'jj'
        ? call[0] === 'jj' && call[1].includes('add')
        : call[0] === 'git' && call[1][0] === 'worktree' && call[1][1] === 'add'));
      expect(add?.[1]).toEqual(kind === 'jj'
        ? ['-R', home, 'workspace', 'add', worktree, '-r', 'main@origin']
        : kind === 'empty-git'
          ? ['worktree', 'add', '-q', '--orphan', '-b', 'demo/demo-orchestrator', worktree]
          : ['worktree', 'add', '-q', '-b', 'demo/demo-orchestrator', worktree, 'HEAD']);
    } finally {
      vi.mocked(run).mockImplementation(defaultRun);
    }
  }, 20_000);

  it('reuses the recorded isolated worktree on wake', async () => {
    const { root, home } = await setup();
    const worktree = hivePath(home, 'lanes', 'demo-orchestrator');
    await fs.mkdir(worktree, { recursive: true });
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{
        name: 'demo-orchestrator', orchestrator: true, worktree,
        pane: '%1', pane_pid: 11, pane_started: 'old', session_id: 'session_abc',
        model: 'kimi-code/k3.1-pro-highspeed',
      }],
    });
    vi.mocked(paneIs).mockResolvedValueOnce(false);

    await expect(wake(root, 'demo')).resolves.toBe('%9');

    expect(vi.mocked(newWindow).mock.calls.at(-1)?.[1]).toBe(worktree);
    expect((await readTeam(home)).agents[0].worktree).toBe(worktree);
  }, 20_000);

  it('keeps a live legacy external worktree unchanged', async () => {
    const { root, home } = await setup();
    const worktree = path.join(root, 'legacy-orchestrator');
    await fs.mkdir(worktree, { recursive: true });
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{
        name: 'demo-orchestrator', orchestrator: true, worktree,
        pane: '%1', pane_pid: 11, pane_started: 'live', session_id: 'session_abc',
        model: 'kimi-code/k3.1-pro-highspeed',
      }],
    });
    const windowsBefore = vi.mocked(newWindow).mock.calls.length;

    await expect(wake(root, 'demo')).rejects.toThrow(/already running/);

    expect(vi.mocked(newWindow).mock.calls).toHaveLength(windowsBefore);
    expect((await readTeam(home)).agents[0].worktree).toBe(worktree);
    expect(await fs.stat(hivePath(home, 'lanes', 'demo-orchestrator')).catch(() => null)).toBeNull();
  });
});

describe('orchestrator launch registration locking', () => {
  it('delete waits for a preflight launch and refuses its pending record', async () => {
    const { root } = await setup();
    await hubTask(root, 'demo', 'do it');
    let markPreflight!: () => void;
    let releasePreflight!: () => void;
    const entered = new Promise<void>((resolve) => { markPreflight = resolve; });
    const release = new Promise<void>((resolve) => { releasePreflight = resolve; });
    vi.mocked(preflight).mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {
      markPreflight();
      await release;
    });
    const starting = startProject(root, 'demo', 'demo-1');
    let deleting!: ReturnType<typeof removeProject>;
    try {
      await entered;
      deleting = removeProject(root, 'demo');
      let deleteSettled = false;
      void deleting.then(() => { deleteSettled = true; }, () => { deleteSettled = true; });
      await new Promise((resolve) => setImmediate(resolve));
      expect(deleteSettled).toBe(false);
      releasePreflight();
      await starting;
      await expect(deleting).rejects.toThrow(/launch is pending|team is not empty/);
      expect((await readProjects(root)).projects.map((p) => p.name)).toEqual(['demo']);
    } finally {
      releasePreflight();
      await Promise.allSettled([starting, deleting]);
    }
  });

  it('does not register an orchestrator after the project leaves the registry', async () => {
    const { root, home } = await setup();
    await hubTask(root, 'demo', 'do it');
    let markIdle!: () => void;
    let releaseIdle!: () => void;
    const entered = new Promise<void>((resolve) => { markIdle = resolve; });
    const release = new Promise<void>((resolve) => { releaseIdle = resolve; });
    vi.mocked(waitIdle).mockImplementationOnce(async () => {
      markIdle();
      await release;
      return 'idle';
    });
    const starting = startProject(root, 'demo', 'demo-1');
    try {
      await entered;
      await writeProjects(root, { projects: [] });
      releaseIdle();
      await expect(starting).rejects.toThrow(/unknown project/);
      expect((await readTeam(home)).agents.some((a) => a.orchestrator)).toBe(false);
    } finally {
      releaseIdle();
      await starting.catch(() => {});
    }
  });
});

describe('wake after a cascade kill', () => {
  it('refuses when the orchestrator entry is gone', async () => {
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), { agents: [] });
    const windows = vi.mocked(newWindow).mock.calls.length;
    await expect(wake(root, 'demo')).rejects.toThrow(/not in team.json/);
    expect(vi.mocked(newWindow).mock.calls).toHaveLength(windows);
  });

  it('refuses when the orchestrator is stamped closed', async () => {
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{
        name: 'demo-orchestrator', orchestrator: true, session_id: 'session_abc', model: 'kimi-code/k3.1-pro-highspeed',
        closed_at: new Date().toISOString(),
      }],
    });
    const windows = vi.mocked(newWindow).mock.calls.length;
    await expect(wake(root, 'demo')).rejects.toThrow(/closed on purpose/);
    expect(vi.mocked(newWindow).mock.calls).toHaveLength(windows);
  });
});

describe('ambiguous legacy orchestrators', () => {
  it('refuses duplicate orchestrators without manifest records before launch', async () => {
    const { root, home } = await setup();
    const agents = [1, 2].map((id) => ({
      name: 'demo-orchestrator', orchestrator: true, worktree: path.join(root, `legacy-${id}`),
      pane: `%${id}`, pane_pid: id * 11, pane_started: `old-${id}`, session_id: `session_${id}`,
      model: 'kimi-code/k3.1-pro-highspeed',
    }));
    await writeJson(hivePath(home, 'team.json'), { agents });
    vi.mocked(paneIs).mockResolvedValue(false);
    const windowsBefore = vi.mocked(newWindow).mock.calls.length;
    const killsBefore = vi.mocked(killWindow).mock.calls.length;
    try {
      await expect(wake(root, 'demo')).rejects.toThrow(/duplicate|ambiguous/);

      expect(vi.mocked(newWindow).mock.calls).toHaveLength(windowsBefore);
      expect(vi.mocked(killWindow).mock.calls).toHaveLength(killsBefore);
      expect((await readTeam(home)).agents).toEqual(agents);
    } finally {
      vi.mocked(paneIs).mockImplementation(async () => true);
    }
  });
});

describe('wake pending pane', () => {
  const LINE = 'You are demo-orchestrator, the orchestrator of project demo.';

  it('a stale pending record is cleared and the wake proceeds', async () => {
    const { root } = await setup();
    await writePendingPane(root, 'demo', {
      pane: '%7', pane_pid: 7, pane_started: 'pending', kind: 'wake', launch_mode: 'ask', launch_scoped_auto: false, model: 'kimi-code/k3.1-pro-highspeed', at: new Date(Date.now() - 11 * 60_000).toISOString(), line: LINE,
    });
    await expect(wake(root, 'demo')).rejects.toThrow(/not in team.json/);
    expect(await readPendingPane(root, 'demo')).toBeNull();
  });

  it('a pending record whose pane died is cleared and the wake proceeds', async () => {
    const { root } = await setup();
    await writePendingPane(root, 'demo', { pane: '%7', pane_pid: 7, pane_started: 'pending', kind: 'wake', launch_mode: 'ask', launch_scoped_auto: false, model: 'kimi-code/k3.1-pro-highspeed', at: new Date().toISOString(), line: LINE });
    vi.mocked(paneExists).mockImplementation(async (p) => p !== '%7');
    await expect(wake(root, 'demo')).rejects.toThrow(/not in team.json/);
    expect(await readPendingPane(root, 'demo')).toBeNull();
    vi.mocked(paneExists).mockImplementation(async () => true);
  });

  it.each(['start', 'wake'] as const)('fences a reused pending identity during the %s decision', async (kind) => {
    const { root, home } = await setup();
    const worktree = hivePath(home, 'lanes', 'demo-orchestrator');
    await fs.mkdir(worktree, { recursive: true });
    if (kind === 'wake') {
      await writeJson(hivePath(home, 'team.json'), {
        agents: [{
          name: 'demo-orchestrator', orchestrator: true, worktree, session_id: 'session_abc',
          model: 'kimi-code/k3.1-pro-highspeed',
        }],
      });
    }
    const task = kind === 'start' ? await hubTask(root, 'demo', 'start the orchestrator') : undefined;
    await writePendingPane(root, 'demo', {
      pane: '%7', pane_pid: 7, pane_started: 'pending', kind, launch_mode: 'ask', launch_scoped_auto: false,
      model: 'kimi-code/k3.1-pro-highspeed', at: new Date().toISOString(), typed: false, line: LINE, worktree,
    });
    const original = await readPendingPane(root, 'demo');
    vi.mocked(paneIdentity).mockResolvedValueOnce({ pid: 99, started: 'reused' });
    vi.mocked(capturePane).mockClear();
    vi.mocked(typeLine).mockClear();
    const windowsBefore = vi.mocked(newWindow).mock.calls.length;

    const operation = kind === 'start' ? startProject(root, 'demo', task!) : wake(root, 'demo');
    await expect(operation).rejects.toThrow(/identity|stale|pending/);

    expect(await readPendingPane(root, 'demo')).toEqual(original);
    expect(capturePane).not.toHaveBeenCalled();
    expect(typeLine).not.toHaveBeenCalled();
    expect(vi.mocked(newWindow).mock.calls).toHaveLength(windowsBefore);
  });

  it('a live young pending pane routes through continue instead of refusing', async () => {
    const { root, home } = await setup();
    await fs.mkdir(hivePath(home), { recursive: true });
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'demo-orchestrator', orchestrator: true, session_id: 'session_abc', model: 'kimi-code/k3.1-pro-highspeed' }],
    });
    await writePendingPane(root, 'demo', { pane: '%7', pane_pid: 7, pane_started: 'pending', kind: 'wake', launch_mode: 'ask', launch_scoped_auto: false, model: 'kimi-code/k3.1-pro-highspeed', at: new Date().toISOString(), line: LINE });
    vi.mocked(capturePane).mockImplementation(async () => IDLE);
    const pane = await wake(root, 'demo');
    expect(pane).toBe('%7');
    const team = await readTeam(home);
    expect(team.agents[0]).toMatchObject({ name: 'demo-orchestrator', orchestrator: true, pane: '%7' });
    expect((await readPendingPane(root, 'demo'))?.typed).toBe(true);
  });
});

describe('orchestrator launch mode', () => {
  async function setupOrchestrator() {
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'demo-orchestrator', orchestrator: true, session_id: 'session_abc', model: 'kimi-code/k3.1-pro-highspeed' }],
    });
    return { root, home };
  }

  it('wakes a managed auto orchestrator without -y', async () => {
    const { root } = await setupOrchestrator();
    await setProjectMode(root, 'demo', 'auto');
    await setProjectApprovals(root, 'demo', 'manual');
    const pane = await wake(root, 'demo');
    expect(pane).toBe('%9');
    expect(vi.mocked(newWindow).mock.calls.at(-1)?.[2])
      .toBe(`HIVE_AGENT=demo-orchestrator HIVE_PROJECT=demo HIVE_HUB_ROOT='${root}' KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run -- --session session_abc -m 'kimi-code/k3.1-pro-highspeed'`);
  });

  it('wakes in ask when approvals is manual, so the human answers', async () => {
    const { root } = await setupOrchestrator();
    await setProjectMode(root, 'demo', 'ask');
    await setProjectApprovals(root, 'demo', 'manual');
    await wake(root, 'demo');
    expect(vi.mocked(newWindow).mock.calls.at(-1)?.[2])
      .toBe(`HIVE_AGENT=demo-orchestrator HIVE_PROJECT=demo HIVE_HUB_ROOT='${root}' KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run -- --session session_abc -m 'kimi-code/k3.1-pro-highspeed'`);
  });
});

describe('atomic task transitions', () => {
  it.each(['cancel', 'rebrief'] as const)('a plan answer cannot overwrite a concurrent %s', async (action) => {
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 1, pane_started: 'x' }],
    });
    const id = await hubTask(root, 'demo', 'build it');
    await hubLog(root, id, 'plan', 'the plan', CPS);
    vi.mocked(capturePane).mockImplementation(async () => IDLE);
    let markTyping!: () => void;
    let releaseTyping!: () => void;
    const typing = new Promise<void>((resolve) => { markTyping = resolve; });
    const release = new Promise<void>((resolve) => { releaseTyping = resolve; });
    vi.mocked(typeLine).mockImplementationOnce(async () => { markTyping(); await release; });
    const answering = planAnswer(root, 'demo', id, 'approve');
    try {
      await typing;
      const { handleTaskAction } = await import('../web/taskactions.js');
      const resolving = handleTaskAction(root, 'demo', '/api/task-resolve', {
        task: id, action, ...(action === 'rebrief' ? { note: 'new brief' } : {}),
      });
      releaseTyping();
      await Promise.all([answering, resolving]);
      const task = (await listTasks(root)).find((candidate) => candidate.id === id);
      expect(task?.state).toBe(action === 'cancel' ? 'cancelled' : 'asked');
      const { readTaskEvents } = await import('../src/state.js');
      expect((await readTaskEvents(root)).slice(-2).map((event) => event.event)).toEqual([
        'answered', action === 'cancel' ? 'cancelled' : 'asked',
      ]);
    } finally {
      releaseTyping();
      await answering.catch(() => {});
    }
  });

  it('rejects an old answer after rebrief and an identical replan', async () => {
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 1, pane_started: 'x' }],
    });
    const id = await hubTask(root, 'demo', 'build it');
    await hubLog(root, id, 'plan', 'the plan', CPS);
    vi.mocked(capturePane).mockImplementation(async () => IDLE);
    vi.mocked(typeLine).mockClear();
    const { paneIdentity } = await import('../src/tmux.js');
    const { handleTaskAction } = await import('../web/taskactions.js');
    const { readTaskEvents } = await import('../src/state.js');
    let before: unknown;
    vi.mocked(paneIdentity).mockImplementationOnce(async () => {
      await handleTaskAction(root, 'demo', '/api/task-resolve', { task: id, action: 'rebrief', note: 'same brief' });
      await hubLog(root, id, 'plan', 'the plan', CPS);
      before = await readTaskEvents(root);
      return { pid: 1, started: 'x' };
    });

    await expect(planAnswer(root, 'demo', id, 'approve')).rejects.toThrow(/lease epoch|plan changed/);
    expect(await readTaskEvents(root)).toEqual(before);
    expect(typeLine).not.toHaveBeenCalled();
  });
});

describe('plan verdict validation', () => {
  it.each([
    [[{ id: 'a', desc: 'one', etaMin: 1 }, { id: 'a', desc: 'two', etaMin: 1 }]],
    [[{ id: 'a', desc: ' ', etaMin: 1 }]],
    [[{ id: 'a', desc: 'one', etaMin: Number.POSITIVE_INFINITY }]],
    [[{ id: 'a', desc: 'one', etaMin: Number.NaN }]],
  ])('sends an invalid plan back instead of approving it', async (checkpoints) => {
    const { planVerdict } = await import('../src/taskgate.js');
    const verdict = planVerdict({ id: 'demo-1', checkpoints } as never, 'approve', '');
    expect(verdict.event).toBe('handed');
  });
});

describe('task receipts', () => {
  async function receiptSetup(outcome: 'passed' | 'failed' | 'pending' | 'skipped' | 'adapter-error' = 'passed') {
    const { root } = await setup();
    const id = await hubTask(root, 'demo', 'build it');
    await hubLog(root, id, 'plan', 'the plan', CPS);
    const task = (await listTasks(root)).find((candidate) => candidate.id === id)!;
    const { recordTaskEvidence } = await import('../src/taskgate.js');
    const evidence = await recordTaskEvidence(root, id, {
      actor: 'agent:builder', plan_digest: task.plan_digest!, epoch: task.lease_epoch!, outcome,
      artifact: { diff: 'src/a.ts' }, content: { check: 'unit', status: outcome },
    });
    return { root, id, task, evidence };
  }

  function receipt(
    task: Record<string, unknown>,
    evidence: { artifact_digest: string; evidence_hash: string },
    overrides: Record<string, unknown> = {},
  ) {
    return {
      actor: 'agent:builder', plan_digest: task.plan_digest, epoch: task.lease_epoch,
      sequence: 1, artifact_digest: evidence.artifact_digest, counters: { files: 1 },
      external_ids: { pr: '12' }, evidence_hashes: [evidence.evidence_hash], state: 'reconciling', ...overrides,
    };
  }

  function config(task: Record<string, unknown>, evidence: { artifact_digest: string; evidence_hash: string }) {
    return {
      plan_digest: task.plan_digest, artifact_digest: evidence.artifact_digest,
      evidence_hashes: [evidence.evidence_hash],
    };
  }

  it('tracks the latest reconciling candidate without trusting inline evidence', async () => {
    const { root, id, task, evidence } = await receiptSetup();
    const { evaluateTaskPredicate, recordTaskReceipt, TASK_PREDICATES } = await import('../src/hub.js');
    const { readTaskEvents } = await import('../src/state.js');
    await recordTaskReceipt(root, id, receipt(task as never, evidence) as never);
    expect((await listTasks(root))[0]).toMatchObject({
      state: 'reconciling', receipt_actor: 'agent:builder', last_receipt_sequence: 1,
    });
    expect((await readTaskEvents(root)).find((event) => event.event === 'evidence')).toMatchObject({
      evidence: { content: { check: 'unit', status: 'passed' }, evidence_hash: evidence.evidence_hash },
    });
    await expect(evaluateTaskPredicate(root, id, 'task_receipt', config(task as never, evidence) as never))
      .resolves.toBe(false);
    const events = await readTaskEvents(root);
    const tampered = events.map((event) => event.event === 'evidence'
      ? { ...event, evidence: { ...event.evidence!, content: { check: 'unit', status: 'failed' } } }
      : event);
    expect(TASK_PREDICATES.task_receipt(tampered, id, config(task as never, evidence) as never)).toBe(false);
    expect(TASK_PREDICATES.task_receipt([
      ...events, { ...events.at(-1)!, event: 'superseded' } as never,
    ], id, config(task as never, evidence) as never)).toBe(false);
    const passes = () => evaluateTaskPredicate(root, id, 'task_receipt', config(task as never, evidence) as never);
    await recordTaskReceipt(root, id, receipt(task as never, evidence, { sequence: 2, state: 'running' }) as never);
    await expect(passes()).resolves.toBe(false);
    await recordTaskReceipt(root, id, receipt(task as never, evidence, { sequence: 3, state: 'reconciling' }) as never);
    await expect(passes()).resolves.toBe(false);
    await recordTaskReceipt(root, id, receipt(task as never, evidence, {
      sequence: 4, state: 'blocked', blocker_kind: 'evidence', unblock_condition: 'fresh evidence',
      resume_condition: { type: 'predicate', acceptance_id: 'missing' },
    }) as never);
    await expect(passes()).resolves.toBe(false);
    await expect(recordTaskReceipt(root, id, receipt(task as never, evidence, {
      sequence: 5, state: 'reconciling',
    }) as never)).rejects.toThrow(/resume condition/);
    await recordTaskReceipt(root, id, receipt(task as never, evidence, { sequence: 5, state: 'failed' }) as never);
    await expect(passes()).resolves.toBe(false);
  });

  it.each(['failed', 'pending', 'skipped', 'adapter-error'] as const)(
    'rejects %s evidence with valid server hashes', async (outcome) => {
      const { root, id, task, evidence } = await receiptSetup(outcome);
      const { evaluateTaskPredicate, recordTaskReceipt } = await import('../src/hub.js');
      const { readTaskEvents } = await import('../src/state.js');
      const before = await readTaskEvents(root);
      expect(before.at(-1)).toMatchObject({ event: 'evidence', evidence: { outcome, evidence_hash: evidence.evidence_hash } });
      await expect(recordTaskReceipt(root, id, receipt(task as never, evidence) as never))
        .rejects.toThrow(/evidence/);
      expect(await readTaskEvents(root)).toEqual(before);
      await expect(evaluateTaskPredicate(root, id, 'task_receipt', config(task as never, evidence) as never))
        .resolves.toBe(false);
    },
  );

  it.each([
    { sequence: 2, actor: 'agent:stale' },
    { sequence: 1 },
    { sequence: 0 },
    { sequence: 2, epoch: 99 },
    { sequence: 2, plan_digest: 'stale' },
    { sequence: 2, artifact_digest: 'f'.repeat(64) },
  ])('rejects a stale or regressive receipt without mutation: $actor $sequence $epoch $plan_digest', async (overrides) => {
    const { root, id, task, evidence } = await receiptSetup();
    const { recordTaskReceipt } = await import('../src/hub.js');
    const { readTaskEvents } = await import('../src/state.js');
    await recordTaskReceipt(root, id, receipt(task as never, evidence) as never);
    const before = await readTaskEvents(root);
    await expect(recordTaskReceipt(
      root, id, receipt(task as never, evidence, overrides) as never,
    )).rejects.toThrow();
    expect(await readTaskEvents(root)).toEqual(before);
  });

  it('allows exactly one append in a genuinely concurrent same-sequence race', async () => {
    const { root, id, task, evidence } = await receiptSetup();
    const { recordTaskReceipt } = await import('../src/hub.js');
    const { readTaskEvents } = await import('../src/state.js');
    const results = await Promise.allSettled([
      recordTaskReceipt(root, id, receipt(task as never, evidence) as never),
      recordTaskReceipt(root, id, receipt(task as never, evidence) as never),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await readTaskEvents(root)).filter((event) => event.event === 'receipt')).toHaveLength(1);
  });

  it.each(['asked', 'note', 'blocked', 'manual-failure', 'receipt'] as const)(
    'rejects %s as receipt evidence', async (kind) => {
      const { root, id, task, evidence } = await receiptSetup();
      const { recordTaskReceipt } = await import('../src/hub.js');
      const { readTaskEvents } = await import('../src/state.js');
      const { createHash } = await import('node:crypto');
      if (kind === 'note') await hubLog(root, id, 'note', 'manual note');
      if (kind === 'blocked') await hubLog(root, id, 'blocked', 'manual blocker');
      if (kind === 'manual-failure') await hubProgress(root, id, 'c1', 'fail', 'manual failure');
      if (kind === 'receipt') await recordTaskReceipt(root, id, receipt(task as never, evidence) as never);
      const before = await readTaskEvents(root);
      const claimed = createHash('sha256').update(JSON.stringify(before[kind === 'asked' ? 0 : before.length - 1])).digest('hex');
      await expect(recordTaskReceipt(root, id, receipt(task as never, evidence, {
        sequence: kind === 'receipt' ? 2 : 1, evidence_hashes: [claimed],
      }) as never)).rejects.toThrow(/evidence|blocker/);
      expect(await readTaskEvents(root)).toEqual(before);
    },
  );

  it('rejects evidence from an old plan epoch after an identical replan', async () => {
    const { root, id, task, evidence } = await receiptSetup();
    const { recordTaskReceipt } = await import('../src/hub.js');
    const { handleTaskAction } = await import('../web/taskactions.js');
    const { readTaskEvents } = await import('../src/state.js');
    await handleTaskAction(root, 'demo', '/api/task-resolve', { task: id, action: 'rebrief', note: 'same brief' });
    await hubLog(root, id, 'plan', 'the plan', CPS);
    const current = (await listTasks(root))[0];
    expect(current.plan_digest).toBe(task.plan_digest);
    const before = await readTaskEvents(root);
    await expect(recordTaskReceipt(root, id, receipt(current as never, evidence) as never))
      .rejects.toThrow(/evidence/);
    expect(await readTaskEvents(root)).toEqual(before);
  });

  it('uses fresh identical evidence after an identical rebrief and replan', async () => {
    const { root, id, task, evidence } = await receiptSetup();
    const { evaluateTaskPredicate, recordTaskReceipt } = await import('../src/hub.js');
    const { recordTaskEvidence } = await import('../src/taskgate.js');
    const { handleTaskAction } = await import('../web/taskactions.js');
    await handleTaskAction(root, 'demo', '/api/task-resolve', { task: id, action: 'rebrief', note: 'same brief' });
    await hubLog(root, id, 'plan', 'the plan', CPS);
    const current = (await listTasks(root))[0];
    const fresh = await recordTaskEvidence(root, id, {
      actor: 'agent:builder', plan_digest: current.plan_digest!, epoch: current.lease_epoch!, outcome: 'passed',
      artifact: { diff: 'src/a.ts' }, content: { check: 'unit', status: 'passed' },
    });
    expect(fresh.evidence_hash).toBe(evidence.evidence_hash);
    await recordTaskReceipt(root, id, receipt(current as never, fresh) as never);
    await expect(evaluateTaskPredicate(root, id, 'task_receipt', config(current as never, fresh) as never))
      .resolves.toBe(false);
  });

  it('requires a current registered condition instead of informational unblock text', async () => {
    const { root, id, task, evidence } = await receiptSetup();
    const { recordTaskReceipt } = await import('../src/hub.js');
    const record = (sequence: number, state: string, extra: Record<string, unknown> = {}) =>
      recordTaskReceipt(root, id, receipt(task as never, evidence, { sequence, state, ...extra }) as never);
    await record(1, 'running');
    await expect(record(2, 'blocked', { blocker_kind: 'execution', unblock_condition: 'build passes' }))
      .rejects.toThrow(/registered resume condition/);
    await record(2, 'blocked', {
      blocker_kind: 'execution', unblock_condition: 'build passes',
      resume_condition: { type: 'predicate', acceptance_id: 'missing' },
    });
    expect((await listTasks(root))[0]).toMatchObject({
      state: 'blocked', resume_state: 'running',
      resume_condition: { type: 'predicate', acceptance_id: 'missing' },
    });
    await expect(record(3, 'running')).rejects.toThrow(/resume condition/);
    expect((await listTasks(root))[0].state).toBe('blocked');
  });

  it.each(['blocked', 'failed'] as const)('allows an authorized reconciler to record %s after revocation', async (state) => {
    const { root, id, task, evidence } = await receiptSetup();
    const { recordTaskReceipt } = await import('../src/hub.js');
    await recordTaskReceipt(root, id, receipt(task as never, evidence) as never);
    await hubLog(root, id, 'cancelled', 'owner revoked the lease');
    await recordTaskReceipt(root, id, receipt(task as never, evidence, {
      sequence: 2, state, actor: 'user:alice', blocker_kind: 'execution', unblock_condition: 'retry later',
      resume_condition: { type: 'predicate', acceptance_id: 'missing' },
    }) as never, { trustedReconciler: true, revalidateReconciler: async () => {} });
    expect((await listTasks(root))[0]).toMatchObject({ state, lease_revoked: true });
  });

  it.each([
    { state: 'running', actor: 'agent:builder' },
    { state: 'reconciling', actor: 'user:alice' },
  ] as const)('denies $state for $actor after cancellation and trusted blocked', async ({ state, actor }) => {
    const { root, id, task, evidence } = await receiptSetup();
    const { recordTaskReceipt } = await import('../src/hub.js');
    const { readTaskEvents } = await import('../src/state.js');
    await recordTaskReceipt(root, id, receipt(task as never, evidence) as never);
    await hubLog(root, id, 'cancelled', 'owner revoked the lease');
    await recordTaskReceipt(root, id, receipt(task as never, evidence, {
      sequence: 2, state: 'blocked', actor: 'user:alice', blocker_kind: 'execution', unblock_condition: 'retry later',
      resume_condition: { type: 'predicate', acceptance_id: 'missing' },
    }) as never, { trustedReconciler: true, revalidateReconciler: async () => {} });
    const before = await readTaskEvents(root);
    const current = (await listTasks(root))[0];
    await expect(recordTaskReceipt(root, id, receipt(current as never, evidence, {
      sequence: 3, state, actor,
    }) as never, { trustedReconciler: true, revalidateReconciler: async () => {} })).rejects.toThrow(/revoked/);
    expect(await readTaskEvents(root)).toEqual(before);
  });
});
