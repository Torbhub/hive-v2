# Native branches

Native branches are disabled by default. Set `HIVE_NATIVE_BRANCHES=1` to enable the core. This document does not claim production rollout.

## CLI

```sh
hive branch create <project> --agent <name> --purpose <text> [--fork]
hive branch status [project]
hive branch refresh <project> <branch>
hive branch result <project> <branch> --file <json>
hive branch reconcile <project> <branch>
```

Create derives project, task, and parent session scope from one current team entry. A child uses native child semantics. A plain fork uses only the current full-history snapshot. Historical turn selection is not supported.

Result files must be regular files. They have size limits and structured findings with native evidence hashes. These checks do not prove that findings are correct.

Refresh and reconcile use bounded history snapshots. They never automatically rejoin findings into the parent.

## Review and rejoin

Authenticated human review and selective rejoin live in the internal core. PR3 will expose them through its web path. They are not CLI commands.

A review binds selected finding IDs, history hashes, reviewer, and grant identities. A rejoin sends only reviewed findings and provenance in a structured parent prompt. It never sends the full transcript or child tool-policy overrides.

After a timeout or crash, delivery can remain unknown. There is no blind retry. Reconciliation requires a persisted acknowledgement message ID and exact parent message evidence. Without that ID, delivery remains unknown.
