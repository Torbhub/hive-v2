# ADR 12: Box services own process cgroups, secrets, and scheduled recovery

## Context

Deploy restarts can kill agent panes. Scheduled scans and browser terminals cross service and credential boundaries. Provisioning runs repeatedly as root against a live box.

## Decision

Keep tmux in its dedicated unit and never restart it during routine provisioning or deploys. Start it only when no server answers. Never remove its socket during a probe gap. Fail production session creation when the managed restart fails or its socket stays unreachable. Verify a responding server PID and its dedicated service cgroup. Keep a managed server running and continue provisioning. Refuse provisioning while a live server has proven foreign ownership. Require an operator to stop it before web or watch restarts. Use ordering-only dependencies where degradation is safe. Inject secrets through root-read files. Make daily scans idempotent and visible when missed. Give each browser attach its own client. Install files only when their contents differ. Generate `web.env` only when absent. Allow `HIVE_PROVISION_REPO` to select a branch worktree for premerge tests while deploys use the default checkout. Merge shared MCP registration without putting per-agent routing in global config. Escape replacement-significant secret characters before rendering nginx. Enable and restart the daily-scan timer rather than its oneshot service. Force-remove Created-state memory containers after stop. Run the watch under systemd supervision and publish a heartbeat after every completed or abandoned cycle.

## Consequences

Routine deploys preserve agents. Missing peer units do not block startup. Orphaned scans recover without duplicates. Repeated provisioning preserves live secrets and avoids unnecessary replacement. Provisioning refuses foreign-owned servers instead of deferring ownership. Template changes to existing secret files need explicit migration. A test repository override must name the intended worktree.

## Sources

- `src/tmux.ts:40-53`, `src/tmux.ts:67`
- `src/watch.ts:759-760`, `src/watch.ts:775`
- `infra/box/daily-scan.sh:2-4`, `infra/box/daily-scan.sh:51-53`, `infra/box/daily-scan.sh:65-68`
- `infra/box/hive-v2-daily-scan.service:3-4`
- `infra/box/hive-v2-tmux.service:3-6`, `infra/box/hive-v2-tmux.service:12`
- `infra/box/hive-v2-tmux.sudoers:1-2`
- `infra/box/hive-v2-watch.service:3-4`, `infra/box/hive-v2-web.service:3-4`
- `infra/box/hub-attach.sh:2-4`, `infra/box/hub-attach.sh:8-9`
- `infra/box/nginx-hive.conf:1-4`
- `infra/box/hive-memory-core.service:29-30`, `infra/box/hive-memory-panel.service:39-40`
- `infra/provision-box.sh:2-10`, `infra/provision-box.sh:24-32`, `infra/provision-box.sh:91-107`, `infra/provision-box.sh:148-160`, `infra/provision-box.sh:198-225`
- `infra/deploy-box.sh:22-23`
