/**
 * Round R4 (H40, the R4 review's R4-4): one flow record (results/flows/<flow-id>.json) that passes the schema and id
 * check but holds parts in a form Timmy does not write no longer takes the board's Flows section, the live board's
 * state or /iterate's list down with it. Each card is drawn with what it holds and says what it left out; a card that
 * still cannot be drawn becomes an "unreadable record" card; /iterate lists every flow and says what it cannot read.
 *
 * TEST FIXTURES, labelled: the flow records are written by hand here (synthetic: no agent, no app, nothing was built or
 * measured); a record object whose property throws when read is a FAKE that no JSON file can be, used only to reach
 * the guards. The board, the live board (127.0.0.1, an ephemeral port) and /iterate are the real Workspace's.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { folderProject } from '../src/project/index.js';
import { flowsSection, type BoardFlow } from '../src/repl/board-flows.js';
import type { LiveState } from '../src/repl/board-live.js';
import { flowListRow } from '../src/repl/iterate.js';
import { Workspace } from '../src/repl/workspace.js';
import { diffText, DOCTRINE_15, paramDiff, type FlowRecord } from '../src/flows/iterate.js';
import { scadDiffText, scadFlowSummary, scadParamDiff } from '../src/flows/iterate-scad.js';
import { freecadFlowSummary } from '../src/flows/iterate-freecad.js';
import { blenderFlowSummary } from '../src/flows/iterate-blender.js';
import { aeFlowSummary } from '../src/flows/iterate-ae.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';

const dirs: string[] = [];
const spaces: Workspace[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const g = glyphSet(true);
const SEP = ` ${g.sep} `;

// ── the records (TEST FIXTURES: synthetic, written by hand) ────────────────────────────────────────────────────

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const base = (id: string, minute: number): Record<string, unknown> => ({
  flow: 1, schema: 'timmy.flow/1', id, kind: 'iterate', instruction: `instruction of ${id}`, project: 'demo',
  started_at: `2026-10-09T09:${String(minute).padStart(2, '0')}:00.000Z`, ended_at: `2026-10-09T09:${String(minute).padStart(2, '0')}:30.000Z`,
  receipts: {}, child_receipts: [], doctrine: DOCTRINE_15,
});
const trayParams = { path: 'recipes/tray.params.json', created: false, before: { sha256: A, values: { width: 140, wall: 3, supportOffset: 10, bore: 3 } } };

/** A tray flow as Timmy writes one: it succeeded and its readback matched (every value synthetic). */
const good = {
  ...base('f00000001', 1), recipe: 'enclosure.tray/1', outcome: 'succeeded', ended_in: 'readback', why: 'the readback of the delivered STEP matches the sealed prediction',
  parameters: { ...trayParams, after: { sha256: B, values: { width: 180, wall: 3, supportOffset: 10, bore: 3 } }, diff: paramDiff({ width: 140, wall: 3, supportOffset: 10, bore: 3 }, { width: 180, wall: 3, supportOffset: 10, bore: 3 }) },
  rebuild: { state: 'succeeded', outputs: [{ path: 'out/recipes/abcd1234/console-tray.step', sha256: 'c'.repeat(64), bytes: 10 }], predicted: { bounds_mm: [180, 80, 30], volume_mm3: 100000 } },
  readback: {
    state: 'completed', tolerance: { bounds_mm: 1e-6, volume_relative: 1e-8 }, verdict: 'matches', scope: 'synthetic',
    measured: { bounds_mm: [180, 80, 30], volume_mm3: 100000, valid: true, solids: 1, sha256: 'c'.repeat(64) },
    checks: [{ name: 'solids', predicted: 1, measured: 1, difference: 0, tolerance: 'exact', passed: true }],
  },
};
/** The review's own two: a tray diff holding null, and a Blender failing check without its differences. */
const trayNullDiff = { ...base('f00000002', 2), recipe: 'enclosure.tray/1', outcome: 'stopped', ended_in: 'checks', parameters: { ...trayParams, diff: [null, { name: 'width', before: 140, after: 150, changed: true }] } };
const trayOdd = {
  ...base('f00000003', 3), recipe: 'enclosure.tray/1', outcome: 'differs', ended_in: 'readback', parameters: { ...trayParams, diff: 'width' },
  agent: { run: 'a00000001', agent: 'qwen', route: 'local endpoint, no charge', others: [null, { how: 'changed' }, { path: 'notes.txt', how: 'added' }] },
  rebuild: { state: 'succeeded', outputs: [null, 7] },
  readback: { state: 'completed', tolerance: { bounds_mm: 1e-6, volume_relative: 1e-8 }, verdict: 'differs', scope: 'synthetic', measured: { bounds_mm: [1, 2, 3], volume_mm3: 6, valid: true, solids: 1, sha256: 'd'.repeat(64) }, checks: [null] },
};
const blenderOdd = {
  ...base('f00000004', 4), target: 'blender', outcome: 'differs', ended_in: 'readback',
  script: { path: 'scene.py', before: { sha256: A, bytes: 10, lines: 1 }, change: { added: 1, removed: 1, hunks: [null], hunks_total: 1 } },
  blender: { state: 'completed', outcome: 'ok', renders: [null, { path: 'renders/still.png', sha256: B }] },
  readback: {
    state: 'completed', verdict: 'differs', scope: 'synthetic',
    read: { objects: [null, { name: 'Cube', type: 'MESH', dimensions: [2, 2, 2], location: [0, 0, 0] }], objects_total: 2, cameras: [null], materials: 'none', scenes: [7], active_camera: null },
    checks: [{ name: 'camera', passed: false }, null],
  },
  dimensions: { after: { objects: 1, agreement: 'x' }, unchanged: 0, tolerance: 1e-6, units: { system: { not: 'a word' } }, changed: [], before: null },
};
const scadOdd = {
  ...base('f00000005', 5), target: 'scad', outcome: 'differs', ended_in: 'readback',
  model: { path: 'box.scad', sha256: A, bytes: 10 },
  parameters: { path: 'box.params.json', before: { sha256: A, bytes: 10, values: { width: 60 } }, diff: { width: 'not a list' } },
  agent: { run: 'a00000002', agent: 'qwen', route: 'local endpoint, no charge', others: [{ how: 'deleted' }] },
  readback: { verdict: 'differs', checks: { closed: false }, scope: 'synthetic' },
};
const freecadOdd = {
  ...base('f00000006', 6), target: 'freecad', outcome: 'failed', ended_in: 'readback',
  script: { path: 'plate.py', before: { sha256: A, bytes: 10, lines: 1 }, change: { added: 'one' } },
  freecad: { state: 'completed', outcome: 'ok', fcstd: [null], checks: [null, { label: 'a hole', passed: true }], step: { path: 'plate.step', sha256: B } },
  readback: { state: 'completed', verdict: 'differs', scope: 'synthetic', checks: [null, 'x'], measured: { valid: true } },
};
/** R4 (H46): an After Effects flow whose lists hold entries Timmy does not write (null, a number, a string for a list). */
const aeOdd = {
  ...base('f00000007', 7), target: 'ae', outcome: 'differs', ended_in: 'readback',
  script: { path: 'author.jsx', before: { sha256: A, bytes: 10, lines: 1 }, after: { sha256: B, bytes: 11, lines: 1 }, change: { added: 1, removed: 1, hunks: [null, { before_line: 3, after_line: 3, removed: ['var x = [240, 540];'], added: ['var x = [480, 540];'] }], hunks_total: 2 }, syntax: 'ok' },
  agent: { run: 'a00000003', agent: 'qwen', route: 'local endpoint, no charge', others: [null, { path: 'notes.txt', how: 'added' }], compared: { scope: 7 } },
  author: { state: 'completed', outcome: 'ok', aep: { path: 'out/ae/author-v1.aep', sha256: A, bytes: 3 }, comps: 'Main', failure_files: [null, 'out/ae/author-v1.aep'] },
  render: { state: 'completed', outcome: 'ok', comp: 'Main', file: { path: 'out/ae/author-v1.mp4', sha256: B, instead: false }, failure_files: 7 },
  readback: {
    state: 'completed', verdict: 'differs', label: 'synthetic', reported_by: 'synthetic',
    probe: { width: 1920, height: 'tall', fps_value: 30, duration: 2, frames: 60 },
    checks: [null, { name: 'Mover at 1 s', reported: [480, 540], measured: [500, 540], passed: false, difference: [20, 0] }, 'x'],
    frames: [null, 7, { path: 'out/ae/frames/f1.png', frame: 30, time: 1, sha256: A }],
    not_compared: [null, 'Title: a text layer'],
  },
  before_after: { reported_by: 'synthetic', before: null, before_note: 'no earlier run', after: { name: 'Main', layers: 'none' }, changes: [null] },
};
const RECORDS = [good, trayNullDiff, trayOdd, blenderOdd, scadOdd, freecadOdd, aeOdd] as const;
const flow = (r: Record<string, unknown>): BoardFlow => ({ file: `results/flows/${String(r.id)}.json`, record: r as unknown as FlowRecord, check: { status: 'unverified', reasons: ['no flow receipt names this file'] } });
const cards = (html: string): string[] => [...html.matchAll(/<article class="card flow[^"]*">([\s\S]*?)<\/article>/g)].map((m) => m[0]);
const cardOf = (html: string, id: string): string => cards(html).find((c) => c.includes(`<strong>${id}</strong>`)) ?? '';

describe('a flow record whose inner shape Timmy did not write (no processes)', () => {
  it('each kind is drawn with what it holds; what is not in the form Timmy writes is left out and said', () => {
    const html = flowsSection({ list: RECORDS.map(flow), more: 0 }, { live: false, base: '../../' }).html;
    expect(cards(html)).toHaveLength(7);
    expect(html).not.toContain('unreadable record');
    // Timmy's own record reads as before.
    const ok = cardOf(html, 'f00000001');
    expect(ok).toContain('<span class="was">140</span> → <strong class="changed">180</strong>');
    expect(ok).toContain('measured from the CAD file, as the record says (not verified)');
    expect(ok).toContain(DOCTRINE_15);
    expect(ok).not.toContain('not shown');
    // The tray: a diff holding null keeps its readable row and says what it left out; a diff that is no list is said.
    const nullDiff = cardOf(html, 'f00000002');
    expect(nullDiff).toContain('<dt>width</dt><dd><span class="was">140</span> → <strong class="changed">150</strong>');
    expect(nullDiff).toContain('1 entry of the parameter diff not in the form Timmy writes, so not shown');
    const tray = cardOf(html, 'f00000003');
    expect(tray).toContain('the parameter diff: not a list, so not shown');
    expect(tray).toContain('2 entries of the files it also changed not in the form Timmy writes, so not shown');
    expect(tray).toContain('notes.txt');
    expect(tray).toContain('2 entries of the rebuild&#39;s outputs not in the form Timmy writes, so not shown');
    expect(tray).toContain('1 entry of the readback&#39;s checks not in the form Timmy writes, so not shown');
    // Blender: the failing check without its differences still says it failed; each odd list is said.
    const blender = cardOf(html, 'f00000004');
    expect(blender).toContain('<dt>camera</dt><dd class="bad">differs; the record holds no differences in the form Timmy writes');
    for (const what of ['the places the script changed', 'the second pass&#39;s checks', 'the cameras read', 'the scenes read', 'the objects read', 'the renders']) {
      expect(blender, what).toContain(`1 entry of ${what} not in the form Timmy writes, so not shown`);
    }
    expect(blender).toContain('the materials read: not a list, so not shown');
    expect(blender).toContain('<td>Cube</td><td>MESH</td><td>2 x 2 x 2</td>');
    expect(blender).toContain('href="../../renders/still.png"');
    expect(blender).toContain('the record&#39;s dimensions are not in the form Timmy writes, so they are not shown');
    expect(blender).not.toContain('[object Object]');
    // OpenSCAD and FreeCAD.
    const scad = cardOf(html, 'f00000005');
    expect(scad).toContain('the parameter diff: not a list, so not shown');
    expect(scad).toContain('1 entry of the files it also changed not in the form Timmy writes, so not shown');
    expect(scad).toContain('the readback&#39;s checks: not a list, so not shown');
    const freecad = cardOf(html, 'f00000006');
    expect(freecad).toContain('<dt>change</dt><dd class="nomodel">not in the form Timmy writes, so not shown</dd>');
    expect(freecad).toContain('1 entry of FreeCAD&#39;s documents not in the form Timmy writes, so not shown');
    expect(freecad).toContain('the script&#39;s own: 1 of 1 passed');
    expect(freecad).toContain('1 entry of the script&#39;s own checks not in the form Timmy writes, so not shown');
    expect(freecad).toContain('2 entries of the readback&#39;s checks not in the form Timmy writes, so not shown');
    // R4 (H46): After Effects: drawn with the entries it can read (the failing check, the file it also changed, the kept
    // frame, what was not compared); the others are left out. Unlike the other kinds, its card does not say what it left out.
    const ae = cardOf(html, 'f00000007');
    expect(ae).toContain('<article class="card flow ae">');
    expect(ae).toContain('<td>Mover at 1 s</td>');
    expect(ae).toContain('href="../../notes.txt"');
    expect(ae).toContain('href="../../out/ae/frames/f1.png"');
    expect(ae).toContain('not compared: Title: a text layer');
    expect(ae).not.toContain('[object Object]');
    expect(ae).not.toContain('null');
    // The live board draws the same cards, as text.
    const live = flowsSection({ list: RECORDS.map(flow), more: 0 }, { live: true, base: '../../' }).html;
    expect(cards(live)).toHaveLength(7);
    expect(live).not.toMatch(/<a [^>]*href=|<img /);
  });

  it('a card that still cannot be drawn becomes an unreadable-record card naming its file and why; the others are drawn', () => {
    // FAKE: a record whose instruction throws when read (no JSON file can be this): it reaches the section's guard.
    const fake = { ...good, id: 'f0000000f' } as Record<string, unknown>;
    Object.defineProperty(fake, 'instruction', { enumerable: true, get() { throw new Error('FAKE: a <b>part</b> that cannot be read'); } });
    const html = flowsSection({ list: [flow(good), flow(fake), flow(scadOdd)], more: 0 }, { live: false, base: '../../' }).html;
    expect(cards(html)).toHaveLength(3);
    const bad = cardOf(html, 'f0000000f');
    expect(bad).toContain('<article class="card flow unreadable">');
    expect(bad).toContain('unreadable record: results/flows/f0000000f.json (its card could not be drawn: FAKE: a &lt;b&gt;part&lt;/b&gt; that cannot be read)');
    expect(bad).toContain('<div class="status status-unverified"><strong>unverified</strong>');
    expect(bad).toContain('href="../../results/flows/f0000000f.json"');
    expect(bad).toContain('data-cmd="/open results/flows/f0000000f.json"');
    expect(bad).not.toContain('<b>');
    expect(cardOf(html, 'f00000001')).toContain('instruction of f00000001');
    expect(cardOf(html, 'f00000005')).toContain('iterate scad · box.scad');
  });

  it("diffText, scadDiffText and the list's summaries say what they cannot read; Timmy's own records read as before", () => {
    const diff = paramDiff({ width: 140, wall: 3 }, { width: 180, wall: 3 });
    expect(diffText(diff)).toBe('width 140 → 180');
    expect(diffText(paramDiff({ width: 140 }, { width: 140 }))).toBe('no value changed');
    expect(diffText([null, ...diff], '->')).toBe('width 140 -> 180; 1 entry of the parameter diff not in the form Timmy writes');
    expect(diffText([null, 'x', { before: 1 }])).toBe('3 entries of the parameter diff not in the form Timmy writes');
    expect(diffText({ width: 1 })).toBe('the parameter diff is not a list Timmy can read');
    expect(diffText([{ name: 'width', before: 'wide', after: null, changed: true }])).toBe('width ? → none');
    expect(scadDiffText(scadParamDiff({ part: 'both' }, { part: 'lid' }))).toBe('part "both" → "lid"');
    expect(scadDiffText([{ name: 'w', before: { x: 1 }, after: 1, changed: true }, null])).toBe('w ? → 1; 1 entry of the parameter diff not in the form Timmy writes');
    expect(scadDiffText('w')).toBe('the parameter diff is not a list Timmy can read');
    expect(scadFlowSummary(scadOdd)).toBe('scad box.scad the parameter diff is not a list Timmy can read');
    expect(freecadFlowSummary(freecadOdd)).toBe('freecad plate.py (its change is not in the form Timmy writes)');
    expect(blenderFlowSummary(blenderOdd)).toBe('blender scene.py +1 −1 lines in 1 place');
    expect(blenderFlowSummary({ ...blenderOdd, script: { path: 'scene.py', change: [] } })).toBe('blender scene.py (its change is not in the form Timmy writes)');
    expect(blenderFlowSummary({ ...blenderOdd, script: { path: 'scene.py' } })).toBe('blender scene.py');
    expect(aeFlowSummary(aeOdd)).toBe('ae author.jsx +1 −1 lines in 2 places');
    expect(aeFlowSummary({ ...aeOdd, script: { path: 'author.jsx', change: [] } })).toBe('ae author.jsx');
  });

  it("/iterate's row for a record that cannot be listed names its file and why (the row's guard)", () => {
    const row = (r: Record<string, unknown>): string => flowListRow(`results/flows/${String(r.id)}.json`, r as unknown as FlowRecord, { glyphs: g, sep: SEP }).map((s) => s.text).join('');
    expect(row(good)).toBe(`    ${g.ok} f00000001  succeeded width 140 → 180${SEP}readback matches${SEP}results/flows/f00000001.json`);
    expect(row(trayNullDiff)).toBe(`    ${g.fail} f00000002  stopped   width 140 → 150; 1 entry of the parameter diff not in the form Timmy writes${SEP}results/flows/f00000002.json`);
    // FAKE: a record whose outcome throws when read (no JSON file can be this): it reaches the row's guard.
    const fake = { ...good, id: 'f0000000e' } as Record<string, unknown>;
    Object.defineProperty(fake, 'outcome', { enumerable: true, get() { throw new Error('FAKE: no outcome'); } });
    expect(row(fake)).toBe(`    ${g.fail} unreadable record: results/flows/f0000000e.json (its row could not be made: FAKE: no outcome)`);
  });
});

// ── through the Workspace ─────────────────────────────────────────────────────────────────────────────────────

function project(): string {
  const root = temp('flow-robust-');
  mkdirSync(join(root, 'results', 'flows'), { recursive: true });
  for (const r of RECORDS) writeFileSync(join(root, 'results', 'flows', `${String(r.id)}.json`), `${JSON.stringify(r, null, 2)}\n`);
  return root;
}

function make(root: string) {
  const sealed: ReceiptInput[] = [];
  const ws = new Workspace({
    glyphs: g, env: {}, onPath: () => null, notify: () => {}, openWeb: (url) => `Open ${url} in your browser.`, link: (t) => t,
    seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
    jobsDir: join(temp('flow-robust-jobs-'), 'jobs'), chdir: () => {}, recoverAtStart: false,
    receipts: () => sealed.map((r, i) => ({ ...r, hash: `sha256:${String(i).padStart(8, '0')}rest` })) as unknown as Receipt[],
  }, folderProject(root));
  spaces.push(ws);
  return ws;
}

/** One GET to the live board on 127.0.0.1, with its own Host and the token as a header. */
function get(port: number, path: string, token: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'GET', path, headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}` }, setHost: false, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('through the Workspace: the board snapshot, the live board and /iterate keep every other flow', () => {
  it('the snapshot board is written with every card', () => {
    const root = project();
    const ws = make(root);
    const out = text(ws.board(''));
    expect(out).toContain('a read-only snapshot');
    expect(out).toContain('Flows 7');
    const html = readFileSync(join(root, '.timmy/board/index.html'), 'utf8');
    expect(cards(html)).toHaveLength(7);
    for (const r of RECORDS) expect(cardOf(html, String(r.id)), String(r.id)).not.toBe('');
    expect(cardOf(html, 'f00000002')).toContain('1 entry of the parameter diff not in the form Timmy writes, so not shown');
    expect(cardOf(html, 'f00000004')).toContain('differs; the record holds no differences in the form Timmy writes');
  });

  it("the live board's /state answers 200 and shows every card", async () => {
    const root = project();
    const ws = make(root);
    expect(text(await ws.boardLive('live'))).toContain('Live board');
    const lb = ws.liveBoard!;
    const token = lb.url.split('#t=')[1];
    const r = await get(lb.port, '/state', token);
    expect(r.status).toBe(200);
    const state = JSON.parse(r.body) as LiveState;
    expect(state.toc).toContain('Flows <b>7</b>');
    expect(cards(state.html)).toHaveLength(7);
    for (const rec of RECORDS) expect(cardOf(state.html, String(rec.id)), String(rec.id)).not.toBe('');
    expect(cardOf(state.html, 'f00000003')).toContain('the parameter diff: not a list, so not shown');
    expect(state.html).not.toContain(root);
  });

  it('/iterate lists every flow, and says what it cannot read in the ones that hold it', async () => {
    const root = project();
    const ws = make(root);
    const out = text(await ws.iterate(''));
    expect(out).toContain('Flows      newest first');
    for (const r of RECORDS) expect(out, String(r.id)).toContain(`${String(r.id)}  `);
    expect(out).toContain(`f00000001  succeeded width 140 → 180${SEP}readback matches${SEP}results/flows/f00000001.json`);
    expect(out).toContain(`f00000002  stopped   width 140 → 150; 1 entry of the parameter diff not in the form Timmy writes${SEP}results/flows/f00000002.json`);
    expect(out).toContain(`f00000003  differs   the parameter diff is not a list Timmy can read${SEP}readback differs${SEP}results/flows/f00000003.json`);
    expect(out).toContain(`f00000005  differs   scad box.scad the parameter diff is not a list Timmy can read${SEP}readback differs${SEP}results/flows/f00000005.json`);
    expect(out).toContain(`f00000006  failed    freecad plate.py (its change is not in the form Timmy writes)${SEP}readback differs${SEP}results/flows/f00000006.json`);
    expect(out).toContain(`f00000007  differs   ae author.jsx +1 −1 lines in 2 places${SEP}readback differs${SEP}results/flows/f00000007.json`);
    // Newest first.
    expect(out.indexOf('f00000007  ')).toBeLessThan(out.indexOf('f00000006  '));
    expect(out.indexOf('f00000006  ')).toBeLessThan(out.indexOf('f00000001  '));
  });
});
