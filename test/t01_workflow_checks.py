import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / 'infra/t01-smoke/workflow.sh'
RUNTIME = ROOT / 'infra/t01-smoke/runtime.py'
COMMIT = 'f0d94882e89ab8d4098b5bb2f166adfb9ee0a0ab'
MANDATORY_PASSED = [
    'frozen_hash_lock_install', 'lazy_install_disabled', 'service_filesystem_access',
    'default_deny_lockdown', 'direct_ip', 'unapproved_dns', 'redirect', 'ipv6',
    'alternate_port', 'metadata', 'container_credentials', 'teamkimi_no_model',
    'paid_admission_disabled',
]


def evidence_records():
    records = [
        {'check': 'hermes_version', 'status': 'passed', 'version': '0.22.6', 'commit': COMMIT},
        {'check': 'source_sha256', 'status': 'passed', 'sha256': '551f2c190f21a0df8e0576a20809c63d3077bc56568fe009b98b289fae2efa81'},
    ]
    records.extend({'check': name, 'status': 'passed'} for name in MANDATORY_PASSED)
    records.append({'check': 'complete', 'status': 'passed'})
    return records


def write_executable(path, content):
    path.write_text(content)
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def workspace():
    temporary = tempfile.TemporaryDirectory()
    root = Path(temporary.name)
    (root / 'infra/t01-smoke').mkdir(parents=True)
    shutil.copy(WORKFLOW, root / 'infra/t01-smoke/workflow.sh')
    if RUNTIME.exists():
        shutil.copy(RUNTIME, root / 'infra/t01-smoke/runtime.py')
    (root / 'bin').mkdir()
    write_executable(root / 'infra/deploy-mutex.sh', '''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS"
exit "${MOCK_MUTEX_RC:-0}"
''')
    return temporary, root


def run(root, command, extra_env=None):
    env = {
        'PATH': f'{root}/bin:{os.environ["PATH"]}',
        'MOCK_CALLS': str(root / 'calls'),
        'GITHUB_RUN_ID': '123',
    }
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        ['bash', 'infra/t01-smoke/workflow.sh', command], cwd=root, env=env,
        capture_output=True, text=True, timeout=20,
    )


def mock_aws(root, content):
    write_executable(root / 'bin/aws', content)


def cleanup_case(describe_rc, describe_error, expected_rc, delete_rc=0, wait_rc=0, release_rc=0, release_expected=False):
    temporary, root = workspace()
    with temporary:
        mock_aws(root, f'''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS"
case "$1 $2" in
  'cloudformation describe-stacks')
    printf '%s\n' '{describe_error}' >&2
    exit {describe_rc}
    ;;
  'cloudformation delete-stack') exit {delete_rc} ;;
  'cloudformation wait') exit {wait_rc} ;;
esac
exit 99
''')
        result = run(root, 'cleanup', {'MOCK_MUTEX_RC': str(release_rc)})
        assert result.returncode == expected_rc, (result.returncode, result.stdout, result.stderr)
        calls = (root / 'calls').read_text()
        if release_expected:
            assert 'release aws-acts hive-v2-t01-smoke/123' in calls, calls
        else:
            assert 'release aws-acts' not in calls, calls
        return calls


calls = cleanup_case(254, 'ValidationError: Stack with id hive-v2-t01-smoke does not exist', 0, release_expected=True)
assert 'delete-stack' not in calls, calls
calls = cleanup_case(0, '', 0, release_expected=True)
assert 'wait stack-delete-complete' in calls, calls
calls = cleanup_case(254, 'AccessDenied: not authorized', 254)
assert 'delete-stack' not in calls, calls
calls = cleanup_case(254, 'ThrottlingException: rate exceeded', 254)
assert 'delete-stack' not in calls, calls
calls = cleanup_case(1, 'network unreachable', 1)
assert 'delete-stack' not in calls, calls
calls = cleanup_case(0, '', 17, delete_rc=17)
assert 'delete-stack' in calls and 'wait stack-delete-complete' not in calls, calls
calls = cleanup_case(0, '', 19, wait_rc=19)
assert 'wait stack-delete-complete' in calls, calls
cleanup_case(254, 'ValidationError: Stack with id hive-v2-t01-smoke does not exist', 23, release_rc=23, release_expected=True)


def release_case(error, aws_rc, expected_rc):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        (root / 'bin').mkdir()
        shutil.copy(ROOT / 'infra/deploy-mutex.sh', root / 'deploy-mutex.sh')
        write_executable(root / 'bin/aws', f'''#!/usr/bin/env bash
printf '%s\n' '{error}' >&2
exit {aws_rc}
''')
        result = subprocess.run(
            ['bash', 'deploy-mutex.sh', 'release', 'aws-acts', 'test-owner'],
            cwd=root, env={'PATH': f'{root}/bin:{os.environ["PATH"]}'},
            capture_output=True, text=True,
        )
        assert result.returncode == expected_rc, (error, result.returncode, result.stderr)
        if expected_rc:
            assert error in result.stderr, result.stderr


release_case('ConditionalCheckFailedException: owner mismatch', 1, 0)
release_case('AccessDenied: not authorized', 1, 1)
release_case('ThrottlingException: rate exceeded', 1, 1)
release_case('network unreachable', 1, 1)
release_case('unexpected DynamoDB failure', 1, 1)


def validate_evidence(records, expected_rc):
    temporary, root = workspace()
    with temporary:
        artifact = root / 'evidence.jsonl'
        artifact.write_text(''.join(json.dumps(record, separators=(',', ':')) + '\n' for record in records))
        result = subprocess.run(
            ['python3', 'infra/t01-smoke/runtime.py', 'validate-evidence', str(artifact)],
            cwd=root, capture_output=True, text=True,
        )
        assert result.returncode == expected_rc, (records, result.stdout, result.stderr)


validate_evidence(evidence_records(), 0)
validate_evidence([{'check': 'complete', 'status': 'passed'}], 1)
validate_evidence([record for record in evidence_records() if record['check'] != 'lazy_install_disabled'], 1)
wrong_version = evidence_records()
wrong_version[0]['version'] = '0.0.0'
validate_evidence(wrong_version, 1)
wrong_commit = evidence_records()
wrong_commit[0]['commit'] = '0' * 40
validate_evidence(wrong_commit, 1)
validate_evidence(evidence_records() + [{'check': 'unapproved', 'status': 'passed'}], 1)
failed_check = evidence_records()
failed_check[2]['status'] = 'failed'
validate_evidence(failed_check, 1)
not_last = evidence_records()
not_last.insert(0, not_last.pop())
validate_evidence(not_last, 1)


def mock_long_collect(root, valid_evidence):
    mock_aws(root, '''#!/usr/bin/env bash
case "$1 $2" in
  'cloudformation describe-stacks') printf 'i-test\n' ;;
  'ec2 get-console-output')
    now="$(cat "$MOCK_NOW")"
    if [ "$now" -ge 1560 ]; then
      while IFS= read -r line; do printf 'T01_EVIDENCE %s\n' "$line"; done < "$VALID_EVIDENCE"
    else
      printf 'booting\n'
    fi
    ;;
esac
''')
    write_executable(root / 'bin/date', '''#!/usr/bin/env bash
now="$(cat "$MOCK_NOW")"
printf '%s\n' "$((now + 30))" > "$MOCK_NOW"
printf '%s\n' "$now"
''')
    write_executable(root / 'bin/sleep', '#!/usr/bin/env bash\nexit 0\n')
    (root / 'now').write_text('0')
    (root / 'valid.jsonl').write_text(valid_evidence)


temporary, root = workspace()
with temporary:
    valid = ''.join(json.dumps(record, separators=(',', ':')) + '\n' for record in evidence_records())
    mock_long_collect(root, valid)
    result = run(root, 'collect', {
        'LIFETIME_MINUTES': '120',
        'MOCK_NOW': str(root / 'now'),
        'VALID_EVIDENCE': str(root / 'valid.jsonl'),
    })
    assert result.returncode == 0, (result.stdout, result.stderr)
    calls = (root / 'calls').read_text()
    renewals = [line for line in calls.splitlines() if line.startswith('renew aws-acts')]
    assert len(renewals) >= 3, calls
    assert 'release aws-acts' not in calls, calls
