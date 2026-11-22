import { promises as fs } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseWireLine, parseWireText, parseWireUsage, readAgentLog, readWireUsage, redactSecrets } from '../src/logview.js';
import { hivePath, hubPath, Refusal, writeJson } from '../src/state.js';
import type { TeamEntry } from '../src/types.js';

const T = 1_761_000_000_000;

afterEach(() => vi.restoreAllMocks());

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

describe('parseWireUsage', () => {
  const turnEnd = (type = 'turn.ended', agentId = 'main', turnId = 'turn-1') => JSON.stringify({
    type, agentId, turnId, time: T,
  });
  const toolCall = (payload: string) => loopEvent({
    type: 'tool.call', name: 'Bash', args: { command: payload },
  });
  const usageRecord = (usage: unknown, usageScope = 'turn') => JSON.stringify({
    type: 'usage.record', agentId: 'main', model: 'kimi-code/k3', usage, usageScope, time: T,
  });

  it('counts only main top-level turn ends and tool calls and preserves explicit zero usage', () => {
    const raw = [
      turnEnd(),
      turnEnd(),
      turnEnd('agent.turn.ended'),
      turnEnd('turn.ended', 'agent-0', 'turn-2'),
      loopEvent({ type: 'turn.ended', turnId: 'turn-3' }),
      toolCall('printf fixture'),
      JSON.stringify({ type: 'context.append_loop_event', agentId: 'agent-0', event: { type: 'tool.call', name: 'Bash' } }),
      loopEvent({ type: 'tool.result', result: { output: 'not a call' } }),
      JSON.stringify({ type: 'turn.prompt', time: T, prompt: 'not a turn end' }),
      usageRecord({ inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 }),
      usageRecord({ inputOther: 9, output: 9, inputCacheRead: 9, inputCacheCreation: 9 }, 'step'),
    ].join('\n');

    expect(parseWireUsage(raw)).toEqual({
      turns: 1, tool_calls: 1, input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 'unknown',
    });
  });

  it('deduplicates numeric turn IDs without conflating string IDs', () => {
    const numeric = (type = 'turn.ended') => JSON.stringify({ type, agentId: 'main', turnId: 0, time: T });
    const raw = [numeric(), numeric(), numeric('agent.turn.ended'), turnEnd('turn.ended', 'main', '0')].join('\n');

    expect(parseWireUsage(raw)).toEqual({
      turns: 2, tool_calls: 0, input_tokens: 'unknown', output_tokens: 'unknown',
      total_tokens: 'unknown', cost_usd: 'unknown',
    });
  });

  it('counts valid records around malformed JSONL and uses unknown for missing or malformed values', () => {
    const mixed = [
      turnEnd(),
      '{"torn',
      toolCall('printf fixture'),
      usageRecord({ inputOther: '10', output: 4, inputCacheRead: 2, inputCacheCreation: 1 }),
    ].join('\n');
    expect(parseWireUsage(mixed)).toEqual({
      turns: 1, tool_calls: 1, input_tokens: 'unknown', output_tokens: 4,
      total_tokens: 'unknown', cost_usd: 'unknown',
    });
    expect(parseWireUsage('not json\n')).toEqual({
      turns: 'unknown', tool_calls: 'unknown', input_tokens: 'unknown', output_tokens: 'unknown',
      total_tokens: 'unknown', cost_usd: 'unknown',
    });
    expect(parseWireUsage(turnEnd())).toEqual({
      turns: 1, tool_calls: 0, input_tokens: 'unknown', output_tokens: 'unknown',
      total_tokens: 'unknown', cost_usd: 'unknown',
    });
  });

  it('sums real input fields and returns metadata without tool arguments or provider payloads', () => {
    const result = parseWireUsage([
      toolCall('printf private-tool-payload'),
      usageRecord({
        inputOther: 11, output: 7, inputCacheRead: 5, inputCacheCreation: 2,
        prompt: 'private-provider-prompt', response: 'private-provider-response',
      }),
    ].join('\n'));

    expect(result).toEqual({
      turns: 0, tool_calls: 1, input_tokens: 18, output_tokens: 7, total_tokens: 25, cost_usd: 'unknown',
    });
    expect(JSON.stringify(result)).not.toContain('private-tool-payload');
    expect(JSON.stringify(result)).not.toContain('private-provider-prompt');
    expect(JSON.stringify(result)).not.toContain('private-provider-response');
  });
});

describe('readWireUsage', () => {
  const unknown = {
    turns: 'unknown', tool_calls: 'unknown', input_tokens: 'unknown', output_tokens: 'unknown',
    total_tokens: 'unknown', cost_usd: 'unknown',
  };
  const turn = (turnId: string) => JSON.stringify({ type: 'turn.ended', agentId: 'main', turnId, time: T });
  const tool = (agentId = 'main') => JSON.stringify({
    type: 'context.append_loop_event', agentId, event: { type: 'tool.call', name: 'Read' }, time: T,
  });
  const usage = (inputOther: number, output: number, inputCacheRead = 0, inputCacheCreation = 0) => JSON.stringify({
    type: 'usage.record', agentId: 'main', model: 'kimi-code/k3', usageScope: 'turn',
    usage: { inputOther, output, inputCacheRead, inputCacheCreation }, time: T,
  });

  async function file(raw: string): Promise<string> {
    const dir = mkdtempSync(path.join(tmpdir(), 'hive-wire-usage-'));
    const name = path.join(dir, 'wire.jsonl');
    await fs.writeFile(name, raw);
    return name;
  }

  async function mutateAfterInitialStat(mutate: (mtimeMs: number) => Promise<void>): Promise<void> {
    const open = fs.open;
    vi.spyOn(fs, 'open').mockImplementationOnce(async (file, flags) => {
      const handle = await open(file, flags);
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, 'stat').mockImplementationOnce(async () => {
        const initial = await stat();
        await mutate(initial.mtimeMs);
        return initial;
      });
      return handle;
    });
  }

  it('returns unknown for a same-size content and mtime mutation', async () => {
    const name = await file(turn('before'));
    await mutateAfterInitialStat(async (mtimeMs) => {
      await fs.writeFile(name, turn('change'));
      await fs.utimes(name, new Date(), new Date(mtimeMs + 1000));
    });

    expect(await readWireUsage(name)).toEqual(unknown);
  });

  it('returns unknown for a same-size rewrite with the original mtime restored', async () => {
    const name = await file(turn('before'));
    await mutateAfterInitialStat(async (mtimeMs) => {
      await fs.writeFile(name, turn('change'));
      await fs.utimes(name, new Date(), new Date(mtimeMs));
    });

    expect(await readWireUsage(name)).toEqual(unknown);
  });

  it('returns unknown for a same-size file replacement', async () => {
    const name = await file(turn('before'));
    const replacement = `${name}.replacement`;
    await mutateAfterInitialStat(async (mtimeMs) => {
      await fs.rename(name, replacement);
      await fs.writeFile(name, turn('change'));
      await fs.utimes(name, new Date(), new Date(mtimeMs));
    });

    expect(await readWireUsage(name)).toEqual(unknown);
  });

  it('reads split UTF-8 records, deduplicates across chunks, and ignores non-main tool calls', async () => {
    const split = JSON.stringify({
      type: 'turn.ended', agentId: 'main', turnId: 'split', time: T, pad: '😀'.repeat(50_000),
    });
    const raw = `${[split, split, tool('agent-0'), tool(), usage(4, 3, 2, 1)].join('\n')}\n`;

    expect(await readWireUsage(await file(raw))).toEqual({
      turns: 1, tool_calls: 1, input_tokens: 7, output_tokens: 3, total_tokens: 10, cost_usd: 'unknown',
    });
  });

  it('recovers after an oversized record and parses an unterminated EOF record', async () => {
    const oversized = JSON.stringify({
      type: 'turn.ended', agentId: 'main', turnId: 'oversized', time: T, pad: 'x'.repeat(256 * 1024),
    });
    const raw = [turn('before'), oversized, turn('after'), tool(), usage(0, 0)].join('\n');

    expect(await readWireUsage(await file(raw))).toEqual({
      turns: 2, tool_calls: 1, input_tokens: 0, output_tokens: 0, total_tokens: 0, cost_usd: 'unknown',
    });
  });

  it('reports cumulative and derived total overflow as unknown', async () => {
    const cumulative = await file(`${usage(Number.MAX_SAFE_INTEGER, 0)}\n${usage(1, 0)}\n`);
    expect(await readWireUsage(cumulative)).toEqual({
      turns: 0, tool_calls: 0, input_tokens: 'unknown', output_tokens: 0,
      total_tokens: 'unknown', cost_usd: 'unknown',
    });
    const total = await file(`${usage(Number.MAX_SAFE_INTEGER, 1)}\n`);
    expect(await readWireUsage(total)).toEqual({
      turns: 0, tool_calls: 0, input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1,
      total_tokens: 'unknown', cost_usd: 'unknown',
    });
  });

  it('returns unknown for an oversize file and a symlink', async () => {
    const oversize = await file(turn('small'));
    await fs.truncate(oversize, 64 * 1024 * 1024 + 1);
    expect(await readWireUsage(oversize)).toEqual(unknown);

    const target = await file(turn('target'));
    const link = path.join(path.dirname(target), 'linked.jsonl');
    await fs.symlink(target, link);
    expect(await readWireUsage(link)).toEqual(unknown);
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

  it('redacts complete agent credentials in environment and tool argument shapes', () => {
    const secret = 'unit-test-agent-secret-with-32-characters';
    const credential = `hva1.builder.0123456789abcdef.${secret}`;
    const representations = [
      credential,
      `HIVE_AGENT_CREDENTIAL=${credential}`,
      `HIVE_AGENT_CREDENTIAL='${credential}'`,
      JSON.stringify({ command: `export HIVE_AGENT_CREDENTIAL=${credential}` }),
      JSON.stringify({ env: { HIVE_AGENT_CREDENTIAL: credential } }),
    ];
    for (const representation of representations) {
      const redacted = redactSecrets(representation);
      expect(redacted).not.toContain(credential);
      expect(redacted).not.toContain(secret);
      expect(redacted).toContain('[redacted-agent-credential]');
    }
    const capped = parseWireLine(loopEvent({
      type: 'content.part', part: { type: 'text', text: `${'x'.repeat(480)}${credential}` },
    }));
    expect(capped?.text).not.toContain('hva1.');
    expect(capped?.text).not.toContain(secret);
  });

  it('redacts source-truncated credential fragments before the text cap', () => {
    for (const length of [31, 32]) {
      const secret = 's'.repeat(length);
      const fragment = `hva1.builder.0123456789abcdef.${secret}`;
      expect(redactSecrets(`before ${fragment} after`)).toBe('before [redacted-agent-credential] after');
      const capped = parseWireLine(loopEvent({
        type: 'content.part', part: { type: 'text', text: `${'x'.repeat(480)}${fragment}` },
      }));
      expect(capped?.text).not.toContain('hva1.');
      expect(capped?.text).not.toContain(secret);
    }
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

  it('reads only the selected session main wire, never other sessions or internal agents', async () => {
    const team = [ORCH, { name: 'fixer', session_id: 'session_worker', worktree: '/wt/a' }];
    const { root, home } = await setup(team, {
      'agent-0': [textLine('worker internal agent')],
      main: [textLine('worker main')],
    }, 'session_worker');
    const orchDir = path.join(
      home, '.kimi-code', 'sessions', 'wd_demo_000000000000', 'session_abc', 'agents', 'main',
    );
    await fs.mkdir(orchDir, { recursive: true });
    await fs.writeFile(path.join(orchDir, 'wire.jsonl'), `${textLine('orchestrator secret context')}\n`);

    const log = await readAgentLog(root, 'demo', 'fixer', home);

    expect(log.session_id).toBe('session_worker');
    expect(log.agents.map((a) => a.agentId)).toEqual(['main']);
    expect(log.agents[0].entries.map((e) => e.text)).toEqual(['worker main']);
    expect(JSON.stringify(log)).not.toContain('worker internal agent');
    expect(JSON.stringify(log)).not.toContain('orchestrator secret context');
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

  it('pages backward through more than 100 entries without gaps or duplicate ids', async () => {
    const lines = Array.from({ length: 250 }, (_, i) => textLine(`line-${String(i + 1).padStart(3, '0')}`));
    const { root, home } = await setup([ORCH], { main: lines });

    const latest = await readAgentLog(root, 'demo', undefined, home);
    const middle = await readAgentLog(root, 'demo', undefined, home, latest.olderCursor!);
    const oldest = await readAgentLog(root, 'demo', undefined, home, middle.olderCursor!);

    expect(latest.agents[0].entries).toHaveLength(100);
    expect(middle.agents[0].entries).toHaveLength(100);
    expect(oldest.agents[0].entries).toHaveLength(50);
    expect(latest.hasOlder).toBe(true);
    expect(middle.hasOlder).toBe(true);
    expect(oldest.hasOlder).toBe(false);
    expect(oldest.olderCursor).toBeNull();
    expect(latest.olderCursor).not.toContain('wire.jsonl');
    expect(latest.olderCursor).not.toContain('/');

    const entries = [...oldest.agents[0].entries, ...middle.agents[0].entries, ...latest.agents[0].entries];
    expect(entries.map((entry) => entry.text)).toEqual(lines.map((_, i) => `line-${String(i + 1).padStart(3, '0')}`));
    expect(new Set(entries.map((entry) => entry.at)).size).toBe(1);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(250);
  });

  it('keeps complete entries across chunk, UTF-8, and torn JSON boundaries', async () => {
    const lines = Array.from({ length: 105 }, (_, i) => textLine(
      `line-${String(i + 1).padStart(3, '0')}-😀-${'x'.repeat(3000)}`,
    ));
    lines.splice(50, 0, '{"torn json"');
    lines.push('{"type":"context.append_loop_event"');
    const { root, home } = await setup([ORCH], { main: lines });

    const latest = await readAgentLog(root, 'demo', undefined, home);
    const older = await readAgentLog(root, 'demo', undefined, home, latest.olderCursor!);

    expect(latest.agents[0].entries.map((entry) => entry.text.slice(0, 8))).toEqual(
      Array.from({ length: 100 }, (_, i) => `line-${String(i + 6).padStart(3, '0')}`),
    );
    expect(older.agents[0].entries.map((entry) => entry.text.slice(0, 8))).toEqual([
      'line-001', 'line-002', 'line-003', 'line-004', 'line-005',
    ]);
    expect(latest.agents[0].entries.every((entry) => entry.text.includes('😀'))).toBe(true);
    expect(latest.agents[0].entries.every((entry) => entry.text.length === 501)).toBe(true);
  });

  it('skips a newline-less JSON record that spans many read chunks', async () => {
    const oversized = textLine('x'.repeat(3 * 256 * 1024));
    const { root, home } = await setup([ORCH], { main: [textLine('before'), oversized, textLine('after')] });

    const log = await readAgentLog(root, 'demo', undefined, home);

    expect(log.agents[0].entries.map((entry) => entry.text)).toEqual(['before', 'after']);
    expect(log.hasOlder).toBe(false);
    expect(log.olderCursor).toBeNull();
  });

  it('never emits a valid JSON prefix with over-limit trailing whitespace', async () => {
    const oversized = `${textLine('fragment-must-not-appear')}${' '.repeat(3 * 256 * 1024)}`;
    const { root, home } = await setup([ORCH], { main: [textLine('before'), oversized, textLine('after')] });

    const log = await readAgentLog(root, 'demo', undefined, home);

    expect(log.agents[0].entries.map((entry) => entry.text)).toEqual(['before', 'after']);
    expect(JSON.stringify(log)).not.toContain('fragment-must-not-appear');
  });

  it('refuses a cursor substituted across sessions', async () => {
    const team = [ORCH, { name: 'fixer', session_id: 'session_other', worktree: '/wt/a' }];
    const lines = Array.from({ length: 101 }, (_, i) => textLine(`line-${i}`));
    const { root, home } = await setup(team, { main: lines });
    const otherDir = path.join(
      home, '.kimi-code', 'sessions', 'wd_demo_000000000000', 'session_other', 'agents', 'main',
    );
    await fs.mkdir(otherDir, { recursive: true });
    await fs.writeFile(path.join(otherDir, 'wire.jsonl'), `${textLine('other session')}\n`);
    const latest = await readAgentLog(root, 'demo', undefined, home);

    await expect(readAgentLog(root, 'demo', 'fixer', home, latest.olderCursor!)).rejects.toThrow(/stale or invalid/);
  });

  it('refuses cursors after a same-size anchor rewrite and renamed file replacement', async () => {
    const lines = Array.from({ length: 101 }, (_, i) => textLine(`original-${i}`));
    const { root, home } = await setup([ORCH], { main: lines });
    const file = path.join(
      home, '.kimi-code', 'sessions', 'wd_demo_000000000000', 'session_abc', 'agents', 'main', 'wire.jsonl',
    );
    const latest = await readAgentLog(root, 'demo', undefined, home);

    const rewritten = Array.from({ length: 101 }, (_, i) => textLine(`modified-${i}`));
    expect(Buffer.byteLength(rewritten.join('\n'))).toBe(Buffer.byteLength(lines.join('\n')));
    await fs.writeFile(file, `${rewritten.join('\n')}\n`);
    await expect(readAgentLog(root, 'demo', undefined, home, latest.olderCursor!)).rejects.toThrow(/stale or invalid/);

    const replacement = `${file}.replacement`;
    await fs.writeFile(replacement, `${lines.join('\n')}\n`);
    await fs.rename(replacement, file);
    await expect(readAgentLog(root, 'demo', undefined, home, latest.olderCursor!)).rejects.toThrow(/stale or invalid/);
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
