import { promises as fs } from 'node:fs';
import { hivePath } from './state.js';

export async function requireAgentCredential(cwd: string, _project: string, agent: string): Promise<void> {
  if (process.env.HIVE_COLLABORATION_ENABLED !== '1') return;
  const file = hivePath(cwd, 'team', agent, 'credential.env');
  const credential = await credentialFromEnvironment({ HIVE_AGENT_CREDENTIAL_FILE: file });
  if (!credential?.startsWith(`hva1.${agent}.`)) {
    throw new Error('enabled spawn needs a locally provisioned agent credential file');
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
