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


def allows(action, resource, statements=STATEMENTS, **context):
    for statement in statements:
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
NETWORK_INTERFACE = 'arn:aws:ec2:us-east-1:594552273052:network-interface/eni-new'
VOLUME = 'arn:aws:ec2:us-east-1:594552273052:volume/vol-new'
SUBNET = 'arn:aws:ec2:us-east-1:594552273052:subnet/subnet-new'
IMAGE = 'arn:aws:ec2:us-east-1::image/ami-new'
ROLE_TAG = {'aws:RequestTag/Role': 'hive-v2-t01-smoke'}

assert not allows('ec2:RunInstances', INSTANCE), 'instance creation requires the T01 request tag'
assert allows('ec2:RunInstances', INSTANCE, **ROLE_TAG)
for resource in (NETWORK_INTERFACE, VOLUME, SECURITY_GROUP, SUBNET, IMAGE):
    assert allows('ec2:RunInstances', resource), f'RunInstances must support {resource}'
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
OTHER_STACK = 'arn:aws:cloudformation:us-east-1:594552273052:stack/other/*'
HEALTH_SECRET = 'arn:aws:secretsmanager:us-east-1:594552273052:secret:hive-v2-t01-smoke-health-123-AbCdEf'
assert not allows('cloudformation:DeleteStack', OTHER_STACK)
assert not allows('lambda:CreateFunction', 'arn:aws:lambda:us-east-1:594552273052:function:hive-v2-t01-broker-health')
assert not allows('iam:PassRole', 'arn:aws:iam::594552273052:role/hive-v2-t01-broker-health', **{'iam:PassedToService': 'lambda.amazonaws.com'})
assert allows('secretsmanager:CreateSecret', HEALTH_SECRET)
assert allows('secretsmanager:DeleteSecret', HEALTH_SECRET)
assert not allows('secretsmanager:DeleteSecret', HEALTH_SECRET.replace('health-', 'other-'))
PROXY_SECRET = 'arn:aws:secretsmanager:us-east-1:594552273052:secret:hive-v2-t01-smoke-proxy-123-AbCdEf'
assert allows('secretsmanager:CreateSecret', PROXY_SECRET)
assert allows('secretsmanager:DescribeSecret', PROXY_SECRET)
assert allows('secretsmanager:DeleteSecret', PROXY_SECRET)
assert not allows('secretsmanager:DeleteSecret', PROXY_SECRET.replace('proxy-', 'other-'))


def deploy_allows(action, resource):
    return any(
        statement['Effect'] == 'Allow' and action_matches(statement, action)
        and resource_matches(statement, resource)
        for statement in DEPLOY_STATEMENTS
    )


def effective_permission(boundary_statement, inline_statement, action, resource):
    return (
        boundary_statement['Effect'] == 'Allow'
        and action_matches(boundary_statement, action)
        and resource_matches(boundary_statement, resource)
        and inline_statement['Effect'] == 'Allow'
        and action_matches(inline_statement, action)
        and resource_matches(inline_statement, resource)
    )


INFRA_STACK = 'arn:aws:cloudformation:us-east-1:594552273052:stack/hive-v2-infra/*'
DEPLOY_ROLE_ARN = 'arn:aws:iam::594552273052:role/hive-v2-gh-deploy'
SMOKE_ROLE = 'arn:aws:iam::594552273052:role/hive-v2-gh-t01-smoke'
assert deploy_allows('cloudformation:ContinueUpdateRollback', INFRA_STACK)
assert not deploy_allows('cloudformation:ContinueUpdateRollback', OTHER_STACK)
assert deploy_allows('iam:UpdateRoleDescription', DEPLOY_ROLE_ARN)
assert deploy_allows('iam:UpdateRoleDescription', SMOKE_ROLE)
assert not deploy_allows('iam:UpdateRoleDescription', 'arn:aws:iam::594552273052:role/other-role')
assert not deploy_allows('iam:UpdateRoleDescription', 'arn:aws:iam::594552273052:role/hive-v2-gh-bench')
assert TEMPLATE['Resources']['T01SmokeRole']['Properties']['MaxSessionDuration'] == 9000

SMOKE_PATH = ROOT / 'infra/t01-smoke/template.yaml'
SMOKE_TEMPLATE = yaml.load(SMOKE_PATH.read_text(), CloudFormationLoader)
for template in (TEMPLATE, SMOKE_TEMPLATE):
    metadata = template['Metadata']
    assert metadata['AWSToolsMetrics']['AWSAgentToolkit'] == 'aws-cloudformation@3'
    assert metadata['com.aws.cloudformation.Context']
for path in (ROOT / 'infra/template.yaml', SMOKE_PATH):
    assert path.stat().st_size < 51_200, f'{path} exceeds the inline template limit'
for resource_name in ('InstanceRole', 'InstanceProfile', 'SecurityGroup', 'Instance'):
    context = SMOKE_TEMPLATE['Resources'][resource_name]['Metadata']['com.aws.cloudformation.Context']
    assert context['why'].strip(), resource_name
    assert context['must'], resource_name
health_policy = SMOKE_TEMPLATE['Resources']['InstanceRole']['Properties']['Policies'][0]['PolicyDocument']['Statement']
proxy_condition = health_policy[1]
assert proxy_condition[0] == 'Matrix' and proxy_condition[2] == 'AWS::NoValue'
health_policy = [health_policy[0], proxy_condition[1], *health_policy[2:]]
HOST = 'arn:aws:ec2:us-east-1:594552273052:instance/*'
DOCUMENT_ARN = 'arn:aws:ssm:us-east-1:594552273052:document/hive-v2-t01-teamkimi-port-forward'
DOCUMENT = TEMPLATE['Resources']['T01TeamKimiPortForwardDocument']['Properties']['Content']
assert not any('ssm:SendCommand' in str(statement) for statement in (*STATEMENTS, *health_policy))
assert allows('ssm:StartSession', DOCUMENT_ARN, health_policy)
assert allows('ssm:StartSession', HOST, health_policy, **{'ssm:resourceTag/Role': 'nexus-kimi-session'})
assert not allows('ssm:StartSession', HOST, health_policy)
assert not allows('ssm:TerminateSession', '*', health_policy)
assert not allows('ssm:StartSession', DOCUMENT_ARN)
assert not allows('ssm:StartSession', HOST, **{'ssm:resourceTag/Role': 'nexus-kimi-session'})
assert DOCUMENT['documentType'] == 'Session'
assert DOCUMENT['schemaVersion'] == '1.0'
assert DOCUMENT['properties']['type'] == 'LocalPortForwarding'
assert DOCUMENT['properties']['portNumber'] == '8765'
assert DOCUMENT['properties']['localPortNumber'] == '8765'
assert 'remoteHost' not in DOCUMENT['properties']
assert TEMPLATE['Resources']['T01TeamKimiPortForwardDocument']['DependsOn'] == 'DeployRole'
assert health_policy[0]['Action'] == 'secretsmanager:GetSecretValue'
assert health_policy[0]['Resource'] == 'TeamKimiSecretArn'
assert TEMPLATE['Resources']['T01SmokeRole']['Properties']['Description'] == (
    'Manages only the disposable T01 preflight stack from the protected GitHub environment.'
)
role_context = TEMPLATE['Resources']['T01SmokeRole']['Metadata']['com.aws.cloudformation.Context']
assert role_context['why'].strip()
assert role_context['must']

INSTANCE_ROLE_ARN = 'arn:aws:iam::594552273052:role/hive-v2-t01-smoke-instance'
INSTANCE_BOUNDARY = 'arn:aws:iam::594552273052:policy/hive-v2-t01-smoke-health-boundary'
BOUNDARY_LIFECYCLE_ACTIONS = {
    'iam:CreatePolicy', 'iam:CreatePolicyVersion', 'iam:DeletePolicy',
    'iam:DeletePolicyVersion', 'iam:GetPolicy', 'iam:GetPolicyVersion',
    'iam:ListPolicyVersions', 'iam:SetDefaultPolicyVersion',
}
for action in ('iam:CreateRole', 'iam:PutRolePermissionsBoundary'):
    assert not allows(action, INSTANCE_ROLE_ARN), f'{action} must require the exact permissions boundary'
    assert allows(action, INSTANCE_ROLE_ARN, **{'iam:PermissionsBoundary': INSTANCE_BOUNDARY})
    assert not allows(action, INSTANCE_ROLE_ARN, **{'iam:PermissionsBoundary': 'arn:aws:iam::594552273052:policy/other-boundary'})
for context in ({}, {'iam:PermissionsBoundary': INSTANCE_BOUNDARY}, {'iam:PermissionsBoundary': 'arn:aws:iam::594552273052:policy/other-boundary'}):
    assert not allows('iam:DeleteRolePermissionsBoundary', INSTANCE_ROLE_ARN, **context), 'T01 must never detach a runtime boundary'
for action in BOUNDARY_LIFECYCLE_ACTIONS:
    assert not allows(action, INSTANCE_BOUNDARY), 'T01 must not mutate boundary policy documents'
    assert deploy_allows(action, INSTANCE_BOUNDARY), 'the root deploy role owns boundary lifecycle'
    assert not deploy_allows(action, 'arn:aws:iam::594552273052:policy/other-policy')
boundary_statement = next(statement for statement in DEPLOY_STATEMENTS if statement['Sid'] == 'ManageHiveBoundaryPolicies')
assert set(boundary_statement['Action']) == BOUNDARY_LIFECYCLE_ACTIONS
assert set(boundary_statement['Resource']) == {INSTANCE_BOUNDARY}
for resource_name in ('T01SmokeHealthBoundary', 'T01SmokeRole'):
    assert TEMPLATE['Resources'][resource_name]['DependsOn'] == 'DeployRole'

role = SMOKE_TEMPLATE['Resources']['InstanceRole']
boundary = TEMPLATE['Resources']['T01SmokeHealthBoundary']
assert role['Properties']['PermissionsBoundary'] == INSTANCE_BOUNDARY
statements = boundary['Properties']['PolicyDocument']['Statement']
assert len(statements) == 5
assert 'ssm:SendCommand' not in str(statements)
proxy_boundary = next(statement for statement in statements if statement.get('Sid') == 'ReadRunTeamKimiControlKey')
proxy_inline = next(statement for statement in health_policy if statement.get('Sid') == 'ReadRunTeamKimiControlKey')
assert proxy_inline['Action'] == 'secretsmanager:GetSecretValue'
assert proxy_inline['Resource'] == 'TeamKimiProxySecretArn'
resolved_inline = {**proxy_inline, 'Resource': PROXY_SECRET}
assert effective_permission(proxy_boundary, resolved_inline, 'secretsmanager:GetSecretValue', PROXY_SECRET)
assert not effective_permission(
    proxy_boundary, resolved_inline, 'secretsmanager:GetSecretValue',
    'arn:aws:secretsmanager:us-east-1:594552273052:secret:other-secret',
)
assert SMOKE_TEMPLATE['Parameters']['TeamKimiProxySecretArn']['NoEcho'] is True
statement = statements[0]
assert statement['Effect'] == 'Allow'
assert statement['Action'] == 'secretsmanager:GetSecretValue'
assert statement['Resource'] == 'arn:aws:secretsmanager:us-east-1:594552273052:secret:hive-v2-t01-smoke-health-*'
admin_inline_policy = {'Effect': 'Allow', 'Action': '*', 'Resource': '*'}
assert effective_permission(statement, admin_inline_policy, 'secretsmanager:GetSecretValue', HEALTH_SECRET)
assert not effective_permission(statement, admin_inline_policy, 'iam:DeleteRole', INSTANCE_ROLE_ARN)
assert not effective_permission(statement, admin_inline_policy, 'iam:PassRole', INSTANCE_ROLE_ARN)
other_secret = 'arn:aws:secretsmanager:us-east-1:594552273052:secret:other-secret'
assert not effective_permission(statement, admin_inline_policy, 'secretsmanager:GetSecretValue', other_secret)

resolver_egress = SMOKE_TEMPLATE['Resources']['SecurityGroup']['Properties']['SecurityGroupEgress']
resolver_rules = [rule for rule in resolver_egress if rule['FromPort'] == 53]
assert len(resolver_rules) == 2
assert {rule['IpProtocol'] for rule in resolver_rules} == {'udp', 'tcp'}
assert all(rule['ToPort'] == 53 for rule in resolver_rules)
assert all(rule['CidrIp'] == '${ResolverIp}/32' for rule in resolver_rules)
assert all(rule['CidrIp'] != '0.0.0.0/0' for rule in resolver_rules)
assert any(rule['FromPort'] == 443 and rule['CidrIp'] == '0.0.0.0/0' for rule in resolver_egress)

bucket = TEMPLATE['Resources']['T01EvidenceBucket']['Properties']
assert bucket['BucketEncryption']['ServerSideEncryptionConfiguration'][0]['ServerSideEncryptionByDefault']['SSEAlgorithm'] == 'AES256'
assert bucket['LifecycleConfiguration']['Rules'][0]['ExpirationInDays'] == 7
assert bucket['PublicAccessBlockConfiguration']['RestrictPublicBuckets'] is True
smoke_s3 = [statement for statement in STATEMENTS if statement.get('Sid') == 'T01PaidEvidenceReadback']
assert len(smoke_s3) == 1
assert smoke_s3[0]['Action'] == ['s3:GetObject', 's3:DeleteObject']
assert smoke_s3[0]['Resource'] == 'arn:aws:s3:::hive-v2-t01-evidence-594552273052/hive-v2-t01-smoke/*'
instance_s3 = [statement for statement in health_policy if statement.get('Sid') == 'WriteRunEvidence']
assert len(instance_s3) == 1
assert instance_s3[0]['Action'] == 's3:PutObject'
assert instance_s3[0]['Resource'] == 'arn:aws:s3:::hive-v2-t01-evidence-594552273052/hive-v2-t01-smoke/${RunId}/*'
EVIDENCE_BUCKET = 'arn:aws:s3:::hive-v2-t01-evidence-594552273052'
assert allows('s3:ListBucket', EVIDENCE_BUCKET, **{'s3:prefix': 'hive-v2-t01-smoke/*'})
assert not allows('s3:ListBucket', EVIDENCE_BUCKET)
assert not allows('s3:ListBucket', EVIDENCE_BUCKET, **{'s3:prefix': 'other/*'})
assert deploy_allows('s3:PutBucketTagging', EVIDENCE_BUCKET)
assert not deploy_allows('s3:PutBucketTagging', 'arn:aws:s3:::other-evidence')
assert TEMPLATE['Resources']['T01EvidenceBucket']['DependsOn'] == 'DeployRole'
