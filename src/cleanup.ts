import path from 'node:path';
import { promises as fs } from 'node:fs';
import { killWindow, paneExists, paneIs, processStartTime, run, type PaneIdentity } from './tmux.js';
import { hivePath, manifestRead, manifestWrite, readProjects, type ManifestRecord } from './state.js';

export type CleanupAction = { record: ManifestRecord; action: string; acted: boolean };

// Cleanup acts only on the manifest, re-judges every record at act time, and trashes instead of deleting.
export async function cleanupProject(
  root: string,
  project: string,
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<CleanupAction[]> {
  const pf = await readProjects(root);
  const p = pf.projects.find((x) => x.name === project);
  if (!p) throw new Error(`unknown project: ${project}`);
  const records = await manifestRead(p.home);
  const actions: CleanupAction[] = [];
  const keep: ManifestRecord[] = [];
  const trashDir = hivePath(p.home, 'trash', new Date().toISOString().slice(0, 10));

  for (const rec of records) {
    if (rec.kind === 'tmux') {
      const pane = String(rec.pane ?? '');
      if (!pane || !(await paneExists(pane))) continue;
      const pid = Number(rec.pane_pid ?? 0);
      const started = String(rec.pane_started ?? '');
      const identity: PaneIdentity | null = pid && started ? { pid, started } : null;
      // A record without identity, or one whose pane was recycled since, is
      // left alone and kept on the manifest — killing it could hit a window
      // hive does not own.
      if (!identity || !(await paneIs(pane, identity))) {
        actions.push({
          record: rec,
          action: `left tmux window ${rec.window ?? pane} (${pane}) alone: ${identity ? 'pane identity no longer matches the record' : 'record has no pane identity'}`,
          acted: false,
        });
        keep.push(rec);
        continue;
      }
      actions.push({ record: rec, action: `kill tmux window ${rec.window ?? pane} (${pane})`, acted: !dryRun });
      if (!dryRun) await killWindow(pane, identity);
      continue;
    }
    if (rec.kind === 'process') {
      const pid = Number(rec.pid ?? 0);
      const started = await processStartTime(pid);
      if (pid && started && started === rec.started) {
        actions.push({ record: rec, action: `terminate process ${pid}`, acted: !dryRun });
        if (!dryRun) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch { /* already gone */ }
        }
      }
      continue;
    }
    if (rec.kind === 'worktree') {
      const wt = String(rec.path ?? '');
      const abs = wt ? path.resolve(wt) : '';
      const st = abs ? await fs.stat(abs).catch(() => null) : null;
      if (!abs || !st) continue;
      // The manifest is writable by the agents hive supervises: only trash a
      // path that sits under the project home AND that git itself lists as a
      // worktree of it.
      const underHome = abs.startsWith(path.resolve(p.home) + path.sep);
      const listed = underHome
        ? (await run('git', ['worktree', 'list', '--porcelain'], p.home)).stdout
            .split('\n')
            .some((l) => l === `worktree ${abs}`)
        : false;
      if (!underHome || !listed) {
        actions.push({ record: rec, action: `left worktree ${abs} alone: not a registered worktree under ${p.home}`, acted: false });
        keep.push(rec);
        continue;
      }
      const dest = path.join(trashDir, path.basename(abs));
      actions.push({ record: rec, action: `trash worktree ${abs} -> ${dest}`, acted: !dryRun });
      if (!dryRun) {
        await fs.mkdir(trashDir, { recursive: true });
        await fs.rename(abs, dest);
        await run('git', ['worktree', 'prune'], p.home);
      }
      continue;
    }
    keep.push(rec);
  }

  if (!dryRun) await manifestWrite(p.home, keep);
  return actions;
}
