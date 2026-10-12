/**
 * R4 (H109; r25 D9 c): Timmy Canvas's rules for a parameter card placed for an operation (companion/studio-canvas/src/cards.js
 * boundDetail, nowBeside, boundOperation), run here in Node: what it keeps of what the operation used, beside the file as it is
 * now, and never in its place; and for a workflow card placed for one (boundRun): its own run beside the newest. The cards
 * themselves run in a real Chromium in tests/studio-used-values-browser.test.ts and tests/studio-operation-runs-browser.test.ts.
 * The readings below are FIXTURES in the shape GET /api/project?detail=1 answers.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error: the page's module is plain JavaScript, bundled for the browser
import { boundDetail, boundOperation, nowBeside } from '../companion/studio-canvas/src/cards.js';

const OP = 'oa0a9ed5a';
const FILE = 'recipes/tray.params.json';
const detail = (width: number, state = 'ok') => ({ type: 'params', engine: 'tray', file: FILE, state, base: `${width}`.padStart(64, '0'), values: [{ name: 'width', value: width, kind: 'number', unit: 'mm' }, { name: 'wall', value: 3, kind: 'number', unit: 'mm' }] });
const used = { operation: OP, file: FILE, state: 'recorded', values: [{ name: 'width', value: 150, unit: 'mm' }, { name: 'wall', value: 3, unit: 'mm' }], sha256: 'a'.repeat(64), from: 'its flow fa0a9ed5a (succeeded) rebuilt the tray from these values; receipt 1a2b3c4d sealed its record', verified: true, build: 'recipe job abcd1234 succeeded' };
const reading = (ops: unknown[]) => ({ project: { id: 'p1', name: 'tray25' }, madeAt: '2026-10-11T12:00:00.000Z', operations: ops });

describe("a parameter card placed for an operation", () => {
  it('names the operation it was placed for from its shape, and nothing else counts as one', () => {
    expect(boundOperation({ meta: { timmyOperation: OP } })).toBe(OP);
    expect(boundOperation({ meta: { timmyOperation: 'o12' } })).toBeNull();
    expect(boundOperation({ meta: {} })).toBeNull();
    expect(boundOperation(null)).toBeNull();
  });

  it('keeps what the reading says the operation used, beside today\'s detail (never in its place)', () => {
    const d = boundDetail(detail(160), OP, reading([{ id: OP, used: [used] }]), null);
    expect(d.values[0].value).toBe(160);
    expect(d.used).toEqual(used);
    // one value beside the file now: said only where the file differs now
    expect(nowBeside('width', 150, d)).toBe(`now 160 mm in ${FILE}`);
    expect(nowBeside('wall', 3, d)).toBeNull();
    expect(nowBeside('bore', 5, d)).toBe(`not in ${FILE} now`);
    // a file that is not there, or not usable, now: nothing beside a value (the card says so once)
    expect(nowBeside('width', 150, detail(160, 'none'))).toBeNull();
    expect(nowBeside('width', 150, null)).toBeNull();
  });

  it('when the reading lists the operation and none of its records names the file: unknown, and why', () => {
    const d = boundDetail(detail(160), OP, reading([{ id: OP, used: [] }]), null);
    expect(d.used).toMatchObject({ operation: OP, file: FILE, state: 'unknown', values: [], sha256: null, verified: false });
    expect(d.used.from).toBe(`no record of operation ${OP} names ${FILE}: no flow of it changed the file, and no receipt of it names the file's bytes`);
  });

  it('when the reading does not list the operation: what it last read, said as last read; with nothing earlier, unknown', () => {
    const last = boundDetail(detail(160), OP, reading([{ id: 'ob1b2c3d4' }]), { type: 'params', used });
    expect(last.used).toEqual({ ...used, asLastRead: true });
    // read again unlisted: the same (a card is not written again when nothing changed)
    expect(boundDetail(detail(160), OP, reading([]), last)).toEqual(last);
    const none = boundDetail(detail(160), OP, reading([]), null);
    expect(none.used).toMatchObject({ state: 'unknown', values: [] });
    expect(none.used.from).toMatch(/is not among the operations this reading lists/);
    // what another operation used, or another file's, is never taken
    expect(boundDetail(detail(160), OP, reading([]), { used: { ...used, operation: 'ob1b2c3d4' } }).used.state).toBe('unknown');
    expect(boundDetail(detail(160), OP, reading([{ id: OP, used: [{ ...used, file: 'box.params.json' }] }]), null).used.state).toBe('unknown');
  });

  it('leaves a result card, and a card placed for no operation, as it is', () => {
    const r = { type: 'result', title: 'flow' };
    expect(boundDetail(r, OP, reading([{ id: OP, used: [used] }]), null)).toBe(r);
    const d = detail(160);
    expect(boundDetail(d, null, reading([{ id: OP, used: [used] }]), null)).toBe(d);
    const w = { type: 'workflow', doc: 'RUN.md' };
    expect(boundDetail(w, null, reading([]), null)).toBe(w);
    expect(boundDetail(null, OP, reading([]), null)).toBeNull();
  });
});

// R4 (H109; the operator's "Bind workflow/result nodes to real operation and artifact IDs"): a workflow card placed for an
// operation keeps that operation's own run beside the newest (boundRun). FIXTURES in the shape GET /api/project?detail=1 answers.
describe('a workflow card placed for an operation', () => {
  const Y = 'ob1b2c3d4';
  const run = (job: string, word: string) => ({ job, target: 'build', word, met: null, receipt: null, predicted: null, startedAt: '2026-10-11T10:00:00.000Z', endedAt: '2026-10-11T10:00:01.000Z', took: '0.1 s', error: null, note: null, blocks: [], outputs: [], more: 0 });
  const wf = (newestOp: string | null, word = 'completed') => ({
    type: 'workflow', doc: 'RUN.md', blocks: [{ name: 'build', word, glyph: '✓', detail: 'exit 0' }], last: run('j-newest', word),
    operation: { id: newestOp, from: "its newest run's job record (j-newest)", request: null, state: null },
  });
  const mine = { card: 'workflow:RUN.md', doc: 'RUN.md', last: run('j-mine', 'failed'), blocks: [{ name: 'build', word: 'failed', glyph: '✗', detail: 'exit 1' }] };

  it("is its own detail when the newest run is the operation's own", () => {
    const d = wf(OP);
    expect(boundDetail(d, OP, reading([{ id: OP, ran: [] }]), null)).toBe(d);
  });

  it("keeps the operation's own run, from the reading, beside a newer run of another operation (never in its place)", () => {
    const d = boundDetail(wf(Y), OP, reading([{ id: OP, ran: [mine] }]), null);
    expect(d.last.job).toBe('j-newest');
    expect(d.ran).toEqual({ operation: OP, doc: 'RUN.md', state: 'recorded', last: mine.last, blocks: mine.blocks });
  });

  it('when the reading read its runs and none ran the document: unknown, and why', () => {
    const d = boundDetail(wf(Y), OP, reading([{ id: OP, ran: [{ ...mine, doc: 'OTHER.md' }] }]), null);
    expect(d.ran).toMatchObject({ operation: OP, state: 'unknown', last: null, blocks: [] });
    expect(d.ran.why).toBe(`no job record Timmy keeps names operation ${OP} running RUN.md`);
  });

  it('otherwise what it last read, as last read: its run kept before, or its own detail when the newest run was its own; else unknown', () => {
    // placed while its run was the newest; another operation ran it since, and the reading no longer lists this one
    const kept = boundDetail(wf(Y), OP, reading([]), wf(OP, 'completed'));
    expect(kept.ran).toEqual({ operation: OP, doc: 'RUN.md', state: 'recorded', last: run('j-newest', 'completed'), blocks: [{ name: 'build', word: 'completed', glyph: '✓', detail: 'exit 0' }], asLastRead: true });
    // read again: the same
    expect(boundDetail(wf(Y), OP, reading([]), kept)).toEqual(kept);
    // listed, its runs not read in this reading: kept as last read too
    expect(boundDetail(wf(Y), OP, reading([{ id: OP }]), kept).ran).toEqual(kept.ran);
    const none = boundDetail(wf(Y), OP, reading([{ id: OP }]), null);
    expect(none.ran.why).toBe(`the runs of operation ${OP} were not read in this reading, and this card holds no earlier reading of its run`);
    expect(boundDetail(wf(Y), OP, reading([]), null).ran.why).toBe(`operation ${OP} is not among the operations this reading lists, and this card holds no earlier reading of its run`);
    // another operation's run, or another document's, is never taken
    expect(boundDetail(wf(Y), OP, reading([]), { ...wf(Y), ran: { ...kept.ran, operation: Y } }).ran.state).toBe('unknown');
    expect(boundDetail(wf(Y), OP, reading([]), { ...wf(OP), doc: 'OTHER.md' }).ran.state).toBe('unknown');
  });
});
