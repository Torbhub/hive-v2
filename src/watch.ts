import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { captureDeathBundle, wireLogMtime } from './death-bundle.js';
import { answerDialog, buildStatus, readDialogFor, Refusal, wake } from './hub.js';
import { wakeAgent } from './spawn.js';
import { classify, lines } from './screen.js';
import { appendDecision, hivePath, hubPath, readProjects, readTeam, upsertTeamEntry, writeJson } from './state.js';
import { capturePane, killWindow, paneExists, run, sleep } from './tmux.js';
import { lastLine, withTimeout } from './view.js';
import type { Approvals, TeamEntry } from './types.js';

// Read-only leaders: a chain segment must start with one of these to be
// auto-approvable. Multi-word leaders match the subcommand, not just `git`.
const SAFE_LEADERS = [
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'pwd', 'echo', 'wc', 'tsc',
  'git status', 'git log', 'git diff', 'git show', 'git branch',
  'jj st', 'jj status', 'jj log', 'jj diff', 'jj show',
  'jj bookmark list', 'jj git root', 'jj root',
  'hive hub status', 'hive hub tasks', 'hive hub dialog',
  'npm test', 'npm run build',
];

// Destructive shapes are never auto-approved, by either tier.
const NEVER_RES = [
  /\brm\s/, /git\s+push/, /git\s+reset/, /\bsudo\b/, /\bdd\s/, /\bmkfs\b/,
  /\bjj\s+push\b/, /\bjj\s+abandon\b/, /jj\s+workspace\s+forget/,
  /chmod\s+-R/, /(?:curl|wget)[^|]*\|\s*(?:ba|z)?sh\b/, />\s*\/(etc|usr|bin|sbin|var|boot|lib)(\/|\s|$)/,
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
  const r = await run(
    'kimi', ['-p', prompt], undefined,
    { ...process.env, ...env, KIMI_CODE_NO_AUTO_UPDATE: '1' },
    CLASSIFY_TIMEOUT_MS,
  );
  return r.code === 0 && r.stdout.trimStart().startsWith('APPROVE');
}

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
): Promise<void> {
  const command = extractCommand(dialog.text);
  if (!command || neverApprove(dialog.text)) return;
  let ok = tier1Approves(command);
  if (!ok && approvals === 'smart') ok = await classifyWithKimi(project, command, env);
  if (!ok) return;
  // Only ever option 1 ("Approve once"); a saves-rule option is the owner's call.
  const opt = dialog.options.find((o) => o.n === 1);
  if (!opt || !opt.offered || opt.saves_rule) return;
  await answerDialog(root, project, agentRef, '1', dialog.fingerprint);
  await appendDecision(root, {
    project, by: 'watch', summary: `auto-approved "${opt.label}" for: $ ${command}`,
  });
}

export const WAKE_MAX_ATTEMPTS = 60;
export const WEDGE_STILL_MS = 10 * 60_000;
const WEDGE_DUMP_TIMEOUT_MS = 15_000;

export type WakeState = Map<string, { attempts: number; nextAt: number }>;

// Desired vs actual, re-judged every tick: a death is logged and bundled once,
// but the wake is retried with backoff until the pane is back or the budget
// runs out (60 attempts at a capped 10-minute backoff span hours of outage).
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
    // wake() can return a pane it never registered (waitIdle timed out before
    // the pickup line landed). Only a team entry pointing at the new pane
    // counts as a resurrection; anything else is a failed attempt.
    const entry = (await readTeam(home)).agents.find((x) => x.name === a.name);
    if (entry?.pane !== pane) {
      throw new Error(`wake returned ${pane} but the team entry still points at ${entry?.pane ?? 'nothing'}`);
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
  { wedgeStillMs = WEDGE_STILL_MS }: { wedgeStillMs?: number } = {},
): Promise<void> {
  const pf = await readProjects(root);
  const status = await buildStatus(root);
  for (const p of pf.projects) {
    const team = await readTeam(p.home);
    for (const a of team.agents) {
      if (!a.pane || a.closed_at) continue;
      if (!(await paneExists(a.pane))) {
        await handleDeath(root, p.name, p.home, a, deaths, wakes);
        continue;
      }
      await judgeWedge(root, p.name, p.home, a, stills, wedgeStillMs);
    }

    const approvals = p.approvals ?? 'manual';
    if (approvals === 'manual') continue;
    const proj = status.projects.find((x) => x.name === p.name);
    if (!proj) continue;
    const targets: (string | undefined)[] = [];
    if (proj.orchestrator.question || proj.orchestrator.starting?.question) targets.push(undefined);
    for (const a of proj.agents) {
      if (a.question && a.ref) targets.push(a.ref);
    }
    for (const ref of targets) {
      const dialog = await readDialogFor(root, p.name, ref).catch((e: unknown) => {
        if (!(e instanceof Refusal)) throw e;
        return null;
      });
      if (!dialog) continue;
      await maybeAutoApprove(root, p.name, ref, dialog, approvals, env);
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
  const deaths = new Set<string>();
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
