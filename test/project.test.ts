import { promises as fs, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeProject } from '../src/project.js';
import {
  hivePath, hubPath, readProjects, writeJson, writePendingPane,
} from '../src/state.js';

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'hive-project-'));
  const home = path.join(root, 'demo');
  const otherHome = path.join(root, 'other');
  await fs.mkdir(home, { recursive: true });
  await writeJson(hubPath(root, 'projects.json'), {
    projects: [
      { name: 'demo', home, repos: [{ folder: home }] },
      { name: 'other', home: otherHome, repos: [{ folder: otherHome }] },
    ],
  });
  await writeJson(hivePath(home, 'team.json'), { agents: [] });
  return { root, home };
}

describe('removeProject', () => {
  it('removes only the registry entry and preserves project and hub records', async () => {
    const { root, home } = await setup();
    const files = [
      [hubPath(root, 'tasks.jsonl'), '{"task":"keep"}\n'],
      [hubPath(root, 'decisions.jsonl'), '{"decision":"keep"}\n'],
      [hivePath(home, 'handoffs', 'builder.md'), 'keep handoff\n'],
      [hivePath(home, 'manifest.jsonl'), '{"kind":"jj-workspace"}\n'],
      [path.join(home, 'repo-marker.txt'), 'keep repo\n'],
      [hivePath(home, 'team.json'), '{"agents":[]}\n'],
    ] as const;
    for (const [file, contents] of files) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, contents);
    }

    await removeProject(root, 'demo');

    expect((await readProjects(root)).projects.map((p) => p.name)).toEqual(['other']);
    for (const [file, contents] of files) {
      expect(await fs.readFile(file, 'utf8')).toBe(contents);
    }
  });

  it('refuses an unknown project without changing the registry', async () => {
    const { root } = await setup();
    await expect(removeProject(root, 'missing')).rejects.toThrow(/unknown project/);
    expect((await readProjects(root)).projects.map((p) => p.name)).toEqual(['demo', 'other']);
  });

  it('refuses every nonempty team, including stopped entries', async () => {
    const { root, home } = await setup();
    await writeJson(hivePath(home, 'team.json'), {
      agents: [{ name: 'builder', pane: '%2', closed_at: '2026-10-27T00:00:00Z' }],
    });
    await expect(removeProject(root, 'demo')).rejects.toThrow(/team is not empty/);
    expect((await readProjects(root)).projects.map((p) => p.name)).toEqual(['demo', 'other']);
  });

  it('refuses a pending launch and keeps its record', async () => {
    const { root } = await setup();
    await writePendingPane(root, 'demo', { pane: '%9', kind: 'start', at: '2026-10-27T00:00:00Z' });
    await expect(removeProject(root, 'demo')).rejects.toThrow(/launch is pending/);
    expect((await readProjects(root)).projects.map((p) => p.name)).toEqual(['demo', 'other']);
    expect(JSON.parse(await fs.readFile(hubPath(root, 'panes', 'demo.json'), 'utf8')).pane).toBe('%9');
  });
});
