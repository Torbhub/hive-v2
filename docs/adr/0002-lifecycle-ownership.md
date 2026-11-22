# ADR 2: Prove ownership and identity before destructive lifecycle changes

## Context

Pane identifiers and manifest records can become stale. Kills, launches, interrupts, and cleanup can race replacement agents.

## Decision

Revalidate ownership and process identity at mutation time. Fence replacement leases. Refuse ambiguous names. Stamp closure before kills and roll back failed stamps. Require an independent Git or jj witness before removing workspaces. Keep terminal targeting and process start-time representation stable. Route all Hive tmux traffic, including tests, through a private socket so the default server remains unreachable.

## Consequences

Operations avoid foreign or recycled targets. Failed kills remain visible. Replacement agents survive. Cleanup stays reversible and auditable. Tests cannot see or mutate sessions on the default tmux server.

## Sources

- `src/cleanup.ts:11`, `src/cleanup.ts:32-34`, `src/cleanup.ts:46`, `src/cleanup.ts:62`, `src/cleanup.ts:92-94`, `src/cleanup.ts:120`
- `src/kill.ts:34-36`, `src/kill.ts:52-57`, `src/kill.ts:75-77`, `src/kill.ts:105-106`, `src/kill.ts:120-123`, `src/kill.ts:147`
- `src/interrupt.ts:6-7`, `src/interrupt.ts:21-23`, `src/interrupt.ts:42`
- `src/tmux.ts:18-20`, `src/tmux.ts:35-36`, `src/tmux.ts:74`, `src/tmux.ts:83-84`, `src/tmux.ts:132`
- `test/tmux.test.ts:5-6`, `test/web.test.ts:16-17`
- `src/types.ts:591-592`
- `src/launch.ts:95-96`, `src/launch.ts:116`, `src/launch.ts:143`
- `src/message.ts:41-42`
- `src/logview.ts:296-297`
- `src/hub.ts:302-303`
- `test/hub.test.ts:986-987`, `test/hub.test.ts:1060-1062`
