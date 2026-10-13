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

## How a task flows

1. You record a task: `hive hub task demo "..."`. It lands in the ledger
   (`.hive-hub/tasks.jsonl`) in state `asked`.
2. You start the team: `hive hub start demo demo-1`. hive opens a tmux window
   (`demo:demo-orchestrator` in the `hive` tmux session), waits for kimi to go
   idle, and types the pickup line: who it is, where its handoff is, where the
   task file is.
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

## Development

```bash
npm run build     # tsc
npm test          # vitest
test/live-smoke.sh  # real kimi session via teamkimi; spends API quota
```
