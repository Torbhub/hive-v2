import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { capturePane, killWindow, paneExists, paneIs } from './tmux.js';
import { lines, parseDialog } from './screen.js';
import {
  clearPendingPane, compareAndSwapTeamEntry, hasLiveSendingClaim, hivePath, hubPath, insertTeamEntry, manifestAdd,
  readPendingPane, readProjects, readTeam, Refusal, withHubLock, writePendingPane, type PendingPane, type ProjectsFile,
} from './state.js';
import {
  allocateAgentLane, assertEntryAlive, assertNoLiveAgentReplacement, assertWorktreeNotShared, checkModel,
  DEFAULT_MODEL, effectiveOrchestratorMode, ensureAgentFiles, findLatestSession,
  launchWindow, orchestratorName, pickupLine, preflight, typeLine, verifiedPendingPaneIdentity, waitIdle, withAgentLaneReservation,
} from './spawn.js';
import { withLaunchClaim, withProjectLock } from './project.js';
import { settlePendingPane } from './taskgate.js';
import { applyMemoryBlock, memoryBlockFor } from './memory.js';
import { assertExecutionAllowed } from './rollout.js';
import type { TeamEntry } from './types.js';

type ProjectEntry = ProjectsFile['projects'][number];
type LaunchKind = 'wake' | 'start';

export function pendingMigrationRequired(pending: PendingPane, orchestrator?: TeamEntry): boolean {
  return pending.model === undefined || (orchestrator !== undefined && orchestrator.model === undefined)
    || (orchestrator !== undefined && pending.model !== orchestrator.model)
    || pending.launch_scoped_auto === undefined || pending.launch_mode === undefined
    || pending.migration_state !== undefined || pending.watch_authority_revoked_at !== undefined
    || orchestrator?.migration_state !== undefined || orchestrator?.watch_authority_revoked_at !== undefined;
}

function orchestratorModel(project: string, kind: LaunchKind, old?: TeamEntry): string {
  if (!old) {
    if (kind === 'wake') throw new Refusal(`${project}'s orchestrator is not in team.json; start it instead of waking`);
    return DEFAULT_MODEL;
  }
  if (old.model === undefined) {
    throw new Refusal(`${old.name} is missing its recorded model. Use hive spawn respawn ${project} --agent ${old.name} --model ${DEFAULT_MODEL}`);
  }
  return old.model;
}

async function recordOrchestrator(
  home: string, entry: Parameters<typeof insertTeamEntry>[1], expected?: TeamEntry | null,
): Promise<void> {
  const current = expected === undefined
    ? (await readTeam(home)).agents.find((candidate) => candidate.name === entry.name)
    : expected;
  if (!current) {
    if (expected === null && (await readTeam(home)).agents.some((candidate) => candidate.name === entry.name)) {
      throw new Refusal(`${entry.name} changed while its launch was being recorded`);
    }
    await insertTeamEntry(home, entry);
    return;
  }
  if (!await compareAndSwapTeamEntry(home, current, entry)) {
    throw new Refusal(`${entry.name} changed while its launch was being recorded`);
  }
}

async function pendingOrchestrator(home: string, pending: PendingPane): Promise<TeamEntry | undefined> {
  const orchestrators = (await readTeam(home)).agents.filter((agent) => agent.orchestrator);
  if (orchestrators.length > 1) throw new Refusal('pending launch has duplicate or ambiguous orchestrator registrations');
  const orchestrator = orchestrators[0];
  const distinct = Boolean(orchestrator?.pane && (orchestrator.pane !== pending.pane
    || orchestrator.pane_pid !== pending.pane_pid || orchestrator.pane_started !== pending.pane_started));
  if (orchestrator?.pane && distinct && await paneIs(orchestrator.pane, {
    pid: orchestrator.pane_pid ?? 0, started: orchestrator.pane_started ?? '',
  })) {
    throw new Refusal(`${orchestrator.name} has a distinct live pane ${orchestrator.pane}`);
  }
  return orchestrator;
}

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
  await assertExecutionAllowed(root, project);
  const projectEntry = (await readProjects(root)).projects.find((candidate) => candidate.name === project);
  if (!projectEntry) throw new Refusal(`unknown project: ${project}`);
  if (kind === 'start') {
    if (!task || !new RegExp(`^${project}-\\d+$`).test(task)) {
      throw new Refusal(`a task id is ${project}-<n>: ${task}`);
    }
    const taskFile = await fs.stat(hubPath(root, 'tasks', `${task}.md`)).catch(() => null);
    if (!taskFile?.isFile()) throw new Refusal(`no task file for ${task}`);
  }
  const pending = await readPendingPane(root, project);
  const old = (await readTeam(projectEntry.home)).agents.find((entry) => entry.orchestrator);
  const model = pending ? undefined : orchestratorModel(project, kind, old);
  const launch = async () => {
    if (model !== undefined) {
      checkModel(model);
      await preflight(model);
    }
    return withLaunchClaim(root, project, (p) => launchRegisteredOrchestrator(root, p, kind, task, model));
  };
  if (kind === 'start' && !old?.worktree && !pending) {
    return withAgentLaneReservation(projectEntry.home, project, orchestratorName(project), undefined, launch);
  }
  return launch();
}

async function launchRegisteredOrchestrator(
  root: string,
  p: ProjectEntry,
  kind: LaunchKind,
  task: string | undefined,
  expectedModel: string | undefined,
): Promise<string> {
  const project = p.name;
  let lane: Awaited<ReturnType<typeof allocateAgentLane>> | undefined;
  let newPane: { pane: string; identity: { pid: number; started: string } } | undefined;
  let claimToken: string | undefined;
  let teamRegistered = false;
  try {
    const launched = await withHubLock(root, async () => {
      const team = await readTeam(p.home);
      const orchestrators = team.agents.filter((agent) => agent.orchestrator);
      if (orchestrators.length > 1) throw new Refusal(`${project} has duplicate or ambiguous orchestrator registrations`);
      if (await settlePendingPane(root, project)) return 'continue' as const;
      const old = orchestrators[0];
      const model = orchestratorModel(project, kind, old);
      if (expectedModel !== undefined && model !== expectedModel) {
        throw new Refusal(`${project}'s recorded model changed before launch`);
      }
      checkModel(model);
      await preflight(model);
      if (kind === 'wake' && old?.closed_at) {
        throw new Refusal(`${project}'s orchestrator was closed on purpose at ${old.closed_at}; not waking it`);
      }
      const name = orchestratorName(project);
      if (old?.pane && (await paneIs(old.pane, { pid: old.pane_pid ?? 0, started: old.pane_started ?? '' }))) {
        throw new Refusal(`${project}'s orchestrator is already running`);
      }
      await assertNoLiveAgentReplacement(p.home, project, name, old);
      let cwd = old?.worktree;
      if (!cwd && kind === 'start') {
        lane = await allocateAgentLane(p.home, project, name);
        cwd = lane.worktree;
      }
      cwd ??= p.home;
      if (!lane) await assertWorktreeNotShared(p.home, cwd, old);
      const sessionId = kind === 'wake' ? old?.session_id ?? (await findLatestSession(cwd, name)) ?? undefined : undefined;
      if (kind === 'wake' && !sessionId) {
        throw new Refusal(`${project} has no recorded session to resume; start it instead`);
      }

      await ensureAgentFiles(cwd, name, 'orchestrator');
      if (task) {
        const block = await memoryBlockFor(root, project, task);
        if (block) await applyMemoryBlock(hivePath(cwd, 'handoffs', `${name}.md`), block);
      }
      const mode = effectiveOrchestratorMode(p.mode ?? 'ask', p.approvals);
      const { pane, identity } = await launchWindow(root, project, name, cwd, sessionId, mode, model, undefined, p.home);
      newPane = { pane, identity };
      await manifestAdd(p.home, {
        kind: 'tmux', at: new Date().toISOString(), pane, window: `${project}:${name}`,
        pane_pid: identity.pid, pane_started: identity.started,
      });
      let line = pickupLine(root, project, name);
      if (task) line += ` The task: read ${hubPath(root, 'tasks', `${task}.md`)} and take it from there.`;
      const pending = {
        pane, pane_pid: identity.pid, pane_started: identity.started, worktree: cwd,
        kind, at: new Date().toISOString(), typed: false, sending: true, claim_token: randomUUID(), task, line,
        model, launch_mode: mode, launch_scoped_auto: mode === 'auto',
      };
      claimToken = pending.claim_token;
      await writePendingPane(root, project, pending);
      return { pane, identity, pending, sessionId, name, cwd, old, model };
    });
    if (launched === 'continue') return continueProject(root, project);
    const { pane, identity, pending, sessionId, name, cwd, old, model } = launched;
    const line = pending.line ?? '';

    const idle = await waitIdle(pane, { maxMs: 140_000 });
    if (idle !== 'idle') {
      await releasePendingSending(root, project, pending.claim_token, idle === 'dialog');
      return pane;
    }
    await withProjectLock(root, project, async () => {
      if (kind === 'wake' && old) await assertEntryAlive(p.home, old, { pane, identity }, { cleanup: false });
      const current = await readPendingPane(root, project);
      if (!current || current.typed || !current.sending || current.claim_token !== pending.claim_token) {
        throw new Refusal(`${project}'s sending claim is no longer active`);
      }
      if (pendingMigrationRequired(current)) throw new Refusal(`${project}'s pending launch needs explicit migration`);
      await assertExecutionAllowed(root, project);
      await typeLine(pane, line, identity);
      await recordOrchestrator(p.home, {
        name, orchestrator: true, pane, pane_pid: identity.pid, pane_started: identity.started,
        worktree: cwd, handoff: hivePath(cwd, 'handoffs', `${name}.md`), closed_at: undefined, wedged_at: undefined,
        model, launch_mode: current.launch_mode, launch_scoped_auto: current.launch_scoped_auto,
        migration_state: undefined, watch_authority_revoked_at: undefined,
      }, old ?? null);
      teamRegistered = true;
      await writePendingPane(root, project, { ...current, typed: true, sending: false });
    });
    const sid = kind === 'wake' ? sessionId : await findLatestSession(cwd, name);
    if (sid) await withProjectLock(root, project, () => recordOrchestrator(p.home, { name, session_id: sid }));
    return pane;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (newPane && !teamRegistered) {
      await killWindow(newPane.pane, newPane.identity).catch((cleanup: unknown) => { cleanupErrors.push(cleanup); });
    }
    const possibleWork = newPane !== undefined || (error as { windowStarted?: boolean }).windowStarted === true;
    if (lane && !possibleWork) await lane.rollback().catch((cleanup: unknown) => { cleanupErrors.push(cleanup); });
    if (claimToken) {
      await releasePendingSending(root, project, claimToken).catch((cleanup: unknown) => { cleanupErrors.push(cleanup); });
    }
    if (cleanupErrors.length) {
      throw new AggregateError([error, ...cleanupErrors], error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
}

export async function wake(root: string, project: string): Promise<string> {
  return launchOrchestrator(root, project, 'wake');
}

export async function startProject(root: string, project: string, task: string): Promise<string> {
  return launchOrchestrator(root, project, 'start', task);
}

export async function continueProject(root: string, project: string): Promise<string> {
  await assertExecutionAllowed(root, project);
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
    const worktree = pending.worktree ?? p.home;
    const orchestrator = await pendingOrchestrator(p.home, pending);
    await assertWorktreeNotShared(p.home, worktree, orchestrator);
    const initialId = await verifiedPendingPaneIdentity(pending);
    const raw = await capturePane(pending.pane);
    if (raw !== null && parseDialog(lines(raw)).kind !== 'none') {
      await releasePendingSending(root, project, pending.claim_token, true);
      throw new Refusal(`a dialog is on the screen of ${pending.pane}; answer it, then continue`);
    }
    const idle = await waitIdle(pending.pane, { maxMs: 140_000 });
    if (idle !== 'idle') throw new Refusal(`${pending.pane} never went idle; nothing was typed`);

    await withProjectLock(root, project, async () => {
      if (pending.kind === 'wake') {
        await assertEntryAlive(p.home, { name: orchestratorName(project) }, { pane: pending.pane, identity: initialId });
      }
      const current = await readPendingPane(root, project);
      if (!current || current.typed || !current.sending || current.claim_token !== pending.claim_token
        || current.worktree !== pending.worktree) {
        throw new Refusal(`${project}'s sending claim is no longer active`);
      }
      const id = await verifiedPendingPaneIdentity(current);
      const currentOrchestrator = await pendingOrchestrator(p.home, current);
      await assertWorktreeNotShared(p.home, current.worktree ?? p.home, currentOrchestrator);
      if (pendingMigrationRequired(current, currentOrchestrator)) {
        throw new Refusal(`${project}'s pending launch provenance requires explicit migration`);
      }
      await assertExecutionAllowed(root, project);
      await typeLine(pending.pane, pending.line, id);
      await recordOrchestrator(p.home, {
        name: orchestratorName(project), orchestrator: true,
        pane: pending.pane, pane_pid: id.pid, pane_started: id.started,
        worktree, handoff: hivePath(worktree, 'handoffs', `${orchestratorName(project)}.md`),
        closed_at: undefined, wedged_at: undefined,
        model: current.model!, launch_mode: current.launch_mode, launch_scoped_auto: current.launch_scoped_auto,
        migration_state: undefined, watch_authority_revoked_at: undefined,
      }, currentOrchestrator ?? null);
      await writePendingPane(root, project, { ...current, typed: true, sending: false });
    });
    const sid = await findLatestSession(pending.worktree ?? p.home, orchestratorName(project));
    if (sid) await withProjectLock(root, project, () => recordOrchestrator(p.home, {
      name: orchestratorName(project), session_id: sid,
    }));
    return pending.pane;
  } catch (e) {
    await releasePendingSending(root, project, pending.claim_token);
    throw e;
  }
}
