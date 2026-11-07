import importlib.util
import json
import subprocess

from t01_workflow_harness import ROOT, evidence_records, mock_aws, run, workspace, write_executable

spec = importlib.util.spec_from_file_location('t01_runtime', ROOT / 'infra/t01-smoke/runtime.py')
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


def classify_evidence(records, expected):
    assert runtime.classify_records(records) == expected, records


def classify_cli(records, expected):
    temporary, root = workspace()
    with temporary:
        artifact = root / 'evidence.jsonl'
        artifact.write_text(''.join(json.dumps(record, separators=(',', ':')) + '\n' for record in records))
        result = subprocess.run(
            ['python3', 'infra/t01-smoke/runtime.py', 'classify-evidence', str(artifact)],
            cwd=root, capture_output=True, text=True, timeout=20,
        )
        assert result.returncode == 0, (records, result.stdout, result.stderr)
        assert result.stdout.strip() == expected, (records, result.stdout, result.stderr)
        assert result.stderr == '', (records, result.stdout, result.stderr)


classify_evidence(evidence_records(), 'passed')
classify_evidence([{'check': 'complete', 'status': 'passed'}], 'invalid')
classify_evidence([record for record in evidence_records() if record['check'] != 'lazy_install_disabled'], 'invalid')
wrong_version = evidence_records()
wrong_version[0]['version'] = '0.0.0'
classify_evidence(wrong_version, 'invalid')
wrong_commit = evidence_records()
wrong_commit[0]['commit'] = '0' * 40
classify_evidence(wrong_commit, 'invalid')
classify_evidence(evidence_records() + [{'check': 'unapproved', 'status': 'passed'}], 'invalid')
failed_check = evidence_records()
failed_check[2]['status'] = 'failed'
classify_evidence(failed_check, 'invalid')
bootstrap_failure = evidence_records()
bootstrap_failure.insert(2, {
    'check': 'bootstrap_error', 'status': 'failed',
    'category': 'InstallError:pm-runtime', 'origin': 'client.py:212',
})
classify_evidence(bootstrap_failure, 'invalid')
bad_category = evidence_records()
bad_category.insert(2, {
    'check': 'bootstrap_error', 'status': 'failed',
    'category': 'unsafe message with spaces', 'origin': 'client.py:212',
})
classify_evidence(bad_category, 'invalid')
bad_origin = evidence_records()
bad_origin.insert(2, {
    'check': 'bootstrap_error', 'status': 'failed',
    'category': 'TypeError:unknown', 'origin': '/absolute/path.py:1',
})
classify_evidence(bad_origin, 'invalid')
not_last = evidence_records()
not_last.insert(0, not_last.pop())
classify_evidence(not_last, 'invalid')

source_record = evidence_records()[1]
classify_evidence([source_record, {'check': 'uv_install', 'status': 'passed'}], 'incomplete')
classify_evidence([
    source_record,
    {'check': 'bootstrap_error', 'status': 'failed', 'category': 'TypeError:unknown', 'origin': 'plugin_inputs.py:39'},
    {'check': 'provisioning', 'status': 'failed'},
    {'check': 'complete', 'status': 'failed'},
], 'failed')
for category in (
    'runtime-version-dependency-bootstrap-failed',
    'runtime-version-permission-denied',
    'runtime-version-missing-module',
    'runtime-version-missing-module-openai',
    'runtime-version-import-failed',
    'runtime-version-system-exit-1',
    'runtime-version-system-exit-255',
    'runtime-version-signal-1',
    'runtime-version-signal-64',
):
    classify_evidence([
        source_record,
        {'check': 'bootstrap_error', 'status': 'failed', 'category': category, 'origin': 'hermes-check:1'},
        {'check': 'provisioning', 'status': 'failed'},
        {'check': 'complete', 'status': 'failed'},
    ], 'failed')
for category in (
    'runtime-version-system-exit-0',
    'runtime-version-system-exit-256',
    'runtime-version-signal-0',
    'runtime-version-signal-65',
    'runtime-version-missing-module-unreviewed',
):
    classify_evidence([
        source_record,
        {'check': 'bootstrap_error', 'status': 'failed', 'category': category, 'origin': 'hermes-check:1'},
        {'check': 'provisioning', 'status': 'failed'},
        {'check': 'complete', 'status': 'failed'},
    ], 'invalid')
classify_evidence([{'check': 'complete', 'status': 'passed', 'payload': 'malicious'}], 'invalid')
classify_evidence([{'check': 'unknown', 'status': 'passed'}], 'invalid')
classify_evidence(['not-json'], 'invalid')
classify_evidence([None, *evidence_records()], 'invalid')
classify_cli([{
    'check': 'bootstrap_error', 'status': 'failed',
    'category': 'x' * 65_537, 'origin': 'client.py:1',
}], 'invalid')


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


def console_failure_case(lines, expected_artifact='sentinel\n'):
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
        assert 'Traceback' not in result.stderr, result.stderr
        if expected_artifact == 'sentinel\n':
            assert 'console produced rejected evidence' in result.stderr, result.stderr
        else:
            assert 'preflight failed; review only the sanitized artifact' in result.stderr, result.stderr
        assert (artifact_dir / 'preflight.jsonl').read_text() == expected_artifact


console_failure_case('not-json\n')
console_failure_case('{"check":"complete","status":"passed","unknown":"field"}\n')
console_failure_case('{"check":"uv_install","status":"passed"}\n{"check":"uv_install","status":"passed"}\n')
console_failure_case('{"check":"bootstrap_error","status":"failed","category":"' + 'x' * 65_537 + '","origin":"client.py:1"}\n')
reordered_failure = '{"status":"failed","check":"provisioning"}\n{"status":"failed","check":"complete"}\n'
console_failure_case(reordered_failure, reordered_failure)
console_failure_case('{"status":"failed","check":"complete"}\n{"status":"failed","check":"provisioning"}\n')
for record in (
    {'check': ['complete'], 'status': 'failed'},
    {'check': {'name': 'complete'}, 'status': 'failed'},
    {'check': 'complete', 'status': ['failed']},
    {'check': 'complete', 'status': {'state': 'failed'}},
):
    classify_cli([record], 'invalid')
    console_failure_case(json.dumps(record, separators=(',', ':')) + '\n')

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
