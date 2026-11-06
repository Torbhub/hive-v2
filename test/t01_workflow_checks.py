import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
from types import SimpleNamespace

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


def validate_evidence(records, expected_rc, cli=False):
    temporary, root = workspace()
    with temporary:
        artifact = root / 'evidence.jsonl'
        artifact.write_text(''.join(json.dumps(record, separators=(',', ':')) + '\n' for record in records))
        if cli:
            result = subprocess.run(
                ['python3', 'infra/t01-smoke/runtime.py', 'validate-evidence', str(artifact)],
                cwd=root, capture_output=True, text=True,
            )
        else:
            spec = importlib.util.spec_from_file_location('t01_runtime', root / 'infra/t01-smoke/runtime.py')
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            result = SimpleNamespace(returncode=module.validate_evidence(str(artifact)), stdout='', stderr='')
        assert result.returncode == expected_rc, (records, result.stdout, result.stderr)


validate_evidence(evidence_records(), 0, cli=True)
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
bootstrap_failure = evidence_records()
bootstrap_failure.insert(2, {
    'check': 'bootstrap_error', 'status': 'failed',
    'category': 'InstallError:pm-runtime', 'origin': 'client.py:212',
})
validate_evidence(bootstrap_failure, 1)
bad_category = evidence_records()
bad_category.insert(2, {
    'check': 'bootstrap_error', 'status': 'failed',
    'category': 'unsafe message with spaces', 'origin': 'client.py:212',
})
validate_evidence(bad_category, 1)
bad_origin = evidence_records()
bad_origin.insert(2, {
    'check': 'bootstrap_error', 'status': 'failed',
    'category': 'TypeError:unknown', 'origin': '/absolute/path.py:1',
})
validate_evidence(bad_origin, 1)
not_last = evidence_records()
not_last.insert(0, not_last.pop())
validate_evidence(not_last, 1)


def sanitize_evidence(records, expected_rc):
    temporary, root = workspace()
    with temporary:
        artifact = root / 'candidate.jsonl'
        artifact.write_text(''.join(json.dumps(record, separators=(',', ':')) + '\n' for record in records))
        result = subprocess.run(
            ['python3', 'infra/t01-smoke/runtime.py', 'sanitize-evidence', str(artifact)],
            cwd=root, capture_output=True, text=True, timeout=20,
        )
        assert result.returncode == expected_rc, (records, result.stdout, result.stderr)


source_record = evidence_records()[1]
sanitize_evidence([source_record, {'check': 'uv_install', 'status': 'passed'}], 0)
sanitize_evidence([
    source_record,
    {'check': 'bootstrap_error', 'status': 'failed', 'category': 'TypeError:unknown', 'origin': 'plugin_inputs.py:39'},
    {'check': 'provisioning', 'status': 'failed'},
    {'check': 'complete', 'status': 'failed'},
], 0)
sanitize_evidence([{'check': 'complete', 'status': 'passed', 'payload': 'malicious'}], 1)
sanitize_evidence([{'check': 'unknown', 'status': 'passed'}], 1)
sanitize_evidence(['not-json'], 1)
sanitize_evidence([None, *evidence_records()], 1)
validate_evidence([None, *evidence_records()], 1)
sanitize_evidence([{
    'check': 'bootstrap_error', 'status': 'failed',
    'category': 'x' * 65_537, 'origin': 'client.py:1',
}], 1)

temporary, root = workspace()
with temporary:
    mock_aws(root, '''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS"
case "$1 $2" in
  'cloudformation describe-stacks') printf 'i-test\n' ;;
  'ec2 get-console-output')
    printf 'T01_EVIDENCE {"check":"provisioning","status":"failed"}\n'
    printf 'T01_EVIDENCE {"status":"passed","check":"complete"}\n'
    ;;
esac
''')
    write_executable(root / 'bin/sleep', '''#!/usr/bin/env bash
if [ "${1:-}" = 600 ]; then
  /bin/sleep 0.01
fi
''')
    artifact_dir = root / 'artifact'
    artifact_dir.mkdir()
    (artifact_dir / 'preflight.jsonl').write_text('sentinel\n')
    result = run(root, 'collect', {'LIFETIME_MINUTES': '5', 'EVIDENCE_DIR': str(artifact_dir)})
    assert result.returncode != 0, (result.stdout, result.stderr)
    assert (artifact_dir / 'preflight.jsonl').read_text() == 'sentinel\n'


def console_rejection_case(lines):
    temporary, root = workspace()
    with temporary:
        mock_aws(root, '''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS"
case "$1 $2" in
  'cloudformation describe-stacks') printf 'i-test\n' ;;
  'ec2 get-console-output')
    while IFS= read -r line; do printf 'T01_EVIDENCE %s\n' "$line"; done < "$MOCK_CONSOLE"
    ;;
esac
''')
        (root / 'console').write_text(lines)
        write_executable(root / 'bin/sleep', '''#!/usr/bin/env bash
if [ "${1:-}" = 600 ]; then
  /bin/sleep 0.01
fi
''')
        artifact_dir = root / 'artifact'
        artifact_dir.mkdir()
        (artifact_dir / 'preflight.jsonl').write_text('sentinel\n')
        result = run(root, 'collect', {
            'LIFETIME_MINUTES': '5',
            'EVIDENCE_DIR': str(artifact_dir),
            'MOCK_CONSOLE': str(root / 'console'),
        })
        assert result.returncode != 0, (result.stdout, result.stderr)
        assert (artifact_dir / 'preflight.jsonl').read_text() == 'sentinel\n'


console_rejection_case('not-json\n')
console_rejection_case('{"check":"complete","status":"passed","unknown":"field"}\n')
console_rejection_case('{"check":"uv_install","status":"passed"}\n{"check":"uv_install","status":"passed"}\n')
console_rejection_case('{"check":"bootstrap_error","status":"failed","category":"' + 'x' * 65_537 + '","origin":"client.py:1"}\n')

temporary, root = workspace()
with temporary:
    mock_aws(root, '''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS"
case "$1 $2" in
  'cloudformation describe-stacks') printf 'i-test\n' ;;
  'ec2 get-console-output')
    printf 'RequestExpired: credentials expired\n' >&2
    exit 254
    ;;
esac
''')
    write_executable(root / 'bin/sleep', '''#!/usr/bin/env bash
if [ "${1:-}" = 600 ]; then
  /bin/sleep 0.01
fi
''')
    result = run(root, 'collect', {'LIFETIME_MINUTES': '5'})
    assert result.returncode == 254, (result.stdout, result.stderr)
    calls = (root / 'calls').read_text()
    assert 'sleep' not in calls, calls
    assert calls.count('ec2 get-console-output') == 1, calls

temporary, root = workspace()
with temporary:
    mock_aws(root, '''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS"
case "$1 $2" in
  'cloudformation describe-stacks') printf 'i-test\n' ;;
  'ec2 get-console-output')
    count=$(cat "$MOCK_CONSOLE_COUNT")
    printf '%s\n' "$((count + 1))" > "$MOCK_CONSOLE_COUNT"
    if [ "$count" -eq 0 ]; then
      printf 'ThrottlingException: rate exceeded\n' >&2
      exit 254
    fi
    while IFS= read -r line; do printf 'T01_EVIDENCE %s\n' "$line"; done < "$VALID_EVIDENCE"
    ;;
esac
''')
    (root / 'console-count').write_text('0')
    write_executable(root / 'bin/sleep', '''#!/usr/bin/env bash
if [ "${1:-}" = 600 ]; then
  /bin/sleep 0.01
fi
''')
    valid = ''.join(json.dumps(record, separators=(',', ':')) + '\n' for record in evidence_records())
    (root / 'valid.jsonl').write_text(valid)
    result = run(root, 'collect', {
        'LIFETIME_MINUTES': '5',
        'MOCK_CONSOLE_COUNT': str(root / 'console-count'),
        'VALID_EVIDENCE': str(root / 'valid.jsonl'),
    })
    assert result.returncode == 0, (result.stdout, result.stderr)
    assert (root / 'calls').read_text().count('ec2 get-console-output') == 2
