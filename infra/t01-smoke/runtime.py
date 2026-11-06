import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = '0.22.6'
COMMIT = 'f0d94882e89ab8d4098b5bb2f166adfb9ee0a0ab'
SOURCE_SHA256 = '551f2c190f21a0df8e0576a20809c63d3077bc56568fe009b98b289fae2efa81'
BASE_SIMPLE_CHECKS = {
    'uv_install', 'python_install', 'frozen_hash_lock_install', 'node_runtime_locked',
    'runner_dependencies_locked', 'lazy_install_disabled', 'service_filesystem_access',
    'default_deny_lockdown', 'direct_ip', 'unapproved_dns', 'redirect', 'ipv6',
    'alternate_port', 'metadata', 'container_credentials', 'teamkimi_no_model',
}
SIMPLE_CHECKS = BASE_SIMPLE_CHECKS | {
    'paid_admission_disabled', 'trusted_tunnel_ready', 'count_only_no_generation',
    'teamkimi_control_port', 'teamkimi_control_broker',
    'tunnel_cleanup', 'paid_evidence_export', 'paid_matrix_completed',
}
ALLOWED_CHECKS = SIMPLE_CHECKS | {'bootstrap_error', 'hermes_version', 'source_sha256', 'provisioning', 'complete'}
ALLOWED_FIELDS = {
    'check', 'status', 'version', 'commit', 'sha256', 'category', 'origin', 'policyHash',
    'requestHash', 'model', 'inputTokens', 'baseInputTokens', 'cacheReadInputTokens',
    'cacheCreationInputTokens', 'cacheCreation5mInputTokens', 'cacheCreation1hInputTokens',
    'generationRequests', 'timestamp', 'revokedAt', 'proof', 'credentialId',
}


def read_json(path):
    with open(path, encoding='utf-8') as source:
        return json.load(source)


def valid_health(secret, run_id, now):
    try:
        return (
            secret['runId'] == run_id
            and type(secret['activeAccounts']) is int and secret['activeAccounts'] > 0
            and type(secret['healthyProbes']) is int and secret['healthyProbes'] > 0
            and secret['healthyProbes'] <= secret['activeAccounts']
            and type(secret['attestedAt']) is int
            and secret['attestedAt'] <= now + 60 and now - secret['attestedAt'] <= 600
            and type(secret['probeFinishedAt']) is int
            and secret['probeFinishedAt'] <= now + 60 and now - secret['probeFinishedAt'] <= 600
            and secret['probeFinishedAt'] <= secret['attestedAt']
            and type(secret['expiresAt']) is int and now < secret['expiresAt']
            and isinstance(secret['apiKey'], str) and bool(secret['apiKey'])
        )
    except (KeyError, TypeError):
        return False


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
            if valid_health(secret, config['run_id'], int(time.time())):
                self.reply(200, {'status': 'ok'})
            else:
                self.reply(502, {'status': 'health_unavailable'})
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            self.reply(502, {'status': 'health_unavailable'})


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


def wait_for_teamkimi():
    for attempt in range(30):
        try:
            connection = http.client.HTTPConnection('127.0.0.1', 8765, timeout=2)
            connection.request('GET', '/teamkimi/smoke/status', headers={'Accept': 'application/json'})
            response = connection.getresponse()
            payload = response.read(65_537)
            connection.close()
            if response.status == 200 and len(payload) <= 65_536:
                status = json.loads(payload)
                if status.get('enabled') is True and status.get('reservations') == [] \
                        and status.get('totals', {}).get('admissions') == 0:
                    return 0
        except (OSError, ValueError, json.JSONDecodeError, http.client.HTTPException):
            pass
        if attempt < 29:
            time.sleep(1)
    return 1


def run_process(arguments, timeout):
    return subprocess.run(arguments, capture_output=True, text=True, timeout=timeout, check=False)


MODULE_ALLOWLIST = {
    'pm': 'pm',
    'hermes_cli': 'hermes-cli',
    'hermes_bootstrap': 'hermes-bootstrap',
    'hermes_constants': 'hermes-constants',
    'openai': 'openai',
    'httpx': 'httpx',
    'rich': 'rich',
    'ruamel': 'ruamel',
    'pydantic': 'pydantic',
    'mcp': 'mcp',
    'fire': 'fire',
    'dotenv': 'dotenv',
}
DEPENDENCY_BOOTSTRAP_SIGNATURES = (
    'hermes: no dependency environment is committed for this install; run `hermes pm repair`',
    'hermes: cannot read dependency environment:',
    'hermes: invalid dependency environment record:',
    'hermes: invalid dependency environment path;',
    'hermes: dependency environment is missing or outside this install;',
    'hermes: dependency environment has no site-packages:',
)
RUNTIME_VERSION_CATEGORIES = frozenset({
    'runtime-version-check-failed',
    'runtime-version-exit-failed',
    'runtime-version-format-failed',
    'runtime-version-dependency-bootstrap-failed',
    'runtime-version-permission-denied',
    'runtime-version-missing-module',
    'runtime-version-import-failed',
    *(f'runtime-version-missing-module-{name}' for name in MODULE_ALLOWLIST.values()),
})


def valid_runtime_version_category(category):
    if category in RUNTIME_VERSION_CATEGORIES:
        return True
    for kind, maximum in (('system-exit', 255), ('signal', 64)):
        match = re.fullmatch(fr'runtime-version-{kind}-([1-9][0-9]*)', category)
        if match:
            return int(match.group(1)) <= maximum
    return False


def classify_version_exit(returncode, output):
    if returncode < 0:
        signal = -returncode
        return f'runtime-version-signal-{signal}' if signal <= 64 else 'runtime-version-exit-failed'
    if any(signature in output for signature in DEPENDENCY_BOOTSTRAP_SIGNATURES):
        return 'runtime-version-dependency-bootstrap-failed'
    if 'hermes: install state is not writable by this user (' in output or 'Permission denied' in output:
        return 'runtime-version-permission-denied'
    missing = re.search(
        r"(?m)^ModuleNotFoundError: No module named '([A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z_][A-Za-z0-9_]*)*'$",
        output,
    )
    if missing:
        module = MODULE_ALLOWLIST.get(missing.group(1))
        return f'runtime-version-missing-module-{module}' if module else 'runtime-version-missing-module'
    if re.search(r'(?m)^ImportError:', output):
        return 'runtime-version-import-failed'
    if 1 <= returncode <= 255:
        return f'runtime-version-system-exit-{returncode}'
    return 'runtime-version-exit-failed'


def proxy_control_key(value):
    if not isinstance(value, str) or not value or len(value) > 512 or any(character.isspace() for character in value):
        raise ValueError('invalid TeamKimi proxy control key')
    return value


def create_proxy_secret():
    key = proxy_control_key(os.environ['TEAMKIMI_PROXY_KEY'])
    run_id = os.environ['GITHUB_RUN_ID']
    if not re.fullmatch(r'[0-9]+', run_id):
        raise ValueError('invalid run ID')
    name = f'hive-v2-t01-smoke-proxy-{run_id}'
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', delete=False) as temporary:
        temporary.write(key)
        path = Path(temporary.name)
    try:
        result = run_process([
            'aws', 'secretsmanager', 'create-secret', '--name', name,
            '--description', 'Expiring run-scoped T01 TeamKimi control key',
            '--secret-string', f'file://{path}',
        ], 30)
        if result.returncode != 0:
            raise RuntimeError('proxy secret creation failed')
        created = json.loads(result.stdout)
    finally:
        path.unlink(missing_ok=True)
    output = os.environ.get('GITHUB_OUTPUT')
    if output:
        with open(output, 'a', encoding='utf-8') as destination:
            destination.write(f'arn={created["ARN"]}\n')
    print(json.dumps({'arn': created['ARN']}, separators=(',', ':')))


def write_proxy_environment():
    result = run_process([
        'aws', 'secretsmanager', 'get-secret-value', '--secret-id', os.environ['TEAMKIMI_PROXY_SECRET_ARN'],
        '--query', 'SecretString', '--output', 'text',
    ], 30)
    if result.returncode != 0:
        raise RuntimeError('proxy secret read failed')
    key = proxy_control_key(result.stdout.rstrip('\n'))
    path = Path(os.environ.get('T01_PROXY_ENVIRONMENT', '/etc/t01/proxy.env'))
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o400)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as environment:
        environment.write(f'HIVE_T01_PROXY_KEY={key}\n')
    path.chmod(0o400)



def hermes_check():
    executable = os.environ.get('T01_HERMES_BIN', '/opt/t01/hermes/bin/hermes')
    stamp_path = os.environ.get('T01_INSTALL_STAMP', '/opt/t01/source/install-stamp.json')
    output_path = os.environ.get('T01_RUNTIME_CHECK_OUT', '/var/lib/t01/hermes/runtime-check.json')
    result = run_process([executable, '--version'], 45)
    output = f'{result.stdout}\n{result.stderr}'
    version_line = f'Hermes Agent v{VERSION}'
    matching_lines = [line.strip() for line in output.splitlines() if line.strip().startswith(version_line)]
    if result.returncode != 0:
        raise RuntimeError(classify_version_exit(result.returncode, output))
    if not any(
        line == version_line or line[len(version_line):].startswith((' ', '('))
        for line in matching_lines
    ):
        raise RuntimeError('runtime version format failed')
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


HERMES_CHECK_CATEGORIES = {
    'runtime version check failed': 'runtime-version-check-failed',
    'runtime version exit failed': 'runtime-version-exit-failed',
    'runtime version format failed': 'runtime-version-format-failed',
    'runtime identity check failed': 'runtime-identity-check-failed',
    'lazy-install config check failed': 'lazy-install-config-check-failed',
    'lazy-install request was accepted': 'lazy-install-request-accepted',
}


def write_hermes_check_metadata(path, content):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as output_file:
        output_file.write(content)


def record_hermes_check_error(error):
    if isinstance(error, subprocess.TimeoutExpired):
        category = 'hermes-check-timeout'
    elif isinstance(error, json.JSONDecodeError):
        category = 'hermes-check-json-error'
    elif isinstance(error, OSError):
        category = 'hermes-check-os-error'
    elif isinstance(error, RuntimeError):
        message = str(error)
        category = HERMES_CHECK_CATEGORIES.get(message, 'hermes-check-runtime-error')
        if valid_runtime_version_category(message):
            category = message
    else:
        category = 'hermes-check-value-error'
    output_path = Path(os.environ.get('T01_RUNTIME_CHECK_OUT', '/var/lib/t01/hermes/runtime-check.json'))
    write_hermes_check_metadata(output_path.parent / 'bootstrap-category', category)
    write_hermes_check_metadata(output_path.parent / 'bootstrap-origin', 'hermes-check:1')


MAX_EVIDENCE_BYTES = 65_536
FAILURE_CHECKS = {'bootstrap_error', 'provisioning', 'complete'}


def read_evidence(path):
    if Path(path).stat().st_size > MAX_EVIDENCE_BYTES:
        raise ValueError('evidence is oversized')
    with open(path, encoding='utf-8') as source:
        return [json.loads(line) for line in source if line.strip()]


COUNT_INPUT_FIELDS = (
    'inputTokens', 'baseInputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens',
    'cacheCreation5mInputTokens', 'cacheCreation1hInputTokens',
)


def valid_counted_input(counts):
    return isinstance(counts, dict) \
        and all(type(counts.get(key)) is int and counts[key] >= 0 for key in COUNT_INPUT_FIELDS) \
        and counts['cacheCreationInputTokens'] == counts['cacheCreation5mInputTokens'] + counts['cacheCreation1hInputTokens'] \
        and counts['inputTokens'] == counts['baseInputTokens'] + counts['cacheReadInputTokens'] + counts['cacheCreationInputTokens']


def count_evidence(path):
    raw = Path(path).read_bytes()
    if len(raw) > MAX_EVIDENCE_BYTES:
        raise ValueError('count evidence is oversized')
    value = json.loads(raw)
    if not isinstance(value, dict) or set(value) != {
        'schemaVersion', 'model', 'requestHash', 'counts', 'generationRequests', 'status', 'timestamp', 'revocation',
    } or value['schemaVersion'] != 1 or value['model'] != 'kimi-code/k3.1-pro' \
            or value['status'] != 'counted' or value['generationRequests'] != 0 \
            or not re.fullmatch(r'[a-f0-9]{64}', value['requestHash']):
        raise ValueError('invalid count evidence')
    counts = value['counts']
    if set(counts) != set(COUNT_INPUT_FIELDS) or not valid_counted_input(counts):
        raise ValueError('invalid counted input')
    revocation = value['revocation']
    if not isinstance(revocation, dict) or set(revocation) != {'id', 'revokedAt', 'proof'} \
            or not re.fullmatch(r'[A-Za-z0-9._:-]{1,256}', revocation['id']) \
            or type(revocation['revokedAt']) is not int or revocation['revokedAt'] < 0 \
            or not re.fullmatch(r'[a-f0-9]{64}', revocation['proof']) \
            or type(value['timestamp']) is not int or value['timestamp'] < 0:
        raise ValueError('invalid count revocation')
    record = {
        'check': 'count_only_no_generation', 'status': 'passed',
        'sha256': hashlib.sha256(raw).hexdigest(), 'requestHash': value['requestHash'],
        'model': value['model'], **counts, 'generationRequests': 0,
        'timestamp': value['timestamp'], 'revokedAt': revocation['revokedAt'], 'proof': revocation['proof'],
    }
    if not valid_record(record):
        raise ValueError('count record failed sanitization')
    print(json.dumps(record, separators=(',', ':'), sort_keys=True))


def paid_export_credential(path, manifest_path):
    records = [record for record in read_evidence(path) if record.get('check') == 'paid_evidence_export']
    if len(records) != 1 or not valid_record(records[0]):
        raise ValueError('invalid paid export marker')
    if hashlib.sha256(Path(manifest_path).read_bytes()).hexdigest() != records[0]['sha256']:
        raise ValueError('paid export manifest hash mismatch')
    print(records[0]['credentialId'])


def manifest_credential(path):
    raw = Path(path).read_bytes()
    if len(raw) > MAX_EVIDENCE_BYTES:
        raise ValueError('oversized preflight evidence')
    revocation = json.loads(raw).get('revocation', {})
    if revocation.get('scope') != 'generation' or revocation.get('verified') is not True \
            or revocation.get('revoked') is not True or revocation.get('credentialId') != revocation.get('receiptId') \
            or not re.fullmatch(r'[a-f0-9]{32}', revocation.get('credentialId', '')) \
            or not re.fullmatch(r'[a-f0-9]{64}', revocation.get('proof', '')):
        raise ValueError('generation revocation not proven')
    print(revocation['credentialId'])


def valid_record(record):
    if not isinstance(record, dict) or set(record) - ALLOWED_FIELDS:
        return False
    check = record.get('check')
    status = record.get('status')
    if not isinstance(check, str) or not isinstance(status, str):
        return False
    if check not in ALLOWED_CHECKS or status not in {'passed', 'failed'}:
        return False
    if status == 'failed' and check not in FAILURE_CHECKS:
        return False
    if check == 'bootstrap_error':
        category = record.get('category')
        origin = record.get('origin')
        if set(record) != {'check', 'status', 'category', 'origin'}:
            return False
        if not isinstance(category, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_.:-]*', category):
            return False
        if category.startswith('runtime-version-') and not valid_runtime_version_category(category):
            return False
        if not isinstance(origin, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+:[0-9]+', origin):
            return False
    elif check == 'hermes_version':
        if record != {'check': check, 'status': 'passed', 'version': VERSION, 'commit': COMMIT}:
            return False
    elif check == 'source_sha256':
        if record != {'check': check, 'status': 'passed', 'sha256': SOURCE_SHA256}:
            return False
    elif check == 'node_runtime_locked':
        if record != {'check': check, 'status': 'passed', 'version': '22.23.2'}:
            return False
    elif check == 'paid_evidence_export':
        if set(record) != {'check', 'status', 'sha256', 'credentialId'} \
                or not re.fullmatch(r'[a-f0-9]{64}', record.get('sha256', '')) \
                or not re.fullmatch(r'[a-f0-9]{32}', record.get('credentialId', '')):
            return False
    elif check == 'count_only_no_generation':
        expected = {
            'check', 'status', 'sha256', 'requestHash', 'model', *COUNT_INPUT_FIELDS,
            'generationRequests', 'timestamp', 'revokedAt', 'proof',
        }
        if set(record) != expected or record['model'] != 'kimi-code/k3.1-pro' \
                or not re.fullmatch(r'[a-f0-9]{64}', record['sha256']) \
                or not re.fullmatch(r'[a-f0-9]{64}', record['requestHash']) \
                or not re.fullmatch(r'[a-f0-9]{64}', record['proof']) \
                or any(type(record[key]) is not int or record[key] < 0 for key in ('timestamp', 'revokedAt')) \
                or type(record['generationRequests']) is not int or record['generationRequests'] != 0 \
                or not valid_counted_input(record):
            return False
    elif check == 'paid_matrix_completed':
        if set(record) != {'check', 'status', 'policyHash'} or not re.fullmatch(r'[a-f0-9]{64}', record.get('policyHash', '')):
            return False
    elif set(record) != {'check', 'status'}:
        return False
    return True


def sanitize_evidence(path):
    try:
        records = read_evidence(path)
    except (OSError, ValueError):
        return 1
    seen = set()
    for record in records:
        check = record.get('check') if isinstance(record, dict) else None
        if check in seen or not valid_record(record):
            return 1
        seen.add(check)
    return 0


def validate_evidence(path):
    try:
        return 0 if classify_records(read_evidence(path)) == 'passed' else 1
    except (OSError, ValueError):
        return 1


def classify_records(records):
    seen = set()
    for record in records:
        check = record.get('check') if isinstance(record, dict) else None
        if not valid_record(record) or check in seen:
            return 'invalid'
        seen.add(check)
    if 'complete' not in seen:
        return 'incomplete'
    if records[-1] == {'check': 'complete', 'status': 'passed'}:
        required = BASE_SIMPLE_CHECKS | {'hermes_version', 'source_sha256', 'complete'}
        if 'paid_matrix_completed' in seen:
            required |= {
                'trusted_tunnel_ready', 'count_only_no_generation', 'tunnel_cleanup',
                'teamkimi_control_port', 'teamkimi_control_broker',
                'paid_evidence_export', 'paid_matrix_completed',
            }
        elif 'count_only_no_generation' in seen:
            required |= {
                'trusted_tunnel_ready', 'count_only_no_generation', 'tunnel_cleanup',
                'teamkimi_control_port', 'teamkimi_control_broker', 'paid_admission_disabled',
            }
        else:
            required.add('paid_admission_disabled')
        return 'passed' if seen == required else 'invalid'
    if records[-1] == {'check': 'complete', 'status': 'failed'}:
        return 'failed'
    return 'invalid'


def classify_evidence(path):
    try:
        return classify_records(read_evidence(path))
    except (OSError, ValueError):
        return 'invalid'


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
    if sys.argv[1] == 'wait-for-teamkimi' and len(sys.argv) == 2:
        return wait_for_teamkimi()
    if sys.argv[1] == 'create-proxy-secret' and len(sys.argv) == 2:
        try:
            create_proxy_secret()
            return 0
        except (OSError, ValueError, RuntimeError, KeyError, TypeError, json.JSONDecodeError, subprocess.TimeoutExpired):
            return 1
    if sys.argv[1] == 'write-proxy-environment' and len(sys.argv) == 2:
        try:
            write_proxy_environment()
            return 0
        except (OSError, ValueError, RuntimeError, KeyError, TypeError, json.JSONDecodeError, subprocess.TimeoutExpired):
            return 1
    if sys.argv[1] == 'hermes-check' and len(sys.argv) == 2:
        try:
            hermes_check()
            return 0
        except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
            record_hermes_check_error(error)
            return 1
    if sys.argv[1] == 'validate-evidence' and len(sys.argv) == 3:
        return validate_evidence(sys.argv[2])
    if sys.argv[1] == 'sanitize-evidence' and len(sys.argv) == 3:
        return sanitize_evidence(sys.argv[2])
    if sys.argv[1] == 'classify-evidence' and len(sys.argv) == 3:
        print(classify_evidence(sys.argv[2]))
        return 0
    if sys.argv[1] == 'count-evidence' and len(sys.argv) == 3:
        try:
            count_evidence(sys.argv[2])
            return 0
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            return 1
    if sys.argv[1] == 'manifest-credential' and len(sys.argv) == 3:
        try:
            manifest_credential(sys.argv[2])
            return 0
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            return 1
    if sys.argv[1] == 'paid-export-credential' and len(sys.argv) == 4:
        try:
            paid_export_credential(sys.argv[2], sys.argv[3])
            return 0
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            return 1
    return 2


if __name__ == '__main__':
    raise SystemExit(main())
