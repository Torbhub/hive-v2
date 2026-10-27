# hive-v2 infrastructure

Committed infrastructure for the hive-v2 hub, which runs on the kimi session
box (a dedicated EC2 instance). One CloudFormation stack plus the box config.

- `template.yaml` — stack `hive-v2-infra`: the IAM role the GitHub deploy
  workflow assumes over OIDC.
- `box/` — the live box config: the systemd units, the `hive` wrapper, and
  the nginx site (with the `__HIVE_WEB_SECRET__` placeholder, rendered at
  provision time). `hive-v2-tmux.service` owns the
  tmux server so deploy restarts of the web and watch units cannot kill the
  panes. Deploys never restart it.

## The one way in

The hub lives inside nexus: `nexus.dexima.ai/hive`. CloudFront sends
`/hive/*` to the nexus Lambda, which relays the request over an SSM
port-forward tunnel to the box's loopback. nginx on the box listens on
`127.0.0.1:8081`, injects the app secret, and proxies to hive-web on 7684.
The nexus session gate is the auth. The relay finds the box by its
`Role=nexus-kimi-session` tag, so no hostname, IP, certificate, or DNS
record references it. There is no public hive hostname or TLS cert; the
relay is the only way in. The hive server strips the `/hive` prefix
before routing, so `/hive/api/view` and `/api/view` are the same endpoint.

- `provision-box.sh` — idempotent root provisioner. Installs units and
  wrapper only when content differs, keeps existing env files under
  `/etc/hive-v2`, renders and reloads nginx, renders the memory gateway
  config, installs docker, and pulls the pinned memory images. It installs
  the pinned nexus-push client without registering it. It also merges the
  `hive-operator` MCP server into `/home/ubuntu/.kimi-code/mcp.json`
  (`infra/merge-mcp.mjs`), preserving every other server. It also installs a
  conditional `PreToolUse` hook that blocks `AskUserQuestion` only when
  `HIVE_AGENT` is set. Non-Hive sessions keep that tool. The watchdog also
  dismisses any native dialog the hook misses and redirects the agent to MCP.
  The config merge is idempotent, validates its output, and preserves all other
  settings. Bump the client commit and
  sha256 pins together to upgrade. The memory stack itself is documented in
  `docs/memory.md`.
- `deploy-box.sh` — what the workflow runs on the box over SSM: fetch, reset
  to the merged commit, `npm ci`, build, provision, health-check.
- `.github/workflows/deploy.yml` — gate job (test, build, lint) then deploy.
  Newest-wins: a newer push cancels an older run, and the staleness step
  skips a survivor only when the newer head touches a deploy path (the
  citadel #1811 rule). A cancelled run is normal, not an incident.
- `deploy-mutex.sh` — a copy of citadel's `scripts/deploy-mutex.sh`. The
  deploy job acquires the fleet mutex (`aws-acts` resource, DynamoDB table
  `citadel-deploy-mutex`) before the SSM box deploy (the stack self-update
  is exempt) and releases it in cleanup. Any hand AWS act must acquire it
  too — see the deploy-discipline skill.

## Bootstrap ceremony (once, by the operator)

1. From an admin shell in account 594552273052:

   ```bash
   aws cloudformation deploy \
     --stack-name hive-v2-infra \
     --template-file infra/template.yaml \
     --capabilities CAPABILITY_NAMED_IAM
   ```

2. In the GitHub repo settings, set:
   - secret `HIVE_DEPLOY_ROLE_ARN` = the stack's `DeployRoleArn` output
   - variable `KIMI_BOX_ID` = `i-004e23820520cbf3c`

3. Done. Every push to main that touches `src/`, `web/`, `infra/`, or the
   package files runs the gate and then deploys over SSM.

## Drift adoption

The systemd units, wrapper, and nginx site on the box were hand-rolled and
are committed here. `provision-box.sh` only rewrites a file when content
differs and never touches an existing env file, so a redeploy is a no-op
config-wise: same units, same nginx config, clean reload.
