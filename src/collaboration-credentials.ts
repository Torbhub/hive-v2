import { promises as fs } from 'node:fs';
import { hivePath } from './state.js';

function brokerUrl(): string {
  return process.env.HIVE_NEXUS_BASE_URL ?? 'https://nexus.dexima.ai';
}

export async function enrollAgentCredential(cwd: string, project: string, agent: string): Promise<void> {
  if (process.env.HIVE_COLLABORATION_ENABLED !== '1') return;
  const administrator = process.env.HIVE_AGENT_CREDENTIAL;
  if (!administrator) throw new Error('enabled spawn needs an administrator agent credential');
  const response = await fetch(`${brokerUrl()}/api/hive/broker/enroll-agent`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${administrator}`,
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
    body: JSON.stringify({ agentId: agent, project }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('agent enrollment was denied');
  const body = await response.json() as { credential?: unknown };
  if (typeof body.credential !== 'string' || !body.credential.startsWith(`hva1.${agent}.`)) {
    throw new Error('agent enrollment returned invalid identity');
  }
  const file = hivePath(cwd, 'team', agent, 'credential.env');
  await fs.unlink(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(`HIVE_AGENT_CREDENTIAL='${body.credential}'\n`, 'utf8');
  } finally {
    await handle.close();
  }
}

export async function credentialFromEnvironment(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const file = env.HIVE_AGENT_CREDENTIAL_FILE;
  if (!file) return env.HIVE_AGENT_CREDENTIAL;
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600) {
    throw new Error('agent credential file is not private');
  }
  const content = await fs.readFile(file, 'utf8');
  const match = /^HIVE_AGENT_CREDENTIAL='([^']+)'\n$/.exec(content);
  if (!match) throw new Error('agent credential file is invalid');
  return match[1];
}
