#!/usr/bin/env node
if (process.env.HIVE_AGENT) {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    console.error('Hive could not inspect this tool call. Retry with a valid tool payload.');
    process.exit(2);
  }
  if (payload.tool_name === 'Bash') {
    const command = payload.tool_input?.command;
    const ffmpeg = /\bffmpeg\b/;
    if (typeof command === 'string' && ffmpeg.test(command)) {
      console.error('Hive agents must not run ffmpeg on this host. Rent a compute machine for media processing and run it there.');
      process.exit(2);
    }
    process.exit(0);
  }
  console.error('Native AskUserQuestion is disabled for Hive agents. Use mcp__hive-operator__ask_operator instead.');
  process.exit(2);
}
process.exit(0);
