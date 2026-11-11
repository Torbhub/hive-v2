# Hermes T01 disposable preflight and paid-matrix runbook

No paid run is authorized by this change. The default dispatch remains `preflight`, `matrix=none`, `paid_admission=false`, and `max_paid_admissions=0`. The count scenario also keeps paid admission and every generation cap at zero. The full matrix requires the reviewed TeamKimi attestation, its exact policy hash, and the external security and real-money gates.

The local health broker remains separate from the TeamKimi smoke listener. The disposable instance reaches that listener only through the fixed SSM port-forward document `hive-v2-t01-teamkimi-port-forward`. The document forwards loopback port 8765 to port 8765 on the existing host tagged `Role=nexus-kimi-session`. The disposable instance role has only `ssm:StartSession` for that document and host. It has no `ssm:SendCommand`, public listener, SSH-agent forwarding, account credential, or broad proxy key access.

## Before the first run

1. Create the `t01-smoke` GitHub environment with required reviewer approval. Restrict it to `main`.
2. Set `HIVE_T01_SMOKE_ROLE_ARN` in that environment to the `T01SmokeRoleArn` stack output.
3. Set `T01_VPC_ID`, `T01_SUBNET_ID`, and `T01_AMI_ID`. Use a reviewed Amazon Linux 2023 x86_64 AMI.
4. Use a subnet outside the Nexus production worker network. Set `T01_RESOLVER_IP` to a reviewed IPv4 resolver in that network. The security group allows UDP and TCP port 53 only to this resolver as a `/32`.
5. Run `python3 infra/t01-smoke/teamkimi_attestation.py` on the host with the existing TeamKimi CLI. Set its JSON output as `T01_HEALTH_ATTESTATION` in the environment. The output contains only aggregate account and successful-probe counts plus timestamps. It contains no names, credentials, URLs, or responses.

The helper requires a recent successful zero-spend quota probe. This probe proves TeamKimi account connectivity without model discovery or a model request. Do not read the TeamKimi configuration or copy its broad proxy key.

The workflow creates a random health credential that expires after the requested lifetime plus 15 minutes. Its secret name is `hive-v2-t01-smoke-health-<run-id>`. The secret contains the health key, run ID, and sanitized attestation. It contains no TeamKimi account credential.

The local broker exposes its health check only on loopback. It checks the run ID, expiry, and attestation in the run secret. It has no model, discovery, forwarding, or general status route. Hermes never receives the synthetic health credential. The health secret uses the AWS-managed Secrets Manager key.

The instance role has a permission boundary that allows only the run secret read, evidence writes, and the fixed SSM tunnel. Inline policies cannot grant broader access. The workflow role session lasts 9000 seconds to cover the longest job. No operator adds a broad instance profile.

The T01 workflow role can replace a boundary only with the same reviewed policy. It cannot detach a boundary. A CloudFormation rollback that requires detachment fails and leaves the boundary in place. This safe failure prevents an unbounded role. Recovery must use the root deployment controls and must not add detachment permission to the T01 role.

## Normal infrastructure deploy and rollback

The fixed SSM document, role boundaries, and encrypted evidence bucket live in `infra/template.yaml`. Merge the reviewed change to `main`. The normal `deploy` workflow owns the `hive-v2-infra` stack update. Do not create the document, edit IAM, create a bucket, or start a tunnel by hand.

If the stack update fails, use the normal deploy workflow rollback controls for `hive-v2-infra`. The workflow handles `UPDATE_ROLLBACK_FAILED` with `continue-update-rollback` when required. Do not detach a T01 boundary to make rollback pass. Rollback does not authorize a count or matrix dispatch.

## Execute the no-spend preflight

1. Open **Actions**, then **t01-smoke**, then **Run workflow**.
2. Select the reviewed commit.
3. Enter `preflight` for `scenario` and `none` for `matrix`.
4. Leave `paid_admission` as `false`. A `true` value fails before AWS credentials are used.
5. Enter every token, API-call, cost, admission, and lifetime cap. Set `max_paid_admissions=0`. Any other admission value fails before AWS credentials are used.
6. Use a lifetime from 5 through 120 minutes. The instance terminates at that deadline even if the workflow stops.
7. Start the workflow. It acquires the fleet deploy mutex before any AWS act. It creates the health secret and preflight stack. After stack creation, it refreshes the attestation in the same secret. The refresh preserves the health key and original expiry. It renews the mutex every ten minutes throughout the critical section and stops renewal before the final release.

Preflight, count, and matrix use the existing deploy role for the fixed host attestation command. Count also uses that role for its two fixed host commands. The `t01-smoke` environment role performs the other AWS steps. The workflow has no push, pull-request, schedule, or external-call trigger.

## Execute the count-only probe

1. Complete and review the no-spend preflight first.
2. Let the normal deploy install the reviewed TeamKimi PR #20 source. The commit is `35b0d0d9b2e124b3418e3c049bd79c2f857b8cfe`. The codeload archive SHA-256 is `e5584a3d9e8cc7b4b4196146f39f0964f06adc2fe79b5fbb5b7631a848972b58`. Provisioning installs read-only source and a disabled template. It does not start TeamKimi or change `teamkimi-tmux.service`.
3. Dispatch `scenario=count`, `matrix=none`, and `paid_admission=false`.
4. Set `max_total_tokens=0`, `max_api_calls=0`, `max_estimated_cost_usd=0`, and `max_paid_admissions=0`. Any paid cap or admission fails before AWS credentials are used.
5. After validation and one fleet mutex acquisition, the workflow uses `HIVE_DEPLOY_ROLE_ARN` only for the fixed host start and stop commands. It uses the T01 smoke role for every other step. The start command checks the source stamp and an unused loopback port. The normal proxy must stay active with an unchanged nonzero PID. The run unit must stay active, and its nonzero PID must own the loopback listener.
6. The listener uses `/var/lib/teamkimi-count/<run-id>/ledger.json` and its run-specific crash log. Shared config and home paths are read-only. The service has no secret arguments, no restart, no boot enablement, and a three-hour lifetime.
7. The disposable service installs and checks Hermes before lockdown. It starts the fixed tunnel before lockdown, then uses only loopback smoke control routes. The broker context must receive local rejections for generation mint and `/v1/messages`.
8. The Node count probe mints a `count-only` credential, sends the frozen synthetic count request once, checks zero reservations and zero admissions, and revokes the credential in `finally`.
9. Review `count_only_no_generation` and `count-host.jsonl`. They contain only fixed checks, count evidence, and revocation proof. They contain no credential, account name, request body, response body, raw SSM output, or upstream error text.
10. The stop step always runs after count. It requires no live credentials or reservations. It checks listener ownership again, then stops only the run unit. It confirms the closed port and unchanged active normal proxy. Confirm `count_stop`, `count_port_closed`, `tunnel_cleanup`, and the final passing `complete` record.

A failed or uncertain stop retains the fleet mutex and the run ledger. Stack and run-secret cleanup still runs. Keep the run state for review. Automatic stop fails closed on an inactive or uncertain listener. Do not dispatch `count-recovery` for a failed or uncertain stop. Use the prior reviewed loopback and manual recovery process. Prove revocation, empty reservations, a closed port, and an unchanged active normal proxy before any further cleanup or release. Keep the original owner and run state during this review. Do not use an offline ledger parser. Do not delete uncertain state or release the mutex by hand. Never continue with an unresolved reservation or failed revocation.

Use `count-recovery` only for an original failed count run whose fixed host stop succeeded but later evidence or cleanup failed. Dispatch this workflow with `scenario=count-recovery` and `recovery_run_id=<original-run-id>`. GitHub verifies the original failed count job and stop evidence before OIDC. The environment approval is the explicit recovery review. The workflow sets `T01_REVIEWED_UNCERTAIN_CLEANUP=yes` and `T01_COUNT_STOP_VERIFIED=yes`. It renews the original owner before cleanup and releases only that owner after successful cleanup. Do not run cleanup manually for this post-stop recovery.

A count probe does not authorize generation. The workflow does not issue a generation credential in count mode. Matrix remains separately reviewed and is not enabled by this change.

## Evidence order before the full matrix

1. Deploy the reviewed TeamKimi broker with paid admission blocked and pricing absent.
2. Complete the environment, installation, health, and connectivity preflight.
3. Complete the count-only probe. Review its counted input and revocation proof.
4. Review the route, model, six price rates, cache accounting, TTL accounting, and exact provider semantics identifiers. Do not copy Open Platform prices to the Kimi Code membership route.
5. Set `T01_PRICING_ATTESTATION` to the complete reviewed attestation. Set `T01_EXPECTED_POLICY_HASH` to its exact TeamKimi policy fingerprint. The workflow recomputes the fingerprint before AWS credentials. The adapter and runner require the same hash again.
6. Confirm the attestation `evidenceHash`, validity window, and these semantics identifiers: `independent-output-ceiling`, `independent-reasoning-ceiling`, and `messages-total-input-output-reasoning-v1`. These identifiers are the reviewed contract. They are not independent proof of provider behavior.
7. Obtain the external `gate:security` and `gate:real-money` approvals for the explicit P01-P12 dispatch.

The provisioner issues a generation credential only after installation, all no-generation checks, count revocation, and these dispatch gates. Hive does not mark pricing verified. TeamKimi derives that state from the complete attestation.
For matrix, the workflow uses the repository `TEAMKIMI_PROXY_KEY` secret to create a run-scoped proxy secret. Only the root paid service reads `/etc/t01/proxy.env`. Preflight and count do not create or read that file.

## Execute the explicit full matrix

1. Use only `scenario=matrix`, `matrix=full`, and `paid_admission=true`.
2. Set `max_input_tokens=16000`, `max_output_tokens=2000`, `max_reasoning_tokens=4000`, `max_total_tokens=132000`, `max_api_calls=12`, `max_estimated_cost_usd=5`, and `max_paid_admissions=12`.
3. Keep the model at `kimi-code/k3.1-pro`. Every other scenario, matrix, cap, model, or admission combination fails before AWS credentials are used.
4. The runner admits P01 through P12 once. Only P11 and P12 may overlap. P07 must fail, P08 through P10 must cancel, and every other scenario must succeed.
5. Every terminal receipt must match the expected policy hash, counted input, cache TTL buckets, reasoning usage, exact total tokens, and cost from all six attested rates.
6. A missing field, policy mismatch, counted-input mismatch, cost mismatch, malformed terminal event, or ambiguous reservation aborts later admissions. Outer CLI and runner guards revoke the exact generation ID and require its final proof.

The CLI generates one random attempt key for generation. Bounded recovery polls that attempt and retries the same mint after a 404. Public-only recovery revokes the resolved ID and fails closed. Never use broad revocation for recovery.

## Evidence review

1. Wait for the connectivity checks and cleanup steps to finish.
2. Download `t01-preflight-<run-id>`. Every console candidate passes schema-only sanitization before it reaches the artifact. Rejected or oversized input is never uploaded. A runtime-check `bootstrap_error.category` names only the fixed internal subcheck and never contains raw Hermes output.
3. For a matrix, review `export/manifest.json`, `export/preflight.json`, and every `export/P01.json` through `export/P12.json`. The downloaded manifest hash must equal the console export marker before verification. The workflow checks membership, hashes, scenario outcomes, receipt arithmetic, policy hash, and exact generation revocation. Artifact upload must succeed before cleanup. Failed verification never reaches the artifact and blocks destructive cleanup.
4. Check the Hermes commit, source hash, frozen install, and disabled lazy-install records.
5. Check that every direct-IP, DNS, redirect, IPv6, alternate-port, metadata, container-credential, and TeamKimi control-port check passed. The broker must retain control access while Hermes cannot call it.
6. Check that `teamkimi_no_model` passed. This check uses the local health validator and sends no model request.
7. Check that the final `complete` record has `passed` status. Any missing or failed record blocks later smoke work.
8. Record the evidence review in Citadel #2345. Do not copy credentials, raw responses, prompts, reasoning, session databases, or console logs into the issue.

## Credential revocation

1. Cleanup force-deletes the run health and proxy secrets after the stack is confirmed absent. This revokes the health credential and deletes the control key. No production TeamKimi credential needs revocation.
2. Record the public credential identifier, deletion time, operator, and deletion version metadata. Never record the health credential or control key.
3. Remove `T01_HEALTH_ATTESTATION` after the run.
4. Treat any evidence leak as a credential exposure. Delete the run secret first, then review the leak.

## Termination

The instance terminates automatically at the requested lifetime. Its encrypted root volume deletes on termination. The workflow deletes the CloudFormation stack and run secrets after evidence collection, including after a failed run. Matrix stacks remain in place until external evidence verification and artifact upload pass, or the reviewed recovery path permits cleanup.

If the workflow stops, start no manual instance. Use the normal stack deployment controls under the fleet deploy mutex to delete `hive-v2-t01-smoke`. Confirm that the instance, instance profile, instance role, security group, and run secrets are gone. Do not change the shared Nexus box or production TeamKimi proxy.

## Mutex recovery

Cleanup releases the mutex only after confirmed absence of the stack and run secrets. An AccessDenied, throttle, network, delete, or wait error returns nonzero and retains the mutex. Do not release the mutex after an uncertain cleanup. Never delete the mutex row by hand.

Count and matrix cleanup also requires a valid paid evidence sequence. Stack deletion alone does not prove smoke revocation or reservation reconciliation. If paid evidence is missing, incomplete, or uncertain, cleanup retains the mutex even when the stack is absent.

Investigate the stack through the normal deployment controls while the same owner holds the mutex. Investigate TeamKimi status, revocation proof, and any ambiguous reservation through the reviewed loopback controls. Renew the mutex during active recovery. For post-stop count recovery, use the workflow dispatch above with the original run ID. For reviewed matrix recovery after confirmed deletion and paid recovery, run `bash infra/t01-smoke/workflow.sh cleanup` with the original `GITHUB_RUN_ID`, `SCENARIO`, and `T01_REVIEWED_UNCERTAIN_CLEANUP=yes`. Confirmed absence and this explicit review permit the owner-safe release. Never set that recovery variable or dispatch count recovery for an unresolved reservation or failed revocation.

A release error also returns nonzero. If all resources are already absent, repeat the same reviewed recovery path after the AWS error clears. Count recovery uses a new workflow dispatch with the original run ID. Other scenarios use the same cleanup command. The retry releases only the same owner's mutex.

## Artifact deletion

GitHub deletes the evidence artifact after seven days. Delete the artifact sooner after the evidence review when the issue contains the required sanitized results. If GitHub retention fails, delete the artifact through the GitHub Actions controls and record the deletion. Do not download old artifacts to preserve them beyond seven days.

## Live-only checks

Static tests cannot prove these results. The first reviewed run must confirm them before any later smoke proposal:

- The selected AMI contains the required `iptables`, `systemd`, and Python 3.11 bootstrap controls.
- The frozen Hermes build completes from the pinned source and `uv.lock` hashes. The pinned Node archive and locked runner-only TypeScript build complete without a frontend build.
- The fixed SSM document starts only on the tagged host and reaches only the loopback TeamKimi smoke listener. No public listener or `SendCommand` permission exists.
- Normal provisioning installs the exact source without starting the count unit or changing the normal proxy. The host start and stop checks prove port ownership, zero live credentials, zero reservations, and an unchanged normal proxy PID.
- The broker context receives local HTTP rejections for generation mint and `/v1/messages`. The Hermes network check alone does not prove these rejections.
- Hermes has no metadata, AWS, proxy, SSH-agent, account, or smoke credential access. Only the broker context holds the short-lived smoke credential.
- The count probe performs one provider count, zero generation, complete revocation, and tunnel cleanup before generation credential issuance.
- Every paid receipt matches the attestation hash, counted input, cache TTL buckets, reasoning usage, total tokens, and matrix ceilings.
- The local broker accepts the current run, rejects expired and cross-run health state, and validates fresh no-model TeamKimi probe evidence without exposing the credential to Hermes.
- The host firewall and service address rules deny every negative destination.
- Console output remains available throughout installation and contains only the expected evidence markers.
- The workflow role permissions cover the stack lifecycle and run secret without broader access.
- Automatic termination, stack deletion, and health-secret deletion finish within the requested lifetime.
