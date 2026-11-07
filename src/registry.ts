import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type RegistryRow = Record<string, unknown> & { pk: string; sk: string };

export type DelegatedApprovalRequest = {
  project: string;
  task?: string;
  consumerGrantId: string;
  approverSubject: string;
  approverGrantId: string;
};

export type WakeSubscription = {
  subscriptionId: string;
  agentId: string;
  executionGrantId: string;
  createdBy: string;
  createdAt: number;
  revokedAt: number | null;
  aclEpoch: number;
};

export interface Registry {
  get(pk: string, sk: string): Promise<RegistryRow | undefined>;
  currentAccount(subject: string, credential: string): Promise<RegistryRow | undefined>;
  delegatedApprovalAccount(agentId: string, credential: string,
    request: DelegatedApprovalRequest): Promise<RegistryRow | undefined>;
  createWakeSubscription(agentId: string, credential: string, executionGrantId: string): Promise<WakeSubscription>;
  revokeWakeSubscription(agentId: string, credential: string, subscriptionId: string): Promise<void>;
  query(pk: string, skPrefix: string): Promise<RegistryRow[]>;
}

export class RegistryUnavailable extends Error {
  constructor(message: string, readonly status = 503) {
    super(message);
  }
}

function unmarshall(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unmarshall);
  if (!value || typeof value !== 'object') return value;
  const row = value as Record<string, unknown>;
  if ('S' in row) return row.S;
  if ('N' in row) return Number(row.N);
  if ('BOOL' in row) return row.BOOL;
  if ('NULL' in row) return null;
  if ('L' in row) return unmarshall(row.L);
  if ('M' in row) return unmarshall(row.M);
  return Object.fromEntries(Object.entries(row).map(([key, item]) => [key, unmarshall(item)]));
}

export class DynamoCliRegistry implements Registry {
  constructor(private readonly table: string, private readonly brokerUrl: string) {}

  private async call(operation: string, args: string[]): Promise<Record<string, unknown>> {
    try {
      const { stdout } = await execFileAsync('aws', [
        'dynamodb', operation, '--table-name', this.table, '--output', 'json', ...args,
      ], { maxBuffer: 4 * 1024 * 1024, timeout: 5000 });
      return JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      throw new RegistryUnavailable('registry request failed');
    }
  }

  async get(pk: string, sk: string): Promise<RegistryRow | undefined> {
    const key = JSON.stringify({ pk: { S: pk }, sk: { S: sk } });
    const result = await this.call('get-item', ['--key', key, '--consistent-read']);
    return result.Item ? unmarshall(result.Item) as RegistryRow : undefined;
  }

  private async broker(pathname: string, credential: string,
    body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(`${this.brokerUrl}${pathname}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          authorization: `Bearer ${credential}`,
          'cache-control': 'no-store',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new RegistryUnavailable('broker request failed');
    }
    if (!response.ok) throw new RegistryUnavailable('broker request failed', response.status);
    return response.json() as Promise<Record<string, unknown>>;
  }

  async currentAccount(subject: string, credential: string): Promise<RegistryRow | undefined> {
    const row = await this.broker('/api/hive/broker/account-status', credential);
    if (row.subject !== subject || typeof row.accountStatus !== 'string') {
      throw new RegistryUnavailable('broker account response is invalid');
    }
    return { ...row, pk: `SUBJECT#${subject}`, sk: 'PROFILE' };
  }

  async delegatedApprovalAccount(agentId: string, credential: string,
    request: DelegatedApprovalRequest): Promise<RegistryRow | undefined> {
    const row = await this.broker('/api/hive/broker/delegated-approval', credential, request);
    if (row.subject !== request.approverSubject || row.accountStatus !== 'active'
      || !Number.isSafeInteger(row.accountEpoch)) {
      throw new RegistryUnavailable('delegated approval response is invalid');
    }
    return { ...row, pk: `SUBJECT#${request.approverSubject}`, sk: 'PROFILE' };
  }

  async createWakeSubscription(agentId: string, credential: string,
    executionGrantId: string): Promise<WakeSubscription> {
    return this.broker('/api/hive/broker/wake-subscriptions', credential, {
      agentId, executionGrantId,
    }) as Promise<WakeSubscription>;
  }

  async revokeWakeSubscription(agentId: string, credential: string, subscriptionId: string): Promise<void> {
    await this.broker('/api/hive/broker/wake-subscriptions/revoke', credential, { agentId, subscriptionId });
  }

  async query(pk: string, skPrefix: string): Promise<RegistryRow[]> {
    const result = await this.call('query', [
      '--key-condition-expression', 'pk = :pk AND begins_with(sk, :sk)',
      '--expression-attribute-values', JSON.stringify({ ':pk': { S: pk }, ':sk': { S: skPrefix } }),
      '--consistent-read',
    ]);
    return Array.isArray(result.Items) ? unmarshall(result.Items) as RegistryRow[] : [];
  }
}

export function registryFromEnv(env: NodeJS.ProcessEnv = process.env): Registry {
  return new DynamoCliRegistry(
    env.HIVE_COLLABORATION_TABLE ?? 'nexus-hive-collaboration',
    env.HIVE_NEXUS_BASE_URL ?? 'https://nexus.dexima.ai',
  );
}
