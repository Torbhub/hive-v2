import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / '.github/workflows/t01-smoke.yml').read_text()
assert re.search(r'matrix:\n\s+description:[^\n]+\n\s+required: true\n\s+type: choice\n\s+options: \[none, full\]', WORKFLOW)
assert re.search(r'paid_admission:[\s\S]*?default: false', WORKFLOW)
assert WORKFLOW.index('validate-inputs') < WORKFLOW.index('configure-aws-credentials')
WORKFLOW_SCRIPT = (ROOT / 'infra/t01-smoke/workflow.sh').read_text()
assert 'cli.js verify' in WORKFLOW_SCRIPT
assert 't01-evidence/export' in WORKFLOW
assert 'PAID_EVIDENCE_VERIFIED' in WORKFLOW_SCRIPT
assert 'T01_REVIEWED_UNCERTAIN_CLEANUP' in WORKFLOW_SCRIPT
CLEANUP_SOURCE = WORKFLOW_SCRIPT.split('cleanup() {', 1)[1].split('\ncase ', 1)[0]
assert 'paid evidence is incomplete or uncertain' in CLEANUP_SOURCE
assert 'stop_mutex_renewal' not in CLEANUP_SOURCE
assert 'deploy-mutex.sh release aws-acts' not in CLEANUP_SOURCE
WORKFLOW_STEPS = yaml.safe_load(WORKFLOW)['jobs']['preflight']['steps']
collect_step = next(step for step in WORKFLOW_STEPS if step.get('id') == 'collect')
assert collect_step['env']['SCENARIO'] == '${{ inputs.scenario }}'
upload_step = next(step for step in WORKFLOW_STEPS if step.get('id') == 'upload')
cleanup_step = next(step for step in WORKFLOW_STEPS if step.get('run') == 'bash infra/t01-smoke/workflow.sh cleanup')
verified = cleanup_step['env']['PAID_EVIDENCE_VERIFIED']
assert "steps.collect.outcome == 'success'" in verified
assert "steps.upload.outcome == 'success'" in verified
final_step = WORKFLOW_STEPS[-1]
assert "steps.collect.outcome == 'failure'" in final_step['if']
assert "steps.upload.outcome == 'failure'" in final_step['if']
proxy_step = next(step for step in WORKFLOW_STEPS if step.get('id') == 'proxy')
assert proxy_step['if'] == "inputs.scenario == 'matrix'"
assert proxy_step['env']['TEAMKIMI_PROXY_KEY'] == '${{ secrets.TEAMKIMI_PROXY_KEY }}'
assert proxy_step['run'] == 'bash infra/t01-smoke/workflow.sh issue-proxy-credential'
deploy_step = next(step for step in WORKFLOW_STEPS if step.get('id') == 'deploy')
assert deploy_step['env']['TEAMKIMI_PROXY_SECRET_ARN'] == '${{ steps.proxy.outputs.arn }}'
health_step = next(step for step in WORKFLOW_STEPS if step.get('id') == 'health')
assert 'TEAMKIMI_PROXY_KEY' not in health_step.get('env', {})
assert WORKFLOW.count('secrets.TEAMKIMI_PROXY_KEY') == 1
RUNBOOK = (ROOT / 'infra/t01-smoke/RUNBOOK.md').read_text()
assert 'T01_REVIEWED_UNCERTAIN_CLEANUP=yes' in RUNBOOK

BASE = {
    'PATH': os.environ['PATH'],
    'SCENARIO': 'preflight',
    'MATRIX': 'none',
    'PAID_ADMISSION': 'false',
    'MAX_INPUT_TOKENS': '16000',
    'MAX_OUTPUT_TOKENS': '2000',
    'MAX_REASONING_TOKENS': '4000',
    'MAX_TOTAL_TOKENS': '22000',
    'MAX_API_CALLS': '1',
    'MAX_ESTIMATED_COST_USD': '0.50',
    'MAX_PAID_ADMISSIONS': '0',
    'LIFETIME_MINUTES': '60',
}
ATTESTATION = {
    'contractVersion': 1,
    'route': 'teamkimi',
    'messagesPath': '/v1/messages',
    'model': 'kimi-code/k3.1-pro',
    'source': 'synthetic-only',
    'effectiveAt': '2026-01-01T00:00:00.000Z',
    'expiresAt': '2030-01-01T00:00:00.000Z',
    'evidenceHash': 'c' * 64,
    'rates': {
        'inputMicrosPerToken': 1,
        'outputMicrosPerToken': 2,
        'reasoningMicrosPerToken': 3,
        'cacheReadMicrosPerToken': 1,
        'cacheCreation5mMicrosPerToken': 2,
        'cacheCreation1hMicrosPerToken': 3,
    },
    'providerSemantics': {
        'maxTokens': 'independent-output-ceiling',
        'thinking': 'independent-reasoning-ceiling',
        'usage': 'messages-total-input-output-reasoning-v1',
    },
}
PAID = {
    **BASE,
    'SCENARIO': 'matrix',
    'MATRIX': 'full',
    'PAID_ADMISSION': 'true',
    'MAX_TOTAL_TOKENS': '132000',
    'MAX_API_CALLS': '12',
    'MAX_ESTIMATED_COST_USD': '5',
    'MAX_PAID_ADMISSIONS': '12',
    'EXPECTED_POLICY_HASH': 'ddb3cae728cb60eb6f02b19403df75d3e9e62e958fba45e84ed15fb7349db2d3',
    'PRICING_ATTESTATION': json.dumps(ATTESTATION),
    'T01_TEAMKIMI_HOST_ID': 'i-0123456789abcdef0',
}


def validate(overrides):
    with tempfile.TemporaryDirectory() as directory:
        forbidden = Path(directory) / 'aws-called'
        bin_dir = Path(directory) / 'bin'
        bin_dir.mkdir()
        aws = bin_dir / 'aws'
        aws.write_text(f'#!/usr/bin/env bash\ntouch {forbidden}\n')
        aws.chmod(0o755)
        result = subprocess.run(
            ['bash', str(ROOT / 'infra/t01-smoke/workflow.sh'), 'validate-inputs'],
            env={**BASE, **overrides, 'PATH': f'{bin_dir}:{os.environ["PATH"]}'},
            capture_output=True, text=True, timeout=5,
        )
        assert not forbidden.exists(), 'validation reached AWS'
        return result.returncode


assert validate({}) == 0
assert validate({**PAID}) == 0
assert validate({**BASE, 'SCENARIO': 'count', 'MAX_TOTAL_TOKENS': '0', 'MAX_API_CALLS': '0', 'MAX_ESTIMATED_COST_USD': '0', 'T01_TEAMKIMI_HOST_ID': 'i-0123456789abcdef0'}) == 0
for override in (
    {'PAID_ADMISSION': 'true'},
    {'SCENARIO': 'matrix'},
    {'MATRIX': 'full'},
    {**PAID, 'MAX_PAID_ADMISSIONS': '11'},
    {**PAID, 'MAX_PAID_ADMISSIONS': '13'},
    {**PAID, 'MAX_TOTAL_TOKENS': '22000'},
    {**PAID, 'MAX_TOTAL_TOKENS': '132001'},
    {**PAID, 'MAX_ESTIMATED_COST_USD': '5.01'},
    {**PAID, 'MAX_API_CALLS': '1'},
    {**PAID, 'EXPECTED_POLICY_HASH': 'b' * 64},
    {**PAID, 'PRICING_ATTESTATION': ''},
):
    assert validate(override) != 0, override

PROVISION = (ROOT / 'infra/t01-smoke/provision.sh').read_text()
PAID_SERVICE = (ROOT / 'infra/t01-smoke/paid.sh').read_text()
assert PROVISION.index('start-session') < PROVISION.index('lock_down\nemit default_deny_lockdown')
assert PAID_SERVICE.index('count-probe.mjs') < PAID_SERVICE.index('cli.js" run')
assert 'issue-generation-credential.mjs' not in PAID_SERVICE
assert PROVISION.index('systemctl start t01-paid.service') < PROVISION.index('emit complete passed')
assert 'aws ssm send-command' not in PROVISION
assert 'SSH_AUTH_SOCK' not in PROVISION
assert 'unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN' in PAID_SERVICE
assert 'unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy SSH_AUTH_SOCK' in PAID_SERVICE
assert 'tsc -p tools/hermes-live/tsconfig.json' in PROVISION
assert 'build:web' not in PROVISION
assert 'npm ci --ignore-scripts' in PROVISION
CONTROL_RULE = 'iptables -A OUTPUT -o lo -p tcp --dport 8765 -m owner --uid-owner 10000 -j REJECT'
assert CONTROL_RULE in PROVISION
assert PROVISION.index(CONTROL_RULE) < PROVISION.index('iptables -A OUTPUT -o lo -j ACCEPT')
LOCK_DOWN = PROVISION.split('lock_down() {', 1)[1].split('\n}', 1)[0]
assert f'if [ "$SCENARIO" != preflight ]; then\n    {CONTROL_RULE}\n  fi' in LOCK_DOWN
TUNNEL_ENDPOINTS = {
    'ssm.us-east-1.amazonaws.com': 'SSM_IP',
    'ssmmessages.us-east-1.amazonaws.com': 'SSMMESSAGES_IP',
}
FINAL_REJECT = 'iptables -A OUTPUT -j REJECT'
INITIAL_TUNNEL = '  start_tunnel\n  wait_for_teamkimi\n  emit trusted_tunnel_ready passed'
TUNNEL_RESOLUTION = PROVISION.split('BOOTSTRAP_STAGE=tunnel-endpoints', 1)[1].split('BOOTSTRAP_STAGE=broker-config', 1)[0]
assert """endpoints = (
    'ssm.us-east-1.amazonaws.com',
    'ssmmessages.us-east-1.amazonaws.com',
)""" in TUNNEL_RESOLUTION
RESOLUTION = 'read -r SSM_IP SSMMESSAGES_IP <<< "$SSM_ENDPOINT_IPS"'
assert RESOLUTION in TUNNEL_RESOLUTION
assert PROVISION.index(RESOLUTION) < PROVISION.index(INITIAL_TUNNEL)
for endpoint, variable in TUNNEL_ENDPOINTS.items():
    host_pin = f'printf \'%s %s\\n\' "${variable}" {endpoint} >> /etc/hosts'
    rule = f'iptables -A OUTPUT -p tcp -d "${variable}" --dport 443 -m owner --uid-owner 10001 -j ACCEPT'
    assert host_pin in PROVISION
    assert PROVISION.index(host_pin) < PROVISION.index(INITIAL_TUNNEL)
    assert LOCK_DOWN.count(rule) == 1
    assert LOCK_DOWN.index('iptables -A OUTPUT -d 169.254.169.254 -j REJECT') < LOCK_DOWN.index(rule)
    assert LOCK_DOWN.index('iptables -A OUTPUT -d 169.254.170.2 -j REJECT') < LOCK_DOWN.index(rule)
    assert LOCK_DOWN.index(rule) < LOCK_DOWN.index(FINAL_REJECT)
assert LOCK_DOWN.count('--uid-owner 10001 -j ACCEPT') == len(TUNNEL_ENDPOINTS)
assert '--uid-owner 10000 -j ACCEPT' not in LOCK_DOWN
assert 'if [ "$SCENARIO" != preflight ] && [ -n "$SSM_IP" ] && [ -n "$SSMMESSAGES_IP" ]; then' in LOCK_DOWN
EVIDENCE_RULE = 'iptables -A OUTPUT -p tcp -d "$EVIDENCE_IP" --dport 443 -m owner --uid-owner 0 -j ACCEPT'
assert LOCK_DOWN.count(EVIDENCE_RULE) == 1
assert LOCK_DOWN.index(EVIDENCE_RULE) < LOCK_DOWN.index(FINAL_REJECT)
assert 'expect_denied teamkimi_control_port' in PROVISION
assert 'expect_broker_allowed teamkimi_control_broker' in PROVISION
assert 'aws s3 cp' in PAID_SERVICE
assert 'write-proxy-environment' in PROVISION
assert PROVISION.index('write-proxy-environment') < PROVISION.index('systemctl start t01-paid.service')
assert 'EnvironmentFile=' not in PROVISION
assert 'runuser -u t01hermes -- test -r /etc/t01/proxy.env' in PROVISION
assert 'Environment=HIVE_T01_PROXY_KEY' not in PROVISION
assert 'export TEAMKIMI_PROXY_KEY' not in PROVISION
assert 'TEAMKIMI_PROXY_KEY=' not in PROVISION
assert re.search(r'if \[ "\$SCENARIO" = matrix \]; then\n  python3 /opt/t01/runtime.py write-proxy-environment\nfi', PROVISION)
assert '  . /etc/t01/proxy.env\n  HIVE_T01_PROXY_KEY="$HIVE_T01_PROXY_KEY" "$NODE" "$RUNNER/cli.js" run \\\n' in PAID_SERVICE

COUNT_EVIDENCE = {
    'schemaVersion': 1,
    'model': 'kimi-code/k3.1-pro',
    'requestHash': 'a' * 64,
    'counts': {
        'inputTokens': 10, 'baseInputTokens': 2, 'cacheReadInputTokens': 3,
        'cacheCreationInputTokens': 5, 'cacheCreation5mInputTokens': 1, 'cacheCreation1hInputTokens': 4,
    },
    'generationRequests': 0,
    'status': 'counted',
    'timestamp': 1760000000000,
    'revocation': {'id': '1123456789abcdef0123456789abcdef', 'revokedAt': 1760000001000, 'proof': 'b' * 64},
}
with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / 'count.json'
    path.write_text(json.dumps(COUNT_EVIDENCE))
    result = subprocess.run(
        ['python3', str(ROOT / 'infra/t01-smoke/runtime.py'), 'count-evidence', str(path)],
        capture_output=True, text=True, timeout=5,
    )
    assert result.returncode == 0, result.stderr
    record = json.loads(result.stdout)
    artifact = Path(directory) / 'preflight.jsonl'
    artifact.write_text(result.stdout)
    assert subprocess.run(
        ['python3', str(ROOT / 'infra/t01-smoke/runtime.py'), 'sanitize-evidence', str(artifact)],
        capture_output=True, timeout=5,
    ).returncode == 0
    assert record['generationRequests'] == 0
    assert record['cacheCreationInputTokens'] == 5
    assert 'credential' not in record
    COUNT_EVIDENCE['counts']['cacheCreation5mInputTokens'] = 2
    path.write_text(json.dumps(COUNT_EVIDENCE))
    assert subprocess.run(
        ['python3', str(ROOT / 'infra/t01-smoke/runtime.py'), 'count-evidence', str(path)],
        capture_output=True, timeout=5,
    ).returncode != 0

with tempfile.TemporaryDirectory() as directory:
    marker = Path(directory) / 'aws-called'
    bin_dir = Path(directory) / 'bin'
    bin_dir.mkdir()
    aws = bin_dir / 'aws'
    aws.write_text(f'#!/usr/bin/env bash\ncase "$1" in cloudformation|secretsmanager|s3) touch {marker} ;; esac\nexit 0\n')
    aws.chmod(0o755)
    result = subprocess.run(
        ['bash', 'infra/t01-smoke/workflow.sh', 'cleanup'], cwd=ROOT,
        env={'PATH': f'{bin_dir}:{os.environ["PATH"]}', 'SCENARIO': 'matrix', 'PAID_EVIDENCE_VERIFIED': 'no'},
        capture_output=True, text=True, timeout=5,
    )
    assert result.returncode != 0
    assert not marker.exists(), 'unverified matrix reached destructive AWS cleanup'
