import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = readFileSync(fileURLToPath(new URL('../infra/deploy-box.sh', import.meta.url)), 'utf8');
const healthCheck = script.slice(script.indexOf('SECRET='));

function runHealthCheck(collaboration: string, authCode: string, noAuthCode: string) {
  const bin = mkdtempSync(path.join(tmpdir(), 'hive-deploy-health-'));
  const stubs = {
    sed: `#!/bin/bash
case "$*" in
  *HIVE_WEB_SECRET*) printf '%s\\n' test-secret ;;
  *HIVE_COLLABORATION_ENABLED*) printf '%s\\n' "$COLLABORATION" ;;
  *) exit 1 ;;
esac
`,
    curl: `#!/bin/bash
case " $* " in
  *" x-hive-auth: "*) printf '%s' "$AUTH_CODE" ;;
  *) printf '%s' "$NO_AUTH_CODE" ;;
esac
`,
    sleep: '#!/bin/bash\n',
  };
  for (const [name, source] of Object.entries(stubs)) {
    const file = path.join(bin, name);
    writeFileSync(file, source);
    chmodSync(file, 0o755);
  }
  return spawnSync('bash', ['-c', healthCheck], {
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      SHA: 'test-sha',
      COLLABORATION: collaboration,
      AUTH_CODE: authCode,
      NO_AUTH_CODE: noAuthCode,
    },
    encoding: 'utf8',
  });
}

describe('deploy health check', () => {
  it('keeps legacy transport-auth expectations when collaboration is off', () => {
    const result = runHealthCheck('', '200', '403');
    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('PASS: auth header -> 200');
    expect(result.stdout).toContain('PASS: no auth header -> 403');
  });

  it('expects bearer authentication when collaboration is on', () => {
    const result = runHealthCheck('1', '401', '403');
    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('PASS: auth header -> 401');
    expect(result.stdout).toContain('PASS: no auth header -> 403');
  });
});
