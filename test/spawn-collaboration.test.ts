import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_CREDENTIAL } from './security-fixture.js';

const tmux = await import('../src/tmux.js');
const { launchWindow } = await import('../src/spawn.js');
const { authenticateBearer } = await import('../src/security.js');
const { FileRegistry } = await import('../src/registry.js');
const { registryItems, securityFile, writeSecurity } = await import('./security-fixture.js');

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.HIVE_COLLABORATION_ENABLED;
  delete process.env.HIVE_NEXUS_BASE_URL;
  delete process.env.HIVE_AGENT_CREDENTIAL;
});

describe('enabled spawn credential enrollment', () => {
  it('enrolls and injects an agent-specific credential without exposing it in tmux commands', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'hive-enabled-spawn-'));
    const cwd = path.join(root, 'demo');
    await fs.mkdir(cwd, { recursive: true });
    process.env.HIVE_COLLABORATION_ENABLED = '1';
    process.env.HIVE_AGENT_CREDENTIAL = AGENT_CREDENTIAL;
    process.env.HIVE_NEXUS_BASE_URL = 'https://broker.test';
    const replacement = 'hva1.builder.fedcba9876543210.replacement-secret-with-high-entropy';
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        agentId: 'builder', ownerSubject: 'user:alice', project: 'demo',
        credential: replacement, credentialId: 'fedcba9876543210', credentialEpoch: 1, aclEpoch: 1,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    let command = '';
    vi.spyOn(tmux, 'newWindow').mockImplementation(async (_name, _cwd, shellCommand) => {
      command = shellCommand;
      return { pane: '%1', identity: { pid: 1, started: 'now' } };
    });

    vi.spyOn(tmux, 'paneIdentity').mockResolvedValue({ pid: 1, started: 'now' });
    await launchWindow(root, 'demo', 'builder', cwd);
    const credentialFile = command.match(/HIVE_AGENT_CREDENTIAL_FILE='([^']+)'/)![1];
    const outside = path.join(root, 'outside');
    await fs.writeFile(outside, 'unchanged');
    await fs.unlink(credentialFile);
    await fs.symlink(outside, credentialFile);
    await launchWindow(root, 'demo', 'builder', cwd);

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://broker.test/api/hive/broker/enroll-agent');
    expect(calls[0].init?.method).toBe('POST');
    expect(command).toContain('HIVE_AGENT_CREDENTIAL= HIVE_AGENT_CREDENTIAL_FILE=');
    expect(command).not.toContain(AGENT_CREDENTIAL);
    expect(command).not.toContain(replacement);
    expect(await fs.readFile(outside, 'utf8')).toBe('unchanged');
    const stat = await fs.stat(credentialFile);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(await fs.readFile(credentialFile, 'utf8')).toContain(replacement);
    expect(await fs.readFile(credentialFile, 'utf8')).not.toContain(AGENT_CREDENTIAL);
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
    await writeSecurity(root, values);
    const registry = new FileRegistry(securityFile(root));
    await expect(authenticateBearer(replacement, registry)).resolves.toMatchObject({
      kind: 'agent', agentId: 'builder', project: 'demo',
    });
    await expect(authenticateBearer(AGENT_CREDENTIAL, registry)).rejects.toThrow('invalid agent credential');
  });

  it('does not enroll or require credentials in default-off mode', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'hive-legacy-spawn-'));
    const cwd = path.join(root, 'demo');
    await fs.mkdir(cwd, { recursive: true });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(tmux, 'newWindow').mockResolvedValue({ pane: '%1', identity: { pid: 1, started: 'now' } });
    vi.spyOn(tmux, 'paneIdentity').mockResolvedValue({ pid: 1, started: 'now' });
    await launchWindow(root, 'demo', 'builder', cwd);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await fs.stat(path.join(cwd, '.hive', 'team', 'builder', 'credential.env')).catch(() => null)).toBeNull();
  });
});
