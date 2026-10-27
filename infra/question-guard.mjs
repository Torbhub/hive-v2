#!/usr/bin/env node
if (process.env.HIVE_AGENT) {
  console.error('Native AskUserQuestion is disabled for Hive agents. Use mcp__hive-operator__ask_operator instead.');
  process.exit(2);
}
process.exit(0);
