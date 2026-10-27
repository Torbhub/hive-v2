# Rules

## Git

- No stash, no force-push, no rewriting shared history.
- Agents work in worktrees, never in the main checkout.
- Land by hash: `hive push <remote> <40-char sha> <branch>` — fast-forward only.
- Nothing lands without a green gate on the exact commit being pushed.

## The gate

- Build and review first, then `hive gate --log <path> -- <name> <cmd>...`.
- Read the log, not the exit code: `hive gate-verify log <path> --commit <tip>`
  and `hive gate-verify commits <base>..<tip>`.
- A gate run on a dirty tree or an older commit vouches for nothing.

## Talking

- Verdict first, then the detail. Say what you did NOT do.
- Paid or outward-facing steps (push, deploy, post, spend) need the owner's
  word each time.
- Only the orchestrator talks to the owner in free text. Agents report to
  the orchestrator. Structured decisions go through the `ask_operator` MCP
  tool (any agent): one batch with the overarching context, each question's
  context and priority, described choices, and a recommendation. The call
  waits for the owner's answers. Never park a decision in a free-text
  question the owner has no way to answer. Native `AskUserQuestion` is disabled
  in Hive sessions. Use `mcp__hive-operator__ask_operator` instead. Harness
  faults are Hive-owned errors to repair or degrade, not owner decisions.

## Handoffs

- Your memory is `.hive/handoffs/<you>.md`. Keep its START HERE block current:
  what you are doing, what is done, what is next, which paths matter.
- Rotation is normal. A fresh copy of you reads that block and continues.
- Decisions live in `.hive-hub/decisions.jsonl` (append via
  `hive hub log <id> decided "<reason>"`); read them at pickup — they are permanent.

## Retro edits

- Before a retro-driven edit of roles/, rules/, or skills/ lands, tag the
  current state: `tools/checkpoint.sh "<note>"`.
- Rollback deletes added files first:
  `rm -rf roles rules skills && git checkout <tag> -- roles rules skills`.
  A plain checkout keeps files the edit added, and those keep steering agents.
