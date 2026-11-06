import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'infra/t01-smoke'))


class CloudFormationLoader(yaml.SafeLoader):
    pass


def construct_tag(loader, tag_suffix, node):
    if isinstance(node, yaml.MappingNode):
        return loader.construct_mapping(node)
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node)
    return loader.construct_scalar(node)


yaml.add_multi_constructor('!', construct_tag, CloudFormationLoader)


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

TEMPLATE = yaml.load(
    (ROOT / 'infra/t01-smoke/broker_template.yaml').read_text(), CloudFormationLoader,
)
code = TEMPLATE['Resources']['HealthFunction']['Properties']['Code']['ZipFile']
secret_value = json.dumps(secret)


class FakeSecrets:
    def get_secret_value(self, SecretId):
        assert SecretId == 'arn:test:health-secret'
        return {'SecretString': secret_value}


fake_boto3 = types.SimpleNamespace(client=lambda name: FakeSecrets())
namespace = {}
with patch.dict(sys.modules, {'boto3': fake_boto3}):
    exec(compile(code, 'broker_template.yaml', 'exec'), namespace)
handler = namespace['handler']


def event(path='/health', method='GET', authorization='Bearer synthetic-only-key'):
    return {
        'rawPath': path,
        'requestContext': {'http': {'method': method}},
        'headers': {'authorization': authorization},
    }


with patch.dict(os.environ, {'SECRET_ARN': 'arn:test:health-secret', 'RUN_ID': '123'}):
    with patch.object(namespace['time'], 'time', return_value=NOW + 1):
        assert handler(event(), None)['statusCode'] == 204
        assert handler(event(authorization='Bearer wrong'), None)['statusCode'] == 401
        assert handler(event(path='/v1/messages', method='POST'), None)['statusCode'] == 404
        assert handler(event(path='/teamkimi/status'), None)['statusCode'] == 404
    with patch.object(namespace['time'], 'time', return_value=secret['expiresAt']):
        assert handler(event(), None)['statusCode'] == 401
    with patch.dict(os.environ, {'RUN_ID': '999'}):
        assert handler(event(), None)['statusCode'] == 503
