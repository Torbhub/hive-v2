import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(() => true),
  propose: vi.fn(async (): Promise<string | null> => 'cand-x1'),
  list: vi.fn(async () => [{ id: 'cand-x1', content: 'a lesson' }] as { id: string; content: string }[] | null),
  promote: vi.fn(async (): Promise<{ kind: 'promoted'; id: string } | { kind: 'missing' } | { kind: 'unavailable' }> => ({ kind: 'promoted', id: 'mem-x1' })),
}));

vi.mock('../src/memory.js', () => ({
  memoryEnabled: mocks.enabled,
  proposeMemory: mocks.propose,
  listCandidates: mocks.list,
  promoteCandidate: mocks.promote,
}));

import { memoryCommand } from '../src/memory-cli.js';

describe('hive memory cli', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabled.mockReturnValue(true);
    mocks.propose.mockResolvedValue('cand-x1');
    mocks.list.mockResolvedValue([{ id: 'cand-x1', content: 'a lesson' }]);
    mocks.promote.mockResolvedValue({ kind: 'promoted', id: 'mem-x1' });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('rejects a missing or unknown subcommand', async () => {
    await expect(memoryCommand([])).rejects.toThrow(/usage: hive memory/);
    await expect(memoryCommand(['eat', 'demo'])).rejects.toThrow(/usage: hive memory/);
  });

  it('rejects a bad project name', async () => {
    await expect(memoryCommand(['ls', 'Bad Name'])).rejects.toThrow(/usage: hive memory/);
  });

  it('rejects propose with no text', async () => {
    await expect(memoryCommand(['propose', 'demo'])).rejects.toThrow(/usage: hive memory/);
  });

  it('rejects promote with no id', async () => {
    await expect(memoryCommand(['promote', 'demo'])).rejects.toThrow(/usage: hive memory/);
  });

  it('refuses every subcommand when memory is not configured', async () => {
    mocks.enabled.mockReturnValue(false);
    await expect(memoryCommand(['propose', 'demo', 'text'])).rejects.toThrow(/not configured/);
    await expect(memoryCommand(['ls', 'demo'])).rejects.toThrow(/not configured/);
    await expect(memoryCommand(['promote', 'demo', 'cand-x1'])).rejects.toThrow(/not configured/);
    expect(mocks.propose).not.toHaveBeenCalled();
  });

  it('proposes with env provenance and prints the candidate id', async () => {
    vi.stubEnv('HIVE_AGENT', 'builder');
    vi.stubEnv('HIVE_SESSION', 'session_1');
    await memoryCommand(['propose', 'demo', 'the', 'gate', 'helps']);
    expect(mocks.propose).toHaveBeenCalledWith('demo', 'builder', 'the gate helps', { session: 'session_1' });
    expect(vi.mocked(console.log)).toHaveBeenCalledWith('cand-x1');
    vi.unstubAllEnvs();
  });

  it('fails loud when memory does not take the candidate', async () => {
    mocks.propose.mockResolvedValue(null);
    await expect(memoryCommand(['propose', 'demo', 'text'])).rejects.toThrow(/did not take/);
  });

  it('lists candidates', async () => {
    await memoryCommand(['ls', 'demo']);
    expect(vi.mocked(console.log)).toHaveBeenCalledWith('cand-x1  a lesson');
  });

  it('fails loud when ls cannot reach memory', async () => {
    mocks.list.mockResolvedValue(null);
    await expect(memoryCommand(['ls', 'demo'])).rejects.toThrow(/did not answer/);
  });

  it('promotes and prints the team id', async () => {
    await memoryCommand(['promote', 'demo', 'cand-x1']);
    expect(mocks.promote).toHaveBeenCalledWith('demo', 'cand-x1');
    expect(vi.mocked(console.log)).toHaveBeenCalledWith('hive: cand-x1 is now team memory mem-x1');
  });

  it('fails loud on a missing candidate', async () => {
    mocks.promote.mockResolvedValue({ kind: 'missing' });
    await expect(memoryCommand(['promote', 'demo', 'cand-nope'])).rejects.toThrow(/no candidate cand-nope/);
  });
});
