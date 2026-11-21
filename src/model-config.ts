import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const EXPECTED_MAPPINGS: Record<string, { provider: string; model: string }> = {
  'kimi-code/k3.1-pro-highspeed': { provider: 'managed:kimi-code', model: 'k3.1-pro-highspeed' },
  'kimi-code/k3.1-pro': { provider: 'managed:kimi-code', model: 'k3.1-pro' },
};

type ModelConfig = {
  configured: boolean;
  default_model: string | null;
  provider: unknown;
  model: unknown;
};

function parserScript(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const script = path.join(dir, 'scripts', 'read-kimi-model.py');
    if (existsSync(script)) return script;
    dir = path.dirname(dir);
  }
  throw new Error('hive: cannot find scripts/read-kimi-model.py above the running module');
}

export async function assertModelConfigured(model: string, houseDefault: string): Promise<void> {
  const home = process.env.KIMI_CODE_HOME ?? path.join(os.homedir(), '.kimi-code');
  const file = path.join(home, 'config.toml');
  let config: ModelConfig;
  try {
    const { stdout } = await execFileAsync('python3', [parserScript(), file, model], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 65_536,
    });
    config = JSON.parse(stdout) as ModelConfig;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `model "${model}" is not configured. Expected configured default "${houseDefault}". `
      + `Kimi config ${file} is malformed or unreadable. ${detail}`,
    );
  }
  const expectedDefault = config.default_model ?? houseDefault;
  if (!config.configured) {
    throw new Error(
      `model "${model}" is not configured. Expected configured default "${expectedDefault}". `
      + `Configure the resolved model in ${file}, or use the configured default.`,
    );
  }
  const expected = EXPECTED_MAPPINGS[model];
  if (!expected) {
    throw new Error(`model "${model}" has no expected Hive provider and model mapping. Expected configured default "${expectedDefault}".`);
  }
  if (config.provider !== expected.provider || config.model !== expected.model) {
    throw new Error(
      `model "${model}" uses provider ${JSON.stringify(config.provider)} and model ${JSON.stringify(config.model)} in ${file}. `
      + `Expected provider "${expected.provider}" and model "${expected.model}".`,
    );
  }
}
