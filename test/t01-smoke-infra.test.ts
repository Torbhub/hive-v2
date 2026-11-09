import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const paths = {
  template: '../infra/t01-smoke/template.yaml',
  provision: '../infra/t01-smoke/provision.sh',
  workflowScript: '../infra/t01-smoke/workflow.sh',
  healthCredential: '../infra/t01-smoke/health_credential.py',
  attestation: '../infra/t01-smoke/teamkimi_attestation.py',
  workflow: '../.github/workflows/t01-smoke.yml',
  runbook: '../infra/t01-smoke/RUNBOOK.md',
  infraReadme: '../infra/README.md',
  deployWorkflow: '../.github/workflows/deploy.yml',
  deployMutex: '../infra/deploy-mutex.sh',
  prePush: '../scripts/git-hooks/pre-push',
  trustTemplate: '../infra/template.yaml',
};

function read(key: keyof typeof paths): string {
  const path = fileURLToPath(new URL(paths[key], import.meta.url));
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

const validInputs = {
  PATH: process.env.PATH,
  SCENARIO: 'preflight',
  MATRIX: 'none',
  PAID_ADMISSION: 'false',
  MAX_INPUT_TOKENS: '16000',
  MAX_OUTPUT_TOKENS: '2000',
  MAX_REASONING_TOKENS: '4000',
  MAX_TOTAL_TOKENS: '22000',
  MAX_API_CALLS: '1',
  MAX_ESTIMATED_COST_USD: '0.50',
  MAX_PAID_ADMISSIONS: '0',
  LIFETIME_MINUTES: '60',
};

function validate(overrides: Record<string, string | undefined> = {}) {
  const script = fileURLToPath(new URL(paths.workflowScript, import.meta.url));
  return spawnSync('bash', [script, 'validate-inputs'], {
    env: { ...validInputs, ...overrides },
    encoding: 'utf8',
  });
}

describe('T01 disposable smoke infrastructure', () => {
  it('runs only from an explicit workflow dispatch with all caps supplied', () => {
    const workflow = read('workflow');
    expect(workflow).toMatch(/on:\n  workflow_dispatch:/);
    expect(workflow).not.toMatch(/\n  (push|pull_request|schedule):/);
    for (const input of [
      'scenario', 'matrix', 'paid_admission', 'max_input_tokens',
      'max_output_tokens', 'max_reasoning_tokens', 'max_total_tokens',
      'max_api_calls', 'max_estimated_cost_usd', 'max_paid_admissions',
      'lifetime_minutes',
    ]) {
      expect(workflow).toMatch(new RegExp(`${input}:\\n\\s+description:`));
      expect(workflow).toMatch(new RegExp(`${input}:[\\s\\S]*?required: true`));
    }
    expect(workflow).toMatch(/paid_admission:[\s\S]*?default: false/);
  });

  it('accepts a bounded no-spend preflight', () => {
    const result = validate();
    expect(result.status).toBe(0);
  });

  it('rejects paid admission and incomplete inputs before any AWS step', () => {
    expect(validate({ PAID_ADMISSION: 'true' }).status).not.toBe(0);
    expect(validate({ SCENARIO: undefined }).status).not.toBe(0);
    expect(validate({ MATRIX: 'P01' }).status).not.toBe(0);
    expect(validate({ MAX_OUTPUT_TOKENS: '2001' }).status).not.toBe(0);
    expect(validate({ MAX_PAID_ADMISSIONS: '1' }).status).not.toBe(0);
    expect(validate({ MAX_PAID_ADMISSIONS: '13' }).status).not.toBe(0);
    expect(validate({ LIFETIME_MINUTES: '121' }).status).not.toBe(0);
  });

  it('pins Hermes and installs from the frozen hash lock before lockdown', () => {
    const provision = read('provision');
    expect(provision).toContain('f0d94882e89ab8d4098b5bb2f166adfb9ee0a0ab');
    expect(provision).toContain('551f2c190f21a0df8e0576a20809c63d3077bc56568fe009b98b289fae2efa81');
    expect(provision).toContain('v0.22.6');
    expect(provision).toContain('"baseVersion":"0.22.6"');
    expect(provision).toContain('"$HERMES_COMMIT" "$HERMES_ARCHIVE_SHA256" > /opt/t01/source/install-stamp.json');
    expect(provision).toContain('Environment=HERMES_INSTALL_ROOT=/opt/t01/source');
    expect(provision).toContain('uv.lock');
    expect(provision).toContain('dnf install -y');
    expect(provision).toContain('python3.11 python3.11-devel');
    expect(provision).toContain('timeout --signal=TERM --kill-after=30s 600 python3.11');
    expect(provision).toContain('timeout --signal=TERM --kill-after=30s 1800 python3.11 -m pm.build_env');
    expect(provision).toMatch(/pm\.build_env[\s\S]*--extra mcp[\s\S]*--sealed/);
    expect(provision).toContain('allow_lazy_installs: false');
    expect(provision).toContain('UV_OFFLINE=1');
    expect(provision).toContain('UV_FROZEN=1');
    expect(provision).toContain('emit uv_install passed');
    expect(provision).toContain('emit python_install passed');
    expect(provision.indexOf('lock_down')).toBeLessThan(provision.lastIndexOf('hermes-check'));
  });

  it('installs Session Manager from a verified versioned RPM', () => {
    const provision = read('provision');
    expect(provision).toContain('SESSION_MANAGER_PLUGIN_VERSION=1.2.896.0');
    expect(provision).toContain('SESSION_MANAGER_PLUGIN_SHA256=89a4a07fcb92169bdd2f07c2531acd11b84857338172e7638964aaa08fd5f0e3');
    expect(provision).toContain('https://s3.amazonaws.com/session-manager-downloads/plugin/$SESSION_MANAGER_PLUGIN_VERSION/linux_64bit/session-manager-plugin.rpm');
    const checksum = 'printf \'%s  %s\\n\' "$SESSION_MANAGER_PLUGIN_SHA256" /opt/t01/session-manager-plugin.rpm | sha256sum -c -';
    expect(provision).toContain(checksum);
    const install = provision.split('\n').find((line) => line.trimStart().startsWith('if dnf install -y'));
    expect(install).toContain('/opt/t01/session-manager-plugin.rpm');
    expect(install).not.toContain('iptables session-manager-plugin');
    expect(provision.indexOf(checksum)).toBeLessThan(provision.indexOf(install ?? ''));
  });

  it('uses the provisioned Hermes runtime store in the sealed service', () => {
    const provision = read('provision');
    expect(provision).toContain(
      `Environment=HERMES_INSTALL_ROOT=/opt/t01/source
Environment=PYTHONPATH=/opt/t01/source
Environment=HERMES_RUNTIME_DIR=/opt/t01/tools`,
    );
    expect(provision).toContain('Environment=HERMES_RUNTIME_DIR=/opt/t01/tools');
    expect(provision).toContain('ReadOnlyPaths=/opt/t01/fixtures /opt/t01/hermes /opt/t01/source /opt/t01/tools');
  });

  it('reports the active stage and exit status for generic bootstrap failures', () => {
    const provision = read('provision');
    for (const stage of [
      'filesystem-init', 'input-validation', 'system-packages', 'runtime-download', 'source-download',
      'python-binary', 'pm-build', 'credential-config', 'default-deny-lockdown',
      'broker-access', 'hermes-access', 'broker-start', 'broker-health',
      'hermes-check', 'runtime-version', 'network-negative', 'teamkimi-no-model', 'broker-stop',
    ]) {
      expect(provision).toContain(`BOOTSTRAP_STAGE=${stage}`);
    }
    expect(provision).toContain('category="failure:$BOOTSTRAP_STAGE"');
    expect(provision).toContain('origin="$BOOTSTRAP_STAGE:$status"');
    expect(provision).not.toContain('systemctl show');
  });

  it('leaves the pm build destination absent before the fresh build', () => {
    const provision = read('provision');
    const initialDirectories = provision.split('\n').find((line) => line.startsWith('mkdir -p /opt/t01/source'));
    expect(initialDirectories).toBe('mkdir -p /opt/t01/source /opt/t01/fixtures /opt/t01/tools /opt/t01/pm-home');
  });

  it('separates broker credentials from the sanitized Hermes context', () => {
    const provision = read('provision');
    expect(provision).toContain('t01broker');
    expect(provision).toContain('t01hermes');
    expect(provision).toContain('User=t01broker');
    expect(provision).toContain('User=t01hermes');
    expect(provision).toContain('Environment=HOME=/var/lib/t01/hermes');
    expect(provision).toContain('Environment=HERMES_HOME=/var/lib/t01/hermes');
    expect(provision).toContain('BROKER_PORT=8765');
    expect(provision).toContain('TEAMKIMI_OPENAI_COMPATIBLE_URL=http://127.0.0.1:$BROKER_PORT/v1');
    expect(provision).toContain('ReadOnlyPaths=/opt/t01/fixtures');
    expect(provision).toContain('ReadOnlyPaths=/var/lib/t01/hermes/config.yaml');
    expect(provision).toContain('ProtectSystem=strict');
    expect(provision).toContain('chmod 0400 /etc/t01/broker/teamkimi.json');
    expect(provision).toContain('chmod 0711 /opt/t01 /var/lib/t01 /etc/t01');
    expect(provision).toContain('chmod 0750 /etc/t01/broker');
    expect(provision).toContain('runuser -u t01broker -- test');
    expect(provision).toContain('runuser -u t01hermes -- test');
    expect(provision).toContain('service_filesystem_access');
    expect(provision).toContain('lazy_install_disabled');
    expect(provision).toContain('hermes_version');
    expect(provision).not.toContain('/v1/chat/completions');
    expect(provision).not.toContain('docker.sock');
    expect(provision).not.toContain('--privileged');
    expect(provision).not.toContain('network host');
    expect(provision).not.toContain('pid=host');
  });

  it('denies unapproved IPv4, IPv6, DNS, redirects, and credential endpoints', () => {
    const provision = read('provision');
    for (const control of [
      'iptables -P OUTPUT DROP', 'ip6tables -P OUTPUT DROP',
      '169.254.169.254', '169.254.170.2', 'fd00:ec2::254',
      '--dport 53', 'expect_denied direct_ip', 'expect_denied unapproved_dns',
      'expect_denied redirect', 'expect_denied ipv6', 'expect_denied alternate_port',
      'expect_denied metadata', 'expect_denied container_credentials',
      'expect_allowed teamkimi_no_model', '6|7|28|124',
    ]) {
      expect(provision).toContain(control);
    }
    expect(provision).not.toContain('TEAMKIMI_IP');
    expect(provision).not.toContain('TEAMKIMI_URL');
    expect(provision).toContain('IPAddressDeny=any');
    expect(provision).toContain('127.0.0.1:$BROKER_PORT/health');
  });

  it('creates an isolated encrypted instance with no ingress or broad instance role', () => {
    const template = read('template');
    expect(template).toContain('ImageId: !Ref AmiId');
    expect(template).not.toContain('{{resolve:ssm:');
    expect(template).toContain('InstanceInitiatedShutdownBehavior: terminate');
    expect(template).toContain('DeleteOnTermination: true');
    expect(template).toContain('Encrypted: true');
    expect(template).toContain('HttpTokens: required');
    expect(template).toContain('HttpPutResponseHopLimit: 1');
    expect(template).not.toMatch(/SecurityGroupIngress:\s*\n\s+-/);
    expect(template).toContain('secretsmanager:GetSecretValue');
    expect(template).not.toContain('AdministratorAccess');
    expect(template).not.toContain("Action: '*'");
    expect(template).toContain('TeamKimiSecretArn');
    expect(template).toContain('secret:hive-v2-t01-smoke-');
    expect(template).toContain('ProvisionScriptSha256');
    expect(template).toMatch(/MaxPaidAdmissions:\n\s+Type: Number\n\s+MinValue: 0\n\s+MaxValue: 12/);
    expect(template).toContain('aws-cloudformation@3');
  });

  it('uses a separate environment-scoped workflow role and the fleet mutex', () => {
    const trust = read('trustTemplate');
    const workflow = read('workflow');
    const script = read('workflowScript');
    expect(trust).toContain('T01SmokeRole:');
    expect(trust).toContain(':environment:t01-smoke');
    expect(trust).toContain('token.actions.githubusercontent.com:ref: refs/heads/main');
    expect(trust).toContain('T01SmokeRoleArn:');
    expect(workflow).toContain('environment: t01-smoke');
    expect(workflow).toContain('HIVE_T01_SMOKE_ROLE_ARN');
    expect(script).toContain('deploy-mutex.sh acquire aws-acts');
    expect(script).toContain('deploy-mutex.sh release aws-acts');
    expect(script).toContain('cloudformation delete-stack');
  });

  it('bounds execution, sanitizes evidence, and deletes artifacts after seven days', () => {
    const workflow = read('workflow');
    const provision = read('provision');
    expect(workflow).toContain('retention-days: 7');
    expect(workflow).toContain('if: always()');
    expect(workflow).toContain('timeout-minutes: 150');
    expect(provision).toContain('shutdown -h +');
    expect(provision).toContain('umask 077');
    expect(provision).toContain('chmod 0600 /var/lib/t01/evidence/preflight.jsonl');
    expect(provision).toContain('publish_evidence');
    expect(read('workflowScript')).toContain('T01_EVIDENCE ');
    expect(read('workflowScript')).toContain('"AmiId=$AMI_ID"');
    expect(read('runbook')).toContain('T01_AMI_ID');
  });

  it('keeps health validation on the instance with an expiring run credential and no model route', () => {
    const script = read('workflowScript');
    const workflow = read('workflow');
    expect(script).toContain('hive-v2-t01-smoke-health-${GITHUB_RUN_ID');
    expect(script).toContain('health_secret_arn');
    expect(script).toContain('--force-delete-without-recovery');
    expect(script).not.toContain('deploy_broker');
    expect(script).not.toContain('BROKER_STACK_NAME');
    expect(workflow).toContain('workflow.sh issue-health-credential');
    expect(workflow).not.toContain('deploy-broker');
    expect(read('template')).not.toContain('TeamKimiUrl');
    expect(read('provision')).toContain('expect_broker_rejected teamkimi_messages_rejected 401');
    expect(read('healthCredential')).toContain('secrets.token_urlsafe(32)');
    expect(read('attestation')).toContain("teamkimi status --json --color=never");
  });

  it('recovers a failed infra rollback through the normal deploy workflow', () => {
    const workflow = read('deployWorkflow');
    expect(workflow).toContain('UPDATE_ROLLBACK_FAILED');
    expect(workflow).toContain('aws cloudformation continue-update-rollback --stack-name hive-v2-infra');
    expect(workflow).toContain('aws cloudformation wait stack-rollback-complete --stack-name hive-v2-infra');
  });

  it('bounds AWS sessions and renews the mutex across the whole lifecycle', () => {
    const workflow = read('workflow');
    const script = read('workflowScript');
    expect(workflow).toContain('role-duration-seconds: 9000');
    for (const command of ['issue_health_credential', 'deploy_stack', 'collect_evidence', 'cleanup']) {
      expect(script).toContain(`with_mutex_renewal ${command}`);
    }
    expect(script).toContain('python3 infra/t01-smoke/runtime.py classify-evidence "$candidate"');
    expect(script).toContain('console_error');
    expect(script).toContain('RequestTimeout');
  });

  it('allows legitimate fleet jobs to finish before failing lock acquisition', () => {
    expect(read('workflow')).toContain('DEPLOY_MUTEX_WAIT_SECONDS: 3600');
    expect(read('deployWorkflow')).toContain('DEPLOY_MUTEX_WAIT_SECONDS: 3600');
    expect(read('deployMutex')).toContain('TTL_SECONDS=1500');
  });

  it('uses only a reviewed /32 resolver for bootstrap DNS', () => {
    const template = read('template');
    const workflow = read('workflow');
    const script = read('workflowScript');
    expect(template).toContain('ResolverIp:');
    expect(template).toContain('CidrIp: !Sub \'${ResolverIp}/32\'');
    expect(template).toContain('IpProtocol: udp');
    expect(template).toContain('IpProtocol: tcp');
    expect(workflow).toContain('T01_RESOLVER_IP');
    expect(script).toContain('"ResolverIp=$RESOLVER_IP"');
  });

  it('documents live-only operation and validates all CloudFormation templates', () => {
    const runbook = read('runbook');
    for (const topic of [
      'fleet deploy mutex', 'Evidence review', 'Credential revocation',
      'Termination', 'seven days', 'No paid run', 'T01_HEALTH_ATTESTATION',
    ]) {
      expect(runbook).toContain(topic);
    }
    expect(runbook).toContain('max_paid_admissions=0');
    expect(read('infraReadme')).toContain('t01-smoke/RUNBOOK.md');
    const validation = 'cfn-lint infra/template.yaml infra/t01-smoke/template.yaml';
    expect(read('deployWorkflow')).toContain(validation);
    expect(read('prePush')).toContain(validation);
  });
});
