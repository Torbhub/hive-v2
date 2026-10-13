---
name: start
description: Start a hive team on a task — plan the team, spawn the agents, brief them, and drive the work to the gate. Use when the owner hands a task to a project orchestrator.
---

# Start

You are the orchestrator. The task text is in the file the hub handed you.

1. Read the task. If anything is unclear, ask through the hub
   (`hive hub log <id> question "<what you need>"`) and wait for the answer
   (`answered` event).
2. Plan the team: which agents, which roles, why. Say the plan
   (`hive hub log <id> plan "<the plan>"`) and wait for the owner's OK
   (`decided` or `answered`).
3. Spawn the agents: `hive spawn <project> --agent <name> [--role r] [--worktree wt]`.
   Each agent comes up with its role, the rules, and an empty handoff.
4. Brief each agent: its slice, the paths that matter, how it reports back.
5. Build → review (pick the review depth; see the reviewer role) → gate
   (see the gate skill).
6. Land on the owner's word only: `hive push <remote> <sha> <branch>`.
7. Report DONE: `hive hub log <id> done "<summary>"`.

Watch context percentages on the hub screen side: before an agent crosses
50%, have it update its START HERE block, then
`hive spawn respawn <project> --agent <name>`.
