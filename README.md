# hive-v2

hive-v2 runs a software task with a team of Kimi Code sessions in tmux: an
orchestrator per project, the agents the task needs, a gate before anything
lands, and a hub screen that shows what waits on you. Every session runs
through the teamkimi proxy.

## Install

```bash
npm install
npm run build
npm link        # puts `hive` on your PATH
```

Needs: Node 20+, tmux, git, the kimi CLI, and a running teamkimi proxy
(`teamkimi server`). hive spawns nothing when the proxy is down.

## The commands that matter

```bash
hive hub init                     # record this folder as your hub root
hive hub add demo ~/src/demo      # a project = a name + a folder with a git repo
hive hub task demo "add a /health endpoint"
hive ui                           # the hub screen: what waits on you
hive hub start demo demo-1        # bring the orchestrator up on a task
hive gate --log g.log -- build "npm run build" test "npm test"
```

Everything else (`wake`, `continue`, `dialog`, `answer`, `spawn`, `cleanup`,
`push`, `gate-verify`) is one `--help`-less usage line away: run `hive` with
no arguments.

## The web screen

`hive web` serves the same hub screen in a browser: `http://127.0.0.1:7684`
(port from `--port N` or `HIVE_WEB_PORT`, loopback only). It reads and acts
exactly like the Ink screen — same view assembly, same fingerprint-checked
dialog answers, one action at a time. It is a plain foreground process, so a
systemd unit is one `ExecStart=/path/to/hive web` line away. Set
`HIVE_WEB_SECRET` to require that value in an `x-hive-auth` header on every
request (unset = open on loopback, for development). The screen also creates
tasks, starts teams, and sets a project's permission mode (`ask`/`yolo`/`auto`
— passed to kimi as nothing/`-y`/`--auto` on the next launch, resume included).

## The watchdog

`hive watch` is a foreground daemon (one systemd unit:
`ExecStart=/path/to/hive watch`, run from the hub root): every 5s it logs
dead panes to `.hive-hub/watch.log` with timestamps and re-wakes a dead
orchestrator by session id, and it auto-answers permission dialogs per the
project's `approvals` setting (`manual`/`safe`/`smart`). `safe` approves only
deterministic read-only commands (a whitelist over every segment of a
`&&`/`;`/`|` chain; destructive patterns like `rm`, `git push`, `sudo`,
curl-pipe-shell, or redirects into system paths are never approved). `smart`
adds a fresh-context `kimi -p` classifier for unknown commands (60s timeout;
only a reply starting with APPROVE counts). It only ever picks option 1,
"Approve once" — never a saves-rule option. Every wake and auto-answer lands
in `.hive-hub/decisions.jsonl` with `by:"watch"`, as do owner answers
(`by:"owner"`) and `hive hub log <id> decided <reason>` (`by:"orchestrator"`);
the web screen shows the latest eight under DECISIONS.
`test/watch-e2e.test.ts` proves the smart tier end to end: a decoy tmux pane
plays a fake approval dialog, and the real watch cycle detects it, calls the
classifier (a stub `kimi` on PATH), and answers the pane or correctly holds
back.

## How a task flows

1. You record a task: `hive hub task demo "..."`. It lands in the ledger
   (`.hive-hub/tasks.jsonl`) in state `asked`.
2. You start the team: `hive hub start demo demo-1`. hive opens a tmux window
   (`demo:demo-orchestrator` in the `hive` tmux session), waits for kimi to go
   idle, and types the pickup line: who it is, where its handoff is, where the
   task file is.

All hive tmux windows live on a **private tmux server socket** (`tmux -L
hive-v2`), never on the default socket — your own tmux sessions are invisible
to hive and hive's kills and keystrokes cannot reach them. To watch an agent
yourself:

```bash
tmux -L hive-v2 attach
```
3. The orchestrator plans, asks, and spawns agents (`hive spawn`). Every state
   change is a ledger event: `plan`, `question`, `blocked`, `done`.
4. The hub screen (`hive ui`) is where you see all of it: tasks that need you,
   dialogs waiting on any agent's screen (answerable from the screen, with a
   fingerprint check so a changed dialog is never blindly answered), context
   percentages, and one-key refresh.
5. Before anything lands: the gate. `hive gate` runs the steps and logs every
   exit code; `hive gate-verify log --commit <tip>` is GREEN only when the log
   vouches for exactly that commit on a clean tree.
6. When the task is done: `hive cleanup demo` trashes what hive created
   (tmux windows, worktrees), never deletes.

## State layout

- Hub root: `.hive-hub/` — `projects.json`, `tasks.jsonl` (append-only
  ledger), `tasks/<id>.md`, `panes/<project>.json` (a starting orchestrator),
  `hub.json`.
- Per project: `.hive/` — `team.json` (who should be running, with pane
  identity = pid + start time), `team/<agent>/role.md` + `RULES.md`,
  `handoffs/<agent>.md` (the agent's persistent memory; rotation works because
  of it), `manifest.jsonl` (what hive created; cleanup's only input).

## Deployment

The hub lives inside nexus at `nexus.dexima.ai/hive` (CloudFront proxies
`/hive/*` to the box; the nexus session gate is the auth). Infrastructure
lives in `infra/` (one CloudFormation stack plus the committed box config)
and every push to main deploys through `.github/workflows/deploy.yml` over
SSM. Bootstrap steps and the drift-adoption story: `infra/README.md`.

## Development

```bash
npm run build     # tsc
npm test          # vitest
test/live-smoke.sh  # real kimi session via teamkimi; spends API quota
```
