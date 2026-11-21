from copy import deepcopy
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = yaml.safe_load((ROOT / '.github/workflows/deploy.yml').read_text())
EXPECTED_TRIGGERS = {
    'push': {
        'branches': ['main'],
        'paths': [
            'src/**', 'web/**', 'infra/**', 'package*.json', 'tsconfig*.json',
            '.github/workflows/deploy.yml',
        ],
    },
    'pull_request': {'branches': ['main']},
    'workflow_dispatch': None,
}
CHECKOUT = '11d5960a326750d5838078e36cf38b85af677262'
EXPECTED_ACTIONS = [
    ('gate', 0, f'actions/checkout@{CHECKOUT}'),
    ('gate', 1, 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020'),
    ('gate', 3, 'taiki-e/install-action@25f51f6b1bf4e18876107cece836f4f77ac17c8c'),
    ('deploy', 0, f'actions/checkout@{CHECKOUT}'),
    ('deploy', 2, 'aws-actions/configure-aws-credentials@7474bc4690e29a8392af63c5b98e7449536d5c3a'),
]
MAIN_ONLY = (
    "${{ github.event_name == 'push'\n"
    "   || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') }}"
)
NOT_SKIPPED = "${{ steps.staleness.outputs.skip != 'true' }}"
DEPLOY_CONDITIONS = [
    None,
    "${{ github.event_name == 'push' }}",
    NOT_SKIPPED,
    NOT_SKIPPED,
    NOT_SKIPPED,
    NOT_SKIPPED,
    "always() && steps.staleness.outputs.skip != 'true'",
]


def validate(workflow):
    assert workflow[True] == EXPECTED_TRIGGERS
    jobs = workflow['jobs']
    assert set(jobs) == {'gate', 'deploy'}
    gate = jobs['gate']
    deploy = jobs['deploy']
    assert gate['permissions'] == {'contents': 'read'}
    assert deploy['permissions'] == {'id-token': 'write', 'contents': 'read'}
    assert deploy['needs'] == 'gate'
    assert deploy['if'] == MAIN_ONLY
    assert all('environment' not in job for job in jobs.values())

    actions = []
    for job_name, job in jobs.items():
        for index, step in enumerate(job['steps']):
            if 'uses' in step:
                actions.append((job_name, index, step['uses']))
    assert actions == EXPECTED_ACTIONS

    credentials = deploy['steps'][2]
    assert credentials['with'] == {
        'role-to-assume': '${{ secrets.HIVE_DEPLOY_ROLE_ARN }}',
        'aws-region': 'us-east-1',
    }
    assert [step.get('if') for step in deploy['steps']] == DEPLOY_CONDITIONS


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
expect_rejection((True, 'push', 'branches'), ['develop'])
expect_rejection(('jobs', 'gate', 'permissions', 'actions'), 'write')
expect_rejection(('jobs', 'deploy', 'permissions', 'id-token'), None)
expect_rejection(('jobs', 'deploy', 'needs'), '')
expect_rejection(('jobs', 'deploy', 'if'), "${{ github.event_name == 'pull_request' }}")
expect_rejection(('jobs', 'release'), {'runs-on': 'ubuntu-latest', 'steps': []})
for job_name in WORKFLOW['jobs']:
    expect_rejection(('jobs', job_name, 'environment'), 'production')
for job_name, index, uses in EXPECTED_ACTIONS:
    repository, sha = uses.split('@')
    expect_rejection(('jobs', job_name, 'steps', index, 'uses'), f'{repository}@{"0" * 40}')
    expect_rejection(('jobs', job_name, 'steps', index, 'uses'), f'untrusted/action@{sha}')
for key, value in (
    ('role-to-assume', '${{ secrets.UNREVIEWED_ROLE_ARN }}'),
    ('aws-region', 'us-west-2'),
    ('role-session-name', 'untrusted-session'),
):
    expect_rejection(('jobs', 'deploy', 'steps', 2, 'with', key), value)
for index, condition in enumerate(DEPLOY_CONDITIONS):
    if condition is not None:
        expect_rejection(('jobs', 'deploy', 'steps', index, 'if'), None)
