import { classify, lines, parseDialog } from './screen.js';
import { capturePane, paneIs, sendEnter, sleep, type PaneIdentity } from './tmux.js';
import type { TeamEntry } from './types.js';

export type CacheExpiryChoice = { n: number; cursor: number; fingerprint: string };

const OPTIONS = [
  ['Compact and continue', 'one-time compact cost · cheapest way to keep this topic'],
  ['Start a new session', 'zero context cost · best for a new task'],
  ['Continue as-is', 'full history kept · highest cost per turn'],
  ["Don't ask me again", ''],
] as const;

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function cacheExpiryChoice(raw: string): CacheExpiryChoice | null {
  const dialog = parseDialog(lines(raw));
  if (dialog.kind !== 'menu') return null;
  if (!/This session has been idle for \d+[dhms](?: \d+[dhms])* and is ~[\d.]+[kKmM]? tokens\./.test(dialog.text)) return null;
  if (!dialog.text.includes('Cache expired — the next message re-sends the entire history at full price.')) return null;
  const screen = lines(raw);
  if (!screen.some((line) => line.trim() === '↑↓ navigate · Enter select · Esc cancel')) return null;

  let cursor = 0;
  let previous = -1;
  for (let n = 1; n <= OPTIONS.length; n++) {
    const [label, description] = OPTIONS[n - 1];
    const pattern = new RegExp(`^\\s*(❯\\s+)?${escape(label)}${description ? `\\s+${escape(description)}` : ''}\\s*$`);
    const index = screen.findIndex((line) => pattern.test(line));
    if (index <= previous || (previous >= 0 && index !== previous + 1)) return null;
    previous = index;
    if (screen[index].includes('❯')) cursor = n;
  }
  if (screen.slice(previous + 1).some((line) => line.trim() !== '' && !/^[─╌]+$/.test(line.trim()))) return null;
  return cursor === 0 ? null : { n: 1, cursor, fingerprint: dialog.fingerprint };
}

function identity(agent: TeamEntry): PaneIdentity {
  if (!agent.pane || !agent.pane_pid || !agent.pane_started) throw new Error('cache fallback needs a recorded pane identity');
  return { pid: agent.pane_pid, started: agent.pane_started };
}

async function readChoice(agent: TeamEntry): Promise<CacheExpiryChoice> {
  const id = identity(agent);
  if (!(await paneIs(agent.pane!, id))) throw new Error('cache fallback pane identity changed');
  const raw = await capturePane(agent.pane!);
  if (raw === null) throw new Error('cache fallback pane is gone');
  const choice = cacheExpiryChoice(raw);
  if (!choice) throw new Error('cache fallback dialog changed');
  return choice;
}

export async function answerCacheExpiry(agent: TeamEntry, expected: CacheExpiryChoice): Promise<boolean> {
  const id = identity(agent);
  const current = await readChoice(agent);
  if (current.fingerprint !== expected.fingerprint || current.cursor !== 1) return false;
  const beforeEnter = await readChoice(agent);
  if (beforeEnter.fingerprint !== expected.fingerprint || beforeEnter.cursor !== 1) return false;
  await sendEnter(agent.pane!, id);
  for (let i = 0; i < 30; i++) {
    const raw = await capturePane(agent.pane!);
    if (raw === null) return false;
    if (/^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏][^\n]*compact/im.test(raw)) return true;
    if (cacheExpiryChoice(raw) === null && classify(lines(raw)) === 'dialog') return false;
    await sleep(100);
  }
  return false;
}
