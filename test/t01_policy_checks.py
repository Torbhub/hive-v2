import fnmatch
from pathlib import Path

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
TEMPLATE = yaml.load((ROOT / 'infra/template.yaml').read_text(), CloudFormationLoader)
ROLE = TEMPLATE['Resources']['T01SmokeRole']
STATEMENTS = ROLE['Properties']['Policies'][0]['PolicyDocument']['Statement']


def action_matches(statement, action):
    actions = statement['Action']
    if isinstance(actions, str):
        actions = [actions]
    return any(fnmatch.fnmatchcase(action, candidate) for candidate in actions)


def resource_matches(statement, resource):
    resources = statement['Resource']
    if isinstance(resources, str):
        resources = [resources]
    return any(fnmatch.fnmatchcase(resource, candidate) for candidate in resources)


def allows(action, resource, **context):
    for statement in STATEMENTS:
        if statement['Effect'] != 'Allow':
            continue
        if not action_matches(statement, action) or not resource_matches(statement, resource):
            continue
        conditions = statement.get('Condition', {})
        matched = True
        for entries in conditions.values():
            for key, expected in entries.items():
                if context.get(key) != expected:
                    matched = False
        if matched:
            return True
    return False


INSTANCE = 'arn:aws:ec2:us-east-1:594552273052:instance/i-preexisting'
SECURITY_GROUP = 'arn:aws:ec2:us-east-1:594552273052:security-group/sg-new'
ROLE_TAG = {'aws:RequestTag/Role': 'hive-v2-t01-smoke'}

assert not allows('ec2:CreateTags', INSTANCE, **ROLE_TAG), 'an existing instance can be tagged arbitrarily'
assert not allows('ec2:TerminateInstances', INSTANCE), 'an untagged preexisting instance can be terminated'
assert not allows('ec2:ModifyInstanceAttribute', INSTANCE, **{'aws:ResourceTag/Role': 'hive-v2-t01-smoke'})
assert not allows('ec2:DeleteTags', INSTANCE, **ROLE_TAG)
assert allows(
    'ec2:CreateTags', INSTANCE, **ROLE_TAG,
    **{'ec2:CreateAction': 'RunInstances'},
), 'RunInstances tag-on-create must remain allowed'
assert not allows(
    'ec2:CreateTags', INSTANCE, **ROLE_TAG,
    **{'ec2:CreateAction': 'CreateSecurityGroup'},
), 'security-group creation can tag an instance'
assert allows(
    'ec2:CreateTags', SECURITY_GROUP, **ROLE_TAG,
    **{'ec2:CreateAction': 'CreateSecurityGroup'},
), 'security-group tag-on-create must remain allowed'
assert allows(
    'ec2:TerminateInstances', INSTANCE,
    **{'aws:ResourceTag/Role': 'hive-v2-t01-smoke'},
), 'the disposable instance must remain terminable'
