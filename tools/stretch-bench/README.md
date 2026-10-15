# stretch-bench

Does stretchtext pay off for this box's agent transcripts? A port of
pro-vi/cc-stretch's bench for kimi-code wire files.

It takes real assistant replies from `~/.kimi-code/sessions/`, asks the model
to rewrite each one as a skim, and measures two things:

- **Skim ratio.** Skim words over original words. Lower is shorter.
- **Coverage.** Do the original's top claims still show in the skim? The top
  claims are the first sentence and each list item's first clause, up to
  three. A claim counts as covered when it appears in the skim as a substring,
  or when most of its content words do.

## Run it

Needs the teamkimi proxy up (`pgrep -af teamkimi`) and a signed-in `kimi`.

```
tsx tools/stretch-bench/extract.ts                 # count replies, no writes
tsx tools/stretch-bench/rewrite.ts --sample 20     # slow: one kimi -p call per reply
tsx tools/stretch-bench/measure.ts                 # prints the report
```

`rewrite.ts` samples from the 30 most recent wire files, seeded, so a rerun
picks the same replies. It writes `results/replay.jsonl` as it goes. Rows hold
the skim text and word counts, not the original text. `measure.ts` reads the
originals back from the wire files and writes `results/summary.json`.

Useful flags: `--root` (sessions dir), `--seed`, `--files` (how many recent
wire files to pool), `--in` / `--out` / `--summary` for paths.

## Read the numbers honestly

- The skim is a rewrite of replies written without the contract, not replies
  written under it from the start.
- The coverage check is a string heuristic, not a reader. It undercounts when
  the skim says the same thing in other words.
- It measures words, not time or understanding.

## Secrets

Skims can carry secrets by design: the bench samples real agent sessions, and
agents share credentials in plain text. `rewrite.ts` runs every skim through
`redact.ts` (env-style assignments, prose passwords, basic-auth shares) before
it writes a row. Redaction is a pattern list, not a guarantee. Scan the
results before you commit them.
