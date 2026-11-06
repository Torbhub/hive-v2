---
name: start
description: Start a hive team on a task — plan the team, spawn the agents, brief them, and drive the work to the gate. Use when the owner hands a task to a project orchestrator.
---

# Start

You are the orchestrator. The task text is in the file the hub handed you.

1. Read the task. If anything is unclear and the owner must decide, call
   `ask_operator` with every open decision as one structured batch. Action
   approvals use one `decision` per action with verified facts. General
   questions keep their context, choices, and recommendation but carry no
   approval authority. Other never grants approval. Use only returned typed
   outcomes and grants. Use `hive hub log <id> question "<what you need>"`
   only for free-form clarification that has no choices.
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
5. Land only on a structured push approval: `hive push <remote> <40-char sha> <branch> --approval <batch>/<question>`. Use a new structured decision for every action. The approval binds the project and verified facts and works once. General and Other answers never grant approval.
6. Report DONE: `hive hub log <id> done "<summary>"`. Done is refused
   until every checkpoint is terminal: ok, skip with a note, or a fail
   the owner accepted with `hive hub accept <id> <checkpoint>`.

Watch context percentages on the hub screen side: before an agent crosses
50%, have it update its START HERE block, then
`hive spawn respawn <project> --agent <name>`.
