// R10 (H164): the project's recent work (src/journey/recent.ts recentWork), newest first, one list for every surface: its chat
// turns and runs (their sealed receipts, verified here), its files (references, results, meshes, recordings), its VoxVision
// observations, the Studio drafts waiting for Accept or Discard, and its other receipts, each with a few plain words, when,
// its state, its receipt (id, verified) and where it opens (src/journey/open.ts openTarget). Bounded: each reader reads at
// most what the list can show, in the folders where each kind lives (never a walk of the whole project: R9's item B).
//
// A real project folder of this test's own: operation records, files with set times, a VoxVision record, a Studio board saved
// with a draft on it, and receipts sealed through the one writer (appendReceipt, into this test's store). Nothing runs.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { takeTurnHold } from '../src/agent/chat-turn.js';
import { hexOfPath, recentWork, RECENT_CAPS, runTitle, type WorkItem } from '../src/journey/index.js';
import { projectId } from '../src/project/index.js';
import { boardDir } from '../src/studio/boards.js';
import { canvasDir } from '../src/studio/document.js';
import { appendReceipt, readChain, type Receipt } from '../src/utils/receipts.js';

const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
const T = (m: number): string => new Date(Date.UTC(2026, 9, 22, 11, 0) + m * 60_000).toISOString();
const short = (r: Receipt): string => r.hash.slice(7, 15);

let box = '';
let root = '';
let pid = '';
const keptHome = process.env.TIMMY_HOME;
const sealed: Record<string, Receipt> = {};

function put(rel: string, body: string | Buffer, at: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  const t = new Date(at);
  utimesSync(abs, t, t);
}
function op(id: string, o: { request: string; state: string; started: string; ended: string | null; via?: string; runs?: Array<{ kind: string; id: string; at: string }> }): void {
  put(`.timmy/operations/${id}.json`, JSON.stringify({ schema: 'timmy.operation/1', id, request: o.request, via: o.via ?? 'repl', project: 'tray', started: o.started, ended: o.ended, state: o.state, parent: null, runs: o.runs ?? [], owner: { pid: 1, started: o.started } }), o.ended ?? o.started);
}
const seal = (name: string, input: Record<string, unknown>): Receipt => { sealed[name] = appendReceipt('runs', input as never); return sealed[name]; };

beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'journey-recent-'));
  root = join(box, 'tray');
  mkdirSync(root, { recursive: true });
  pid = projectId(root);
  process.env.TIMMY_HOME = join(box, 'home', 'timmy');
  // a workflow run that wrote out/report.md (its prediction sealed first), a run still running, a chat turn and its operation
  op('o1111aaaa', { request: '/run REPORT.md report', state: 'succeeded', started: T(0), ended: T(2), runs: [{ kind: 'job', id: 'j1a2b3c', at: T(0) }] });
  op('o2222bbbb', { request: '/iterate tray make the walls 2 mm thicker', state: 'running', started: T(10), ended: null });
  op('o3333cccc', { request: 'how deep is the tray?', via: 'workbench', state: 'answered', started: T(11), ended: T(12) });
  seal('predict', { kind: 'predict', subject: 'predict · REPORT.md › report', policy: 'human-gated', status: 'ok', operation_id: 'o1111aaaa', project_id: pid, ts: T(0) });
  seal('check', { kind: 'check', subject: 'setup check', policy: 'human-gated', status: 'ok', project_id: pid, ts: T(1) });
  seal('workflow', { kind: 'workflow', subject: 'workflow · REPORT.md › report', policy: 'human-gated', status: 'ok', operation_id: 'o1111aaaa', project_id: pid, outputs: [{ path: 'out/report.md', sha256: sha('# Report\n'), bytes: 9 }], ts: T(2) });
  seal('turn', {
    kind: 'chat', subject: 'chat.turn · workbench · 1 step · qwen3:8b', policy: 'human-gated', status: 'ok', operation_id: 'o3333cccc', project_id: pid,
    via: 'ollama', model_requested: 'qwen3:8b', model_resolved: 'qwen3:8b', prompt_hash: sha('how deep is the tray?'), response_hash: sha('12 mm.'),
    sources: [{ kind: 'ollama', host: '127.0.0.1:11434', endpoint: 'local', tools: 'on', cost_basis: 'local endpoint' }], cost_usd: 0, cost_measured: true, ms: 900, ts: T(12),
  });
  // another project's turn on the same chain: never listed here
  seal('foreign', { kind: 'chat', subject: 'chat.turn · repl · 1 step · x', policy: 'human-gated', status: 'ok', project_id: 'ffffffffffffffff', ts: T(20) });
  // the project's files: a reference image, a mesh, a recording, the run's result, a workflow document (not an artifact)
  put('refs/preview.png', Buffer.from('89504e47', 'hex'), T(3));
  put('refs/demo-tray.stl', 'solid demo\nendsolid demo\n', T(4));
  put('refs/demo-tray.rrd', Buffer.from('RRF2'), T(5));
  put('out/report.md', '# Report\n', T(2));
  put('REPORT.md', '# Report (review demo)\n', T(-5));
  // a VoxVision observation, sealed by a vox receipt of its exact bytes
  const record = JSON.stringify({ schema: 'timmy.vox/1', id: 'v1a2b3c4d', action: 'detect', command: '/detect refs/preview.png color 255,255,255', made_at: T(6), project: 'tray', status: 'ok', inputs: [{ path: 'refs/preview.png', kind: 'image' }], tools: [], metrics: [], highlights: [], failures: [], notes: [] });
  put('results/vox/v1a2b3c4d.json', record, T(6));
  // the /detect that made it (its operation), and the /add that brought the image in (an intake), as `timmy act` records them
  op('o5555eeee', { request: '/detect refs/preview.png color 255,255,255', state: 'succeeded', started: T(6), ended: T(6) });
  seal('vox', { kind: 'vox', subject: 'vox · detect refs/preview.png', policy: 'human-gated', status: 'ok', operation_id: 'o5555eeee', project_id: pid, outputs: [{ path: 'results/vox/v1a2b3c4d.json', sha256: sha(record) }], ts: T(6) });
  op('o6666ffff', { request: '/add /elsewhere/examples/visual-tools/preview.png', state: 'answered', started: T(3), ended: T(3) });
  seal('intake', { kind: 'intake', subject: 'intake · 1 file into refs/', policy: 'human-gated', status: 'ok', operation_id: 'o6666ffff', project_id: pid, files: [{ path: 'refs/preview.png', sha256: sha(Buffer.from('89504e47', 'hex')) }], ts: T(3) });
  // Studio's board for the project, saved with a draft Timmy proposed on it (waiting for Accept or Discard)
  const board = join(boardDir(canvasDir(process.env), pid), 'canvas.json');
  mkdirSync(dirname(board), { recursive: true });
  writeFileSync(board, JSON.stringify({ format: 'timmy-canvas', snapshot: { store: {
    'shape:a': { typeName: 'shape', id: 'shape:a', type: 'geo', meta: { timmyDraft: { id: 'draft-0a1b2c3d', job: 'j9f8e7d', at: T(8) } } },
    'shape:b': { typeName: 'shape', id: 'shape:b', type: 'geo', meta: { timmyDraft: { id: 'draft-0a1b2c3d', job: 'j9f8e7d', at: T(8) } } },
    'shape:c': { typeName: 'shape', id: 'shape:c', type: 'geo', meta: {} },
  } } }));
});
afterEach(() => {
  if (keptHome === undefined) delete process.env.TIMMY_HOME; else process.env.TIMMY_HOME = keptHome;
  for (const k of Object.keys(sealed)) delete sealed[k];
  rmSync(box, { recursive: true, force: true });
});

const ctx = () => ({ project: { name: 'tray', root } });
const by = (items: WorkItem[], kind: string, id?: string) => items.find((i) => i.kind === kind && (id === undefined || i.id === id));

describe('recentWork: the project\'s newest work, newest first, each with where it opens', () => {
  it('lists every kind, newest first, with its words, time, state, receipt (verified here) and target', () => {
    const r = recentWork(ctx(), 20);
    expect(r.project).toEqual({ name: 'tray', id: pid });
    expect(r.items.map((i) => `${i.kind}:${i.id}`)).toEqual([
      'turn:' + short(sealed.turn),          // 11:12
      'run:o2222bbbb',                        // 11:10 (running)
      'draft:draft-0a1b2c3d',                 // 11:08
      'observation:v1a2b3c4d',                // 11:06
      'recording:refs/demo-tray.rrd',         // 11:05
      'mesh:refs/demo-tray.stl',              // 11:04
      'reference:refs/preview.png',           // 11:03
      'run:o1111aaaa',                        // 11:02 (its result out/report.md is listed with it, not again)
      'receipt:' + short(sealed.check),       // 11:01
    ]);
    // the newest first, by when
    const whens = r.items.map((i) => Date.parse(i.when!));
    expect([...whens].sort((a, b) => b - a)).toEqual(whens);
    expect(r.items.every((i) => i.when !== null)).toBe(true);
  });

  it('a chat turn: its question\'s first words (from its operation record), answered, its route and its receipt verified', () => {
    const t = by(recentWork(ctx(), 20).items, 'turn')!;
    expect(t).toMatchObject({
      id: short(sealed.turn), title: 'how deep is the tray?', when: T(12), state: 'answered', operation: 'o3333cccc',
      receipt: { id: short(sealed.turn), verified: true }, fake: false,
      route: { provider: 'ollama', requested: 'qwen3:8b', answeredBy: 'qwen3:8b', where: 'this computer', surface: 'workbench' },
      open: { surface: 'companion', tab: 'chat', query: `tab=chat&receipt=${short(sealed.turn)}` },
    });
  });

  it('a run: its request in plain words, its state in the shared words, its own receipt (not the prediction), its result', () => {
    const items = recentWork(ctx(), 20).items;
    const done = by(items, 'run', 'o1111aaaa')!;
    expect(done).toMatchObject({ title: 'Workflow run: report in REPORT.md', when: T(2), state: 'completed', receipt: { id: short(sealed.workflow), verified: true }, results: ['out/report.md'], open: { tab: 'workflows', query: 'tab=workflows&run=o1111aaaa' } });
    const running = by(items, 'run', 'o2222bbbb')!;
    expect(running).toMatchObject({ title: 'Iterate: tray make the walls 2 mm thicker', when: T(10), state: 'running', receipt: null });
    // the result the run wrote is not listed again on its own (it opens in the run's detail)
    expect(by(items, 'result', 'out/report.md')).toBeUndefined();
  });

  it('files: a mesh, a recording and a reference image, each opening where it belongs (F5: the recording names itself)', () => {
    const items = recentWork(ctx(), 20).items;
    expect(by(items, 'mesh')).toMatchObject({ id: 'refs/demo-tray.stl', title: 'demo-tray.stl', state: 'saved', when: T(4), receipt: null, open: { tab: 'create', query: `tab=create&mesh=${hexOfPath('refs/demo-tray.stl')}` } });
    expect(by(items, 'recording')).toMatchObject({ id: 'refs/demo-tray.rrd', title: 'demo-tray.rrd', open: { tab: 'create', query: `tab=create&recording=${hexOfPath('refs/demo-tray.rrd')}` } });
    expect(by(items, 'reference')).toMatchObject({ id: 'refs/preview.png', title: 'preview.png', open: { tab: 'home', preview: 'image', query: `tab=home&file=${hexOfPath('refs/preview.png')}` } });
    // a workflow document at the project's top is not an artifact
    expect(items.some((i) => i.id === 'REPORT.md')).toBe(false);
  });

  it('one item per thing done: a /detect is its observation, an /add its file (with its intake receipt), never a run besides', () => {
    const items = recentWork(ctx(), 20).items;
    expect(by(items, 'run', 'o5555eeee')).toBeUndefined();
    expect(by(items, 'run', 'o6666ffff')).toBeUndefined();
    expect(by(items, 'observation')).toMatchObject({ operation: 'o5555eeee' });
    expect(by(items, 'reference', 'refs/preview.png')).toMatchObject({ operation: 'o6666ffff', receipt: { id: short(sealed.intake), verified: true } });
  });

  it('a run\'s words name a file, never a path', () => {
    expect(runTitle('/add /opt/elsewhere/examples/visual-tools/preview.png')).toBe('Add: preview.png');
    expect(runTitle('/detect refs/preview.png color 255,255,255')).toBe('Detect: preview.png color 255,255,255');
    expect(runTitle('/run docs/REPORT.md report')).toBe('Workflow run: report in REPORT.md');
    expect(runTitle('/iterate tray make the walls 2 mm thicker')).toBe('Iterate: tray make the walls 2 mm thicker');
  });

  it('an observation with its vox receipt verified; a Studio draft waiting for Accept or Discard, counted once', () => {
    const items = recentWork(ctx(), 20).items;
    expect(by(items, 'observation')).toMatchObject({ id: 'v1a2b3c4d', title: 'detect preview.png', when: T(6), state: 'completed', receipt: { id: short(sealed.vox), verified: true }, open: { tab: 'voxvision', query: 'tab=voxvision&vox=v1a2b3c4d' } });
    expect(items.filter((i) => i.kind === 'draft')).toHaveLength(1);
    expect(by(items, 'draft')).toMatchObject({ id: 'draft-0a1b2c3d', title: 'A draft Timmy proposed on the Studio board', when: T(8), state: 'draft', receipt: null, open: { surface: 'studio' } });
  });

  it('a receipt that belongs to no listed turn or run is listed as itself, and another project\'s never', () => {
    const items = recentWork(ctx(), 20).items;
    expect(by(items, 'receipt')).toMatchObject({ id: short(sealed.check), title: 'check · setup check', state: 'sealed', receipt: { id: short(sealed.check), verified: true }, open: { tab: 'logs' } });
    // the prediction and the workflow receipt are the run's; the vox receipt the observation's: not listed again
    expect(items.filter((i) => i.kind === 'receipt')).toHaveLength(1);
    expect(JSON.stringify(items)).not.toContain(short(sealed.foreign));
  });

  it('a chat turn being answered now (its hold, read only) is listed first, running, opening Chat at that turn', () => {
    const held = takeTurnHold(root, 'repl');
    if (!held.ok) throw new Error(held.lines.join('\n'));
    try {
      const first = recentWork(ctx(), 20).items[0];
      expect(first).toMatchObject({ kind: 'turn', id: held.hold.id, state: 'running', title: 'A chat turn being answered in the REPL', receipt: null, open: { tab: 'chat', select: { name: 'turn', value: held.hold.id }, query: `tab=chat&turn=${held.hold.id}` } });
    } finally { held.hold.release(); }
    expect(recentWork(ctx(), 20).items.some((i) => i.state === 'running' && i.kind === 'turn')).toBe(false);
  });

  it('a running run a NEEDS YOU box blocks is waiting on you (the caller says which: its own boxes, the decisions view)', () => {
    const r = recentWork({ ...ctx(), waiting: (op) => (op === 'o2222bbbb' ? 'write_project_file asks to write notes.md' : undefined) }, 20);
    expect(by(r.items, 'run', 'o2222bbbb')).toMatchObject({ state: 'waiting on you', waiting: 'write_project_file asks to write notes.md' });
    expect(by(r.items, 'run', 'o1111aaaa')).toMatchObject({ state: 'completed' });
  });

  it('limit: the newest `limit` items only', () => {
    expect(recentWork(ctx(), 3).items.map((i) => i.kind)).toEqual(['turn', 'run', 'draft']);
  });

  it('a receipt that does not verify is said so, never green', () => {
    // tamper with the turn's receipt on the chain (its body no longer matches its hash)
    const chain = readChain('runs').map((r) => (r.hash === sealed.turn.hash ? { ...r, model_resolved: 'something-else' } as Receipt : r));
    const t = by(recentWork({ ...ctx(), chain }, 20).items, 'turn')!;
    expect(t.receipt).toMatchObject({ id: short(sealed.turn), verified: false });
    expect(t.receipt!.why).toMatch(/body hash mismatch|does not verify/);
  });

  it('a FAKE run or turn is labelled FAKE', () => {
    op('o4444dddd', { request: '/run FAKE.md demo', state: 'succeeded', started: T(30), ended: T(31) });
    expect(by(recentWork(ctx(), 20).items, 'run', 'o4444dddd')).toMatchObject({ fake: true });
  });

  it('bounded: each reader stops at its cap, and the notes say what was left out', () => {
    for (let i = 0; i < 12; i += 1) put(`refs/extra-${String(i).padStart(2, '0')}.txt`, `${i}`, T(-30 + i));
    const r = recentWork(ctx(), 20, { caps: { ...RECENT_CAPS, fileEntries: 6 } });
    expect(r.notes).toContain('Not all files were looked at: the reader stops after 6 folder entries, so an older file may be left out.');
    // the defaults are small, fixed numbers (never "the whole project")
    expect(RECENT_CAPS.fileEntries).toBeLessThanOrEqual(1000);
    expect(RECENT_CAPS.operations).toBeLessThanOrEqual(2000);
    expect(RECENT_CAPS.fileDepth).toBeLessThanOrEqual(4);
  });

  it('an empty project: no items, and no error', () => {
    const empty = join(box, 'empty');
    mkdirSync(empty);
    expect(recentWork({ project: { name: 'empty', root: empty }, chain: [] }, 12)).toMatchObject({ items: [], notes: [] });
  });
});
