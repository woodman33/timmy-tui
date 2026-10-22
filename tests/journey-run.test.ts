// R10 (H164): a run's summary in project context (src/journey/run.ts runSummary), journey step 4: "Inspect its workflow
// progress, result and receipt without losing project context". Read from the one run detail (src/ops/run-detail.ts
// readRunDetail, the producer every surface's run detail draws): its progress (steps done of total, its state), its result
// (each exit, its outputs, the verdict), its receipts verified here, with the project it belongs to (its name and folder).
//
// The run is real: the REPL's own Workspace runs /run REPORT.md report (tests/helpers/run-inspect-fixture.ts), with upmd a
// TEST DOUBLE (tests/fixtures/fake-upmd.mjs) and the change block's flow a TEST DOUBLE (tests/fixtures/fake-params-flow.ts);
// its records (the operation's, the prediction receipt, the job, the block receipts, the run's receipt) are Timmy's own.
import { afterEach, describe, expect, it } from 'vitest';
import { readRunInspection } from '../src/ops/run-detail.js';
import { readChain, type Receipt } from '../src/utils/receipts.js';
import { recentWork, runSummary } from '../src/journey/index.js';
import { opsKit, replOf, sandbox } from './helpers/ops-sandbox.js';
import { reportProject, runOf } from './helpers/run-inspect-fixture.js';

const kit = opsKit();
afterEach(async () => { await kit.cleanup(); }, 60_000);

describe('runSummary: a run\'s progress, result and receipt, with its project (R10 H164)', () => {
  it('a FAKE workflow run that wrote five files: 2 of 2 steps, completed, each exit, its outputs, its receipt verified; recentWork says the same', async () => {
    const s = sandbox(kit, 'journey-run-');
    reportProject(s);
    const { ws } = replOf(kit, s);
    const { op } = await runOf(ws, 'REPORT.md', 'report');
    const chain = readChain('runs', s.root);
    const ctx = { project: { name: 'project', root: s.root }, chain, jobs: ws.jobs.list() };
    const r = runSummary(ctx, op);
    if (!r.ok) throw new Error(r.why);
    expect(r.operation).toBe(op);
    expect(r.project).toMatchObject({ name: 'project', root: s.root });
    expect(r.project.id).toMatch(/^[0-9a-f]{16}$/);
    expect(r.title).toBe('Workflow run: report in REPORT.md');
    expect(r.progress).toMatchObject({ state: 'completed', done: 2, total: 2, current: null, words: '2 of 2 steps · completed' });
    // each process's own exit, kept apart from the verdict
    expect(r.result.exits.map((e) => `${e.who}: ${e.code}`)).toEqual(expect.arrayContaining([expect.stringMatching(/^upmd.*\(job j[0-9a-f]{6}\): 0$/), 'block change: 0', 'block report: 0']));
    // the four files the report block wrote, and the flow record the change block's TEST DOUBLE wrote (its receipt sealed both)
    expect(r.result.outputs.map((o) => o.path)).toEqual(['out/blob.bin', 'out/preview.png', 'out/report.md', 'out/summary.json', expect.stringMatching(/^results\/flows\/f[0-9a-f]{8}\.json$/)]);
    // the same files, in the same order, as the run inspection (the companion's run detail) lists them
    const ins = readRunInspection(op, { project: s.root, jobs: ws.jobs.list(), chain });
    if (!ins.ok) throw new Error(ins.why);
    expect(r.result.outputs.map((o) => o.path)).toEqual(ins.inspection.outputs.filter((o) => o.kind === 'file').map((o) => o.path));
    expect(r.result.outputs.find((o) => o.path === 'out/preview.png')!.open).toMatchObject({ tab: 'home', preview: 'image', select: { name: 'file', value: 'out/preview.png' } });
    expect(r.result.verdict).toMatch(/^succeeded/);
    // its own receipt (its workflow's, never the prediction), verified here; every receipt of the run with its state
    const own = chain.find((x) => x.operation_id === op && x.kind === 'workflow') as Receipt;
    expect(r.receipt).toEqual({ id: own.hash.slice(7, 15), kind: 'workflow', verified: true });
    expect(r.receipts.length).toBeGreaterThanOrEqual(3);
    expect(r.receipts.every((x) => x.verified)).toBe(true);
    expect(r.receipts.map((x) => x.kind)).toEqual(expect.arrayContaining(['predict', 'workflow']));
    expect(r.open).toMatchObject({ surface: 'companion', tab: 'workflows', query: `tab=workflows&run=${op}` });
    // one source: the recent work's item for this run says the same state and the same receipt
    const item = recentWork(ctx, 20).items.find((i) => i.kind === 'run' && i.id === op)!;
    expect(item).toMatchObject({ state: 'completed', receipt: { id: r.receipt!.id, verified: true }, title: r.title });
    expect(item.results).toEqual(r.result.outputs.map((o) => o.path));

    // a receipt changed on a copy of the chain (FIXTURE): it does not verify, and the summary says so, never green
    const tampered = chain.map((x) => (x.hash === own.hash ? { ...x, subject: `${x.subject} (changed)` } as Receipt : x));
    const t = runSummary({ ...ctx, chain: tampered }, op);
    if (!t.ok) throw new Error(t.why);
    expect(t.receipt).toMatchObject({ id: own.hash.slice(7, 15), verified: false });
    expect(t.receipt!.why).toMatch(/body hash mismatch/);
  });

  it('not an operation id, and an operation this project has no record of: refused in words, nothing made up', () => {
    const s = sandbox(kit, 'journey-run-none-');
    const ctx = { project: { name: 'project', root: s.root }, chain: [], jobs: [] };
    expect(runSummary(ctx, '../etc')).toMatchObject({ ok: false, refusal: 'not an id' });
    const none = runSummary(ctx, 'o00000000');
    expect(none).toMatchObject({ ok: false, refusal: 'unknown' });
    expect((none as { why: string }).why).toMatch(/o00000000/);
  });
});
