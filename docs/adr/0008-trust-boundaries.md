# ADR 8: Trust boundaries minimize secrets and reject unsafe input

## Context

Names, messages, logs, protocol streams, configuration, and browser requests cross independent trust boundaries. Configuration errors can disclose unrelated secrets.

## Decision

Validate context-specific grammars. Reject control input and symlinks. Redact before display and truncation. Bound protocol lines. Expose only safe errors. Enforce browser request origin checks. Replace native MCP parse errors with fixed text and preserve configuration modes explicitly. Keep task text as data. Use `gh` for private archive downloads so redirect handling does not expose its token.

## Consequences

Untrusted content cannot become commands or terminal control. Sensitive payloads and configuration stay out of logs. Malformed peers cannot exhaust memory.

## Sources

- `src/state.ts:10-11`
- `src/kill.ts:41-42`
- `src/logview.ts:32-37`, `src/logview.ts:41`, `src/logview.ts:53`, `src/logview.ts:286-287`
- `src/mcp.ts:127-128`, `src/mcp.ts:363-364`
- `src/message.ts:8`, `src/message.ts:58-59`, `src/message.ts:109`
- `src/names.ts:1-2`, `src/names.ts:5-6`
- `src/project.ts:235-236`
- `src/questions.ts:288`, `src/questions.ts:763`
- `web/actions.ts:48-50`, `web/actions.ts:130-131`
- `infra/merge-mcp.mjs:14`, `infra/merge-mcp.mjs:47-48`, `infra/merge-mcp.mjs:57`
- `infra/t01-smoke/teamkimi-count-install.sh:64`
- `test/web.test.ts:330`, `test/logview.test.ts:84`
