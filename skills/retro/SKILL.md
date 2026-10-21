---
name: retro
description: Review a landed task and propose edits to the team's roles, rules, and skills. Use after a task reaches done, so the team learns from how the run went.
---

# Retro

Run after a task lands, before cleanup. You read how the run went and propose
edits to the team's steering: `roles/`, `rules/`, `skills/`.

Read first:

- `.hive/handoffs/*` — what each agent remembered. Gaps and stale START HERE
  blocks are findings.
- `.hive-hub/decisions.jsonl` — what the owner and the orchestrator decided,
  and what the watchdog auto-answered.
- The gate log and its `<log>.d/` step logs — what the gate caught, and what
  slipped past it.

Look for:

- **Automated checks**: a mistake a check could have caught gets a check, not
  a rule. A check that exists but nobody wired into the gate is the finding,
  not a new check.
- **Rules**: reserve `rules/RULES.md` for judgement calls. A mechanical
  pattern never becomes a rule.
- **Roles**: a brief that kept needing clarification means the role file is
  unclear.
- **Skills**: a step the orchestrator reinvented means a skill is missing or
  wrong.

Propose, never edit in place. The edits land as their own change through the
same path as any work: gate, then the owner's word. Before a retro-driven
edit lands, tag the current state with `tools/checkpoint.sh` (see
`rules/RULES.md`). Those paths live in the hive-v2 repo, not in your project
worktree — run the checkpoint and make the edits from a hive-v2 checkout.
Report verdict first: what to change, why, and what you
deliberately left alone.
