from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from t01_workflow_harness import ROOT, evidence_records, mock_aws, paid_console_records, run, workspace, write_executable


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
    terminate_rc=0,
):
    temporary, root = workspace()
    with temporary:
        mock_aws(root, f'''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS"
case "$1 $2" in
  'cloudformation describe-stacks')
    if [ {describe_rc} -eq 0 ] && [[ "$*" = *InstanceId* ]]; then
      printf 'i-test\n'
    fi
    printf '%s\n' '{describe_error}' >&2
    exit {describe_rc}
    ;;
  'cloudformation delete-stack') exit {delete_rc} ;;
  'cloudformation wait') exit {wait_rc} ;;
  'ec2 terminate-instances') exit {terminate_rc} ;;
  'ec2 wait') exit 0 ;;
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
  *) exit 99 ;;
esac
exit 0
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
    ((0, '', 17), {'terminate_rc': 17}),
]
with ThreadPoolExecutor(max_workers=8) as pool:
    calls = list(pool.map(lambda case: cleanup_case(*case[0], **case[1]), cleanup_cases))
assert 'delete-stack' not in calls[0] and 'delete-secret' not in calls[0], calls[0]
assert 'wait stack-delete-complete' in calls[1], calls[1]
assert 'ec2 terminate-instances --instance-ids i-test' in calls[1], calls[1]
assert 'ec2 wait instance-terminated --instance-ids i-test' in calls[1], calls[1]
assert 'create-image' not in calls[1] and 'image-available' not in calls[1], calls[1]
assert 'delete-secret --secret-id hive-v2-t01-smoke-health-123 --force-delete-without-recovery' in calls[1], calls[1]
assert 'delete-stack' not in calls[2], calls[2]
assert 'delete-stack' not in calls[3], calls[3]
assert 'delete-stack' not in calls[4], calls[4]
assert 'delete-stack' in calls[5] and 'wait stack-delete-complete' not in calls[5], calls[5]
assert 'delete-secret --secret-id hive-v2-t01-smoke-health-123 --force-delete-without-recovery' in calls[5], calls[5]
assert 'wait stack-delete-complete' in calls[6], calls[6]
assert 'delete-secret' in calls[8] and 'release aws-acts' not in calls[8], calls[8]
assert 'delete-secret' not in calls[9] and 'release aws-acts' not in calls[9], calls[9]
assert 'delete-secret' in calls[10] and 'release aws-acts' not in calls[10], calls[10]
assert calls[11].count('secretsmanager describe-secret') == 4, calls[11]
assert 'delete-stack' in calls[12], calls[12]
assert 'delete-secret --secret-id hive-v2-t01-smoke-health-123 --force-delete-without-recovery' in calls[12], calls[12]


def keep_cleanup_case(
    markers=1, evidence='passed', paid_verified='yes', scenario='preflight',
    image_wait_rc=0, create_rc=0, describe_images_rc=0,
    deregister_rc=0, delete_snapshot_rc=0,
):
    temporary, root = workspace()
    with temporary:
        artifact = root / 'artifact'
        artifact.mkdir()
        if evidence == 'incomplete':
            records = [evidence_records()[1], {'check': 'image_sanitized', 'status': 'passed'}]
        else:
            records = paid_console_records('a' * 64) if scenario == 'matrix' else evidence_records()
            for _ in range(markers):
                records.insert(-1, {'check': 'image_sanitized', 'status': 'passed'})
            if evidence == 'failed':
                records[-1]['status'] = 'failed'
        (artifact / 'preflight.jsonl').write_text(
            ''.join(json.dumps(record, separators=(',', ':')) + '\n' for record in records),
        )
        mock_aws(root, '''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS"
case "$1 $2" in
  'cloudformation describe-stacks') printf 'i-test\n' ;;
  'cloudformation delete-stack'|'cloudformation wait') exit 0 ;;
  'ec2 create-image')
    if [ "${MOCK_CREATE_RC:-0}" -eq 0 ]; then
      printf 'ami-t01\n'
    fi
    exit "${MOCK_CREATE_RC:-0}"
    ;;
  'ec2 terminate-instances') exit 0 ;;
  'ec2 wait')
    if [ "${3:-}" = image-available ]; then
      exit "${MOCK_IMAGE_WAIT_RC:-0}"
    fi
    exit 0
    ;;
  'ec2 describe-images')
    if [[ "$*" = *Name=name,Values=hive-v2-t01-smoke-123* ]]; then
      printf 'ami-uncertain\n'
      exit 0
    fi
    if [ "${MOCK_DESCRIBE_IMAGES_RC:-0}" -ne 0 ]; then
      exit "${MOCK_DESCRIBE_IMAGES_RC}"
    fi
    if [[ "$*" = *ami-uncertain* ]]; then
      printf 'snap-uncertain\n'
    else
      printf 'snap-t01\n'
    fi
    ;;
  'ec2 deregister-image') exit "${MOCK_DEREGISTER_RC:-0}" ;;
  'ec2 delete-snapshot') exit "${MOCK_DELETE_SNAPSHOT_RC:-0}" ;;
  's3 rm') exit 0 ;;
  'secretsmanager describe-secret')
    if grep -q "delete-secret --secret-id $4 " "$MOCK_CALLS"; then
      printf 'ResourceNotFoundException: secret not found\n' >&2
      exit 254
    fi
    exit 0
    ;;
  'secretsmanager delete-secret') exit 0 ;;
  *) exit 99 ;;
esac
exit 0
''')
        result = run(root, 'cleanup', {
            'IMAGE_ACTION': 'keep',
            'SCENARIO': scenario,
            'PAID_EVIDENCE_VERIFIED': paid_verified,
            'EVIDENCE_DIR': str(artifact),
            'MOCK_IMAGE_WAIT_RC': str(image_wait_rc),
            'MOCK_CREATE_RC': str(create_rc),
            'MOCK_DESCRIBE_IMAGES_RC': str(describe_images_rc),
            'MOCK_DEREGISTER_RC': str(deregister_rc),
            'MOCK_DELETE_SNAPSHOT_RC': str(delete_snapshot_rc),
        })
        return result, (root / 'calls').read_text().splitlines()


def call_index(calls, operation):
    return next(index for index, line in enumerate(calls) if operation in line)


def assert_disposable_cleanup(calls, proxy=False):
    assert 'ec2 terminate-instances --instance-ids i-test' in calls, calls
    assert 'cloudformation delete-stack --stack-name hive-v2-t01-smoke' in calls, calls
    assert any('delete-secret --secret-id hive-v2-t01-smoke-health-123 --force-delete-without-recovery' in line for line in calls), calls
    if proxy:
        assert any('delete-secret --secret-id hive-v2-t01-smoke-proxy-123 --force-delete-without-recovery' in line for line in calls), calls
    assert not any('release aws-acts' in line for line in calls), calls


result, calls = keep_cleanup_case()
assert result.returncode == 0, (result.stdout, result.stderr)
create_calls = [line for line in calls if line.startswith('ec2 create-image ')]
assert len(create_calls) == 1, calls
create_call = create_calls[0]
assert '--instance-id i-test' in create_call, create_call
assert '--name hive-v2-t01-smoke-123' in create_call, create_call
assert '--no-reboot' in create_call and '--public' not in create_call, create_call
assert '--tag-specifications' in create_call, create_call
assert 'Key=Role,Value=hive-v2-t01-smoke' in create_call, create_call
assert 'Key=RunId,Value=123' in create_call, create_call
assert call_index(calls, 'ec2 create-image') < call_index(calls, 'ec2 terminate-instances'), calls
assert call_index(calls, 'ec2 terminate-instances') < call_index(calls, 'ec2 wait instance-terminated'), calls
assert call_index(calls, 'ec2 wait instance-terminated') < call_index(calls, 'ec2 wait image-available'), calls
assert call_index(calls, 'ec2 wait image-available') < call_index(calls, 'cloudformation delete-stack'), calls
assert not any('deregister-image' in line for line in calls), calls
assert not any('delete-snapshot' in line for line in calls), calls
assert 'release aws-acts hive-v2-t01-smoke/123' in calls, calls

for overrides in (
    {'markers': 0}, {'markers': 2}, {'evidence': 'incomplete'},
    {'evidence': 'failed'}, {'paid_verified': 'no'},
):
    result, calls = keep_cleanup_case(**overrides)
    assert result.returncode != 0, (overrides, result.stdout, result.stderr)
    assert not any('create-image' in line for line in calls), (overrides, calls)
    assert_disposable_cleanup(calls)

result, calls = keep_cleanup_case(scenario='matrix', paid_verified='no')
assert result.returncode != 0, (result.stdout, result.stderr)
assert_disposable_cleanup(calls, proxy=True)
if any(line.startswith('ec2 create-image ') for line in calls):
    assert 'ec2 deregister-image --image-id ami-t01' in calls, calls
    assert 'ec2 delete-snapshot --snapshot-id snap-t01' in calls, calls

result, calls = keep_cleanup_case(image_wait_rc=19)
assert result.returncode == 19, (result.stdout, result.stderr)
assert_disposable_cleanup(calls)
assert 'ec2 deregister-image --image-id ami-t01' in calls, calls
assert 'ec2 describe-images --image-ids ami-t01 --query Images[0].BlockDeviceMappings[].Ebs.SnapshotId --output text' in calls, calls
snapshot_deletes = [line for line in calls if line.startswith('ec2 delete-snapshot ')]
assert snapshot_deletes == ['ec2 delete-snapshot --snapshot-id snap-t01'], calls

result, calls = keep_cleanup_case(image_wait_rc=19, describe_images_rc=23)
assert result.returncode != 0, (result.stdout, result.stderr)
assert_disposable_cleanup(calls)
assert not any('deregister-image' in line or 'delete-snapshot' in line for line in calls), calls

result, calls = keep_cleanup_case(image_wait_rc=19, deregister_rc=17)
assert result.returncode != 0, (result.stdout, result.stderr)
assert_disposable_cleanup(calls)
assert 'ec2 deregister-image --image-id ami-t01' in calls, calls
assert not any('delete-snapshot' in line for line in calls), calls

result, calls = keep_cleanup_case(image_wait_rc=19, delete_snapshot_rc=23)
assert result.returncode != 0, (result.stdout, result.stderr)
assert_disposable_cleanup(calls)
assert 'ec2 delete-snapshot --snapshot-id snap-t01' in calls, calls

result, calls = keep_cleanup_case(create_rc=17)
assert result.returncode != 0, (result.stdout, result.stderr)
assert_disposable_cleanup(calls)
discovery = next(line for line in calls if line.startswith('ec2 describe-images ') and 'Name=name,Values=' in line)
assert 'Name=name,Values=hive-v2-t01-smoke-123' in discovery, discovery
assert call_index(calls, 'ec2 terminate-instances') < call_index(calls, 'ec2 deregister-image'), calls
assert 'ec2 deregister-image --image-id ami-uncertain' in calls, calls
snapshot_deletes = [line for line in calls if line.startswith('ec2 delete-snapshot ')]
assert snapshot_deletes == ['ec2 delete-snapshot --snapshot-id snap-uncertain'], calls
destructive_image_calls = [line for line in calls if 'deregister-image' in line or 'delete-snapshot' in line]
assert not any('ami-*' in line or 'snap-*' in line for line in destructive_image_calls), calls


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
  'cloudformation describe-stacks') printf 'i-test\n' ;;
  'cloudformation deploy'|'cloudformation delete-stack'|'cloudformation wait') /bin/sleep 0.05; exit 0 ;;
  'ec2 terminate-instances'|'ec2 wait') exit 0 ;;
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
  *) exit 99 ;;
esac
exit 0
''')
    write_executable(root / 'bin/curl', '''#!/usr/bin/env bash
printf 'synthetic-runner-archive'
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
    'GITHUB_REPOSITORY': 'Torbhub/hive-v2',
    'GITHUB_SHA': 'a' * 40,
    'SCENARIO': 'preflight',
    'MATRIX': 'none',
    'PAID_ADMISSION': 'false',
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
            environment['MOCK_RENEWER_PID_FILE'] = str(root / 'renewer.pid')
        result = run(root, command, environment)
        assert result.returncode == 0, (command, result.stdout, result.stderr)
        calls = (root / 'calls').read_text()
        renewals = [line for line in calls.splitlines() if line.startswith('renew aws-acts')]
        expected_renewals = 1 if command == 'cleanup' else 3
        assert len(renewals) >= expected_renewals, (command, calls)
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
    list(pool.map(lifecycle_success_case, ('deploy', 'cleanup')))

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


def assert_inner_cleanup_ownership(root):
    source = (root / 'infra/t01-smoke/workflow.sh').read_text()
    cleanup_source = source.split('cleanup() {', 1)[1].split('\ncase ', 1)[0]
    assert 'stop_mutex_renewal' not in cleanup_source
    assert 'deploy-mutex.sh release' not in cleanup_source


def mock_renewer_wait(root, rc, forever):
    workflow = root / 'infra/t01-smoke/workflow.sh'
    workflow.write_text(f'''jobs() {{ :; }}
wait() {{
  if [ "$1" = "$MUTEX_RENEWER_PID" ]; then
    return {rc}
  fi
  builtin wait "$@"
}}
''' + workflow.read_text())
    if forever:
        mutex = root / 'infra/deploy-mutex.sh'
        source = mutex.read_text()
        source = source.replace(
            'exit "${MOCK_RENEW_RC:-0}"',
            'if [ "${MOCK_RENEW_FOREVER:-0}" = 1 ]; then\n'
            '  while true; do /bin/sleep 600; done\n'
            'fi\n'
            'exit "${MOCK_RENEW_RC:-0}"',
        )
        mutex.write_text(source)


def genuine_renewer_status_after_command_case(rc):
    temporary, root = workspace()
    with temporary:
        mock_lifecycle(root)
        mock_renewer_wait(root, rc, True)
        result = run(root, 'cleanup', {
            **DEPLOY_ENV,
            'MOCK_SECRET_PRESENT': '0',
            'MOCK_RENEW_FOREVER': '1',
        })
        assert result.returncode == rc, (result.stdout, result.stderr)
        assert 'release aws-acts' not in (root / 'calls').read_text()


def already_reaped_renewal_success_case():
    temporary, root = workspace()
    with temporary:
        mock_lifecycle(root)
        result = run(root, 'cleanup', {**DEPLOY_ENV, 'MOCK_SECRET_PRESENT': '0'})
        assert result.returncode == 0, (result.returncode, result.stdout, result.stderr)
        assert (root / 'calls').read_text().count('release aws-acts hive-v2-t01-smoke/123') == 1


genuine_renewer_status_after_command_case(23)
genuine_renewer_status_after_command_case(127)
already_reaped_renewal_success_case()


def renewal_failure_before_inner_cleanup_case():
    temporary, root = workspace()
    with temporary:
        assert_inner_cleanup_ownership(root)
        mock_lifecycle(root)
        result = run(root, 'cleanup', {**DEPLOY_ENV, 'MOCK_SECRET_PRESENT': '0', 'MOCK_RENEW_RC': '23'})
        assert result.returncode == 23, (result.stdout, result.stderr)
        calls = (root / 'calls').read_text()
        assert 'release aws-acts' not in calls, calls


def inner_subshell_cannot_reap_outer_case():
    temporary, root = workspace()
    with temporary:
        assert_inner_cleanup_ownership(root)
        mock_lifecycle(root)
        result = run(root, 'cleanup', {
            **DEPLOY_ENV,
            'MOCK_SECRET_PRESENT': '0',
            'MOCK_RENEWER_PID_FILE': str(root / 'renewer.pid'),
        })
        assert result.returncode == 0, (result.stdout, result.stderr)
        calls = (root / 'calls').read_text()
        assert calls.count('release aws-acts hive-v2-t01-smoke/123') == 1, calls
        renewer_pid = int((root / 'renewer.pid').read_text())
        try:
            os.kill(renewer_pid, 0)
        except ProcessLookupError:
            pass
        else:
            raise AssertionError(f'renewer {renewer_pid} survived release')


renewal_failure_before_inner_cleanup_case()
inner_subshell_cannot_reap_outer_case()


with ThreadPoolExecutor(max_workers=8) as pool:
    list(pool.map(renewal_failure_case, ('issue-health-credential', 'deploy', 'collect', 'cleanup')))

temporary, root = workspace()
with temporary:
    mock_lifecycle(root)
    result = run(root, 'deploy', {**DEPLOY_ENV, 'MOCK_SECRET_ERROR': '1'})
    assert result.returncode != 0, (result.stdout, result.stderr)
    assert 'cloudformation deploy' not in (root / 'calls').read_text()


def missing_renewal_status_case():
    temporary, root = workspace()
    with temporary:
        mock_aws(root, '''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS"
case "$1 $2" in
  'cloudformation describe-stacks') printf 'i-test\n' ;;
  'ec2 get-console-output') printf 'T01_EVIDENCE not-json\n' ;;
esac
''')
        write_executable(root / 'bin/sleep', '''#!/usr/bin/env bash
if [ "${1:-}" = 600 ]; then
  /bin/sleep 0.01
fi
''')
        (root / 'console').write_text('not-json\n')
        (root / 'artifact').mkdir()
        workflow = root / 'infra/t01-smoke/workflow.sh'
        source = workflow.read_text()
        trap = '''trap 'status=$?; printf "%s\\n" "$status" > "$RENEWAL_STATUS_FILE.tmp"; mv "$RENEWAL_STATUS_FILE.tmp" "$RENEWAL_STATUS_FILE"' EXIT'''
        workflow.write_text(source.replace(trap, ''))
        env = {
            'PATH': f'{root}/bin:{os.environ["PATH"]}',
            'MOCK_CALLS': str(root / 'calls'),
            'MOCK_RELEASED': str(root / 'released'),
            'MOCK_RENEW_AFTER_RELEASE': str(root / 'renew-after-release'),
            'MOCK_CONSOLE': str(root / 'console'),
            'GITHUB_RUN_ID': '123',
            'LIFETIME_MINUTES': '5',
            'EVIDENCE_DIR': str(root / 'artifact'),
        }
        process = subprocess.Popen(
            ['bash', 'infra/t01-smoke/workflow.sh', 'collect'], cwd=root, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True,
        )
        try:
            stdout, stderr = process.communicate(timeout=1)
        except subprocess.TimeoutExpired:
            state = subprocess.check_output(
                ['ps', '-o', 'pid=,ppid=,pgid=,sid=,stat=,args=', '--sid', str(process.pid)],
                text=True,
            )
            print(state)
            for line in state.splitlines()[1:]:
                try:
                    os.kill(int(line.split()[0]), 15)
                except ProcessLookupError:
                    pass
            process.wait()
            raise AssertionError('renewal completion depended on the status file')
        assert process.returncode == 1, (stdout, stderr)
        assert 'console produced rejected evidence' in stderr, stderr


missing_renewal_status_case()
