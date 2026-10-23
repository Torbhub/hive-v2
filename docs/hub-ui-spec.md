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

   Every task need shows its reason as a detail line under row 1 (web: gray, small): the task's `last_note`, or `no reason recorded` when the note is empty.

   A stale task need also shows the word `stale` in amber after `words`, and a **Nudge** button inside the card, below its action row. Stale means the task is in `plan`, `question`, `blocked`, or `handed` and its `last_progress_at` (or its `updated` stamp when no progress was ever reported) is more than 4 hours old (`STALE_MS`). Nudge POSTs `/api/message` with `{project, text: "<taskId>: owner asks for status"}`. While the send runs the button swaps to cyan `nudging…`. The stale marker and Nudge are web-only.

   A `plan` task carries the `plan` action (`project`, `taskId` set) and its checkpoint list: one line per checkpoint, gray, small, `{id}: {desc} (~{etaMin}m)`, above the verdict buttons. If its project's orchestrator has a live question, the first such task also absorbs it: the dialog block keyed `"<project>"` renders on this card and rule 3 is skipped for that project (one card, one answer). With no dialog, the web UI renders the plan action: an **Approve plan** button and a **Send back** button with an optional feedback line; both POST `/api/plan-answer`, which types the verdict as the orchestrator's next line and logs the task `answered` (approve) or `handed` (send back). With no dialog, the TUI renders the same action as two hotkey **Button**s (`paddingLeft: 2`, `columnGap: 1`): `a approve plan` (hotkey `a`) and `b send back` (hotkey `b`). When several plan needs show at once, a hotkey presses the first one. `b` swaps the buttons for a one-line feedback prompt: white `feedback: `, then the typed text in white (gray `what should change? (optional)` while the line is empty), then an inverse-space cursor. Enter sends, Esc cancels, and an empty line means no feedback. While the prompt is open, button hotkeys and Enter stay inert. While the answer runs, the card shows cyan `answering…`. The checkpoint list and the reason line are web-only. The TUI keeps the verdict row only.

   A `blocked` or `question` task carries the `resolve` action (`project`, `taskId` set), web-only: a **Rebrief** button and a **Cancel** button. Rebrief swaps both buttons for a one-line input (placeholder `the new brief`, aria-label `new brief for <taskId>`), a **Send** button that stays disabled until the line holds text, and a **Back** button that abandons the rebrief and brings the buttons back. Send and Cancel POST `/api/task-resolve` with `{project, task, action, note?}`: `cancel` moves the task to `cancelled`, `rebrief` moves it back to `asked` with the note as its new brief. While the call runs the card shows cyan `resolving…`. The TUI has no resolve action.
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
- when `name` is set (web only): gray `  {project}:{name}` — the tmux window the orchestrator lives in.
- when state `unregistered` and `pane` set: gray `  pane {pane}` (two leading spaces).
- when `context` is a number: `  {context}%` — color: **gray** if `context_assumed`, else **yellow** if `context >= rotateAt` (plugin option `rotate_at_percent`, default **50**), else **green**.
- when `context_unknown`: gray `  context unknown`.
- when state is `running` (web only): an **Interrupt** button (§13), spaced off the text.

**`agents` row**:
- no agents: gray `none`.
- else one row: for each agent, one of these glyphs **followed by a trailing space** (so two hollow dots don't read as one wide sign): `●` **green** (running), `○` **yellow` (stopped), `✖` **red** (wedged), `?` **red** (unknown/unrecorded). Then white ` {up} of {total}` (leading space; `up` = running count).
- If any agents are not running, a second line, **yellow**: `{ref} {state}` joined with `, ` (e.g. `fixer stopped, reviewer@/wt/repo unknown`).
- Web only, a third line, gray, small: the tmux window name of every agent, `{project}:{agent name}` joined with `, `.
- Web only, when any agent is running: a wrap line of **Interrupt {ref}** buttons, one per running agent (§13).

**`tasks` row** — white, one string:
`{open_tasks} open` then optional suffixes, in order:
- ` · {n} overnight run` / ` · {n} overnight runs` (tasks of this project in state `overnight`)
- ` · {n} cleanup` (state `cleanup`)
- ` · {n} done today` (state `done`, `updated` same local day)

**`progress` row** (web only, only when the project has tasks with a checkpoint list): one line per such task in a non-closed state, small text, in ledger order. A `done` or `cancelled` task drops off the row.
- `{taskId}` — white, medium
- `{done}/{total} checkpoints` — zinc. `done` counts checkpoints with a terminal progress event (`ok`, `fail`, `skip`)
- `on {checkpoint}` — zinc, only when a checkpoint's latest event is `started`
- `last progress {ago} ago` or `no progress yet` — gray, from `last_progress_at`
- `failed: {ids}` — **red**, only when checkpoints hold a `fail`
- `stale` — amber, plus a **Nudge** button (same behavior as the need card), only when the task is stale per §1.4

**`folders` row** — one line per repo, white, `wrap: truncate-end`:
`{folder}` + (when `changed` truthy) `  {changed} changed`. (`branch` and `kind` are **not** shown on screen.)

**Attach hint** (web only): the card ends with one gray mono line, `attach: tmux -L hive-v2 attach`. The window names above are what to attach to.

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
`wedged` marks a pane the watchdog found frozen on a spinner with a stale wire log.
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

type HubAgentState = 'running' | 'stopped' | 'unknown' | 'unrecorded' | 'wedged'
// wedged: pane alive but frozen on a spinner with a stale wire log;
// the watchdog restarts it when a session exists to resume

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
  checkpoints?: { id: string; desc: string; etaMin: number }[]  // from the latest plan event
  progress?: Record<string, { status: 'started' | 'ok' | 'fail' | 'skip'; note?: string; at: string }>
  last_progress_at?: string | null   // ISO of the latest progress event
  plan_approved?: boolean
  checkpoint_accepts?: Record<string, string>  // failed checkpoint id → ISO of owner accept
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

A task in a closed state (`done`, `cancelled`) keeps its checkpoint trail in the data, but the project card's progress row (§1.7) drops it.

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
    "needs_owner": true,
    "checkpoints": [ { "id": "a", "desc": "write it", "etaMin": 5 } ],
    "progress": { "a": { "status": "started", "at": "2026-10-13T06:30:00Z" } },
    "last_progress_at": "2026-10-13T06:30:00Z",
    "plan_approved": false,
    "checkpoint_accepts": {}
  }
]
```

- `state`: last event that is not `note`. Vocabulary: `asked handed plan question answered blocked overnight cleanup decided done cancelled note progress planaccept`.
- Closed states: `done cancelled`. Needs-owner states: `plan question blocked` → `needs_owner`.
- `decisions` always an array (possibly empty). `last_note` may be `null`.
- `checkpoints` comes from the latest `plan` event and resets on a fresh plan. `progress` maps checkpoint id to its latest progress event. `last_progress_at` is the newest progress stamp, or `null` when nothing was reported.

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
| `Add project` row (web only, §10) | POST `/api/project` with `{name, path}` | 30 s | — |
| `Send` message row (web only, §11) | POST `/api/message` with `{project, text}` | 150 s | cyan `sending…` on the card |
| `Rebrief` / `Cancel` on a blocked or question need (web only) | POST `/api/task-resolve` with `{project, task, action, note?}` | 30 s | cyan `resolving…` on the need |
| `Nudge` on a stale need or progress row (web only) | POST `/api/message` with `{project, text: "<taskId>: owner asks for status"}` | 150 s | cyan `nudging…` on the need or row |
| `Interrupt` / `Interrupt {ref}` buttons (web only, §13) | POST `/api/interrupt` with `{project, agent?}` | 150 s | — |
| (workers, completeness) | POST `/api/progress` with `{project, task, checkpoint, status, note?}` | 30 s | — |
| `Seen` button | local state only (records the away-period start as seen); no subprocess | — | — |

`/api/task-resolve` validates, in order: `action` is `cancel` or `rebrief`, a rebrief carries a non-empty `note` (the new brief, whitespace-folded, capped at 4000 characters, no control characters — the fold already turns tab and newline into spaces, so what remains is hostile or broken input), the task exists and belongs to the project, and it is not already `done` or `cancelled`. `cancel` appends a `cancelled` task event (note, or `cancelled by the owner`). `rebrief` appends an `asked` event with the note, and the fold clears the old plan's checkpoints, progress, approval, and progress clock. Both append an owner decision (`cancelled {task}` / `rebriefed {task}: {note}`), and the logged rebrief summary holds at most the first 120 characters of the note (same cap as an owner message, §11). Every refusal is a 400 `{ok: false, detail}` and shows as a toast. Ledger appends only: no pane is touched, so a dead orchestrator never blocks the call.

`/api/progress` is a thin pass-through to the hub progress function: `task` and `checkpoint` are required, the task must exist and belong to the project, `status` is `started|ok|fail|skip`, the checkpoint must be in the task's plan, and a `skip` needs a note saying why. Success appends one `progress` event and answers `{ok: true}`. Both endpoints serialize per project like the other actions.

Toasts (on completion):
- wake/continue success: `{project}: {done} (pane {stdout.trim()})` where `done` is `its orchestrator is coming up; it reports back when its team is up` (wake) or `its first line was sent` (continue).
- wake/continue failure: `{project}: {last stderr line, "hivehouse: " stripped}`.
- answer success: `{who}: answered "{option}"` + ` (the dialog is still on its screen)` when `dialog_gone` false; `who` = `{project} · {agent}` or `{project}`. Failure: `{who}: {stderr last line}`.
- plan-answer success: `{taskId}: plan approved` / `{taskId}: plan sent back`. Failure: `{taskId}: {reason}` (for example the plan prompt came back on the orchestrator's screen).
- task-resolve success: `{taskId}: cancelled` / `{taskId}: back to asked with the new brief`. Failure: `{taskId}: {reason}` (for example the task is already done).
- nudge success: `{taskId}: the orchestrator was asked for status`. Failure: `{taskId}: {reason}` (for example the pane is gone).
- message success: `{project}: the message was typed to its orchestrator`. Failure: `{project}: {reason}` (for example the pane is gone or a dialog waits on its screen).
- interrupt success: `interrupted {target}` where `target` is the agent ref or `{project}-orchestrator`. Failure: `{who}: {reason}` with `who` = `{project} · {agent}` or `{project}` (for example the pane is gone).
- After every action: refresh.

## 8. Notes for the Ink port

- Colors map 1:1 to Ink's named colors (`gray`, `white`, `magenta`, `red`, `yellow`, `green`, `cyan`); `bold` via `<Text bold>`.
- `wrap: truncate-end` / `truncate-start` correspond to Ink's `wrap="truncate-end"` / `"truncate-start"`; `wrap: wrap` is default wrapping.
- The engine's `Button` renders as a clickable/pressable chip; `variant="primary"` (Resume) is emphasized, `plain` (refresh, Seen) is unadorned text, default (Continue, dialog options) is in between. In a keyboard-driven port, make all of them focusable/shortcut-driven and keep labels byte-exact.
- All glyphs are literal Unicode: `● ○ ◌ ◐ ◑ ▲ ✖ ? ! • ─` and `…`.
- The `dialogs` map is populated per refresh by running `hh-hub dialog <project>` for each orchestrator with `question` or `starting.question`, and `hh-hub dialog <project> <agentRef>` for each agent with `question`; failures are silently omitted.

Skipped: the engine-specific atoms/pane plumbing and the edit/git guard in `hub.tsx` (not visible UI). Risk: `Button` styling is defined by the `claude-code` engine, not this repo — you'll need to invent the Ink visual treatment for `primary`/`plain`/default yourself; labels and behavior above are exact.

## 9. Stretchtext (web UI only)

Decision summaries can carry stretchtext markup: `{{short|long}}`. The web UI parses it (`src/stretch.ts`) and renders each closed stretch as its `short` form — dotted underline, brighter than the surrounding summary text, `role="button"` with `aria-expanded`. A click swaps the span to its `long` form inline (long forms can hold further stretches); a second click collapses back to `short`. While any stretch in a row is open, the row wraps instead of truncating. Text without a `|`, unclosed stretches, and braces inside code spans or fences render as plain text.

Every expand (never a collapse) fires a fire-and-forget POST to `/api/stretch-opened` with `{short, pane}` (`pane` = the decision's task id, else its project). The endpoint appends `{"ts": <ms epoch>, "short": "...", "pane": "..."}` as one JSON line to `~/.kimi-code/stretch-opened.jsonl` (override with `HIVE_STRETCH_LOG`), which the stretchtext skill reads to know what the owner already opened. UI failures are swallowed; the server logs its own failures. `short` and `pane` are capped at 200 characters. The Ink screen does not parse the markup; raw braces show there.

## 10. Add project row (web UI only)

The web screen ends its project list with an add-project row, rendered after the last project card and before the footer (so it is also the answer to the §1.6 empty state). One row: a `name` input (placeholder `name`, aria-label `new project name`, fixed narrow width), a `path` input (placeholder `/absolute/path`, aria-label `new project path`, grows), and a primary **Add project** button. Both inputs are mono, small. Enter in either input submits. The button stays disabled until both fields hold text.

A submit POSTs `/api/project` with `{name, path}` (trimmed). The server checks, in order: the name matches the CLI rule (`/^[a-z][a-z0-9-]{0,31}$/`), `path` is absolute, it is a directory, and it holds a git repo (a `.git` directory, or a `.git` file that starts with `gitdir:` — a worktree pointer). A duplicate name is refused. Optional `mode` (`ask|yolo|auto`) and `approvals` (`manual|safe|smart`) fields are validated the same way when present. The form does not send them: the project card's toggles set them after the add. Success writes `projects.json` exactly like `hive hub add` and answers `{ok: true, name}`. Any refusal is a 400 `{ok: false, detail}` and shows as a toast. On success the row clears, a `{name}: project added` toast shows, and the view refreshes so the new card appears. All `projects.json` writes (`/api/project`, `/api/mode`, `/api/approvals`) serialize on one key, so their read-modify-write cannot race.

The Ink screen has no add-project row (it has no task-creation row either): registration stays a web flow, the TUI stays a monitor.

## 11. Owner message row (web UI only)

Each project card holds a message row above its new-task row. One row: a text input (placeholder `message the orchestrator…`, aria-label `message for {project}`, mono, small) and a **Send** button. Enter in the input submits. The button stays disabled while the input is blank, and the shared one-action-at-a-time gate disables it while any action runs. While this project's send is in flight, the row shows cyan `sending…`. On success the input clears. The row shows on every card, even with no team. The server answers a refusal and the refusal shows as a toast.

A submit POSTs `/api/message` with `{project, text}`. The default target is the project's orchestrator. An optional `agent` field names a team agent (`name`, or `name@<worktree>` when the name is ambiguous). The server checks, in order: `text` trimmed and whitespace-folded is non-empty, it is capped at 4000 characters, it holds no control characters (the fold already turns tab and newline into spaces, so what remains is hostile or broken input), the project exists, the target is in `team.json`, and the target has a recorded pane whose identity (pid plus start time) still matches the live pane. A dialog on the target's screen refuses with `answer it first`. The typed line is `Owner: {text}` and the send reuses the spawn typing path, so the pane identity is verified again before the keys land. Success answers `{ok: true, typed}` and appends the message to `decisions.jsonl` with `by: 'owner'`. The logged summary holds at most the first 120 characters of the text. A send that cannot be logged answers an error, not a success. Every refusal is a 400 `{ok: false, detail}` and shows as a toast.

The Ink screen has no message row: messaging a live agent stays a web flow, the TUI stays a monitor.

## 12. Decisions feed (web UI only)

The web screen shows a `Decisions` section between the empty state and the project cards, only when the filtered feed is non-empty. Header: gray, small, uppercase, `Decisions`. One row per entry, newest first, capped at 8: a gray dot, the entry's `task` (else its `project`) in white, then the `summary` (stretchtext per §9), and `ago(entry.at)` in gray on the right.

The feed is signal only. The server scans the newest 64 entries of `decisions.jsonl` and drops the noise before capping (`feedKeep` in `src/view.ts`):

- `by: 'watch'` rows whose summary starts with `auto-approved "Approve once"` (tier-1 auto-approvals)
- `by: 'owner'` rows whose summary starts with `answered "Approve once"`

Everything else stays: plan approvals, send-backs, rebriefs, cancels, owner messages, non-trivial watch decisions, wedged marks, deaths. The web UI renders what the view carries and never filters itself. The TUI has no decisions feed.

## 13. Interrupt (web UI and CLI)

`hive interrupt <project> [agent]` and the web **Interrupt** buttons send Escape to a live pane. A running turn stops mid-turn and the session survives, so the owner can steer the agent after with a message or a dialog answer. Killing the pane loses the session and its context. On an open dialog Escape is the dismiss key, and the dialog block's own Esc button covers that case, so a need card has no Interrupt button.

The target is the project's orchestrator by default. A starting orchestrator not yet registered is reached through its pending pane. An optional `agent` names a team agent (`name`, or `name@<worktree>` when the name is ambiguous). The checks run in order: the project exists, the target resolves in `team.json`, the pane is live, and its identity (pid plus start time) still matches the record. The send goes through the tmux layer, which re-verifies the pane identity before the key lands. Success answers `{ok: true, target, pane}` and appends `interrupted {target}` to `decisions.jsonl` with `by: 'owner'`. Every refusal is a 400 `{ok: false, detail}` and shows as a toast. The endpoint serializes per project like the other actions. The Ink screen has no interrupt buttons: interrupting stays a web and CLI flow.
