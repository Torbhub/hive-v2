from pathlib import Path
import re

import yaml


class CloudFormationLoader(yaml.SafeLoader):
    pass


def construct_tag(loader, tag_suffix, node):
    if isinstance(node, yaml.MappingNode):
        return loader.construct_mapping(node)
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node)
    return loader.construct_scalar(node)


yaml.add_multi_constructor('!', construct_tag, CloudFormationLoader)
ROOT = Path(__file__).resolve().parents[1]
bench = yaml.safe_load((ROOT / '.github/workflows/bench.yml').read_text())
template = yaml.load((ROOT / 'infra/template.yaml').read_text(), CloudFormationLoader)
t01 = yaml.safe_load((ROOT / '.github/workflows/t01-smoke.yml').read_text())
auto_merge = (ROOT / '.github/workflows/auto-merge.yml').read_text()
deploy = (ROOT / '.github/workflows/deploy.yml').read_text()

assert set(bench[True]) == {'workflow_dispatch'}
inputs = bench[True]['workflow_dispatch']['inputs']
assert set(inputs) == {'expected_main_sha'}
assert inputs['expected_main_sha']['required'] is True
assert set(bench['jobs']) == {'bench'}
job = bench['jobs']['bench']
assert job['if'] == "${{ github.ref == 'refs/heads/main' }}"
assert job['environment'] == 'role-bench'
assert job['permissions'] == {'contents': 'read', 'id-token': 'write'}
assert len(job['steps']) == 7
checkout = job['steps'][0]
assert checkout['with']['ref'] == '${{ inputs.expected_main_sha }}'
assert checkout['with']['persist-credentials'] is False
verification = job['steps'][1]['run']
for required in ('^[0-9a-f]{40}$', 'git rev-parse HEAD', 'git cat-file -e', 'commits/main'):
    assert required in verification
bench_run = job['steps'][5]['run']
assert 'for role in roles/*;' in bench_run
assert 'GH_TOKEN' not in job['steps'][5].get('env', {})
serialized = yaml.safe_dump(bench)
for forbidden in ('pull_request', 'candidate', 'refs/pull/', 'pr_number', 'bench-admission'):
    assert forbidden not in serialized
for item in job['steps']:
    if 'uses' in item:
        assert re.fullmatch(r'[0-9a-f]{40}', item['uses'].split('@')[1])

resources = template['Resources']
deploy_statements = resources['DeployRole']['Properties']['AssumeRolePolicyDocument']['Statement']
assert len(deploy_statements) == 2
assert [statement['Condition'] for statement in deploy_statements] == [
    {'StringEquals': {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': '${GithubSubjectPrefix}:ref:refs/heads/main',
    }},
    {'StringEquals': {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:ref': 'refs/heads/main',
        'token.actions.githubusercontent.com:sub': '${GithubSubjectPrefix}:environment:t01-smoke',
    }},
]
bench_condition = resources['BenchRole']['Properties']['AssumeRolePolicyDocument']['Statement'][0]['Condition']
assert bench_condition == {'StringEquals': {
    'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
    'token.actions.githubusercontent.com:ref': 'refs/heads/main',
    'token.actions.githubusercontent.com:sub': '${GithubSubjectPrefix}:environment:role-bench',
}}
policy = resources['DeployRole']['Properties']['Policies'][0]['PolicyDocument']['Statement']
manage_roles = next(statement for statement in policy if statement['Sid'] == 'ManageHiveRoles')
assert 'iam:UpdateAssumeRolePolicy' in manage_roles['Action']

preflight = t01['jobs']['preflight']
assert preflight['environment'] == 't01-smoke'
proxy = next(item for item in preflight['steps'] if item.get('id') == 'proxy')
assert proxy['env']['TEAMKIMI_PROXY_KEY'] == '${{ secrets.TEAMKIMI_PROXY_KEY }}'
for t01_job in t01['jobs'].values():
    for item in t01_job['steps']:
        if item.get('with', {}).get('role-to-assume') == '${{ secrets.HIVE_DEPLOY_ROLE_ARN }}':
            assert t01_job['environment'] == 't01-smoke'
assert 'docs/*|rules/*|skills/*|README.md|AGENTS.md) ;;' in auto_merge
assert 'infra/*|src/*|roles/*) PROSE_DENY=1;;' in auto_merge
assert 'python3 test/bench_workflow_checks.py' in deploy
