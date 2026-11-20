import { hubLog, planAnswer } from '../src/hub.js';
import { hivePath, readTeam, writeJson } from '../src/state.js';
import type { RootContract } from '../src/types.js';

export function taskContract(home: string, writeScope: string[], outputClaim: string): RootContract {
  return {
    schema_version: 1,
    objective: 'Complete the bounded task.',
    consumer: 'demo-orchestrator',
    deliverable: outputClaim,
    kind: 'build',
    acceptance: [{
      id: 'diff', predicate_id: 'git_diff_scope', version: 1,
      configuration: {}, required_evidence: ['diff-evidence'],
    }],
    provenance: {
      repository: home,
      base_revision: '0'.repeat(40),
      artifact_revision: '1'.repeat(40),
    },
    write_scope: writeScope,
    action_scope: [],
    budget: { depth: 1, active_children: 8, active_project_records: 16, attempts: 3 },
    delegation: { output_claims: [outputClaim], adapters: ['tmux'] },
  };
}

export async function approveContract(root: string, id: string, contract: RootContract): Promise<void> {
  if (contract.provenance.kind === 'research') throw new Error('this fixture needs code provenance');
  const home = contract.provenance.repository;
  const team = await readTeam(home);
  if (!team.agents.some((agent) => agent.orchestrator)) {
    await writeJson(hivePath(home, 'team.json'), {
      agents: [...team.agents, {
        name: 'demo-orchestrator', orchestrator: true, pane: '%1', pane_pid: 1, pane_started: 'x',
      }],
    });
  }
  await hubLog(root, id, 'plan', 'the plan', [{ id: 'work', desc: 'bounded work', etaMin: 5 }], undefined, contract);
  await planAnswer(root, 'demo', id, 'approve');
}
