import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXPECTED_MODEL, SCENARIOS, type T01Report } from './runner.js';
import { sameCountedInput, smokeAttestation, smokePolicyHash, usageCostMicros, usageEvidence } from './policy.js';

const SAFE_TOOLS = new Set(['read_file', 't01:echo', 't01:sleep']);
const SAFE_ACTIVITIES = new Set(['t01_observer', 't01_pre_tool']);
const SAFE_STATES = new Set([
  'queued', 'running', 'cleanup-pending', 'succeeded', 'failed', 'unknown', 'cancelling', 'cancelled',
  'completed', 'aborted', 'finalized', 'open', 'reserved', 'reconciled', 'ambiguous',
]);
const SAFE_STATUSES = new Set([
  'completed', 'failed', 'interrupted', 'running', 'missing', 'conflicting', 'present', 'invalid',
  'pending', 'approved', 'reserved', 'reconciled', 'ambiguous', 'succeeded',
]);
const SAFE_KINDS = new Set([
  'system', 'text', 'tool_use', 'tool_result', 'result', 'stdout', 'stderr', 'eof', 'exit', 'deadline', 'cancel',
  'forced-stop', 'receipt', 'parser-error', 'malformed-json', 'truncated-json', 'invalid-utf8', 'truncated-utf8',
  'invalid-schema', 'line-too-large', 'event-limit',
]);
const SAFE_ERRORS = new Set([
  'provider', 'provider-limit', 'authentication', 'cancelled', 'timeout', 'invalid-request', 'policy', 'other',
  'pricing_unverified', 'policy_mismatch', 'provider_accounting_unverified', 'provider_input_accounting_unverified',
  'provider_event_malformed', 'provider_terminal_evidence_conflict', 'provider_terminal_evidence_missing',
  'scenario_ceiling_exceeded', 'matrix_ceiling_exceeded', 'upstream_outcome_ambiguous', 'client_detached',
  'ledger_unavailable', 'smoke_internal_error',
]);
const ALLOWED_KEYS = new Set([
  'schemaVersion', 'state', 'abortReason', 'pin', 'version', 'commit', 'routeHash', 'preflight', 'installation',
  'artifactHash', 'lockedDependenciesHash', 'registryHashes', 'readiness', 'runs', 'revocation', 'revoked', 'receiptId',
  'scenarioId', 'admissionId', 'requestHash', 'admissionRequestHash', 'generation', 'policyHash', 'trace', 'events',
  'reconciliation', 'registryHash', 'deniedNetworkAttempts', 'parserErrors', 'stdout', 'stderr', 'usageFile', 'activities',
  'id', 'idSha256', 'resultSha256', 'usage', 'receipt', 'session', 'sessionId', 'sessionIdSha256', 'process', 'cancellation',
  'sequence', 'kind', 'offset', 'length', 'evidenceHash', 'signal', 'sha256', 'bytes', 'terminalTransitions', 'fenced',
  'exitCode', 'interruptedReceipt', 'result', 'type', 'timestamp', 'subtype', 'model', 'modelSha256', 'textSha256',
  'textBytes', 'late', 'name', 'nameSha256', 'toolCallSha256', 'inputSha256', 'outputSha256', 'outputBytes',
  'durationMs', 'isError', 'errorCategory', 'tokens', 'replayGap', 'input', 'output', 'total', 'cache_read', 'cache_write',
  'status', 'callCount', 'rowCount', 'childSessionCount', 'updatedAt', 'pid', 'pgid', 'startTimeTicks', 'reaped', 'inputVerified',
  'signals', 'requested', 'provider', 'credential', 'smokeOnly', 'shortLived', 'isolatedFromHermes', 'enforcement',
  'atomicReservations', 'sharedLedger', 'modelCeiling', 'tokenCeiling', 'dollarCeiling', 'pricingVerified',
  'admissionAllowed', 'blockedReason', 'isolation', 'disposable', 'readOnlyFixtures', 'confinedWorkingDirectories',
  'noPrivilegedMode', 'noHostNetwork', 'noHostPid', 'noContainerSockets', 'noCredentialMounts', 'noWritableHostPaths',
  'noOnDemandInstalls', 'coreDumpsDisabled', 'debuggingDisabled', 'ceilings', 'scenario', 'matrix', 'admissions',
  'inputTokens', 'baseInputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens',
  'cacheCreation5mInputTokens', 'cacheCreation1hInputTokens', 'countedInput', 'providerSemantics',
  'maxTokens', 'thinking', 'outputTokens', 'reasoningTokens', 'totalTokens', 'costMicros', 'egress', 'defaultDeny',
  'approvedDestination', 'directIpDenied', 'unapprovedDnsDenied', 'redirectDenied', 'ipv6Denied', 'alternatePortDenied',
  'metadataDenied', 'files', 'path', 'workspace', 'review', 'reviewer', 'reviewedAt', 'createdAt', 'deleteAfter', 'cleanupAfter', 'proof',
  'credentialId', 'revokedAt', 'scope', 'verified',
  'P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10', 'P11', 'P12',
]);
const HASH_KEYS = new Set([
  'artifactHash', 'lockedDependenciesHash', 'routeHash', 'policyHash', 'requestHash', 'admissionRequestHash',
  'sha256', 'registryHash', 'evidenceHash', 'textSha256', 'toolCallSha256', 'inputSha256', 'outputSha256',
  'resultSha256', 'sessionIdSha256', 'modelSha256', 'nameSha256', 'idSha256', 'proof',
]);
const OBJECT_KEYS = new Set([
  'pin', 'preflight', 'installation', 'registryHashes', 'readiness', 'revocation', 'stdout', 'stderr', 'usage',
  'usageFile', 'receipt', 'session', 'process', 'cancellation', 'result', 'tokens', 'credential', 'reconciliation',
  'countedInput', 'providerSemantics', 'isolation', 'enforcement', 'ceilings', 'scenario', 'matrix', 'egress', 'review', 'workspace',
]);
const COLLECTION_CAPS: Record<string, number> = {
  runs: 12, trace: 8192, events: 4096, parserErrors: 64, activities: 128, signals: 32, files: 32,
};
const SAFE_ABORT = /^(preflight-or-runner-error|ambiguous-outcome|revocation-failed|resume-[a-z-]+)$/;

function hashed(value: string | Uint8Array) {
  return createHash('sha256').update(value).digest('hex');
}

function stringValue(key: string, value: string) {
  if (value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('unsafe-evidence-string');
  switch (key) {
    case 'sessionId': return { key: 'sessionIdSha256', value: hashed(value) };
    case 'model': return value === EXPECTED_MODEL ? { key, value } : { key: 'modelSha256', value: hashed(value) };
    case 'name': return SAFE_TOOLS.has(value) ? { key, value } : { key: 'nameSha256', value: hashed(value) };
    case 'id': return SAFE_ACTIVITIES.has(value) ? { key, value } : { key: 'idSha256', value: hashed(value) };
    case 'state': if (!SAFE_STATES.has(value)) throw new Error('unsafe-state'); return { key, value };
    case 'status': if (!SAFE_STATUSES.has(value)) throw new Error('unsafe-status'); return { key, value };
    case 'kind': case 'type': case 'subtype': case 'signal': if (!SAFE_KINDS.has(value) && !['SIGINT', 'SIGKILL', 'SIGTERM', 'SIGHUP', 'init'].includes(value)) throw new Error('unsafe-kind'); return { key, value };
    case 'errorCategory': return { key, value: SAFE_ERRORS.has(value) ? value : 'other' };
    case 'provider': if (value !== 'TeamKimi') throw new Error('unsafe-provider'); return { key, value };
    case 'version': if (value !== '0.22.6') throw new Error('unsafe-version'); return { key, value };
    case 'commit': if (!/^[a-f0-9]{40}$/.test(value)) throw new Error('unsafe-commit'); return { key, value };
    case 'scenarioId': if (!/^P(0[1-9]|1[0-2])$/.test(value)) throw new Error('unsafe-scenario'); return { key, value };
    case 'admissionId': case 'receiptId': case 'credentialId': if (!/^[A-Za-z0-9._:-]{1,256}$/.test(value)) throw new Error('unsafe-identifier'); return { key, value };
    case 'scope': if (!['generation', 'count-only'].includes(value)) throw new Error('unsafe-credential-scope'); return { key, value };
    case 'reviewer': if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error('unsafe-reviewer'); return { key, value };
    case 'path': if (!/^(manifest|preflight|P(0[1-9]|1[0-2]))\.json$/.test(value) && !(value.startsWith('/') && !value.includes('..'))) throw new Error('unsafe-path'); return { key, value };
    case 'createdAt': case 'deleteAfter': case 'reviewedAt': case 'updatedAt': case 'cleanupAfter': if (!Number.isFinite(Date.parse(value))) throw new Error('unsafe-time'); return { key, value };
    case 'abortReason': if (!SAFE_ABORT.test(value)) throw new Error('unsafe-abort-reason'); return { key, value };
    default: return { key, value };
  }
}

function sanitized(value: unknown, parent?: string, depth = 0, grandparent?: string): unknown {
  if (value === undefined) return undefined;
  if (depth > 16) throw new Error('evidence-nesting-too-deep');
  const semanticsUsage = parent === 'usage' && grandparent === 'providerSemantics' && typeof value === 'string';
  if (!semanticsUsage && parent && OBJECT_KEYS.has(parent) && (typeof value !== 'object' || value === null || Array.isArray(value))) throw new Error('invalid-evidence-object');
  if (parent && HASH_KEYS.has(parent) && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) throw new Error('invalid-evidence-hash');
  if (parent === 'registryHashes' && typeof value === 'string' && !/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid-registry-hash');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return stringValue(parent ?? '', value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite-evidence');
    return value;
  }
  if (Array.isArray(value)) {
    const cap = COLLECTION_CAPS[parent ?? ''] ?? 128;
    if (value.length > cap) throw new Error('evidence-collection-too-large');
    return value.map((entry) => {
      const clean = sanitized(entry, parent, depth + 1, grandparent);
      if (typeof clean === 'object' && clean !== null && 'key' in clean && 'value' in clean) {
        return (clean as { value: string }).value;
      }
      return clean;
    });
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('unstructured-evidence');
  const entries = Object.entries(value);
  if (entries.length > 128) throw new Error('evidence-object-too-large');
  const output: Record<string, unknown> = {};
  for (const [key, entry] of entries) {
    if (!ALLOWED_KEYS.has(key)) throw new Error(`non-allowlisted-evidence:${key}`);
    const clean = sanitized(entry, key, depth + 1, parent);
    if (clean === undefined) continue;
    if (typeof clean === 'object' && clean !== null && 'key' in clean && 'value' in clean) {
      const transformed = clean as { key: string; value: string };
      output[transformed.key] = transformed.value;
    } else output[key] = clean;
  }
  return output;
}

async function writeSecure(path: string, value: unknown) {
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(sanitized(value), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function exportEvidence(root: string, report: T01Report) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const createdAt = new Date();
  const files: { path: string; sha256: string }[] = [];
  const write = async (name: string, value: unknown) => {
    await writeSecure(join(root, name), value);
    const bytes = await readFile(join(root, name));
    files.push({ path: name, sha256: hashed(bytes) });
  };
  await write('preflight.json', {
    schemaVersion: report.schemaVersion, state: report.state, abortReason: report.abortReason,
    pin: report.pin, routeHash: report.routeHash, preflight: report.preflight, revocation: report.revocation,
    workspace: report.workspace,
  });
  for (const run of report.runs) await write(`${run.scenarioId}.json`, run);
  const manifestPath = join(root, 'manifest.json');
  await writeSecure(manifestPath, {
    schemaVersion: 1,
    createdAt: createdAt.toISOString(),
    deleteAfter: new Date(createdAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    state: report.state,
    workspace: report.workspace,
    files,
    review: { status: 'pending' },
  });
  return manifestPath;
}

export type VerifyEvidenceOptions = { attestation: unknown; expectedPolicyHash: string; credentialId: string };

export function verifyEvidenceReport(report: T01Report, options: VerifyEvidenceOptions) {
  const attestation = smokeAttestation(options.attestation, Date.now());
  if (smokePolicyHash(attestation) !== options.expectedPolicyHash
    || report.preflight.readiness?.enforcement.policyHash !== options.expectedPolicyHash) throw new Error('policy-hash-mismatch');
  if (report.schemaVersion !== 1 || report.state !== 'completed' || report.runs.length !== SCENARIOS.length) throw new Error('scenario-outcome');
  const scenarioIds = new Set(report.runs.map((run) => run.scenarioId));
  for (const scenario of SCENARIOS) {
    if (!scenarioIds.has(scenario.id)) throw new Error('scenario-outcome');
    const run = report.runs.find((entry) => entry.scenarioId === scenario.id)!;
    const expectedState = scenario.id === 'P07' ? 'failed' : ['P08', 'P09', 'P10'].includes(scenario.id) ? 'cancelled' : 'succeeded';
    const expectedReceipt = scenario.id === 'P07' ? 'failed' : ['P08', 'P09', 'P10'].includes(scenario.id) ? 'interrupted' : 'completed';
    if (run.state !== expectedState || run.receipt?.status !== expectedReceipt) throw new Error('scenario-outcome');
    const usage = run.receipt.usage;
    if (run.receipt.policyHash !== options.expectedPolicyHash || run.receipt.inputVerified !== true || !usage
      || !sameCountedInput(run.receipt.countedInput, usage)) throw new Error('receipt-accounting-mismatch');
    usageEvidence(usage);
    if (usageCostMicros(usage, attestation.rates) !== usage.costMicros) throw new Error('receipt-cost-mismatch');
  }
  const revocation = report.revocation;
  if (!revocation || revocation.revoked !== true || revocation.verified !== true || revocation.scope !== 'generation'
    || revocation.credentialId !== options.credentialId || revocation.receiptId !== options.credentialId
    || !/^[a-f0-9]{32}$/.test(revocation.credentialId || '') || !/^[a-f0-9]{64}$/.test(revocation.proof)
    || !Number.isSafeInteger(revocation.revokedAt) || (revocation.revokedAt ?? -1) < 0) throw new Error('revocation-not-proven');
  return { verified: true as const };
}

export async function verifyEvidenceExport(manifestPath: string, options: VerifyEvidenceOptions) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    state: string; review: { status: string }; files: { path: string; sha256: string }[];
  };
  if (manifest.state !== 'completed' || manifest.review.status !== 'pending') throw new Error('evidence-not-complete');
  const root = join(manifestPath, '..');
  const expected = new Set(['manifest.json', 'preflight.json', ...SCENARIOS.map((scenario) => `${scenario.id}.json`)]);
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length !== expected.size || entries.some((entry) => !entry.isFile() || !expected.has(entry.name)
    || entry.name !== 'manifest.json' && !manifest.files.some((file) => file.path === entry.name))) {
    throw new Error('evidence-manifest-membership-mismatch');
  }
  for (const file of [{ path: 'manifest.json', sha256: hashed(await readFile(manifestPath)) }, ...manifest.files]) {
    const path = join(root, file.path);
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o777) !== 0o600) throw new Error('unsafe-evidence-artifact');
    const bytes = await readFile(path);
    if (file.path !== 'manifest.json' && hashed(bytes) !== file.sha256) throw new Error('evidence-hash-mismatch');
    sanitized(JSON.parse(bytes.toString('utf8')));
  }
  const preflight = JSON.parse(await readFile(join(root, 'preflight.json'), 'utf8'));
  const runs = await Promise.all(SCENARIOS.map(async (scenario) => JSON.parse(await readFile(join(root, `${scenario.id}.json`), 'utf8'))));
  return verifyEvidenceReport({ ...preflight, runs } as T01Report, options);
}

export async function approveEvidenceExport(manifestPath: string, reviewer: string) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(reviewer)) throw new Error('invalid-reviewer');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    review: { status: string };
    files: { path: string; sha256: string }[];
  };
  if (manifest.review.status !== 'pending' || manifest.files.length > 32) throw new Error('evidence-review-not-pending');
  const root = join(manifestPath, '..');
  const expected = new Set(['manifest.json', ...manifest.files.map((file) => file.path)]);
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.length !== expected.size || entries.some((entry) => !entry.isFile() || !expected.has(entry.name))) {
    throw new Error('evidence-manifest-membership-mismatch');
  }
  for (const file of manifest.files) {
    const path = join(root, file.path);
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o777) !== 0o600) throw new Error('unsafe-evidence-artifact');
    const bytes = await readFile(path, 'utf8');
    if (hashed(bytes) !== file.sha256) throw new Error('evidence-hash-mismatch');
    sanitized(JSON.parse(bytes));
  }
  await writeSecure(manifestPath, { ...manifest, review: { status: 'approved', reviewer, reviewedAt: new Date().toISOString() } });
}

async function overwrite(path: string, size: number) {
  await chmod(path, 0o600);
  const handle = await open(path, 'r+');
  try {
    for (let offset = 0; offset < size; offset += 64 * 1024) {
      const length = Math.min(64 * 1024, size - offset);
      await handle.write(randomBytes(length), 0, length, offset);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function cleanupEvidence(root: string, now = Date.now()) {
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;
  const names = await readdir(root);
  if (names.length > 64) throw new Error('evidence-cleanup-cap');
  for (const name of names) {
    const path = join(root, name);
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink() || details.mtimeMs > cutoff) throw new Error('unsafe-evidence-cleanup-path');
  }
  for (const name of names) {
    const path = join(root, name);
    await overwrite(path, (await lstat(path)).size);
    await unlink(path);
  }
}

export async function cleanupWorkspace(root: string, now = Date.now()) {
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;
  const files: { path: string; size: number; symlink: boolean }[] = [];
  const directories: string[] = [];
  const visit = async (directory: string) => {
    if (directories.length >= 64) throw new Error('workspace-cleanup-cap');
    directories.push(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > 1024) throw new Error('workspace-cleanup-cap');
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const details = await lstat(path);
      if (details.mtimeMs > cutoff) throw new Error('workspace-retention-active');
      if (entry.isSymbolicLink()) files.push({ path, size: 0, symlink: true });
      else if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push({ path, size: details.size, symlink: false });
      else throw new Error('unsafe-workspace-entry');
    }
  };
  await visit(root);
  for (const directory of directories) await chmod(directory, 0o700);
  for (const file of files) {
    if (!file.symlink) await overwrite(file.path, file.size);
    await unlink(file.path);
  }
  for (const directory of directories.reverse()) await rmdir(directory);
}

export async function cleanupManifest(manifestPath: string, now = Date.now()) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { workspace: { path: string } };
  if (typeof manifest.workspace?.path !== 'string' || !manifest.workspace.path.startsWith('/')) throw new Error('missing-workspace-registration');
  await cleanupWorkspace(manifest.workspace.path, now);
  await cleanupEvidence(join(manifestPath, '..'), now);
}
