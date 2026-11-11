import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

from t01_workflow_harness import ROOT, evidence_records, mock_aws, run, workspace, write_executable

PIN = '35b0d0d9b2e124b3418e3c049bd79c2f857b8cfe'
ARCHIVE_SHA256 = 'e5584a3d9e8cc7b4b4196146f39f0964f06adc2fe79b5fbb5b7631a848972b58'
INSTALL = ROOT / 'infra/t01-smoke/teamkimi-count-install.sh'
HOST = ROOT / 'infra/t01-smoke/teamkimi-count-host.sh'
SSM = ROOT / 'infra/t01-smoke/count-host.sh'
UNIT = ROOT / 'infra/box/teamkimi-count@.service'
PROVISION_BOX = ROOT / 'infra/provision-box.sh'
WORKFLOW_YAML = ROOT / '.github/workflows/t01-smoke.yml'


def read(path):
    return path.read_text() if path.exists() else ''


def check_install_contract():
    installer = read(INSTALL)
    host = read(HOST)
    unit = read(UNIT)
    provision = read(PROVISION_BOX)
    assert PIN in installer and ARCHIVE_SHA256 in installer
    assert PIN in host and ARCHIVE_SHA256 in host
    assert 'repos/Torbhub/teamkimi/tarball' in installer
    assert 'provenance.json' in installer
    assert 'systemctl start' not in installer and 'systemctl restart' not in installer
    assert 'systemctl enable' not in installer and 'teamkimi-tmux' not in installer
    assert 'teamkimi-count-install.sh' in provision
    assert 'teamkimi-count-host.sh' in provision
    assert 'teamkimi-count@.service' in provision
    for required in (
        'User=ubuntu', 'Group=ubuntu', 'Restart=no', 'RuntimeMaxSec=10800',
        'ProtectSystem=strict', 'ProtectHome=read-only', 'StateDirectoryMode=0700',
        'ReadOnlyPaths=/home/ubuntu', 'ReadWritePaths=/var/lib/teamkimi-count/%i',
        f'/opt/teamkimi-count/{PIN}/src/index.js smoke-count',
        '--state-path /var/lib/teamkimi-count/%i/ledger.json',
    ):
        assert required in unit, required
    assert '[Install]' not in unit
    for forbidden in ('TEAMKIMI_PROXY_KEY', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'):
        assert forbidden not in unit
    workflow = read(WORKFLOW_YAML)
    assert workflow.count('workflow.sh acquire') == 1
    deploy_blocks = workflow.split('role-to-assume: ${{ secrets.HIVE_DEPLOY_ROLE_ARN }}')[1:]
    assert len(deploy_blocks) == 3
    for block in deploy_blocks:
        assert block.split('role-duration-seconds: ', 1)[1].splitlines()[0] == '3600'
    start = workflow.index('workflow.sh count-start')
    stop = workflow.index('workflow.sh count-stop')
    assert workflow.index('workflow.sh acquire') < start < stop
    assert workflow.index('HIVE_DEPLOY_ROLE_ARN') < start
    assert workflow.index('HIVE_T01_SMOKE_ROLE_ARN', start) < stop
    assert workflow.index('HIVE_DEPLOY_ROLE_ARN', start) < stop
    assert workflow.index('HIVE_T01_SMOKE_ROLE_ARN', stop) > stop
    assert 'vars.KIMI_BOX_ID' in workflow
    assert 't01-evidence/count-host.jsonl' in workflow
    trust = read(ROOT / 'infra/template.yaml')
    smoke_role = trust.split('  T01SmokeRole:', 1)[1].split('\nOutputs:', 1)[0]
    assert 'ssm:SendCommand' not in smoke_role
    smoke_provision = read(ROOT / 'infra/t01-smoke/provision.sh')
    generation_check = 'expect_broker_rejected teamkimi_generation_rejected 403'
    messages_check = 'expect_broker_rejected teamkimi_messages_rejected 401'
    generation_position = smoke_provision.index(generation_check)
    messages_position = smoke_provision.index(messages_check)
    count_guard = smoke_provision.rfind('if [ "$SCENARIO" = count ]; then', 0, generation_position)
    assert messages_position < count_guard < generation_position
    assert 'runuser -u t01broker' in smoke_provision
    assert 'http://127.0.0.1:8765/v1/messages' in smoke_provision


def check_installer_idempotence():
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        fixture = root / 'fixture'
        (fixture / 'src').mkdir(parents=True)
        (fixture / 'src/index.js').write_text('synthetic-count-cli\n')
        archive = root / 'source.tar.gz'
        with tarfile.open(archive, 'w:gz') as output:
            output.add(fixture, arcname='teamkimi-35b0d0d9b2e124b3418e3c049bd79c2f857b8cfe')
        archive_sha = hashlib.sha256(archive.read_bytes()).hexdigest()
        source = read(INSTALL).replace('/opt/teamkimi-count', str(root / 'opt/teamkimi-count'))
        source = source.replace(ARCHIVE_SHA256, archive_sha)
        source = source.replace('.st_uid != 0', f'.st_uid != {os.getuid()}')
        source = source.replace('.st_gid != 0', f'.st_gid != {os.getgid()}')
        source = source.replace('-o root -g root ', '')
        script = root / 'install.sh'
        script.write_text(source)
        (root / 'opt').mkdir()
        (root / 'bin').mkdir()
        write_executable(root / 'bin/id', '#!/usr/bin/env bash\nprintf "0\\n"\n')
        write_executable(root / 'bin/chown', '#!/usr/bin/env bash\nexit 0\n')
        write_executable(root / 'bin/runuser', '''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS"
cat "$MOCK_ARCHIVE"
''')
        env = {
            'PATH': f'{root}/bin:{os.environ["PATH"]}',
            'MOCK_ARCHIVE': str(archive),
            'MOCK_CALLS': str(root / 'calls'),
        }
        first = subprocess.run(['bash', str(script)], env=env, capture_output=True, text=True, timeout=10)
        assert first.returncode == 0, (first.stdout, first.stderr)
        installed = root / f'opt/teamkimi-count/{PIN}'
        stamp = json.loads((installed / 'provenance.json').read_text())
        assert stamp['commit'] == PIN and stamp['archiveSha256'] == archive_sha
        assert all(not path.stat().st_mode & 0o222 for path in installed.rglob('*'))
        second = subprocess.run(['bash', str(script)], env=env, capture_output=True, text=True, timeout=10)
        assert second.returncode == 0, (second.stdout, second.stderr)
        assert 'kept:' in second.stdout
        assert (root / 'calls').read_text().count('tarball') == 1


def ready_status():
    return {
        'enabled': True,
        'countOnly': True,
        'pricingVerified': False,
        'admissionAllowed': False,
        'blockedReason': None,
        'credentials': [],
        'reservations': [],
        'totals': {'admissions': 0},
    }


def host_workspace():
    temporary = tempfile.TemporaryDirectory()
    root = Path(temporary.name)
    source = read(HOST)
    for prefix in ('/opt/teamkimi-count', '/var/lib/teamkimi-count', '/etc/systemd/system'):
        source = source.replace(prefix, str(root / prefix.lstrip('/')))
    source = source.replace('SOURCE_OWNER=0', f'SOURCE_OWNER={os.getuid()}')
    source = source.replace('SOURCE_GROUP=0', f'SOURCE_GROUP={os.getgid()}')
    current_user = subprocess.check_output(['id', '-un'], text=True).strip()
    source = source.replace('= ubuntu ] || fail count_state', f'= {current_user} ] || fail count_state')
    source = source.replace('install -d -m 0700 -o ubuntu -g ubuntu', 'install -d -m 0700')
    script = root / 'host.sh'
    script.write_text(source)
    script.chmod(0o755)
    source_dir = root / f'opt/teamkimi-count/{PIN}'
    (source_dir / 'src').mkdir(parents=True)
    (source_dir / 'src/index.js').write_text('synthetic-source\n')
    (source_dir / 'provenance.json').write_text(json.dumps({
        'commit': PIN, 'archiveSha256': ARCHIVE_SHA256,
    }))
    for path in (source_dir, source_dir / 'src', source_dir / 'src/index.js', source_dir / 'provenance.json'):
        path.chmod(0o555 if path.is_dir() else 0o444)
    (root / 'etc/systemd/system').mkdir(parents=True)
    shutil.copy(UNIT, root / 'etc/systemd/system/teamkimi-count@.service')
    (root / 'bin').mkdir()
    (root / 'status.json').write_text(json.dumps(ready_status()))
    (root / 'normal-proxy.pid').write_text('3131\n')
    (root / 'normal-active').touch()
    (root / 'listener.pid').write_text('4242\n')
    (root / 'socket-owner.pid').write_text('4242\n')
    env = {
        'PATH': f'{root}/bin:{os.environ["PATH"]}',
        'MOCK_ACTIVE': str(root / 'active'),
        'MOCK_CALLS': str(root / 'calls'),
        'MOCK_STATE': str(root / 'var/lib/teamkimi-count/123'),
        'MOCK_STATUS': str(root / 'status.json'),
        'MOCK_NORMAL_PID': str(root / 'normal-proxy.pid'),
        'MOCK_NORMAL_ACTIVE': str(root / 'normal-active'),
        'MOCK_LISTENER_PID': str(root / 'listener.pid'),
        'MOCK_SOCKET_PID': str(root / 'socket-owner.pid'),
        'MOCK_PORT_OWNER': str(root / 'port-owner'),
    }
    write_executable(root / 'bin/id', '''#!/usr/bin/env bash
if [ "$#" = 1 ] && [ "$1" = -u ]; then
  printf '0\n'
else
  /usr/bin/id "$@"
fi
''')
    write_executable(root / 'bin/systemctl', '''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS"
case "$1 $2" in
  'is-active --quiet')
    if [ "$3" = teamkimi-tmux.service ]; then
      [ -f "$MOCK_NORMAL_ACTIVE" ]
    else
      [ -f "$MOCK_ACTIVE" ]
    fi
    ;;
  'show teamkimi-tmux.service') cat "$MOCK_NORMAL_PID" ;;
  'show teamkimi-count@123.service')
    if [ -f "$MOCK_ACTIVE" ]; then cat "$MOCK_LISTENER_PID"; else printf '0\n'; fi
    ;;
  'start teamkimi-count@123.service')
    : > "$MOCK_ACTIVE"
    printf 'preserve-this-ledger\n' > "$MOCK_STATE/ledger.json"
    ;;
  'stop teamkimi-count@123.service') rm -f "$MOCK_ACTIVE" ;;
  *) exit 2 ;;
esac
''')
    write_executable(root / 'bin/ss', '''#!/usr/bin/env bash
if [ -f "$MOCK_ACTIVE" ]; then
  pid="$(cat "$MOCK_SOCKET_PID")"
elif [ -f "$MOCK_PORT_OWNER" ]; then
  pid="$(cat "$MOCK_PORT_OWNER")"
else
  exit 0
fi
printf 'LISTEN 0 4096 127.0.0.1:8765 0.0.0.0:* users:(("node",pid=%s,fd=20))\n' "$pid"
''')
    write_executable(root / 'bin/curl', '''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS"
out=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then out="$2"; shift 2; else shift; fi
done
cat "$MOCK_STATUS" > "$out"
''')
    write_executable(root / 'bin/sleep', '#!/usr/bin/env bash\nexit 0\n')
    return temporary, root, script, env


def invoke_host(script, env, action, run_id='123'):
    return subprocess.run(
        ['bash', str(script), action, run_id], env=env,
        capture_output=True, text=True, timeout=10,
    )


def check_host_lifecycle():
    temporary, root, script, env = host_workspace()
    with temporary:
        started = invoke_host(script, env, 'start')
        assert started.returncode == 0, (started.stdout, started.stderr)
        assert started.stdout == (
            'T01_COUNT count_source passed\nT01_COUNT count_loopback passed\n'
            'T01_COUNT count_proxy passed\nT01_COUNT count_start passed\n'
        )
        ledger = root / 'var/lib/teamkimi-count/123/ledger.json'
        ledger.write_text('preserve-this-ledger\n')
        stopped = invoke_host(script, env, 'stop')
        assert stopped.returncode == 0, (stopped.stdout, stopped.stderr)
        assert stopped.stdout == (
            'T01_COUNT count_source passed\nT01_COUNT count_stop passed\n'
            'T01_COUNT count_port_closed passed\nT01_COUNT count_proxy passed\n'
        )
        assert ledger.read_text() == 'preserve-this-ledger\n'
        calls = (root / 'calls').read_text()
        assert 'start teamkimi-count@123.service' in calls
        assert 'stop teamkimi-count@123.service' in calls
        assert 'teamkimi-tmux.service start' not in calls and 'teamkimi-tmux.service stop' not in calls

    temporary, root, script, env = host_workspace()
    with temporary:
        (root / 'normal-active').unlink()
        result = invoke_host(script, env, 'start')
        assert result.returncode != 0
        assert 'start teamkimi-count@123.service' not in (root / 'calls').read_text()

    temporary, root, script, env = host_workspace()
    with temporary:
        (root / 'port-owner').write_text('9999\n')
        result = invoke_host(script, env, 'start')
        assert result.returncode != 0
        calls = (root / 'calls').read_text() if (root / 'calls').exists() else ''
        assert 'start teamkimi-count@123.service' not in calls

    temporary, root, script, env = host_workspace()
    with temporary:
        assert invoke_host(script, env, 'start').returncode == 0
        active = ready_status()
        active['credentials'] = [{'id': 'public-id', 'revokedAt': None}]
        (root / 'status.json').write_text(json.dumps(active))
        ledger = root / 'var/lib/teamkimi-count/123/ledger.json'
        before = ledger.read_bytes()
        result = invoke_host(script, env, 'stop')
        assert result.returncode != 0
        assert 'stop teamkimi-count@123.service' not in (root / 'calls').read_text()
        assert ledger.read_bytes() == before

    temporary, root, script, env = host_workspace()
    with temporary:
        assert invoke_host(script, env, 'start').returncode == 0
        (root / 'socket-owner.pid').write_text('9999\n')
        result = invoke_host(script, env, 'stop')
        assert result.returncode != 0
        assert 'stop teamkimi-count@123.service' not in (root / 'calls').read_text()

    temporary, root, script, env = host_workspace()
    with temporary:
        assert invoke_host(script, env, 'start').returncode == 0
        (root / 'normal-proxy.pid').write_text('99\n')
        result = invoke_host(script, env, 'stop')
        assert result.returncode != 0
        assert 'stop teamkimi-count@123.service' not in (root / 'calls').read_text()

    temporary, root, script, env = host_workspace()
    with temporary:
        result = invoke_host(script, env, 'start', 'not-numeric')
        assert result.returncode != 0
        assert not (root / 'calls').exists()


def ssm_workspace(output):
    temporary = tempfile.TemporaryDirectory()
    root = Path(temporary.name)
    (root / 'bin').mkdir()
    (root / 'infra/t01-smoke').mkdir(parents=True)
    shutil.copy(SSM, root / 'infra/t01-smoke/count-host.sh')
    invocation = root / 'invocation.json'
    invocation.write_text(json.dumps({'Status': 'Success', 'Output': output}))
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
        'MOCK_INVOCATION': str(invocation),
        'GITHUB_RUN_ID': '123',
        'T01_TEAMKIMI_HOST_ID': 'i-abcdef12',
        'EVIDENCE_DIR': str(root / 'evidence'),
    }
    return temporary, root, env


def invoke_ssm(root, env, action):
    return subprocess.run(
        ['bash', 'infra/t01-smoke/count-host.sh', action], cwd=root, env=env,
        capture_output=True, text=True, timeout=10,
    )


def check_ssm_sanitization():
    sequences = {
        'start': ['count_source', 'count_loopback', 'count_proxy', 'count_start'],
        'stop': ['count_source', 'count_stop', 'count_port_closed', 'count_proxy'],
    }
    for action, names in sequences.items():
        output = ''.join(f'T01_COUNT {name} passed\n' for name in names)
        temporary, root, env = ssm_workspace(output)
        with temporary:
            result = invoke_ssm(root, env, action)
            assert result.returncode == 0, (result.stdout, result.stderr)
            assert (root / 'evidence/count-host.jsonl').read_text() == output

    invalid_start = [
        'T01_COUNT count_source passed\nT01_COUNT count_start passed\n',
        'T01_COUNT count_source passed\nT01_COUNT count_source passed\n'
        'T01_COUNT count_loopback passed\nT01_COUNT count_proxy passed\nT01_COUNT count_start passed\n',
        'T01_COUNT count_source passed\nT01_COUNT count_proxy passed\n'
        'T01_COUNT count_loopback passed\nT01_COUNT count_start passed\n',
        'T01_COUNT count_source passed\nT01_COUNT count_loopback passed\n'
        'T01_COUNT count_proxy passed\nT01_COUNT count_start passed\nT01_COUNT count_stop passed\n',
        'raw-account-secret\n',
    ]
    for output in invalid_start:
        temporary, root, env = ssm_workspace(output)
        with temporary:
            result = invoke_ssm(root, env, 'start')
            assert result.returncode != 0, output
            assert not (root / 'evidence/count-host.jsonl').exists()
            assert 'raw-account-secret' not in result.stdout + result.stderr


def count_evidence():
    records = evidence_records()
    complete = records.pop()
    for check in (
        'trusted_tunnel_ready', 'teamkimi_control_port', 'teamkimi_control_broker',
        'teamkimi_generation_rejected', 'teamkimi_messages_rejected',
    ):
        records.append({'check': check, 'status': 'passed'})
    records.extend([
        {
            'check': 'count_only_no_generation', 'status': 'passed', 'sha256': 'a' * 64,
            'requestHash': 'b' * 64, 'model': 'kimi-code/k3.1-pro',
            'inputTokens': 10, 'baseInputTokens': 2, 'cacheReadInputTokens': 3,
            'cacheCreationInputTokens': 5, 'cacheCreation5mInputTokens': 1,
            'cacheCreation1hInputTokens': 4, 'generationRequests': 0,
            'timestamp': 1, 'revokedAt': 1, 'proof': 'c' * 64,
        },
        {'check': 'tunnel_cleanup', 'status': 'passed'},
        complete,
    ])
    return ''.join(json.dumps(record, separators=(',', ':')) + '\n' for record in records)


def cleanup_stop_case(stop_verified):
    temporary, root = workspace()
    with temporary:
        artifact = root / 'artifact'
        artifact.mkdir()
        (artifact / 'preflight.jsonl').write_text(count_evidence())
        mock_aws(root, '''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS"
case "$1 $2" in
  'cloudformation describe-stacks')
    printf 'ValidationError: Stack with id hive-v2-t01-smoke does not exist\n' >&2
    exit 254
    ;;
  'secretsmanager describe-secret')
    printf 'ResourceNotFoundException: secret not found\n' >&2
    exit 254
    ;;
esac
''')
        result = run(root, 'cleanup', {
            'SCENARIO': 'count', 'EVIDENCE_DIR': str(artifact),
            'T01_COUNT_STOP_VERIFIED': stop_verified,
        })
        calls = (root / 'calls').read_text()
        assert 'secretsmanager describe-secret' in calls
        if stop_verified == 'yes':
            assert result.returncode == 0, (result.stdout, result.stderr)
            assert 'release aws-acts hive-v2-t01-smoke/123' in calls
        else:
            assert result.returncode != 0
            assert 'release aws-acts' not in calls


def original_count_job():
    return {
        'id': 1,
        'run_id': 42941131826,
        'name': 'preflight',
        'status': 'completed',
        'conclusion': 'failure',
        'steps': [
            {'name': 'Start only the run-scoped count listener', 'status': 'completed', 'conclusion': 'success'},
            {'name': 'Stop only the run-scoped count listener', 'status': 'completed', 'conclusion': 'success'},
            {'name': 'Issue the run-scoped TeamKimi control credential', 'status': 'completed', 'conclusion': 'skipped'},
        ],
    }


def original_count_document(job=None):
    return json.dumps({'total_count': 1, 'jobs': [job or original_count_job()]})


def recovery_case(overrides=None, command='count-recovery'):
    overrides = dict(overrides or {})
    response = overrides.pop('GH_RESPONSE', original_count_document())
    temporary, root = workspace()
    with temporary:
        mock_aws(root, '''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS"
case "$1 $2" in
  'cloudformation describe-stacks')
    printf 'ValidationError: Stack with id hive-v2-t01-smoke does not exist\n' >&2
    exit 254
    ;;
  'secretsmanager describe-secret')
    if grep -q delete-secret "$MOCK_CALLS"; then
      printf 'ResourceNotFoundException: secret not found\n' >&2
      exit 254
    fi
    ;;
  'secretsmanager delete-secret') exit 0 ;;
esac
''')
        (root / 'gh-response.json').write_text(response)
        write_executable(root / 'bin/gh', '''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_GH_CALLS"
if [ "$#" -ne 2 ] || [ "$1" != api ] || [ "$2" != "/repos/$GITHUB_REPOSITORY/actions/runs/$T01_RECOVERY_RUN_ID/jobs?per_page=100" ]; then
  exit 90
fi
cat "$MOCK_GH_RESPONSE"
exit "${MOCK_GH_RC:-0}"
''')
        env = {
            'SCENARIO': 'count-recovery',
            'T01_RECOVERY_RUN_ID': '42941131826',
            'T01_REVIEWED_UNCERTAIN_CLEANUP': 'yes',
            'T01_COUNT_STOP_VERIFIED': 'yes',
            'GITHUB_REPOSITORY': 'Torbhub/hive-v2',
            'GH_TOKEN': 'synthetic-github-token',
            'MOCK_GH_CALLS': str(root / 'gh-calls'),
            'MOCK_GH_RESPONSE': str(root / 'gh-response.json'),
        }
        env.update(overrides)
        result = run(root, command, env)
        calls = (root / 'calls').read_text() if (root / 'calls').exists() else ''
        gh_calls = (root / 'gh-calls').read_text() if (root / 'gh-calls').exists() else ''
        return result, calls, gh_calls


expected_gh_call = 'api /repos/Torbhub/hive-v2/actions/runs/42941131826/jobs?per_page=100\n'
result, calls, gh_calls = recovery_case()
assert result.returncode == 0, (result.stdout, result.stderr)
assert gh_calls == expected_gh_call, gh_calls
lines = calls.splitlines()
renew = 'renew aws-acts hive-v2-t01-smoke/42941131826'
deletes = [line for line in lines if line.startswith('secretsmanager delete-secret ')]
assert len(deletes) == 1, calls
assert 'secretsmanager delete-secret --secret-id hive-v2-t01-smoke-health-42941131826 ' in deletes[0], calls
assert lines[0] == renew, calls
assert 'release aws-acts hive-v2-t01-smoke/42941131826' in lines, calls
assert 'acquire aws-acts' not in calls
assert 'hive-v2-t01-smoke/123' not in calls
assert 'hive-v2-t01-smoke-health-123' not in calls

result, calls, gh_calls = recovery_case({'MOCK_RENEW_RC': '17'})
assert result.returncode != 0
assert calls == renew + '\n', calls
assert gh_calls == expected_gh_call, gh_calls

result, calls, gh_calls = recovery_case(command='validate-recovery')
assert result.returncode == 0, (result.stdout, result.stderr)
assert calls == '', calls
assert gh_calls == expected_gh_call, gh_calls

skipped_recovery_job = {'name': 'count-recovery', 'status': 'completed', 'conclusion': 'skipped'}
skipped_companion_document = json.dumps({
    'total_count': 2,
    'jobs': [original_count_job(), skipped_recovery_job],
})
result, calls, gh_calls = recovery_case({'GH_RESPONSE': skipped_companion_document}, 'validate-recovery')
assert result.returncode == 0, (result.stdout, result.stderr)
assert calls == '', calls
assert gh_calls == expected_gh_call, gh_calls

matrix_job = original_count_job()
matrix_job['steps'][2]['conclusion'] = 'success'
preflight_job = original_count_job()
preflight_job['steps'][0]['conclusion'] = 'skipped'
successful_job = original_count_job()
successful_job['conclusion'] = 'success'
missing_step_job = original_count_job()
missing_step_job['steps'].pop(1)
duplicate_step_job = original_count_job()
duplicate_step_job['steps'].append(duplicate_step_job['steps'][1])
wrong_status_job = original_count_job()
wrong_status_job['steps'][1]['status'] = 'in_progress'
wrong_status_job['steps'][1]['conclusion'] = None
failed_stop_job = original_count_job()
failed_stop_job['steps'][1]['conclusion'] = 'failure'

for command in ('validate-recovery', 'count-recovery'):
    for overrides in (
        {'SCENARIO': 'count'},
        {'T01_RECOVERY_RUN_ID': ''},
        {'T01_RECOVERY_RUN_ID': 'run-42941131826'},
        {'T01_RECOVERY_RUN_ID': '42941131826/evidence'},
        {'T01_REVIEWED_UNCERTAIN_CLEANUP': 'no'},
        {'T01_COUNT_STOP_VERIFIED': 'no'},
    ):
        result, calls, gh_calls = recovery_case(overrides, command)
        assert result.returncode != 0, (command, overrides)
        assert calls == '', (command, overrides, calls)
        assert gh_calls == '', (command, overrides, gh_calls)
    for overrides in (
        {'GH_RESPONSE': original_count_document(matrix_job)},
        {'GH_RESPONSE': original_count_document(preflight_job)},
        {'GH_RESPONSE': original_count_document(successful_job)},
        {'GH_RESPONSE': original_count_document(missing_step_job)},
        {'GH_RESPONSE': original_count_document(duplicate_step_job)},
        {'GH_RESPONSE': original_count_document(wrong_status_job)},
        {'GH_RESPONSE': original_count_document(failed_stop_job)},
        {'GH_RESPONSE': json.dumps({'total_count': 2, 'jobs': [original_count_job(), original_count_job()]})},
        {'GH_RESPONSE': json.dumps({'total_count': 2, 'jobs': [original_count_job(), {**skipped_recovery_job, 'conclusion': 'failure'}]})},
        {'GH_RESPONSE': json.dumps({'total_count': 2, 'jobs': [original_count_job(), {**skipped_recovery_job, 'name': 'unexpected'}]})},
        {'GH_RESPONSE': '{not-json'},
        {'MOCK_GH_RC': '17'},
    ):
        result, calls, _ = recovery_case(overrides, command)
        assert result.returncode != 0, (command, overrides)
        assert calls == '', (command, overrides, calls)


check_host_lifecycle()
check_install_contract()
check_installer_idempotence()
check_ssm_sanitization()
cleanup_stop_case('no')
cleanup_stop_case('yes')
