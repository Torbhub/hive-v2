# Native branches

Native branches are disabled by default. Set `HIVE_NATIVE_BRANCHES=1` to enable the core. This document does not claim production rollout.

## Admission

Create needs an approved root contract and one current parent worker lease. The root contract allocates the output claim and native result acceptance IDs.

Native branches are read-only. A non-empty native write scope fails before any native call. Read-only native and tmux scopes can overlap.

Create requires an effective server attestation for read-only filesystem access, denied shell execution, denied side effects, and only `Read`, `Grep`, and `Glob` tools. An unattested child or fork never becomes active.

Kimi Server 2.5.3 does not provide this attestation for child or fork creation. Creation therefore remains unknown on that server.

Hive stores an epoch-1 lease and budget reservation before child or fork creation. Native and tmux admissions share dedup, parent, project, depth, and attempt limits.

Records without a lease remain readable. Writes to those records fail because Hive does not create a lease during a read.

## CLI

```sh
hive branch create <project> --agent <name> --purpose <text> [--fork] [--output-claim <text>] [--acceptance <id>...]
hive branch status [project]
hive branch refresh <project> <branch>
hive branch result <project> <branch> --file <json>
hive branch reconcile <project> <branch>
```

Create derives project, task, and parent session scope from one current team entry. A child uses native child semantics. A plain fork uses only the current full-history snapshot. Historical turn selection is not supported.

The output claim and acceptance flags select existing root allocations. They do not create a child plan or approval.

Result files must be regular files. They have size limits and structured findings with native evidence hashes. These checks do not prove that findings are correct.

Each result must match one assistant message in the exact child session. The message ID, role, session, structured content, and full content hash must match. Every finding cites that result message.

The `native_result` predicate rereads parent and child history on every evaluation. Cached evidence cannot bypass this check. A rejoined parent permits only the exact rejoin message after the stored snapshot.

Refresh and reconcile use bounded history snapshots. They never automatically rejoin findings into the parent.

## Review and rejoin

Authenticated human review and selective rejoin live in the internal core and web path. They are not CLI commands.

A review binds selected finding IDs, history hashes, reviewer, and grant identities. A rejoin sends only reviewed findings and provenance in a structured parent prompt. It never sends the full transcript or child tool-policy overrides.

After a timeout or crash, delivery can remain unknown. There is no blind retry. Reconciliation requires a persisted acknowledgement message ID and exact parent message evidence. Without that ID, delivery remains unknown.

Exact delivery releases the native lease. The parent worker lease remains unchanged. Root execution authority does not replace native review or rejoin authority.
