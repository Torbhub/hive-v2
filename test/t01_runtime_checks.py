import concurrent.futures
import http.client
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

from t01_workflow_harness import write_executable

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / 'infra/t01-smoke/runtime.py'
COMMIT = 'f0d94882e89ab8d4098b5bb2f166adfb9ee0a0ab'


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def request(port, path='/access-check'):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
    connection.request('GET', path)
    response = connection.getresponse()
    response.read()
    connection.close()
    return response.status


def start_broker(config, secret, port):
    env = {
        'PATH': os.environ['PATH'],
        'T01_BROKER_CONFIG': str(config),
        'T01_BROKER_SECRET': str(secret),
        'T01_BROKER_PORT': str(port),
    }
    process = subprocess.Popen(
        ['python3', str(RUNTIME), 'broker'], env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(30):
            if process.poll() is not None:
                raise AssertionError('broker exited before serving')
            try:
                return process, request(port)
            except OSError:
                time.sleep(0.05)
        raise AssertionError('broker did not start')
    except Exception:
        process.kill()
        process.wait()
        raise


with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    config = root / 'config.json'
    secret = root / 'secret.json'
    config.write_text('{}')
    secret.write_text('{"apiKey":"test-only"}')
    port = free_port()
    process, status = start_broker(config, secret, port)
    process.kill()
    process.wait()
    assert status == 200, f'readable broker config and secret returned {status}'

    secret.chmod(0)
    port = free_port()
    process, status = start_broker(config, secret, port)
    process.kill()
    process.wait()
    assert status == 502, f'unreadable broker secret returned {status}'

    secret.chmod(0o400)
    port = free_port()
    readiness_env = {
        'PATH': os.environ['PATH'],
        'T01_BROKER_PORT': str(port),
        'T01_BROKER_READINESS_ATTEMPTS': '20',
        'T01_BROKER_READINESS_DELAY': '0.05',
    }
    readiness = subprocess.Popen(
        ['python3', str(RUNTIME), 'wait-for-broker'], env=readiness_env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(0.15)
    broker_process, status = start_broker(config, secret, port)
    assert readiness.wait(timeout=5) == 0, 'initial refusal did not become ready'
    assert status == 200
    broker_process.kill()
    broker_process.wait()

    readiness_env['T01_BROKER_PORT'] = str(free_port())
    readiness_env['T01_BROKER_READINESS_ATTEMPTS'] = '3'
    readiness_env['T01_BROKER_READINESS_DELAY'] = '0.01'
    permanent = subprocess.run(
        ['python3', str(RUNTIME), 'wait-for-broker'], env=readiness_env,
        capture_output=True, text=True, timeout=5,
    )
    assert permanent.returncode == 1, 'permanent refusal was accepted'

    now = int(time.time())
    config.write_text(json.dumps({'run_id': '123'}))
    secret.chmod(0o600)
    secret.write_text(json.dumps({
        'apiKey': 'synthetic-only', 'runId': '123',
        'activeAccounts': 1, 'healthyProbes': 1,
        'attestedAt': now, 'probeFinishedAt': now, 'expiresAt': now + 60,
    }))
    port = free_port()
    process, status = start_broker(config, secret, port)
    assert status == 200
    assert request(port, '/health') == 200
    assert request(port, '/v1/messages') == 404
    assert request(port, '/teamkimi/status') == 404
    config.write_text(json.dumps({'run_id': '999'}))
    assert request(port, '/health') == 502
    process.kill()
    process.wait()


def fake_hermes(
    root, version='0.22.6', lazy='false', lazy_rc=1, commit=COMMIT,
    invalid_json=False, version_rc=0, version_output=None, version_signal=None,
):
    version_output = version_output if version_output is not None else f'Hermes Agent v{version}\n'
    (root / 'version-output').write_text(version_output)
    version_exit = f'kill -{version_signal} $$' if version_signal else f'exit {version_rc}'
    executable = root / 'hermes'
    executable.write_text(f'''#!/usr/bin/env bash
if [ "$1" = --version ]; then
  cat "{root}/version-output"
  {version_exit}
fi
if [ "$1 $2 $3" = 'config get security.allow_lazy_installs' ]; then
  printf '{lazy}\n'
  exit 0
fi
exit {lazy_rc}
''')
    executable.chmod(0o755)
    stamp = root / 'install-stamp.json'
    stamp.write_text('not-json' if invalid_json else json.dumps({'baseVersion': '0.22.6', 'commit': commit}))
    return executable, stamp


def provision_records(root):
    source = (ROOT / 'infra/t01-smoke/provision.sh').read_text()
    start = source.index('read_hermes_check_metadata() {')
    on_error = source[start:source.index('\ntrap on_error ERR', start)]
    env = {
        'PATH': os.environ['PATH'],
        'EVIDENCE': str(root / 'preflight.jsonl'),
        'BOOTSTRAP_STAGE': 'hermes-check',
        'T01_RUNTIME_CHECK_OUT': str(root / 'runtime-check.json'),
    }
    result = subprocess.run(
        ['bash', '-c', f'''emit() {{
  local check="$1" status="$2" details="${{3:-}}" record
  record="{{\\"check\\":\\"$check\\",\\"status\\":\\"$status\\"${{details:+,$details}}}}"
  printf '%s\\n' "$record" >> "$EVIDENCE"
}}
lock_down() {{ :; }}
publish_evidence() {{ cat "$EVIDENCE"; }}
{on_error}
false
on_error
'''],
        env=env, capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == 1, result.stderr
    return [json.loads(line) for line in (root / 'preflight.jsonl').read_text().splitlines()]


def system_package_case(failures):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        (root / 'bin').mkdir()
        for name in ('dnf-calls', 'download-calls', 'digest-calls', 'removal-calls'):
            (root / name).write_text('')
        write_executable(root / 'bin/dnf', '''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_DNF_CALLS"
printf 'raw repository failure\n' >&2
count=$(wc -l < "$MOCK_DNF_CALLS")
[ "$count" -gt "$MOCK_FAILURES" ]
''')
        write_executable(root / 'bin/curl', '''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_DOWNLOAD_CALLS"
''')
        write_executable(root / 'bin/sha256sum', '''#!/usr/bin/env bash
printf '%s\n' "$(cat)" >> "$MOCK_DIGEST_CALLS"
''')
        write_executable(root / 'bin/rm', '''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_REMOVAL_CALLS"
''')
        write_executable(root / 'bin/sleep', '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$MOCK_SLEEP_CALLS"\n')
        source = (ROOT / 'infra/t01-smoke/provision.sh').read_text()
        start = source.index('BOOTSTRAP_STAGE=system-packages')
        stage = source[start:source.index('BOOTSTRAP_STAGE=runtime-download', start)]
        start = source.index('read_hermes_check_metadata() {')
        on_error = source[start:source.index('\ntrap on_error ERR', start)]
        result = subprocess.run(
            ['bash', '-c', '''
set -Eeuo pipefail
emit() {
  local check="$1" status="$2" details="${3:-}" record
  record="{\\"check\\":\\"$check\\",\\"status\\":\\"$status\\"${details:+,$details}}"
  printf '%s\\n' "$record" >> "$EVIDENCE"
}
stop_tunnel() { :; }
lock_down() { :; }
publish_evidence() { cat "$EVIDENCE"; }
''' + on_error + '\ntrap on_error ERR\n' + stage],
            env={
                'PATH': f'{root}/bin:{os.environ["PATH"]}',
                'EVIDENCE': str(root / 'preflight.jsonl'),
                'MOCK_DNF_CALLS': str(root / 'dnf-calls'),
                'MOCK_DOWNLOAD_CALLS': str(root / 'download-calls'),
                'MOCK_DIGEST_CALLS': str(root / 'digest-calls'),
                'MOCK_REMOVAL_CALLS': str(root / 'removal-calls'),
                'MOCK_SLEEP_CALLS': str(root / 'sleep-calls'),
                'MOCK_FAILURES': str(failures),
            },
            capture_output=True, text=True, timeout=5,
        )
        calls = (root / 'dnf-calls').read_text().splitlines()
        sleeps = (root / 'sleep-calls').read_text().splitlines() if (root / 'sleep-calls').exists() else []
        downloads = (root / 'download-calls').read_text().splitlines()
        digests = (root / 'digest-calls').read_text().splitlines()
        removals = (root / 'removal-calls').read_text().splitlines()
        return result, calls, sleeps, downloads, digests, removals


def credential_secret_case(aws_content=None):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        (root / 'bin').mkdir()
        if aws_content is not None:
            write_executable(root / 'bin/aws', aws_content)
        source = (ROOT / 'infra/t01-smoke/provision.sh').read_text()
        start = source.index('BOOTSTRAP_STAGE=credential-secret')
        stage = source[start:source.index('BOOTSTRAP_STAGE=evidence-endpoint', start)]
        stage = stage.replace('/etc/t01/broker/teamkimi.json', str(root / 'teamkimi.json'))
        start = source.index('read_hermes_check_metadata() {')
        on_error = source[start:source.index('\ntrap on_error ERR', start)]
        result = subprocess.run(
            ['/bin/bash', '-c', '''
set -Eeuo pipefail
emit() {
  local check="$1" status="$2" details="${3:-}" record
  record="{\\"check\\":\\"$check\\",\\"status\\":\\"$status\\"${details:+,$details}}"
  printf '%s\\n' "$record" >> "$EVIDENCE"
}
stop_tunnel() { :; }
lock_down() { :; }
publish_evidence() {
  while IFS= read -r record; do
    printf '%s\\n' "$record"
  done < "$EVIDENCE"
}
''' + on_error + '\ntrap on_error ERR\n' + stage],
            env={
                'PATH': str(root / 'bin'),
                'EVIDENCE': str(root / 'preflight.jsonl'),
                'SCENARIO': 'preflight',
                'TEAMKIMI_SECRET_ARN': 'synthetic-secret-arn',
            },
            capture_output=True, text=True, timeout=5,
        )
        records = [json.loads(line) for line in result.stdout.splitlines()]
        return result, records


packages = 'install -y gcc gcc-c++ make cmake python3-devel python3.11 python3.11-devel libffi-devel libatomic git xz ca-certificates iptables awscli /opt/t01/session-manager-plugin.rpm'
download = '--fail --silent --show-error --location --proto =https --proto-redir =https --max-redirs 0 --connect-timeout 10 --max-time 60 https://s3.amazonaws.com/session-manager-downloads/plugin/1.2.896.0/linux_64bit/session-manager-plugin.rpm --output /opt/t01/session-manager-plugin.rpm'
digest = '89a4a07fcb92169bdd2f07c2531acd11b84857338172e7638964aaa08fd5f0e3  /opt/t01/session-manager-plugin.rpm'
result, calls, sleeps, downloads, digests, removals = system_package_case(1)
assert result.returncode == 0, (result.stdout, result.stderr)
assert calls == [packages, packages], calls
assert sleeps == ['5'], sleeps
assert downloads == [download], downloads
assert digests == [digest], digests
assert removals == ['-f /opt/t01/session-manager-plugin.rpm'], removals
result, calls, sleeps, downloads, digests, removals = system_package_case(3)
assert result.returncode == 1, (result.stdout, result.stderr)
assert calls == [packages, packages, packages], calls
assert sleeps == ['5', '5'], sleeps
assert downloads == [download], downloads
assert digests == [digest], digests
assert removals == [], removals
records = [json.loads(line) for line in result.stdout.splitlines()]
assert records[0]['category'] == 'failure:system-packages', records
assert records[0]['origin'] == 'system-packages:1', records
assert 'raw repository failure' not in result.stdout, result.stdout
result, calls, sleeps, downloads, digests, removals = system_package_case(0)
assert result.returncode == 0, (result.stdout, result.stderr)
assert calls == [packages], calls
assert sleeps == [], sleeps
assert downloads == [download], downloads
assert digests == [digest], digests
assert removals == ['-f /opt/t01/session-manager-plugin.rpm'], removals


def source_download_path_case():
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        source = (ROOT / 'infra/t01-smoke/provision.sh').read_text()
        path_line = next(
            line for line in source.splitlines()
            if line.startswith('export PATH=/opt/t01/node/bin:')
        )
        exported_path = path_line.removeprefix('export PATH=')
        directories = exported_path.split(':')
        assert directories[0] == '/opt/t01/node/bin', exported_path
        for name, parent in (('useradd', 'usr/sbin'), ('runuser', 'usr/sbin'), ('iptables', 'sbin')):
            executable = root / parent / name
            executable.parent.mkdir(parents=True, exist_ok=True)
            write_executable(executable, '#!/bin/sh\nexit 0\n')
        path = ':'.join(str(root / entry.lstrip('/')) for entry in directories)
        result = subprocess.run(
            ['/bin/bash', '-c', 'command -v useradd runuser iptables'],
            env={'PATH': path}, capture_output=True, text=True, timeout=5,
        )
        assert result.returncode == 0, (exported_path, result.stdout, result.stderr)


source_download_path_case()

provision = (ROOT / 'infra/t01-smoke/provision.sh').read_text()
stages = [
    provision.index(f'BOOTSTRAP_STAGE={stage}')
    for stage in ('credential-users', 'credential-secret', 'evidence-endpoint', 'broker-config')
]
assert stages == sorted(stages), stages
assert 'BOOTSTRAP_STAGE=credential-config' not in provision
aws_check = provision.index('command -v aws >/dev/null')
secret_read = provision.index('aws secretsmanager get-secret-value')
assert stages[1] < aws_check < secret_read, (stages[1], aws_check, secret_read)

result, records = credential_secret_case()
assert result.returncode == 1, (result.stdout, result.stderr)
assert records[0] == {
    'check': 'bootstrap_error', 'status': 'failed',
    'category': 'failure:credential-secret', 'origin': 'credential-secret:1',
}, records
raw_aws_output = 'synthetic raw secret output'
result, records = credential_secret_case(
    f'#!/bin/bash\nprintf \'%s\\n\' \'{raw_aws_output}\' >&2\nexit 1\n',
)
assert result.returncode == 1, (result.stdout, result.stderr)
assert raw_aws_output in result.stderr, result.stderr
assert raw_aws_output not in result.stdout, result.stdout
assert records[0] == {
    'check': 'bootstrap_error', 'status': 'failed',
    'category': 'failure:credential-secret', 'origin': 'credential-secret:1',
}, records


def broker_secret_refresh_case(aws_content):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        (root / 'bin').mkdir()
        target = root / 'teamkimi.json'
        target.write_text('{"attestedAt":1,"apiKey":"original-key"}')
        target.chmod(0o400)
        write_executable(root / 'bin/aws', aws_content)
        write_executable(root / 'bin/chown', '''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CHOWN_CALLS"
''')
        source = (ROOT / 'infra/t01-smoke/provision.sh').read_text()
        start = source.index('refresh_teamkimi_secret() {')
        function = source[start:source.index('\n}\n', start) + 3]
        function = function.replace('/etc/t01/broker/teamkimi.json', str(target))
        result = subprocess.run(
            ['/bin/bash', '-c', 'set -Eeuo pipefail\n' + function + '\nrefresh_teamkimi_secret'],
            env={
                'PATH': f'{root}/bin:{os.environ["PATH"]}',
                'TEAMKIMI_SECRET_ARN': 'synthetic-secret-arn',
                'CHOWN_CALLS': str(root / 'chown-calls'),
            },
            capture_output=True, text=True, timeout=5,
        )
        chown_calls = (root / 'chown-calls').read_text() if (root / 'chown-calls').exists() else ''
        return result, target.read_text(), target.stat().st_mode & 0o777, chown_calls, list(root.glob('teamkimi.json.*'))


updated_secret = '{"attestedAt":200,"apiKey":"original-key"}'
result, content, mode, chown_calls, temporaries = broker_secret_refresh_case(
    f'#!/usr/bin/env bash\nprintf \'%s\\n\' \'{updated_secret}\'\n',
)
assert result.returncode == 0, (result.stdout, result.stderr)
assert content == updated_secret + '\n'
assert mode == 0o400
assert 't01broker:t01broker' in chown_calls
assert temporaries == []
assert updated_secret not in result.stdout + result.stderr

original_secret = '{"attestedAt":1,"apiKey":"original-key"}'
raw_secret_error = 'synthetic-secret-refresh-error'
result, content, mode, chown_calls, temporaries = broker_secret_refresh_case(
    f'#!/usr/bin/env bash\nprintf \'%s\\n\' \'{raw_secret_error}\'\nprintf \'%s\\n\' \'{raw_secret_error}\' >&2\nexit 1\n',
)
assert result.returncode != 0
assert content == original_secret
assert mode == 0o400
assert chown_calls == ''
assert temporaries == []
assert raw_secret_error not in result.stdout + result.stderr

provision = (ROOT / 'infra/t01-smoke/provision.sh').read_text()
assert provision.count('aws secretsmanager get-secret-value') == 2
assert (
    '  emit trusted_tunnel_ready passed\n'
    'fi\n'
    'BOOTSTRAP_STAGE=credential-refresh\n'
    'refresh_teamkimi_secret\n'
    'BOOTSTRAP_STAGE=default-deny-lockdown\n'
    'lock_down\n'
    'emit default_deny_lockdown passed'
) in provision
lockdown_call = provision.index('lock_down\nemit default_deny_lockdown')
assert 'aws secretsmanager get-secret-value' not in provision[lockdown_call:]
assert 'BOOTSTRAP_STAGE=teamkimi-no-model\nexpect_allowed teamkimi_no_model' in provision
assert 'SECRETS_MANAGER_IP' not in provision
assert 'secretsmanager.us-east-1.amazonaws.com' not in provision
lock_down = provision.split('lock_down() {', 1)[1].split('\n}', 1)[0]
assert 'iptables -A OUTPUT -d 169.254.169.254 -j REJECT' in lock_down
assert 'iptables -A OUTPUT -d 169.254.170.2 -j REJECT' in lock_down
for rule in lock_down.splitlines():
    if 'ACCEPT' in rule:
        assert '169.254.169.254' not in rule
        assert '169.254.170.2' not in rule
        assert 'SECRETS_MANAGER' not in rule
        assert 'secretsmanager' not in rule


def assert_diagnostic(root, expected, result):
    assert result.returncode != 0, result.stderr
    assert result.stdout == '', result.stdout
    assert result.stderr == '', result.stderr
    for name in ('bootstrap-category', 'bootstrap-origin'):
        assert (root / name).stat().st_mode & 0o777 == 0o600, name
    assert (root / 'bootstrap-category').read_text() == expected
    assert (root / 'bootstrap-origin').read_text() == 'hermes-check:1'
    records = provision_records(root)
    assert records[0] == {
        'check': 'bootstrap_error', 'status': 'failed',
        'category': expected, 'origin': 'hermes-check:1',
    }
    assert records[1] == {'check': 'provisioning', 'status': 'failed'}
    assert records[2] == {'check': 'complete', 'status': 'failed'}


def hermes_check(
    version='0.22.6', lazy='false', lazy_rc=1, commit=COMMIT, invalid_json=False,
    missing=False, version_rc=0, version_output=None, version_signal=None,
):
    temporary = tempfile.TemporaryDirectory()
    root = Path(temporary.name)
    executable, stamp = fake_hermes(
        root, version, lazy, lazy_rc, commit, invalid_json,
        version_rc, version_output, version_signal,
    )
    if missing:
        executable = root / 'missing-hermes'
    output = root / 'runtime-check.json'
    env = {
        'PATH': os.environ['PATH'],
        'T01_HERMES_BIN': str(executable),
        'T01_INSTALL_STAMP': str(stamp),
        'T01_RUNTIME_CHECK_OUT': str(output),
    }
    result = subprocess.run(
        ['python3', str(RUNTIME), 'hermes-check'], env=env,
        capture_output=True, text=True, timeout=10,
    )
    return result, output.read_text() if output.exists() else None, root, temporary


result, output, root, directory = hermes_check()
assert result.returncode == 0, result.stderr
assert json.loads(output) == {
    'version': '0.22.6', 'commit': COMMIT, 'lazy_installs': False,
}


def assert_untrusted(category, origin='hermes-check:1', prepare=None):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        (root / 'bootstrap-category').write_text(category)
        (root / 'bootstrap-origin').write_text(origin)
        if prepare:
            prepare(root)
        records = provision_records(root)
        assert records[0] == {
            'check': 'bootstrap_error', 'status': 'failed',
            'category': 'failure:hermes-check', 'origin': 'hermes-check:1',
        }, records
        assert records[1] == {'check': 'provisioning', 'status': 'failed'}
        assert records[2] == {'check': 'complete', 'status': 'failed'}


assert_untrusted('runtime-version-check-failed:malicious')
assert_untrusted('runtime-version-check-failed', 'hermes-check:0')
assert_untrusted('runtime-version-system-exit-0')
assert_untrusted('runtime-version-system-exit-256')
assert_untrusted('runtime-version-signal-0')
assert_untrusted('runtime-version-signal-65')
assert_untrusted('runtime-version-missing-module-unreviewed')
assert_untrusted('not-json')
assert_untrusted('A' * 65)


def symlink_metadata(root):
    (root / 'bootstrap-category').unlink()
    (root / 'bootstrap-origin').unlink()
    (root / 'category-target').write_text('runtime-version-check-failed')
    (root / 'origin-target').write_text('hermes-check:1')
    (root / 'bootstrap-category').symlink_to(root / 'category-target')
    (root / 'bootstrap-origin').symlink_to(root / 'origin-target')


assert_untrusted('', '', symlink_metadata)


def directory_metadata(root):
    (root / 'bootstrap-category').unlink()
    (root / 'bootstrap-category').mkdir()


assert_untrusted('', '', directory_metadata)


def assert_failure(expected, **kwargs):
    result, _, root, directory = hermes_check(**kwargs)
    with directory:
        assert_diagnostic(root, expected, result)


version_exit_cases = [
    ('runtime-version-system-exit-1', {'version_rc': 1}),
    ('runtime-version-system-exit-2', {'version_rc': 2}),
    ('runtime-version-system-exit-255', {'version_rc': 255}),
    ('runtime-version-signal-15', {'version_signal': 'TERM'}),
    (
        'runtime-version-dependency-bootstrap-failed',
        {
            'version_rc': 1,
            'version_output': 'hermes: no dependency environment is committed for this install; run `hermes pm repair`\n',
        },
    ),
    (
        'runtime-version-dependency-bootstrap-failed',
        {
            'version_rc': 1,
            'version_output': 'hermes: cannot read dependency environment: /secret/state; run `hermes pm repair`\n',
        },
    ),
    (
        'runtime-version-permission-denied',
        {
            'version_rc': 1,
            'version_output': 'hermes: install state is not writable by this user (/secret/path); run as the install owner\n',
        },
    ),
    (
        'runtime-version-missing-module-openai',
        {'version_rc': 1, 'version_output': "ModuleNotFoundError: No module named 'openai'\n"},
    ),
    (
        'runtime-version-missing-module',
        {'version_rc': 1, 'version_output': "ModuleNotFoundError: No module named 'unreviewed_secret'\n"},
    ),
    (
        'runtime-version-import-failed',
        {'version_rc': 1, 'version_output': "ImportError: cannot import name 'secret' from 'openai' (/secret/path)\n"},
    ),
]
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
    list(executor.map(lambda case: assert_failure(case[0], **case[1]), version_exit_cases))
assert_failure('runtime-version-format-failed', version='0.0.0')
assert_failure('runtime-version-format-failed', version='0.22.60')
assert_failure('runtime-identity-check-failed', commit='0' * 40)
assert_failure('lazy-install-config-check-failed', lazy='true')
assert_failure('lazy-install-request-accepted', lazy_rc=0)
assert_failure('hermes-check-os-error', missing=True)
assert_failure('hermes-check-json-error', invalid_json=True)

spec = importlib.util.spec_from_file_location('t01_runtime_timeout', RUNTIME)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    with (
        patch.dict(os.environ, {'PATH': os.environ['PATH'], 'T01_RUNTIME_CHECK_OUT': str(root / 'runtime-check.json')}),
        patch.object(runtime, 'run_process', side_effect=subprocess.TimeoutExpired('hermes', 45)),
        patch.object(sys, 'argv', ['runtime.py', 'hermes-check']),
    ):
        result = runtime.main()
    assert_diagnostic(root, 'hermes-check-timeout', subprocess.CompletedProcess('hermes-check', result, stdout='', stderr=''))


def executable(root, name, content):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    path.chmod(0o755)


with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    capture = root / 'captured-secret'
    source = root / 'source-path'
    executable(root, 'bin/aws', '''#!/usr/bin/env bash
if [ "$1 $2" = 'secretsmanager create-secret' ]; then
  for argument in "$@"; do
    case "$argument" in
      file://*)
        source_path="${argument#file://}"
        cp "$source_path" "$MOCK_CAPTURE"
        printf '%s' "$source_path" > "$MOCK_SOURCE"
        ;;
    esac
  done
  printf '{"ARN":"%s"}\n' "$MOCK_ARN"
  exit 0
fi
exit 99
''')
    output = root / 'github-output'
    env = {
        'PATH': f'{root}/bin:{os.environ["PATH"]}', 'TEAMKIMI_PROXY_KEY': 'synthetic-proxy-secret',
        'GITHUB_RUN_ID': '123', 'GITHUB_OUTPUT': str(output), 'MOCK_CAPTURE': str(capture),
        'MOCK_SOURCE': str(source), 'MOCK_ARN': 'arn:aws:secretsmanager:us-east-1:594552273052:secret:hive-v2-t01-smoke-proxy-123',
    }
    result = subprocess.run(
        ['python3', str(RUNTIME), 'create-proxy-secret'], env=env, capture_output=True, text=True, timeout=5,
    )
    assert result.returncode == 0, result.stderr
    assert capture.read_text() == 'synthetic-proxy-secret'
    assert not Path(source.read_text()).exists(), 'the temporary secret file survived creation'
    assert output.read_text() == 'arn=arn:aws:secretsmanager:us-east-1:594552273052:secret:hive-v2-t01-smoke-proxy-123\n'
    assert 'synthetic-proxy-secret' not in result.stdout + result.stderr

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    executable(root, 'bin/aws', '''#!/usr/bin/env bash
if [ "$1 $2" = 'secretsmanager get-secret-value' ]; then
  printf 'synthetic-proxy-secret\n'
  exit 0
fi
exit 99
''')
    environment = root / 'proxy.env'
    result = subprocess.run(
        ['python3', str(RUNTIME), 'write-proxy-environment'],
        env={
            'PATH': f'{root}/bin:{os.environ["PATH"]}',
            'TEAMKIMI_PROXY_SECRET_ARN': 'arn:aws:secretsmanager:us-east-1:594552273052:secret:hive-v2-t01-smoke-proxy-123',
            'T01_PROXY_ENVIRONMENT': str(environment),
        },
        capture_output=True, text=True, timeout=5,
    )
    assert result.returncode == 0, result.stderr
    assert environment.read_text() == 'HIVE_T01_PROXY_KEY=synthetic-proxy-secret\n'
    assert environment.stat().st_mode & 0o777 == 0o400
    assert 'synthetic-proxy-secret' not in result.stdout + result.stderr


def broker_status_case(responses):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        (root / 'bin').mkdir()
        (root / 'count').write_text('0')
        response_cases = '\n'.join(
            f"  {attempt}) printf '%s' '{code}'; exit {status} ;;"
            for attempt, (code, status) in enumerate(responses, 1)
        )
        executable(root, 'bin/runuser', f'''#!/usr/bin/env bash
count=$(($(cat "$MOCK_COUNT") + 1))
printf '%s\n' "$count" > "$MOCK_COUNT"
printf '%s\n' "$*" >> "$MOCK_CALLS"
printf 'raw tunnel output synthetic-credential\n' >&2
case "$count" in
{response_cases}
  *) exit 99 ;;
esac
''')
        executable(root, 'bin/sleep', '''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_SLEEPS"
''')
        source = (ROOT / 'infra/t01-smoke/provision.sh').read_text()
        start = source.index('expect_broker_allowed() {')
        check = source[start:source.index('\n}', start) + 2]
        start = source.index('read_hermes_check_metadata() {')
        on_error = source[start:source.index('\ntrap on_error ERR', start)]
        on_error = on_error.replace('/var/lib/t01/evidence', str(root))
        result = subprocess.run(
            ['/bin/bash', '-c', f'''set -Eeuo pipefail
emit() {{
  local check="$1" status="$2" details="${{3:-}}" record
  record="{{\\"check\\":\\"$check\\",\\"status\\":\\"$status\\"${{details:+,$details}}}}"
  printf '%s\\n' "$record" >> "$EVIDENCE"
}}
stop_tunnel() {{ :; }}
lock_down() {{ :; }}
publish_evidence() {{ cat "$EVIDENCE"; }}
{on_error}
trap on_error ERR
{check}
BOOTSTRAP_STAGE=teamkimi-no-model
expect_broker_allowed teamkimi_control_broker curl -4 --silent http://127.0.0.1:8765/teamkimi/smoke/status
printf '%s' "$BOOTSTRAP_STAGE" > "$MOCK_FINAL_STAGE"
'''],
            env={
                'PATH': f'{root}/bin:{os.environ["PATH"]}',
                'EVIDENCE': str(root / 'preflight.jsonl'),
                'T01_RUNTIME_CHECK_OUT': str(root / 'runtime-check.json'),
                'MOCK_COUNT': str(root / 'count'),
                'MOCK_CALLS': str(root / 'calls'),
                'MOCK_SLEEPS': str(root / 'sleeps'),
                'MOCK_FINAL_STAGE': str(root / 'final-stage'),
            },
            capture_output=True, text=True, timeout=5,
        )
        evidence = root / 'preflight.jsonl'
        records = [json.loads(line) for line in evidence.read_text().splitlines()] if evidence.exists() else []
        calls = (root / 'calls').read_text().splitlines()
        sleeps_path = root / 'sleeps'
        sleeps = sleeps_path.read_text().splitlines() if sleeps_path.exists() else []
        final_stage_path = root / 'final-stage'
        final_stage = final_stage_path.read_text() if final_stage_path.exists() else None
        return result, records, calls, sleeps, final_stage


result, records, calls, sleeps, final_stage = broker_status_case([('503', 0), ('000', 7), ('200', 0)])
assert result.returncode == 0, (result.stdout, result.stderr)
assert records == [{'check': 'teamkimi_control_broker', 'status': 'passed'}], records
assert len(calls) == 3, calls
assert sleeps == ['2', '2'], sleeps
assert all('--output /dev/null --write-out %{http_code}' in call for call in calls), calls
assert final_stage == 'teamkimi-no-model', final_stage

for responses, code in (
    ([('503', 0)] * 3, '503'),
    ([('000', 7)] * 3, '000'),
):
    result, records, calls, sleeps, _ = broker_status_case(responses)
    assert result.returncode == 1, (result.stdout, result.stderr)
    assert records == [
        {'check': 'teamkimi_control_broker', 'status': 'failed'},
        {
            'check': 'bootstrap_error', 'status': 'failed',
            'category': 'failure:teamkimi-control-broker',
            'origin': f'teamkimi-control-broker:{code}',
        },
        {'check': 'provisioning', 'status': 'failed'},
        {'check': 'complete', 'status': 'failed'},
    ], records
    assert len(calls) == 3, calls
    assert sleeps == ['2', '2'], sleeps
    assert 'raw tunnel output' not in result.stdout + result.stderr
    assert 'synthetic-credential' not in result.stdout + result.stderr
