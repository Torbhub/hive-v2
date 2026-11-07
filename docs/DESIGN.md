# hive-v2 design

hive-v2 runs a software task with a team of Kimi Code sessions in tmux: an
orchestrator per project, the agents the task needs, a gate before anything
lands, and a hub screen that shows what waits on you. It is a ground-up
rewrite of [hivehouse](https://github.com/Cleveland-RD/hivehouse) (Claude
Code plugin, ~5.5k lines of bash + a Claude-Code-only TSX module) as one
small TypeScript codebase on **Kimi Code + teamkimi**.

Hard requirements from the operator:

- Sessions are Kimi Code sessions, always routed through the **teamkimi**
  proxy (`teamkimi run`). The spawn path refuses to start anything when the
  proxy is down.
- The hub screen clones hivehouse's hub UI exactly (see
  `docs/hub-ui-spec.md` — every string, glyph, and color is specified there).
- No bloat, no lore comments. Comments say why, never what. The layout must
  make sense to a new SWE on first read.

## What was cut from hivehouse (and why)

Away/delegate mode (~40% of the original: root-owned delegate files, a
1001-line shell policy parser, MCP secret shuffling), overnight runs,
remote-sync, the root-owned machine slot, rm/find/rsync PATH guards,
`custom/` override machinery with trust checks, unregistered-session
discovery via Claude session records, menu-arrow dialog navigation,
5 roles → 3, 9 skills → 3, 21 options → a handful. All of it is either a
different product (unattended autonomy) or defense in depth against problems
the underlying CLI already handles. The hivehouse task-state vocabulary keeps
an `overnight` state only as a display suffix, since the screen shows it.

## Stack

- Node 20+, TypeScript, ESM, built with `tsc` to `dist/` and `vite build` to
  `web/dist/` (the browser hub screen). Single bin: `hive`.
- Hub screen: [Ink](https://github.com/vadimdemedes/ink) (React for the
  terminal). The hivehouse screen is already React-ish TSX; the port is
  near-mechanical per `docs/hub-ui-spec.md`.
- tmux is the process supervisor, on a private server socket (`tmux -L
  hive-v2`) so hive can never see or touch the user's own sessions; every
  mutation re-verifies the pane's session and pid+starttime first. No daemons
  of our own.
- Runtime deps: `ink`, `react`. Dev deps: `typescript`, `@types/react`,
  `@types/node`, `tsx` (dev runner), `vitest` (tests). Nothing else — no
  commander, no execa, no zod; `child_process` and hand-rolled arg parsing
  are enough.

## Repo layout

```
src/
  cli.ts       — arg parsing + subcommand dispatch, nothing else
  types.ts     — HubView/HubProject/HubAgent/HubTask/HubDialog (spec §5, away fields dropped)
  tmux.ts      — tmux wrappers: windows, capture-pane, ANSI clean, send-keys, pane identity (pid+starttime)
  screen.ts    — Kimi TUI reading: idle detection, dialog parse, context-% scrape
  state.ts     — .hive-hub/ and .hive/ file layout, JSON/JSONL IO, mkdir lock
  hub.ts       — status/tasks/task/log/dialog/answer/wake/continue/start logic
  spawn.ts     — spawn/respawn/close of orchestrator + agent sessions
  gate.ts      — gate runner + gate-verify (log, commits)
  handy.ts     — loopback-only Handy CLI bridge for browser dictation
  cleanup.ts   — manifest-driven cleanup, trash-not-delete
  watch.ts     — watchdog (dead-pane log + wake), safe/smart auto-approver, and direct Auto dialog answers
  compact.ts   — idle compaction policy, durable attempts, and per-worker controls
  cache-expiry.ts — exact cache-dialog parsing and identity-checked cursor input
  ui/HubApp.tsx   — the hub screen (spec docs/hub-ui-spec.md)
  ui/look.ts      — the shared look: ago, look tables, needs-building (Ink and web both import it)
  ui/buttons.tsx  — keyboard-driven button (Tab focus, Enter press, hotkeys)
  view.ts         — one HubView assembly (status + tasks + dialogs) for both screens
roles/         — orchestrator.md, implementer.md, reviewer.md, council-*.md, researcher.md, news-scout.md, deslop-reviewer.md (read by spawned sessions)
rules/RULES.md — the team's working rules (git, gate, reporting, handoff format)
skills/        — start, gate, cleanup, council, retro, digest-triage, experiment (Kimi Code skills; load with --skills-dir)
web/           — server.ts (node:http, loopback), dictation.tsx (browser audio), + the React/vite SPA (built to web/dist)
docs/          — this file, hub-ui-spec.md, mechanics.md (what was kept/cut and why), crawl-sources.md + crawl/ (the daily loop's ledger and findings)
test/          — vitest: screen parsing, gate-verify, task ledger, arg parsing
README.md      — written for a new SWE: what it is, install, the 6 commands you actually use
```

## State

Work folder (hub root), holds `.hive-hub/`:

- `projects.json` — `{projects:[{name, home, repos:[{folder}]}]}`
- `tasks.jsonl` — append-only ledger, one event per line. Vocabulary:
  `asked handed plan question answered blocked overnight cleanup decided done
  cancelled note progress planaccept`. Task state = last event not in
  {note, progress, planaccept}. `plan/question/blocked` = needs owner.
  `done/cancelled` = closed.
- `tasks/<id>.md` — task text handed to the orchestrator as a path.
- `panes/<project>.json` — a start/wake the hub launched that has not
  registered yet: `{pane, kind, at, typed, task}`.
- `watch.log` — the watchdog's pane-death/cycle-error lines, timestamped.
- `decisions.jsonl` — append-only permanent decisions: owner answers,
  watch auto-approvals/wakes, orchestrator `decided` events.
- `hub.json` — the hub's own name (written by `hive hub init`).

Registration runs under the hub lock. An explicit path registers its canonical
folder and refuses a duplicate canonical home. Hive checks the folder identity
again before the registry write. A blank path allocates `<root>/<name>` or
`<name>-<8 hex>` without reusing an existing or registered path. A source must
be the canonical root of its repository. With no source, hive creates an empty
Git repository. A JJ source creates a workspace from `main@origin`, `main`, or
`@`. A plain Git source creates a detached worktree from `HEAD`. New homes do
not inherit `.hive` state. Every Git and JJ child process has a 30-second
timeout. A failed create deregisters and removes only newly allocated state.
Cleanup checks directory identity and leaves a changed path in place.

Per project, `<project>/.hive/`:

- `team.json` — one entry per agent: name, tmux target, pane pid +
  starttime (identity is pid+starttime, never the bare `%N`), worktree,
  session resume info, handoff path. Orchestrator included. `auto_compact`
  controls the 30-minute policy for that worker. `compaction` stores the
  session id, status, attempt count, activity epoch, instruction hash, and failure detail.
- `team/<agent>/role.md`, `team/<agent>/RULES.md` — copies made at spawn.
- `handoffs/<agent>.md` — the agent's persistent memory. Worker START HERE
  blocks carry Assignment and Deliverable sections. Fresh launch validates and
  writes them before any side effect. Respawn and wake validate them before
  killing or creating a pane. Explicit respawn repairs both fields at the
  recorded path after preflight and plan checks. Repair preserves progress and
  Memory sections. Writes refuse symlinks. New handoffs include a Progress
  heading. The agent updates that section without removing the contract.
- `manifest.jsonl` — typed records of what hive-v2 created (`worktree`,
  `tmux`, `process`). Cleanup acts only on the manifest and trashes instead
  of deleting.

## Commands (the whole surface)

```
hive hub init|add <name> [path] [--source <path>]|status [--json]|tasks [--json]|task <project> <text>|log <id> <event> [note]
hive hub dialog <project> [agent] | answer <project> [agent] --choice <n|esc> --seen <sha1>
hive hub plan-answer <project> <task-id> <approve|sendback> [feedback]
hive hub wake <project> | start <project> <task-id> | continue <project>
hive spawn <project> --agent <name> --assignment <text> --deliverable <text> [--role r] [--worktree wt] | respawn [--assignment <text> --deliverable <text>] | close
hive gate --log <path> -- <name> <cmd>... | gate-verify log <path> [--commit sha] | gate-verify commits <base>..<tip>
hive push <remote> <40-char sha> <branch> [--approval <batch>/<question>] — fast-forward only, one-time grant for agents
hive cleanup <project> [--dry-run]
hive compact <project> [agent] on|off
hive handy-bridge [--origin URL]         — local Handy transcription bridge
hive ui                                  — the hub screen
```

`status --json` and `tasks --json` emit exactly the shapes in spec §6.1/§6.2
(minus away fields) — the screen is a dumb renderer over them.

## Operator questions (ask_operator MCP)

- `hive mcp` (src/mcp.ts) is a stdio MCP server, newline-delimited JSON-RPC,
  no SDK. It advertises one tool, `ask_operator`, registered for every kimi
  session as `hive-operator` in `~/.kimi-code/mcp.json` by provision
  (infra/merge-mcp.mjs). `toolTimeoutMs` is 7 days because a batch waits for
  a human. A call needs `HIVE_HUB_ROOT` and an individual
  `HIVE_AGENT_CREDENTIAL`. The current credential alone selects the owner,
  agent, and project. Every poll rechecks credential status and the write ACL.
- The tool input is strict (src/questions.ts): an overarching `context` and
  1-20 questions. General questions keep context, choices, and recommendation
  but carry no approval authority. A decision names exactly one action. Legacy
  approval-shaped requests and internal output become safe detail cards.
  Every owner-visible field passes the internal-content boundary.
- `src/decision-verification.ts` resolves only the registered project and
  recorded worktree. Repository, branch, full 40-character commit, diff summary,
  files, and destination come from Git. Agent repository claims are discarded.
  Verification failures remove approval. Non-repository actions have no
  execution authority and use fixed action-specific destinations. Every agent
  field is normalized before security-instruction checks.
- `src/decisions.ts` owns fixed card wording and choices. Push, pull request
  creation, merge, deploy, paid work, deletion, and credential grants stay
  separate. A fresh complete request offers Refresh, one approval, and Cancel.
  Refresh is recommended. Mixed batches preserve safe overarching context and
  show the no-auto-approval notice separately.
- Verification older than 15 minutes is stale. The UI disables stale approval
  and resets a selected stale approval to Refresh with an announced explanation.
  Submit checks current choice validity. `validateAnswers` checks freshness
  again at answer time. Other remains non-authoritative.
- A structured answer adds `decision: {action, outcome, facts, grant?}`. Grants
  bind batch, question, project, verified-fact fingerprint, expiry, and explicit
  execution authority. `consumePushApproval` rechecks current facts under the
  hub lock and consumes once. `hive push --approval <batch>/<question>` uses it.
  Cross-project, action, commit, branch, remote, and replay substitution fail.
- An optional injected `DecisionRewriter` receives a defensive copy of sanitized
  facts and an abort signal. Model text never supplies the security overview.
  Cards always keep deterministic wording, so model claims cannot create
  approval, cost, or factual assertions. No model integration or paid call is
  enabled by default.
- A call creates `.hive-hub/questions/<uuid>.json` (status open) and waits,
  polling the file every 2s without the hub lock. The read loop stays live:
  ping and client cancellation work mid-wait, and a cancelled wait leaves the
  batch open for the operator. One outstanding batch per agent session, at
  most 200 open batches hub-wide, MCP lines capped at 1MiB. Answer, cancel,
  and create all transition under `withHubLock`, so a web POST and an MCP
  process cannot both close a batch. On a close the file moves to
  `questions/closed/`, so the open listing never scans history. Batch files
  are 0600. An answered or cancelled batch appends one owner decision to
  `decisions.jsonl`. A terminal batch left at the open path is renamed before
  authorization. Exact unconsumed duplicates are deduplicated. Any consumed or
  conflicting duplicate fails closed, so only one push authorization is possible.
- The hub web screen (`web/questions.tsx`) lists open batches from
  `/api/view`. The owner answers with `POST /api/questions/answer`
  (`{id, answers: [{question, choice, text?}]}`) or cancels with
  `POST /api/questions/cancel` (`{id}`). `other` answers require text, and
  the server re-validates everything the UI checked. The answer route takes
  bodies up to 512KiB so twenty full-length Other answers fit. The MCP call
  then returns `{id, status, answers}` as JSON text, or a tool error on cancel.
- A live wait refreshes `waitHeartbeatAt` every 15 seconds. The watchdog
  suppresses stale and wedge checks only while that heartbeat is recent.
- A dead MCP child never closes its batch: an orphaned batch stays open and
  the owner can cancel it. Its heartbeat expires, so normal watchdog recovery
  resumes. There is no idempotent resume by design. A lazy
  sweep (driven by the hub view) cancels open batches older than 7 days with
  an `expired` audit note, and prunes closed history to the newest 200.
  `/api/view` carries the oldest 50 open batches and `questionsTotal` counts
  them all, so a full screen never turns into a giant payload.

## Kimi session mechanics (the part that replaces hh-spawn)

- Launch, in a new tmux window named `<project>:<agent>`:
  `HIVE_AGENT=<agent> HIVE_PROJECT=<project> HIVE_HUB_ROOT='<root>' KIMI_CODE_NO_AUTO_UPDATE=1 KIMI_CODE_SESSION_LOCK=0 exec teamkimi run -- [--session <id>] [--agent-file <profile>] [-y|--auto] -m '<model>'`
  — fresh sessions also bind `.hive/team/<agent>/agent.md` in print mode. Its
  `disallowedTools` contains `AskUserQuestion`. Interactive Kimi 2.3.1 ignores
  profile-selection flags, so a conditional `PreToolUse` hook enforces the same
  rule when `HIVE_AGENT` is set. The hook returns exit 2 and directs the agent
  to `mcp__hive-operator__ask_operator`. Non-Hive sessions return exit 0. If the
  hook misses a dialog, the watchdog detects its exact footer, sends Escape once,
  and types one MCP redirect. It never selects a native answer.
  The project's `mode` in projects.json (`ask`/`yolo`/`auto`, default `ask`)
  maps to no flag for `ask` and `-y` for `yolo` and `auto`, on fresh starts and
  resumes alike. Derived `ask` plus `safe` or `smart` orchestrator launches use
  supervised `--auto` instead. The model
  is the house default `kimi-code/k3.1-pro` unless the spawn passed `--model`,
  and the effective model is stamped into team.json. HIVE_AGENT and HIVE_PROJECT
  remain pane and hook metadata. They cannot select MCP identity. An individual
  agent credential selects that identity. The root is shell-quoted.
  `exec` so
  the pane process IS the CLI (identity check). Pre-flight: `teamkimi status`
  must succeed, else refuse.
- Worker pickup starts from the persisted Assignment and Deliverable. It does
  not wait for another brief. The worker returns the named artifact to the
  orchestrator.
- Pane reading (`screen.ts`) is calibrated against the real Kimi Code 2.1.x
  TUI on this box — capture actual screens during development, do not guess:
  - idle: screen unchanged ~3s AND the bottom input box is an empty prompt
    (the `│ > │` row inside the `╭─╮/╰─╯` box) AND no spinner line.
  - context %: scrape `context: N% (used/1M)` from the status line.
  - dialog: numbered option lists and `Esc to cancel`-style prompts; parse
    options, mark `Type something`-like free-text options not-offered, sha1
    fingerprint over the dialog text. `answer` re-checks the fingerprint
    before sending keys (digit or Escape). Never types over a dialog.
- Typing: `send-keys -l` then `Enter`, re-verifying pane identity before every
  send. Normal task input waits for idle. Auto-compaction also uses Kimi's
  supported busy queue. The only dialog fallback selects `Compact and continue`
  on a complete Kimi 2.5.1 cache-expiry chooser. The final send holds the team
  lock, rechecks disablement and the screen, and verifies process identity and
  the full dialog fingerprint before every key. It also rechecks activity and
  requires a non-dialog screen before every Enter and after each input capture.
  Legacy instruction cleanup runs before closed and pane-less liveness branches.
- Rotation: `hive spawn respawn <project> --agent <name>` (kill pane, fresh
  session, pickup line points at the handoff). The screen shows context % so
  the owner/orchestrator knows when; no automatic rotation in v2.

## Gate (ported semantics, kept strict)

`hive gate --log L -- build "npm run build" test "npm test"`: writes header
`# hive-gate steps: build,test head=<sha> dirty=<0|1>`, runs every step even
after a failure, per-step output to `L.d/<name>.log`, appends `<name> exit
<n>`. `gate-verify log L [--commit sha]`: GREEN only with ≥1 step line, all
`exit 0`, no duplicates, every header step present, and (with --commit) head
match + clean tree. A green step whose name starts with `test` also needs its
`L.d/<name>.log` to show a vitest summary with passed > 0 and zero errors —
exit 0 alone is not evidence. `gate-verify commits a..b`: per commit non-empty
subject, ≤ N files vs first parent, empty range is RED. A gate with no step
lines is RED, never vacuously green.

## Testing

vitest unit tests for: screen parsing (fixture captures of the real Kimi
TUI taken during development), task ledger folding, gate-verify verdicts,
dialog fingerprint, CLI arg parsing. Plus one live smoke script
(`test/live-smoke.sh`, not run in CI): spawns a real kimi session via
teamkimi in tmux, waits idle, types `Reply with the word OK`, sees it work
and go idle, closes it.

## Comment policy

Comments explain why a non-obvious decision exists, in one line. No restating
code, no history lessons, no lore, no "unlike hivehouse…" asides outside
docs/. Identifiers carry the meaning.
