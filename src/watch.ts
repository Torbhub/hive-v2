import { promises as fs } from 'node:fs';
import { captureDeathBundle } from './death-bundle.js';
import { answerDialog, buildStatus, readDialogFor, Refusal, wake } from './hub.js';
import { wakeAgent } from './spawn.js';
import { appendDecision, hubPath, readProjects, readTeam } from './state.js';
import { paneExists, run, sleep } from './tmux.js';
import { lastLine, withTimeout } from './view.js';
import type { Approvals, TeamEntry } from './types.js';

// Read-only leaders: a chain segment must start with one of these to be
// auto-approvable. Multi-word leaders match the subcommand, not just `git`.
const SAFE_LEADERS = [
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'pwd', 'echo', 'wc', 'tsc',
  'git status', 'git log', 'git diff', 'git show', 'git branch',
  'hive hub status', 'hive hub tasks', 'hive hub dialog',
  'npm test', 'npm run build',
];

// Destructive shapes are never auto-approved, by either tier.
const NEVER_RES = [
  /\brm\s/, /git\s+push/, /git\s+reset/, /\bsudo\b/, /\bdd\s/, /\bmkfs\b/,
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

// Desired vs actual, re-judged every tick: a death is logged and bundled once,
// but the wake is retried until the pane is back or the attempts run out.
async function handleDeath(
  root: string,
  project: string,
  a: TeamEntry,
  deaths: Set<string>,
  wakes: Map<string, number>,
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
  const attempt = (wakes.get(key) ?? 0) + 1;
  if (attempt > WAKE_MAX_ATTEMPTS) return;
  wakes.set(key, attempt);
  if (attempt === 1) {
    await appendDecision(root, {
      project, by: 'watch',
      summary: a.orchestrator
        ? `woke the orchestrator after pane ${a.pane} died`
        : `woke ${a.name} after pane ${a.pane} died`,
    });
  }
  try {
    const pane = a.orchestrator ? await wake(root, project) : await wakeAgent(root, project, a.name);
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

export async function watchCycle(
  root: string,
  env: NodeJS.ProcessEnv = {},
  deaths: Set<string> = new Set(),
  wakes: Map<string, number> = new Map(),
): Promise<void> {
  const pf = await readProjects(root);
  const status = await buildStatus(root);
  for (const p of pf.projects) {
    const team = await readTeam(p.home);
    for (const a of team.agents) {
      if (!a.pane || a.closed_at || (await paneExists(a.pane))) continue;
      await handleDeath(root, p.name, a, deaths, wakes);
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
  const wakes = new Map<string, number>();
  for (;;) {
    await withTimeout(watchCycle(root, env, deaths, wakes), cycleTimeoutMs, 'watch cycle').catch(async (e: unknown) => {
      await appendWatchLog(root, `${new Date().toISOString()} cycle error: ${lastLine(e)}`);
    });
    await sleep(intervalMs);
  }
}
