import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
from unittest.mock import patch

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
