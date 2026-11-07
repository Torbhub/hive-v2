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


def fake_hermes(root, version='0.22.6', lazy='false', lazy_rc=1, commit=COMMIT, invalid_json=False):
    executable = root / 'hermes'
    executable.write_text(f'''#!/usr/bin/env bash
if [ "$1" = --version ]; then
  printf 'Hermes Agent v{version}\n'
  exit 0
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


def hermes_check(version='0.22.6', lazy='false', lazy_rc=1, commit=COMMIT, invalid_json=False, missing=False):
    temporary = tempfile.TemporaryDirectory()
    root = Path(temporary.name)
    executable, stamp = fake_hermes(root, version, lazy, lazy_rc, commit, invalid_json)
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


assert_failure('runtime-version-check-failed', version='0.0.0')
assert_failure('runtime-version-check-failed', version='0.22.60')
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
