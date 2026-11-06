import { pushByHash } from './gate.js';
import { UsageError } from './usage.js';

export async function runPushCommand(
  remote: string,
  sha: string,
  branch: string,
  reference: string | undefined,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!reference) throw new UsageError('a structured push approval is required');
  const [batch, question] = reference.split('/');
  const root = env.HIVE_HUB_ROOT;
  const project = env.HIVE_PROJECT;
  if (!batch || !question || !root || !project) throw new UsageError('approval requires batch/question and Hive project state');
  await pushByHash(remote, sha, branch, cwd, { root, project, batch, question });
  console.log(`hive: pushed ${sha} to ${remote}/${branch}`);
}
