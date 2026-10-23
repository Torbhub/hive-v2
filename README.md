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
hive doctor                       # preflight: is this box ready for a task
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

## Interrupt vs kill

`hive interrupt demo [agent]` — or the Interrupt buttons on the web screen —
sends Escape to a live pane. A running turn stops mid-turn and the session
stays alive: its context survives and you can steer the agent after with a
message or a dialog answer. On an open dialog Escape is the dismiss key, so a
dialog needs the answer flow instead. Killing the pane (`hive spawn close`,
`hive cleanup`) ends the session and its context with it. Interrupt first
when the work matters.

## The watchdog

`hive watch` is a foreground daemon (one systemd unit:
`ExecStart=/path/to/hive watch`, run from the hub root): every 5s it logs
dead panes to `.hive-hub/watch.log` with timestamps and re-wakes the dead by
session id. A failed wake is retried with backoff (60 attempts over hours,
then it gives up and says so). A pane closed on purpose (`hive cleanup`,
`hive spawn close`, a respawn) is stamped `closed_at` in `team.json` first,
and the watch never re-wakes a stamped pane. A dead agent with a recorded
session is re-woken the same way as the orchestrator. A live pane frozen on
a spinner for 10 minutes is marked `wedged` on the hub, but only when
nothing corroborates life: no CPU advance in its process tree and a stale
wire log. Before any restart of a wedged pane the watch saves a stack dump
(`sudo pstack`, plus `py-spy dump` when installed) to `.hive/wedges/`, then
kills the pane so the death path re-wakes it. The watch also pulses
`.hive-hub/watch-status.json` every cycle. A stale file means the watch
itself is wedged. It auto-answers permission dialogs per the
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

## The daily loop

Once a day the box posts a `daily-scan` task to the hivev2 project by
itself (a systemd timer, `hive-v2-daily-scan.timer`, provisioned from
`infra/box/` — never made by hand). The orchestrator that picks it up
follows the experiment skill (`skills/experiment/SKILL.md`): a news-scout
crawls the standing sources in `docs/crawl-sources.md` plus one web-search
pass and writes a dated findings note in `docs/crawl/` with at most three
candidate experiments. The orchestrator tries at most one, in its own lane,
through the gate and a PR. The deslop-reviewer reviews that PR. Only a
CLEAN verdict earns the `deslop-clean` label that lets auto-merge land it.
An experiment that touches the loop's control plane never auto-merges:
`infra/`, `.github/`, `scripts/`, `roles/`, `skills/`, `rules/`, or
`AGENTS.md`. It waits for you. A day where the scout finds nothing worth
trying closes as done with a note, and that is the loop working.

## How a task flows

1. You record a task: `hive hub task demo "..."`. It lands in the ledger
   (`.hive-hub/tasks.jsonl`) in state `asked`. A task can also be a
   structured brief: frontmatter between `---` lines plus a
   `## Files to touch` section that claims the paths the work will change.
   Paste one with `hive hub task demo "$(cat brief.md)"`. hive validates the
   brief before recording it and keeps the frontmatter at the top of
   `tasks/<id>.md`.
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
3. The orchestrator plans, asks, and spawns agents (`hive spawn`). With
   `--task <id>` the spawn binds the agent to a task whose brief claims a
   file scope. hive refuses the spawn when the scope overlaps another live
   agent's task scope, and when either brief's scope does not parse. Two
   agents on the same task never collide. A task with no scope claim spawns
   unchecked. Every state change is a ledger event: `plan`, `question`,
   `blocked`, `done`.
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

The hub lives inside nexus at `nexus.dexima.ai/hive` and is reachable only
through that relay (CloudFront `/hive/*` → nexus Lambda → SSM tunnel to the
box loopback; the nexus session gate is the auth). No public hostname, cert,
or DNS record exists for the hub. Infrastructure
lives in `infra/` (one CloudFormation stack plus the committed box config)
and every push to main deploys through `.github/workflows/deploy.yml` over
SSM. Bootstrap steps and the drift-adoption story: `infra/README.md`.

## The bench

`bench/` holds small canary tasks about hive's own code. Each task in
`bench/tasks/<id>/` pins a rev, breaks one thing (`setup.sh`), and checks
the fix (`check.sh`). `bench/run.sh <task> [action...]` clones hive at the
pinned rev, breaks it, runs the optional action (an agent working from
`prompt.md`), and prints one JSON verdict line: pass or fail. The verdict
comes from the gate itself. The runner commits the candidate and reads the
check through `hive gate` plus `hive gate-verify --commit HEAD`, exactly
like work that lands.

A change to `roles/`, `rules/`, or `skills/` steers agent behavior, and the
PR gate cannot see behavior. Such a change must post a bench verdict in its
PR body. Run every task in `bench/tasks/` with an agent that carries the
candidate role or rules, and paste the JSON lines. A task the agent solved
before the change must stay green after it.

The runner does heavy work: a full clone, `npm ci`, a build, vitest. Do not
run it on the hub box. Run it on any other machine with Node 22.

## Development

```bash
npm run build     # tsc
npm test          # vitest
test/live-smoke.sh  # real kimi session via teamkimi; spends API quota
```
