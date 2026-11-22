---
name: delete-comment
description: Delete code and configuration comments safely, preserve decisions and semantics, lower the comment baseline, and report exact savings. Use when the user asks to remove comments.
disable-model-invocation: true
---

# Delete comments

Work in the target repository. Its instructions and ADR convention govern the
work. Report conflicts to the orchestrator. Never add a suppression mechanism.

1. Run `node scripts/discipline-gate.mjs --inventory-comments`. Save the JSON
   and sum its physical lines per file and in total. This is the before count.
2. Classify every block as decision-record, tautology, stale, or excuse. Also
   identify semantic directives for migration. Do not treat strings, regexes,
   URLs, shebangs, heredocs, or block scalar data as comments.
3. Preserve durable decision records in the target repository's ADR convention
   before deleting them. Do not invent a new decision location.
4. File an issue for each distinct excuse. Include the source location, the
   constraint, and the evidence needed to remove it. Link the issue in the
   handoff, not in code.
5. Migrate semantic directives into the configuration, types, tests, or
   executable checks that enforce them. Verify equivalent behavior before
   deleting the directive.
6. Delete tautology and stale comments. Delete decision records and excuses
   only after their preservation steps. Delete comments in fenced code examples
   too. Do not replace them with renamed comments or disable directives.
7. Run `node scripts/discipline-gate.mjs --update`. Inspect the baseline diff.
   Comment counts may only decrease or disappear. Never raise a count or add a
   newly commented file. The update cannot legitimize new or increased comments.
8. Run `node scripts/discipline-gate.mjs --check`, then the target repository's
   normal gate. Read the diagnostics and fix failures rather than suppressing
   them.
9. Repeat the inventory. Report exact physical-line savings as before minus
   after, with per-file and total counts. Also report files removed from the
   baseline and any preserved ADRs, issues, or semantic migrations. No estimates.
