import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateRootContract } from '../src/state.js';
import type { RootContract } from '../src/types.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const skill = readFileSync(path.join(root, 'skills', 'start', 'SKILL.md'), 'utf8');
const retro = readFileSync(path.join(root, 'skills', 'retro', 'SKILL.md'), 'utf8');
const role = readFileSync(path.join(root, 'roles', 'orchestrator.md'), 'utf8');
const implementer = readFileSync(path.join(root, 'roles', 'implementer.md'), 'utf8');
const citadelWorker = readFileSync(path.join(root, 'roles', 'citadel-worker.md'), 'utf8');

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

describe('COE workflow contract', () => {
  it('requires the artifact in worker briefs and completion before release', () => {
    expect(skill).toContain('Before plan approval, classify any COE trigger and name the required artifact in each worker\'s Assignment and Deliverable. Workers can start before the artifact is complete.');
    expect(skill).toContain('Require the completed artifact before final review or SHIP and before clearing `gate:coe`.');
    expect(skill).toContain('A human reviewer clears `gate:coe` only after reviewing the completed artifact, evidence, and independent qualified reviewer\'s SHIP verdict.');
    expect(role).toContain('A human reviewer clears `gate:coe` only after reviewing the completed artifact, evidence, and independent qualified reviewer\'s SHIP verdict.');
  });

  it('keeps ordinary deliverables short and defines the nontrivial non-COE bug result', () => {
    for (const text of [implementer, citadelWorker]) {
      expect(text).toContain('Ordinary features and trivial fixes keep the existing short deliverable.');
      expect(text).toContain('For a nontrivial bug with no COE trigger, return repro, proven cause, remaining hypotheses, shared/class fix, adjacent audit, RED/GREEN evidence, and deterministic prevention or a justified residual gap. Do not require the full COE template.');
    }
  });

  it('applies and verifies the COE gate on the returned pull request', () => {
    expect(role).toContain('After a worker returns a PR URL, apply `gate:coe` to that URL with `gh pr edit <url> --add-label gate:coe` when required.');
    expect(role).toContain('After applying `gate:coe`, verify with `gh pr view <url> --json labels` that the required hold is present. If it is absent, block merge.');
    expect(role).toContain('A template checkbox is not a label.');
  });

  it('closes the existing PR or issue artifact during retro', () => {
    expect(retro).toContain('If the task has a COE artifact, close the existing PR or issue artifact. Confirm prevention actions landed or have tracked owners, check recurrence of the same mechanism, and promote reusable deterministic checks into existing gates.');
    expect(retro).toContain('Do not write a second retrospective document.');
  });

  it('runs existing cleanup after retro for every job without new COE infrastructure', () => {
    expect(skill).toContain('After retro, every job uses the existing `cleanup` skill. Show `hive cleanup <project> --dry-run`, then run `hive cleanup <project>` only with owner approval.');
    expect(skill).toContain('Cleanup does not depend on a COE artifact and needs no new Hub schema, task events, or cleanup service.');
  });
});
