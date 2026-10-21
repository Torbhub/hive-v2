import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { run } from './tmux.js';

const STEP_NAME_RE = /^(?!.*\.\.)[A-Za-z0-9_.-]+$/;
const HEADER_RE = /^# hive-gate steps: ([,A-Za-z0-9_.-]+) head=([0-9a-f]{40}|none) dirty=([01])$/;
const STEP_LINE_RE = /^[A-Za-z0-9_.-]+ exit [0-9]+$/;
const TEST_STEP_RE = /^test/;
const VITEST_TESTS_RE = /^\s*Tests\s+(.+)$/m;
const VITEST_ERRORS_RE = /^\s*Errors\s+(\d+) error/m;
const CONVENTIONAL_RE = /^(feat|fix|refactor|docs|style|test|chore|perf)(\([a-z0-9-]+\))?: .+/;
const ATTRIBUTION_RE = /^\s*(co-authored-by|claude-session)\s*:|generated with \[?claude code/i;

export type GateStep = { name: string; cmd: string };

export function parseSteps(args: string[]): GateStep[] {
  if (args.length === 0 || args.length % 2 !== 0) throw new Error('steps come in <name> <command> pairs');
  const seen = new Set<string>();
  const steps: GateStep[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const [name, cmd] = [args[i], args[i + 1]];
    if (!STEP_NAME_RE.test(name)) throw new Error(`a step name is letters, digits, '_', '.' and '-' with no '..': ${name}`);
    if (seen.has(name)) throw new Error(`a step name is given twice: ${name}`);
    seen.add(name);
    steps.push({ name, cmd });
  }
  return steps;
}

async function gitTracked(file: string, cwd: string): Promise<boolean> {
  const r = await run('git', ['ls-files', '--error-unmatch', '--', file], cwd);
  return r.code === 0;
}

// Each step runs in its own process group so an interrupt writes no line for it — a partial gate is detectably partial.
function runStep(cmd: string, cwd: string, out: fs.FileHandle): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', cmd], { cwd, detached: true, stdio: ['ignore', out.fd, out.fd] });
    const pid = child.pid;
    let done = false;
    const onSig = () => {
      if (pid) {
        try {
          process.kill(-pid, 'SIGTERM');
        } catch { /* already gone */ }
      }
      if (!done) {
        done = true;
        resolve(null);
      }
    };
    process.once('SIGINT', onSig);
    process.once('SIGTERM', onSig);
    child.on('close', (code) => {
      process.removeListener('SIGINT', onSig);
      process.removeListener('SIGTERM', onSig);
      if (!done) {
        done = true;
        resolve(code ?? 1);
      }
    });
  });
}

export async function runGate(logPath: string, steps: GateStep[], cwd: string): Promise<number> {
  const logDir = path.dirname(logPath);
  const st = await fs.stat(logDir).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`the gate log cannot be written: ${logPath}`);
  // A git-tracked log is refused: its change would go unseen by the dirty check below.
  if (await gitTracked(logPath, cwd)) throw new Error(`the gate log may not be a file git tracks: ${logPath}`);
  if (await gitTracked(`${logPath}.d`, cwd)) throw new Error(`the gate log may not be a file git tracks: ${logPath}.d`);

  const headR = await run('git', ['rev-parse', '--verify', '-q', 'HEAD'], cwd);
  const head = headR.code === 0 ? headR.stdout.trim() : 'none';
  let dirty = 0;
  if (head !== 'none') {
    const top = (await run('git', ['rev-parse', '--show-toplevel'], cwd)).stdout.trim();
    const rel = path.relative(top, path.resolve(cwd, logPath));
    const status = await run('git', ['status', '--porcelain'], cwd);
    const lines = status.stdout.split('\n').filter((l) => l.trim());
    dirty = lines.some((l) => {
      const p = l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop() ?? '';
      return p !== rel && !p.startsWith(`${rel}.d/`) && p !== `${rel}.d`;
    }) ? 1 : 0;
  }
  if (dirty) {
    process.stderr.write('hive: the tree has uncommitted changes, so this log will vouch for no commit; commit first, then run the gate on the tip\n');
  }

  await fs.rm(`${logPath}.d`, { recursive: true, force: true });
  await fs.mkdir(`${logPath}.d`, { recursive: true });
  const log = await fs.open(logPath, 'w');
  await log.write(`# hive-gate steps: ${steps.map((s) => s.name).join(',')} head=${head} dirty=${dirty}\n`);
  let status = 0;
  for (const step of steps) {
    const out = await fs.open(path.join(`${logPath}.d`, `${step.name}.log`), 'a');
    const rc = await runStep(step.cmd, cwd, out);
    await out.close();
    if (rc === null) {
      await log.close();
      process.exit(130);
    }
    await log.write(`${step.name} exit ${rc}\n`);
    if (rc !== 0) status = 1;
  }
  await log.close();
  return status;
}

export type VerifyLogResult = { green: boolean; out: string; note?: string };

// Exit 0 is not evidence: a test step must show passed > 0, zero failed, and
// zero errors in the vitest summary of its own output log.
async function vacuity(file: string, name: string): Promise<string | null> {
  const stepLog = path.join(`${file}.d`, `${name}.log`);
  const out = await fs.readFile(stepLog, 'utf8').catch(() => '');
  if (!out) return `no step output at ${stepLog}`;
  const tests = out.match(VITEST_TESTS_RE)?.[1] ?? '';
  const passed = Number(tests.match(/(\d+) passed/)?.[1] ?? 0);
  const failed = Number(tests.match(/(\d+) failed/)?.[1] ?? 0);
  const errors = Number(out.match(VITEST_ERRORS_RE)?.[1] ?? 0);
  if (passed === 0) return 'zero passing tests — the step evidences nothing';
  if (failed > 0) return `${failed} failed test(s) in the summary — the exit code was masked`;
  if (errors > 0) return `${errors} error(s) — tests did not run to a verdict`;
  return null;
}

export async function verifyLog(
  file: string,
  { expect = [], commit = '' }: { expect?: string[]; commit?: string } = {},
  cwd = process.cwd(),
): Promise<VerifyLogResult> {
  for (const n of expect) {
    if (!STEP_NAME_RE.test(n)) throw new Error(`an expected name is a step name: ${n}`);
  }
  if (commit.startsWith('-')) throw new Error(`a commit may not start with '-': ${commit}`);
  const content = await fs.readFile(file, 'utf8').catch(() => '');
  if (!content) return { green: false, out: `RED: no gate log at ${file}` };

  const header = content.split('\n')[0];
  const hm = header.match(HEADER_RE);
  let names: string[] = [];
  let hhead = '';
  let hdirty = '';
  if (hm) {
    names = hm[1].split(',');
    hhead = hm[2];
    hdirty = hm[3];
  } else if (expect.length === 0) {
    return { green: false, out: `RED: ${file} has no hive-gate header; name the steps it must hold with --expect` };
  }
  names = [...names, ...expect];

  const stepLines = content.split('\n').filter((l) => STEP_LINE_RE.test(l));
  if (stepLines.length === 0) return { green: false, out: `RED: no steps in ${file}` };

  const red = stepLines.filter((l) => !l.endsWith(' exit 0'));
  const counts = new Map<string, number>();
  for (const l of stepLines) counts.set(l.split(' ')[0], (counts.get(l.split(' ')[0]) ?? 0) + 1);
  const twice = [...counts].filter(([, n]) => n > 1).map(([n]) => n);
  const present = new Set(stepLines.map((l) => l.split(' ')[0]));
  const missing = names.filter((n) => !present.has(n));

  const vacuous: string[] = [];
  for (const l of stepLines) {
    const name = l.split(' ')[0];
    if (l.endsWith(' exit 0') && TEST_STEP_RE.test(name)) {
      const why = await vacuity(file, name);
      if (why) vacuous.push(`${name}: ${why}`);
    }
  }

  let reasons = '';
  if (commit) {
    const shaR = await run('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', `${commit}^{commit}`], cwd);
    if (shaR.code !== 0) throw new Error(`unknown commit: ${commit}`);
    const sha = shaR.stdout.trim();
    if (!hhead) reasons = 'a log with no hive-gate header vouches for no commit';
    else if (hhead !== sha) reasons = `the gate ran on ${hhead}, not ${sha}`;
    else if (hdirty === '1') reasons = 'the gate ran on a dirty tree, so it vouches for no commit';
  }

  if (red.length || missing.length || twice.length || vacuous.length || reasons) {
    const out = ['RED:'];
    if (red.length) out.push(...red);
    if (missing.length) out.push(`missing: ${missing.join(' ')}`);
    if (twice.length) out.push(`twice: ${twice.join(' ')}`);
    if (vacuous.length) out.push(...vacuous);
    if (reasons) out.push(reasons);
    return { green: false, out: out.join('\n') };
  }

  let note: string | undefined;
  if (!commit && hhead) {
    note = hdirty === '1'
      ? `note: this gate ran on a dirty tree (head ${hhead}), so it vouches for no commit; commit, gate the tip, and verify with --commit <tip>`
      : 'note: not checked against a commit; verify with --commit <tip> before reporting it';
  }
  return { green: true, out: `GREEN (${stepLines.length} steps)`, note };
}

export type VerifyCommitsOptions = {
  maxFiles: number; style: 'conventional' | 'free'; attribution: 'allow' | 'deny'; noBody?: boolean;
};

export async function verifyCommits(
  range: string,
  opts: VerifyCommitsOptions,
  cwd = process.cwd(),
): Promise<{ green: boolean; out: string }> {
  const parts = range.split('..');
  if (range.startsWith('-') || range.includes('...') || parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`not a range: ${range}`);
  }
  const [base, tip] = parts;
  const baseR = await run('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', `${base}^{commit}`], cwd);
  if (baseR.code !== 0) throw new Error(`unknown base: ${base}`);
  const tipR = await run('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', `${tip}^{commit}`], cwd);
  if (tipR.code !== 0) throw new Error(`unknown tip: ${tip}`);

  const list = await run('git', ['rev-list', '--reverse', '--end-of-options', `${base}..${tip}`], cwd);
  const commits = list.stdout.split('\n').filter((l) => l.trim());
  if (commits.length === 0) return { green: false, out: `RED: no commits in ${range}` };

  const problems: string[] = [];
  for (const c of commits) {
    const short = (await run('git', ['rev-parse', '--short', c], cwd)).stdout.trim();
    const msg = (await run('git', ['log', '-1', '--format=%B', c], cwd)).stdout.replace(/\n$/, '');
    const subject = msg.split('\n')[0] ?? '';
    const body = msg.split('\n').slice(1).filter((l) => l.trim()).join('\n');
    if (!subject.trim()) problems.push(`${short} subject: empty`);
    if (opts.style === 'conventional' && !CONVENTIONAL_RE.test(subject)) {
      problems.push(`${short} subject: not conventional: ${subject}`);
    }
    // A merge counts only its own content: the files where it differs from the merge git itself computes.
    const parents = (await run('git', ['rev-list', '--parents', '-n', '1', c], cwd)).stdout.trim().split(/\s+/).length - 1;
    let files: number;
    if (parents <= 1) {
      const d = await run('git', ['diff-tree', '-r', '--root', '--no-commit-id', '--name-only', '-m', '--first-parent', c], cwd);
      files = d.stdout.split('\n').filter((l) => l.trim()).length;
    } else if (parents === 2) {
      const merged = (await run('git', ['merge-tree', '--write-tree', `${c}^1`, `${c}^2`], cwd)).stdout.split('\n')[0];
      if (/^[0-9a-f]{40,64}$/.test(merged)) {
        const d = await run('git', ['diff', '--name-only', merged, c], cwd);
        files = d.stdout.split('\n').filter((l) => l.trim()).length;
      } else {
        const d = await run('git', ['diff-tree', '-r', '--cc', '--no-commit-id', '--name-only', c], cwd);
        files = d.stdout.split('\n').filter((l) => l.trim()).length;
      }
    } else {
      const d = await run('git', ['diff-tree', '-r', '--cc', '--no-commit-id', '--name-only', c], cwd);
      files = d.stdout.split('\n').filter((l) => l.trim()).length;
    }
    if (files > opts.maxFiles) problems.push(`${short} files: ${files}, more than ${opts.maxFiles}`);
    if (opts.attribution === 'deny' && msg.split('\n').some((l) => ATTRIBUTION_RE.test(l))) {
      problems.push(`${short} attribution: an attribution line is not allowed`);
    }
    if (body.trim()) {
      if (opts.noBody) problems.push(`${short} body: a body is not allowed`);
      else problems.push(`WARN ${short} body: the commit has a body`);
    }
  }
  const bad = problems.some((p) => !p.startsWith('WARN'));
  const out = [...problems, bad ? '' : `OK (${commits.length} commits)`].filter(Boolean).join('\n');
  return { green: !bad, out };
}

export async function pushByHash(remote: string, sha: string, branch: string, cwd: string): Promise<void> {
  if (remote.startsWith('-')) throw new Error(`a remote may not start with '-': ${remote}`);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`push is by full 40-char hash: ${sha}`);
  if (branch.startsWith('-')) throw new Error(`a branch may not start with '-': ${branch}`);
  const ok = await run('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', `${sha}^{commit}`], cwd);
  if (ok.code !== 0) throw new Error(`unknown commit: ${sha}`);
  const remoteTip = await run('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/remotes/${remote}/${branch}`], cwd);
  if (remoteTip.code === 0) {
    const anc = await run('git', ['merge-base', '--is-ancestor', remoteTip.stdout.trim(), sha], cwd);
    if (anc.code !== 0) throw new Error(`${remote}/${branch} is not an ancestor of ${sha}; a push would not be fast-forward`);
  }
  const pushed = await run('git', ['push', remote, `${sha}:refs/heads/${branch}`], cwd);
  if (pushed.code !== 0) throw new Error(pushed.stderr.trim() || 'git push failed');
}
