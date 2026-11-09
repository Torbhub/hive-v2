import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import types
from unittest.mock import patch

from t01_workflow_harness import mock_aws, run, workspace, write_executable

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'infra/t01-smoke'))


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


attestation_module = load_module(
    't01_teamkimi_attestation', ROOT / 'infra/t01-smoke/teamkimi_attestation.py',
)
credential_module = load_module(
    't01_health_credential', ROOT / 'infra/t01-smoke/health_credential.py',
)

NOW = 1_800_000_000


def status_value():
    return {
        'accounts': [
            {'name': 'private-a', 'status': 'active', 'disabled': False},
            {'name': 'private-b', 'status': 'error', 'disabled': False},
        ],
        'probe': {
            'enabled': True,
            'lastRunFinishedAt': '2027-01-15T07:59:00.000Z',
            'accounts': [
                {'name': 'private-a', 'status': 'ok', 'error': None},
                {'name': 'private-b', 'status': 'error', 'error': 'private'},
            ],
        },
    }


value = attestation_module.attestation(status_value(), NOW)
assert value == {
    'schemaVersion': 1,
    'activeAccounts': 1,
    'healthyProbes': 1,
    'attestedAt': NOW,
    'probeFinishedAt': NOW - 60,
}
assert 'private' not in json.dumps(value)
attestation_module.validate_attestation(value, NOW + 60)
for field in value:
    wrong = dict(value)
    wrong.pop(field)
    try:
        attestation_module.validate_attestation(wrong, NOW + 60)
    except ValueError:
        pass
    else:
        raise AssertionError(f'missing {field} was accepted')
for wrong_time in (NOW - 601, NOW + 61):
    wrong = dict(value, attestedAt=wrong_time)
    try:
        attestation_module.validate_attestation(wrong, NOW)
    except ValueError:
        pass
    else:
        raise AssertionError('stale or future attestation was accepted')
try:
    attestation_module.attestation(status_value(), NOW + 601)
except ValueError:
    pass
else:
    raise AssertionError('stale probe was accepted')

secret = credential_module.build_secret(
    value, '123', 't01h-public-test', 'synthetic-only-key', NOW, 60,
)
assert secret['apiKey'] == 'synthetic-only-key'
assert secret['runId'] == '123'
assert secret['credentialId'] == 't01h-public-test'
assert secret['expiresAt'] == NOW + 75 * 60
assert set(secret) == {
    'apiKey', 'credentialId', 'runId', 'activeAccounts', 'healthyProbes',
    'attestedAt', 'probeFinishedAt', 'expiresAt',
}


def fake_create_secret(arguments, **kwargs):
    path = arguments[arguments.index('--secret-string') + 1].removeprefix('file://')
    assert os.stat(path).st_mode & 0o777 == 0o600
    assert json.loads(Path(path).read_text())['apiKey'] == 'synthetic-issue-key'
    assert not any('synthetic-issue-key' in argument for argument in arguments)
    return types.SimpleNamespace(stdout=json.dumps({'ARN': 'arn:test:health-secret', 'VersionId': 'version-test'}))


with tempfile.TemporaryDirectory() as directory:
    output_path = Path(directory) / 'github-output'
    environment = {
        'GITHUB_RUN_ID': '123',
        'GITHUB_OUTPUT': str(output_path),
        'T01_HEALTH_ATTESTATION': json.dumps(value),
        'LIFETIME_MINUTES': '60',
    }
    stdout = io.StringIO()
    with (
        patch.dict(os.environ, environment),
        patch.object(credential_module.secrets, 'token_hex', return_value='0123456789abcdef'),
        patch.object(credential_module.secrets, 'token_urlsafe', return_value='synthetic-issue-key'),
        patch.object(credential_module.time, 'time', return_value=NOW),
        patch.object(credential_module.subprocess, 'run', side_effect=fake_create_secret),
        patch.object(sys, 'stdout', stdout),
    ):
        credential_module.issue()
    assert 'synthetic-issue-key' not in stdout.getvalue()
    assert 'synthetic-issue-key' not in output_path.read_text()
    assert 't01h-0123456789abcdef' in stdout.getvalue()

runtime_module = load_module('t01_runtime_health', ROOT / 'infra/t01-smoke/runtime.py')

assert runtime_module.valid_health(secret, '123', NOW + 1)
assert not runtime_module.valid_health(secret, '999', NOW + 1)
assert not runtime_module.valid_health(secret, '123', secret['expiresAt'])
assert not runtime_module.valid_health(dict(secret, apiKey=''), '123', NOW + 1)
assert not runtime_module.valid_health(dict(secret, healthyProbes=0), '123', NOW + 1)
assert not runtime_module.valid_health(dict(secret, healthyProbes=2), '123', NOW + 1)
assert not runtime_module.valid_health(
    dict(secret, probeFinishedAt=secret['attestedAt'] + 1), '123', NOW + 1,
)

for field in ('attestedAt', 'probeFinishedAt'):
    for offset in (-601, 62):
        wrong = dict(secret, **{field: NOW + offset})
        assert not runtime_module.valid_health(wrong, '123', NOW + 1), (field, offset)

for field in ('runId', 'activeAccounts', 'healthyProbes', 'attestedAt', 'probeFinishedAt', 'expiresAt', 'apiKey'):
    wrong = dict(secret)
    wrong.pop(field)
    assert not runtime_module.valid_health(wrong, '123', NOW + 1), field


fresh = dict(
    value, activeAccounts=3, healthyProbes=2,
    attestedAt=NOW + 60, probeFinishedAt=NOW + 30,
)
updated = []


def fake_refresh_secret(arguments, **kwargs):
    if arguments[2] == 'get-secret-value':
        assert arguments[3:] == [
            '--secret-id', 'hive-v2-t01-smoke-health-123',
            '--query', 'SecretString', '--output', 'text',
        ]
        return types.SimpleNamespace(stdout=json.dumps(secret))
    assert arguments[:3] == ['aws', 'secretsmanager', 'update-secret']
    path = arguments[arguments.index('--secret-string') + 1].removeprefix('file://')
    updated.append(json.loads(Path(path).read_text()))
    assert not any('synthetic-only-key' in argument for argument in arguments)
    return types.SimpleNamespace(stdout='{}')


stdout = io.StringIO()
with (
    patch.dict(os.environ, {
        'GITHUB_RUN_ID': '123', 'T01_HEALTH_ATTESTATION': json.dumps(fresh),
    }),
    patch.object(credential_module.time, 'time', return_value=NOW + 60),
    patch.object(credential_module.secrets, 'token_hex', side_effect=AssertionError('credential rotated')),
    patch.object(credential_module.secrets, 'token_urlsafe', side_effect=AssertionError('key rotated')),
    patch.object(credential_module.subprocess, 'run', side_effect=fake_refresh_secret),
    patch.object(sys, 'stdout', stdout),
):
    credential_module.refresh()
assert updated == [dict(
    secret, activeAccounts=3, healthyProbes=2,
    attestedAt=NOW + 60, probeFinishedAt=NOW + 30,
)]
assert updated[0]['apiKey'] == secret['apiKey']
assert updated[0]['credentialId'] == secret['credentialId']
assert updated[0]['runId'] == secret['runId']
assert updated[0]['expiresAt'] == secret['expiresAt']
assert stdout.getvalue() == ''


ATTESTATION_SSM = ROOT / 'infra/t01-smoke/host-attestation.sh'


def attestation_ssm_workspace(invocation):
    temporary = tempfile.TemporaryDirectory()
    root = Path(temporary.name)
    (root / 'bin').mkdir()
    (root / 'infra/t01-smoke').mkdir(parents=True)
    shutil.copy(ATTESTATION_SSM, root / 'infra/t01-smoke/host-attestation.sh')
    shutil.copy(
        ROOT / 'infra/t01-smoke/teamkimi_attestation.py',
        root / 'infra/t01-smoke/teamkimi_attestation.py',
    )
    (root / 'invocation.json').write_text(json.dumps(invocation))
    mock_aws(root, '''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS"
case "$1 $2" in
  'ssm send-command') printf 'command-123\n' ;;
  'ssm wait') exit 0 ;;
  'ssm get-command-invocation') cat "$MOCK_INVOCATION" ;;
  *) exit 2 ;;
esac
''')
    env = {
        'PATH': f'{root}/bin:{os.environ["PATH"]}',
        'MOCK_CALLS': str(root / 'calls'),
        'MOCK_INVOCATION': str(root / 'invocation.json'),
        'T01_TEAMKIMI_HOST_ID': 'i-abcdef12',
        'GITHUB_OUTPUT': str(root / 'github-output'),
    }
    return temporary, root, env


def invoke_attestation_ssm(root, env):
    return subprocess.run(
        ['bash', 'infra/t01-smoke/host-attestation.sh'], cwd=root, env=env,
        capture_output=True, text=True, timeout=10,
    )


current = int(time.time())
fresh_host = dict(value, attestedAt=current, probeFinishedAt=current - 60)
temporary, root, env = attestation_ssm_workspace({'Status': 'Success', 'Output': json.dumps(fresh_host)})
with temporary:
    result = invoke_attestation_ssm(root, env)
    assert result.returncode == 0, (result.stdout, result.stderr)
    canonical = json.dumps(fresh_host, separators=(',', ':'), sort_keys=True)
    assert result.stdout == canonical + '\n'
    assert (root / 'github-output').read_text() == f'attestation={canonical}\n'
    calls = (root / 'calls').read_text()
    assert '--instance-ids i-abcdef12' in calls
    expected_command = (
        'runuser -u ubuntu -- env -i HOME=/home/ubuntu '
        'PATH=/opt/node22/bin:/usr/local/bin:/usr/bin:/bin '
        '/usr/bin/python3 /home/ubuntu/hive-v2/infra/t01-smoke/teamkimi_attestation.py'
    )
    assert expected_command in calls
    assert 'HOME=/root' not in calls
    assert 'synthetic-sensitive-value' not in result.stdout + result.stderr + calls

invalid_outputs = [
    'raw-account-secret\n',
    '<html>redirect to synthetic-sensitive-value</html>\n',
    json.dumps(dict(fresh_host, apiKey='synthetic-sensitive-value')),
    'x' * 65537,
]
for output in invalid_outputs:
    temporary, root, env = attestation_ssm_workspace({'Status': 'Success', 'Output': output})
    with temporary:
        result = invoke_attestation_ssm(root, env)
        assert result.returncode != 0
        assert 'synthetic-sensitive-value' not in result.stdout + result.stderr
        assert 'raw-account-secret' not in result.stdout + result.stderr
        assert not (root / 'github-output').exists()

temporary, root, env = attestation_ssm_workspace({
    'Status': 'Failed', 'Output': 'synthetic-sensitive-value',
})
with temporary:
    result = invoke_attestation_ssm(root, env)
    assert result.returncode != 0
    assert 'synthetic-sensitive-value' not in result.stdout + result.stderr
    assert not (root / 'github-output').exists()


workflow_yaml = (ROOT / '.github/workflows/t01-smoke.yml').read_text()
deploy_position = workflow_yaml.index('workflow.sh deploy')
collect_position = workflow_yaml.index('workflow.sh collect', deploy_position)
refresh_segment = workflow_yaml[deploy_position:collect_position]
ssm_position = refresh_segment.index('workflow.sh refresh-host-attestation')
secret_position = refresh_segment.index('workflow.sh refresh-health-credential')
assert refresh_segment.index('HIVE_DEPLOY_ROLE_ARN') < ssm_position < secret_position
assert refresh_segment.index('HIVE_T01_SMOKE_ROLE_ARN', ssm_position) < secret_position
assert 'run: bash infra/t01-smoke/host-attestation.sh' not in refresh_segment
assert 'if: inputs.scenario' not in refresh_segment
assert refresh_segment.split('role-duration-seconds: ', 1)[1].splitlines()[0] == '3600'
assert refresh_segment.split('role-duration-seconds: 9000', 1)[1]
workflow_shell = (ROOT / 'infra/t01-smoke/workflow.sh').read_text()
assert 'refresh-host-attestation) with_mutex_renewal refresh_host_attestation ;;' in workflow_shell
assert 'refresh-health-credential) with_mutex_renewal refresh_health_credential ;;' in workflow_shell


temporary, root = workspace()
with temporary:
    for source in ('health_credential.py', 'teamkimi_attestation.py'):
        shutil.copy(ROOT / 'infra/t01-smoke' / source, root / 'infra/t01-smoke' / source)
    existing_path = root / 'existing.json'
    existing_path.write_text(json.dumps(secret))
    updated_path = root / 'updated.json'
    mock_aws(root, '''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS"
case "$1 $2" in
  'secretsmanager get-secret-value') cat "$MOCK_EXISTING" ;;
  'secretsmanager update-secret')
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --secret-string ]; then
        cp "${2#file://}" "$MOCK_UPDATED"
        exit 0
      fi
      shift
    done
    exit 2
    ;;
  *) exit 2 ;;
esac
''')
    write_executable(root / 'bin/sleep', '#!/usr/bin/env bash\nexit 0\n')
    current = int(time.time())
    fresh_workflow = dict(value, attestedAt=current, probeFinishedAt=current - 60)
    result = run(root, 'refresh-health-credential', {
        'T01_HEALTH_ATTESTATION': json.dumps(fresh_workflow),
        'MOCK_EXISTING': str(existing_path), 'MOCK_UPDATED': str(updated_path),
    })
    assert result.returncode == 0, (result.stdout, result.stderr)
    assert json.loads(updated_path.read_text()) == dict(secret, **{
        field: fresh_workflow[field]
        for field in ('activeAccounts', 'healthyProbes', 'attestedAt', 'probeFinishedAt')
    })
    calls = (root / 'calls').read_text()
    assert 'renew aws-acts hive-v2-t01-smoke/123' in calls
    assert 'synthetic-only-key' not in result.stdout + result.stderr + calls
