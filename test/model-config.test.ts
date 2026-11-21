import { promises as fs } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertModelConfigured } from '../src/model-config.js';

const HIGHSPEED = 'kimi-code/k3.1-pro-highspeed';
const PRO = 'kimi-code/k3.1-pro';

async function configure(contents: string): Promise<string> {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'hive-model-config-'));
  await fs.writeFile(path.join(home, 'config.toml'), contents);
  vi.stubEnv('KIMI_CODE_HOME', home);
  return home;
}

function modelConfig(alias: string, provider: string, upstream: string): string {
  return `default_model = "${alias}"\n[models."${alias}"]\nprovider = "${provider}"\nmodel = "${upstream}"\n`;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Kimi model configuration', () => {
  it('uses KIMI_CODE_HOME first and parses dotted whitespace, quoted aliases, and multiline strings', async () => {
    const emptyHome = await fs.mkdtemp(path.join(tmpdir(), 'hive-model-empty-home-'));
    vi.spyOn(os, 'homedir').mockReturnValue(emptyHome);
    await configure(`default_model = """${PRO}"""\n[models . "${PRO}"]\nprovider = """managed:kimi-code"""\nmodel = """k3.1-pro"""\n`);
    await expect(assertModelConfigured(PRO, HIGHSPEED)).resolves.toBeUndefined();
  });

  it('fails closed on a malformed bare slash key', async () => {
    await configure('[models.kimi-code/k3.1-pro-highspeed]\nprovider = "managed:kimi-code"\nmodel = "k3.1-pro-highspeed"\n');
    await expect(assertModelConfigured(HIGHSPEED, HIGHSPEED)).rejects.toThrow(/config\.toml.*(malformed|parse)/);
  });

  it('fails closed on malformed TOML', async () => {
    await configure('default_model = "unterminated\n');
    await expect(assertModelConfigured(HIGHSPEED, HIGHSPEED)).rejects.toThrow(/config\.toml.*(malformed|parse)/);
  });

  it('ignores nested lookalikes instead of treating them as direct model keys', async () => {
    await configure(`[models.nested."${HIGHSPEED}"]\nprovider = "managed:kimi-code"\nmodel = "k3.1-pro-highspeed"\n`);
    await expect(assertModelConfigured(HIGHSPEED, HIGHSPEED)).rejects.toThrow(`model "${HIGHSPEED}" is not configured`);
  });

  it('refuses an old Pro alias that silently maps to highspeed', async () => {
    await configure(modelConfig(PRO, 'managed:kimi-code', 'k3.1-pro-highspeed'));
    await expect(assertModelConfigured(PRO, HIGHSPEED)).rejects.toThrow(/Expected provider "managed:kimi-code" and model "k3\.1-pro"/);
  });

  it('refuses an unexpected provider for the resolved model', async () => {
    await configure(modelConfig(HIGHSPEED, 'other', 'k3.1-pro-highspeed'));
    await expect(assertModelConfigured(HIGHSPEED, HIGHSPEED)).rejects.toThrow(/Expected provider "managed:kimi-code"/);
  });
});
