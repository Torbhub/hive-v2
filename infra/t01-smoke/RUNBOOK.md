# Hermes T01 disposable preflight runbook

No paid run is authorized. This workflow installs Hermes and checks connectivity only. The broker exposes no model endpoint. The separate TeamKimi broker PR owns paid admission, model limits, token limits, and dollar limits.

## Before the first run

1. Confirm that `gate:security` and `gate:real-money` remain uncleared in `docs/hermes-t01-no-model-spike.md`.
2. Create the `t01-smoke` GitHub environment with required reviewer approval. Restrict it to `main`.
3. Set `HIVE_T01_SMOKE_ROLE_ARN` in that environment to the `T01SmokeRoleArn` stack output.
4. Set the environment variables `T01_VPC_ID`, `T01_SUBNET_ID`, `T01_AMI_ID`, `T01_TEAMKIMI_URL`, and `T01_TEAMKIMI_SECRET_ARN`. Use a reviewed Amazon Linux 2023 x86_64 AMI.
5. Set `T01_TEAMKIMI_SECRET_KEY` when the secret JSON uses a key other than `apiKey`.
6. Set `T01_TEAMKIMI_CONNECTIVITY_PATH` to a TeamKimi endpoint that returns HTTP 2xx without a model request.
7. Use a subnet outside the Nexus production worker network. Use a secret encrypted with the AWS-managed Secrets Manager key. A customer KMS key needs a separate scoped grant.
8. Store a short-lived, smoke-only TeamKimi credential in the referenced secret. Keep the real account credential only in that secret. The secret name must start with `hive-v2-t01-smoke-`.

The instance role can read only the referenced secret. The role cannot deploy, read other secrets, or write artifacts. No operator adds a broad instance profile.

## Execute the no-spend preflight

1. Open **Actions**, then **t01-smoke**, then **Run workflow**.
2. Select the reviewed commit.
3. Enter `preflight` for `scenario` and `none` for `matrix`.
4. Leave `paid_admission` as `false`. A `true` value fails before AWS credentials are used.
5. Enter every token, API-call, cost, admission, and lifetime cap. The workflow requires explicit values even though this run spends nothing.
6. Use a lifetime from 5 through 120 minutes. The instance terminates at that deadline even if the workflow stops.
7. Start the workflow. It acquires the fleet deploy mutex before the stack act and releases the mutex during cleanup.

The workflow uses only the `t01-smoke` environment role. It has no push, pull-request, schedule, or external-call trigger.

## Evidence review

1. Wait for the connectivity checks and cleanup steps to finish.
2. Download `t01-preflight-<run-id>`. The artifact contains only `T01_EVIDENCE` JSON lines from the instance console.
3. Check the Hermes commit, source hash, frozen install, and disabled lazy-install records.
4. Check that every direct-IP, DNS, redirect, IPv6, alternate-port, metadata, and container-credential check passed.
5. Check that `teamkimi_no_model` passed. This check uses the configured health endpoint and sends no model request.
6. Check that the final `complete` record has `passed` status. Any missing or failed record blocks later smoke work.
7. Record the evidence review in Citadel #2345. Do not copy credentials, raw responses, prompts, reasoning, session databases, or console logs into the issue.

## Credential revocation

1. Revoke the smoke-only TeamKimi credential after each run or abort. Use the TeamKimi account control plane outside the disposable instance.
2. Record the credential identifier, revocation time, and operator. Never record the credential.
3. Remove the secret value after revocation. Keep the ARN reference only if the next reviewed run needs it.
4. Treat any evidence leak as a credential exposure. Revoke first, then review the leak.

## Termination

The instance terminates automatically at the requested lifetime. Its encrypted root volume deletes on termination. The workflow deletes the CloudFormation stack after evidence collection, including after a failed run.

If the workflow stops, start no manual instance. Use the normal stack deployment controls under the fleet deploy mutex to delete `hive-v2-t01-smoke`. Confirm that the instance, instance profile, instance role, and security group are gone. Do not change the shared Nexus box.

## Artifact deletion

GitHub deletes the evidence artifact after seven days. Delete the artifact sooner after the evidence review when the issue contains the required sanitized results. If GitHub retention fails, delete the artifact through the GitHub Actions controls and record the deletion. Do not download old artifacts to preserve them beyond seven days.

## Live-only checks

Static tests cannot prove these results. The first reviewed run must confirm them before any later smoke proposal:

- The selected AMI contains the required `iptables`, `systemd`, and Python runtime controls.
- The frozen Hermes build completes from the pinned source and `uv.lock` hashes.
- The configured TeamKimi health endpoint proves account connectivity without model discovery or a model request.
- The host firewall and service address rules deny every negative destination.
- Console output remains available throughout installation and contains only the expected evidence markers.
- The workflow role permissions cover the exact stack lifecycle without broader access.
- Automatic termination and stack cleanup finish within the requested lifetime.
