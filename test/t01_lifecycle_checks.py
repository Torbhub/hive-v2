from concurrent.futures import ThreadPoolExecutor
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
PROVISION = ROOT / 'infra/t01-smoke/provision.sh'
BROKER_TEMPLATE = ROOT / 'infra/t01-smoke/broker_template.yaml'
SMOKE_TEMPLATE = ROOT / 'infra/t01-smoke/template.yaml'
COMMIT = 'f0d94882e89ab8d4098b5bb2f166adfb9ee0a0ab'
MANDATORY_PASSED = [
    'uv_install', 'python_install', 'frozen_hash_lock_install',
    'lazy_install_disabled', 'service_filesystem_access',
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
    for template in (PROVISION, BROKER_TEMPLATE, SMOKE_TEMPLATE):
        if template.exists():
            shutil.copy(template, root / 'infra/t01-smoke' / template.name)
    (root / 'bin').mkdir()
    write_executable(root / 'infra/deploy-mutex.sh', '''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS"
case "$1" in
  renew)
    if [ -f "$MOCK_RELEASED" ]; then
      printf 'renewal after release\n' >> "$MOCK_RENEW_AFTER_RELEASE"
      exit 99
    fi
    exit "${MOCK_RENEW_RC:-0}"
    ;;
  release)
    : > "$MOCK_RELEASED"
    /bin/sleep 0.05
    exit "${MOCK_RELEASE_RC:-0}"
    ;;
esac
exit 0
''')
    return temporary, root


def run(root, command, extra_env=None):
    env = {
        'PATH': f'{root}/bin:{os.environ["PATH"]}',
        'MOCK_CALLS': str(root / 'calls'),
        'MOCK_RELEASED': str(root / 'released'),
        'MOCK_RENEW_AFTER_RELEASE': str(root / 'renew-after-release'),
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


def mock_long_collect(root, valid_evidence):
    mock_aws(root, '''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS"
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
    write_executable(root / 'bin/sleep', '''#!/usr/bin/env bash
now="$(cat "$MOCK_NOW")"
printf '%s\n' "$((now + 600))" > "$MOCK_NOW"
/bin/sleep 0.01
''')
    (root / 'now').write_text('0')
    (root / 'valid.jsonl').write_text(valid_evidence)


def cleanup_case(
    describe_rc, describe_error, expected_rc, delete_rc=0, wait_rc=0,
    release_rc=0, release_expected=False, secret_describe_rc=0,
    secret_delete_rc=0, secret_confirm_rc=254, secret_confirm_failures=0,
):
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
  'secretsmanager describe-secret')
    describe_count=$(grep -c '^secretsmanager describe-secret' "$MOCK_CALLS" || true)
    if [ "$describe_count" -gt 1 ] && [ "$describe_count" -le $(({secret_confirm_failures} + 1)) ]; then
      rc=0
    elif [ "$describe_count" -gt 1 ]; then
      rc={secret_confirm_rc}
    else
      rc={secret_describe_rc}
    fi
    if [ "$rc" -eq 254 ]; then
      printf 'ResourceNotFoundException: secret not found\n' >&2
    elif [ "$rc" -ne 0 ]; then
      printf 'AccessDenied: not authorized\n' >&2
    fi
    exit "$rc"
    ;;
  'secretsmanager delete-secret') exit {secret_delete_rc} ;;
esac
exit 99
''')
        result = run(root, 'cleanup', {'MOCK_RELEASE_RC': str(release_rc)})
        subprocess.run(['/bin/sleep', '0.05'], check=True)
        assert result.returncode == expected_rc, (result.returncode, result.stdout, result.stderr)
        calls = (root / 'calls').read_text()
        assert not (root / 'renew-after-release').exists(), calls
        if release_expected:
            assert 'release aws-acts hive-v2-t01-smoke/123' in calls, calls
        else:
            assert 'release aws-acts' not in calls, calls
        return calls


missing = 'ValidationError: Stack with id hive-v2-t01-smoke does not exist'
cleanup_cases = [
    ((254, missing, 0), {'release_expected': True, 'secret_describe_rc': 254}),
    ((0, '', 0), {'release_expected': True}),
    ((254, 'AccessDenied: not authorized', 254), {}),
    ((254, 'ThrottlingException: rate exceeded', 254), {}),
    ((1, 'network unreachable', 1), {}),
    ((0, '', 17), {'delete_rc': 17}),
    ((0, '', 19), {'wait_rc': 19}),
    ((254, missing, 23), {'release_rc': 23, 'release_expected': True}),
    ((254, missing, 12), {'secret_delete_rc': 12}),
    ((254, missing, 13), {'secret_describe_rc': 13}),
    ((254, missing, 14), {'secret_confirm_rc': 14}),
    ((254, missing, 0), {'release_expected': True, 'secret_confirm_failures': 2}),
]
with ThreadPoolExecutor(max_workers=8) as pool:
    calls = list(pool.map(lambda case: cleanup_case(*case[0], **case[1]), cleanup_cases))
assert 'delete-stack' not in calls[0] and 'delete-secret' not in calls[0], calls[0]
assert 'wait stack-delete-complete' in calls[1], calls[1]
assert 'delete-secret --secret-id hive-v2-t01-smoke-health-123 --force-delete-without-recovery' in calls[1], calls[1]
assert 'delete-stack' not in calls[2], calls[2]
assert 'delete-stack' not in calls[3], calls[3]
assert 'delete-stack' not in calls[4], calls[4]
assert 'delete-stack' in calls[5] and 'wait stack-delete-complete' not in calls[5], calls[5]
assert 'wait stack-delete-complete' in calls[6], calls[6]
assert 'delete-secret' in calls[8] and 'release aws-acts' not in calls[8], calls[8]
assert 'delete-secret' not in calls[9] and 'release aws-acts' not in calls[9], calls[9]
assert 'delete-secret' in calls[10] and 'release aws-acts' not in calls[10], calls[10]
assert calls[11].count('secretsmanager describe-secret') == 4, calls[11]


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


def mock_lifecycle(root):
    mock_aws(root, '''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS"
if [ -n "${MOCK_RENEWER_PID_FILE:-}" ]; then
  printf '%s\n' "$MUTEX_RENEWER_PID" > "$MOCK_RENEWER_PID_FILE"
fi
case "$1 $2" in
  'cloudformation describe-stacks')
    case "$4" in
      hive-v2-t01-broker) printf 'https://id.lambda-url.us-east-1.on.aws/\n' ;;
      *) printf 'ValidationError: Stack with id hive-v2-t01-smoke does not exist\n' >&2; exit 254 ;;
    esac
    ;;
  'cloudformation deploy'|'cloudformation delete-stack'|'cloudformation wait') /bin/sleep 0.05; exit 0 ;;
  'secretsmanager describe-secret')
    if [ "${MOCK_SECRET_ERROR:-0}" = 1 ]; then
      printf 'AccessDenied: not authorized\n' >&2
      exit 254
    fi
    if [ "${MOCK_SECRET_PRESENT:-0}" = 1 ]; then
      printf 'arn:aws:secretsmanager:us-east-1:594552273052:secret:hive-v2-t01-smoke-health-123-test\n'
    else
      printf 'ResourceNotFoundException: secret not found\n' >&2
      exit 254
    fi
    ;;
esac
''')
    write_executable(root / 'bin/sleep', '''#!/usr/bin/env bash
if [ "${1:-}" = 600 ]; then
  /bin/sleep 0.01
fi
''')
    (root / 'now').write_text('0')


DEPLOY_ENV = {
    'VPC_ID': 'vpc-test',
    'SUBNET_ID': 'subnet-test',
    'RESOLVER_IP': '10.0.0.2',
    'AMI_ID': 'ami-test',
    'TEAMKIMI_SECRET_KEY': 'apiKey',
    'TEAMKIMI_CONNECTIVITY_PATH': '/health',
    'GITHUB_REPOSITORY': 'Torbhub/hive-v2',
    'GITHUB_SHA': 'a' * 40,
    'SCENARIO': 'preflight',
    'MATRIX': 'none',
    'MAX_INPUT_TOKENS': '0',
    'MAX_OUTPUT_TOKENS': '0',
    'MAX_REASONING_TOKENS': '0',
    'MAX_TOTAL_TOKENS': '0',
    'MAX_API_CALLS': '0',
    'MAX_ESTIMATED_COST_USD': '0',
    'MAX_PAID_ADMISSIONS': '0',
    'LIFETIME_MINUTES': '60',
}
def lifecycle_success_case(command):
    temporary, root = workspace()
    with temporary:
        mock_lifecycle(root)
        environment = {
            **DEPLOY_ENV,
            'MOCK_SECRET_PRESENT': '0' if command == 'cleanup' else '1',
        }
        if command == 'cleanup':
            workflow = root / 'infra/t01-smoke/workflow.sh'
            source = workflow.read_text()
            trap = '''trap 'status=$?; printf "%s\\n" "$status" > "$RENEWAL_STATUS_FILE.tmp"; mv "$RENEWAL_STATUS_FILE.tmp" "$RENEWAL_STATUS_FILE"' EXIT'''
            delayed_trap = '''trap 'status=$?; /bin/sleep 0.05; printf "%s\\n" "$status" > "$RENEWAL_STATUS_FILE.tmp"; mv "$RENEWAL_STATUS_FILE.tmp" "$RENEWAL_STATUS_FILE"' EXIT'''
            assert trap in source
            workflow.write_text(source.replace(trap, delayed_trap))
            environment['MOCK_RENEWER_PID_FILE'] = str(root / 'renewer.pid')
        result = run(root, command, environment)
        assert result.returncode == 0, (command, result.stdout, result.stderr)
        calls = (root / 'calls').read_text()
        renewals = [line for line in calls.splitlines() if line.startswith('renew aws-acts')]
        assert len(renewals) >= 3, (command, calls)
        if command == 'cleanup':
            subprocess.run(['/bin/sleep', '0.1'], check=True)
            assert calls.count('release aws-acts hive-v2-t01-smoke/123') == 1, calls
            assert not (root / 'renew-after-release').exists(), calls
            renewer_pid = int((root / 'renewer.pid').read_text())
            try:
                os.kill(renewer_pid, 0)
            except ProcessLookupError:
                pass
            else:
                raise AssertionError(f'renewer {renewer_pid} survived cleanup')


with ThreadPoolExecutor(max_workers=3) as pool:
    list(pool.map(lifecycle_success_case, ('deploy-broker', 'deploy', 'cleanup')))

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


def renewal_failure_case(command):
    temporary, root = workspace()
    with temporary:
        if command == 'issue-health-credential':
            mock_aws(root, '''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS"
''')
            write_executable(root / 'bin/python3', '''#!/usr/bin/env bash
(
  /bin/sleep 0.1
  aws secretsmanager create-secret --name survived-renewal-failure
) &
wait
''')
            environment = {'T01_HEALTH_ATTESTATION': '{}', 'LIFETIME_MINUTES': '60'}
        elif command == 'collect':
            valid = ''.join(json.dumps(record, separators=(',', ':')) + '\n' for record in evidence_records())
            mock_long_collect(root, valid)
            environment = {
                'LIFETIME_MINUTES': '120',
                'MOCK_NOW': str(root / 'now'),
                'VALID_EVIDENCE': str(root / 'valid.jsonl'),
            }
        else:
            mock_lifecycle(root)
            environment = {
                **DEPLOY_ENV,
                'MOCK_SECRET_PRESENT': '0' if command == 'cleanup' else '1',
            }
        result = run(root, command, {**environment, 'MOCK_RENEW_RC': '23'})
        if command == 'issue-health-credential':
            subprocess.run(['/bin/sleep', '0.25'], check=True)
        assert result.returncode == 23, (command, result.stdout, result.stderr)
        calls = (root / 'calls').read_text()
        assert 'release aws-acts' not in calls, (command, calls)
        assert 'no such job' not in result.stderr.lower(), (command, result.stderr)
        assert not (root / 'renew-after-release').exists(), (command, calls)
        if command == 'issue-health-credential':
            assert 'create-secret' not in calls, calls


with ThreadPoolExecutor(max_workers=8) as pool:
    list(pool.map(renewal_failure_case, ('issue-health-credential', 'deploy-broker', 'deploy', 'collect', 'cleanup')))

temporary, root = workspace()
with temporary:
    mock_lifecycle(root)
    result = run(root, 'deploy-broker', {**DEPLOY_ENV, 'MOCK_SECRET_ERROR': '1'})
    assert result.returncode != 0, (result.stdout, result.stderr)
    assert 'cloudformation deploy' not in (root / 'calls').read_text()
