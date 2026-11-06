import http.client
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

VERSION = '0.22.6'
COMMIT = 'f0d94882e89ab8d4098b5bb2f166adfb9ee0a0ab'
SOURCE_SHA256 = '551f2c190f21a0df8e0576a20809c63d3077bc56568fe009b98b289fae2efa81'
SIMPLE_CHECKS = {
    'frozen_hash_lock_install', 'lazy_install_disabled', 'service_filesystem_access',
    'default_deny_lockdown', 'direct_ip', 'unapproved_dns', 'redirect', 'ipv6',
    'alternate_port', 'metadata', 'container_credentials', 'teamkimi_no_model',
    'paid_admission_disabled',
}
ALLOWED_CHECKS = SIMPLE_CHECKS | {'hermes_version', 'source_sha256', 'provisioning', 'complete'}
ALLOWED_FIELDS = {'check', 'status', 'version', 'commit', 'sha256'}


def read_json(path):
    with open(path, encoding='utf-8') as source:
        return json.load(source)


class BrokerHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return

    def reply(self, status, body):
        payload = json.dumps(body, separators=(',', ':')).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(payload)

    def broker_values(self):
        config = read_json(os.environ.get('T01_BROKER_CONFIG', '/etc/t01/broker/config.json'))
        secret = read_json(os.environ.get('T01_BROKER_SECRET', '/etc/t01/broker/teamkimi.json'))
        return config, secret

    def do_GET(self):
        if self.path == '/redirect-fixture':
            self.send_response(302)
            self.send_header('Location', 'https://example.com/')
            self.send_header('Connection', 'close')
            self.end_headers()
            return
        if self.path == '/access-check':
            try:
                self.broker_values()
                self.reply(200, {'status': 'ok'})
            except (OSError, ValueError, json.JSONDecodeError):
                self.reply(502, {'status': 'access_failed'})
            return
        if self.path != '/health':
            self.reply(404, {'status': 'unavailable'})
            return
        try:
            config, secret = self.broker_values()
            api_key = secret[config['teamkimi_secret_key']]
            if not isinstance(api_key, str) or not api_key:
                raise ValueError('invalid credential shape')
            target = urlsplit(config['teamkimi_url'])
            connection = http.client.HTTPSConnection(
                target.hostname, 443, timeout=10, context=ssl.create_default_context()
            )
            connection.request('GET', config['teamkimi_connectivity_path'], headers={
                'Authorization': f'Bearer {api_key}',
                'Accept': 'application/json',
                'Connection': 'close',
            })
            response = connection.getresponse()
            response.read(1024)
            connection.close()
            if 200 <= response.status < 300:
                self.reply(200, {'status': 'ok'})
            else:
                self.reply(502, {'status': 'upstream_rejected', 'upstream_status': response.status})
        except (OSError, ValueError, KeyError, json.JSONDecodeError, ssl.SSLError, http.client.HTTPException):
            self.reply(502, {'status': 'connectivity_failed'})


def broker():
    port = int(os.environ.get('T01_BROKER_PORT', '8765'))
    ThreadingHTTPServer(('127.0.0.1', port), BrokerHandler).serve_forever()


def wait_for_broker():
    port = int(os.environ.get('T01_BROKER_PORT', '8765'))
    attempts = int(os.environ.get('T01_BROKER_READINESS_ATTEMPTS', '30'))
    delay = float(os.environ.get('T01_BROKER_READINESS_DELAY', '1'))
    for attempt in range(attempts):
        try:
            connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
            connection.request('GET', '/access-check')
            response = connection.getresponse()
            response.read(1024)
            connection.close()
            return 0 if 200 <= response.status < 300 else 1
        except ConnectionRefusedError:
            if attempt + 1 < attempts:
                time.sleep(delay)
        except OSError:
            return 1
    return 1


def run_process(arguments, timeout):
    return subprocess.run(arguments, capture_output=True, text=True, timeout=timeout, check=False)


def hermes_check():
    executable = os.environ.get('T01_HERMES_BIN', '/opt/t01/hermes/bin/hermes')
    stamp_path = os.environ.get('T01_INSTALL_STAMP', '/opt/t01/source/install-stamp.json')
    output_path = os.environ.get('T01_RUNTIME_CHECK_OUT', '/var/lib/t01/hermes/runtime-check.json')
    result = run_process([executable, '--version'], 45)
    output = f'{result.stdout}\n{result.stderr}'
    version_line = f'Hermes Agent v{VERSION}'
    matching_lines = [line.strip() for line in output.splitlines() if line.strip().startswith(version_line)]
    if result.returncode != 0 or not any(
        line == version_line or line[len(version_line):].startswith((' ', '('))
        for line in matching_lines
    ):
        raise RuntimeError('runtime version check failed')
    stamp = read_json(stamp_path)
    if stamp.get('baseVersion') != VERSION or stamp.get('commit') != COMMIT:
        raise RuntimeError('runtime identity check failed')
    config = run_process([executable, 'config', 'get', 'security.allow_lazy_installs'], 45)
    if config.returncode != 0 or config.stdout.strip().lower() != 'false':
        raise RuntimeError('lazy-install config check failed')
    lazy_install = run_process([executable, 'pm', 'environment', 'voice', '--extra', 'voice'], 60)
    if lazy_install.returncode == 0:
        raise RuntimeError('lazy-install request was accepted')
    record = {'version': VERSION, 'commit': COMMIT, 'lazy_installs': False}
    descriptor = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as output_file:
        json.dump(record, output_file, sort_keys=True)
        output_file.write('\n')


def validate_evidence(path):
    try:
        with open(path, encoding='utf-8') as source:
            records = [json.loads(line) for line in source if line.strip()]
    except (OSError, ValueError):
        return 1
    if not records or records[-1] != {'check': 'complete', 'status': 'passed'}:
        return 1
    seen = set()
    for record in records:
        if not isinstance(record, dict) or set(record) - ALLOWED_FIELDS:
            return 1
        check = record.get('check')
        if check not in ALLOWED_CHECKS or record.get('status') not in {'passed', 'failed'}:
            return 1
        if check in seen or record.get('status') != 'passed':
            return 1
        seen.add(check)
        if check == 'hermes_version':
            if record != {'check': check, 'status': 'passed', 'version': VERSION, 'commit': COMMIT}:
                return 1
        elif check == 'source_sha256':
            if record != {'check': check, 'status': 'passed', 'sha256': SOURCE_SHA256}:
                return 1
        elif set(record) != {'check', 'status'}:
            return 1
    required = SIMPLE_CHECKS | {'hermes_version', 'source_sha256', 'complete'}
    return 0 if seen == required else 1


def main():
    if len(sys.argv) < 2:
        return 2
    if sys.argv[1] == 'broker':
        broker()
        return 0
    if sys.argv[1] == 'wait-for-broker' and len(sys.argv) == 2:
        try:
            return wait_for_broker()
        except (OSError, ValueError):
            return 1
    if sys.argv[1] == 'hermes-check' and len(sys.argv) == 2:
        try:
            hermes_check()
            return 0
        except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
            return 1
    if sys.argv[1] == 'validate-evidence' and len(sys.argv) == 3:
        return validate_evidence(sys.argv[2])
    return 2


if __name__ == '__main__':
    raise SystemExit(main())
