/**
 * Round R4 (H99, the review of the H99 work, item 4): a /run whose block made no change, left by a REPL that crashed, and
 * recovered. The review: recovery sealed the block's receipt as "no change" (src/repl/workflow-blocks.ts sealLeftBlocks) while
 * the record it wrote said only that the block failed (exit 4), so /jobs, /op and the board read it as failed (the r24
 * symptom). Now the job module's writer notes each such block on its step (outcome, why, current, last_build: noteLeftSteps,
 * read as the receipt is) before recovery writes the record.
 *
 * The crash is real: a REPL session runs as its own process (tests/fixtures/no-change-crash-fixture.ts, a real Workspace
 * running /run in an operation through workers/upmd/pty_run.py with this machine's python3), stops following the run
 * (SIGSTOP) while its first block runs, and is killed with SIGKILL once upmd has ended; its pty wrapper's stop file says how
 * the block ended, and the next REPL's /recover records the run from it. FAKE pieces, each labelled:
 * - upmd is tests/fixtures/fake-upmd.mjs (a TEST DOUBLE of upmd 0.2.7's behaviour; it is not upmd; its blocks run for real,
 *   and a failing block stops the chain);
 * - the code agent is tests/fixtures/fake-code-agent.mjs (a TEST DOUBLE: no model, nothing sent) as Qwen Code on a local
 *   endpoint: its PYREPLACE word finds nothing to replace, so it changes nothing;
 * - OpenSCAD is tests/fixtures/fake-openscad.mjs (a TEST DOUBLE; not reached: nothing was changed, so nothing is rebuilt).
 * The `timmy` the block runs is the real CLI (tests/helpers/ops-sandbox.ts); every folder is under os.tmpdir().
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { JobManager } from '../src/jobs/index.js';
import { jobOutcome } from '../src/ops/outcome.js';
import { BOARD_FILE } from '../src/repl/board.js';
import { readChain } from '../src/utils/receipts.js';
import { wrapperStopFile } from '../src/workflows/upmd-live.js';
import { FAKE_UPMD, json, opsKit, REPO, replOf, sandbox as opsSandbox, text, until } from './helpers/ops-sandbox.js';

const kit = opsKit();
afterEach(() => kit.cleanup(), 60_000);

const FIXTURE = path.join(REPO, 'tests', 'fixtures', 'no-change-crash-fixture.ts');
const PYTHON3 = String(spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout ?? '').trim() || null;
if (!PYTHON3) console.warn('no-change-recover: no python3 here, so the crash case (upmd on a pty) is skipped');
const F = '```';
/** change asks for a change the agent cannot make (FAKE: nothing to replace); inspect needs change. */
const DOC = [
  '# FAKE workflow for the recovered no-change test', '',
  `${F}bash [name:change]`, 'sleep 1', 'timmy act \'/iterate scad box.scad "make it 100 wide PYFILE:box.params.json PYREPLACE:999,=>100,"\' --wait', F, '',
  `${F}bash [name:inspect, deps:change]`, 'echo inspect', F, '',
].join('\n');

/** The crashed session's READY line: its job, its operation and its pty wrapper's pid. */
function readyOf(child: ChildProcess): Promise<{ job: string; op: string; pid: number }> {
  let out = '';
  let err = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the session did not get ready: ${out}${err}`)), 90_000);
    child.stdout!.on('data', (b: Buffer) => {
      out += b.toString('utf8');
      const m = /^READY (.*)$/m.exec(out);
      if (m) { clearTimeout(timer); resolve(JSON.parse(m[1])); } else if (/^FAILED /m.test(out)) { clearTimeout(timer); reject(new Error(`${out}${err}`)); }
    });
    child.stderr!.on('data', (b: Buffer) => { err += b.toString('utf8'); });
    child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`the session ended (${code ?? signal}) before it was ready: ${out}${err}`)); });
  });
}

describe.skipIf(!PYTHON3)('a /run whose block made no change, left by a REPL that crashed, recovered (R4 H99, the review)', () => {
  it('the record recovery writes notes the block (no change, its words, its last build); /jobs, /op and the board say no change, never failed', async () => {
    const s = opsSandbox(kit, 'no-change-recover-');
    const jobsDir = path.join(s.home, 'timmy', 'jobs');
    fs.writeFileSync(path.join(s.root, 'CHANGE.md'), DOC);
    const config = path.join(s.base, 'crashed-session.json');
    fs.writeFileSync(config, JSON.stringify({ root: s.root, jobsDir, upmd: FAKE_UPMD, python3: PYTHON3, doc: 'CHANGE.md', block: 'inspect', running: 'change' }));
    const child = spawn(process.execPath, ['--import', 'tsx', FIXTURE, config], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: s.env });
    kit.children.push(child);
    const ready = await readyOf(child);
    const stopFile = wrapperStopFile(new JobManager({ dir: jobsDir }).get(ready.job)!.args)!;

    // The REPL stops following while change runs; upmd goes on: the agent changes nothing, so `timmy act` exits 4 (there is no
    // build yet), upmd stops the chain (inspect never starts) and ends, and its wrapper writes what it saw to its stop file.
    process.kill(child.pid!, 'SIGSTOP');
    await until(() => fs.existsSync(stopFile), 90_000, 'the wrapper\'s stop file');
    const stop = json(stopFile) as { exit: number; stopped: boolean; blocks: Array<{ n: number; name?: string; state: string; code?: number }> };
    expect(stop).toMatchObject({ exit: 1, stopped: false });
    expect(stop.blocks.map((b) => [b.n, b.name, b.state, b.code])).toEqual([[1, 'change', 'failed', 4]]);
    // The crash: the REPL never saw change end, so it noted and sealed nothing of it.
    const gone = new Promise((r) => child.once('exit', r));
    child.kill('SIGKILL');
    await gone;
    await until(() => new JobManager({ dir: jobsDir }).get(ready.job)?.stale === true, 30_000, 'the run\'s record to be stale');
    const left = new JobManager({ dir: jobsDir }).get(ready.job)!;
    expect(left.steps.map((x) => [x.name, x.state, x.outcome ?? null])).toEqual([['change', 'running', null]]);
    // the flow the block ran: no change, as its own record says, in the run's operation
    const flows = fs.readdirSync(path.join(s.root, 'results', 'flows'));
    expect(flows).toHaveLength(1);
    const flow = json(path.join(s.root, 'results', 'flows', flows[0])) as { id: string; outcome: string; operation: string; last_build: { state: string } };
    expect(flow).toMatchObject({ outcome: 'no change', operation: ready.op, last_build: { state: 'none' } });

    // The next REPL's /recover records the run from its wrapper's stop file.
    const { ws } = replOf(kit, s);
    const said = text(await ws.recover(''));
    // recovery's own line for the run: no change, never ✖ or "now says failed" (R4 lead)
    expect(said).toMatch(new RegExp(`${ready.job}[^\\n]*`));
    expect(said).toContain('its job record now says no change');
    expect(said).toContain('change made no change (upmd counted it as failed)');
    expect(said).not.toMatch(/now says failed/);
    const job = new JobManager({ dir: jobsDir }).get(ready.job)!;
    // its record, as recovery wrote it: change made no change, noted on its step (its state and code stay as upmd gave them)
    expect(job.state, said).toBe('failed');
    expect(job.steps.map((x) => [x.name, x.state, x.code, x.seen ?? null])).toEqual([['change', 'failed', 4, 'wrapper']]);
    expect(job.steps[0]).toMatchObject({ outcome: 'no change', current: false, last_build: 'none' });
    expect(job.steps[0].why).toMatch(new RegExp(`^flow ${flow.id}: the agent changed nothing, so nothing was rebuilt`));
    // the block's receipt recovery sealed says the same
    const receipt = readChain('runs', s.root).find((r) => r.kind === 'workflow-block' && (r as { block?: { run?: string; name?: string } }).block?.run === ready.job) as { block: Record<string, unknown> } | undefined;
    expect(receipt?.block).toMatchObject({ name: 'change', outcome: 'no change', state: 'failed', exit_code: 4, seen: 'wrapper', no_change: { flows: [flow.id], last_build: 'none', words: job.steps[0].why } });
    // the run, as every view reads its record: no change (=), never failed (✖); upmd counted the block as failed
    expect(jobOutcome(job)).toMatchObject({ state: 'no change', current: false });
    expect(jobOutcome(job).words).toContain('upmd counted it as failed: exit 4');
    const jobs = text(ws.jobsView(''));
    expect(jobs).toMatch(new RegExp(`= ${ready.job} +no change`));
    expect(jobs).not.toMatch(new RegExp(`✖ ${ready.job}`));
    const card = text(ws.op(ready.op));
    expect(card).toMatch(/Workflow\s+CHANGE\.md › inspect\s+job j[0-9a-f]{6}\s+no change · 1 of 2 steps/);
    expect(card).toContain('1 change no change · 2 inspect not run');
    ws.board('');
    const html = fs.readFileSync(path.join(s.root, BOARD_FILE), 'utf8');
    const at = html.indexOf(`<strong class="label">${ready.job} · `);
    expect(at, 'the run\'s result card').toBeGreaterThan(0);
    const result = html.slice(html.lastIndexOf('<article', at), html.indexOf('</article>', at));
    expect(result).toContain('<div class="rstatus rstatus-neutral"><strong>no change</strong> stopped at change: it made no change and there is no build yet (upmd counted the block as failed: exit 4)');
  }, 180_000);
});

describe('the job module\'s writer notes a left run\'s steps before it writes its record (SYNTHETIC records in src/jobs\' shape)', () => {
  const T = (s: number): string => new Date(Date.parse('2026-10-11T10:00:00.000Z') + s * 1000).toISOString();
  const gone = 2147480000;
  const left = (dir: string, id: string, more: Record<string, unknown> = {}): void => fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    id, kind: 'workflow', label: 'W.md › inspect', project: 'demo', root: dir, command: 'upmd', args: [], state: 'running', pid: gone, startedAt: T(0), lines: 0,
    steps: [{ name: 'change', index: 1, state: 'failed', code: 4 }, { name: 'inspect', index: 2, state: 'running' }], ...more,
  }));
  it('endLeft and noteAtOnceSealed write the notes noteLeft gives; a note that renames a step or changes its state is not written', () => {
    const s = opsSandbox(kit, 'no-change-writer-');
    const dir = path.join(s.base, 'jobs');
    fs.mkdirSync(dir, { recursive: true });
    const seen: string[][] = [];
    const m = new JobManager({
      dir,
      // FAKE: notes change as no change, as src/repl/workflow-blocks.ts noteLeftSteps would from a flow's record
      noteLeft: (job) => { seen.push(job.steps.map((x) => `${x.name} ${x.state}`)); return job.steps.map((x) => (x.name === 'change' ? { ...x, outcome: 'no change' as const, why: 'flow f12345678: the agent changed nothing, so nothing was rebuilt', current: false, last_build: 'stale' } : x)); },
    });
    left(dir, 'j0a0b01');
    const ended = m.endLeft('j0a0b01', { state: 'failed', error: 'interrupted: its REPL ended while inspect was running; its process is gone', interrupted: true })!;
    // it is given the steps as the record will say them (the running one interrupted)
    expect(seen.at(-1)).toEqual(['change failed', 'inspect interrupted']);
    expect(ended.steps[0]).toMatchObject({ name: 'change', state: 'failed', code: 4, outcome: 'no change', current: false, last_build: 'stale' });
    expect(new JobManager({ dir }).get('j0a0b01')).toEqual(ended);
    // a run its own Timmy ended at once (src/ops/exit-at-once.ts): noted as its record is noted sealed
    left(dir, 'j0a0b02', { state: 'cancelled', endedAt: T(9), steps: [{ name: 'change', index: 1, state: 'failed', code: 4 }, { name: 'inspect', index: 2, state: 'stopped', endedAt: T(9) }], exitedAtOnce: { at: T(9), by: 'timmy md', signal: 'SIGINT', sealed: false } });
    expect(m.noteAtOnceSealed('j0a0b02')).toBe(true);
    expect(new JobManager({ dir }).get('j0a0b02')).toMatchObject({ exitedAtOnce: { sealed: true }, steps: [{ name: 'change', outcome: 'no change', last_build: 'stale' }, { name: 'inspect', state: 'stopped' }] });
    // a note function that changes what upmd said is not believed: the record is written as it was
    const bad = new JobManager({ dir, noteLeft: (job) => job.steps.map((x) => ({ ...x, state: 'completed' as const })) });
    left(dir, 'j0a0b03');
    expect(bad.endLeft('j0a0b03', { state: 'failed', error: 'interrupted', interrupted: true })!.steps.map((x) => [x.name, x.state, x.outcome ?? null])).toEqual([['change', 'failed', null], ['inspect', 'interrupted', null]]);
    // one that throws: the same
    const throws = new JobManager({ dir, noteLeft: () => { throw new Error('FAKE: the chain could not be read'); } });
    left(dir, 'j0a0b04');
    expect(throws.endLeft('j0a0b04', { state: 'failed', error: 'interrupted', interrupted: true })!.steps[0].outcome).toBeUndefined();
  });
});
