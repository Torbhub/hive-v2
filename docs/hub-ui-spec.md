# Hivehouse Hub Screen — Reimplementation Spec

Source of truth: `hooks/hub.tsx` (the renderer), `types/index.d.ts` (the shapes), `bin/hh-hub` + `bin/hh-lib.sh` (the JSON producers). All visible strings below are verbatim from source.

## 0. Frame & global behavior

- The screen is one pane titled **"Hub"**, opened by the command `/hub-screen` (description: `Show the hub: what waits on you, and every project`).
- Outer container: vertical box, `backgroundColor: black` (deliberate — the engine's default pane background is grey in ANSI themes), `width = max(36, bodyColumns ?? 60)`, `minHeight = viewport rows`, `paddingX = 1`.
- `inner = width - 2` — used for the horizontal rule.
- The horizontal rule (`rule`) is a gray `Text` of `'─'` repeated `inner` times.
- **Polling:** every **20 s** (`EVERY_MS`). Also refreshes on open, on the refresh button/`r` key, and after every action completes.
- **Refresh** runs in parallel (cwd = hub root, 30 s timeout each):
  - `bin/hh-hub status --json`
  - `bin/hh-hub tasks --json`
- If `status` fails, old data is kept and `error` is set to the exception message. If only `tasks` fails, projects still render and `error` is `` `tasks not read: ${lastLine}` `` (last line of stderr, with a leading `hivehouse: ` prefix stripped).
- **One action at a time:** a press while another action runs is ignored (the `acting` atom).
- Toasts (transient notifications, not part of the layout): see §7.

## 1. Layout, top to bottom

### 1.1 Header row (row, `justifyContent: space-between`)

Left (row, `flexShrink: 1`):
- `HUB` — **bold, white**
- `  ·  {where}` — gray, `wrap: truncate-start`. `where` is the hub root with `$HOME` replaced by `~` (empty string renders nothing).

Right (box, `flexShrink: 0`, `paddingLeft: 2`):
- Away/mode text — color: **magenta** if away, **red** if away refused, else **gray**. Content (exactly one, note trailing double space):
  - `away until {untilLabel}  ` when `view.away` is set
  - `away refused: {awayRefused}  ` when `view.awayRefused` is set
  - `relay  ` otherwise, but only once data was read (`updatedAt` truthy)
- Clock — gray: `HH:MM` (local, `toTimeString().slice(0,5)` of `updatedAt`), or `reading…` before the first successful read.

`untilLabel(ms)`: if the until-time is today → `HH:MM`; otherwise `{WeekdayAbbrev} {HH:MM}` (e.g. `Tue 07:30`, from `toDateString().slice(0,3)`).

### 1.2 Rule

### 1.3 Error line

Only when `view.error` non-empty: **red** text, the error string verbatim.

### 1.4 NEEDS YOU section (only when at least one need)

Header: `NEEDS YOU` — **bold, magenta**. `marginTop: 1`.

Each need (`paddingLeft: 1`, column):
- Row 1 (`justifyContent: space-between`):
  - `{glyph} ` — colored per need
  - `{who}` — **bold, white**
  - `  {words}` — white, `wrap: wrap`
  - right side: `{when}` — gray (see `ago()` below; may be empty)
- Then the dialog block (§4), if any.
- Then the action (button or busy text), `paddingLeft: 2`, if any.

Needs, in order pushed:
1. **Hub not recorded** (only when `updatedAt` truthy and `hubName` empty): glyph `!`, color **red**, who `hub`, words `has not recorded its session, so nobody can reply to it`, when empty.
2. **Tasks with `needs_owner`** (per task): who = task `id`, when = `ago(task.updated)`. Glyph/color/words by state (`waitLook`):
   | state | glyph | words | color |
   |---|---|---|---|
   | `plan` | `▲` | `plan to approve` | magenta |
   | `question` | `?` | `question` | yellow |
   | `blocked` | `✖` | `blocked` | red |
   | anything else | `•` | the state name itself | white |

   A `plan` task carries the `plan` action (`project`, `taskId` set). If its project's orchestrator has a live question, the first such task also absorbs it: the dialog block keyed `"<project>"` renders on this card and rule 3 is skipped for that project (one card, one answer). With no dialog, the web UI renders the plan action: an **Approve plan** button and a **Send back** button with an optional feedback line; both POST `/api/plan-answer`, which types the verdict as the orchestrator's next line and logs the task `answered` (approve) or `handed` (send back). With no dialog, the TUI renders the same action as two hotkey **Button**s (`paddingLeft: 2`, `columnGap: 1`): `a approve plan` (hotkey `a`) and `b send back` (hotkey `b`). When several plan needs show at once, a hotkey presses the first one. `b` swaps the buttons for a one-line feedback prompt: white `feedback: `, then the typed text in white (gray `what should change? (optional)` while the line is empty), then an inverse-space cursor. Enter sends, Esc cancels, and an empty line means no feedback. While the prompt is open, button hotkeys and Enter stay inert. While the answer runs, the card shows cyan `answering…`.
3. **Orchestrator question** (per project with `orchestrator.question`, unless absorbed by a `plan` task per rule 2): glyph `?`, **yellow**, who = project name, words `its orchestrator has a question on its screen`, when empty, plus dialog block keyed `"<project>"`.
4. **Agent question** (per agent with `question`): glyph `?`, **yellow**, who = `{project} · {agentRef}`, words `a question on its screen`, when empty, plus dialog block keyed `"<project>/<agentRef>"`.
5. **Starting orchestrator waiting on owner** (`orchestrator.starting` exists, not `typed`, not `sending`): glyph `?`, **yellow**, who = project name, when = `ago(starting.at)`:
   - if `starting.question`: words `a question on the screen of pane {pane}: answer it, then Continue`, plus dialog block.
   - else: words `waiting in pane {pane} for its first line`, no dialog.
   - Action: while this project is busy → cyan text `continuing…`; else a **Button** labeled `Continue`.

### 1.5 DECIDED WHILE YOU WERE AWAY section

Visibility: `Boolean(view.away) || (Boolean(view.lastAway) && awaySince !== seenAway)`, and the filtered list is non-empty. `awaySince = away?.since ?? lastAway?.since ?? ''`. `seenAway` is local UI state (per away period start; a newer away period starts unseen).

- Header row (`space-between`): `DECIDED WHILE YOU WERE AWAY` — **bold, cyan**; on the right, only when **not** currently away: plain **Button** `Seen` (pressing records this away period as seen; the section disappears after away ends).
- Rows (max 8, newest first): each `paddingLeft: 1`, `space-between`:
  - `{taskId}` — **bold, white**
  - `  {reason}` — white, wrap
  - right: `ago(decision.at)` — gray
- Source: every `decisions[]` entry of every task, tagged with the task id, filtered to `at >= awaySince` (no filter if `awaySince` empty), sorted descending by `at`, sliced to 8.

### 1.6 Empty state

Only when `updatedAt` truthy, `projects` empty, and no error: `marginTop: 1`, gray text:

`No projects yet: tell the hub which folders make up a project.`

### 1.7 Project cards (one per project, in status order)

Card = column, `marginTop: 1`.

**Card header** (row, `space-between`):
- `{NAME}` — project name **uppercased**, **bold, white**
- `{dot} {word}` — orchestrator look (§3)

**Label rows**: the `row(label, ...lines)` helper renders a row with `paddingLeft: 1`: label in a fixed `width: 14`, `flexShrink: 0` box, **gray**; content lines in a `flexShrink: 1` column. Labels, in order: `orchestrator`, `agents`, `tasks`, `folders`.

**`orchestrator` row** — one row of texts:
- orchestrator `name` — white; fallbacks: `none yet` when state is `none`, `?` otherwise.
- when state `unregistered` and `pane` set: gray `  pane {pane}` (two leading spaces).
- when `context` is a number: `  {context}%` — color: **gray** if `context_assumed`, else **yellow** if `context >= rotateAt` (plugin option `rotate_at_percent`, default **50**), else **green**.
- when `context_unknown`: gray `  context unknown`.

**`agents` row**:
- no agents: gray `none`.
- else one row: for each agent, one of these glyphs **followed by a trailing space** (so two hollow dots don't read as one wide sign): `●` **green** (running), `○` **yellow` (stopped), `?` **red** (unknown/unrecorded). Then white ` {up} of {total}` (leading space; `up` = running count).
- If any agents are not running, a second line, **yellow**: `{ref} {state}` joined with `, ` (e.g. `fixer stopped, reviewer@/wt/repo unknown`).

**`tasks` row** — white, one string:
`{open_tasks} open` then optional suffixes, in order:
- ` · {n} overnight run` / ` · {n} overnight runs` (tasks of this project in state `overnight`)
- ` · {n} cleanup` (state `cleanup`)
- ` · {n} done today` (state `done`, `updated` same local day)

**`folders` row** — one line per repo, white, `wrap: truncate-end`:
`{folder}` + (when `changed` truthy) `  {changed} changed`. (`branch` and `kind` are **not** shown on screen.)

**Resume row** (`paddingLeft: 15`), shown only when `canResume = (state is 'stopped' or 'resumable') && session_id && !starting`:
- while busy with this project: cyan `resuming…`
- else: **Button, variant `primary`**: `Resume · {back} session` / `Resume · {back} sessions`, where `back = 1 + (number of stopped agents)`.

### 1.8 Footer

- `marginTop: 1` box containing the rule again.
- Row, `space-between`:
  - gray legend: `● running  ○ stopped  ◌ no team`
  - plain **Button** `refresh` with **hotkey `r`** (re-runs the two reads).

## 2. Relative-time formatting (`ago(iso, now)`)

- invalid date → empty string
- `< 60 s` → `now`
- `< 1 h` → `{m}m`
- `< 24 h` → `{h}h`
- else → `{d}d`

## 3. Orchestrator look table (`orchestratorLook`)

| condition | dot | word | color |
|---|---|---|---|
| `starting` set, state ≠ `running`, `typed` or `sending` | `◐` | `coming up` | cyan |
| `starting` set, state ≠ `running`, neither | `◐` | `waiting on you` | magenta |
| `running` | `●` | `running` | green |
| `stopped` | `○` | `stopped` | yellow |
| `unknown` | `?` | `cannot tell` | red |
| `none` | `◌` | `no team` | gray |
| `unregistered` | `◑` | `not registered` | magenta |
| `resumable` | `○` | `stopped, not registered` | yellow |
| (fallback) | `?` | `cannot tell` | red |

Agent colors: running → green, stopped → yellow, anything else → red.
`agentRef(a) = a.ref ?? a.name` (status emits `<name>@<team root>` when a name appears in two team roots).

## 4. Dialog block (verbatim rendering rules)

Rendered under a need when a dialog was read for that session (`paddingLeft: 3`, column). Data from `hh-hub dialog` (§6.3). If the dialog could **not** be read (absent from the map), nothing is rendered here — the generic wording of the need stands.

1. **Dialog text lines**: `text.split('\n')`, drop lines matching `/^[\s─╌]*$/` (blank/rule-only), keep the **last 14**. Each: gray, `wrap: truncate-end`, verbatim.
2. **Button row** (row, `flexWrap: wrap`, `columnGap: 1`), rendered when there is at least one offered option or `esc` is true:
   - one **Button** per option with `offered === true`: label `` `${n} ${label}` `` plus ` (saves a rule)` when `saves_rule`. Press → answer with choice `String(n)`.
   - when `esc` true: a **Button** labeled `Esc`. Press → answer with choice `esc`.
3. **Detail lines**: for each offered option with `detail !== ''`: gray, truncate-end: `{n}. {label} {detail}`.
4. **Yellow hint line**, rendered when some option is not offered **or** there are no offered options:
   - when `options` is empty: `answer it in the pane`
   - else: `{comma-joined labels of non-offered options, or 'this dialog' if that list is empty}: answer it in the pane`

Not-offered options are those matching `^(Type something\.?|Chat about this)$` (case-insensitive) in the parser — they need the owner's own text.

## 5. Data shapes (from `types/index.d.ts`, annotated)

```ts
type HubOrchestratorState = 'running' | 'stopped' | 'unknown' | 'none' | 'unregistered' | 'resumable'
// unknown: process alive but tmux cannot vouch; none: no team recorded;
// unregistered: live session outside hivehouse (found via Claude Code session records);
// resumable: nothing recorded, but a transcript exists (wake resumes by session id)

type HubAgentState = 'running' | 'stopped' | 'unknown' | 'unrecorded'

type HubAgent = {
  name: string
  state: HubAgentState
  question?: boolean        // a dialog waits on its screen, unwatched
  context?: number          // percent of context window
  context_assumed?: boolean // percent computed against an assumed window
  context_unknown?: boolean // tokens exceed an assumed window; no percent available
  context_tokens?: number
  worktree?: string         // team root it sits in
  ref?: string              // "<name>@<team root>" when name is ambiguous, else same as name
}

type HubOrchestrator = {
  state: HubOrchestratorState
  question?: boolean
  name?: string
  pid?: number              // unregistered sessions
  pane?: string             // unregistered sessions, e.g. "%12"
  session_id?: string
  context?: number
  context_assumed?: boolean
  context_unknown?: boolean
  context_tokens?: number
  starting?: {              // a session this hub started (wake/start) that hasn't registered
    pane: string
    kind: string
    at: string              // ISO timestamp
    typed?: boolean         // its first line was sent ("coming up")
    sending?: boolean       // an hh-hub is still waiting to send it ("coming up")
    question?: boolean      // a dialog waits on its screen
    task?: string
  }
}

type HubFolder = { folder: string; kind: string; branch?: string; changed?: number }

type HubProject = {
  name: string
  home: string
  repos: HubFolder[]
  orchestrator: HubOrchestrator
  agents: HubAgent[]
  open_tasks: number
}

type HubTask = {
  id: string                // e.g. "myproj-3"
  project: string
  asked: string             // ISO of first event
  state: string             // last non-note event
  updated: string           // ISO of last event (notes included)
  last_note: string | null
  needs_owner: boolean      // state ∈ {plan, question, blocked}
  decisions?: { at: string; reason: string }[]
}

type HubDialogOption = {
  n: number
  label: string
  detail: string            // '' when none
  offered: boolean          // false = needs owner's own text, answer in pane
  saves_rule: boolean       // choosing it saves a permission rule
}
type HubDialog = {
  kind: 'numbered' | 'menu' | 'none'
  text: string              // multi-line captured dialog text
  options: HubDialogOption[]
  cursor: number | null     // menu cursor row (1-based)
  esc: boolean              // dialog offers Escape
  fingerprint: string       // 40-char hex sha1 of text; `answer` re-checks it
}

type HubView = {
  root: string
  hubName: string
  projects: HubProject[]
  tasks: HubTask[]
  dialogs: Record<string, HubDialog>  // "<project>" = orchestrator, "<project>/<agent>" = agent
  away: { until: number; since?: string } | null   // until = epoch SECONDS
  awayRefused: string | null
  lastAway: { since: string; until: number } | null
  updatedAt: number          // ms epoch of last successful refresh
  error: string
}
```

## 6. Exact JSON outputs of `bin/hh-hub`

### 6.1 `hh-hub status --json`

Top level: `{ "hub": {...}, "projects": [...] }`.

```json
{
  "hub": {
    "root": "/abs/work/folder",
    "name": "hub",
    "claude_pid": 12345,
    "claude_started": "...",
    "away": { "until": 1760300400, "hosts": "", "tools": "", "since": "2026-10-12T22:00:00Z" },
    "away_refused": "writable by group or others: /path",
    "last_away": { "since": "2026-10-11T20:00:00Z", "until": 1760220000 }
  },
  "projects": [
    {
      "name": "myproj",
      "home": "/abs/work/folder/myproj",
      "repos": [
        { "folder": "myproj", "kind": "repo", "branch": "main", "changed": 3 },
        { "folder": "wt/feat", "kind": "worktree" }
      ],
      "orchestrator": {
        "state": "stopped",
        "question": false,
        "name": "myproj-orchestrator",
        "session_id": "5f2c...",
        "context": 42, "context_assumed": false,
        "starting": { "pane": "%7", "kind": "start", "at": "2026-10-13T06:59:00Z",
                      "typed": false, "sending": false, "question": true, "task": "myproj-2" }
      },
      "agents": [
        { "name": "fixer", "state": "running", "worktree": "/abs/.../myproj",
          "question": false, "context": 18, "context_assumed": true, "ref": "fixer" }
      ],
      "open_tasks": 2,
      "held": false
    }
  ]
}
```

Field notes:
- `hub.name`, `claude_pid`, `claude_started` come from `hub.json`; absent when the hub never recorded itself (`hub` may be just `{root}`). The screen's "hub not recorded" need keys off the missing `name`.
- `hub.away` present only while a valid delegate file names this hub; `since` optional; `hosts`/`tools` are strings (screen ignores them).
- `hub.away_refused` optional string (first refusal reason).
- `hub.last_away` optional; stays after away ends.
- `folder` is stored relative to the hub root when it sits under it, else absolute. `kind` ∈ `repo | worktree | folder | missing` (the parent repo path is stripped). `branch`/`changed` only for repo/worktree kinds; `changed` is a count of dirty paths.
- `orchestrator.state` ∈ the six states above. `question` is **always** present (boolean). `pid`/`pane` only for `unregistered`. `starting` only when a hub-started pane is pending. Context fields per §5.
- Agent entries always include `name`, `state`, `worktree`, `question`, `ref`; context fields optional.
- `held` (boolean) is emitted but **not used by the screen** (the text-mode status shows `  (held: the hub starts and wakes nothing here)`).

### 6.2 `hh-hub tasks --json`

A JSON **array**, sorted by `asked`:

```json
[
  {
    "id": "myproj-1",
    "project": "myproj",
    "asked": "2026-10-12T20:14:03Z",
    "state": "question",
    "updated": "2026-10-13T06:41:22Z",
    "last_note": "which schema do you want?",
    "decisions": [ { "at": "2026-10-13T02:10:00Z", "reason": "chose postgres per the brief" } ],
    "needs_owner": true
  }
]
```

- `state`: last event that is not `note`. Vocabulary: `asked handed plan question answered blocked overnight cleanup decided done cancelled note`.
- Closed states: `done cancelled`. Needs-owner states: `plan question blocked` → `needs_owner`.
- `decisions` always an array (possibly empty). `last_note` may be `null`.

### 6.3 `hh-hub dialog <project> [<agent>[@<team root>]]`

Success (exit 0) prints one line: the pane dialog parse plus identifiers:

```json
{
  "project": "myproj",
  "session": "myproj-orchestrator",
  "pane": "%7",
  "kind": "numbered",
  "text": "────────────────────\n Do you want to proceed?\n 1. Yes\n 2. Yes, always allow\n 3. No\n Esc to cancel",
  "options": [
    { "n": 1, "label": "Yes", "detail": "", "offered": true, "saves_rule": false },
    { "n": 2, "label": "Yes, always allow", "detail": "for this folder", "offered": true, "saves_rule": true },
    { "n": 3, "label": "Type something.", "detail": "", "offered": false, "saves_rule": false }
  ],
  "cursor": null,
  "esc": true,
  "fingerprint": "9f2b...40 hex chars"
}
```

- `kind`: `numbered` (digit selects), `menu` (arrow keys + Enter; `cursor` = 1-based row), `none` (no options parsed).
- `saves_rule`: label+detail matches `always allow|don't ask again|switch to accept edits` (case-insensitive).
- `fingerprint` = sha1 hex of `text` (40 lowercase hex chars).
- Exit 3/`4` when no dialog is up or the pane is unreadable — the screen then just omits the block (and the hint tells the owner to answer in the pane).

### 6.4 `hh-hub answer ...` (stdout on success)

```json
{ "answered": true, "session": "myproj-orchestrator", "choice": "2", "option": "Yes, always allow", "dialog_gone": true }
```

`choice` echoes the `--choice` arg (`1`-`9` or `esc`); `option` is the resolved label (`Esc` for escape); `dialog_gone` false means the key was sent but a dialog is still on screen.

## 7. Actions (key/button → exact invocation, cwd = hub root)

| Trigger | Invocation | Timeout | Busy placeholder |
|---|---|---|---|
| `r` key / `refresh` button | `hh-hub status --json` + `hh-hub tasks --json` | 30 s each | — |
| `Resume · N sessions` button | `hh-hub wake <project>` (+ `--mode <permission_mode_local>` when that plugin option is a non-empty string) | 150 s | cyan `resuming…` on the card |
| `Continue` button | `hh-hub continue <project>` | 150 s | cyan `continuing…` on the need |
| dialog option button | `hh-hub answer <project> [<agent>] --choice <n> --seen <fingerprint>` | 30 s | — |
| `Esc` button | same with `--choice esc` | 30 s | — |
| `a approve plan` / `b send back` hotkey buttons (TUI), `Approve plan` / `Send back` + feedback line (web) | `hh-hub plan-answer <project> <task> <approve|sendback> [feedback]` | 30 s (TUI), 150 s (web) | cyan `answering…` on the need |
| `Seen` button | local state only (records the away-period start as seen); no subprocess | — | — |

Toasts (on completion):
- wake/continue success: `{project}: {done} (pane {stdout.trim()})` where `done` is `its orchestrator is coming up; it reports back when its team is up` (wake) or `its first line was sent` (continue).
- wake/continue failure: `{project}: {last stderr line, "hivehouse: " stripped}`.
- answer success: `{who}: answered "{option}"` + ` (the dialog is still on its screen)` when `dialog_gone` false; `who` = `{project} · {agent}` or `{project}`. Failure: `{who}: {stderr last line}`.
- plan-answer success: `{taskId}: plan approved` / `{taskId}: plan sent back`. Failure: `{taskId}: {reason}` (for example the plan prompt came back on the orchestrator's screen).
- After every action: refresh.

## 8. Notes for the Ink port

- Colors map 1:1 to Ink's named colors (`gray`, `white`, `magenta`, `red`, `yellow`, `green`, `cyan`); `bold` via `<Text bold>`.
- `wrap: truncate-end` / `truncate-start` correspond to Ink's `wrap="truncate-end"` / `"truncate-start"`; `wrap: wrap` is default wrapping.
- The engine's `Button` renders as a clickable/pressable chip; `variant="primary"` (Resume) is emphasized, `plain` (refresh, Seen) is unadorned text, default (Continue, dialog options) is in between. In a keyboard-driven port, make all of them focusable/shortcut-driven and keep labels byte-exact.
- All glyphs are literal Unicode: `● ○ ◌ ◐ ◑ ▲ ✖ ? ! • ─` and `…`.
- The `dialogs` map is populated per refresh by running `hh-hub dialog <project>` for each orchestrator with `question` or `starting.question`, and `hh-hub dialog <project> <agentRef>` for each agent with `question`; failures are silently omitted.

Skipped: the engine-specific atoms/pane plumbing and the edit/git guard in `hub.tsx` (not visible UI). Risk: `Button` styling is defined by the `claude-code` engine, not this repo — you'll need to invent the Ink visual treatment for `primary`/`plain`/default yourself; labels and behavior above are exact.
