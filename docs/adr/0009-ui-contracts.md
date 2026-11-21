# ADR 9: UI contracts preserve safe interaction and deployment compatibility

## Context

Terminal grammars, recursive markup, keyboard timing, caching, and duplicate question surfaces come from outside individual components.

## Decision

Parse calibrated terminal forms. Keep code literals opaque. Read keyboard state at event time. Deduplicate owner questions. Use deployment-safe asset and cache policies. Keep destructive confirmation delayed. Preserve stable button registration slots. Serve extensionless SPA routes from the shell. Record stretch-open telemetry on a best-effort basis. Mark a task stale after four hours without progress. Measure that interval from the latest activity when no progress exists so a rebriefed old task is not immediately stale.

## Consequences

Input races and malformed screens fail safely. Nested content remains valid. One build serves both mounts. Owners see current assets and one answer path. Rebriefing starts a fresh stale interval while tasks with progress still use their latest progress timestamp.

## Sources

- `src/types.ts:437-438`
- `src/ui/buttons.tsx:17-18`, `src/ui/buttons.tsx:39-42`
- `src/ui/HubApp.tsx:172`
- `src/ui/look.ts:12-13`, `src/ui/look.ts:206-207`
- `web/stretch.ts:8`, `web/kill.tsx:4-7`, `web/static.ts:19`, `web/static.ts:37`, `web/static.ts:46-47`
- `web/Stretch.tsx:5`, `web/Stretch.tsx:14-15`
- `vite.config.mjs:7`
- `src/screen.ts:4`, `src/screen.ts:22`, `src/screen.ts:28`, `src/screen.ts:43`, `src/screen.ts:77`, `src/screen.ts:88`, `src/screen.ts:99-101`
- `src/stretch.ts:1-4`
- `src/view.ts:15-16`, `src/view.ts:36-38`, `src/view.ts:73`
