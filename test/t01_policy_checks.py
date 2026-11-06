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
DEPLOY_STATEMENTS = TEMPLATE['Resources']['DeployRole']['Properties']['Policies'][0]['PolicyDocument']['Statement']


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
assert not allows('ec2:RevokeSecurityGroupEgress', SECURITY_GROUP)
assert allows(
    'ec2:RevokeSecurityGroupEgress', SECURITY_GROUP,
    **{'aws:ResourceTag/Role': 'hive-v2-t01-smoke'},
), 'CloudFormation must remove the default egress from its own security group'
MUTEX_TABLE = 'arn:aws:dynamodb:us-east-1:594552273052:table/citadel-deploy-mutex'
assert allows('dynamodb:UpdateItem', MUTEX_TABLE), 'owner-only renewal requires UpdateItem'
BROKER_STACK = 'arn:aws:cloudformation:us-east-1:594552273052:stack/hive-v2-t01-broker/*'
HEALTH_FUNCTION = 'arn:aws:lambda:us-east-1:594552273052:function:hive-v2-t01-broker-health'
HEALTH_SECRET = 'arn:aws:secretsmanager:us-east-1:594552273052:secret:hive-v2-t01-smoke-health-123-AbCdEf'
BROKER_ROLE = 'arn:aws:iam::594552273052:role/hive-v2-t01-broker-health'
assert allows('cloudformation:DeleteStack', BROKER_STACK)
assert allows('lambda:CreateFunction', HEALTH_FUNCTION)
assert not allows('lambda:CreateFunction', HEALTH_FUNCTION + '-other')
assert allows('secretsmanager:CreateSecret', HEALTH_SECRET)
assert allows('secretsmanager:DeleteSecret', HEALTH_SECRET)
assert not allows('secretsmanager:DeleteSecret', HEALTH_SECRET.replace('health-', 'other-'))
assert allows('iam:PassRole', BROKER_ROLE, **{'iam:PassedToService': 'lambda.amazonaws.com'})
assert not allows('iam:PassRole', BROKER_ROLE, **{'iam:PassedToService': 'ec2.amazonaws.com'})


def deploy_allows(action, resource):
    return any(
        statement['Effect'] == 'Allow' and action_matches(statement, action)
        and resource_matches(statement, resource)
        for statement in DEPLOY_STATEMENTS
    )


INFRA_STACK = 'arn:aws:cloudformation:us-east-1:594552273052:stack/hive-v2-infra/*'
SMOKE_ROLE = 'arn:aws:iam::594552273052:role/hive-v2-gh-t01-smoke'
assert deploy_allows('cloudformation:ContinueUpdateRollback', INFRA_STACK)
assert not deploy_allows('cloudformation:ContinueUpdateRollback', BROKER_STACK)
assert deploy_allows('iam:UpdateRoleDescription', SMOKE_ROLE)
assert not deploy_allows('iam:UpdateRoleDescription', 'arn:aws:iam::594552273052:role/other-role')

SMOKE_PATH = ROOT / 'infra/t01-smoke/template.yaml'
BROKER_PATH = ROOT / 'infra/t01-smoke/broker_template.yaml'
SMOKE_TEMPLATE = yaml.load(SMOKE_PATH.read_text(), CloudFormationLoader)
BROKER_TEMPLATE = yaml.load(BROKER_PATH.read_text(), CloudFormationLoader)
for template in (TEMPLATE, SMOKE_TEMPLATE, BROKER_TEMPLATE):
    metadata = template['Metadata']
    assert metadata['AWSToolsMetrics']['AWSAgentToolkit'] == 'aws-cloudformation@3'
    assert metadata['com.aws.cloudformation.Context']
for path in (ROOT / 'infra/template.yaml', SMOKE_PATH, BROKER_PATH):
    assert path.stat().st_size < 51_200, f'{path} exceeds the inline template limit'
for resource_name in ('InstanceRole', 'InstanceProfile', 'SecurityGroup', 'Instance'):
    context = SMOKE_TEMPLATE['Resources'][resource_name]['Metadata']['com.aws.cloudformation.Context']
    assert context['why'].strip(), resource_name
    assert context['must'], resource_name
for resource_name in ('HealthRole', 'HealthFunction', 'HealthUrl', 'HealthUrlPermission'):
    context = BROKER_TEMPLATE['Resources'][resource_name]['Metadata']['com.aws.cloudformation.Context']
    assert context['why'].strip(), resource_name
    assert context['must'], resource_name
health_policy = BROKER_TEMPLATE['Resources']['HealthRole']['Properties']['Policies'][0]['PolicyDocument']['Statement']
assert health_policy[0]['Action'] == 'secretsmanager:GetSecretValue'
assert health_policy[0]['Resource'] == 'SecretArn'
role_context = TEMPLATE['Resources']['T01SmokeRole']['Metadata']['com.aws.cloudformation.Context']
assert role_context['why'].strip()
assert role_context['must']
