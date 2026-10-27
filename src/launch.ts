import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { capturePane, paneExists, paneIdentity, paneIs } from './tmux.js';
import { lines, parseDialog } from './screen.js';
import {
  clearPendingPane, hasLiveSendingClaim, hivePath, hubPath, manifestAdd, readPendingPane, readTeam, Refusal,
  upsertTeamEntry, withHubLock, writePendingPane, type ProjectsFile,
} from './state.js';
import {
  assertEntryAlive, effectiveOrchestratorMode, ensureAgentFiles, findLatestSession,
  launchWindow, orchestratorName, pickupLine, preflight, typeLine, waitIdle,
} from './spawn.js';
import { withLaunchClaim, withProjectLock } from './project.js';
import { settlePendingPane } from './taskgate.js';
import { applyMemoryBlock, memoryBlockFor } from './memory.js';

type ProjectEntry = ProjectsFile['projects'][number];
type LaunchKind = 'wake' | 'start';

async function releasePendingSending(root: string, project: string, claimToken: string, question = false): Promise<void> {
  await withHubLock(root, async () => {
    const current = await readPendingPane(root, project);
    if (current?.sending && current.claim_token === claimToken) {
      await writePendingPane(root, project, { ...current, ...(question ? { question: true } : {}), sending: false });
    }
  });
}

async function launchOrchestrator(
  root: string,
  project: string,
  kind: LaunchKind,
  task?: string,
): Promise<string> {
  return withLaunchClaim(root, project, (p) => launchRegisteredOrchestrator(root, p, kind, task));
}

async function launchRegisteredOrchestrator(
  root: string,
  p: ProjectEntry,
  kind: LaunchKind,
  task?: string,
): Promise<string> {
  const project = p.name;
  if (kind === 'start') {
    if (!task || !new RegExp(`^${project}-\\d+$`).test(task)) {
      throw new Refusal(`a task id is ${project}-<n>: ${task}`);
    }
    const taskFile = await fs.stat(hubPath(root, 'tasks', `${task}.md`)).catch(() => null);
    if (!taskFile?.isFile()) throw new Refusal(`no task file for ${task}`);
  }
  // Claim-then-launch under the hub lock: a second start for the same project
  // must see the pending record, never race past the check.
  const launched = await withHubLock(root, async () => {
    if (await settlePendingPane(root, project)) return 'continue' as const;
    await preflight();

    const team = await readTeam(p.home);
    const old = team.agents.find((a) => a.orchestrator);
    // The watch's death path wakes from a stale snapshot; re-read under the lock.
    if (kind === 'wake' && !old) {
      throw new Refusal(`${project}'s orchestrator is not in team.json; start it instead of waking`);
    }
    if (kind === 'wake' && old?.closed_at) {
      throw new Refusal(`${project}'s orchestrator was closed on purpose at ${old.closed_at}; not waking it`);
    }
    const name = orchestratorName(project);
    const cwd = old?.worktree ?? p.home;
    const sessionId = kind === 'wake' ? old?.session_id ?? (await findLatestSession(cwd, name)) ?? undefined : undefined;
    if (kind === 'wake' && !sessionId) {
      throw new Refusal(`${project} has no recorded session to resume; start it instead`);
    }
    // start and wake both refuse a live orchestrator: a second window would orphan the first.
    if (old?.pane && (await paneIs(old.pane, { pid: old.pane_pid ?? 0, started: old.pane_started ?? '' }))) {
      throw new Refusal(`${project}'s orchestrator is already running`);
    }

    await ensureAgentFiles(cwd, name, 'orchestrator');
    if (task) {
      const block = await memoryBlockFor(root, project, task);
      if (block) await applyMemoryBlock(hivePath(cwd, 'handoffs', `${name}.md`), block);
    }
    const mode = effectiveOrchestratorMode(p.mode ?? 'ask', p.approvals);
    const { pane, identity } = await launchWindow(root, project, name, cwd, sessionId, mode, old?.model);
    await manifestAdd(p.home, {
      kind: 'tmux', at: new Date().toISOString(), pane, window: `${project}:${name}`,
      pane_pid: identity.pid, pane_started: identity.started,
    });
    let line = pickupLine(root, project, name);
    if (task) line += ` The task: read ${hubPath(root, 'tasks', `${task}.md`)} and take it from there.`;
    const pending = {
      pane, kind, at: new Date().toISOString(), typed: false, sending: true, claim_token: randomUUID(), task, line,
    };
    await writePendingPane(root, project, pending);
    return { pane, identity, pending, sessionId, name, cwd, old };
  });
  if (launched === 'continue') {
    // A live, young pending pane is a start still in flight; finish it instead of refusing.
    return continueProject(root, project);
  }
  const { pane, identity, pending, sessionId, name, cwd, old } = launched;
  const line = pending.line ?? '';

  try {
    const idle = await waitIdle(pane, { maxMs: 140_000 });
    if (idle !== 'idle') {
      await releasePendingSending(root, project, pending.claim_token, idle === 'dialog');
      return pane;
    }
    await withProjectLock(root, project, async () => {
      if (kind === 'wake' && old) await assertEntryAlive(p.home, old, { pane, identity });
      const current = await readPendingPane(root, project);
      if (!current || current.typed || !current.sending || current.claim_token !== pending.claim_token) {
        throw new Refusal(`${project}'s sending claim is no longer active`);
      }
      await typeLine(pane, line, identity);
      await upsertTeamEntry(p.home, {
        name, orchestrator: true, pane, pane_pid: identity.pid, pane_started: identity.started,
        worktree: cwd, handoff: hivePath(cwd, 'handoffs', `${name}.md`), closed_at: undefined, wedged_at: undefined,
      });
      await writePendingPane(root, project, { ...current, typed: true, sending: false });
    });
    const sid = kind === 'wake' ? sessionId : await findLatestSession(cwd, name);
    if (sid) await withProjectLock(root, project, () => upsertTeamEntry(p.home, { name, session_id: sid }));
    return pane;
  } catch (e) {
    await releasePendingSending(root, project, pending.claim_token);
    throw e;
  }
}

export async function wake(root: string, project: string): Promise<string> {
  return launchOrchestrator(root, project, 'wake');
}

export async function startProject(root: string, project: string, task: string): Promise<string> {
  return launchOrchestrator(root, project, 'start', task);
}

export async function continueProject(root: string, project: string): Promise<string> {
  return withLaunchClaim(root, project, (p) => continueRegisteredProject(root, p));
}

async function continueRegisteredProject(root: string, p: ProjectEntry): Promise<string> {
  const project = p.name;
  const pending = await withProjectLock(root, project, async () => {
    const current = await readPendingPane(root, project);
    if (!current) throw new Refusal(`${project} is not waiting on a first line`);
    if (current.typed) throw new Refusal(`${project}'s first line was already sent`);
    if (hasLiveSendingClaim(current)) throw new Refusal(`${project}'s first line is already sending`);
    if (!current.line) throw new Refusal(`${project}'s pending record has no line to type`);
    const claimed = {
      ...current, at: new Date().toISOString(), line: current.line, sending: true, claim_token: randomUUID(),
    };
    await writePendingPane(root, project, claimed);
    return claimed;
  });
  try {
    if (!(await paneExists(pending.pane))) {
      await clearPendingPane(root, project);
      throw new Refusal(`${project}'s starting pane ${pending.pane} is gone; start again`);
    }
    const raw = await capturePane(pending.pane);
    if (raw !== null && parseDialog(lines(raw)).kind !== 'none') {
      await releasePendingSending(root, project, pending.claim_token, true);
      throw new Refusal(`a dialog is on the screen of ${pending.pane}; answer it, then continue`);
    }
    const idle = await waitIdle(pending.pane, { maxMs: 140_000 });
    if (idle !== 'idle') throw new Refusal(`${pending.pane} never went idle; nothing was typed`);
    const id = await paneIdentity(pending.pane);
    if (!id) throw new Refusal(`pane ${pending.pane} has no readable identity`);

    await withProjectLock(root, project, async () => {
      if (pending.kind === 'wake') {
        await assertEntryAlive(p.home, { name: orchestratorName(project) }, { pane: pending.pane, identity: id });
      }
      const current = await readPendingPane(root, project);
      if (!current || current.typed || !current.sending || current.claim_token !== pending.claim_token) {
        throw new Refusal(`${project}'s sending claim is no longer active`);
      }
      await typeLine(pending.pane, pending.line, id);
      await upsertTeamEntry(p.home, {
        name: orchestratorName(project), orchestrator: true,
        pane: pending.pane, pane_pid: id.pid, pane_started: id.started,
        worktree: p.home, handoff: hivePath(p.home, 'handoffs', `${orchestratorName(project)}.md`),
        closed_at: undefined, wedged_at: undefined,
      });
      await writePendingPane(root, project, { ...current, typed: true, sending: false });
    });
    const sid = await findLatestSession(p.home, orchestratorName(project));
    if (sid) await withProjectLock(root, project, () => upsertTeamEntry(p.home, { name: orchestratorName(project), session_id: sid }));
    return pending.pane;
  } catch (e) {
    await releasePendingSending(root, project, pending.claim_token);
    throw e;
  }
}
