import { spawn } from 'node:child_process';
import { readProjects, readTeam, Refusal } from './state.js';
import { assertPane, HIVE_SESSION, tmuxSocket, type PaneIdentity } from './tmux.js';
import { orchestratorName, withoutPaneIds } from './window-name.js';

export async function attachProject(root: string, project: string): Promise<void> {
  const entry = (await readProjects(root)).projects.find((candidate) => candidate.name === project);
  if (!entry) throw new Refusal(`unknown project: ${project}`);
  const agent = (await readTeam(entry.home)).agents.find((candidate) => candidate.orchestrator);
  const name = agent?.name ?? orchestratorName(project);
  if (!agent?.pane || !agent.pane_pid || !agent.pane_started || agent.closed_at) {
    throw new Refusal(`${name} has no recorded pane identity`);
  }
  const identity: PaneIdentity = { pid: agent.pane_pid, started: agent.pane_started };
  await assertPane(agent.pane, identity);
  const child = spawn('tmux', [
    '-L', tmuxSocket(), 'attach-session', '-t', HIVE_SESSION,
    ';', 'select-window', '-t', agent.pane,
    ';', 'select-pane', '-t', agent.pane,
  ], { stdio: ['inherit', 'inherit', 'pipe'] });
  let errorOutput = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    errorOutput = (errorOutput + chunk).slice(-4096);
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const detail = errorOutput.trim().split('\n').filter((line) => line.trim()).pop();
      reject(new Error(`tmux attach exited with ${signal ?? code}${detail ? `: ${withoutPaneIds(detail)}` : ''}`));
    });
  });
}
