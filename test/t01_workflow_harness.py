import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / 'infra/t01-smoke/workflow.sh'
RUNTIME = ROOT / 'infra/t01-smoke/runtime.py'
PROVISION = ROOT / 'infra/t01-smoke/provision.sh'
SMOKE_TEMPLATE = ROOT / 'infra/t01-smoke/template.yaml'
COMMIT = 'f0d94882e89ab8d4098b5bb2f166adfb9ee0a0ab'
MANDATORY_PASSED = [
    'uv_install', 'python_install', 'frozen_hash_lock_install',
    'node_runtime_locked', 'runner_dependencies_locked',
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
    next(record for record in records if record['check'] == 'node_runtime_locked')['version'] = '22.23.2'
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
    shutil.copy(RUNTIME, root / 'infra/t01-smoke/runtime.py')
    for template in (PROVISION, SMOKE_TEMPLATE):
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
    /bin/sleep 0.05
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
        capture_output=True, text=True, timeout=30,
    )


def mock_aws(root, content):
    write_executable(root / 'bin/aws', content)
