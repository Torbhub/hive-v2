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
   in minutes. Log the plan with its checkpoints and root contract:
   `hive hub log <id> plan "<the plan>" --checkpoints '[{"id":"c1","desc":"build the thing","etaMin":10}]' --contract '<root-contract-json>'`.
   Use the canonical examples below. Show the root contract and `plan_digest` in the owner approval request.
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

## Canonical root contract examples

Use these shapes for build and research plans. Replace the values with the
actual task values. Keep explicit empty scopes.

Build contract:

```json build-contract
{
  "schema_version": 1,
  "objective": "Ship the reviewed artifact.",
  "consumer": "release-owner",
  "deliverable": "A bounded diff and test evidence.",
  "kind": "build",
  "acceptance": [
    {
      "id": "diff",
      "predicate_id": "git_diff_scope",
      "version": 1,
      "configuration": {},
      "required_evidence": ["diff-evidence"],
      "required": true
    }
  ],
  "provenance": {
    "kind": "code",
    "repository": "/work/demo",
    "base_revision": "0000000000000000000000000000000000000000",
    "artifact_revision": "1111111111111111111111111111111111111111"
  },
  "write_scope": ["src"],
  "action_scope": [],
  "budget": {
    "depth": 1,
    "active_children": 4,
    "active_project_records": 8,
    "attempts": 3,
    "wall_seconds": 900
  },
  "delegation": {
    "output_claims": ["A bounded diff and test evidence."],
    "adapters": ["tmux"]
  }
}
```

Research contract:

```json research-contract
{
  "schema_version": 1,
  "objective": "Answer the research question.",
  "consumer": "research-owner",
  "deliverable": "A cited research report.",
  "kind": "research",
  "acceptance": [
    {
      "id": "receipt",
      "predicate_id": "task_receipt",
      "version": 1,
      "configuration": {
        "output_claim": "A cited research report.",
        "artifact_path": "reports/research.md",
        "artifact_digest": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
      },
      "required_evidence": ["research-report"],
      "required": true
    }
  ],
  "provenance": {
    "kind": "research",
    "source_range": {
      "start": "source:first",
      "end": "source:first",
      "sources": [
        {
          "id": "source:first",
          "path": "docs/research.md",
          "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "observed_at": "2026-11-20T12:00:00.000Z"
        }
      ]
    },
    "evidence_window": {
      "starts_at": "2026-11-20T00:00:00.000Z",
      "ends_at": "2026-11-21T00:00:00.000Z"
    }
  },
  "write_scope": ["reports"],
  "action_scope": [],
  "budget": {
    "depth": 1,
    "active_children": 4,
    "active_project_records": 8,
    "attempts": 3
  },
  "delegation": {
    "output_claims": ["A cited research report."],
    "adapters": ["tmux"]
  }
}
```
