from copy import deepcopy
from pathlib import Path
import re

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = yaml.safe_load((ROOT / '.github/workflows/shrink-anything.yml').read_text())
CHECKOUT = 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262'
SETUP_NODE = 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020'
UPLOAD = 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02'
CREATE_PR = 'peter-evans/create-pull-request@22a9089034f40e5a961c8808d113e2c98fb63676'
PACKAGE = '@el4cteo/shrink-anything@0.1.0'


def validate(workflow):
    assert set(workflow[True]) == {'workflow_dispatch'}
    inputs = workflow[True]['workflow_dispatch']['inputs']
    assert set(inputs) == {'repository', 'base_branch', 'target_sha', 'setup_command', 'check_command'}
    for name in ('repository', 'base_branch', 'target_sha', 'check_command'):
        assert inputs[name]['required'] is True
    assert inputs['setup_command']['required'] is False
    assert workflow['permissions'] == {}
    assert workflow['concurrency'] == {
        'group': 'shrink-anything-${{ inputs.repository }}',
        'cancel-in-progress': False,
    }
    assert set(workflow['jobs']) == {'shrink'}
    job = workflow['jobs']['shrink']
    assert job['if'] == "${{ github.ref == 'refs/heads/main' }}"
    assert job['environment'] == 'shrink-anything'
    assert job['runs-on'] == 'ubuntu-latest'
    assert job['permissions'] == {}
    assert job['timeout-minutes'] == 120

    steps = job['steps']
    actions = [step['uses'] for step in steps if 'uses' in step]
    assert actions == [CHECKOUT, SETUP_NODE, UPLOAD, CREATE_PR]
    for action in actions:
        assert re.fullmatch(r'[0-9a-f]{40}', action.split('@')[1])

    checkout = steps[0]
    assert checkout['with'] == {
        'repository': '${{ inputs.repository }}',
        'ref': '${{ inputs.target_sha }}',
        'token': '${{ secrets.SHRINK_ANYTHING_TOKEN }}',
        'persist-credentials': False,
    }
    validation = steps[1]['run']
    assert steps[1]['env']['GH_TOKEN'] == '${{ secrets.SHRINK_ANYTHING_TOKEN }}'
    for required in ('git check-ref-format --branch', 'git rev-parse HEAD', 'gh api', 'EXPECTED_TARGET_SHA', 'BASE_HEAD'):
        assert required in validation
    assert steps[2]['with'] == {'node-version': 22}

    setup = steps[3]
    assert setup['if'] == "${{ inputs.setup_command != '' }}"
    assert setup['env']['SETUP_COMMAND'] == '${{ inputs.setup_command }}'
    assert setup['run'] == 'bash -euo pipefail -c "$SETUP_COMMAND"'

    shrink = steps[4]
    assert shrink['env']['TARGET_CHECK'] == '${{ inputs.check_command }}'
    assert shrink['run'].count(PACKAGE) == 3
    for required in ('go -- "$TARGET_CHECK"', 'shrink-anything verify', 'shrink-anything report', '.shrink/report.md', '.shrink/report.svg'):
        assert required in shrink['run']
    assert 'github.com/EL4CTEO' not in yaml.safe_dump(workflow)

    upload = steps[5]
    assert upload['if'] == 'always()'
    assert upload['with']['path'] == '.shrink/report.md\n.shrink/report.svg\n.shrink/TASK.md\n'
    assert upload['with']['if-no-files-found'] == 'warn'
    assert upload['with']['retention-days'] == 14

    create = steps[6]
    assert create['with']['token'] == '${{ secrets.SHRINK_ANYTHING_TOKEN }}'
    assert create['with']['base'] == '${{ inputs.base_branch }}'
    assert create['with']['branch'] == 'shrink-anything/${{ github.run_id }}'
    assert create['with']['delete-branch'] is True
    assert ':(exclude).shrink/**' in create['with']['add-paths']
    for step in steps:
        if 'run' in step:
            assert '${{ inputs.' not in step['run']


def expect_rejection(path, value):
    workflow = deepcopy(WORKFLOW)
    target = workflow
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    try:
        validate(workflow)
    except AssertionError:
        return
    raise AssertionError(f'accepted faulty mutation: {path}')


validate(WORKFLOW)
expect_rejection((True, 'pull_request_target'), {})
expect_rejection(('permissions', 'contents'), 'write')
expect_rejection(('jobs', 'shrink', 'environment'), None)
expect_rejection(('jobs', 'shrink', 'if'), "${{ github.event_name == 'workflow_dispatch' }}")
expect_rejection(('jobs', 'shrink', 'permissions', 'contents'), 'write')
expect_rejection(('jobs', 'shrink', 'steps', 0, 'with', 'persist-credentials'), True)
expect_rejection(('jobs', 'shrink', 'steps', 0, 'uses'), 'actions/checkout@v4')
expect_rejection(('jobs', 'shrink', 'steps', 4, 'run'), WORKFLOW['jobs']['shrink']['steps'][4]['run'].replace(PACKAGE, '@el4cteo/shrink-anything@latest'))
expect_rejection(('jobs', 'shrink', 'steps', 5, 'with', 'path'), '.shrink/report.md')
expect_rejection(('jobs', 'shrink', 'steps', 6, 'with', 'token'), '${{ github.token }}')
