import { open } from 'node:fs/promises';
import { approveEvidenceExport, cleanupEvidence, cleanupManifest, cleanupWorkspace, exportEvidence } from './evidence.js';
import { TeamKimiAdapter, type HiveControlEvidence } from './broker.js';
import { HermesProcessSupervisor } from './process.js';
import { EXPECTED_MODEL, runT01Matrix } from './runner.js';

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function controls(path: string): Promise<HiveControlEvidence> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 64 * 1024) throw new Error('controls-too-large');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as HiveControlEvidence;
  } finally {
    await handle.close();
  }
}

async function main() {
  const action = process.argv[2] ?? 'preflight';
  if (action === 'review') {
    await approveEvidenceExport(option('--manifest') ?? '', option('--reviewer') ?? '');
    console.log('Evidence review approved.');
    return;
  }
  if (action === 'cleanup') {
    const manifest = option('--manifest');
    if (manifest) await cleanupManifest(manifest);
    else {
      await cleanupEvidence(option('--root') ?? '');
      const workspace = option('--workspace');
      if (workspace) await cleanupWorkspace(workspace);
    }
    console.log('Expired evidence destroyed.');
    return;
  }
  if (action !== 'preflight' && action !== 'run') throw new Error('unknown-action');
  const paidAuthorization = action === 'run'
    && process.argv.includes('--paid-admissions-authorized')
    && process.env.HIVE_T01_AUTHORIZE_PAID_ADMISSIONS === 'yes';
  if (action === 'run' && !paidAuthorization) throw new Error('paid-admissions-not-authorized');
  const credential = process.env.HIVE_T01_SMOKE_CREDENTIAL;
  const brokerUrl = process.env.HIVE_T01_BROKER_URL;
  const artifactRoot = option('--artifacts');
  const controlsPath = option('--controls');
  if (!credential || !brokerUrl || !artifactRoot || !controlsPath) throw new Error('missing-runtime-configuration');
  delete process.env.HIVE_T01_SMOKE_CREDENTIAL;
  const adapter = new TeamKimiAdapter({ baseUrl: brokerUrl, credential, controls: await controls(controlsPath) });
  await adapter.start();
  try {
    const report = await runT01Matrix({
      process: new HermesProcessSupervisor(),
      broker: adapter,
      brokerUrl,
      model: process.env.HIVE_T01_MODEL ?? EXPECTED_MODEL,
      workspace: option('--workspace'),
      hermesPath: option('--hermes'),
      pythonPath: option('--python'),
      preflightOnly: action === 'preflight',
      paidAuthorization,
    });
    const manifest = await exportEvidence(artifactRoot, report);
    console.log(`T01 ${action}: ${report.state}. Review manifest: ${manifest}`);
  } finally {
    await adapter.close();
  }
}

main().catch(() => {
  console.error('T01 stopped without exporting unsanitized errors.');
  process.exitCode = 1;
});
