# Hivehouse: what it actually does, and what to cut

Read: all of `bin/` (24 scripts, ~5.5k lines), all 9 skills, `rules/`, `roles/`, `docs/`, `hooks/hooks.json` + head of `hooks/hub.tsx`, `plugin.json`, CHANGELOG. Skimmed only: `hh-away-hook` (head of 1001 lines — it's one policy enforced a hundred ways), `hooks/hub.tsx` (structure, not every line), `evals/`, `workflows/`.

## 1. State model

Three roots, each with a distinct lifecycle.

**`<project>/.hivehouse/`** (`HH_STATE_DIR`, `bin/hh-lib.sh:8`) — per-project, created by `hh_ensure_state` (hh-lib.sh:147), git-excluded via `info/exclude`, refuses to operate if tracked.

| File | Holds | Lifecycle |
|---|---|---|
| `team.json` (+`.lock`) | One entry per agent: name, tmux socket/pane, pane_pid+pane_started (identity), model, effort, mode, worktree, branch, window, handoff path; orchestrator also claude_pid/claude_started, hub name | Written only under mkdir-lock via `hh_team_edit` (hh-lib.sh:363). Created by `hh-spawn`, read by everything, entry removed by `hh-spawn --close`. Survives restarts — it's the "who should be running" record. |
| `team/<agent>/role.md`, `RULES.md` | Copies of role/rules made at spawn | Written once at spawn; `--respawn` reuses these copies |
| `team/<agent>/session.json` | {session_id, transcript_path, source, at} | Written by SessionStart hook (hh-session-hook) and `hh-spawn --self`; basis for `hh-context` and `wake --resume` |
| `team/<agent>/context.json` | Claude Code's measured context window for the current session | Written continuously by `hh-statusline` |
| `team/<agent>/rotate-asked.json`, `window-guess-told.json` | Stop-hook "told once per crossing" markers | Stop hook writes/removes |
| `handoffs/<agent>.md` | The agent's persistent memory; newest START HERE block on top | Created from template at spawn; **the agent itself edits it** (model-driven). The single most important file in the system — rotation works because of it. |
| `manifest.jsonl` (+`.lock`) | Typed records of everything hivehouse created: `worktree`, `tmux`, `process`, `dir`, `file`, `remote` — never commands | Append at spawn/create; `hh-cleanup` acts on it and drops acted-on entries |
| `settings.json` | Project tighten-only overrides (permission_mode, files_per_commit, allow_attribution, overnight_ceiling_usd) | Owner-written; read by `hh-settings resolve` |
| `custom/` | User overrides of roles/rules/brief template | Read via `hh_custom_file` with trust checks |
| `rotate.log`, `rotate.out` | Rotation history and detached-rotation output | Append-only |
| `trash/<date>/` | Where `--finish` moves non-temp files instead of deleting | Grows until owner empties |
| `team/<agent>/away-mcp.json` | MCP allowlist secrets for bypass sessions (0600) | Away mode only |

**`<work folder>/.hivehouse-hub/`** (`HH_HUB_DIR`) — hub state, outside any repo. Header comment at `bin/hh-hub:5` is the authoritative map.

- `projects.json` — `{projects:[{name, home, repos[]}]}`; the hub's world model.
- `hub.json` — the hub's own session identity (claude_pid+started, pane, session_id, window).
- `tasks.jsonl` — append-only ledger; one event per line. Vocabulary (hh-hub:32): `asked handed plan question answered blocked overnight cleanup decided done cancelled note`. State of a task = last non-note event; `plan/question/blocked` = waits on owner. **This is the entire "what waits on you" data source.**
- `tasks/<id>.md` — task text + project folders + messaging instructions, handed to the orchestrator as a path.
- `memory/<project>.md`, `memory/hub-handoff.md` — hub's model-written notes and its own handoff.
- `panes/<project>.json` — a start/wake the hub launched that hasn't registered yet; stores the exact line to type, `typed` flag, sender pid. Prevents double-starts and enables `continue` after a dialog.
- `runs/<project>.json` — same pattern for overnight/cleanup lines typed into a running orchestrator.
- `name`, `answers.jsonl`, `lock` — hub name, dialog-answer audit, mkdir lock.
- Away mode adds: `away.json`, `decisions/<id>.md`, `holds/<project>`, `recovery.jsonl`, `recovery-state.json`, `hung-state.json`, `peers.jsonl`.

**`~/.hivehouse/`** (`hh_home`, overridable via `HIVEHOUSE_HOME`):

- `registry/panes/<sha(socket|pane)>.json` — pane→{project, agent, identities}. This is how the hooks answer "which agent am I?" without trusting cwd (`hh_hook_session`, hh-lib.sh:588).
- `slot.lock` + `queue/` — per-user heavy-job slot (used unless the machine slot exists).
- `custom/`, `cache/resume-*` — user-level overrides; cached transcript scans.

**Machine-level (never written by hivehouse):** `/var/lib/hivehouse/slot` or macOS equivalent (machine-wide slot, root:group 2775), `/etc/hivehouse/delegate.d/<uid>` (root-owned away-mode delegate file, created by owner pasting sudo lines `hh-hub away` prints).

**Identity scheme worth keeping:** a pane is its `pane_pid` + process start time (`hh_pane_identity`), never the bare `%N` id (tmux reuses them); a Claude is pid + start time + `hh_is_claude` argv check. This is the load-bearing invariant behind every "is it still running / safe to type" decision.

## 2. The core loop

Driven by `skills/start/SKILL.md` (166 lines). Mechanical steps in **bold-bash**, model steps in *italic*:

1. *Read project, resume existing team if `team.json` has one* → **bash: `hh-context --all`, `hh-spawn --self`, `hh-spawn --respawn`** for restart recovery.
2. *Clarify the task* (`AskUserQuestion`, `HH-CLARIFY:` prefix) — pure model.
3. *Name self, plan team, show `HH-PLAN:` (roles, models, why), wait for owner OK* — model; settings resolved mechanically via **`hh-settings resolve`** (tighten-only).
4. **bash: `hh-spawn --self --agent orchestrator`** registers the pane → **bash: `hh-spawn --agent ...` per agent** (worktree, role/rules copy, handoff, tmux window, wait-idle, pickup line).
5. *Orchestrator sends each agent its brief via `SendMessage`* (template in `rules/brief-template.md`). Agents then talk to each other directly; decisions/finished work flow to the orchestrator; only the orchestrator talks to the owner. **This routing is skill text, not code** — the only enforcement is the allowedTools list and convention.
6. *Build → review (depth chosen by orchestrator; reviewer role has the depth table) → gate.*
7. **bash: `hh-gate --log ... -- step cmd ...`**, then orchestrator reads it: **`hh-gate-verify log --commit <tip>`** + **`hh-gate-verify commits base..tip`**. Rule (gate skill): never call anything green without the log path.
8. *Land on owner's word* → **bash: `hh-push <remote> <40-hex> <branch>`** (ff-only, by hash).
9. *Rotate at every check*: **`hh-context --all`** → *agent updates START HERE block, says "done"* → **bash: `hh-rotate <agent>`** / **`hh-self-rotate`**.
10. *Finish on owner's word*: **bash: `hh-cleanup --finish --dry-run`** shown → **`hh-cleanup --finish`**.

With a hub (`skills/hub/SKILL.md`), the owner never talks to orchestrators directly: hub records the task (**`hh-hub task`** → ledger + task file), hands it over by orchestrator state (`SendMessage` if running, **`hh-hub wake`** if stopped — resumes its conversation by session id, **`hh-hub start`** if none), and relays `HH-CLARIFY`/`HH-PLAN`/`BLOCKED`/`DONE` word-for-word both ways. The relay is model discipline; the state detection and the typed lines are bash.

## 3. hh-spawn mechanics (`bin/hh-spawn`, 285 lines)

- **Validation:** agent names (`hh_is_agent_name`), model/effort enums, branch names that can't be read as options, absolute worktree path, `--mode` through `hh_check_mode` (bypass refused unless away delegate valid).
- **Worktree:** `git worktree add -q -b <branch> <wt> <base>` → `hh-manifest add worktree` first (so cleanup owns it); warns if Claude Code's folder-trust will block the agent (trust is judged by the main repo's entry, hh-lib.sh:1152).
- **Per-agent files:** copies role+rules into `team/<agent>/`, writes the handoff template if absent (hh-spawn:236).
- **Launch command** (hh-spawn:263): `exec claude [--resume <sid>] --name <project>-<agent> --model M --effort E --permission-mode M --allowedTools 'Bash(hh-slot status) Bash(hh-slot release *) Bash(hh-context *) Bash(hh-gate-verify *) Bash(hh-settings resolve *) Bash(hh-disk *)' --settings <json>`. `exec` so the pane process **is** claude (identity check). The allowedTools list is the agent's whole mechanical grant — everything else prompts.
- **Settings JSON** (`hh_agent_settings`, hh-lib.sh:521): statusLine = `hh-statusline <agent dir> <owner's statusline quoted>` — measures the window into `context.json`, then chains the owner's own statusline.
- **tmux:** `hh_open_window` (hh-lib.sh:1248) — new window in the spawner's own session when possible, else `hh-<projectkey>`; env via `-e HH_AGENT/HH_PROJECT/HIVEHOUSE_HOME`; away-marker vars scrubbed from the tmux global environment so they can't leak to other panes.
- **Registration order matters:** manifest add → registry file → team.json upsert ("what is on the manifest can be cleaned up").
- **Idle detection** (`wait_idle`, hh-lib.sh:456): 1/s capture via `capture-pane -p -e -J`, cleaned by a perl filter that strips ANSI + dim runs + nbsp (`hh_pane_clean`). Idle = screen unchanged for N seconds AND last lines show an empty prompt (`❯` with nothing after) AND none of `HH_DIALOG_TEXT` phrases ("Do you trust", "Esc to cancel", …) inside the prompt box region. Dialog → exit 5, nothing typed. Working-line regex `HH_WORKING_RE` matches Claude Code's spinner line for hang detection. **All of this is tied to the Claude Code 2.1.x terminal UI and says so in the comments.**
- **Typing:** `send-keys -l '<pickup line>'` then `Enter`. The pickup line (`hh_pickup_line`, hh-lib.sh:608) is the contract: "You are X. Read <handoff> from the top: its START HERE block is your prompt... Report to <orchestrator>. Wait for its first message."
- **Never answers dialogs.** That's a deliberate boundary — dialog answering exists only in `hh-hub answer`, with fingerprint verification.

## 4. The gate

**`hh-gate`** (72 lines): validates step names, refuses a git-tracked log path, writes header `# hh-gate steps: a,b,c head=<sha> dirty=<0|1>`, takes the slot itself (`hh-slot acquire --wait`, released in EXIT trap), runs each step as `bash -c` in its own process group (`set -m`) with output to `<log>.d/<name>.log`, appends `<name> exit <n>` per step, **runs every step even after a failure**, and on INT/TERM/HUP kills the step's whole group and writes no line — so a partial gate is detectably partial.

**`hh-gate-verify log`** (hh-gate-verify:23): GREEN only if ≥1 step line, all `exit 0`, no name twice, every header-named step and every `--expect` name present. With `--commit <sha>` the header's head must equal the sha and dirty=0 — **a gate on a dirty tree or a stale log vouches for nothing**. A gate with no step lines is RED, not vacuously green.

**`hh-gate-verify commits <base>..<tip>`** (:74): all flags required (nothing loosened by omission). Per commit: non-empty subject, conventional-style regex when asked, ≤ N files vs first parent (merges counted against git's own re-merge via `merge-tree --write-tree` — nice touch), attribution-trailer deny, empty range is RED.

Verdict: this pair is ~200 lines, fully mechanical, and directly enforces "nothing lands unverified." Keep nearly as-is.

## 5. Context rotation

- **Measurement:** `hh_transcript_used` (hh-lib.sh:543) reads the last main-conversation assistant usage line from the session's `.jsonl` transcript (input+cache+output tokens). Window source priority (`hh-context` wsrc): Claude Code's own measurement in `context.json` > `--window` arg > team.json record > assumed 1M (always *labeled* "assumed"; over-window tokens print "N tokens (window unknown)", never a fake >100%).
- **Trigger:** the Stop hook (`hh-stop-hook`) fires at `rotate_at_percent` (default 50), once per crossing, and blocks the stop with "update your START HERE block, then ROTATE READY / run hh-self-rotate."
- **Mechanism:** `hh_rotate_pane` (hh-lib.sh:481) — wait idle → re-verify pane identity → type `/clear` → settle → detect `/clear` left on the input line and retype once → wait idle → re-verify → type the pickup line. Identity is re-checked before **every** send because the idle wait can last minutes. `hh-self-rotate` is the same detached via nohup so it survives the orchestrator's own tool call ending; `hh-hub rotate` does it for the hub with a template pickup line.
- The handoff content itself is model work (`skills/handoff`); the bash half is dumb and safe.

## 6. Bloat to drop in a rewrite (opinionated)

Ordered by size of win:

1. **Away/delegate mode — the single biggest bloat source, roughly 40% of the codebase.** The root-owned delegate file with 4 versioned formats and sudo-paste flow (hh-lib.sh:887–1122, ~230 lines), `hh-away-hook` (1001-line shell parser trying to police Bash tokens — its own comments admit `$'\x67'it push` gets through), `hh-hub away/back/decide/hold/recover` (~500 lines of hh-hub), hung-session killer with locale-fingerprinted ps output, root-owned-jq discovery, MCP-secret file shuffling, peers, beats, "decided while you were away." This is a different product ("unattended autonomy with a security model") glued onto the team runner. The overnight skill depends on it. **Drop all of it; if you want unattended runs later, design them fresh on top of a working v2.**
2. **`hh-remote-sync`** (288 lines) — moving teams to remote hosts for the night. Away-mode adjacent. Drop.
3. **The machine slot** — root-owned 2775 directories, admin setup lines, cross-user queue tickets, takeover guards (hh-lib.sh:255–392, hh-slot). Keep the *idea* (one heavy job at a time) as a per-user mkdir lock with a simple FIFO; drop machine sharing, `HH_SLOT_LOCAL`, and the setup ceremony.
4. **Locale-compat identity records** — dual `lstart`/`lstart_c` fields plus language-free fingerprinting (`hh_lstart_fp`) exist only so 0.2.0 and 0.3.0 locks interoperate. A rewrite records `LC_ALL=C ps` once. Saves ~80 lines and a whole class of comments.
5. **`bin/guard/{rm,find,rsync}` PATH guards** — wrapper binaries refusing to delete `/`, `$HOME`, repo roots, cloud-sync roots. Claude Code already has permission prompts; this is defense against a problem the permission system owns. Drop (or keep as an optional extra).
6. **`custom/` override machinery with trust checks** (`hh_custom_file`, `hh_custom_safe`) — three-level file resolution with ownership/link/mode validation, plus "don't read custom/ while away" logic. In v2: project file else plugin file, one line. Most users never override.
7. **Option-placeholder plumbing** (`hh_option_value`, `${user_config.X}` unfilled detection) — a plugin-harness workaround leaking into every skill's boilerplate ("if it still reads literally, run hh-settings option X"). Keep one tiny resolver; strip the repeated paragraph from every skill.
8. **21 userConfig options → ~6.** Drop the three `window_*` (measurement made them near-dead), `remote_hosts`, `dedicated_hosts`, `away_mcp_allow`, `hub_max_starts_per_day`, `heartbeat_minutes`, `overnight_ceiling_usd`, `hub_auto_start`. Keep: model_builder/reviewer, effort_builder/reviewer, permission_mode_local, rotate_at_percent, files_per_commit, commit_style, allow_attribution, min_free_gb — and even those could shrink.
9. **Recovery exotica:** unregistered-orchestrator discovery via `~/.claude/sessions/*.json` (`live_orchestrator`), resumable-transcript scanning with fingerprint caching (`hh_resume_root`/`hh_resume_candidate`, ~60 lines), hub-takeover prevention, `hh-hub naming`. v2 answer to "orchestrator wasn't registered": tell the owner to register it. Respawn-from-record already covers restarts.
10. **Skills:** 9 → 4. Drop `overnight` (away-mode), `bubble-review` (fold the 9 categories into the reviewer role — they already are), `review-plan`, `doc-updater`. Fold `handoff` into RULES.md (it's one template + one habit). Keep `start`, `hub`, `gate`, `cleanup`.
11. **Roles:** 5 → 2 (implementer, reviewer). Architect/fixer/product are one-paragraph personas the orchestrator can inline.
12. **Repo debris:** `evals/`, `workflows/docs-health-check.workflow.js`, `types/index.d.ts`, icon, ~60 test scripts. Rewrite tests around spawn/idle/gate/cleanup only — but note the existing dialog/working-line ANSI fixtures (`tests/fixtures/`) are gold; steal them.
13. **The `hooks/hub.tsx` screen (839 lines)** — the *feature* is core (it's your #1 v2 requirement), the implementation is heavy: a TSX module with atoms polling `hh-hub status` every 20s. Since `hh-hub status --json` already produces everything the screen shows, v2 could render it as a dumb terminal dashboard (even a `watch`-style pane) — but if the Claude Code module API is the only way to get buttons, keep a *minimal* module: status table + Resume/Continue/dialog-answer buttons, nothing else.

Also worth naming as **accidental complexity, not bloat**: the extreme defensiveness (fail-closed exit codes, bash 3.2 compat, "never run the program named by the first word on PATH" comments) is mostly *justified* for code that types into panes and kills processes — but a rewrite targeting bash ≥4 and Linux-only can delete the compat shims and half the comments.

## 7. Proposed v2 minimal feature set

Five mechanics + three skills, each mapping to existing code to salvage:

1. **Spawn/team** — `hh-spawn` (--self, --agent, --respawn, --close) with worktree, role/rules copy, handoff template, launch command with allowedTools, registry + team.json with pid+starttime identity, wait-idle, pickup line. Salvage: hh-spawn nearly whole; from hh-lib.sh keep identity helpers, `hh_open_window`, `wait_idle`/pane-clean/dialog-phrase detection, `hh_pickup_line`, `hh_team_edit` mkdir-lock. **This is the crown jewel; change almost nothing conceptually.**
2. **Hub status + screen** — `hh-hub init/add/status/task/log/tasks` (projects.json + tasks.jsonl ledger + task files), `hh-hub self`. One `status --json` powers both the greeting and the screen. Drop: discover ceremony, away, holds, recover, naming.
3. **Wake/answer** — `hh-hub wake` (resume orchestrator by session id, fixed BACK line), `hh-hub start <project> <task>` (the `panes/<project>.json` pending-record pattern with typed flag — genuinely good design, keep), `hh-hub continue`, `hh-hub dialog`/`answer` with fingerprint (dialog *read* plus numeric-choice send only; drop menu-arrow navigation if you want a cut line).
4. **Gate before land** — `hh-gate` + `hh-gate-verify log|commits` as-is, plus `hh-push` by full hash (37 lines, worth it).
5. **Rotation** — `hh-statusline` (window measurement), `hh-context`, Stop-hook reminder, `hh-rotate`/`hh-self-rotate` via `hh_rotate_pane`. Transcript-based measurement is the right design; keep the "assumed window is always labeled" rule.
6. **Cleanup** — manifest (kinds: worktree, tmux, process only) + `hh-cleanup --finish [--dry-run]` with re-judgment at act time and trash-not-delete. Drop dir/file/remote kinds.
7. **Slot** — per-user mkdir lock with `--wait` FIFO, nothing root-owned.
8. **Skills:** `start` (trim the away/hub-away sections; keep the plan→OK→spawn→brief→gate→land→cleanup spine), `hub` (relay mode only: task ledger, hand-over by state, word-for-word carry, dialog surfacing), `gate`, `cleanup`. **RULES.md trimmed** to: git rules (no stash, worktrees only, push by hash), one-heavy-job, paid/outward steps need a word each time, verdict-first reporting, handoff format.
9. **Hooks:** SessionStart (hub detection + session record), Stop (rotate reminder). Two hooks, not four.

Estimated shape: ~1.5–2k lines of bash (vs 5.5k), 4 skills (vs 9), 2 roles (vs 5), 2 hooks (vs 4+TSX), no sudo anything, no security-model claims.

**Not checked / risks:** I read `hh-away-hook` and `hooks/hub.tsx` only structurally — if you keep any away-mode or screen feature, read them fully first. The idle/dialog detection is pinned to Claude Code 2.1.x's terminal UI; any rewrite inherits that coupling (the ANSI test fixtures in `tests/fixtures/` document the exact screens — preserve them).
