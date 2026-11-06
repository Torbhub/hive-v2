import { randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { approveEvidenceExport, cleanupEvidence, cleanupManifest, cleanupWorkspace, exportEvidence, verifyEvidenceExport } from './evidence.js';
import { TeamKimiAdapter, issueGenerationCredential, revokeAndVerifySmokeCredential, validateControls, withSmokeRevocation, type HiveControlEvidence } from './broker.js';
import { HermesProcessSupervisor } from './process.js';
import { EXPECTED_MODEL, runT01Matrix } from './runner.js';
import { smokePolicyHash } from './policy.js';

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function readJson(path: string): Promise<unknown> {
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
  if (action === 'validate-policy') {
    const attestation = await readJson(option('--attestation') ?? '');
    if (smokePolicyHash(attestation) !== option('--expected-policy-hash')) throw new Error('policy-hash-mismatch');
    return;
  }
  if (action === 'verify') {
    const manifest = option('--manifest') ?? '';
    const attestationPath = option('--attestation') ?? '';
    const expectedPolicyHash = option('--expected-policy-hash') ?? '';
    const credentialId = option('--credential-id') ?? '';
    await verifyEvidenceExport(manifest, { attestation: await readJson(attestationPath), expectedPolicyHash, credentialId });
    console.log('T01 evidence verified.');
    return;
  }
  if (action !== 'preflight' && action !== 'run') throw new Error('unknown-action');
  const paidAuthorization = action === 'run'
    && process.argv.includes('--paid-admissions-authorized')
    && process.env.HIVE_T01_AUTHORIZE_PAID_ADMISSIONS === 'yes';
  if (action === 'run' && !paidAuthorization) throw new Error('paid-admissions-not-authorized');
  const preflightCredential = action === 'preflight' ? process.env.HIVE_T01_SMOKE_CREDENTIAL : undefined;
  const preflightCredentialId = action === 'preflight' ? process.env.HIVE_T01_SMOKE_CREDENTIAL_ID : undefined;
  const brokerUrl = process.env.HIVE_T01_BROKER_URL;
  const proxyApiKey = action === 'run' ? process.env.HIVE_T01_PROXY_KEY : undefined;
  const artifactRoot = option('--artifacts');
  const controlsPath = option('--controls');
  const attestationPath = option('--attestation');
  const expectedPolicyHash = option('--expected-policy-hash');
  if (!brokerUrl || !artifactRoot || !controlsPath || !attestationPath || !expectedPolicyHash
    || action === 'preflight' && (!preflightCredential || !preflightCredentialId)
    || action === 'run' && !proxyApiKey) throw new Error('missing-runtime-configuration');
  delete process.env.HIVE_T01_SMOKE_CREDENTIAL;
  delete process.env.HIVE_T01_PROXY_KEY;
  const runWithCredential = async (credential: string, credentialId: string, attestation: unknown, controls: HiveControlEvidence, attemptKey?: string) => {
    const adapter = new TeamKimiAdapter({ baseUrl: brokerUrl, credential, credentialId, attemptKey, proxyApiKey, controls, attestation, expectedPolicyHash });
    await adapter.start();
    try {
      const report = await runT01Matrix({
        process: new HermesProcessSupervisor(), broker: adapter, brokerUrl,
        model: process.env.HIVE_T01_MODEL ?? EXPECTED_MODEL,
        workspace: option('--workspace'), hermesPath: option('--hermes'), hermesUser: option('--hermes-user'),
        pythonPath: option('--python'), expectedPolicyHash,
        preflightOnly: action === 'preflight', paidAuthorization,
      });
      const manifest = await exportEvidence(artifactRoot, report);
      console.log(`T01 ${action}: ${report.state}. Review manifest: ${manifest}`);
      if (report.state !== 'completed') process.exitCode = 1;
    } finally {
      await adapter.close();
    }
  };
  if (action === 'preflight') {
    await withSmokeRevocation({ baseUrl: brokerUrl, credentialId: preflightCredentialId! }, async () => {
      await runWithCredential(
        preflightCredential!, preflightCredentialId!, await readJson(attestationPath), await readJson(controlsPath) as HiveControlEvidence,
      );
    });
    return;
  }
  const attemptKey = randomBytes(32).toString('hex');
  let issuedId: string | undefined;
  try {
    const attestation = await readJson(attestationPath);
    if (smokePolicyHash(attestation) !== expectedPolicyHash) throw new Error('policy-hash-mismatch');
    const controls = await readJson(controlsPath) as HiveControlEvidence;
    validateControls(controls);
    const issued = await issueGenerationCredential(brokerUrl, attemptKey, proxyApiKey!);
    issuedId = issued.id;
    await runWithCredential(issued.credential, issued.id, attestation, controls, attemptKey);
  } finally {
    if (issuedId) await revokeAndVerifySmokeCredential(brokerUrl, issuedId, attemptKey, proxyApiKey);
  }
}

main().catch(() => {
  console.error('T01 stopped without exporting unsanitized errors.');
  process.exitCode = 1;
});
