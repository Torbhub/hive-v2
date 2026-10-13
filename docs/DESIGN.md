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

- Node 20+, TypeScript, ESM, built with `tsc` to `dist/`. Single bin: `hive`.
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
  cleanup.ts   — manifest-driven cleanup, trash-not-delete
  ui/HubApp.tsx   — the hub screen (spec docs/hub-ui-spec.md)
  ui/buttons.tsx  — keyboard-driven button (Tab focus, Enter press, hotkeys)
roles/         — orchestrator.md, implementer.md, reviewer.md (read by spawned sessions)
rules/RULES.md — the team's working rules (git, gate, reporting, handoff format)
skills/        — start, gate, cleanup (Kimi Code skills; load with --skills-dir)
docs/          — this file, hub-ui-spec.md, mechanics.md (what was kept/cut and why)
test/          — vitest: screen parsing, gate-verify, task ledger, arg parsing
README.md      — written for a new SWE: what it is, install, the 6 commands you actually use
```

## State

Work folder (hub root), holds `.hive-hub/`:

- `projects.json` — `{projects:[{name, home, repos:[{folder}]}]}`
- `tasks.jsonl` — append-only ledger, one event per line. Vocabulary:
  `asked handed plan question answered blocked overnight cleanup decided done
  cancelled note`. Task state = last non-note event; `plan/question/blocked`
  = needs owner; `done/cancelled` = closed.
- `tasks/<id>.md` — task text handed to the orchestrator as a path.
- `panes/<project>.json` — a start/wake the hub launched that has not
  registered yet: `{pane, kind, at, typed, task}`.
- `hub.json` — the hub's own name (written by `hive hub init`).

Per project, `<project>/.hive/`:

- `team.json` — one entry per agent: name, tmux target, pane pid +
  starttime (identity is pid+starttime, never the bare `%N`), worktree,
  session resume info, handoff path. Orchestrator included.
- `team/<agent>/role.md`, `team/<agent>/RULES.md` — copies made at spawn.
- `handoffs/<agent>.md` — the agent's persistent memory; the agent updates
  its START HERE block. Rotation and restarts work because of this file.
- `manifest.jsonl` — typed records of what hive-v2 created (`worktree`,
  `tmux`, `process`). Cleanup acts only on the manifest and trashes instead
  of deleting.

## Commands (the whole surface)

```
hive hub init|add <name> <path>|status [--json]|tasks [--json]|task <project> <text>|log <id> <event> [note]
hive hub dialog <project> [agent] | answer <project> [agent] --choice <n|esc> --seen <sha1>
hive hub wake <project> | start <project> <task-id> | continue <project>
hive spawn <project> --agent <name> [--role r] [--worktree wt] | respawn | close
hive gate --log <path> -- <name> <cmd>... | gate-verify log <path> [--commit sha] | gate-verify commits <base>..<tip>
hive push <remote> <sha> <branch>        — fast-forward only, by full hash
hive cleanup <project> [--dry-run]
hive ui                                  — the hub screen
```

`status --json` and `tasks --json` emit exactly the shapes in spec §6.1/§6.2
(minus away fields) — the screen is a dumb renderer over them.

## Kimi session mechanics (the part that replaces hh-spawn)

- Launch, in a new tmux window named `<project>:<agent>`:
  `KIMI_CODE_NO_AUTO_UPDATE=1 exec teamkimi run -- --session <id>` when
  resuming, else `teamkimi run`. `exec` so the pane process IS the CLI
  (identity check). Pre-flight: `teamkimi status` must succeed, else refuse.
- Pickup line (typed once the pane is idle):
  `You are <agent> of project <project>. Read .hive/handoffs/<agent>.md from
  the top: its START HERE block is your prompt. Your role: .hive/team/<agent>/role.md.
  The rules: .hive/team/<agent>/RULES.md. Report to the orchestrator; wait for its first message.`
- Pane reading (`screen.ts`) is calibrated against the real Kimi Code 2.1.x
  TUI on this box — capture actual screens during development, do not guess:
  - idle: screen unchanged ~3s AND the bottom input box is an empty prompt
    (the `│ > │` row inside the `╭─╮/╰─╯` box) AND no spinner line.
  - context %: scrape `context: N% (used/1M)` from the status line.
  - dialog: numbered option lists and `Esc to cancel`-style prompts; parse
    options, mark `Type something`-like free-text options not-offered, sha1
    fingerprint over the dialog text. `answer` re-checks the fingerprint
    before sending keys (digit or Escape). Never types over a dialog.
- Typing: `send-keys -l` then `Enter`, only after idle, re-verifying pane
  identity before every send.
- Rotation: `hive spawn respawn <project> --agent <name>` (kill pane, fresh
  session, pickup line points at the handoff). The screen shows context % so
  the owner/orchestrator knows when; no automatic rotation in v2.

## Gate (ported semantics, kept strict)

`hive gate --log L -- build "npm run build" test "npm test"`: writes header
`# hive-gate steps: build,test head=<sha> dirty=<0|1>`, runs every step even
after a failure, per-step output to `L.d/<name>.log`, appends `<name> exit
<n>`. `gate-verify log L [--commit sha]`: GREEN only with ≥1 step line, all
`exit 0`, no duplicates, every header step present, and (with --commit) head
match + clean tree. `gate-verify commits a..b`: per commit non-empty
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
