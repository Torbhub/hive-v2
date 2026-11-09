import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_CREDENTIAL } from './security-fixture.js';

const tmux = await import('../src/tmux.js');
const { launchWindow } = await import('../src/spawn.js');
const { authenticateBearer } = await import('../src/security.js');
const { MemoryRegistry, registryItems } = await import('./security-fixture.js');
const { hubPath, writeJson } = await import('../src/state.js');

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.HIVE_COLLABORATION_ENABLED;
  delete process.env.HIVE_NEXUS_BASE_URL;
  delete process.env.HIVE_AGENT_CREDENTIAL;
});

describe('enabled spawn credential files', () => {
  it('uses a local per-agent file without network enrollment or tmux secret exposure', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'hive-enabled-spawn-'));
    const cwd = path.join(root, 'demo');
    const credentialFile = path.join(cwd, '.hive', 'team', 'builder', 'credential.env');
    await fs.mkdir(path.dirname(credentialFile), { recursive: true });
    const replacement = 'hva1.builder.fedcba9876543210.replacement-secret-with-high-entropy';
    await fs.writeFile(credentialFile, `HIVE_AGENT_CREDENTIAL='${replacement}'\n`, { mode: 0o600 });
    await writeJson(hubPath(root, 'projects.json'), {
      projects: [{ name: 'demo', home: cwd, repos: [{ folder: cwd }] }],
    });
    process.env.HIVE_COLLABORATION_ENABLED = '1';
    process.env.HIVE_AGENT_CREDENTIAL = AGENT_CREDENTIAL;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    let command = '';
    vi.spyOn(tmux, 'newWindow').mockImplementation(async (_name, _cwd, shellCommand) => {
      command = shellCommand;
      return { pane: '%1', identity: { pid: 1, started: 'now' } };
    });
    vi.spyOn(tmux, 'paneIdentity').mockResolvedValue({ pid: 1, started: 'now' });
    await launchWindow(root, 'demo', 'builder', cwd);
    await launchWindow(root, 'demo', 'builder', cwd);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(command).toContain('HIVE_COLLABORATION_ENABLED=1');
    expect(command).toContain(`HIVE_AGENT_REF='builder@${cwd}'`);
    expect(command).toContain('HIVE_AGENT_CREDENTIAL= HIVE_AGENT_CREDENTIAL_FILE=');
    expect(command).not.toContain(AGENT_CREDENTIAL);
    expect(command).not.toContain(replacement);
    const stat = await fs.stat(credentialFile);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(await fs.readFile(credentialFile, 'utf8')).toBe(`HIVE_AGENT_CREDENTIAL='${replacement}'\n`);
    const { credentialFromEnvironment } = await import('../src/collaboration-credentials.js');
    await expect(credentialFromEnvironment({
      HIVE_AGENT_CREDENTIAL: AGENT_CREDENTIAL, HIVE_AGENT_CREDENTIAL_FILE: credentialFile,
    })).resolves.toBe(replacement);

    const values = registryItems();
    const credentialRow = values.find((row) => row.sk?.startsWith('CRED#'))!;
    credentialRow.sk = 'CRED#fedcba9876543210';
    credentialRow.credentialId = 'fedcba9876543210';
    credentialRow.credentialHash = createHash('sha256')
      .update(`${credentialRow.salt}:replacement-secret-with-high-entropy`).digest('hex');
    const registry = new MemoryRegistry(values);
    await expect(authenticateBearer(replacement, registry)).resolves.toMatchObject({
      kind: 'agent', agentId: 'builder', project: 'demo',
    });
    await expect(authenticateBearer(AGENT_CREDENTIAL, registry)).rejects.toThrow('invalid agent credential');

    const outside = path.join(root, 'outside');
    await fs.writeFile(outside, 'unchanged');
    await fs.unlink(credentialFile);
    await fs.symlink(outside, credentialFile);
    await expect(launchWindow(root, 'demo', 'builder', cwd)).rejects.toThrow('not private');
    expect(await fs.readFile(outside, 'utf8')).toBe('unchanged');
  });

  it('does not require credentials in default-off mode', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'hive-legacy-spawn-'));
    const cwd = path.join(root, 'demo');
    await fs.mkdir(cwd, { recursive: true });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    let command = '';
    vi.spyOn(tmux, 'newWindow').mockImplementation(async (_name, _cwd, shellCommand) => {
      command = shellCommand;
      return { pane: '%1', identity: { pid: 1, started: 'now' } };
    });
    vi.spyOn(tmux, 'paneIdentity').mockResolvedValue({ pid: 1, started: 'now' });
    await launchWindow(root, 'demo', 'builder', cwd);
    expect(command).not.toContain('HIVE_COLLABORATION_ENABLED');
    expect(command).not.toContain('HIVE_AGENT_CREDENTIAL_FILE');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await fs.stat(path.join(cwd, '.hive', 'team', 'builder', 'credential.env')).catch(() => null)).toBeNull();
  });
});
