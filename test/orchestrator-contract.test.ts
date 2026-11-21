import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateRootContract } from '../src/state.js';
import type { RootContract } from '../src/types.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const skill = readFileSync(path.join(root, 'skills', 'start', 'SKILL.md'), 'utf8');
const role = readFileSync(path.join(root, 'roles', 'orchestrator.md'), 'utf8');

function examples(): Record<string, RootContract> {
  return Object.fromEntries([...skill.matchAll(/```json (build|research)-contract\n([\s\S]*?)```/g)]
    .map((match) => [match[1], JSON.parse(match[2]) as RootContract]));
}

describe('orchestrator root contract examples', () => {
  it('provides one valid canonical build and research example', () => {
    const contracts = examples();
    expect(skill.match(/```json build-contract/g)).toHaveLength(1);
    expect(skill.match(/```json research-contract/g)).toHaveLength(1);
    expect(Object.keys(contracts).sort()).toEqual(['build', 'research']);
    for (const contract of Object.values(contracts)) {
      expect(() => validateRootContract(contract)).not.toThrow();
    }
    expect(contracts.build.kind).toBe('build');
    expect(contracts.research.kind).toBe('research');
  });

  it('makes the research receipt viable for its admitted artifact scope', async () => {
    const contract = examples().research;
    const acceptance = contract.acceptance.find((candidate) => candidate.predicate_id === 'task_receipt');
    expect(acceptance).toBeDefined();
    const configuration = acceptance!.configuration;
    expect(configuration.output_claim).toBe(contract.deliverable);
    expect(configuration.artifact_path).toBe('reports/research.md');
    expect(String(configuration.artifact_digest)).toMatch(/^[0-9a-f]{64}$/);
    expect(contract.delegation.output_claims).toContain(String(configuration.output_claim));
    const { pathsWithinScope } = await import('../src/scope.js');
    const admittedWriteScope = contract.write_scope;
    expect(pathsWithinScope([String(configuration.artifact_path)], admittedWriteScope)).toBe(true);
  });

  it('points the role at the canonical examples and requires contract and digest in owner requests', () => {
    for (const text of [skill, role]) {
      expect(text).toContain('Show the root contract and `plan_digest` in the owner approval request.');
    }
    expect(role).toContain('skills/start/SKILL.md#canonical-root-contract-examples');
    expect(role).not.toContain('```json build-contract');
    expect(role).not.toContain('```json research-contract');
  });
});
