import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import time

from teamkimi_attestation import validate_attestation

SECRET_PREFIX = 'hive-v2-t01-smoke-health-'


def secret_name(run_id):
    if not re.fullmatch(r'[0-9]+', run_id):
        raise ValueError('run ID must be numeric')
    return SECRET_PREFIX + run_id


def build_secret(attestation, run_id, credential_id, api_key, now, lifetime_minutes):
    secret_name(run_id)
    validate_attestation(attestation, now)
    if type(lifetime_minutes) is not int or not 5 <= lifetime_minutes <= 120:
        raise ValueError('invalid lifetime')
    if not re.fullmatch(r't01h-[A-Za-z0-9-]{8,32}', credential_id):
        raise ValueError('invalid credential ID')
    if not api_key or any(character.isspace() for character in api_key):
        raise ValueError('invalid API key')
    return {
        'apiKey': api_key,
        'credentialId': credential_id,
        'runId': run_id,
        'activeAccounts': attestation['activeAccounts'],
        'healthyProbes': attestation['healthyProbes'],
        'attestedAt': attestation['attestedAt'],
        'probeFinishedAt': attestation['probeFinishedAt'],
        'expiresAt': now + (lifetime_minutes + 15) * 60,
    }


def run_secret_command(arguments, value):
    temporary = tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', delete=False)
    path = Path(temporary.name)
    try:
        with temporary:
            json.dump(value, temporary, separators=(',', ':'), sort_keys=True)
        return subprocess.run(
            [*arguments, '--secret-string', f'file://{path}'],
            capture_output=True, text=True, timeout=30, check=True,
        )
    finally:
        path.unlink(missing_ok=True)


def issue():
    run_id = os.environ['GITHUB_RUN_ID']
    attestation = json.loads(os.environ['T01_HEALTH_ATTESTATION'])
    lifetime = int(os.environ['LIFETIME_MINUTES'])
    now = int(time.time())
    credential_id = 't01h-' + secrets.token_hex(8)
    value = build_secret(
        attestation, run_id, credential_id, secrets.token_urlsafe(32), now, lifetime,
    )
    result = run_secret_command(
        [
            'aws', 'secretsmanager', 'create-secret',
            '--name', secret_name(run_id),
            '--description', 'Expiring no-spend T01 health credential without account access',
        ],
        value,
    )
    created = json.loads(result.stdout)
    metadata = {
        'credentialId': credential_id,
        'secretArn': created['ARN'],
        'versionId': created.get('VersionId'),
        'issuedAt': now,
        'expiresAt': value['expiresAt'],
    }
    output = os.environ.get('GITHUB_OUTPUT')
    if output:
        with open(output, 'a', encoding='utf-8') as destination:
            for key, item in metadata.items():
                destination.write(f'{key}={item}\n')
    print(json.dumps(metadata, separators=(',', ':'), sort_keys=True))


def refresh():
    run_id = os.environ['GITHUB_RUN_ID']
    attestation = json.loads(os.environ['T01_HEALTH_ATTESTATION'])
    now = int(time.time())
    validate_attestation(attestation, now)
    name = secret_name(run_id)
    try:
        result = subprocess.run(
            [
                'aws', 'secretsmanager', 'get-secret-value',
                '--secret-id', name, '--query', 'SecretString', '--output', 'text',
            ],
            capture_output=True, text=True, timeout=30, check=True,
        )
        current = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        raise ValueError('existing health credential could not be read') from None
    if (
        not isinstance(current, dict)
        or current.get('runId') != run_id
        or not isinstance(current.get('apiKey'), str)
        or not current['apiKey']
        or any(character.isspace() for character in current['apiKey'])
        or not isinstance(current.get('credentialId'), str)
        or not re.fullmatch(r't01h-[A-Za-z0-9-]{8,32}', current['credentialId'])
        or type(current.get('expiresAt')) is not int
    ):
        raise ValueError('existing health credential is invalid')
    refreshed = {
        **current,
        'activeAccounts': attestation['activeAccounts'],
        'healthyProbes': attestation['healthyProbes'],
        'attestedAt': attestation['attestedAt'],
        'probeFinishedAt': attestation['probeFinishedAt'],
    }
    run_secret_command(
        ['aws', 'secretsmanager', 'update-secret', '--secret-id', name], refreshed,
    )


if __name__ == '__main__':
    if len(sys.argv) == 1:
        issue()
    elif sys.argv[1:] == ['refresh']:
        refresh()
    else:
        raise SystemExit('usage: health_credential.py [refresh]')
