# hive-v2 — working rules for agents

## Lane discipline (HARD)

- Never commit or push directly to `main`. Every change gets its own lane:
  `jj workspace add ../hive-v2-<lane>` from the box clone (jj-colocated),
  work there, push the bookmark, open a PR. main merges happen on GitHub
  after the deslop review and a green `gate` check.
- Two lanes never share a working copy.
- Push through the gate: run `bash scripts/install-git-hooks.sh` once per
  clone, then push with `jj push`. `jj git push` fires no git hooks and
  bypasses the gate. The local gate is fast static checks only (bash -n on
  shell scripts, yaml parse of workflows). The real gate runs in CI.
  `PRESUBMIT=off` bypasses with a loud warning. Declare the escape in your
  lane pulse.

## Box compute (HARD)

- No heavy local compute in lanes: no npm ci, no test suites, no builds on
  this box. Write the code, push the branch, let the PR gate run them in CI.
  Cheap syntax checks (`bash -n`, yaml parse) are fine.
- The box runs the live hub and the orchestrators. A lane that chugs it
  kills the product it's working on.

## Build and test

- Build: `npm run build` (needs Node 22. On the deploy box use `/opt/node22/bin/npm`).
- Test: `npm test` (vitest). All tests must pass before a push.
- UI changes: `docs/hub-ui-spec.md` is the byte-exact contract for the hub
  screen. When the screen changes, the spec changes in the same commit.

## Code style

- Comments are minimal, context only, and never restate the code. No lore
  comments, no "why we changed this" comments — git history carries that.
- Prose (docs, README, UI strings) is controlled simple english: short
  sentences, no semicolons.
- Keep the file layout: `src/` for the CLI and hub logic, `web/` for the
  server and SPA, `test/` mirrors `src/`, `scripts/` for the CI gate
  helpers (the discipline ratchet).

## Deploys

- Deploys belong to the `deploy` workflow. Push to `main` deploys. Nobody
  runs deploy steps by hand. The full ceremony lives in `infra/README.md`.
- The workflow is newest-wins: a newer push cancels an older run, and a
  cancelled run is normal, not an incident.
- Any AWS act outside the workflow (a stack change, an IAM touch, an SSM
  command to the box) acquires the fleet deploy mutex first:
  `bash infra/deploy-mutex.sh acquire <resource> <owner>`. Release it in
  cleanup, always. Details: `docs/runbooks/deploy-mutex.md` in citadel.
- The box itself is state: never rebuild it by hand. Change
  `infra/box/`, push, let the workflow run `infra/provision-box.sh`.

## tmux discipline

- hive owns a private tmux socket (`tmux -L hive-v2`). Never send keys or
  kills to the default socket. The operator's own sessions live there.
- Every pane kill or type re-verifies the pane's identity (pid + start
  time) first. See `src/tmux.ts`.
