---
name: cleanup
description: Clean up what hive created for a project — tmux windows, worktrees, processes — from its manifest, trashing instead of deleting. Use when a task is finished or a team is being torn down.
---

# Cleanup

Cleanup acts only on the project's `.hive/manifest.jsonl` and trashes instead
of deleting. Records are re-judged at act time: a window that is already gone,
a pid that is now a different process, a worktree that vanished — none of them
are touched.

Always show the dry run first:

```bash
hive cleanup <project> --dry-run
```

Then, on the owner's word:

```bash
hive cleanup <project>
```

Trash lands in `.hive/trash/<date>/`; emptying it is the owner's call.
