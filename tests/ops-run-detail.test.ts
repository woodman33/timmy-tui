/**
 * Round R4 (H102, part 2): one run detail for every surface (src/ops/run-detail.ts; the shape: src/contracts/run-detail.ts),
 * and `timmy op` (src/ops/op-cli.ts), each made from records real code wrote: a completed run, a run that made no change
 * (its last build current, then stale), a failed run, a cancelled one, one recovered after its Timmy was killed; the object
 * as JSON, its Markdown summary (kept once, never over itself), the refusals, and two runs of one request with the older one
 * asked for (nothing is picked by its time).
 *
 * FAKE pieces, each labelled where it is used:
 * - upmd is tests/fixtures/fake-upmd.mjs (a TEST DOUBLE of upmd 0.2.7's --ci behaviour; each block through sh -c);
 * - `timmy act '/iterate tray …'` is tests/fixtures/fake-tray-flow.ts (a TEST DOUBLE: no agent runs and nothing is built; it
 *   writes FAKE STEP bytes, a flow record through Timmy's own writer, and seals a real flow receipt under the block's
 *   operation), with the outcome the test sets: succeeded, no change with the last build current, or stale (exit 4, as
 *   `timmy act` exits then);
 * - one NEEDS YOU box is FAKE: the words a REPL's waiting box would give, passed through the run detail's `waiting` seam.
 * Real: the REPL's Workspace and its /run (the operation's record, the prediction receipt, the workflow job and its block
 * receipts, the run's receipt), /stop, `timmy md` killed with SIGKILL and /recover after it, `timmy evidence` and `timmy op`
 * as real child processes (the CLI through tsx), the job manager and the project's own receipt chain. Every folder is under
 * os.tmpdir().
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RUN_DETAIL_VERSION, type RunDetail } from '../src/contracts/run-detail.js';
import { RUN_DETAIL_SCHEMA, readRunDetail, runDetail, RunDetailError, runRecipe, runSummaryMarkdown, summaryRel } from '../src/ops/run-detail.js';
import { projectId } from '../src/project/index.js';
import { readChain, type Receipt } from '../src/utils/receipts.js';
import { parseWorkflow } from '../src/workflows/upmd.js';
import type { Workspace } from '../src/repl/workspace.js';
import { CLI, FAKE_UPMD, FIXTURES, opsKit, replOf, sandbox, sleep, text, TSX, until, type Sandbox } from './helpers/ops-sandbox.js';

const kit = opsKit();
/** The process groups of runs a test killed or left (the pty wrapper of a killed `timmy md`), ended after it. */
const groups: number[] = [];
afterEach(async () => {
  for (const g of groups.splice(0)) { try { process.kill(-g, 'SIGKILL'); } catch { /* ended */ } }
  await kit.cleanup();
}, 60_000);

const FAKE_TRAY = path.join(FIXTURES, 'fake-tray-flow.ts');
const PYTHON3 = String(spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout ?? '').trim() || null;
const F = '```';
const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
const short = (r: Receipt): string => r.hash.slice(7, 15);
const read = (s: Sandbox, rel: string): string => fs.readFileSync(path.join(s.root, rel), 'utf8');

/** The FAKE tray run's document: the change through `timmy act '/iterate tray …'`, then this run's STEP by its operation. */
const TRAY = [
  '# FAKE tray run for the run detail test', '',
  `${F}bash [name:change]`, 'timmy act \'/iterate tray "make the tray 150 mm wide"\' --wait', F, '',
  `${F}bash [name:inspect, deps:change]`, 'step=$(timmy evidence step) || exit 1', 'echo "the STEP: $step"', F, '',
].join('\n');
const FAIL = ['# FAKE: a run that fails', '', `${F}bash [name:first]`, 'echo first', F, '', `${F}bash [name:broken, deps:first]`, 'echo broken; exit 3', F, '', `${F}bash [name:after, deps:broken]`, 'echo after', F, ''].join('\n');
const SLOW = ['# FAKE: a run to stop', '', `${F}bash [name:first]`, 'echo first', F, '', `${F}bash [name:long, deps:first]`, 'touch long.started', 'sleep 30', F, ''].join('\n');

/**
 * The project the tray runs need: TRAY.md, and the parameter file holding the bytes the FAKE flow's record names as its
 * source (so its record is true of the project), and the sandbox's `timmy`: the real CLI, but for `act '/iterate tray …'`,
 * the FAKE tray flow (a TEST DOUBLE), whose outcome, export folder and last build the test sets in files.
 */
function trayProject(s: Sandbox): (o: { outcome?: string; job?: string; lastBuild?: string }) => void {
  fs.writeFileSync(path.join(s.root, 'TRAY.md'), TRAY);
  fs.mkdirSync(path.join(s.root, 'recipes'), { recursive: true });
  fs.writeFileSync(path.join(s.root, 'recipes', 'tray.params.json'), 'FAKE before');
  const conf = path.join(s.base, 'fake-tray');
  fs.mkdirSync(conf, { recursive: true });
  fs.writeFileSync(path.join(s.bin, 'timmy'), [
    '#!/bin/sh',
    '# FAKE: `timmy act \'/iterate tray …\'` is tests/fixtures/fake-tray-flow.ts (a TEST DOUBLE: no agent runs, nothing is built).',
    '# Every other word is the real CLI (src/cli.ts through tsx).',
    'if [ "$1" = "act" ]; then',
    '  case "$2" in /iterate*)',
    `    export FAKE_TRAY_OUTCOME="$(cat "${conf}/outcome" 2>/dev/null || echo succeeded)"`,
    `    export FAKE_TRAY_JOB="$(cat "${conf}/job" 2>/dev/null || echo 1a2b3c4d)"`,
    `    export FAKE_TRAY_LAST_BUILD="$(cat "${conf}/last-build" 2>/dev/null)"`,
    `    exec "${TSX}" "${FAKE_TRAY}" "$@" ;;`,
    '  esac',
    'fi',
    `exec "${TSX}" "${CLI}" "$@"`, '',
  ].join('\n'), { mode: 0o755 });
  return (o) => {
    for (const [k, v] of [['outcome', o.outcome], ['job', o.job], ['last-build', o.lastBuild]] as const) {
      const p = path.join(conf, k);
      if (v === undefined) fs.rmSync(p, { force: true }); else fs.writeFileSync(p, v);
    }
  };
}

/** `/run <doc> <block>` in the REPL, to its end: its job and operation. */
async function runOf(ws: Workspace, doc: string, block: string): Promise<{ job: string; op: string }> {
  const started = text(await ws.operate(`/run ${doc} ${block}`, 'repl', () => ws.run(`${doc} ${block}`)));
  const job = /Running\s+(j[0-9a-f]{6})/.exec(started)?.[1];
  expect(job, started).toBeDefined();
  const h = ws.ops.latest!;
  await ws.jobs.done(job!);
  await ws.ops.done(h);
  return { job: job!, op: h.id };
}

/** `timmy op …` as a real child process (the sandbox's `timmy`: the real CLI), in the project. */
function timmyOp(s: Sandbox, args: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(path.join(s.bin, 'timmy'), ['op', ...args], { cwd: o.cwd ?? s.root, env: { ...s.env, ...o.env }, encoding: 'utf8', timeout: 120_000 });
  return { status: r.status, stdout: String(r.stdout), stderr: String(r.stderr) };
}

/** The receipts of one operation on the project's chain. */
const receiptsOf = (s: Sandbox, op: string): Receipt[] => readChain('runs', s.root).filter((r) => r.operation_id === op);
const blockReceipt = (s: Sandbox, job: string, name: string): Receipt =>
  readChain('runs', s.root).find((r) => r.kind === 'workflow-block' && (r as { block?: { run?: string; name?: string } }).block?.run === job && (r as { block?: { name?: string } }).block?.name === name)!;
const flowOf = (s: Sandbox, op: string): { id: string; rel: string } => {
  const n = fs.readdirSync(path.join(s.root, 'results', 'flows')).find((x) => JSON.parse(read(s, `results/flows/${x}`)).operation === op)!;
  return { id: n.slice(0, -5), rel: `results/flows/${n}` };
};
const detailOf = (s: Sandbox, op: string, o: Parameters<typeof runDetail>[1] = {}): RunDetail => runDetail(op, { project: s.root, ...o });

describe('a run detail from the records a completed /run wrote (FAKE upmd, FAKE tray flow)', () => {
  it('every part with where it came from; two runs of one request, the older asked for, is its own; `timmy op` --json is the object, --summary its Markdown (upmd reads its recipe), --save keeps it once', async () => {
    const s = sandbox(kit, 'run-detail-');
    const set = trayProject(s);
    const { ws } = replOf(kit, s);
    set({ job: '1a2b3c4d' });
    const a = await runOf(ws, 'TRAY.md', 'inspect');
    // the same request again, later: a run of its own (another operation, another export folder), newer by every file's time
    set({ job: '5e6f7a8b' });
    const b = await runOf(ws, 'TRAY.md', 'inspect');
    expect(b.op).not.toBe(a.op);
    const flowA = flowOf(s, a.op);
    const flowB = flowOf(s, b.op);
    const stepA = 'out/recipes/1a2b3c4d/console-tray.step';
    const chainA = receiptsOf(s, a.op);
    const predict = chainA.find((r) => r.kind === 'predict')!;

    const d = detailOf(s, a.op);
    const rec = `.timmy/operations/${a.op}.json`;
    expect(d).toMatchObject({
      version: RUN_DETAIL_VERSION, operation: a.op, parent: null, children: [],
      project: { name: 'project', root: s.root, id: projectId(s.root) },
      objective: { value: '/run TRAY.md inspect', from: rec },
      sourceRevision: { value: `TRAY.md sha256:${sha(TRAY)} (the document the prediction sealed before upmd ran; no git revision is recorded)`, from: `receipt ${short(predict)}` },
      verdict: { state: 'completed', words: `succeeded: job ${a.job} completed`, from: rec },
      stage: { current: null, done: 2, total: 2, from: `job ${a.job}` },
      acceptance: { state: 'not reviewed' },
      prediction: { words: '/run TRAY.md inspect: change → inspect, each block exits 0', receipt: short(predict), frozenAt: predict.ts },
      freshness: { state: 'current', from: flowA.rel },
      cost: { usd: null, measured: false },
      summary: { path: null },
      next: { words: `review its result: ${stepA}`, command: `/inspect ${stepA}` },
    });
    // each process's own exit, apart from Timmy's verdict: upmd's, then each block's from its own receipt
    expect(d.exits).toEqual([
      { who: `upmd (job ${a.job})`, code: 0, state: 'completed', from: `job ${a.job}` },
      { who: 'block change', code: 0, state: 'completed', from: `receipt ${short(blockReceipt(s, a.job, 'change'))}` },
      { who: 'block inspect', code: 0, state: 'completed', from: `receipt ${short(blockReceipt(s, a.job, 'inspect'))}` },
    ]);
    // the frozen prediction beside each check, and the flow's readback beside its sealed prediction
    expect(d.checks).toEqual([
      { name: 'block change', predicted: 'exits 0', actual: 'exit 0', differs: false, from: `receipt ${short(blockReceipt(s, a.job, 'change'))}` },
      { name: 'block inspect', predicted: 'exits 0', actual: 'exit 0', differs: false, from: `receipt ${short(blockReceipt(s, a.job, 'inspect'))}` },
      { name: `flow ${flowA.id} readback`, predicted: 'matches the sealed prediction', actual: 'matches', differs: false, from: flowA.rel },
    ]);
    // its files, each with its role and where it came from: what it ran from, the flow's record (as its receipt sealed it),
    // its source, the STEP it delivered; its logs and records
    const flowReceipt = chainA.find((r) => r.kind === 'flow')!;
    expect(d.files.map((x) => [x.path.replace(/w[0-9a-f]{8}/, 'w…'), x.role, x.sha256 ?? '', x.from])).toEqual([
      ['TRAY.md', 'input', sha(TRAY), `receipt ${short(predict)}`],
      ['~/timmy/jobs/runs/w…/checked.md', 'input', sha(TRAY), `job ${a.job}`],
      [flowA.rel, 'record', sha(fs.readFileSync(path.join(s.root, flowA.rel))), `receipt ${short(flowReceipt)}`],
      ['recipes/tray.params.json', 'source', sha('FAKE before'), flowA.rel],
      [stepA, 'output', sha(fs.readFileSync(path.join(s.root, stepA))), flowA.rel],
      [`~/timmy/jobs/${a.job}.log`, 'log', '', `job ${a.job}`],
      [rec, 'record', '', rec],
    ]);
    expect(d.receipts).toEqual(chainA.map((r) => ({ id: short(r), kind: r.kind, subject: r.subject })));
    expect(d.receipts.map((r) => r.kind)).toEqual(['predict', 'flow', 'workflow-block', 'workflow-block', 'workflow']);
    expect(d.worker).toEqual({ harness: { value: 'upmd', from: `job ${a.job}` }, environment: { value: expect.stringMatching(/^\S+ .+/), from: `receipt ${short(predict)}` } });
    expect(d.time.startedAt).toBe(JSON.parse(read(s, rec)).started);
    expect(d.time.endedAt).toBe(JSON.parse(read(s, rec)).ended);
    expect(d.time.elapsedMs).toBe(Date.parse(d.time.endedAt!) - Date.parse(d.time.startedAt!));
    expect(d.cost).toEqual({ usd: null, measured: false, why: 'no record of this operation reports a request to a model or another priced service, so no cost is recorded (none is invented)' });
    expect(d.unknown).toEqual([{ field: 'worker.model', why: expect.stringContaining('no record of this operation names a model') }]);
    // the older run asked for is its own: nothing of the newer run (its operation, flow, export folder) is in it
    const all = JSON.stringify(d);
    for (const theirs of [b.op, b.job, flowB.id, '5e6f7a8b']) expect(all).not.toContain(theirs);
    // no test folder in it but the project's own root
    expect(JSON.stringify({ ...d, project: { ...d.project, root: '.' } })).not.toContain(s.base);
    // the newer run's own detail names its own STEP
    expect(detailOf(s, b.op).next).toEqual({ words: 'review its result: out/recipes/5e6f7a8b/console-tray.step', command: '/inspect out/recipes/5e6f7a8b/console-tray.step' });

    // `timmy op <id> --json`: the same object, with its schema
    const j = timmyOp(s, [a.op, '--json']);
    expect(j.status, j.stderr).toBe(0);
    expect(JSON.parse(j.stdout)).toEqual({ schema: RUN_DETAIL_SCHEMA, ...d });
    // plain words: one part a line, each with the record it came from
    const words = timmyOp(s, [a.op]);
    expect(words.status, words.stderr).toBe(0);
    const lines = words.stdout.split('\n');
    expect(lines[0]).toBe(`operation ${a.op} · project · completed`);
    expect(words.stdout).toContain(`  verdict     succeeded: job ${a.job} completed  [${rec}]`);
    expect(words.stdout).toContain(`  stage       2 of 2 steps ended  [job ${a.job}]`);
    expect(words.stdout).toContain(`  predicted   /run TRAY.md inspect: change → inspect, each block exits 0 (frozen ${predict.ts}, before the run)  [receipt ${short(predict)}]`);
    expect(words.stdout).toContain(`              block inspect: predicted exits 0, actual exit 0  [receipt ${short(blockReceipt(s, a.job, 'inspect'))}]`);
    expect(words.stdout).toContain(`  freshness   current: `);
    expect(words.stdout).toContain('  acceptance  not reviewed');
    expect(words.stdout).toContain('  cost        unknown: no record of this operation reports a request to a model');
    expect(words.stdout).toContain(`  next        review its result: ${stepA} → /inspect ${stepA}`);
    expect(words.stdout).not.toMatch(/\d+%/);

    // --summary: Markdown made from the run detail alone, the same text each time; its recipe, as upmd read it, parses
    const md = timmyOp(s, [a.op, '--summary']);
    expect(md.status, md.stderr).toBe(0);
    expect(md.stdout).toBe(runSummaryMarkdown(d, runRecipe(d)));
    expect(md.stdout.split('\n')[0]).toBe(`# Run ${a.op}: completed`);
    for (const h of ['## Outcome', '## Prediction and checks', '## Files', '## Worker and cost', '## Receipts', '## Next', '## Recipe']) expect(md.stdout).toContain(`\n${h}\n`);
    expect(md.stdout).toContain('| block change | exits 0 | exit 0 | no |');
    expect(md.stdout).toContain(`Predicted before the run, frozen at ${predict.ts} (receipt ${short(predict)})`);
    const recipe = parseWorkflow(md.stdout);
    const doc = parseWorkflow(TRAY);
    expect(recipe.map((x) => [x.name, x.deps, x.code])).toEqual(doc.map((x) => [x.name, x.deps, x.code]));

    // --save keeps it beside the operation's record, once: never over a file already there
    const saved = timmyOp(s, [a.op, '--summary', '--save']);
    expect(saved.status, saved.stderr).toBe(0);
    expect(saved.stdout).toBe(md.stdout);
    expect(saved.stderr).toContain(`kept the executive summary: ${summaryRel(a.op)} (sha256 ${sha(md.stdout).slice(0, 12)})`);
    expect(read(s, summaryRel(a.op))).toBe(md.stdout);
    const again = timmyOp(s, [a.op, '--save', '--json']);
    expect(again.status).toBe(1);
    expect(JSON.parse(again.stdout)).toEqual({ schema: RUN_DETAIL_SCHEMA, operation: a.op, ok: false, refusal: 'not saved', why: `${summaryRel(a.op)} is already there; a kept summary is never written over`, path: summaryRel(a.op), exit_code: 1 });
    expect(read(s, summaryRel(a.op))).toBe(md.stdout);
    // the run detail names the kept summary now; made again, the summary is the text kept
    const kept = detailOf(s, a.op);
    expect(kept.summary).toEqual({ path: summaryRel(a.op) });
    expect(kept.files.at(-1)).toEqual({ path: summaryRel(a.op), role: 'record', from: summaryRel(a.op) });
    expect(runSummaryMarkdown(kept, runRecipe(kept))).toBe(md.stdout);

    // freshness: what it made, changed since the run, is stale; the newer run's own STEP is untouched, so it stays current
    fs.writeFileSync(path.join(s.root, stepA), 'changed by hand after the run\n');
    const later = detailOf(s, a.op);
    expect(later.freshness).toEqual({ state: 'stale', why: `${stepA} changed since the run: sha256 ${sha('changed by hand after the run\n').slice(0, 12)} now, ${d.files.find((x) => x.path === stepA)!.sha256!.slice(0, 12)} as recorded`, from: flowA.rel });
    expect(later.verdict).toEqual(d.verdict);
    expect(detailOf(s, b.op).freshness.state).toBe('current');
    // what it ran from, changed since: stale too
    fs.writeFileSync(path.join(s.root, 'TRAY.md'), `${TRAY}\n<!-- edited -->\n`);
    expect(detailOf(s, b.op).freshness).toMatchObject({ state: 'stale', why: expect.stringMatching(/^TRAY\.md \(what it ran from\) changed since the run: /) });
  }, 240_000);
});

describe('a run that made no change (FAKE tray flow: its last build current, then stale)', () => {
  it('Timmy\'s verdict no change, kept apart from each exit (0, then upmd\'s 1 and the block\'s 4); the last build it checked as a reference; freshness from its check; one next action each', async () => {
    const s = sandbox(kit, 'run-detail-nochange-');
    const set = trayProject(s);
    const { ws } = replOf(kit, s);
    set({ job: '1a2b3c4d' });
    await runOf(ws, 'TRAY.md', 'inspect');
    // the export the FAKE flow's no-change check names beside the STEP (so its record is true of the project)
    fs.writeFileSync(path.join(s.root, 'out/recipes/1a2b3c4d/console-tray.stl'), 'FAKE stl');

    set({ outcome: 'no change', job: '1a2b3c4d' });
    const cur = await runOf(ws, 'TRAY.md', 'inspect');
    const flow = flowOf(s, cur.op);
    const d = detailOf(s, cur.op);
    expect(d.verdict).toEqual({ state: 'no change', words: expect.stringMatching(new RegExp(`^no change: job ${cur.job} every block exited 0; change made no change: flow ${flow.id}: `)), from: `.timmy/operations/${cur.op}.json` });
    expect(d.stage).toEqual({ current: null, done: 2, total: 2, from: `job ${cur.job}` });
    expect(d.exits.map((e) => [e.who, e.code, e.state])).toEqual([[`upmd (job ${cur.job})`, 0, 'completed'], ['block change', 0, 'no change'], ['block inspect', 0, 'completed']]);
    expect(d.checks.map((c) => [c.name, c.predicted, c.actual, c.differs])).toEqual([
      ['block change', 'exits 0', 'exit 0 (no change)', false],
      ['block inspect', 'exits 0', 'exit 0', false],
      [`flow ${flow.id} last build`, null, 'current: FAKE: the last build (recipe job 1a2b3c4d) still matches its recorded inputs', null],
    ]);
    // the last build it checked: not made by this run, so references, with the bytes its check recorded
    expect(d.files.filter((x) => x.role === 'reference').map((x) => [x.path, x.sha256, x.from])).toEqual([
      ['out/recipes/1a2b3c4d/console-tray.stl', sha('FAKE stl'), flow.rel],
      ['out/recipes/1a2b3c4d/console-tray.step', sha(read(s, 'out/recipes/1a2b3c4d/console-tray.step')), flow.rel],
    ]);
    expect(d.files.some((x) => x.role === 'output')).toBe(false);
    expect(d.freshness).toEqual({ state: 'current', why: expect.stringMatching(/^it made no change; its check \(\S+\) found the last build current: FAKE: the last build \(recipe job 1a2b3c4d\) still matches its recorded inputs; the 3 files its records name with a sha256 have those bytes now; what it ran from \(TRAY\.md\) is as recorded too$/), from: flow.rel });
    expect(d.next).toEqual({ words: 'nothing was changed: edit the request in TRAY.md, then run it again', command: '/run TRAY.md inspect' });

    // stale: the FAKE flow's check finds the request changed since the last build, and exits 4 as `timmy act` does
    set({ outcome: 'no change', job: '1a2b3c4d', lastBuild: 'stale' });
    const st = await runOf(ws, 'TRAY.md', 'inspect');
    const flow2 = flowOf(s, st.op);
    const e = detailOf(s, st.op);
    expect(e.verdict.state).toBe('no change');
    expect(e.verdict.words).toContain(`stopped at change, which made no change (upmd counted it as failed: exit 4`);
    expect(e.stage).toEqual({ current: null, done: 1, total: 2, from: `job ${st.job}` });
    // upmd's own exit and the block's, as they were: never Timmy's verdict
    expect(e.exits.map((x) => [x.who, x.code, x.state])).toEqual([[`upmd (job ${st.job})`, 1, 'failed'], ['block change', 4, 'no change']]);
    expect(e.checks.map((c) => [c.name, c.actual, c.differs])).toEqual([
      ['block change', 'exit 4 (no change)', true],
      ['block inspect', 'not run', true],
      [`flow ${flow2.id} last build`, 'stale: FAKE: the last build (recipe job 1a2b3c4d) is stale: the request has changed since it was built; /recipe tray runs it again', null],
    ]);
    // its exports' bytes are as recorded, but its check found the build stale: stale
    expect(e.freshness).toEqual({ state: 'stale', why: expect.stringMatching(/^it made no change; its check \(\S+\) found the last build stale: FAKE: the last build \(recipe job 1a2b3c4d\) is stale/), from: flow2.rel });
    expect(e.next).toEqual({ words: 'nothing was changed, and the last build no longer matches its inputs: rebuild it', command: '/recipe tray' });
    const md = runSummaryMarkdown(e, runRecipe(e));
    expect(md.split('\n')[0]).toBe(`# Run ${st.op}: no change`);
    expect(md).toContain('- Exits: upmd (job');
    expect(md).toContain('block change exit 4 (no change)');
    expect(md).toContain(`| block inspect | exits 0 | not run | yes | job ${st.job} |`);
  }, 240_000);
});

describe('a failed /run, a running one, a cancelled one (FAKE upmd)', () => {
  it('failed: the block\'s exit 3 beside its prediction; running: the block it is in, then NEEDS YOU from a waiting box (FAKE); cancelled by /stop', async () => {
    const s = sandbox(kit, 'run-detail-ends-');
    fs.writeFileSync(path.join(s.root, 'FAIL.md'), FAIL);
    fs.writeFileSync(path.join(s.root, 'SLOW.md'), SLOW);
    const { ws } = replOf(kit, s);

    const f = await runOf(ws, 'FAIL.md', 'after');
    const d = detailOf(s, f.op);
    expect(d.verdict).toEqual({ state: 'failed', words: `failed: job ${f.job} failed`, from: `.timmy/operations/${f.op}.json` });
    expect(d.stage).toEqual({ current: null, done: 2, total: 3, from: `job ${f.job}` });
    expect(d.exits.map((x) => [x.who, x.code, x.state])).toEqual([[`upmd (job ${f.job})`, 1, 'failed'], ['block first', 0, 'completed'], ['block broken', 3, 'failed']]);
    expect(d.checks.map((c) => [c.name, c.predicted, c.actual, c.differs])).toEqual([
      ['block first', 'exits 0', 'exit 0', false], ['block broken', 'exits 0', 'exit 3 (failed)', true], ['block after', 'exits 0', 'not run', true],
    ]);
    expect(d.freshness).toEqual({ state: 'unknown', why: 'no file it made is named with a sha256, so whether its result is still as it was made cannot be checked; what it ran from (FAIL.md) is as recorded', from: d.files[0].from });
    expect(d.next).toEqual({ words: 'see why: its blocks and log', command: `/jobs ${f.job}` });

    const started = text(await ws.operate('/run SLOW.md long', 'repl', () => ws.run('SLOW.md long')));
    const job = /Running\s+(j[0-9a-f]{6})/.exec(started)![1];
    const h = ws.ops.latest!;
    await until(() => fs.existsSync(path.join(s.root, 'long.started')), 30_000, 'the long block');
    let live: RunDetail | undefined;
    await until(() => { live = detailOf(s, h.id); return live.stage.current === 'long'; }, 30_000, 'the run detail to name the block running');
    expect(live!.verdict).toEqual({ state: 'running', words: 'running: long', from: `.timmy/operations/${h.id}.json` });
    expect(live!.stage).toEqual({ current: 'long', done: 1, total: 2, from: `job ${job}` });
    expect(live!.time.endedAt).toBeNull();
    expect(live!.time.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(live!.checks.at(-1)).toMatchObject({ name: 'block long', actual: 'running', differs: null });
    expect(live!.next).toEqual({ words: `follow it; /stop ${job} stops it`, command: `/jobs ${job}` });
    // FAKE: a NEEDS YOU box waiting for this operation in the caller's own REPL, in its words (the `waiting` seam)
    const asked = detailOf(s, h.id, { waiting: (op) => (op === h.id ? 'FAKE: run long: approve its command first' : undefined) });
    expect(asked.verdict).toEqual({ state: 'needs you', words: 'needs you: FAKE: run long: approve its command first', from: `.timmy/operations/${h.id}.json` });
    expect(asked.next?.words).toBe('answer its NEEDS YOU box in the REPL: y runs it once; n, Esc or Enter deny it');

    await ws.operate(`/stop ${job}`, 'repl', () => ws.stop(job));
    await ws.jobs.done(job);
    await ws.ops.done(h);
    const c = detailOf(s, h.id);
    expect(c.verdict).toEqual({ state: 'cancelled', words: `stopped: job ${job} stopped`, from: `.timmy/operations/${h.id}.json` });
    expect(c.exits.map((x) => [x.who, x.code, x.state])).toEqual([[`upmd (job ${job})`, null, 'cancelled'], ['block first', 0, 'completed'], ['block long', null, 'stopped']]);
    expect(c.checks.at(-1)).toMatchObject({ name: 'block long', predicted: 'exits 0', actual: 'stopped', differs: true });
    expect(c.time.endedAt).not.toBeNull();
    expect(c.next).toEqual({ words: 'it was stopped: run it again when you want it', command: '/run SLOW.md long' });
  }, 180_000);
});

describe('a run recovered after its Timmy was killed (`timmy md`, SIGKILL; FAKE upmd on a real pty)', () => {
  it.skipIf(!PYTHON3)('left running: unknown, and /recover says what to do; after /recover: recovered, its block interrupted', async () => {
    const s = sandbox(kit, 'run-detail-recover-');
    fs.writeFileSync(path.join(s.root, 'SLOW.md'), SLOW);
    const child = spawn(path.join(s.bin, 'timmy'), ['md', 'SLOW.md', 'long'], { cwd: s.root, env: { ...s.env, UPMD_BIN: FAKE_UPMD }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    kit.children.push(child);
    if (child.pid) groups.push(child.pid);
    let out = '';
    child.stdout!.setEncoding('utf8').on('data', (c: string) => { out += c; });
    child.stderr!.setEncoding('utf8').on('data', (c: string) => { out += c; });
    const closed = new Promise<void>((z) => { child.on('close', () => z()); });
    await until(() => fs.existsSync(path.join(s.root, 'long.started')), 60_000, `the long block (${out})`);
    await sleep(300);
    process.kill(-child.pid!, 'SIGKILL');
    await closed;
    const ops = fs.readdirSync(path.join(s.root, '.timmy', 'operations')).filter((n) => /^o[0-9a-f]{8}\.json$/.test(n));
    expect(ops).toHaveLength(1);
    const op = ops[0].slice(0, -5);
    const jobs = path.join(s.home, 'timmy', 'jobs');
    const job = fs.readdirSync(jobs).find((n) => /^j[0-9a-f]{6}\.json$/.test(n))!.slice(0, -5);
    const wrapper = (JSON.parse(fs.readFileSync(path.join(jobs, `${job}.json`), 'utf8')) as { pid?: number }).pid;
    if (wrapper) groups.push(wrapper);
    // its pty wrapper sees its timmy md gone and stops upmd
    await until(() => { try { process.kill(-wrapper!, 0); return false; } catch { return true; } }, 30_000, 'the run\'s wrapper to end');

    const left = detailOf(s, op);
    expect(left.verdict).toEqual({ state: 'unknown', words: 'left running: its record says it runs, and the Timmy that began it has ended; /recover records how its runs ended', from: `.timmy/operations/${op}.json` });
    expect(left.next).toEqual({ words: 'record how its runs ended', command: '/recover' });

    const { ws } = replOf(kit, s);
    await ws.recover('');
    const r = detailOf(s, op);
    expect(r.verdict.state).toBe('recovered');
    expect(r.verdict.words).toMatch(/^interrupted: /);
    expect(r.verdict.from).toBe(`.timmy/operations/${op}.json`);
    expect(r.exits.find((x) => x.who === 'block long')).toMatchObject({ state: 'interrupted' });
    expect(r.checks.find((c) => c.name === 'block long')).toMatchObject({ predicted: 'exits 0', actual: expect.stringMatching(/interrupted/), differs: true });
    expect(r.time.endedAt).not.toBeNull();
    expect(r.next).toEqual({ words: 'it was interrupted when the Timmy running it ended, and recovery recorded it: run it again', command: '/run SLOW.md long' });
  }, 180_000);
});

describe('`timmy op` refuses, with why', () => {
  it('not an id (2); no record of it here (1); another project\'s, naming it and how to ask there (1); a record that cannot be read, named (1); its id from TIMMY_OPERATION', async () => {
    const s = sandbox(kit, 'run-detail-refuse-');
    fs.writeFileSync(path.join(s.root, 'FAIL.md'), FAIL);
    const { ws } = replOf(kit, s);
    const f = await runOf(ws, 'FAIL.md', 'after');

    const bad = timmyOp(s, ['nope']);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('nope is not an operation id (o and 8 hex digits): /ops lists them');
    const none = timmyOp(s, []);
    expect(none.status).toBe(2);
    expect(none.stderr).toContain('Name the operation (o and 8 hex digits; /ops lists them), or run it where TIMMY_OPERATION is set');
    expect(timmyOp(s, [f.op, '--json', '--summary']).status).toBe(2);

    const unknown = timmyOp(s, ['o00000000', '--json']);
    expect(unknown.status).toBe(1);
    expect(JSON.parse(unknown.stdout)).toMatchObject({ schema: RUN_DETAIL_SCHEMA, operation: 'o00000000', ok: false, refusal: 'unknown', exit_code: 1 });
    expect(unknown.stderr).toContain('timmy op: unknown: no record, job or receipt of project names operation o00000000');

    // another project of the same Timmy (its jobs folder): the run is not that project's; it says whose, and how to ask there
    const other = path.join(s.base, 'other');
    fs.mkdirSync(other);
    const elsewhere = timmyOp(s, [f.op, '--json'], { cwd: other });
    expect(elsewhere.status).toBe(1);
    expect(JSON.parse(elsewhere.stdout)).toEqual({
      schema: RUN_DETAIL_SCHEMA, operation: f.op, ok: false, refusal: 'other project', elsewhere: { name: 'project', root: s.root },
      why: `operation ${f.op} is not other's: it is project's (its job ${f.job} ran there); timmy op ${f.op} --project ${s.root}`, exit_code: 1,
    });
    expect(readRunDetail(f.op, { project: other })).toMatchObject({ ok: false, refusal: 'other project', elsewhere: { name: 'project', root: s.root } });
    expect(() => runDetail(f.op, { project: other })).toThrow(RunDetailError);
    // asked there, as it says: shown
    const there = timmyOp(s, [f.op, '--project', s.root], { cwd: other });
    expect(there.status, there.stderr).toBe(0);
    expect(there.stdout.split('\n')[0]).toBe(`operation ${f.op} · project · failed`);

    // a record that cannot be read: named, never guessed around
    fs.writeFileSync(path.join(s.root, '.timmy', 'operations', 'o0badbad0.json'), '{ not json');
    const broken = timmyOp(s, ['o0badbad0']);
    expect(broken.status).toBe(1);
    expect(broken.stderr).toContain('timmy op: unreadable: operation o0badbad0\'s record .timmy/operations/o0badbad0.json cannot be read: ');

    // a /run's block has its operation's id in TIMMY_OPERATION: `timmy op` with no id shows that one
    const inBlock = timmyOp(s, [], { env: { TIMMY_OPERATION: f.op } });
    expect(inBlock.status, inBlock.stderr).toBe(0);
    expect(inBlock.stdout.split('\n')[0]).toBe(`operation ${f.op} · project · failed`);
  }, 180_000);
});
