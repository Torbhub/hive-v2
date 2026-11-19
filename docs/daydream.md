# Manual daydreams

Daydreams are disabled by default. Set both `HIVE_DAYDREAM=1` and `HIVE_NATIVE_BRANCHES=1` for native operations. The status command is read-only and does not need these flags.

A daydream mines facts for one approved task plan and its current started checkpoint. It never answers owner questions or rejoins the parent session. It has no watcher and does not change idle compaction.

## Commands

```sh
hive daydream mine <project> --agent <name> --checkpoint <id> --question <text>
hive daydream verify <project> <daydream> --file <brief.json>
hive daydream recover <project> <daydream> [--file <brief.json>]
hive daydream status [project]
```

`mine` resolves one current TeamEntry. It captures bounded task, checkpoint, handoff, parent-history, and question hashes. Task events must match both the project and task ID. It creates one native child with `hive_daydream_id` and submits the exact question.

`verify` reads one bounded regular JSON file. Symbolic links, unknown fields, unsafe text, wrong hashes, wrong quotes, and oversized input are refused. The brief must be the only matching standalone JSON in exactly one native assistant message.

`recover` without a file reconciles durable intents or submits the recovery prompt when compaction is already proven. With a file, it also verifies the recovery brief. Facts and unknowns must match the mined brief exactly.

`status` prints durable records for one project or all projects. It does not refresh native state.

## BTW read-only boundary and phase isolation

Mining uses one fresh native `:btw` agent. Recovery uses a different fresh `:btw` agent after main compaction is proven. Each session has at most one active BTW. Timeout or unknown effects never create a replacement.

BTW provides a built-in positive allowlist of `Read`, `Grep`, and `Glob`. Manual mode remains as defense in depth. No custom profile or `disabled_tools` override is needed.

Hive persists the BTW agent and prompt intent before submission. A lost prompt reconciles only through a unique `prompt_id` in that agent's transcript. The existing agent, acknowledgement, and intent are preserved. No prompt is overwritten or resubmitted.

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
