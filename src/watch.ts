import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { captureDeathBundle, wireLogMtime } from './death-bundle.js';
import { answerDialog, buildStatus, continueProject, readDialogFor, Refusal, wake } from './hub.js';
import { DEFAULT_MODEL, wakeAgent } from './spawn.js';
import { classify, lines } from './screen.js';
import { appendDecision, hasLiveSendingClaim, hivePath, hubPath, readPendingPane, readProjects, readTeam, upsertTeamEntry, writeJson } from './state.js';
import { capturePane, killWindow, paneExists, paneIs, run, sleep } from './tmux.js';
import { lastLine, withTimeout } from './view.js';
import { loadProcessedKeys, recordProcessedKey } from './watch-persist.js';
import type { Approvals, TeamEntry } from './types.js';

// Read-only leaders: a chain segment must start with one of these to be
// auto-approvable. Multi-word leaders match the subcommand, not just `git`.
const SAFE_LEADERS = [
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'pwd', 'echo', 'wc', 'tsc',
  'git status', 'git log', 'git diff', 'git show', 'git branch',
  'jj st', 'jj status', 'jj log', 'jj diff', 'jj show',
  'jj bookmark list', 'jj git root', 'jj root',
  'hive hub status', 'hive hub tasks', 'hive hub dialog',
  'npm run build',
];

// Destructive shapes are never auto-approved, by either tier.
const NEVER_RES = [
  /\brm\s/, /git\s+push/, /git\s+reset/, /\bsudo\b/, /\bdd\s/, /\bmkfs\b/,
  /\bjj\s+push\b/, /\bjj\s+abandon\b/, /jj\s+workspace\s+forget/,
  /chmod\s+-R/, /(?:curl|wget)[^|]*\|\s*(?:ba|z)?sh\b/, />\s*\/(etc|usr|bin|sbin|var|boot|lib)(\/|\s|$)/,
  // Heavy compute waits for a human: box policy bans local builds and suites.
  /\bnpm\s+ci\b/, /\bnpm\s+(?:i|install)\b/, /\bnpx\s+vitest\b/, /\bnpm\s+test\b/,
  /\bnpx\s+jest\b/, /\bcargo\s+build\b/, /\bmake\s/, /\bdocker\s+build\b/, /\bpip\s+install\b/,
];

export function extractCommand(dialogText: string): string | null {
  const m = dialogText.match(/^\s*(?:▶\s*)?\$\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

export function neverApprove(dialogText: string): boolean {
  return NEVER_RES.some((re) => re.test(dialogText));
}

export function tier1Approves(command: string): boolean {
  const segments = command.split(/\s*(?:&&|\|\||[;|])\s*/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((seg) => SAFE_LEADERS.some((w) => seg === w || seg.startsWith(`${w} `)));
}

const CLASSIFY_TIMEOUT_MS = 60_000;
const CYCLE_TIMEOUT_MS = 120_000;

export async function kimiEnv(): Promise<NodeJS.ProcessEnv> {
  const r = await run('teamkimi', ['env']);
  const env: Record<string, string> = {};
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return env;
}

// A fresh-context one-shot classifier; only a response STARTING with APPROVE counts.
export async function classifyWithKimi(
  project: string,
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const prompt = `In project ${project}, an agent asks to run this command:\n$ ${command}\nAnswer APPROVE only if this is clearly a safe, read-only or build/test action with no external side effects. Otherwise answer ASK.`;
  const model = [env.HIVE_CLASSIFIER_MODEL, process.env.HIVE_CLASSIFIER_MODEL]
    .find((value) => value?.trim()) ?? DEFAULT_MODEL;
  const spawnEnv = { ...process.env, ...env, KIMI_CODE_NO_AUTO_UPDATE: '1' };
  const args = ['-m', model, '-p', prompt];
  const r = await run('kimi', args, undefined, spawnEnv, CLASSIFY_TIMEOUT_MS);
  return r.code === 0 && r.stdout.trimStart().startsWith('APPROVE');
}

// APPROVE verdicts cached by command: one grep must never spawn two classifiers.
// ASK and timeouts are never cached, so a re-ask always reaches the classifier.
const approveCache = new Map<string, true>();
// Fingerprints with a classifier running right now; abandoned cycles skip them.
const inFlightMarks = new Set<string>();

async function appendWatchLog(root: string, line: string): Promise<void> {
  await fs.mkdir(hubPath(root), { recursive: true });
  await fs.appendFile(hubPath(root, 'watch.log'), `${line}\n`);
}

async function maybeAutoApprove(
  root: string,
  project: string,
  agentRef: string | undefined,
  dialog: NonNullable<Awaited<ReturnType<typeof readDialogFor>>>,
  approvals: Approvals,
  env: NodeJS.ProcessEnv,
  verdicts: Map<string, true>,
  marks: Set<string>,
  auto = false,
): Promise<void> {
  const command = extractCommand(dialog.text);
  if (auto) {
    const trust = !command && dialog.text.includes('Trust this folder?');
    if (!command && !trust) return;
    const opt = dialog.options.find((o) => o.offered && !o.saves_rule && (
      trust ? /^Trust\b/i.test(o.label) : /^(Approve|Allow)\b/i.test(o.label)
    ));
    if (!opt) return;
    await answerDialog(root, project, agentRef, String(opt.n), dialog.fingerprint);
    await appendDecision(root, {
      project, by: 'watch',
      summary: command ? `auto-approved "${opt.label}" for: $ ${command}` : `auto-approved "${opt.label}"`,
    });
    return;
  }
  // neverApprove runs before every tier and before the cache, always.
  if (!command || neverApprove(dialog.text)) return;
  // Whitespace-collapsed key: `git  status` and `git status` share a verdict.
  const cacheKey = command.replace(/\s+/g, ' ');
  let ok = tier1Approves(command);
  if (!ok && approvals === 'smart') {
    if (verdicts.has(cacheKey)) {
      ok = true;
    } else if (!marks.has(dialog.fingerprint)) {
      marks.add(dialog.fingerprint);
      try {
        ok = await classifyWithKimi(project, command, env);
      } finally {
        marks.delete(dialog.fingerprint);
      }
      if (ok) verdicts.set(cacheKey, true);
    }
  }
  if (!ok) return;
  // Only ever option 1 ("Approve once"); a saves-rule option is the owner's call.
  const opt = dialog.options.find((o) => o.n === 1);
  if (!opt || !opt.offered || opt.saves_rule) return;
  await answerDialog(root, project, agentRef, '1', dialog.fingerprint);
  await appendDecision(root, {
    project, by: 'watch', summary: `auto-approved "${opt.label}" for: $ ${command}`,
  });
}

export async function handleCurrentOrchestratorDialog(root: string, project: string): Promise<void> {
  const p = (await readProjects(root)).projects.find((x) => x.name === project);
  if (!p) throw new Refusal(`unknown project: ${project}`);
  const approvals = p.approvals ?? 'manual';
  if (p.mode !== 'auto' && approvals === 'manual') return;
  const dialog = await readDialogFor(root, project).catch((e: unknown) => {
    if (!(e instanceof Refusal)) throw e;
    return null;
  });
  if (!dialog) return;
  const env: NodeJS.ProcessEnv = p.mode !== 'auto' && approvals === 'smart' ? await kimiEnv().catch(() => ({})) : {};
  await maybeAutoApprove(root, project, undefined, dialog, approvals, env, approveCache, inFlightMarks, p.mode === 'auto');
}

export const WAKE_MAX_ATTEMPTS = 60;
export const WEDGE_STILL_MS = 10 * 60_000;
export const STALE_WIRE_MS = 15 * 60_000;
const WEDGE_DUMP_TIMEOUT_MS = 15_000;

export type WakeState = Map<string, { attempts: number; nextAt: number }>;

// Desired vs actual, re-judged every tick: a death is logged and bundled once,
// but the wake is retried with backoff until the pane is back or the budget
// runs out (60 attempts at a capped 10-minute backoff span hours of outage).
// The deaths set is seeded from disk at watch start, so a restart skips the
// re-report but still owns the wake.
async function handleDeath(
  root: string,
  project: string,
  home: string,
  a: TeamEntry,
  deaths: Set<string>,
  wakes: WakeState,
): Promise<void> {
  const key = `${a.pane}:${a.pane_pid}`;
  if (!deaths.has(key)) {
    deaths.add(key);
    await recordProcessedKey(root, key);
    await appendWatchLog(
      root,
      `${new Date().toISOString()} ${project} ${a.name} pane ${a.pane} died (pid ${a.pane_pid}, started ${a.pane_started})`,
    );
    const bundle = await captureDeathBundle(root, project, a).catch(() => null);
    await appendWatchLog(
      root,
      `${new Date().toISOString()} ${project} ${a.name} death bundle: ${bundle ?? 'capture failed'}`,
    );
  }
  if (!a.orchestrator && !a.session_id) return;
  const w = wakes.get(key) ?? { attempts: 0, nextAt: 0 };
  if (w.attempts >= WAKE_MAX_ATTEMPTS || Date.now() < w.nextAt) return;
  const attempt = w.attempts + 1;
  wakes.set(key, { attempts: attempt, nextAt: Date.now() + Math.min(5000 * 2 ** (attempt - 1), 600_000) });
  try {
    const pane = a.orchestrator ? await wake(root, project) : await wakeAgent(root, project, a.name);
    // A timeout can return an unregistered pane. A resurrection needs both the
    // returned pane and its new process identity in the team entry.
    const entry = (await readTeam(home)).agents.find((x) => x.name === a.name);
    if (entry?.pane !== pane) {
      throw new Error(`wake returned ${pane} but the team entry still points at ${entry?.pane ?? 'nothing'}`);
    }
    if (!(await paneIs(pane, { pid: entry.pane_pid ?? 0, started: entry.pane_started ?? '' }))) {
      throw new Error(`wake returned ${pane} but the team entry has a stale process identity`);
    }
    await appendDecision(root, {
      project, by: 'watch',
      summary: a.orchestrator
        ? `woke the orchestrator after pane ${a.pane} died`
        : `woke ${a.name} after pane ${a.pane} died`,
    });
    await appendWatchLog(
      root,
      `${new Date().toISOString()} ${project} resurrected ${a.name} in pane ${pane} (wake attempt ${attempt})`,
    );
  } catch (e) {
    await appendWatchLog(root, `${new Date().toISOString()} ${project} wake attempt ${attempt} failed: ${lastLine(e)}`);
    if (attempt === WAKE_MAX_ATTEMPTS) {
      await appendWatchLog(
        root,
        `${new Date().toISOString()} ${project} gave up waking ${a.name} after ${WAKE_MAX_ATTEMPTS} attempts; wake it by hand`,
      );
    }
  }
}

// A live pane with a silent wire log for 15 minutes is a stalled lane.
// One decisions line per pane per hour; the persisted set carries it across
// restarts so systemd never turns one stall into an hourly-repeat flood.
async function flagStale(
  root: string,
  project: string,
  a: TeamEntry,
  seen: Set<string>,
): Promise<void> {
  if (!a.session_id || !a.pane) return;
  const wireAt = await wireLogMtime(os.homedir(), a.session_id);
  if (wireAt === null) return;
  const ageMs = Date.now() - wireAt;
  if (ageMs < STALE_WIRE_MS) return;
  const key = `stale:${a.pane}:${Math.floor(Date.now() / 3_600_000)}`;
  if (seen.has(key)) return;
  seen.add(key);
  await recordProcessedKey(root, key);
  await appendDecision(root, {
    project, by: 'watch',
    summary: `stale: ${project}/${a.name} no output for ${Math.floor(ageMs / 60_000)}m`,
  });
}

async function stackProbe(sections: string[], title: string, cmd: string, args: string[]): Promise<void> {
  try {
    const r = await run(cmd, args, undefined, undefined, WEDGE_DUMP_TIMEOUT_MS);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `exit code ${r.code}`);
    sections.push(title, r.stdout.trimEnd() || 'no output');
  } catch (e) {
    sections.push(title, `unavailable (${lastLine(e)})`);
  }
}

// Operator standing rule: stack dumps land on disk BEFORE any wedged restart.
async function captureWedgeDump(home: string, a: TeamEntry): Promise<string> {
  const sections: string[] = [`agent: ${a.name}`, `pane: ${a.pane ?? '?'}`, `pid: ${a.pane_pid ?? '?'}`];
  await stackProbe(sections, `== pstack ${a.pane_pid} ==`, 'sudo', ['-n', 'pstack', String(a.pane_pid)]);
  const pySpy = await run('which', ['py-spy'], undefined, undefined, WEDGE_DUMP_TIMEOUT_MS);
  if (pySpy.code === 0) await stackProbe(sections, '== py-spy dump ==', 'py-spy', ['dump', '--pid', String(a.pane_pid)]);
  const file = hivePath(home, 'wedges', `${a.name}-${Math.floor(Date.now() / 1000)}.log`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, sections.join('\n') + '\n');
  return file;
}

export type Stillness = Map<string, { content: string; since: number; cpu: number | null }>;

// CPU seconds of the pane's whole process tree; null when the pid is gone.
async function treeCpuTime(pid: number): Promise<number | null> {
  const r = await run('ps', ['-eo', 'pid=,ppid=,times='], undefined, undefined, WEDGE_DUMP_TIMEOUT_MS);
  if (r.code !== 0) return null;
  const kids = new Map<number, number[]>();
  const times = new Map<number, number>();
  for (const line of r.stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)/);
    if (!m) continue;
    const [p, pp, t] = [Number(m[1]), Number(m[2]), Number(m[3])];
    times.set(p, t);
    kids.set(pp, [...(kids.get(pp) ?? []), p]);
  }
  if (!times.has(pid)) return null;
  let total = 0;
  const stack = [pid];
  while (stack.length) {
    const p = stack.pop()!;
    total += times.get(p) ?? 0;
    stack.push(...(kids.get(p) ?? []));
  }
  return total;
}

async function clearWedged(root: string, home: string, project: string, a: TeamEntry): Promise<void> {
  await upsertTeamEntry(home, { name: a.name, wedged_at: undefined });
  await appendWatchLog(root, `${new Date().toISOString()} ${project} ${a.name} is moving again; cleared the wedged mark`);
}

// A live pane can still be dead weight: kimi's spinner ticks while it works,
// so a pane frozen on a spinner is suspicious. It is only wedged when nothing
// corroborates life: no CPU advance in the process tree and a stale wire log.
async function judgeWedge(
  root: string,
  project: string,
  home: string,
  a: TeamEntry,
  stills: Stillness,
  stillMs: number,
): Promise<void> {
  const pane = a.pane;
  if (!pane) return;
  const key = `${pane}:${a.pane_pid}`;
  const raw = await capturePane(pane);
  if (raw === null || classify(lines(raw)) !== 'working') {
    stills.delete(key);
    if (a.wedged_at) await clearWedged(root, home, project, a);
    return;
  }
  const seen = stills.get(key);
  if (!seen || seen.content !== raw) {
    const cpu = a.pane_pid ? await treeCpuTime(a.pane_pid) : null;
    stills.set(key, { content: raw, since: Date.now(), cpu });
    if (seen && a.wedged_at) await clearWedged(root, home, project, a);
    return;
  }
  if (Date.now() - seen.since < stillMs) return;
  const cpu = a.pane_pid ? await treeCpuTime(a.pane_pid) : null;
  if (cpu !== null && seen.cpu !== null && cpu > seen.cpu) {
    // The tree burned CPU while the screen sat still: working, not wedged.
    stills.set(key, { content: raw, since: Date.now(), cpu });
    return;
  }
  if (a.session_id) {
    const wireAt = await wireLogMtime(os.homedir(), a.session_id);
    if (wireAt !== null && Date.now() - wireAt < stillMs) return;
  }
  if (a.wedged_at) return;
  await upsertTeamEntry(home, { name: a.name, wedged_at: new Date().toISOString() });
  await appendWatchLog(
    root,
    `${new Date().toISOString()} ${project} ${a.name} looks wedged: pane ${pane} frozen on a spinner for ${Math.round(stillMs / 60_000)}m`,
  );
  const dump = await captureWedgeDump(home, a).catch(() => null);
  await appendWatchLog(root, `${new Date().toISOString()} ${project} ${a.name} stack dump: ${dump ?? 'capture failed'}`);
  if (!a.orchestrator && !a.session_id) {
    await appendDecision(root, {
      project, by: 'watch',
      summary: `marked ${a.name} wedged: frozen pane, no session to resume, stack dump saved, left for the owner`,
    });
    return;
  }
  await appendDecision(root, {
    project, by: 'watch',
    summary: `marked ${a.name} wedged: frozen pane, stale wire log, stack dump saved, restarting it`,
  });
  if (!a.pane_pid || !a.pane_started) {
    await appendWatchLog(root, `${new Date().toISOString()} ${project} ${a.name} has no recorded pane identity; refusing to kill ${pane}`);
    return;
  }
  await killWindow(pane, { pid: a.pane_pid, started: a.pane_started }).catch(async (e: unknown) => {
    await appendWatchLog(root, `${new Date().toISOString()} ${project} killing the wedged pane failed: ${lastLine(e)}`);
  });
  // The death path re-wakes it on the next tick.
}

export async function watchCycle(
  root: string,
  env: NodeJS.ProcessEnv = {},
  deaths: Set<string> = new Set(),
  wakes: WakeState = new Map(),
  stills: Stillness = new Map(),
  { wedgeStillMs = WEDGE_STILL_MS, verdicts = approveCache, marks = inFlightMarks }: {
    wedgeStillMs?: number; verdicts?: Map<string, true>; marks?: Set<string>;
  } = {},
): Promise<void> {
  const pf = await readProjects(root);
  const status = await buildStatus(root);
  for (const p of pf.projects) {
    const proj = status.projects.find((x) => x.name === p.name);
    const team = await readTeam(p.home);
    for (const a of team.agents) {
      if (!a.pane || a.closed_at) continue;
      if (!(await paneExists(a.pane))) {
        await handleDeath(root, p.name, p.home, a, deaths, wakes);
        continue;
      }
      const waiting = a.orchestrator
        ? proj?.orchestrator.operator_waiting === true
        : proj?.agents.some((x) => x.name === a.name && x.worktree === a.worktree && x.operator_waiting) === true;
      if (waiting) {
        stills.delete(`${a.pane}:${a.pane_pid}`);
        if (a.wedged_at) await clearWedged(root, p.home, p.name, a);
        continue;
      }
      await flagStale(root, p.name, a, deaths);
      await judgeWedge(root, p.name, p.home, a, stills, wedgeStillMs);
    }

    const starting = proj?.orchestrator.starting;
    if (proj && starting?.typed === false && starting.question === false && !proj.orchestrator.question) {
      const pending = await readPendingPane(root, p.name);
      if (pending?.typed === false && !hasLiveSendingClaim(pending)) {
        await continueProject(root, p.name).catch(async (e: unknown) => {
          if (!(e instanceof Refusal)) {
            await appendWatchLog(root, `${new Date().toISOString()} ${p.name} continue failed: ${lastLine(e)}`);
          }
        });
      }
    }

    const approvals = p.approvals ?? 'manual';
    if (p.mode !== 'auto' && approvals === 'manual') continue;
    if (!proj) continue;
    const targets: (string | undefined)[] = [];
    const orchDialog = proj.orchestrator.screen_question
      ?? (proj.orchestrator.question === true && proj.orchestrator.operator_question !== true);
    if (orchDialog || proj.orchestrator.starting?.question) targets.push(undefined);
    for (const a of proj.agents) {
      if ((a.screen_question ?? (a.question && !a.operator_question)) && a.ref) targets.push(a.ref);
    }
    for (const ref of targets) {
      const dialog = await readDialogFor(root, p.name, ref).catch((e: unknown) => {
        if (!(e instanceof Refusal)) throw e;
        return null;
      });
      if (!dialog) continue;
      await maybeAutoApprove(root, p.name, ref, dialog, approvals, env, verdicts, marks, p.mode === 'auto');
    }
  }
}

// The watch loop is a foreground process; systemd owns restart-on-death.
// A wedged cycle await is abandoned after cycleTimeoutMs; the loop moves on.
export async function watch(
  root: string,
  { intervalMs = 5000, cycleTimeoutMs = CYCLE_TIMEOUT_MS }: { intervalMs?: number; cycleTimeoutMs?: number } = {},
): Promise<void> {
  const env = await kimiEnv().catch(() => ({} as NodeJS.ProcessEnv));
  const deaths = await loadProcessedKeys(root);
  const wakes: WakeState = new Map();
  const stills: Stillness = new Map();
  let cycles = 0;
  for (;;) {
    await withTimeout(watchCycle(root, env, deaths, wakes, stills), cycleTimeoutMs, 'watch cycle').catch(async (e: unknown) => {
      await appendWatchLog(root, `${new Date().toISOString()} cycle error: ${lastLine(e)}`);
    });
    cycles += 1;
    // The heartbeat: a stale status file means the watch itself is wedged.
    await writeJson(hubPath(root, 'watch-status.json'), { ts: new Date().toISOString(), cycles }).catch(() => {});
    await sleep(intervalMs);
  }
}
