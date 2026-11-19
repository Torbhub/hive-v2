# Daydreams

Daydreams are disabled by default. Set both `HIVE_DAYDREAM=1` and `HIVE_NATIVE_BRANCHES=1` for native operations. Status and local automation controls do not need these flags.

A daydream mines facts for one approved task plan and its current started checkpoint. It never answers owner questions, rejoins the parent session, or promotes memory. Automation has a separate opt-in and does not replace ordinary idle compaction.

## Commands

```sh
hive daydream mine <project> --agent <name> --checkpoint <id> --question <text>
hive daydream verify <project> <daydream> --file <brief.json>
hive daydream recover <project> <daydream> [--file <brief.json>]
hive daydream status [project]
hive daydream automation <project> [agent] on|off|status
hive daydream reconcile <project> <daydream>
hive daydream prune <project> [--dry-run]
```

`mine` resolves one current TeamEntry. It captures bounded task, checkpoint, handoff, parent-history, and question hashes. Task events must match both the project and task ID. It creates one native child with `hive_daydream_id` and submits the exact question.

`verify` reads one bounded regular JSON file. Symbolic links, unknown fields, unsafe text, wrong hashes, wrong quotes, and oversized input are refused. The brief must be the only matching standalone JSON in exactly one native assistant message.

`recover` without a file reconciles durable intents or submits the recovery prompt when compaction is already proven. With a file, it also verifies the recovery brief. Facts and unknowns must match the mined brief exactly.

`status` prints durable records for one project or all projects. It does not refresh native state.

## Automation rollout

Automation needs all of these opt-ins:

- `HIVE_DAYDREAM=1` and `HIVE_NATIVE_BRANCHES=1` keep the native rollout gates.
- `HIVE_DAYDREAM_AUTOMATION=1` enables automation globally.
- `hive daydream automation <project> <agent> on` enables one non-orchestrator worker. Orchestrator opt-in is rejected before reservation. Status can omit the agent name to report the project.

The native client also needs `HIVE_KIMI_SERVER_TOKEN`. `HIVE_KIMI_SERVER_ORIGIN` can override its loopback origin. Automation status, on, and off are local operations. They do not need native flags. Prune is also local. Reconcile needs the native flags but does not need `HIVE_DAYDREAM_AUTOMATION`.

`auto_compact` is independent. An agent with only `auto_compact` keeps its existing behavior. An agent with automation and `auto_compact=false` can still run an idle daydream.

An idle run needs 30 minutes since the last genuine wire activity. The epoch uses the existing `turn.ended`, `agent.turn.ended`, and `full_compaction.complete` events. Keepalive, polling, and passive screen output do not move it. Watch delegates all daydream work to the compactor. A pre-compaction run happens only after every serialized delivery guard passes and before actual compaction input. A rejected worker, session, pane, activity, or completion guard consumes no run, fingerprint, or budget. After the daydream, delivery recaptures the pane and wire activity and repeats the same screen, fallback, completion, and activity guard. Late output or activity prevents input but preserves the completed run. It has a different trigger reason from an idle run.

A fingerprint contains the agent, session, activity epoch, and reason. One fingerprint has at most one run, including after a watch restart. One active reservation per project prevents concurrent native runs. The reservation and result writes use the project lock. The reserved session and worktree are revalidated against an exact non-orchestrator TeamEntry inside the team lock before native work. The native lifecycle runs outside that lock because the PR4 operations take it themselves.

Automated mining uses a fixed question and the current started checkpoint. The runner delegates to the existing mine, verify, fork, compaction, and recovery operations. It does not add a second compactor, rejoin the parent, or promote memory. A brief that stays pending for 60 seconds becomes unknown. Automation never retries it.

## Budgets and durable state

Daily windows use UTC dates. The default per-agent ceilings are 4 runs, 12 prompts, and 4 compactions. The default per-project ceilings are 16 runs, 48 prompts, and 16 compactions. One run can use at most 3 prompts and 1 compaction.

Before any native effect, Hive reserves 1 run, 3 prompts, and 1 compaction under the project lock. Both per-agent and per-project remaining budgets must cover that reservation. A failed reservation makes no native call. A reported result replaces the reservation with its actual run, prompt, and compaction counts. Result and reconcile use one guarded usage finalizer. A crash or reconcile of an unfinished reservation charges the full reservation because native effects are unknown. This includes missing-child and recovered-result-write crash paths. Recovered completion adds only positive deltas above existing counts. An unknown 1/1 result therefore completes at 3/1 without a repeated charge. `usageRecorded` prevents a repeated first charge. Token usage is evidence and never acts as an enforcement boundary.

Durable run records live in `.hive/daydreams/automation/state.json`. Each reservation stores `ownerPid` and `ownerStartTime` before native runner execution. A live owner blocks new fingerprints and missing-child reconcile. Invalid, mismatched, or unreadable lease data also stays fenced with `usageRecorded=false` and no child discovery. Only confirmed owner death permits the pre-child `ENOENT` proof and full-reservation charging.

A reservation survives process loss and blocks duplicate admission. Any unknown reservation, child, prompt, fork, compaction, or result fences that agent. It also keeps the project reservation closed while native effects may still be active.

`hive daydream reconcile <project> <daydream>` is read-only. It clears a fence only after one of these proofs:

- The durable daydream is already `recovered`.
- A pre-child record read fails with `ENOENT` and no matching native child exists. The run becomes terminal unknown and is not reported as recovered.

Corruption, permission errors, invalid records, and transient I/O never prove a missing child. They stay fenced with `usageRecorded=false`. Other unknown outcomes also stay fenced. Reconcile never creates a BTW, submits a prompt, forks, compacts, or retries unknown work. Use the explicit manual `verify` or `recover` command to finish an existing PR4 lifecycle when that is safe. Then run `reconcile` to release the automation fence.

## Retention

Recovered automation writes a bounded summary under `.hive/daydreams/automation/artifacts` and matching tombstoned metadata under `.hive/daydreams/automation/metadata`. The summary contains identity, trigger, status, and usage. It does not contain a transcript or credentials.

`hive daydream prune <project> [--dry-run]` considers only these Hive-owned artifact and tombstone pairs. The default age cap is 30 days and the default count cap is the newest 100 tombstones. An artifact is eligible when it meets the age cap or exceeds the count cap. Dry-run reports the same candidates without deleting them.

Prune refuses symbolic links, non-regular files, foreign artifact paths, and changes detected during pruning. Every `.json` entry must be a regular file. It validates all owned tombstones before the first unlink. Verified directory handles stay open, and deletion uses `/proc/self/fd` paths so an ancestor rename or symlink swap cannot redirect it. Prune never deletes native sessions, wire logs, context files, workspaces, panes, credentials, manual daydream records, active metadata, or automation state.

## BTW read-only boundary and phase isolation

Mining uses one fresh native `:btw` agent. Recovery uses a different fresh `:btw` agent after main compaction is proven. Each session has at most one active BTW. Timeout or unknown effects never create a replacement.

BTW provides a built-in positive allowlist of `Read`, `Grep`, and `Glob`. Manual mode remains as defense in depth. No custom profile or `disabled_tools` override is needed.

Hive persists the BTW agent and prompt intent before submission, but not prompt content. A lost prompt reconciles only through a unique `prompt_id` in that agent's transcript. If backfill omits the prompt record, the operator can supply proof content for verification or recovery. Hive uses it only when its hash matches the durable prompt hash and `nativeMessageId` is present. An existing wrong prompt ID is never overridden. Missing proof, mismatches, duplicates, and missing turns are refused. The same completed, non-wedged linked turn and assistant JSON frame are still required. The existing agent, acknowledgement, and intent are preserved. No prompt is overwritten, resubmitted, or persisted in durable records.

## Brief and evidence

A brief has this shape:

```json
{
  "schemaVersion": 1,
  "daydreamId": "<daydream id>",
  "phase": "mine or recover",
  "checkpointId": "<current started checkpoint>",
  "questionHash": "<sha256>",
  "sourceHistoryHash": "<sha256>",
  "facts": [
    {
      "id": "f1",
      "answer": "<fact>",
      "whyNow": "<reason>",
      "uncertainty": "<remaining uncertainty>",
      "citations": []
    }
  ],
  "unknowns": []
}
```

A brief has 1 to 12 facts with sequential IDs and at most 12 unknowns. Native citations carry `messageId`, `contentHash`, and an exact quote. Task citations carry `eventHash` and an exact quote. Registered-handoff citations carry `pathHash`, `contentHash`, and an exact quote.

Verification reads the current task log and registered handoff again. Their hashes and quoted text must match the captured evidence. Later work blocks verification or recovery.

Handoff containment and content come from one opened descriptor. Hive uses `O_NOFOLLOW`, the descriptor's real path, `fstat`, and reads from that descriptor. Replacing the parent path cannot redirect the read.

Hive applies `redactSecrets` to brief prose, unknowns, citation quotes, and error text. A citation whose quote changes during redaction is rejected. Hashes are preserved.

## BTW output provenance

A brief binds to one completed BTW prompt and one completed trigger turn. The prompt must match its acknowledgement ID and exact content. Exactly one assistant text frame must contain the same standalone brief JSON.

Top-level `prompts[]` entries carry `promptId`, `status`, `userMessageId`, and `content`. Turn items carry `turnId`, `state`, and `steps`. Unrelated turns may omit `triggerPromptId`. The selected turn must match the operation prompt ID and be completed and not wedged. The selected roster entry must have `type` set to `sub`.

Record provenance carries `sessionId`, `agentId`, `promptId`, `turnId`, `stepId`, `frameId`, and a hash of the full frame text. Mining and recovery use different agent IDs and separate provenance records.

Flattened `/messages` output is not BTW evidence. Native citations still use main or checkpoint-fork message IDs, content hashes, and exact quotes. The BTW frame proves brief provenance only and does not prove factual support.

## Checkpoint and compaction

After mined brief verification, Hive forks only the current child boundary. Historical turns are not supported. The fork must have equivalent content at every position and either identical message IDs or the session-derived ID mapping. A fork crash with `forking` intent and no fork ID is permanently unknown. Recovery never creates another fork.

Hive compacts only the original mining child with native `:compact`. Before compaction, it reads the live transcript watermark and server incarnation. It generates a fresh random nonce and includes that nonce in the exact compaction instruction. Compaction changes the history hash. The message count can grow when Kimi adds summary and recovery messages.

HTTP acceptance is not success. The ordinary `:compact` route can acknowledge `begin === false`. Production still requires a complete contiguous post-watermark journal with two official markers:

- `op` is `marker.upsert` and `item.marker` is `compaction`.
- The first payload has phase `started`, trigger `manual`, agent ID `main`, and the exact instruction.
- The next payload has phase `completed` and agent ID `main`. Its result object contains `summary`, `compactedCount`, `tokensBefore`, and `tokensAfter`. Start-only fields are not required on completion.

Ordinary REST lifecycle markers can be lost during backfill. Production accepts either the normal correlated lifecycle proof or one nonce-correlated backfill summary.

When the journal is incomplete or the server incarnation changes, Hive reads the main transcript for one phase-free `compaction_summary`. Its text must contain the exact intent nonce. `item.at` is optional and is not a compaction timestamp. `intentAt` is diagnostic only. Missing, wrong, or ambiguous proof blocks recovery without another compaction or prompt. Accepted backfill proof rebinds the child snapshot to current native history. Duplicate nonces and mismatched post-compaction history are rejected.

Without matching backfill proof, an older completion, wrong nonce, gap, duplicate start, cancellation, error, incomplete journal, or server incarnation change blocks recovery.

Recovery reconciles `compacting` and `unknown` records with read-only meta and journal calls. It never repeats `:compact`. A persisted recovery acknowledgement is reconciled before any compacted submission branch. Its message ID is preserved and never resubmitted.

Recovery validates native citations against the retained checkpoint. Task and handoff citations use the captured evidence and their current registered sources. The compacted child summary is not evidence for a lost fact.

## Records and crashes

Records live under `.hive/daydreams`. The directory mode is `0700` and file mode is `0600`. Each write uses a random exclusive temporary file followed by a same-directory rename.

Records contain bounded redacted briefs, hashes, snapshots, and operation intents. They do not contain raw transcripts, full task logs, credentials, whole handoffs, or the raw question. Prose redaction does not change hashes.

Hive persists child, prompt, acknowledgement, fork, and compaction intent before dependent effects. Recovery discovers a child by `hive_daydream_id` when its ID was not persisted. It uses a persisted prompt acknowledgement ID when exact message proof is available. It never blindly repeats a child, prompt, fork, or compaction.

A plain fork loss without its ID remains unknown. Prompt loss without an acknowledgement ID remains unknown. Compaction without verified transcript markers remains unproven.

## Native verification boundary

The client targets the Kimi Server 2.5.3 routes for BTW creation, prompts, per-agent transcripts, current forks, compaction, server meta, transcript watermarks, and transcript-op catch-up. Synthetic tests define the expected wire behavior. Live native verification still needs to confirm BTW isolation, frame provenance, marker payloads, journal coverage, fork ID mapping, and restart reconciliation on the pinned runtime.
