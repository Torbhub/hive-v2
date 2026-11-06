# Hermes T01 disposable preflight runbook

No paid run is authorized by this workflow. It installs Hermes and checks connectivity only. The broker exposes no model endpoint. The separate TeamKimi broker PR owns paid admission, model limits, token limits, and dollar limits.

## Before the first run

1. Create the `t01-smoke` GitHub environment with required reviewer approval. Restrict it to `main`.
2. Set `HIVE_T01_SMOKE_ROLE_ARN` in that environment to the `T01SmokeRoleArn` stack output.
3. Set `T01_VPC_ID`, `T01_SUBNET_ID`, and `T01_AMI_ID`. Use a reviewed Amazon Linux 2023 x86_64 AMI.
4. Use a subnet outside the Nexus production worker network.
5. Keep `T01_TEAMKIMI_SECRET_KEY` at `apiKey` and `T01_TEAMKIMI_CONNECTIVITY_PATH` at `/health` unless a reviewed change requires different values.
6. Run `python3 infra/t01-smoke/teamkimi_attestation.py` on the host with the existing TeamKimi CLI. Set its JSON output as `T01_HEALTH_ATTESTATION` in the environment. The output contains only aggregate account and successful-probe counts plus timestamps. It contains no names, credentials, URLs, or responses.

The helper requires a recent successful zero-spend quota probe. This probe proves TeamKimi account connectivity without model discovery or a model request. Do not read the TeamKimi configuration or copy its broad proxy key.

The workflow creates a random health credential that expires after the requested lifetime plus 15 minutes. Its secret name is `hive-v2-t01-smoke-health-<run-id>`. The secret contains the health key, run ID, and sanitized attestation. It contains no TeamKimi account credential.

The disposable Lambda accepts only authenticated `GET /health` requests. It checks the run ID, expiry, and attestation. It has no model, discovery, forwarding, or general status route. The preflight stack receives the Lambda HTTPS origin and secret ARN dynamically. The health secret uses the AWS-managed Secrets Manager key.

The instance and Lambda roles can read only the run secret. No operator adds a broad instance profile.

## Execute the no-spend preflight

1. Open **Actions**, then **t01-smoke**, then **Run workflow**.
2. Select the reviewed commit.
3. Enter `preflight` for `scenario` and `none` for `matrix`.
4. Leave `paid_admission` as `false`. A `true` value fails before AWS credentials are used.
5. Enter every token, API-call, cost, admission, and lifetime cap. Set `max_paid_admissions=0`. Any other admission value fails before AWS credentials are used.
6. Use a lifetime from 5 through 120 minutes. The instance terminates at that deadline even if the workflow stops.
7. Start the workflow. It acquires the fleet deploy mutex before any AWS act. It creates the health secret and broker before the preflight stack. It renews the mutex every ten minutes during collection and releases it during cleanup.

The workflow uses only the `t01-smoke` environment role. It has no push, pull-request, schedule, or external-call trigger.

## Evidence review

1. Wait for the connectivity checks and cleanup steps to finish.
2. Download `t01-preflight-<run-id>`. The artifact contains only `T01_EVIDENCE` JSON lines from the instance console.
3. Check the Hermes commit, source hash, frozen install, and disabled lazy-install records.
4. Check that every direct-IP, DNS, redirect, IPv6, alternate-port, metadata, and container-credential check passed.
5. Check that `teamkimi_no_model` passed. This check uses the health-only Lambda and sends no model request.
6. Check that the final `complete` record has `passed` status. Any missing or failed record blocks later smoke work.
7. Record the evidence review in Citadel #2345. Do not copy credentials, raw responses, prompts, reasoning, session databases, or console logs into the issue.

## Credential revocation

1. Cleanup force-deletes the run health secret after both stacks are confirmed absent. This revokes the health credential. No production TeamKimi credential needs revocation.
2. Record the public credential identifier, deletion time, operator, and deletion version metadata. Never record the health credential.
3. Remove `T01_HEALTH_ATTESTATION` after the run.
4. Treat any evidence leak as a credential exposure. Delete the run secret first, then review the leak.

## Termination

The instance terminates automatically at the requested lifetime. Its encrypted root volume deletes on termination. The workflow deletes both CloudFormation stacks and the run health secret after evidence collection, including after a failed run.

If the workflow stops, start no manual instance. Use the normal stack deployment controls under the fleet deploy mutex to delete `hive-v2-t01-smoke` and `hive-v2-t01-broker`. Confirm that the instance, instance profile, instance role, security group, Lambda resources, and run secret are gone. Do not change the shared Nexus box or production TeamKimi proxy.

## Mutex recovery

Cleanup releases the mutex only after confirmed absence of both stacks and the run secret. An AccessDenied, throttle, network, delete, or wait error returns nonzero and retains the mutex. Do not release the mutex after an uncertain cleanup. Never delete the mutex row by hand.

Investigate the stacks through the normal deployment controls while the same owner holds the mutex. Renew the mutex during active recovery. After confirmed deletion, run `bash infra/t01-smoke/workflow.sh cleanup` with the original `GITHUB_RUN_ID`. Confirmed absence permits the owner-safe release.

A release error also returns nonzero. If all resources are already absent, run the same cleanup command after the AWS error clears. The retry releases only the same owner's mutex.

## Artifact deletion

GitHub deletes the evidence artifact after seven days. Delete the artifact sooner after the evidence review when the issue contains the required sanitized results. If GitHub retention fails, delete the artifact through the GitHub Actions controls and record the deletion. Do not download old artifacts to preserve them beyond seven days.

## Live-only checks

Static tests cannot prove these results. The first reviewed run must confirm them before any later smoke proposal:

- The selected AMI contains the required `iptables`, `systemd`, and Python 3.11 bootstrap controls.
- The frozen Hermes build completes from the pinned source and `uv.lock` hashes.
- The health-only Lambda accepts the current run credential, rejects other requests, and validates fresh no-model TeamKimi probe evidence.
- The host firewall and service address rules deny every negative destination.
- Console output remains available throughout installation and contains only the expected evidence markers.
- The workflow role permissions cover both stack lifecycles and the run secret without broader access.
- Automatic termination, both stack deletions, and health-secret deletion finish within the requested lifetime.
