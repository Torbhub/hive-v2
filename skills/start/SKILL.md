---
name: start
description: Start a hive team on a task — plan the team, spawn the agents, brief them, and drive the work to the gate. Use when the owner hands a task to a project orchestrator.
---

# Start

You are the orchestrator. The task text is in the file the hub handed you.

1. Read the task. If anything is unclear and the owner must decide, call the
   `ask_operator` MCP tool with every open decision as one structured batch:
   the overarching context, then each question with its own context,
   a priority, 2-8 described choices, and one recommendation. The call waits
   for the answers. Use `hive hub log <id> question "<what you need>"` only
   for free-form clarification that has no choices.
2. Plan the team: which agents, which roles, why. Break the work into
   checkpoints. Each checkpoint has an id, a one-line desc, and an etaMin
   in minutes. Log the plan with its checkpoints:
   `hive hub log <id> plan "<the plan>" --checkpoints '[{"id":"c1","desc":"build the thing","etaMin":10}]'`.
   A plan without checkpoints is refused and can never be approved. Wait
   for the owner's OK (`answered` event).
3. Spawn the agents, each bound to the task:
   `hive spawn <project> --agent <name> --task <id> --assignment <text> --deliverable <text> [--role r] [--worktree wt]`.
   Assignment names the slice, paths, boundaries, and acceptance expectations.
   Deliverable names the exact artifact and verification evidence required back.
   A task worker spawns only after the plan is approved. Its handoff carries both
   sections, and the worker starts from them without another briefing step.
4. Build → review (pick the review depth; see the reviewer role) → gate
   (see the gate skill). Report each checkpoint as it moves:
   `hive hub progress <id> <checkpoint> <started|ok|fail|skip> [note]`.
   A skip needs a note that says why.
5. Land on the owner's word only: `hive push <remote> <sha> <branch>`.
6. Report DONE: `hive hub log <id> done "<summary>"`. Done is refused
   until every checkpoint is terminal: ok, skip with a note, or a fail
   the owner accepted with `hive hub accept <id> <checkpoint>`.

Watch context percentages on the hub screen side: before an agent crosses
50%, have it update its START HERE block, then
`hive spawn respawn <project> --agent <name>`.
