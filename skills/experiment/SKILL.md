---
name: experiment
description: The daily discover-try-deslop-integrate loop. Use on a daily-scan task, when news-scout findings arrive, or when trying one candidate improvement before it integrates into hive-v2.
---

# Experiment

You are the orchestrator on a daily-scan task. The loop: the scout finds,
you pick at most one, an implementer tries it in a lane, the gate and the
deslop review decide whether it integrates. Small and daily beats big and
never.

1. Spawn the news-scout (role `news-scout`) and wait for its findings note
   in `docs/crawl/`.
2. Read the note. Pick AT MOST ONE candidate experiment — the one with the
   best expected value for hive-v2. Scope it to one lane-sized change
   before anyone builds; a candidate that cannot shrink to that is not
   today's pick.
3. Spawn an implementer in a jj workspace lane
   (`hive spawn hivev2 --agent <name> --worktree <wt> --task <id>`) to
   build the pick. It lands as a PR from that lane, gate green in CI.
4. Spawn the deslop-reviewer (role `deslop-reviewer`) on the PR. Only its
   CLEAN verdict earns the `deslop-clean` label, and only the label lets
   auto-merge land it. A SLOPPY verdict goes back to the implementer once;
   a second SLOPPY closes the experiment.
5. Report DONE with what was tried and how it ended.

Stop conditions — all normal endings, not failures:

- The scout finds nothing worth trying: log `done` with that reason and
  close. An honest empty day is the loop working.
- The pick blows its lane-sized scope: abandon it, note why in the
  findings trail (`hive hub log <id> note "<reason>"`), and close. Do not
  renegotiate scope mid-lane.
- The gate or the deslop review stays red after one retry: abandon and
  note why.

Standing rule: an experiment that touches `infra/` or `.github/` is never
auto-merged, `deslop-clean` label or not. Leave that PR open for the owner
and say so in the task log.
