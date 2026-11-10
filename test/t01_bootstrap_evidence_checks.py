import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

from t01_workflow_harness import ROOT, write_executable

PROVISION = (ROOT / 'infra/t01-smoke/provision.sh').read_text()


def assert_failed_console(console, stage, status):
    prefix = 'T01_EVIDENCE '
    lines = console.splitlines()
    assert all(line.startswith(prefix) for line in lines), lines
    records = [json.loads(line[len(prefix):]) for line in lines]
    assert records == [
        {
            'check': 'bootstrap_error', 'status': 'failed',
            'category': f'failure:{stage}', 'origin': f'{stage}:{status}',
        },
        {'check': 'provisioning', 'status': 'failed'},
        {'check': 'complete', 'status': 'failed'},
    ], records
    with tempfile.TemporaryDirectory() as directory:
        artifact = Path(directory) / 'evidence.jsonl'
        artifact.write_text(''.join(json.dumps(record) + '\n' for record in records))
        result = subprocess.run(
            ['python3', str(ROOT / 'infra/t01-smoke/runtime.py'), 'classify-evidence', str(artifact)],
            capture_output=True, text=True, timeout=5,
        )
        assert result.returncode == 0 and result.stdout.strip() == 'failed', (result.stdout, result.stderr)


def early_provision_case():
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        bin_dir = root / 'bin'
        bin_dir.mkdir()
        for name in ('chown', 'iptables', 'ip6tables'):
            write_executable(bin_dir / name, '#!/usr/bin/env bash\nexit 0\n')
        write_executable(bin_dir / 'shutdown', '#!/usr/bin/env bash\nexit 17\n')
        source = PROVISION.split('BOOTSTRAP_STAGE=input-validation', 1)[0]
        for absolute in ('/opt/t01', '/var/lib/t01', '/etc/t01'):
            source = source.replace(absolute, str(root / absolute.removeprefix('/')))
        source = source.replace('> /dev/console', f'>> {root / "console"}')
        script = root / 'provision-init.sh'
        script.write_text(source)
        result = subprocess.run(
            ['bash', str(script)],
            env={
                'PATH': f'{bin_dir}:{os.environ["PATH"]}',
                'SCENARIO': 'preflight', 'LIFETIME_MINUTES': '120',
            },
            capture_output=True, text=True, timeout=5,
        )
        for relative in ('opt/t01/runner-source', 'opt/t01/node', 'var/lib/t01/workspace'):
            assert (root / relative).is_dir(), relative
        console = root / 'console'
        return result, console.read_text() if console.exists() else ''


result, console = early_provision_case()
assert result.returncode == 1, (result.stdout, result.stderr)
assert console, (result.stdout, result.stderr)
assert_failed_console(console, 'filesystem-init', 17)


TEMPLATE_SOURCE = (ROOT / 'infra/t01-smoke/template.yaml').read_text()
USER_DATA = TEMPLATE_SOURCE.split('Fn::Base64: !Sub |\n', 1)[1].split('\n      Tags:', 1)[0]
USER_DATA = '\n'.join(line.removeprefix('          ') for line in USER_DATA.splitlines()) + '\n'


def user_data_case(download_rc):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        bin_dir = root / 'bin'
        bin_dir.mkdir()
        write_executable(bin_dir / 'shutdown', '#!/usr/bin/env bash\nexit 0\n')
        write_executable(bin_dir / 'sha256sum', '#!/usr/bin/env bash\nexit 0\n')
        inner_console = root / 'inner-console'
        inner_console.write_text(
            'T01_EVIDENCE {"check":"bootstrap_error","status":"failed","category":"failure:inner-provision","origin":"inner-provision:9"}\n'
            'T01_EVIDENCE {"check":"provisioning","status":"failed"}\n'
            'T01_EVIDENCE {"check":"complete","status":"failed"}\n'
        )
        inner = root / 'inner.sh'
        inner.write_text('#!/usr/bin/env bash\ncp "$MOCK_INNER_CONSOLE" "$MOCK_CONSOLE"\nexit 1\n')
        write_executable(bin_dir / 'curl', '''#!/usr/bin/env bash
if [ "$MOCK_DOWNLOAD_RC" != 0 ]; then
  exit "$MOCK_DOWNLOAD_RC"
fi
output=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then
    output="$2"
    shift 2
  else
    shift
  fi
done
cp "$MOCK_INNER" "$output"
''')
        source = re.sub(r'\$\{[A-Za-z0-9]+\}', '120', USER_DATA)
        source = source.replace('/opt/t01-provision.sh', str(root / 'provision.sh'))
        source = source.replace('> /dev/console', f'>> {root / "console"}')
        script = root / 'user-data.sh'
        script.write_text(source)
        result = subprocess.run(
            ['bash', str(script)],
            env={
                'PATH': f'{bin_dir}:{os.environ["PATH"]}',
                'MOCK_DOWNLOAD_RC': str(download_rc), 'MOCK_INNER': str(inner),
                'MOCK_INNER_CONSOLE': str(inner_console), 'MOCK_CONSOLE': str(root / 'console'),
            },
            capture_output=True, text=True, timeout=5,
        )
        console = root / 'console'
        return result, console.read_text() if console.exists() else ''


result, console = user_data_case(22)
assert result.returncode == 1, (result.stdout, result.stderr)
assert_failed_console(console, 'userdata-bootstrap', 22)
result, console = user_data_case(0)
assert result.returncode == 1, (result.stdout, result.stderr)
assert_failed_console(console, 'inner-provision', 9)
