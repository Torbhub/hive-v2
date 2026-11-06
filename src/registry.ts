import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type RegistryRow = Record<string, unknown> & { pk: string; sk: string };

export interface Registry {
  get(pk: string, sk: string): Promise<RegistryRow | undefined>;
  currentAccount(subject: string, credential: string): Promise<RegistryRow | undefined>;
  put(row: RegistryRow, credential: string): Promise<RegistryRow>;
  query(pk: string, skPrefix: string): Promise<RegistryRow[]>;
}

export class RegistryUnavailable extends Error {
  constructor(message: string, readonly status = 503) {
    super(message);
  }
}

export class FileRegistry implements Registry {
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  private async read(): Promise<RegistryRow[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new RegistryUnavailable('registry read failed');
    }
    try {
      const document = JSON.parse(raw) as { items?: RegistryRow[] };
      if (!Array.isArray(document.items)) throw new Error();
      return document.items;
    } catch {
      throw new RegistryUnavailable('registry read failed');
    }
  }

  async get(pk: string, sk: string): Promise<RegistryRow | undefined> {
    return (await this.read()).find((row) => row.pk === pk && row.sk === sk);
  }

  async currentAccount(subject: string, _credential: string): Promise<RegistryRow | undefined> {
    return this.get(`SUBJECT#${subject}`, 'PROFILE');
  }

  async query(pk: string, skPrefix: string): Promise<RegistryRow[]> {
    return (await this.read()).filter((row) => row.pk === pk && row.sk.startsWith(skPrefix));
  }

  async put(row: RegistryRow, _credential: string): Promise<RegistryRow> {
    this.writes = this.writes.then(async () => {
      const rows = await this.read();
      const index = rows.findIndex((current) => current.pk === row.pk && current.sk === row.sk);
      if (index < 0) rows.push(row);
      else rows[index] = row;
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.tmp.${process.pid}`;
      await fs.writeFile(temporary, JSON.stringify({ items: rows }, null, 2) + '\n', { mode: 0o600 });
      await fs.rename(temporary, this.file);
    });
    await this.writes;
    return row;
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

  async put(row: RegistryRow, credential: string): Promise<RegistryRow> {
    if (!row.sk.startsWith('WAKE#') || typeof row.agentId !== 'string') {
      throw new RegistryUnavailable('only wake writes use the broker');
    }
    const revoked = row.revokedAt !== null && row.revokedAt !== undefined;
    const result = await this.broker(
      revoked ? '/api/hive/broker/wake-subscriptions/revoke' : '/api/hive/broker/wake-subscriptions',
      credential,
      revoked
        ? { agentId: row.agentId, subscriptionId: row.subscriptionId }
        : { agentId: row.agentId, executionGrantId: row.executionGrantId },
    );
    return revoked ? row : result as RegistryRow;
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
  if (env.HIVE_REGISTRY_FILE) return new FileRegistry(env.HIVE_REGISTRY_FILE);
  return new DynamoCliRegistry(
    env.HIVE_COLLABORATION_TABLE ?? 'nexus-hive-collaboration',
    env.HIVE_NEXUS_BASE_URL ?? 'https://nexus.dexima.ai',
  );
}
