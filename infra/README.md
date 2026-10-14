# hive-v2 infrastructure

Committed infrastructure for the hive-v2 hub site
(`https://hive.44.192.48.70.sslip.io/`), which runs on the kimi session box
(a dedicated EC2 instance). One CloudFormation stack plus the box config that
used to be hand-rolled.

- `template.yaml` — stack `hive-v2-infra`: the basic-auth secret in Secrets
  Manager and the IAM role the GitHub deploy workflow assumes over OIDC.
- `box/` — the live box config, adopted byte-for-byte: both systemd units,
  the `hive` wrapper, and the nginx site (with `__HIVE_WEB_SECRET__` and
  `__HIVE_ORIGIN_KEY__` placeholders, rendered at provision time).

## The two ways in

- **nexus embed**: nexus.dexima.ai's CloudFront proxies `/hive/*` to the box's
  nginx vhost with a custom origin header `x-hive-origin: <HIVE_ORIGIN_KEY>`.
  The nexus session gate is the auth; nginx only checks the origin key on
  `location /hive/` and never asks for basic auth there. The hive server
  strips the `/hive` prefix before routing, so `/hive/api/view` and
  `/api/view` are the same endpoint.
- **standalone fallback**: `https://hive.44.192.48.70.sslip.io/` at the root
  keeps the Let's Encrypt + basic-auth setup unchanged.
- `provision-box.sh` — idempotent root provisioner. Installs units and
  wrapper only when content differs, keeps an existing
  `/etc/hive-v2/web.env` and htpasswd file, renders and reloads nginx.
- `deploy-box.sh` — what the workflow runs on the box over SSM: fetch, reset
  to the merged commit, `npm ci`, build, provision, health-check.
- `.github/workflows/deploy.yml` — gate job (test, build, lint) then deploy.

## Bootstrap ceremony (once, by the operator)

1. From an admin shell in account 594552273052, with the password the live
   site already uses:

   ```bash
   aws cloudformation deploy \
     --stack-name hive-v2-infra \
     --template-file infra/template.yaml \
     --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides HiveBasicAuthPassword='<existing basic-auth password>'
   ```

   The password must be the existing live one so the running site never
   breaks. It lands in Secrets Manager as
   `citadel/kimi-permanent-01/hive-basicauth` (`{"username":"alex",...}`).

2. In the GitHub repo settings, set:
   - secret `HIVE_DEPLOY_ROLE_ARN` = the stack's `DeployRoleArn` output
   - secret `HIVE_BASIC_AUTH_PASSWORD` = the same password
   - secret `HIVE_ORIGIN_KEY` = the `HIVE_ORIGIN_KEY` line from
     `/etc/hive-v2/web.env` on the box (`sudo grep HIVE_ORIGIN_KEY
     /etc/hive-v2/web.env`). The citadel deploy-nexus workflow consumes it to
     set the CloudFront origin header; this repo never reads it from GitHub.
   - variable `KIMI_BOX_ID` = `i-004e23820520cbf3c`

3. Done. Every push to main that touches `src/`, `web/`, `infra/`, or the
   package files runs the gate and then deploys over SSM.

## Drift adoption

The systemd units, wrapper, and nginx site on the box were hand-rolled and
are committed here unchanged. `provision-box.sh` only rewrites a file when
content differs and never touches an existing env file or htpasswd file, so
the first SSM deploy is a no-op config-wise: same units, same nginx config,
same secrets, clean reload.

## Rotating the basic-auth password

1. Update the stack parameter and the `HIVE_BASIC_AUTH_PASSWORD` GitHub
   secret to the new value.
2. On the box: `printf '%s' '<new password>' | sudo bash infra/provision-box.sh`
   (the password only ever travels on stdin, never argv).
