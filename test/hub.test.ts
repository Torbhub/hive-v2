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
    paneIdentity: vi.fn(async () => ({ pid: 1, started: 'x' })),
    paneIs: vi.fn(async () => true),
    capturePane: vi.fn(async () => DIALOG),
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

import { capturePane, killWindow, newWindow, paneExists, paneIs, sendArrow, sendEnter, sendLiteral } from '../src/tmux.js';
import {
  answerDialog, buildStatus, continueProject, hubAccept, hubAdd, hubInit, hubLog, hubProgress, hubTask, listTasks, menuKeys, planAnswer,
  readDialogFor, setProjectApprovals, setProjectMode, startProject, wake,
} from '../src/hub.js';
import { handleCurrentOrchestratorDialog } from '../src/watch.js';
import { preflight, typeLine, waitIdle } from '../src/spawn.js';
import { killAgent } from '../src/kill.js';
import { removeProject } from '../src/project.js';
import { lines, parseDialog } from '../src/screen.js';
import { appendTaskEvent, hubPath, hivePath, readDecisions, readPendingPane, readProjects, readTeam, writeJson, writePendingPane, writeProjects } from '../src/state.js';
import type { Checkpoint } from '../src/types.js';

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

// A three-option menu built on the trust menu's structure (cursor on 1).
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
    expect(vi.mocked(sendEnter).mock.calls).toEqual([['%1']]);
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
    // a non-decided event does not mirror
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
    // A legacy ledger can hold a plan event with no checkpoints; append it directly.
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
    const id = await hubTask(root, 'demo', 'build it');
    await hubLog(root, id, 'plan', 'the plan', CPS);
    vi.mocked(capturePane).mockImplementation(async () => IDLE);
    await planAnswer(root, 'demo', id, 'approve');
    return { root, id };
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
    await hubLog(root, id, 'done');
    expect((await listTasks(root)).find((t) => t.id === id)?.state).toBe('done');
  });

  it('a skip needs a note, then counts as terminal', async () => {
    const { root, id } = await setupApproved();
    await hubProgress(root, id, 'c1', 'ok');
    await expect(hubProgress(root, id, 'c2', 'skip')).rejects.toThrow(/needs a note/);
    await hubProgress(root, id, 'c2', 'skip', 'not needed on this repo');
    await hubLog(root, id, 'done');
    expect((await listTasks(root)).find((t) => t.id === id)?.state).toBe('done');
  });

  it('a failed checkpoint blocks done until the owner accepts it', async () => {
    const { root, id } = await setupApproved();
    await hubProgress(root, id, 'c1', 'ok');
    await hubProgress(root, id, 'c2', 'fail', 'flaky fixture');
    await expect(hubLog(root, id, 'done')).rejects.toThrow(/c2 failed and the owner has not accepted it/);
    await hubAccept(root, id, 'c2');
    await hubLog(root, id, 'done');
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
    await hubLog(root, id, 'done');
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

describe('orchestrator dialog pane resolution', () => {
  afterEach(() => {
    vi.mocked(paneExists).mockResolvedValue(true);
    vi.mocked(capturePane).mockResolvedValue(DIALOG);
  });

  it('Auto answers a live pending approval instead of the stale registered pane', async () => {
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 1, pane_started: 'old' }],
    });
    await writePendingPane(root, 'demo', {
      pane: '%2', kind: 'wake', at: new Date().toISOString(), typed: false, line: 'You are demo-orchestrator.',
    });
    await setProjectMode(root, 'demo', 'auto');
    vi.mocked(paneExists).mockImplementation(async (pane) => pane === '%2');
    vi.mocked(capturePane).mockImplementation(async (pane) => pane === '%2' ? DIALOG : IDLE);
    vi.mocked(sendLiteral).mockClear();

    await handleCurrentOrchestratorDialog(root, 'demo');

    expect(sendLiteral).toHaveBeenCalledTimes(1);
    expect(sendLiteral).toHaveBeenCalledWith('%2', '1');
  });

  it('a dead pending pane does not hide a live registered orchestrator', async () => {
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 1, pane_started: 'current' }],
    });
    await writePendingPane(root, 'demo', {
      pane: '%2', kind: 'wake', at: new Date().toISOString(), typed: false, line: 'You are demo-orchestrator.',
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
      pane: '%7', kind: 'start', at: new Date().toISOString(), typed: false, line: 'You are demo-orchestrator.',
    });
    vi.mocked(capturePane).mockImplementation(async () => IDLE);
    vi.mocked(typeLine).mockClear();
    return root;
  }

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
      pane: '%7', kind: 'start', at, typed: false, sending: true, line: 'You are demo-orchestrator.',
    });

    await expect(continueProject(root, 'demo')).rejects.toThrow(/already sending/);

    expect(typeLine).not.toHaveBeenCalled();
    expect(await readPendingPane(root, 'demo')).toMatchObject({ at, typed: false, sending: true });
  });

  it('reclaims an orphaned sending claim and refreshes its activity timestamp', async () => {
    const root = await setupPending();
    const staleAt = new Date(Date.now() - 11 * 60_000).toISOString();
    await writePendingPane(root, 'demo', {
      pane: '%7', kind: 'start', at: staleAt, typed: false, sending: true, line: 'You are demo-orchestrator.',
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
  // The exact timeline from the review: the wake's guard passes (entry
  // present, unstamped), the owner's Kill lands while the new pane comes up,
  // and the final upsert must refuse instead of resurrecting — with the
  // fresh pane taken down.
  it('a cascade landing mid-wake stops the final upsert and the fresh pane dies', async () => {
    vi.mocked(killWindow).mockClear();
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'demo-orchestrator', orchestrator: true, session_id: 'session_abc' }],
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
      agents: [{ name: 'demo-orchestrator', orchestrator: true, session_id: 'session_abc' }],
    });
    await writePendingPane(root, 'demo', {
      pane: '%7', kind: 'wake', at: new Date().toISOString(), typed: false, line: 'You are demo-orchestrator.',
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

describe('start after a cleanup stamp', () => {
  // cleanup stamps closed_at without dropping the entry; that stamp is
  // history, not a kill in flight, and a deliberate start must proceed.
  it('start on a stamped project succeeds and clears the stamp', async () => {
    const { root, home } = await setup();
    await hubTask(root, 'demo', 'do it');
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'demo-orchestrator', orchestrator: true, session_id: 'session_abc', closed_at: new Date().toISOString() }],
    });
    const pane = await startProject(root, 'demo', 'demo-1');
    expect(pane).toBe('%9');
    const team = await readTeam(home);
    expect(team.agents[0]).toMatchObject({ name: 'demo-orchestrator', pane: '%9' });
    expect(team.agents[0].closed_at).toBeUndefined();
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
    vi.mocked(preflight).mockImplementationOnce(async () => {
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
  // The watch's death path reads the team once per tick and wakes from that
  // stale snapshot. The cascade drops the orchestrator entry (or stamps it
  // closed mid-flight), so the wake must re-check and refuse.
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
        name: 'demo-orchestrator', orchestrator: true, session_id: 'session_abc',
        closed_at: new Date().toISOString(),
      }],
    });
    const windows = vi.mocked(newWindow).mock.calls.length;
    await expect(wake(root, 'demo')).rejects.toThrow(/closed on purpose/);
    expect(vi.mocked(newWindow).mock.calls).toHaveLength(windows);
  });
});

describe('wake pending pane', () => {
  const LINE = 'You are demo-orchestrator, the orchestrator of project demo.';

  it('a stale pending record is cleared and the wake proceeds', async () => {
    const { root } = await setup();
    await writePendingPane(root, 'demo', {
      pane: '%7', kind: 'wake', at: new Date(Date.now() - 11 * 60_000).toISOString(), line: LINE,
    });
    await expect(wake(root, 'demo')).rejects.toThrow(/not in team.json/);
    expect(await readPendingPane(root, 'demo')).toBeNull();
  });

  it('a pending record whose pane died is cleared and the wake proceeds', async () => {
    const { root } = await setup();
    await writePendingPane(root, 'demo', { pane: '%7', kind: 'wake', at: new Date().toISOString(), line: LINE });
    vi.mocked(paneExists).mockImplementation(async (p) => p !== '%7');
    await expect(wake(root, 'demo')).rejects.toThrow(/not in team.json/);
    expect(await readPendingPane(root, 'demo')).toBeNull();
    vi.mocked(paneExists).mockImplementation(async () => true);
  });

  it('a live young pending pane routes through continue instead of refusing', async () => {
    const { root, home } = await setup();
    await fs.mkdir(hivePath(home), { recursive: true });
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'demo-orchestrator', orchestrator: true, session_id: 'session_abc' }],
    });
    await writePendingPane(root, 'demo', { pane: '%7', kind: 'wake', at: new Date().toISOString(), line: LINE });
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
      agents: [{ name: 'demo-orchestrator', orchestrator: true, session_id: 'session_abc' }],
    });
    return { root, home };
  }

  it('wakes an auto orchestrator with -y', async () => {
    const { root } = await setupOrchestrator();
    await setProjectMode(root, 'demo', 'auto');
    await setProjectApprovals(root, 'demo', 'manual');
    const pane = await wake(root, 'demo');
    expect(pane).toBe('%9');
    expect(vi.mocked(newWindow).mock.calls.at(-1)?.[2])
      .toBe(`HIVE_AGENT=demo-orchestrator HIVE_PROJECT=demo HIVE_HUB_ROOT='${root}' KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run -- --session session_abc -y -m 'kimi-code/k3.1-pro'`);
  });

  it('wakes in ask when approvals is manual, so the human answers', async () => {
    const { root } = await setupOrchestrator();
    await setProjectMode(root, 'demo', 'ask');
    await setProjectApprovals(root, 'demo', 'manual');
    await wake(root, 'demo');
    expect(vi.mocked(newWindow).mock.calls.at(-1)?.[2])
      .toBe(`HIVE_AGENT=demo-orchestrator HIVE_PROJECT=demo HIVE_HUB_ROOT='${root}' KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run -- --session session_abc -m 'kimi-code/k3.1-pro'`);
  });
});
