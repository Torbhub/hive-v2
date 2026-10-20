---
name: digest-triage
description: Turn digest-labeled GitHub issues into hive improvement tasks. Use when the owner asks for a digest triage.
---

# Digest triage

hive does not scrape the web. The digest arrives as issues labeled `digest`
in Torbhub/kimi-harness. You read them and turn the picks into tasks.

1. List what is open:

   ```bash
   gh issue list --repo Torbhub/kimi-harness --label digest --state open
   ```

2. Read each issue. Open the linked source when the title is not enough.
3. Pick what is worth a hive improvement: a change to roles, rules, skills,
   the gate, or the hub. Skip what is noise, stale, or already done.
4. Record each pick as a task on the project it improves:
   `hive hub task <project> "<what to change and why, with the issue link>"`.
5. Close the loop on each issue, on the owner's word: comment the task id on
   a pick, or the reason on a skip.

Report verdict first: how many issues, how many picks, what you skipped and
why.
