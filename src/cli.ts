#!/usr/bin/env node
import {
  answerDialog, buildStatus, continueProject, hubAdd, hubInit, hubLog, hubTask,
  listTasks, planAnswer, readDialogFor, startProject, wake,
} from './hub.js';
import { closeAgent, respawnAgent, spawnAgent } from './spawn.js';
import { landPr, parseSteps, pushByHash, runGate, verifyCommits, verifyLog } from './gate.js';
import { cleanupProject } from './cleanup.js';
import { checkName } from './names.js';

function validName(kind: string, value: string): string {
  try {
    return checkName(kind, value);
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
}

// The @worktree suffix is a display disambiguator matched against recorded
// team entries; only the name part needs the name rules.
function validAgentRef(value: string): string {
  validName('agent', value.split('@')[0]);
  return value;
}

const USAGE = `usage:
  hive hub init|add <name> <path>|status [--json]|tasks [--json]|task <project> <text>|log <id> <event> [note]
  hive hub dialog <project> [agent] | answer <project> [agent] --choice <n|esc> --seen <sha1>
  hive hub wake <project> | start <project> <task-id> | continue <project>
  hive spawn <project> --agent <name> [--role r] [--worktree wt] [--task id] [--model m] | respawn | close
  hive gate --log <path> -- <name> <cmd>...
  hive gate-verify log <path> [--expect a,b] [--commit sha] | gate-verify commits <base>..<tip> --max-files <n> --style conventional|free --attribution allow|deny [--no-body]
  hive push <remote> <sha> <branch>
  hive land <remote> <sha> <branch> [--title t] [--body b] | --bookmark <name> [--title t] [--body b]
  hive cleanup <project> [--dry-run]
  hive doctor
  hive ui
  hive web [--port N]
  hive watch`;

class UsageError extends Error {}

const VALUELESS_FLAGS = new Set(['json', 'dry-run', 'no-body']);

function parseFlags(args: string[], names: string[]): { flags: Record<string, string | true>; pos: string[] } {
  const out: Record<string, string | true> = {};
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (!names.includes(key)) throw new UsageError(`unknown flag: ${a}`);
      if (VALUELESS_FLAGS.has(key)) {
        out[key] = true;
      } else {
        const v = args[i + 1];
        if (v === undefined || v.startsWith('--')) throw new UsageError(`--${key} needs a value`);
        out[key] = v;
        i++;
      }
    } else {
      pos.push(a);
    }
  }
  return { flags: out, pos };
}

function fail(msg: string): never {
  throw new UsageError(msg);
}

function str(v: string | true | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

async function hubCommand(args: string[]): Promise<void> {
  const root = process.cwd();
  const sub = args[0] ?? fail('hub needs a subcommand');
  switch (sub) {
    case 'init': {
      await hubInit(root, args[1]);
      console.log(`hive: hub recorded at ${root}/.hive-hub`);
      return;
    }
    case 'add': {
      const [name, folder] = [args[1], args[2]];
      if (!name || !folder) throw new UsageError('usage: hive hub add <name> <path>');
      await hubAdd(root, validName('project', name), folder);
      console.log(`hive: project ${name} added (${folder})`);
      return;
    }
    case 'status': {
      const status = await buildStatus(root);
      if (args.includes('--json')) console.log(JSON.stringify(status, null, 2));
      else {
        console.log(`hub: ${status.hub.name ?? '(not recorded)'} @ ${status.hub.root}`);
        for (const p of status.projects) {
          console.log(`${p.name}: orchestrator ${p.orchestrator.state}, ${p.agents.length} agents, ${p.open_tasks} open tasks`);
        }
      }
      return;
    }
    case 'tasks': {
      const tasks = await listTasks(root);
      if (args.includes('--json')) console.log(JSON.stringify(tasks, null, 2));
      else for (const t of tasks) console.log(`${t.id} ${t.state}${t.needs_owner ? ' (needs you)' : ''} ${t.last_note ?? ''}`);
      return;
    }
    case 'task': {
      const [project, ...text] = args.slice(1);
      if (!project || text.length === 0) throw new UsageError('usage: hive hub task <project> <text>');
      const id = await hubTask(root, validName('project', project), text.join(' '));
      console.log(id);
      return;
    }
    case 'log': {
      const [id, event, ...note] = args.slice(1);
      if (!id || !event) throw new UsageError('usage: hive hub log <id> <event> [note]');
      await hubLog(root, id, event, note.length ? note.join(' ') : undefined);
      return;
    }
    case 'dialog': {
      const [, project, agent] = args;
      if (!project) throw new UsageError('usage: hive hub dialog <project> [agent]');
      const dialog = await readDialogFor(root, validName('project', project), agent && validAgentRef(agent));
      if (!dialog) process.exit(3);
      console.log(JSON.stringify(dialog, null, 2));
      return;
    }
    case 'answer': {
      const { flags: f, pos } = parseFlags(args.slice(1), ['choice', 'seen']);
      const [project, agent] = pos;
      if (!project || typeof f.choice !== 'string' || typeof f.seen !== 'string') throw new UsageError('usage: hive hub answer <project> [agent] --choice <n|esc> --seen <sha1>');
      const result = await answerDialog(root, validName('project', project), agent && validAgentRef(agent), f.choice, f.seen);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case 'plan-answer': {
      const [, project, task, verdict, ...fb] = args;
      if (!project || !task || !verdict) throw new UsageError('usage: hive hub plan-answer <project> <task> <approve|sendback> [feedback]');
      const r = await planAnswer(root, validName('project', project), task, verdict, fb.length ? fb.join(' ') : undefined);
      console.log(`hive: typed into ${project}'s orchestrator: ${r.typed}`);
      return;
    }
    case 'wake': {
      if (!args[1]) throw new UsageError('usage: hive hub wake <project>');
      console.log(await wake(root, validName('project', args[1])));
      return;
    }
    case 'start': {
      if (!args[1] || !args[2]) throw new UsageError('usage: hive hub start <project> <task-id>');
      console.log(await startProject(root, validName('project', args[1]), args[2]));
      return;
    }
    case 'continue': {
      if (!args[1]) throw new UsageError('usage: hive hub continue <project>');
      console.log(await continueProject(root, validName('project', args[1])));
      return;
    }
    default:
      throw new UsageError(`unknown hub subcommand: ${sub}`);
  }
}

async function spawnCommand(args: string[]): Promise<void> {
  const root = process.cwd();
  let sub: 'spawn' | 'respawn' | 'close' = 'spawn';
  let rest = args;
  if (args[0] === 'respawn' || args[0] === 'close') {
    sub = args[0];
    rest = args.slice(1);
  }
  const { flags: f, pos } = parseFlags(rest, ['agent', 'role', 'worktree', 'task', 'model']);
  const project = pos[0] && validName('project', pos[0]);
  const agent = typeof f.agent === 'string' ? validName('agent', f.agent) : f.agent;
  if (!project || typeof agent !== 'string') {
    throw new UsageError('usage: hive spawn [respawn|close] <project> --agent <name> [--role r] [--worktree wt] [--task id] [--model m]');
  }
  if (sub !== 'spawn' && f.task !== undefined) throw new UsageError('--task only applies to spawn');
  if (sub === 'close') {
    await closeAgent(root, project, agent);
    console.log(`hive: ${project}/${agent} closed`);
    return;
  }
  if (sub === 'respawn' && f.model !== undefined) {
    throw new UsageError('respawn reuses the model recorded in team.json; change it with close + spawn or by editing team.json');
  }
  const pane = sub === 'respawn'
    ? await respawnAgent(root, project, agent)
    : await spawnAgent(root, project, { agent, role: str(f.role), worktree: str(f.worktree), task: str(f.task), model: str(f.model) });
  console.log(pane);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? fail('no command');
  switch (cmd) {
    case 'hub':
      await hubCommand(args.slice(1));
      return;
    case 'spawn':
      await spawnCommand(args.slice(1));
      return;
    case 'gate': {
      const sep = args.indexOf('--');
      const { flags: f } = parseFlags(args.slice(1, sep === -1 ? undefined : sep), ['log']);
      if (sep === -1 || typeof f.log !== 'string') throw new UsageError('usage: hive gate --log <path> -- <name> <cmd>...');
      const steps = parseSteps(args.slice(sep + 1));
      process.exit(await runGate(f.log, steps, process.cwd()));
    }
    case 'gate-verify': {
      const sub = args[1] ?? fail('gate-verify needs log|commits');
      if (sub === 'log') {
        const { flags: f, pos } = parseFlags(args.slice(2), ['expect', 'commit']);
        const file = pos[0];
        if (!file) throw new UsageError('usage: hive gate-verify log <path> [--expect a,b] [--commit sha]');
        const result = await verifyLog(file, { expect: str(f.expect)?.split(',') ?? [], commit: str(f.commit) ?? '' });
        console.log(result.out);
        if (result.note) process.stderr.write(result.note + '\n');
        process.exit(result.green ? 0 : 1);
      }
      if (sub === 'commits') {
        const { flags: f, pos } = parseFlags(args.slice(2), ['max-files', 'style', 'attribution', 'no-body']);
        const range = pos[0];
        if (!range || typeof f['max-files'] !== 'string' || typeof f.style !== 'string' || typeof f.attribution !== 'string') {
          throw new UsageError('usage: hive gate-verify commits <base>..<tip> --max-files <n> --style conventional|free --attribution allow|deny [--no-body]');
        }
        if (f.style !== 'conventional' && f.style !== 'free') throw new UsageError('--style is conventional|free');
        if (f.attribution !== 'allow' && f.attribution !== 'deny') throw new UsageError('--attribution is allow|deny');
        const maxFiles = Number(f['max-files']);
        if (!Number.isInteger(maxFiles) || maxFiles < 0) throw new UsageError('--max-files is a non-negative integer');
        const result = await verifyCommits(range, { maxFiles, style: f.style, attribution: f.attribution, noBody: f['no-body'] === true });
        console.log(result.out);
        process.exit(result.green ? 0 : 1);
      }
      throw new UsageError(`unknown gate-verify subcommand: ${sub}`);
    }
    case 'push': {
      const [, remote, sha, branch] = args;
      if (!remote || !sha || !branch) throw new UsageError('usage: hive push <remote> <sha> <branch>');
      await pushByHash(remote, sha, branch, process.cwd());
      console.log(`hive: pushed ${sha} to ${remote}/${branch}`);
      return;
    }
    case 'land': {
      const { flags: f, pos } = parseFlags(args.slice(1), ['title', 'body', 'bookmark']);
      const [remote, sha, branch] = pos;
      if (f.bookmark !== undefined ? pos.length > 0 : !remote || !sha || !branch) {
        throw new UsageError('usage: hive land <remote> <sha> <branch> [--title t] [--body b] | --bookmark <name> [--title t] [--body b]');
      }
      console.log(await landPr({ remote, sha, branch, bookmark: str(f.bookmark), title: str(f.title), body: str(f.body) }, process.cwd()));
      return;
    }
    case 'cleanup': {
      const project = args[1];
      if (!project) throw new UsageError('usage: hive cleanup <project> [--dry-run]');
      const dryRun = args.includes('--dry-run');
      const actions = await cleanupProject(process.cwd(), validName('project', project), { dryRun });
      if (actions.length === 0) console.log(`hive: nothing to clean for ${project}`);
      for (const a of actions) console.log(`${dryRun ? 'would ' : ''}${a.action}`);
      return;
    }
    case 'doctor': {
      const { doctor } = await import('./doctor.js');
      process.exit(await doctor(process.cwd()));
    }
    case 'ui': {
      const { render } = await import('ink');
      const { createElement } = await import('react');
      const { HubApp } = await import('./ui/HubApp.js');
      render(createElement(HubApp, { root: process.cwd() }));
      return;
    }
    case 'watch': {
      const { watch } = await import('./watch.js');
      console.log(`hive: watching ${process.cwd()} (deaths + approvals per projects.json)`);
      await watch(process.cwd());
      return;
    }
    case 'web': {
      const { flags: f } = parseFlags(args.slice(1), ['port']);
      const raw = typeof f.port === 'string' ? f.port : process.env.HIVE_WEB_PORT ?? '7684';
      const port = Number(raw);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError(`a port is 1-65535: ${raw}`);
      const { listen } = await import('../web/server.js');
      await listen(process.cwd(), port);
      console.log(`hive: hub web on http://127.0.0.1:${port} (root ${process.cwd()})`);
      return;
    }
    default:
      throw new UsageError(`unknown command: ${cmd}`);
  }
}

main().catch((err: unknown) => {
  if (err instanceof UsageError) {
    console.error(`hive: ${err.message}`);
    console.error(USAGE);
    process.exit(64);
  }
  console.error(`hive: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
