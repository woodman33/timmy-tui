/**
 * The recipe watcher (round R3, helper H11): a Timmy job that follows one durable recipe job by its UUID.
 * It polls lanes/recipes/jobs.ts status() (about once a second), prints each phase change, and when the job
 * ends: on success copies the freshly verified exports into the project (src/recipes deliver) and exits 0;
 * otherwise says where the raw failure is kept and exits nonzero. Stopped (SIGTERM from /stop or the REPL's
 * end), it asks the recipe's own cancel path and keeps reading status briefly for a final state. The
 * REPL asks that same cancel itself before it stops this watcher (round R4: a stop can land before this
 * module, and so its handler, has loaded); asking twice changes nothing. The
 * recipe supervisor owns the native process; this watcher never signals a process it did not start.
 *
 *   node [--import tsx] src/recipes/watch.ts <project root> <recipe job UUID>
 */
import { cancel, status } from '../../lanes/recipes/jobs.js';
import { deliver, failureFiles, isRecipeJobId, outcomeLines, short } from './index.js';

const [root, id] = process.argv.slice(2);
const poll = Number(process.env.TIMMY_RECIPE_POLL_MS) > 0 ? Number(process.env.TIMMY_RECIPE_POLL_MS) : 1000;
const say = (s: string): void => { process.stdout.write(`${s}\n`); };
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** How long a stopped watcher keeps reading status for the final state (inside the job manager's 2 s grace). */
const STOP_READ_MS = 1500;

let stopUntil: number | undefined;
process.on('SIGTERM', () => {
  if (stopUntil !== undefined) return;
  stopUntil = Date.now() + STOP_READ_MS;
  try {
    const c = cancel(root, id);
    say(`${id} stop: cancel requested through the recipe's own cancel path; now ${c.state} (${c.progress})`);
  } catch (e) { say(`${id} stop: the cancel request failed: ${message(e)}`); }
});

async function main(): Promise<number> {
  if (!root || !id || !isRecipeJobId(id)) { say('Usage: watch <project root> <recipe job UUID>'); return 64; }
  let last = '';
  let first = true;
  for (;;) {
    let s: ReturnType<typeof status>;
    try { s = status(root, id); } catch (e) { say(`${id} could not be read: ${message(e)}`); return 5; }
    if (first) { say(`Recipe job ${id} · request ${short(s.job.requestHash)} · source ${short(s.job.sourceHash)}`); first = false; }
    const phase = `${s.state} ${s.progress}`;
    if (phase !== last) { last = phase; say(`${id} ${s.state}: ${s.progress}${s.reason ? ` (${s.reason})` : ''}`); }
    if (s.state === 'succeeded') {
      const d = deliver(root, id);
      if (!d.ok) { say(`${id} succeeded, but its exports were not copied: ${d.error}`); return 4; }
      for (const f of d.files) say(`copied ${f.path} sha256 ${f.sha256}`);
      for (const l of outcomeLines(d.v, d.dir)) say(l);
      return 0;
    }
    if (s.state === 'failed' || s.state === 'cancelled' || s.state === 'interrupted') {
      const kept = failureFiles(root, id);
      if (kept.length) say(`Kept as it ended: ${kept.join(', ')}`);
      if (s.state === 'interrupted') say(`/recipe recover ${id} reads it again; nothing is rerun`);
      return s.state === 'failed' ? 1 : s.state === 'cancelled' ? 2 : 3;
    }
    if (stopUntil !== undefined && Date.now() > stopUntil) { say(`${id} stop: no final state yet (${s.state}, ${s.progress}); /recipe status shows it`); return 2; }
    await sleep(stopUntil !== undefined ? 100 : poll);
  }
}

process.exitCode = await main();
