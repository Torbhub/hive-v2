# Collaboration identity and authorization

Collaboration is disabled by default. Legacy web, health-check, daily-scan, MCP, and Kimi spawn behavior stays unchanged in this mode. Set `HIVE_COLLABORATION_ENABLED=1` only after the registry, key, and per-agent credential setup is complete. External activation stays disabled.

Enabled Hive accepts two credential types. Nexus human assertions identify stable `user:` subjects. Individual agent credentials identify immutable registered agents. The legacy shared web secret is only an nginx transport check. It never selects a principal.

The Nexus relay is the only human entrypoint. It checks the current user before each request and attaches a short-lived assertion for the `hive` audience. The browser never sees that assertion. Hive checks the signature, issuer, audience, expiry, subject, account status, and account epoch on every request.

Agents use `HIVE_AGENT_CREDENTIAL` read from their private credential file. `HIVE_AGENT`, `HIVE_PROJECT`, client identity headers, and body fields cannot select the owner, agent, or project. The server derives those values from the current credential and registry profile. It stores only a hash of each bearer secret.

## Enabled setup

An administrator first grants the owner project administration and provisions each agent through the Citadel local administrative channel:

```bash
python3 console/backend/hive_admin.py grant \
  --project demo --principal user:alice --actions admin
python3 console/backend/hive_admin.py enroll-agent \
  --agent-id builder --owner user:alice --project demo \
  --credential-file /absolute/demo/.hive/team/builder/credential.env
```

The command writes a mode-0600 file and prints no credential. Running it again rotates the credential after checking the current admin grant. The broker has no enrollment route and never returns a plaintext credential. Keep each file in its agent worktree, set `HIVE_COLLABORATION_ENABLED=1`, and leave administrator `HIVE_AGENT_CREDENTIAL` unset. Spawn passes only `HIVE_AGENT_CREDENTIAL_FILE` to the agent and clears any inherited credential value. Default-off spawn does not read or require the file.

## Authorization

Every project, task, and thread defaults to deny. Grants name `read`, `write`, `execute`, or `admin`. Messaging write access does not grant execution. Task creation requires `admin`. Dialog approval requires `execute`. Foreign resources return the same not-found response.

Authorization follows the stored task, agent, question, dialog, decision, or log target. Caller task and thread fields cannot select a different scope. Task-only grants work without project-wide read. Orphan objects are hidden.

Hive rechecks credentials and grants for reads, writes, execution, recovery, subscriptions, and administration. Long actions are checked again before their response. MCP waits check on every poll and end after revocation or cancellation.

Each agent has monotonic ACL and credential epochs. `GET /api/agent/identity` returns the agent ID, owner, project, and epochs. It never returns the credential.

Wake subscriptions require the agent owner or a principal with an explicit execution grant. Each subscription records that grant. Use `POST /api/wake-subscriptions`, `GET /api/wake-subscriptions?agentId=<id>`, and `POST /api/wake-subscriptions/revoke`. The Nexus broker checks the registered project and performs conditional writes. Revoked subscriptions remain tombstoned.

Execution approvals require a human approver. Agent principals cannot create them. Consumption also rejects persisted approvals with agent approvers. A supplied task requires exact task-scoped delegated grants. Project-wide grants do not authorize delegated approval. Push consumption uses the delegated-approval proof at `/api/hive/broker/delegated-approval`. The broker authenticates the consuming agent and validates its exact execute grant and task plus the recorded approver subject and execute grant identity. Only then does it return the approver's current account status, epoch, and expiry. It never substitutes the consumer owner's account. Invalid scopes, revoked or substituted grants, and disabled accounts fail closed.

## Execution pause

Run `hive hub execution <project> off` to pause one project. The command stores `collaboration_execution_disabled_at` in `.hive-hub/projects.json`. A second `off` command keeps the first timestamp. Run `hive hub execution <project> status` to read the pause state. This slice has no `on` command.

The pause applies only when collaboration is enabled. It blocks worker spawn, respawn, orchestrator launch, watchdog wake, continue, and execution answers for that project. Other projects stay unchanged. The final launch check runs before agent profile and tmux setup. Enabled execution returns HTTP 409 with a rollout-paused error when the project is paused or its config is missing or corrupt. Legacy execution does not read the pause setting.

The pause does not stop existing panes. Reads, progress, cancellation, ordinary answers, interrupt, and kill remain available. Wake-subscription listing and revocation also remain available.

Set `HIVE_WAKE_SUBSCRIPTION_WRITES_ENABLED=1` to allow `POST /api/wake-subscriptions`. This flag controls subscription creation only. It does not admit or dispatch a wake.

## Configuration and restore

The session box has read-only access to `nexus-hive-collaboration`. It has no `nexus-users` access and no table write access. Canonical account status, delegated approval, and wake writes go through `/api/hive/broker/*` on Nexus. `HIVE_COLLABORATION_TABLE` can select another table. `HIVE_NEXUS_BASE_URL` selects the broker. `HIVE_ASSERTION_KEYS_SECRET` defaults to `citadel/hive/assertion-keys`. Tests can use `HIVE_ASSERTION_KEYS_JSON`. Isolated local development uses the same broker contract. Set `HIVE_NEXUS_BASE_URL` to a local Citadel broker. Missing or invalid configuration fails closed.

Do not restore into active dispatch. Restore keeps independent credential, ACL, agent, and subscription revocation records. It keeps the greatest epoch and the earliest nonzero credential expiry. It never inserts an older active row after a revocation. See the Citadel Hive identity runbook for local enrollment and rotation commands.
