---
name: council
description: Review one artifact with fresh-context lens agents that never see each other's work, then merge their verdicts with a fresh synthesizer. Use when a review needs more than one pair of eyes, for deep reviews and risky changes.
---

# Council

One artifact. Several lenses. No cross-talk. One synthesis.

## The pattern

1. Pick the lenses. The standing lens roles live in `roles/council-*.md`.
   Take only the ones the artifact needs.
2. Spawn K fresh agents per lens:
   `hive spawn <project> --agent <name> --role council-<lens> --assignment <text> --deliverable <text>`.
   Assignment names the artifact and lens. Deliverable names the report path under
   `.hive/councils/<review-id>/`. K is the fan-out per lens. Default K=1. Raise K
   only when a miss is expensive and the budget allows. Lens agents never see
   each other's output. No shared handoff. No discussion between lenses.
4. Each lens agent writes its report to its own path. Every finding carries
   a verdict:
   - BLOCKING — must be fixed before the artifact ships.
   - STRONG-ADVISORY — must be addressed or explicitly justified. Does not
     hard-block.
   - ADVISORY — a comment only. Never blocks.
5. Spawn one fresh synthesizer: `--role council-synthesizer`. Brief it with
   the report directory only. It merges the reports, resolves conflicts,
   and emits the final verdict.

## The blocking rule

Every blocking reviewer follows this rule, verbatim:

> You are a BLOCKING reviewer. If you block, state the EXACT reason
> (specific finding + file/section + severity) AND the single concrete
> change that would clear it. A fresh downstream context reads your stated
> reason to figure out how to get past the block, so a vague or
> unactionable block is invalid.

## Cost discipline

A council costs K agents per lens plus one synthesizer. The synthesizer is
where the judgment lives. Keep it fresh and well-briefed. When the budget
is tight, cut K before you cut the synthesizer.
