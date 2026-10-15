# hive-v2 infrastructure

Committed infrastructure for the hive-v2 hub, which runs on the kimi session
box (a dedicated EC2 instance). One CloudFormation stack plus the box config.

- `template.yaml` — stack `hive-v2-infra`: the IAM role the GitHub deploy
  workflow assumes over OIDC.
- `box/` — the live box config: both systemd units, the `hive` wrapper, and
  the nginx site (with `__HIVE_WEB_SECRET__` and `__HIVE_ORIGIN_KEY__`
  placeholders, rendered at provision time).

## The one way in

The hub lives inside nexus: `nexus.dexima.ai/hive`. CloudFront proxies
`/hive/*` to the box's nginx vhost with a custom origin header
`x-hive-origin: <HIVE_ORIGIN_KEY>`. The nexus session gate is the auth.
nginx checks the origin key on `location /hive/` and serves nothing else on
the hostname. The hive server strips the `/hive` prefix before routing, so
`/hive/api/view` and `/api/view` are the same endpoint.

The hostname `hive.44.192.48.70.sslip.io` exists only as the CloudFront
origin (CloudFront cannot target a bare IP). It serves no public UI.

- `provision-box.sh` — idempotent root provisioner. Installs units and
  wrapper only when content differs, keeps an existing
  `/etc/hive-v2/web.env`, renders and reloads nginx. Installs the pinned
  nexus-push MCP client to `/opt/nexus-push/` (pins at the top of the
  section, bump both to upgrade).
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
   - on the citadel repo, secret `HIVE_ORIGIN_KEY` = the `HIVE_ORIGIN_KEY`
     line from `/etc/hive-v2/web.env` on the box. The citadel deploy-nexus
     workflow consumes it to set the CloudFront origin header; this repo
     never reads it from GitHub.

3. Done. Every push to main that touches `src/`, `web/`, `infra/`, or the
   package files runs the gate and then deploys over SSM.

## Swapping the origin hostname (e.g. to hive.dexima.ai)

The CloudFront origin hostname is a deploy-time context on the citadel side,
so the swap is four steps, no code archaeology:

1. Point the new hostname's DNS at the box (`44.192.48.70`).
2. Cert on the box: `sudo certbot --nginx -d hive.dexima.ai` (http-01 works
   once DNS resolves; the le-http01 nginx site already answers challenges).
3. Edit `infra/box/nginx-hive.conf`: `server_name` and both
   `ssl_certificate*` paths to the new hostname, push. The deploy workflow
   reprovisions the box. `nginx -t` gates the reload, so a missing cert
   fails safe.
4. On the citadel repo set the variable `HIVE_ORIGIN_HOST` to the new
   hostname. The next deploy-nexus run points CloudFront at it.

The old sslip hostname then serves nothing and its cert can lapse.


## Drift adoption

The systemd units, wrapper, and nginx site on the box were hand-rolled and
are committed here. `provision-box.sh` only rewrites a file when content
differs and never touches an existing env file, so a redeploy is a no-op
config-wise: same units, same nginx config, clean reload.
