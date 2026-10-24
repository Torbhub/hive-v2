import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWireLine, parseWireText, readAgentLog, redactSecrets } from '../src/logview.js';
import { hivePath, hubPath, Refusal, writeJson } from '../src/state.js';
import type { TeamEntry } from '../src/types.js';

const T = 1_761_000_000_000;

function loopEvent(event: unknown): string {
  return JSON.stringify({ type: 'context.append_loop_event', agentId: 'main', event, time: T });
}

function textLine(text: string): string {
  return loopEvent({ type: 'content.part', part: { type: 'text', text } });
}

function userMessage(text: string): string {
  return JSON.stringify({
    type: 'context.append_message', agentId: 'main', time: T,
    message: { role: 'user', content: [{ type: 'text', text }], id: 'm1', toolCalls: [], origin: { kind: 'user' } },
  });
}

describe('parseWireLine', () => {
  it('extracts a think part', () => {
    const e = parseWireLine(loopEvent({ type: 'content.part', part: { type: 'think', think: 'what if I…' } }));
    expect(e).toEqual({ at: new Date(T).toISOString(), kind: 'think', text: 'what if I…' });
  });

  it('extracts a text part', () => {
    const e = parseWireLine(loopEvent({ type: 'content.part', part: { type: 'text', text: 'done.' } }));
    expect(e?.kind).toBe('text');
    expect(e?.text).toBe('done.');
  });

  it('extracts a tool call with its display summary', () => {
    const e = parseWireLine(loopEvent({
      type: 'tool.call', name: 'Read', args: { path: '/tmp/x.ts' },
      display: { kind: 'fs', operation: 'read', path: '/tmp/x.ts' },
    }));
    expect(e?.kind).toBe('tool');
    expect(e?.text).toBe('Read read /tmp/x.ts');
  });

  it('falls back to the args when a tool call has no display', () => {
    const e = parseWireLine(loopEvent({ type: 'tool.call', name: 'Bash', args: { command: 'ls' } }));
    expect(e?.text).toBe('Bash {"command":"ls"}');
  });

  it('extracts a user message as a prompt', () => {
    const e = parseWireLine(userMessage('please fix the gate'));
    expect(e?.kind).toBe('prompt');
    expect(e?.text).toBe('please fix the gate');
  });

  it('ignores steps, tool results, and non-user messages', () => {
    expect(parseWireLine(loopEvent({ type: 'step.begin', step: 1 }))).toBeNull();
    expect(parseWireLine(loopEvent({ type: 'tool.result', result: { output: 'x' } }))).toBeNull();
    expect(parseWireLine(JSON.stringify({
      type: 'context.append_message', time: T,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    }))).toBeNull();
    expect(parseWireLine(JSON.stringify({ type: 'usage.record', time: T }))).toBeNull();
  });

  it('returns null on a malformed line', () => {
    expect(parseWireLine('{"type": "context.append_loop_event", "event:')).toBeNull();
    expect(parseWireLine('not json at all')).toBeNull();
  });

  it('redacts secrets and caps long text', () => {
    const secret = `token is sk-${'a'.repeat(40)} ok`;
    const e = parseWireLine(loopEvent({ type: 'content.part', part: { type: 'think', think: secret } }));
    expect(e?.text).toBe('token is sk-[redacted] ok');
    const long = parseWireLine(loopEvent({ type: 'content.part', part: { type: 'text', text: 'x'.repeat(600) } }));
    expect(long?.text.length).toBe(501);
    expect(long?.text.endsWith('…')).toBe(true);
  });

  it('redacts a token that straddles the 500-char cap', () => {
    // Cap-first would keep the token's head; redact-first must not.
    const straddle = `${'x'.repeat(469)} Bearer ${'T'.repeat(100)}`;
    const e = parseWireLine(loopEvent({ type: 'content.part', part: { type: 'think', think: straddle } }));
    expect(e?.text).toContain('Bearer [redacted]');
    expect(e?.text).not.toContain('TT');
  });
});

describe('parseWireText', () => {
  it('keeps order, skips blank and torn lines', () => {
    const raw = [
      userMessage('go'),
      '',
      '{"torn',
      loopEvent({ type: 'content.part', part: { type: 'think', think: 'plan' } }),
      loopEvent({ type: 'content.part', part: { type: 'text', text: 'answer' } }),
    ].join('\n');
    expect(parseWireText(raw).map((e) => e.kind)).toEqual(['prompt', 'think', 'text']);
  });
});

describe('redactSecrets', () => {
  it('redacts Bearer tokens in any case', () => {
    expect(redactSecrets('Authorization: Bearer abc.def-123_x/y+z=')).toBe('Authorization: Bearer [redacted]');
    expect(redactSecrets('authorization: bearer abc.def-123_x/y+z=')).toBe('authorization: bearer [redacted]');
    expect(redactSecrets('AUTHORIZATION: BEARER abc.def-123')).toBe('AUTHORIZATION: BEARER [redacted]');
  });

  it('redacts Authorization credentials but keeps the scheme', () => {
    expect(redactSecrets('Authorization: token abcdefgh99')).toBe('Authorization: token [redacted]');
    expect(redactSecrets('authorization: Basic dXNlcjpwYXNzMTIz')).toBe('authorization: Basic [redacted]');
    const nested = JSON.stringify({ headers: { Authorization: 'Bearer abc.def.ghi123' } });
    expect(redactSecrets(nested)).toBe('{"headers":{"Authorization":"Bearer [redacted]"}}');
    const escaped = JSON.stringify({ cmd: `curl -H ${JSON.stringify('Authorization: Bearer abc.def.ghi123')}` });
    expect(redactSecrets(escaped)).not.toContain('abc.def.ghi');
    expect(redactSecrets(escaped)).toContain('Bearer [redacted]');
  });

  it('redacts sk- keys', () => {
    expect(redactSecrets('key sk-proj-abc123XYZ_-9 here')).toBe('key sk-[redacted] here');
  });

  it('redacts GitHub tokens', () => {
    expect(redactSecrets(`token ghp_${'a'.repeat(36)} ok`)).toBe('token [redacted-gh-token] ok');
    expect(redactSecrets(`token gho_${'B1'.repeat(18)} ok`)).toBe('token [redacted-gh-token] ok');
    expect(redactSecrets(`token github_pat_${'A1_'.repeat(12)} ok`)).toBe('token [redacted-gh-token] ok');
  });

  it('redacts Slack tokens', () => {
    expect(redactSecrets('slack xoxb-123456789012-abcdefghijkl ok')).toBe('slack [redacted-slack-token] ok');
    expect(redactSecrets('slack xoxp-123456789012-abcdefghijkl ok')).toBe('slack [redacted-slack-token] ok');
  });

  it('redacts JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5x';
    expect(redactSecrets(`jwt ${jwt} ok`)).toBe('jwt [redacted-jwt] ok');
  });

  it('redacts a key/value secret and keeps the key name', () => {
    expect(redactSecrets('{"apiKey": "AIzaSyAbcdefg123456"}')).toBe('{"apiKey": "[redacted]"}');
    expect(redactSecrets('api_key=abcdefgh123')).toBe('api_key=[redacted]');
    expect(redactSecrets('password: "hunter2hunter2"')).toBe('password: "[redacted]"');
  });

  it('redacts a quoted value with spaces, up to its closing quote', () => {
    const args = JSON.stringify({ password: 'correct horse battery' });
    expect(redactSecrets(args)).toBe('{"password":"[redacted]"}');
  });

  it('redacts a short quoted value (the quoted floor is 3, the bare floor 8)', () => {
    const args = JSON.stringify({ password: 'hunter2' });
    expect(redactSecrets(args)).toBe('{"password":"[redacted]"}');
    const tiny = JSON.stringify({ password: 'ab' });
    expect(redactSecrets(tiny)).toBe('{"password":"ab"}');
  });

  it('an interior escaped quote does not end a quoted value early', () => {
    const args = JSON.stringify({ cmd: `set ${JSON.stringify({ password: 'ab"cd1234' })}` });
    expect(redactSecrets(args)).not.toContain('cd1234');
    expect(redactSecrets(args)).not.toContain('ab\\"cd');
  });

  it('redacts through backslash-escaped quotes, the shape JSON.stringify embeds in args', () => {
    const args = JSON.stringify({ cmd: `echo ${JSON.stringify({ password: 'correct horse battery' })}` });
    expect(redactSecrets(args)).not.toContain('correct horse');
    expect(redactSecrets(args)).toContain('password');
    const bare = JSON.stringify({ cmd: `run ${JSON.stringify({ token: 'abc12345xyz' })}` });
    expect(redactSecrets(bare)).not.toContain('abc12345xyz');
  });

  it('redacts the password in URL userinfo', () => {
    expect(redactSecrets('https://deploy:s3cret99@example.com/repo.git'))
      .toBe('https://deploy:[redacted]@example.com/repo.git');
  });

  it('redacts AWS secret and session values in key/value shape, and the key id itself', () => {
    expect(redactSecrets('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'))
      .toBe('aws_secret_access_key = [redacted]');
    expect(redactSecrets(`aws_session_token: ${'FQoGZXIvYXdzE'.repeat(4)}`))
      .toBe('aws_session_token: [redacted]');
    expect(redactSecrets('aws AKIAIOSFODNN7EXAMPLE done')).toBe('aws [redacted-aws-key] done');
    expect(redactSecrets('aws ASIAIOSFODNN7EXAMPLE done')).toBe('aws [redacted-aws-key] done');
  });

  it('redacts long hex strings, leaves short ones', () => {
    expect(redactSecrets('sha a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4')).toBe('sha [redacted-hex]');
    expect(redactSecrets('sha a1b2c3d')).toBe('sha a1b2c3d');
  });

  it('keeps the key name when the value is hex (kv rule runs before the hex rule)', () => {
    expect(redactSecrets('token=a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4')).toBe('token=[redacted]');
  });

  it('leaves short values and ordinary prose alone', () => {
    expect(redactSecrets('token=short')).toBe('token=short');
    expect(redactSecrets('the plan has 3 checkpoints')).toBe('the plan has 3 checkpoints');
  });
});

async function setup(
  team: TeamEntry[],
  wires: Record<string, string[]>,
  sessionId = 'session_abc',
): Promise<{ root: string; home: string }> {
  const root = mkdtempSync(path.join(tmpdir(), 'hive-logview-root-'));
  const home = mkdtempSync(path.join(tmpdir(), 'hive-logview-home-'));
  const projHome = path.join(root, 'demo');
  await writeJson(hubPath(root, 'projects.json'), { projects: [{ name: 'demo', home: projHome, repos: [] }] });
  await writeJson(hivePath(projHome, 'team.json'), { agents: team });
  for (const [agentId, lines] of Object.entries(wires)) {
    const dir = path.join(home, '.kimi-code', 'sessions', 'wd_demo_000000000000', sessionId, 'agents', agentId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'wire.jsonl'), `${lines.join('\n')}\n`);
  }
  return { root, home };
}

const ORCH: TeamEntry = { name: 'demo-orchestrator', orchestrator: true, session_id: 'session_abc' };

describe('readAgentLog', () => {
  it('defaults to the orchestrator and reads its wire log', async () => {
    const { root, home } = await setup([ORCH], { main: [userMessage('go'), textLine('on it')] });
    const log = await readAgentLog(root, 'demo', undefined, home);
    expect(log.agent).toBe('demo-orchestrator');
    expect(log.session_id).toBe('session_abc');
    expect(log.agents.map((a) => a.agentId)).toEqual(['main']);
    expect(log.agents[0].entries.map((e) => e.kind)).toEqual(['prompt', 'text']);
  });

  it('reads a named agent and orders main before the subagents', async () => {
    const team = [ORCH, { name: 'fixer', session_id: 'session_abc', worktree: '/wt/a' }];
    const { root, home } = await setup(team, {
      'agent-0': [textLine('subagent says')],
      main: [textLine('main says')],
    });
    const log = await readAgentLog(root, 'demo', 'fixer', home);
    expect(log.agent).toBe('fixer');
    expect(log.agents.map((a) => a.agentId)).toEqual(['main', 'agent-0']);
  });

  it('keeps the newest 100 entries per agent', async () => {
    const lines = Array.from({ length: 120 }, (_, i) => textLine(`line-${String(i + 1).padStart(3, '0')}`));
    const { root, home } = await setup([ORCH], { main: lines });
    const log = await readAgentLog(root, 'demo', undefined, home);
    const entries = log.agents[0].entries;
    expect(entries.length).toBe(100);
    expect(entries[0].text).toBe('line-021');
    expect(entries[99].text).toBe('line-120');
  });

  it('a stale session id is a Refusal, not a 500', async () => {
    const { root, home } = await setup([{ ...ORCH, session_id: 'session_gone' }], {});
    const err = await readAgentLog(root, 'demo', undefined, home).then(
      () => { throw new Error('should have refused'); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Refusal);
    expect((err as Error).message).toMatch(/no wire log/);
  });

  it('a bare name matching two agents is a Refusal, never a guess', async () => {
    const team = [
      ORCH,
      { name: 'fixer', session_id: 'session_abc', worktree: '/wt/a' },
      { name: 'fixer', session_id: 'session_abc', worktree: '/wt/b' },
    ];
    const { root, home } = await setup(team, { main: [textLine('x')] });
    await expect(readAgentLog(root, 'demo', 'fixer', home)).rejects.toThrow(/say which/);
    const log = await readAgentLog(root, 'demo', 'fixer@/wt/b', home);
    expect(log.agent).toBe('fixer');
  });

  it('rejects a session id that is not a plain id', async () => {
    const { root, home } = await setup([{ ...ORCH, session_id: '../escape' }], {});
    await expect(readAgentLog(root, 'demo', undefined, home)).rejects.toThrow(/not a plain id/);
  });

  it('rejects bad names as Refusals', async () => {
    const { root, home } = await setup([ORCH], {});
    await expect(readAgentLog(root, 'Bad Project', undefined, home)).rejects.toThrow(Refusal);
    await expect(readAgentLog(root, 'demo', 'Bad Name!', home)).rejects.toThrow(Refusal);
  });
});
