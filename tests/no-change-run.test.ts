/**
 * Round R4 (H99, r24): a satisfied request run again, end to end. On the Mac (r24), after `/run WORKFLOW.md result` made the
 * tray 150 mm wide, the board's "Run up to here" ran it again: the agent changed nothing, the flow said 'stopped', the change
 * block exited 1, and the job, the operation card, /room and God's Eye View said FAILED. Here the same shape runs for real:
 * a /run whose blocks call real `timmy act` child processes, twice, then once more after the parameter file was changed by
 * hand. "No change" is its own outcome in the flow record, the block's exit and words, the job, the operation card, /room
 * and God's Eye View; the blocks that need it run only on a last build that still matches its recorded inputs.
 *
 * FAKE pieces, each labelled (as tests/ops-operation.test.ts uses them):
 * - upmd is tests/fixtures/fake-upmd.mjs (a TEST DOUBLE of upmd 0.2.7's --ci behaviour; it runs each block with sh -c);
 * - the code agent is tests/fixtures/fake-code-agent.mjs (a TEST DOUBLE: no model, nothing sent) as Qwen Code on a local
 *   endpoint; its PYREPLACE word edits the parameter file, and changes nothing when what it replaces is not there;
 * - OpenSCAD is tests/fixtures/fake-openscad.mjs (a TEST DOUBLE with no geometry engine: a box sized by -D values).
 * The tray recipe needs a Python with CadQuery to run under `timmy act`, which this machine does not have: its own last-build
 * check runs in tests/iterate.test.ts through the Workspace's seams. The `timmy` each block runs is the real CLI.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readChain, type Receipt } from '../src/utils/receipts.js';
import { readOperationRecord } from '../src/ops/operations.js';
import { json, opsKit, replOf, sandbox as opsSandbox, text } from './helpers/ops-sandbox.js';
import { BOARD_FILE } from '../src/repl/board.js';

const kit = opsKit();
afterEach(() => kit.cleanup(), 60_000);

const WORKFLOW = [
  '# FAKE workflow for the no-change test',
  '',
  '```bash [name:change]',
  'timmy act \'/iterate scad box.scad "make it 100 wide PYFILE:box.params.json PYREPLACE:60,=>100,"\' --wait',
  '```',
  '',
  '```bash [name:inspect, deps:change]',
  'stl=$(ls -t out/scad/*/box.stl 2>/dev/null | head -n 1)',
  'if [ -z "$stl" ]; then echo "no STL"; exit 1; fi',
  'timmy act "/inspect $stl" --wait',
  '```',
  '',
  '```bash [name:result, deps:inspect]',
  'timmy act \'/op\' --wait',
  '```',
  '',
].join('\n');

const blockReceipt = (chain: Receipt[], job: string, name: string): (Receipt & { block: Record<string, unknown> }) | undefined =>
  chain.find((r) => r.kind === 'workflow-block' && (r as { block?: { run?: string; name?: string } }).block?.run === job && (r as { block?: { name?: string } }).block?.name === name) as never;

describe('a satisfied request run again through /run and `timmy act` (FAKE upmd, agent and OpenSCAD)', () => {
  it('no change end to end: the flow, the block\'s exit and words, the job, the card, /room and God\'s Eye View; the blocks after it run only on a build that still matches', async () => {
    const s = opsSandbox(kit, 'no-change-run-');
    const { ws, notes } = replOf(kit, s);
    const { root } = s;
    fs.writeFileSync(path.join(root, 'WORKFLOW.md'), WORKFLOW);
    const run = async (): Promise<{ job: string; op: string; started: string }> => {
      const started = text(await ws.operate('/run WORKFLOW.md result', 'repl', () => ws.run('WORKFLOW.md result')));
      const job = /Running\s+(j[0-9a-f]{6})/.exec(started)?.[1];
      expect(job, started).toBeDefined();
      const h = ws.ops.latest!;
      await ws.jobs.done(job!);
      await ws.ops.done(h);
      return { job: job!, op: h.id, started };
    };

    // 1. The request, made: the flow changes the width 60 → 100, OpenSCAD builds it, inspect and result run.
    const first = await run();
    expect(ws.jobs.get(first.job)!.state, ws.jobs.tail(first.job, 200).join('\n')).toBe('completed');
    const flows1 = fs.readdirSync(path.join(root, 'results', 'flows'));
    expect(flows1).toHaveLength(1);
    expect(json(path.join(root, 'results', 'flows', flows1[0])).outcome).toBe('succeeded');
    // R4 (H99, gap 4): /run names its operation when it starts and on its ✓ line
    expect(first.started).toContain(`Operation  ${first.op}`);
    expect(notes.join('\n')).toMatch(new RegExp(`✓ ${first.job} completed .*operation ${first.op} \\(/op ${first.op}\\)`));

    // 2. The same request again (r24): the agent changes nothing; the last /scad run still matches its recorded inputs, so the
    //    change block exits 0 and the blocks that need it run on that build.
    const second = await run();
    const job2 = ws.jobs.get(second.job)!;
    const log2 = ws.jobs.tail(second.job, 400).join('\n');
    expect(job2.state, log2).toBe('completed');
    expect(job2.steps.map((x) => [x.name, x.state, x.code, x.outcome ?? ''])).toEqual([['change', 'completed', 0, 'no change'], ['inspect', 'completed', 0, ''], ['result', 'completed', 0, '']]);
    const flow2 = fs.readdirSync(path.join(root, 'results', 'flows')).map((n) => json(path.join(root, 'results', 'flows', n))).find((r) => r.operation === second.op)!;
    expect(flow2).toMatchObject({ outcome: 'no change', ended_in: 'checks', last_build: { state: 'current', build: { kind: 'native', app: 'openscad' } } });
    expect(String(flow2.why)).toContain('no change: the agent changed nothing, so nothing was rebuilt; the last OpenSCAD run (');
    expect(String(flow2.why)).toContain('still matches its recorded inputs: box.scad and box.params.json hash as recorded');
    // the block's own words, from `timmy act` (= and "no change", never ✖) and its exit 0
    expect(log2).toMatch(new RegExp(`= this request \\(in operation ${second.op}, joined\\) no change: flow f[0-9a-f]{8} no change: the last OpenSCAD run`));
    expect(log2).toMatch(/<== change exited with code 0/);
    // its block receipt: outcome no change, no status, the flow and the last build's state
    const chain = readChain('runs', root);
    const r2 = blockReceipt(chain, second.job, 'change')!;
    expect(r2.block).toMatchObject({ outcome: 'no change', state: 'completed', exit_code: 0, no_change: { flows: [flow2.id], last_build: 'current' } });
    expect(r2.status).toBeUndefined();
    expect(r2.subject).toBe('workflow · block · WORKFLOW.md › result · change · no change');
    // the REPL's notices: the block, then the run, with the operation
    const said2 = notes.join('\n');
    expect(said2).toMatch(new RegExp(`${second.job}  change no change: flow f[0-9a-f]{8}: the agent changed nothing, so nothing was rebuilt; the last OpenSCAD run`));
    expect(said2).toMatch(new RegExp(`✓ ${second.job} completed  WORKFLOW\\.md › result · 3 of 3 steps · change: no change .*operation ${second.op}`));
    // the operation card: the block in its words; the flow says no change once; the operation itself: no change
    const card2 = text(ws.op(second.op));
    expect(card2).toContain('1 change no change · 2 inspect completed · 3 result completed');
    expect(card2).toMatch(/Flow\s+f[0-9a-f]{8}\s+scad\s+no change: the agent changed nothing, so nothing was rebuilt/);
    expect(card2).not.toMatch(/no change: no change/);
    expect(readOperationRecord(root, second.op)).toMatchObject({ ok: true, record: { state: 'succeeded' } });

    // 3. The parameter file changed by hand since the last build, and the same request again: the agent changes nothing, the
    //    last build is stale, so the change block exits 4 and nothing after it runs on the stale build.
    const params = path.join(root, 'box.params.json');
    fs.writeFileSync(params, fs.readFileSync(params, 'utf8').replace('"width": 100', '"width": 120'));
    expect(fs.readFileSync(params, 'utf8')).toContain('"width": 120');
    const third = await run();
    const job3 = ws.jobs.get(third.job)!;
    const log3 = ws.jobs.tail(third.job, 400).join('\n');
    expect(job3.state, log3).toBe('failed'); // upmd's own end: a block exited non-zero (kept as it is)
    expect(job3.steps.map((x) => [x.name, x.state, x.code, x.outcome ?? ''])).toEqual([['change', 'failed', 4, 'no change']]);
    expect(log3).toMatch(/<== change exited with code 4/);
    expect(log3).not.toMatch(/==> inspect/);
    const flow3 = fs.readdirSync(path.join(root, 'results', 'flows')).map((n) => json(path.join(root, 'results', 'flows', n))).find((r) => r.operation === third.op)!;
    expect(flow3).toMatchObject({ outcome: 'no change', last_build: { state: 'stale' } });
    expect(String(flow3.why)).toMatch(/the last OpenSCAD run \([0-9a-f]{8}, [^)]+\) is stale: box\.params\.json has changed since \(sha256 [0-9a-f]{8} then, [0-9a-f]{8} now\); \/scad box\.scad runs it again/);
    // the job, as every view reads it: no change (=), never failed (✖)
    const said3 = notes.join('\n');
    expect(said3).toMatch(new RegExp(`= ${third.job} no change  WORKFLOW\\.md › result: stopped at change, which made no change: flow f[0-9a-f]{8}: .*is stale.* · 1 of 3 steps; change no change, exit 4; inspect, result not run.*operation ${third.op}`));
    expect(said3).not.toContain(`✖ ${third.job} failed`);
    const jobs = text(ws.jobsView(''));
    expect(jobs).toMatch(new RegExp(`= ${third.job} +no change`));
    expect(text(ws.jobsView(third.job))).toMatch(/change\s+no change/);
    // the operation: no change (its record, the card's head and the workflow part)
    expect(readOperationRecord(root, third.op)).toMatchObject({ ok: true, record: { state: 'no change' } });
    const card3 = text(ws.op(third.op));
    expect(card3).toMatch(new RegExp(`Operation ${third.op}\\s+no change`));
    expect(card3).toMatch(/Workflow\s+WORKFLOW\.md › result\s+job j[0-9a-f]{6}\s+no change · 1 of 3 steps/);
    expect(card3).toContain('1 change no change · 2 inspect not run · 3 result not run');
    // the Control Room and God's Eye View: the run and the flow say no change; neither says the run failed
    const room = text(await ws.room(''));
    expect(room).toMatch(new RegExp(`${third.job}[^\\n]*no change`));
    expect(room).not.toMatch(new RegExp(`${third.job}[^\\n]*failed`));
    expect(room).toMatch(new RegExp(`= ${third.job}  upmd \\(a workflow run\\)  no change`));
    // the board's snapshot: the workflow card's run and its block say no change (the = glyph), the flow card too
    ws.board('');
    const html = fs.readFileSync(path.join(root, BOARD_FILE), 'utf8');
    expect(html).toMatch(new RegExp(`${third.job}[\\s\\S]{0,400}wfs-nochange`));
    expect(html).toContain('<span class="wf-glyph" aria-hidden="true">=</span> <strong>no change</strong>');
    expect(html).toMatch(/<span class="state state-nochange">no change<\/span>/);
    const overview = text(await ws.overview('--all'));
    expect(overview).toContain('no change');
    expect(overview).not.toMatch(new RegExp(`${third.job}[^\\n]*failed`));
    // the block receipt of the stale case
    const r3 = blockReceipt(readChain('runs', root), third.job, 'change')!;
    expect(r3.block).toMatchObject({ outcome: 'no change', state: 'failed', exit_code: 4, no_change: { last_build: 'stale' } });
    expect(r3.status).toBeUndefined();
  }, 300_000);
});
