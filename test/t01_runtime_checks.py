import http.client
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time

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


def fake_hermes(root, version='0.22.6', lazy='false', lazy_rc=1):
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
    stamp.write_text(json.dumps({'baseVersion': '0.22.6', 'commit': COMMIT}))
    return executable, stamp


def hermes_check(version='0.22.6', lazy='false', lazy_rc=1):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        executable, stamp = fake_hermes(root, version, lazy, lazy_rc)
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
        return result, output.read_text() if output.exists() else None


result, output = hermes_check()
assert result.returncode == 0, result.stderr
assert json.loads(output) == {
    'version': '0.22.6', 'commit': COMMIT, 'lazy_installs': False,
}
result, _ = hermes_check(version='0.0.0')
assert result.returncode != 0, 'placeholder runtime version was accepted'
result, _ = hermes_check(version='0.22.60')
assert result.returncode != 0, 'a version with the expected prefix was accepted'
result, _ = hermes_check(lazy='true', lazy_rc=0)
assert result.returncode != 0, 'enabled lazy installs were accepted'
