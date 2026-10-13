---
name: gate
description: Run the gate before anything lands and read its verdict. Use when work is ready to land, or when checking whether a gate log vouches for a commit.
---

# Gate

Never call anything green without the log path.

Run it:

```bash
hive gate --log <path> -- build "npm run build" test "npm test"
```

- Every step runs even after a failure. Per-step output lands in
  `<path>.d/<name>.log`; the log holds one `<name> exit <n>` line per step.
- Commit first, then run the gate on the tip. A gate on a dirty tree vouches
  for nothing.

Read it:

```bash
hive gate-verify log <path> --commit <tip>
hive gate-verify commits <base>..<tip> --max-files 20 --style conventional --attribution deny
```

GREEN only when every step is `exit 0`, no step is missing or duplicated, and
(with `--commit`) the gate ran on exactly that commit on a clean tree. A gate
that wrote no step lines is RED, never vacuously green.
