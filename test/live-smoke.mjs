import { mkdirSync } from 'node:fs';
import {
  capturePane, ensureHiveSession, killWindow, newWindow, paneIdentity, sendEnter, sleep,
} from '../dist/tmux.js';
import { classify, lines, parseDialog } from '../dist/screen.js';
import { typeLine } from '../dist/spawn.js';

const DIR = '/tmp/hive-smoke';
const NAME = 'smoke';
let pane = null;

function fail(msg) {
  console.error(`smoke: FAIL: ${msg}`);
  process.exitCode = 1;
}

async function waitFor(pred, maxMs, what) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const raw = await capturePane(pane);
    if (raw === null) throw new Error('pane died');
    const ls = lines(raw);
    if (pred(ls)) return ls;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

try {
  mkdirSync(DIR, { recursive: true });
  await ensureHiveSession();
  pane = await newWindow(NAME, DIR, 'KIMI_CODE_NO_AUTO_UPDATE=1 exec teamkimi run');
  console.log(`smoke: window ${pane} up`);

  // A fresh folder asks for trust once; cursor defaults to "Trust this folder".
  const first = await waitFor(
    (ls) => classify(ls) !== 'unknown' || parseDialog(ls).kind !== 'none',
    120_000,
    'first stable screen',
  );
  if (parseDialog(first).kind !== 'none') {
    console.log('smoke: trust dialog up; pressing Enter');
    await sendEnter(pane);
  }
  await waitFor((ls) => classify(ls) === 'idle', 120_000, 'idle');
  console.log('smoke: idle detected');

  const identity = await paneIdentity(pane);
  await typeLine(pane, 'Reply with the word OK', identity);
  console.log('smoke: prompt typed');

  await waitFor((ls) => classify(ls) === 'working', 60_000, 'working');
  console.log('smoke: working detected');

  await waitFor((ls) => classify(ls) === 'idle' && ls.some((l) => l.includes('OK')), 180_000, 'idle after reply');
  console.log('smoke: idle again, reply contained OK');
  console.log('smoke: PASS');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  if (pane) await killWindow(pane);
}
