/**
 * R8 (H155): the Control Room's panes from ONE source (src/ops/panes.ts): which runs get a pane, in which order, and what each
 * pane says (its state, who started it, its exit, its receipt checked in this reading, how a turn being answered is stopped,
 * its log's last lines). The Workbench's tab 7 (src/workbench/control-tab.ts) draws from it in a terminal and the companion's
 * tab 7 (src/companion/panels/control.ts, panel-control.js) in a browser.
 *
 * REAL here: the job store's jobs (sh and sleep, in this test's own job store) and their logs; receipts sealed by the job
 * store's seal into this file's own store (TIMMY_STORE, tests/isolation-setup.ts), then verified by verifyReceiptIn; a copy of
 * that chain with one field changed (it does not verify).
 * FAKE here: the project (a temporary folder named FAKE-panes), the jobs' labels and what they print, the chat turns' holds
 * (plain values: no turn is answered in this test).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { JobManager } from '../src/jobs/index.js';
import * as panes from '../src/ops/panes.js';
import { projectId } from '../src/project/index.js';
import { appendReceipt, readChain, type Receipt } from '../src/utils/receipts.js';
import * as tab from '../src/workbench/control-tab.js';
import { glyphsFor } from '../src/workbench/frame.js';
import { readJobs, type JobRow } from '../src/workbench/state.js';

const g = glyphsFor(true);
const boxes: string[] = [];
const managers: JobManager[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.stopAll(); });
afterAll(() => { for (const b of boxes) rmSync(b, { recursive: true, force: true }); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, get: () => T | undefined | false | null, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(25);
  }
}

/** A FAKE project folder of its own, and a job store of its own beside it, sealing each ended job into this file's store. */
function fakeProject(): { root: string; jobs: JobManager } {
  const b = realpathSync(mkdtempSync(join(tmpdir(), 'r8-panes-')));
  boxes.push(b);
  const root = join(b, 'FAKE-panes');
  mkdirSync(root);
  const jobs = new JobManager({
    dir: join(b, 'jobs'),
    seal: (j) => appendReceipt('runs', { kind: 'run', subject: `task · ${j.label} · ${j.state}`, policy: 'human-gated', status: j.state === 'completed' ? 'ok' : 'failed', project: 'FAKE-panes', project_id: projectId(root), job: { id: j.id, kind: j.kind, label: j.label, state: j.state, exit_code: j.exitCode ?? null }, spans: [], artifacts: [] }).hash.slice(7, 15),
  });
  managers.push(jobs);
  return { root, jobs };
}
const chain = (): Receipt[] => readChain('runs');

describe('the Control Room\'s panes, one source (R8 H155)', () => {
  it('the Workbench\'s tab 7 draws from the same source: its rule, its words and its bounds are the shared module\'s', () => {
    expect(tab.paneJobs).toBe(panes.paneJobs);
    expect(tab.checkReceipt).toBe(panes.checkReceipt);
    expect(tab.jobMark).toBe(panes.jobMark);
    expect(tab.PANES_MAX).toBe(panes.PANES_MAX);
    expect(tab.TAIL_MAX).toBe(panes.TAIL_MAX);
    expect(panes.PANES_MAX).toBe(4);
    expect(panes.TAIL_MAX).toBe(6);
  });

  it('which runs get a pane: what runs first, then the newest ended in the slots left; a chat turn being answered takes a slot, and one whose receipt is sealed is no longer answered', async () => {
    const p = fakeProject();
    const done = p.jobs.start({ kind: 'task', label: 'FAKE job (test): three lines', project: 'FAKE-panes', root: p.root, command: 'sh', args: ['-c', 'printf "one\\n\\033[1mtwo\\033[0m\\nthree\\n"'] });
    await p.jobs.done(done.id);
    await sleep(15);
    const failed = p.jobs.start({ kind: 'workflow', label: 'FAKE.md › fails', project: 'FAKE-panes', root: p.root, command: 'sh', args: ['-c', 'echo "FAKE: about to fail"; exit 3'] });
    await p.jobs.done(failed.id);
    await sleep(15);
    const live = p.jobs.start({ kind: 'task', label: 'FAKE job (test): eight lines, then waits', project: 'FAKE-panes', root: p.root, command: 'sh', args: ['-c', 'for i in 1 2 3 4 5 6 7 8; do echo "line $i"; done; sleep 30'] });
    await until('its eight lines in its log', () => (p.jobs.get(live.id)?.lines ?? 0) >= 8);
    const rows = readJobs(p.jobs.list(), p.root, { mine: new Set(), chain: chain() });

    // the four slots: what runs first, then the newest ended (newest first)
    const sel = panes.paneJobs(rows, [], 0);
    expect(sel.live.map((j) => j.id)).toEqual([live.id]);
    expect(sel.quiet.map((j) => j.id)).toEqual([failed.id, done.id]);
    // the order both surfaces draw them in: the project's running jobs, the turns being answered, a Workbench's runs elsewhere,
    // then the newest ended
    const turn = { id: 't1-0e1373aa', surface: 'repl' as const };
    const elsewhere = { ...rows.find((j) => j.id === live.id)!, id: 'j0e1399', project: 'FAKE-elsewhere' };
    const order = panes.paneOrder(panes.paneJobs(rows, [elsewhere], 1), [turn]);
    expect(order.map((x) => (x.kind === 'turn' ? `turn ${x.turn.id}` : `${x.quiet ? 'quiet' : 'running'} ${x.job.id}`))).toEqual([
      `running ${live.id}`, `turn ${turn.id}`, 'running j0e1399', `quiet ${failed.id}`,
    ]);
    // turns being answered take the slots: three of them leave none for the ended runs
    expect(panes.paneJobs(rows, [], 3).quiet).toEqual([]);
    // more running than four: every one is a pane, and no ended run is
    const many: JobRow[] = Array.from({ length: 6 }, (_, k) => ({ ...rows.find((j) => j.id === live.id)!, id: `j0e13${70 + k}` }));
    expect(panes.paneJobs([...many, ...rows.filter((j) => !j.live)], [], 0)).toMatchObject({ live: { length: 6 }, quiet: [] });

    // a turn whose own receipt is sealed has ended (its hold is let go a moment after): matched by its id, never by surface
    const held = [{ id: 't1-0e1373aa', surface: 'repl' }, { id: 't2-0e1373bb', surface: 'repl' }, { surface: 'monitor' }];
    expect(panes.liveTurnsOf(held, [{ turn: 't1-0e1373aa' }, { turn: undefined }])).toEqual([{ id: 't2-0e1373bb', surface: 'repl' }, { surface: 'monitor' }]);
    await p.jobs.stop(live.id);
  }, 30_000);

  it('what each pane says: its mark and word, who started it, its exit, and its receipt verified only when verifyReceiptIn confirms it in this reading', async () => {
    const p = fakeProject();
    const ok = p.jobs.start({ kind: 'task', label: 'FAKE job (test): passes', project: 'FAKE-panes', root: p.root, command: 'sh', args: ['-c', 'echo fine'] });
    await p.jobs.done(ok.id);
    const bad = p.jobs.start({ kind: 'task', label: 'FAKE job (test): exit 3', project: 'FAKE-panes', root: p.root, command: 'sh', args: ['-c', 'exit 3'] });
    await p.jobs.done(bad.id);
    const rows = readJobs(p.jobs.list(), p.root, { mine: new Set(), chain: chain() });
    const okRow = rows.find((j) => j.id === ok.id)!;
    const badRow = rows.find((j) => j.id === bad.id)!;

    expect(panes.jobMark(okRow, g)).toEqual({ glyph: '✓', role: 'text' });
    expect(panes.jobMark(badRow, g)).toEqual({ glyph: '✕', role: 'failure' });
    expect(panes.jobMark({ mark: 'running', live: true }, g)).toEqual({ glyph: '▶', role: 'text' });
    expect(panes.jobMark({ mark: 'stopped', live: false }, g)).toEqual({ glyph: '■', role: 'text' });
    expect(panes.exitWords(okRow)).toBe('exit 0');
    expect(panes.exitWords(badRow)).toBe('exit 3');
    expect(panes.exitWords({ exitCode: null })).toBe('no exit code');
    expect(panes.exitWords({})).toBe('exit not recorded');
    // started by: this process's job store, which is not a Workbench's (no "this Workbench" here)
    expect(panes.whoWords(okRow)).toBe('another session');
    expect(panes.whoWords({ owner: 'workbench' })).toBe('this Workbench');
    expect(panes.whoWords({ owner: 'unknown' })).toBe('started by: not recorded');

    // the receipt, checked in this reading: verified on the chain as read
    expect(okRow.receipt).toMatch(/^[0-9a-f]{8}$/);
    const v = panes.checkReceipt(chain(), ok.id, okRow.receipt!);
    expect(v).toEqual({ state: 'verified' });
    expect(panes.receiptWords(okRow, v, g)).toEqual({ words: `✓ receipt ${okRow.receipt} verified`, role: 'live' });
    // the same receipt in a chain whose body was changed: it does not verify, with why, and it is never green
    const changed = chain().map((r) => (r.hash.slice(7, 15) === okRow.receipt ? { ...r, subject: `${r.subject} (changed)` } : r));
    const w = panes.checkReceipt(changed, ok.id, okRow.receipt!);
    expect(w.state).toBe('failed');
    const said = panes.receiptWords(okRow, w, g);
    expect(said.role).toBe('failure');
    expect(said.words).toMatch(new RegExp(`^✕ receipt ${okRow.receipt} does not verify: .+`));
    // not on the chain read here, not checked, none
    const missing = panes.checkReceipt(chain(), 'j000000', okRow.receipt!);
    expect(missing).toMatchObject({ state: 'not found' });
    expect(panes.receiptWords(okRow, missing, g)).toEqual({ words: `receipt ${okRow.receipt} (not found on the chain read here)`, role: 'secondary' });
    expect(panes.receiptWords(okRow, undefined, g)).toEqual({ words: `receipt ${okRow.receipt} (not verified here)`, role: 'secondary' });
    expect(panes.receiptWords({ receipt: undefined }, undefined, g)).toEqual({ words: 'no receipt', role: 'secondary' });

    // how a chat turn being answered is stopped: where it was sent from, in the frame's words (src/ops/workspace-frame.ts)
    expect(panes.turnStopLine('repl')).toBe('Ctrl+C in the REPL stops it');
    expect(panes.turnStopLine('workbench')).toBe('Esc in its composer stops it');
    expect(panes.turnStopLine('companion')).toBe('Stop on the page that sent it stops it');
  }, 30_000);

  it('a pane\'s log: its last lines (escapes out, the project\'s folder as .), at most TAIL_MAX; why, when there is none', async () => {
    const p = fakeProject();
    const talk = p.jobs.start({ kind: 'task', label: 'FAKE job (test): ten lines', project: 'FAKE-panes', root: p.root, command: 'sh', args: ['-c', `for i in 1 2 3 4 5 6 7 8 9; do echo "line $i"; done; printf 'in \\033[32m%s\\033[0m\\r\\n' "${p.root}/out"`] });
    await p.jobs.done(talk.id);
    const rec = p.jobs.get(talk.id)!;
    const row = readJobs([rec], p.root, { mine: new Set(), chain: [] })[0];
    expect(panes.paneTailOf(rec, row, process.env)).toEqual({ lines: ['line 5', 'line 6', 'line 7', 'line 8', 'line 9', 'in ./out'] });
    expect(panes.paneTail(rec.logPath, 2, (t) => t)).toEqual({ lines: ['line 9', `in ${p.root}/out`] });
    expect(panes.paneTailOf(undefined, row, process.env)).toEqual({ why: 'its record was not read here' });
    expect(panes.paneTail(join(p.root, 'no-such.log'), 6, (t) => t)).toEqual({ why: 'no log yet (it printed nothing, or never started)' });
    // a long log: only its end is read (TAIL_BYTES), and a line cut by where the read starts is left out
    const big = join(p.root, 'big.log');
    writeFileSync(big, `${Array.from({ length: 4000 }, (_, k) => `FAKE log line ${k}`).join('\n')}\n`);
    const tail = panes.paneTail(big, panes.TAIL_MAX, (t) => t);
    expect(tail).toEqual({ lines: Array.from({ length: 6 }, (_, k) => `FAKE log line ${3994 + k}`) });
    expect(panes.TAIL_BYTES).toBe(16 * 1024);
  }, 30_000);
});
