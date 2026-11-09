import hashlib
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


def classify_with_reason(records, expected_classification, expected_reason):
    assert runtime.classify_records_with_reason(records) == (expected_classification, expected_reason), records


classify_with_reason([{'check': 'sensitive-check-name', 'status': 'passed'}], 'invalid', 'bad-schema:unknown:check')
duplicate_check = evidence_records()
duplicate_check.insert(1, duplicate_check[0])
classify_with_reason(duplicate_check, 'invalid', 'duplicate-check')
classify_with_reason(evidence_records()[:-1], 'incomplete', 'missing-complete')
wrong_record_set = [record for record in evidence_records() if record['check'] != 'lazy_install_disabled']
classify_with_reason(wrong_record_set, 'invalid', 'wrong-record-set')
classify_with_reason([
    source_record,
    {'check': 'bootstrap_error', 'status': 'failed', 'category': 'TypeError:unknown', 'origin': 'plugin_inputs.py:39'},
    {'check': 'provisioning', 'status': 'failed'},
    {'check': 'complete', 'status': 'failed'},
], 'failed', 'completion-failed')
classify_with_reason(evidence_records(), 'passed', 'none')


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


def console_failure_case(lines, expected_artifact='sentinel\n', expected_reason='bad-schema'):
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
        assert 'synthetic-sensitive-value' not in result.stdout + result.stderr
        if expected_artifact == 'sentinel\n':
            assert f'console produced rejected evidence; reason={expected_reason}; it was not copied to the artifact' in result.stderr, result.stderr
        else:
            assert f'preflight failed; reason={expected_reason}; review only the sanitized artifact' in result.stderr, result.stderr
        assert (artifact_dir / 'preflight.jsonl').read_text() == expected_artifact


console_failure_case('not-json\n')
console_failure_case(
    '{"check":"complete","status":"passed","unknown":"synthetic-sensitive-value"}\n',
    expected_reason='bad-schema:complete:record',
)
console_failure_case(
    '{"check":"uv_install","status":"passed"}\n{"check":"uv_install","status":"passed"}\n',
    expected_reason='duplicate-check',
)
console_failure_case('{"check":"bootstrap_error","status":"failed","category":"' + 'x' * 65_537 + '","origin":"client.py:1"}\n')
reordered_failure = '{"status":"failed","check":"provisioning"}\n{"status":"failed","check":"complete"}\n'
console_failure_case(reordered_failure, reordered_failure, 'completion-failed')
teamkimi_failure = [
    source_record,
    {'check': 'teamkimi_no_model', 'status': 'failed'},
    {
        'check': 'bootstrap_error', 'status': 'failed',
        'category': 'failure:teamkimi-no-model', 'origin': 'teamkimi-no-model:1',
    },
    {'check': 'provisioning', 'status': 'failed'},
    {'check': 'complete', 'status': 'failed'},
]
classify_with_reason(teamkimi_failure, 'failed', 'completion-failed')
classify_with_reason(
    [source_record, {'check': 'teamkimi_no_model', 'status': 'passed'}],
    'incomplete', 'missing-complete',
)
for record in evidence_records():
    failed_record = {**record, 'status': 'failed'}
    assert runtime.valid_record(failed_record), failed_record
teamkimi_console = ''.join(json.dumps(record, separators=(',', ':')) + '\n' for record in teamkimi_failure)
console_failure_case(teamkimi_console, teamkimi_console, 'completion-failed')
console_failure_case(
    '{"status":"failed","check":"complete"}\n{"status":"failed","check":"provisioning"}\n',
    expected_reason='wrong-record-set',
)
for record, expected_reason in (
    ({'check': ['complete'], 'status': 'failed'}, 'bad-schema:unknown:record'),
    ({'check': {'name': 'complete'}, 'status': 'failed'}, 'bad-schema:unknown:record'),
    ({'check': 'complete', 'status': ['failed']}, 'bad-schema:complete:record'),
    ({'check': 'complete', 'status': {'state': 'failed'}}, 'bad-schema:complete:record'),
):
    classify_cli([record], 'invalid')
    console_failure_case(json.dumps(record, separators=(',', ':')) + '\n', expected_reason=expected_reason)


incomplete_records = [source_record, {'check': 'uv_install', 'status': 'passed'}]
incomplete = ''.join(json.dumps(record, separators=(',', ':')) + '\n' for record in incomplete_records)
temporary, root = workspace()
with temporary:
    mock_aws(root, '''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS"
case "$1 $2" in
  'cloudformation describe-stacks') printf 'i-test\n' ;;
  'ec2 get-console-output')
    printf 'synthetic-sensitive-value\n'
    while IFS= read -r line; do printf 'T01_EVIDENCE %s\n' "$line"; done < "$MOCK_CONSOLE"
    ;;
esac
''')
    (root / 'console').write_text(incomplete)
    write_executable(root / 'bin/sleep', '#!/usr/bin/env bash\nexit 0\n')
    artifact_dir = root / 'artifact'
    artifact_dir.mkdir()
    (artifact_dir / 'preflight.jsonl').write_text('sentinel\n')
    result = run(root, 'collect', {
        'LIFETIME_MINUTES': '5',
        'EVIDENCE_DIR': str(artifact_dir),
        'MOCK_CONSOLE': str(root / 'console'),
    })
    assert result.returncode == 1, (result.stdout, result.stderr)
    assert 'preflight did not complete before the lifetime deadline; reason=missing-complete' in result.stderr, result.stderr
    assert 'synthetic-sensitive-value' not in result.stdout + result.stderr
    assert (artifact_dir / 'preflight.jsonl').read_text() == incomplete
    assert (root / 'calls').read_text().count('ec2 get-console-output') == 10


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


def paid_console_records(manifest_sha, marker=True):
    records = [record for record in evidence_records() if record['check'] != 'paid_admission_disabled']
    complete = records.pop()
    for check in (
        'trusted_tunnel_ready', 'teamkimi_control_port', 'teamkimi_control_broker',
        'teamkimi_messages_rejected', 'tunnel_cleanup',
    ):
        records.append({'check': check, 'status': 'passed'})
    records.append({
        'check': 'count_only_no_generation', 'status': 'passed', 'sha256': 'a' * 64,
        'requestHash': 'b' * 64, 'model': 'kimi-code/k3.1-pro',
        'inputTokens': 10, 'baseInputTokens': 2, 'cacheReadInputTokens': 3,
        'cacheCreationInputTokens': 5, 'cacheCreation5mInputTokens': 1, 'cacheCreation1hInputTokens': 4,
        'generationRequests': 0, 'timestamp': 1, 'revokedAt': 1, 'proof': 'c' * 64,
    })
    if marker:
        records.append({
            'check': 'paid_evidence_export', 'status': 'passed', 'sha256': manifest_sha,
            'credentialId': '0123456789abcdef0123456789abcdef',
        })
    records.append({'check': 'paid_matrix_completed', 'status': 'passed', 'policyHash': 'd' * 64})
    records.append(complete)
    return records


classify_with_reason([None], 'invalid', 'bad-schema:unknown:record')
classify_with_reason([{'check': 'uv_install', 'status': 'pending'}], 'invalid', 'bad-schema:uv_install:status')
classify_with_reason(
    [{'check': 'uv_install', 'status': 'passed', 'version': 'unexpected'}],
    'invalid', 'bad-schema:uv_install:fields',
)
for record, expected_reason in (
    (
        {'check': 'bootstrap_error', 'status': 'failed', 'category': 'TypeError:unknown'},
        'bad-schema:bootstrap_error:fields',
    ),
    (
        {'check': 'bootstrap_error', 'status': 'failed', 'category': 'unsafe message', 'origin': 'client.py:1'},
        'bad-schema:bootstrap_error:category',
    ),
    (
        {'check': 'bootstrap_error', 'status': 'failed', 'category': 'TypeError:unknown', 'origin': '/secret/path:1'},
        'bad-schema:bootstrap_error:origin',
    ),
    (
        {'check': 'source_sha256', 'status': 'passed', 'sha256': '0' * 64},
        'bad-schema:source_sha256:identity',
    ),
    (
        {'check': 'node_runtime_locked', 'status': 'passed', 'version': '0.0.0'},
        'bad-schema:node_runtime_locked:identity',
    ),
    (
        {'check': 'paid_evidence_export', 'status': 'passed', 'sha256': 'invalid', 'credentialId': '0' * 32},
        'bad-schema:paid_evidence_export:fields',
    ),
    (
        {'check': 'paid_matrix_completed', 'status': 'passed', 'policyHash': 'invalid'},
        'bad-schema:paid_matrix_completed:fields',
    ),
):
    classify_with_reason([record], 'invalid', expected_reason)
wrong_version = evidence_records()[0]
wrong_version['version'] = '0.0.0'
classify_with_reason([wrong_version], 'invalid', 'bad-schema:hermes_version:identity')

bad_count_schema = paid_console_records('a' * 64)
next(record for record in bad_count_schema if record['check'] == 'count_only_no_generation')['sha256'] = ['not-a-string']
classify_with_reason(bad_count_schema, 'invalid', 'bad-schema:count_only_no_generation:fields')
for field, value in (('cacheCreation5mInputTokens', 2), ('inputTokens', 11)):
    bad_count_input = paid_console_records('a' * 64)
    next(record for record in bad_count_input if record['check'] == 'count_only_no_generation')[field] = value
    classify_with_reason(bad_count_input, 'invalid', 'bad-schema:count_only_no_generation:count-input')


def paid_collect_case(manifest_sha='match', verify_rc=0):
    temporary, root = workspace()
    with temporary:
        manifest = root / 'manifest.json'
        manifest.write_bytes(b'{"state":"completed"}\n')
        actual_sha = hashlib.sha256(manifest.read_bytes()).hexdigest()
        marker_sha = actual_sha if manifest_sha == 'match' else manifest_sha
        marker = manifest_sha != 'missing'
        valid = ''.join(json.dumps(record, separators=(',', ':')) + '\n' for record in paid_console_records(marker_sha, marker))
        (root / 'valid.jsonl').write_text(valid)
        mock_aws(root, '''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS"
case "$1 $2" in
  'cloudformation describe-stacks') printf 'i-test\n' ;;
  'ec2 get-console-output')
    while IFS= read -r line; do printf 'T01_EVIDENCE %s\n' "$line"; done < "$VALID_EVIDENCE"
    ;;
  's3 cp')
    mkdir -p "$4"
    cp "$MOCK_MANIFEST" "$4/manifest.json"
    ;;
esac
''')
        write_executable(root / 'bin/node', '''#!/usr/bin/env bash
printf 'external-verify\n' >> "$MOCK_CALLS"
exit "${MOCK_VERIFY_RC:-0}"
''')
        write_executable(root / 'bin/sleep', '''#!/usr/bin/env bash
if [ "${1:-}" = 600 ]; then
  /bin/sleep 0.01
fi
''')
        result = run(root, 'collect', {
            'LIFETIME_MINUTES': '5', 'SCENARIO': 'matrix',
            'PRICING_ATTESTATION': '{}', 'EXPECTED_POLICY_HASH': 'd' * 64,
            'VALID_EVIDENCE': str(root / 'valid.jsonl'), 'MOCK_MANIFEST': str(manifest),
            'MOCK_VERIFY_RC': str(verify_rc),
        })
        return result, (root / 'calls').read_text()


result, calls = paid_collect_case(verify_rc=1)
assert result.returncode != 0, (result.stdout, result.stderr)
assert 'external-verify' in calls and 's3 rm' not in calls, calls
result, calls = paid_collect_case(manifest_sha='0' * 64)
assert result.returncode != 0, 'a manifest hash mismatch was accepted'
assert 'external-verify' not in calls and 's3 rm' not in calls, calls
result, calls = paid_collect_case(manifest_sha='missing')
assert result.returncode != 0, 'a missing manifest marker was accepted'
assert 'external-verify' not in calls and 's3 rm' not in calls, calls
result, calls = paid_collect_case()
assert result.returncode == 0, (result.stdout, result.stderr)
assert 'external-verify' in calls and 's3 rm' not in calls, calls

temporary, root = workspace()
with temporary:
    result = run(root, 'cleanup', {'SCENARIO': 'matrix', 'PAID_EVIDENCE_VERIFIED': 'no'})
    assert result.returncode != 0, (result.stdout, result.stderr)
    calls = (root / 'calls').read_text() if (root / 'calls').exists() else ''
    assert 'delete-stack' not in calls and 'delete-secret' not in calls and 's3 rm' not in calls, calls
    assert 'release aws-acts' not in calls, calls

def proxy_cleanup_case(delete_rc):
    temporary, root = workspace()
    with temporary:
        artifact = root / 'artifact'
        artifact.mkdir()
        valid = ''.join(json.dumps(record, separators=(',', ':')) + '\n' for record in paid_console_records('a' * 64))
        (artifact / 'preflight.jsonl').write_text(valid)
        mock_aws(root, '''#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS"
case "$1 $2" in
  'cloudformation describe-stacks')
    printf 'ValidationError: Stack with id hive-v2-t01-smoke does not exist\n' >&2
    exit 254
    ;;
  'secretsmanager describe-secret')
    if [[ "$*" = *proxy* ]]; then
      count=$(grep -c 'describe-secret.*proxy' "$MOCK_CALLS" || true)
      if [ "$count" -gt 1 ]; then
        printf 'ResourceNotFoundException: secret not found\n' >&2
        exit 254
      fi
      exit 0
    fi
    printf 'ResourceNotFoundException: secret not found\n' >&2
    exit 254
    ;;
  'secretsmanager delete-secret') exit "${MOCK_PROXY_DELETE_RC:-0}" ;;
esac
''')
        result = run(root, 'cleanup', {
            'SCENARIO': 'matrix', 'PAID_EVIDENCE_VERIFIED': 'yes', 'EVIDENCE_DIR': str(artifact),
            'MOCK_PROXY_DELETE_RC': str(delete_rc),
        })
        return result, (root / 'calls').read_text()


result, calls = proxy_cleanup_case(0)
assert result.returncode == 0, (result.stdout, result.stderr)
assert calls.count('s3 rm') == 1, calls
assert 'delete-secret --secret-id hive-v2-t01-smoke-proxy-123 --force-delete-without-recovery' in calls, calls
assert 'release aws-acts hive-v2-t01-smoke/123' in calls, calls
result, calls = proxy_cleanup_case(17)
assert result.returncode != 0, (result.stdout, result.stderr)
assert 'delete-secret --secret-id hive-v2-t01-smoke-proxy-123 --force-delete-without-recovery' in calls, calls
assert 'release aws-acts' not in calls, calls
assert 'synthetic-proxy-secret' not in result.stdout + result.stderr
