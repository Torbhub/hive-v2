import datetime
import json
import shlex
import subprocess
import time

STATUS_COMMAND = 'teamkimi status --json --color=never'
ATTESTATION_FIELDS = {
    'schemaVersion', 'activeAccounts', 'healthyProbes', 'attestedAt', 'probeFinishedAt',
}


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError('timestamp must be a string')
    parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('timestamp must include a timezone')
    return int(parsed.timestamp())


def attestation(status, now=None):
    observed = int(time.time() if now is None else now)
    if not isinstance(status, dict):
        raise ValueError('TeamKimi status must be an object')
    accounts = status.get('accounts')
    probe = status.get('probe')
    if not isinstance(accounts, list) or not isinstance(probe, dict) or probe.get('enabled') is not True:
        raise ValueError('TeamKimi probe status is unavailable')
    active_names = {
        account.get('name') for account in accounts
        if isinstance(account, dict) and isinstance(account.get('name'), str) and account.get('name')
        and account.get('status') == 'active' and account.get('disabled') is False
    }
    probe_accounts = probe.get('accounts')
    if not active_names or not isinstance(probe_accounts, list):
        raise ValueError('no active TeamKimi account is available')
    healthy = {
        account.get('name') for account in probe_accounts
        if isinstance(account, dict) and isinstance(account.get('name'), str) and account.get('name')
        and account.get('status') == 'ok' and account.get('error') is None
    }
    healthy_names = active_names & healthy
    finished = timestamp(probe.get('lastRunFinishedAt'))
    if not healthy_names or finished > observed + 60 or observed - finished > 600:
        raise ValueError('no recent healthy TeamKimi probe is available')
    return {
        'schemaVersion': 1,
        'activeAccounts': len(active_names),
        'healthyProbes': len(healthy_names),
        'attestedAt': observed,
        'probeFinishedAt': finished,
    }


def validate_attestation(value, now):
    if not isinstance(value, dict) or set(value) != ATTESTATION_FIELDS:
        raise ValueError('invalid attestation fields')
    if value['schemaVersion'] != 1:
        raise ValueError('unsupported attestation schema')
    for field in ATTESTATION_FIELDS - {'schemaVersion'}:
        if type(value[field]) is not int:
            raise ValueError(f'{field} must be an integer')
    if value['activeAccounts'] < 1 or value['healthyProbes'] < 1:
        raise ValueError('attestation has no healthy TeamKimi account')
    if value['healthyProbes'] > value['activeAccounts']:
        raise ValueError('attestation counts are inconsistent')
    if value['attestedAt'] > now + 60 or now - value['attestedAt'] > 600:
        raise ValueError('attestation is stale or in the future')
    if value['probeFinishedAt'] > value['attestedAt'] or value['attestedAt'] - value['probeFinishedAt'] > 600:
        raise ValueError('probe evidence is stale or in the future')


def collect():
    try:
        result = subprocess.run(
            shlex.split(STATUS_COMMAND), capture_output=True, text=True,
            timeout=15, check=True,
        )
        status = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        raise ValueError('TeamKimi status collection failed') from error
    return attestation(status)


def main():
    print(json.dumps(collect(), separators=(',', ':'), sort_keys=True))


if __name__ == '__main__':
    main()
