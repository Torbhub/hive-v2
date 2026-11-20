import {
  listNativeBranches,
  nativeBranchDetail as detail,
  nativeBranchSummary as summary,
  readNativeBranch,
  rejoinNativeBranch,
  reviewNativeBranch,
} from '../src/branches.js';
import { checkName } from '../src/names.js';
import { createNativeBranchClient } from '../src/native-client.js';
import type { Registry } from '../src/registry.js';
import { AuthorizationError, authorize, type Principal } from '../src/security.js';
import { Refusal } from '../src/state.js';
import type {
  NativeBranchDetail,
  NativeBranchRecord,
  NativeBranchSummary,
} from '../src/types.js';
import { HttpError } from './http-error.js';

function projectName(value: unknown): string {
  try {
    return checkName('project', String(value ?? ''));
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  }
}

export async function branchListResponse(
  root: string,
  registry: Registry,
  principal: Principal,
  projectValue: unknown,
): Promise<{ ok: true; branches: NativeBranchSummary[] }> {
  const project = projectName(projectValue);
  let records: NativeBranchRecord[];
  try {
    records = await listNativeBranches(root, project);
  } catch {
    throw new AuthorizationError('not found');
  }
  const branches: NativeBranchSummary[] = [];
  for (const record of records) {
    if (record.scope.project !== project) continue;
    try {
      await authorize(principal, registry, 'read', { project, task: record.scope.task });
      branches.push(summary(record));
    } catch (error) {
      if (!(error instanceof AuthorizationError)) throw error;
    }
  }
  return { ok: true, branches };
}

async function readForWeb(root: string, project: string, id: string): Promise<NativeBranchRecord> {
  try {
    return await readNativeBranch({ root, project }, id);
  } catch {
    throw new AuthorizationError('not found');
  }
}

export async function branchDetailResponse(
  root: string,
  registry: Registry,
  principal: Principal,
  projectValue: unknown,
  id: string,
): Promise<{ ok: true; branch: NativeBranchDetail }> {
  const project = projectName(projectValue);
  const record = await readForWeb(root, project, id);
  await authorize(principal, registry, 'read', { project, task: record.scope.task });
  return { ok: true, branch: detail(record) };
}

export async function storedBranchMutationScope(
  root: string,
  body: Record<string, unknown>,
): Promise<{ project: string; task: string }> {
  const project = projectName(body.project);
  const record = await readForWeb(root, project, String(body.branch ?? ''));
  return { project, task: record.scope.task };
}

function exactFields(body: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new Refusal(`native branch request: unknown field ${key}`);
  }
}

export async function handleBranchAction(
  root: string,
  pathname: string,
  body: Record<string, unknown>,
  principal: Principal,
  registry?: Registry,
): Promise<unknown | null> {
  if (pathname !== '/api/branch-review' && pathname !== '/api/branch-rejoin') return null;
  if (!registry) throw new HttpError(404, 'not found');
  const project = projectName(body.project);
  const id = String(body.branch ?? '');
  const scope = { root, project };
  if (pathname === '/api/branch-review') {
    exactFields(body, ['project', 'branch', 'findingIds']);
    if (!Array.isArray(body.findingIds) || body.findingIds.some((findingId) => typeof findingId !== 'string')) {
      throw new Refusal('native branch review findingIds is invalid');
    }
    const native = createNativeBranchClient();
    const record = await reviewNativeBranch(scope, id, {
      findingIds: body.findingIds as string[], principal, registry,
    }, native);
    return { ok: true, branch: detail(record) };
  }
  exactFields(body, ['project', 'branch', 'reviewDigest']);
  if (typeof body.reviewDigest !== 'string') throw new Refusal('native review digest is required');
  const native = createNativeBranchClient();
  const record = await rejoinNativeBranch(scope, id, {
    principal, registry, reviewDigest: body.reviewDigest,
  }, native);
  return { ok: true, branch: detail(record) };
}
