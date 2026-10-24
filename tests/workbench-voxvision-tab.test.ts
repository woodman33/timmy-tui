/**
 * R5 (H134): tab 5, VoxVision (src/workbench/voxvision-tab.ts), over REAL VoxVision records: the REPL's Workspace runs
 * /inspect on an STL (Timmy's own STL reader, in process: real) and on a PNG with no Look worker on this machine (its record
 * says "needs setup" with its step), and each record is sealed by the real appendReceipt in the project's own store. The
 * capability rows are /tools' own builder for VoxVision (src/vox/tools.ts voxCapabilityRows) with nothing on the PATH, and
 * one FAKE row in /tools' shape (labelled). Then a receipt, a record and an input are changed, each on purpose.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityRow } from '../src/capabilities/index.js';
import { appendReceipt, readChain, receiptsPath, type ReceiptInput } from '../src/utils/receipts.js';
import { resetLookChecks } from '../src/vision/look.js';
import { voxCapabilityRows } from '../src/vox/tools.js';
import { glyphsFor, innerWidth } from '../src/workbench/frame.js';
import { bodyKind, layoutFor } from '../src/workbench/layout.js';
import type { Lazy } from '../src/workbench/model.js';
import { COLUMNS_FROM } from '../src/workbench/tab-columns.js';
import { lineCells, plain, type Line, type Role } from '../src/workbench/text.js';
import { INSPECT_COMMAND, readVox, VOX_LIST, voxCompanionHint, voxDetail, voxView, type VoxData, type VoxItem } from '../src/workbench/voxvision-tab.js';
import { cubeStl, png, put, settled, tempKit, workspace } from './helpers/vox-fakes.js';
import { act as voxAct, fakeVideoRecord, SMALL } from './helpers/vox-panel-kit.js';

const kit = tempKit();
afterEach(async () => { resetLookChecks(); vi.restoreAllMocks(); await kit.cleanup(); });

const g = glyphsFor(true);
const SIZES = [[160, 45], [120, 40], [100, 30]] as const;

/** The body's inner size at a terminal size, as the Workbench lays this tab out (src/workbench/layout.ts OWN_COLUMNS: the
 *  whole width at every size, Context the [i] drawer). */
function bodyAt(columns: number, rows: number): { width: number; height: number } {
  const l = layoutFor({ columns, rows, body: bodyKind(false, 'voxvision') });
  return { width: innerWidth(l.center!.w), height: l.center!.h - 2 };
}
const ctxAt = (columns: number, rows: number, cursor = 0) => ({ ui: { cursor: { [VOX_LIST]: cursor } }, g, ...bodyAt(columns, rows), now: Date.now(), columns });
const text = (lines: readonly Line[]): string => lines.map(plain).join('\n');
/** The words of the body, each column's rows joined (a phrase wrapped in a narrow column reads whole): the rows split at the
 *  columns' rules, each column's rows trimmed and joined by a space; a stacked body is one column. */
function words(lines: readonly Line[]): string {
  const cols: string[][] = [];
  for (const l of lines) plain(l).split(' │ ').forEach((part, i) => { (cols[i] ??= []).push(part.trim()); });
  return cols.map((c) => c.filter(Boolean).join(' ').replace(/\s+/g, ' ')).join('\n');
}
const rolesOf = (lines: readonly Line[], re: RegExp): Role[] => lines.flat().filter((s) => re.test(s.text)).map((s) => s.role ?? 'text');
const greens = (lines: readonly Line[]): string[] => lines.flat().filter((s) => s.role === 'live').map((s) => s.text);
const env = (): NodeJS.ProcessEnv => { const e = { ...process.env }; delete e.TIMMY_STORE; return e; };

/** The VoxVision rows /tools makes here (nothing on the PATH), and one FAKE row of the family in /tools' shape. */
function capsOf(root: string): Lazy<CapabilityRow[]> {
  const rows: CapabilityRow[] = [
    ...(voxCapabilityRows({ env: {}, onPath: () => null, root }) as CapabilityRow[]),
    { id: 'look', kind: 'tool', name: 'Image observations (/observe)', rung: 'needs setup', detail: 'FAKE: a row in /tools\' shape for this test', setup: 'FAKE: install python3' },
    { id: 'openrouter', kind: 'model', name: 'FAKE model row (not of the family)', rung: 'installed', detail: 'FAKE' },
  ];
  return { state: 'ready', value: rows, at: Date.now() };
}

/** A project with two real records: an STL inspected (ok, measured) and a PNG inspected with no Look here (needs setup). */
async function fixture(): Promise<{ root: string; stl: string; png: string }> {
  const root = kit.temp('wb-vox-');
  put(root, 'parts/cube.stl', cubeStl(10));
  put(root, 'refs/photo.png', png(8, 6, (x, y) => [x * 30, y * 40, 90]));
  // the REPL's seal, made real: each record's vox receipt on the project's own chain
  const seal = (input: ReceiptInput): string => appendReceipt('runs', input, root).hash;
  const { ws } = workspace(root, kit, { extra: { seal, receipts: () => readChain('runs', root) } });
  await ws.inspect('parts/cube.stl');
  await settled(ws);
  await new Promise((r) => setTimeout(r, 15));
  await ws.inspect('refs/photo.png');
  await settled(ws);
  const ids = readdirSync(join(root, 'results', 'vox')).filter((n) => /^v[0-9a-f]{8}\.json$/.test(n)).map((n) => n.slice(0, -5));
  const byInput = (p: string): string => ids.find((id) => readFileSync(join(root, 'results', 'vox', `${id}.json`), 'utf8').includes(`"path": "${p}"`))!;
  return { root, stl: byInput('parts/cube.stl'), png: byInput('refs/photo.png') };
}
const read = (root: string): VoxData => readVox({ root, chain: readChain('runs', root), env: env() });

describe('tab 5, VoxVision: the reading', () => {
  it('reads each record with the board\'s own check: the vox receipt that sealed exactly its bytes, and its inputs unchanged', async () => {
    const f = await fixture();
    const d = read(f.root);
    expect(d.rows.map((r) => r.card.id)).toEqual([f.png, f.stl]);
    const [pngRow, stlRow] = d.rows;
    expect(stlRow.card).toMatchObject({ id: f.stl, action: 'inspect', status: 'ok', command: '/inspect parts/cube.stl', check: { status: 'verified' } });
    expect(stlRow.card.metrics.length).toBeGreaterThan(0);
    expect(pngRow.card).toMatchObject({ id: f.png, status: 'needs-setup', check: { status: 'verified' } });
    expect(pngRow.card.failures).toEqual([expect.objectContaining({ tool: 'look', code: 'needs-setup', setup: expect.any(String) })]);
    // each with its receipt on the chain: the newest vox receipt that names the record
    for (const r of d.rows) expect(r.seal).toMatchObject({ seq: expect.any(Number), hash: expect.stringMatching(/^sha256_/) });
    expect(d.unreadable).toEqual([]);
  });
});

describe('tab 5: the pipeline, the tools and the records', () => {
  it('the pipeline: .intent → each tool this computer can run → .receipt, then the tools that need setup, marked so', async () => {
    const f = await fixture();
    const d = read(f.root);
    for (const [c, r] of SIZES) {
      const v = voxView(ctxAt(c, r), capsOf(f.root), d);
      const all = text(v.lines);
      expect(all).toMatch(/^PIPELINE \.intent → Timmy's STL reader → Spatial module → \.receipt/m);
      expect(all).toMatch(/needs setup: Look · STEP readback/);
      expect(all).toMatch(/Rerun viewer/);
      // .intent amber (an intent), .receipt plain: no green for a stage (nothing was checked to draw it)
      // (R7 H150: .intent amber, role accent: B10)
      expect(rolesOf(v.lines, /^\.intent$/)).toEqual(['accent']);
      expect(rolesOf(v.lines, /^\.receipt$/)).toEqual(['strong']);
      // the layers VoxVision has no use of yet are no stage (they are in the tools list, needing setup)
      expect(v.lines.slice(0, 3).map(plain).join(' ')).not.toMatch(/Viser|FiftyOne/);
    }
  });

  it('the tools with their rungs (one that needs setup with its step), and the records newest first with action, time, tools and status', async () => {
    const f = await fixture();
    const d = read(f.root);
    for (const [c, r] of SIZES) {
      const v = voxView(ctxAt(c, r), capsOf(f.root), d);
      const all = text(v.lines);
      const said = words(v.lines);
      expect(all).toMatch(/TOOLS[^\n]*2 of 12 here/);
      expect(said).toMatch(/Timmy's STL reader (Spatial module|installed)/);
      // a tool that needs setup has its step under it (cut at a narrow column's edge, its start whole)
      expect(all).toMatch(/do: python3/);
      // the records: each id whole, its action, its status word, sealed, the tools it used or needed
      expect(all).toMatch(new RegExp(`${f.png} inspect`));
      expect(all).toMatch(new RegExp(`${f.stl} inspect`));
      expect(all).toMatch(/needs setup/);
      expect(said).toMatch(/sealed/);
      expect(said).toMatch(/used stl/);
      expect(said).toMatch(/needed look/);
      // no rung is green: a rung is not a check made now
      for (const s of greens(v.lines)) expect(s).toBe('✓ verified');
    }
  });

  it('no record yet: says so and names the one command that makes one, at every size', async () => {
    const root = kit.temp('wb-vox-empty-');
    const d = read(root);
    for (const [c, r] of SIZES) {
      const v = voxView(ctxAt(c, r), capsOf(root), d);
      expect(words(v.lines)).toMatch(/No VoxVision record yet\./);
      expect(rolesOf(v.lines, /^\/inspect <file>$/)).toEqual(['strong']);
      expect(text(v.lines)).toContain(INSPECT_COMMAND);
      expect(rolesOf(v.lines, /^\[c\]$/)).toEqual(['action']);
    }
  });
});

describe('tab 5: the selected record', () => {
  it('its values with their words, what failed with its step, its receipt "✓ verified" only as verifyReceiptIn confirms it now, the verdict not recorded, and where 3D is seen', async () => {
    const f = await fixture();
    const d = read(f.root);
    for (const [c, r] of SIZES) {
      // the STL record (the second, newest first)
      const v = voxView(ctxAt(c, r, 1), capsOf(f.root), d);
      const all = text(v.lines);
      const said = words(v.lines);
      expect(all).toMatch(new RegExp(`RECORD ${f.stl}`));
      expect(all).toMatch(/RECEIPT #\d+/);
      expect(all).toMatch(/✓ verified/);
      expect(greens(v.lines)).toEqual(['✓ verified']);
      expect(said).toMatch(/Verdict not recorded/);
      // where its images and 3D are seen, kept in view under the detail at every size
      expect(said).toMatch(new RegExp(`/vox view ${f.stl}`));
      expect(rolesOf(v.lines, /^\[c\]$/)).toEqual(['action']);
      // its values with their words (where the column has room for them: the stacked body, and 160)
      if (c !== 120) { expect(all).toMatch(/VALUES \d/); expect(all).toMatch(/measured/); }
      // the PNG record: what failed, with its step
      const w = words(voxView(ctxAt(c, r, 0), capsOf(f.root), d).lines);
      expect(w).toMatch(/look needs-setup/);
      expect(w).toMatch(/do: python3/);
    }
    const stacked = text(voxView(ctxAt(100, 30, 1), capsOf(f.root), d).lines);
    expect(stacked).toMatch(/✓ verified: link, body hash and signature \(verifyReceiptIn, this reading\)/);
    expect(stacked).toMatch(/its bytes and inputs are the ones it sealed/);
    expect(stacked).toMatch(/Verdict +not recorded: a VoxVision record \(timmy\.vox\/1\) keeps no operator verdict/);
    // R6 (H143): the companion draws its image, what was measured over it, its frames and its mesh views (c); no Timmy
    // surface draws depth or voxels; Rerun's own viewer shows its files where it is installed
    expect(stacked.replace(/\s+/g, ' ')).toMatch(/A terminal draws no image\. \[c\] Companion(?: · Show)?: this record's image with what was measured over it, its frames and its mesh views \(tab 5\)\./);
    expect(stacked.replace(/\s+/g, ' ')).toMatch(new RegExp(`No Timmy surface draws depth or voxels \\(no adapter here\\)\\. Rerun's own viewer shows its files, where it is installed \\(/vox view ${f.stl}\\)\\.`));
    expect(stacked).not.toMatch(/do not reach the companion/);
  });

  it('a receipt changed in the store: "✕ does not verify" amber with why, and nothing green', async () => {
    const f = await fixture();
    const store = receiptsPath('runs', f.root);
    const lines = readFileSync(store, 'utf8').split('\n');
    const at = lines.findIndex((l) => l.includes('"kind":"vox"') && l.includes('cube.stl'));
    lines[at] = lines[at].replace('parts/cube.stl', 'parts/cube.STL');
    writeFileSync(store, lines.join('\n'));
    const d = read(f.root);
    for (const [c, r] of SIZES) {
      const v = voxView(ctxAt(c, r, 1), capsOf(f.root), d);
      expect(text(v.lines)).toMatch(/✕ does not verify/);
      expect(rolesOf(v.lines, /^✕ does not verify$/)).toEqual(['failure']);
      expect(greens(v.lines)).toEqual([]);
    }
  });

  it('an input changed since (stale), and a record changed after its receipt: each said, amber, never as sealed', async () => {
    const f = await fixture();
    put(f.root, 'parts/cube.stl', cubeStl(12));
    const stale = read(f.root);
    expect(stale.rows.find((r) => r.card.id === f.stl)!.card.check.status).toBe('stale');
    const v = voxView(ctxAt(160, 45, 1), capsOf(f.root), stale);
    // the list says it in its mark and word, the detail says why
    expect(rolesOf(v.lines, /^⚠ stale$/)).toEqual(['attention']);
    expect(words(v.lines)).toMatch(/⚠ stale: parts\/cube\.stl changed since/);
    const rec = join(f.root, 'results', 'vox', `${f.png}.json`);
    const j = JSON.parse(readFileSync(rec, 'utf8')) as { notes?: string[] };
    j.notes = [...(j.notes ?? []), 'FAKE: a note added after the receipt'];
    writeFileSync(rec, `${JSON.stringify(j, null, 2)}\n`);
    // and a file in results/vox that is no record Timmy can read (FAKE, on purpose): listed apart, with why
    writeFileSync(join(f.root, 'results', 'vox', 'v0000beef.json'), '{ "schema": "timmy.vox/1", ');
    const changed = read(f.root);
    expect(changed.unreadable).toEqual([{ file: 'results/vox/v0000beef.json', why: 'it is not a VoxVision record (timmy.vox/1) Timmy can read' }]);
    expect(words(voxView(ctxAt(100, 30), capsOf(f.root), changed).lines)).toMatch(/results\/vox\/v0000beef\.json: it is not a VoxVision record/);
    expect(changed.rows.find((r) => r.card.id === f.png)!.card.check.status).toBe('unverified');
    const w = voxView(ctxAt(160, 45, 0), capsOf(f.root), changed);
    expect(rolesOf(w.lines, /^✕ changed after sealing$/)).toEqual(['failure']);
    expect(words(w.lines)).toMatch(/✕ not this record: the record is not the file its receipt [0-9a-f]+ sealed/);
  });
});

describe('tab 5: the layout, the items and the Inspector', () => {
  it('three columns under the pipeline from 120 columns, stacked below; every line within the body; the items records then tools', async () => {
    const f = await fixture();
    const d = read(f.root);
    const caps = capsOf(f.root);
    const tools = (caps as Extract<typeof caps, { state: 'ready' }>).value.filter((x) => x.kind === 'vox' || x.id === 'look' || x.id === 'adapters');
    const n = d.rows.length + tools.length;
    for (const [c, r] of SIZES) {
      const { width, height } = bodyAt(c, r);
      for (let k = 0; k < n; k++) {
        const v = voxView(ctxAt(c, r, k), caps, d);
        for (const l of v.lines) expect(lineCells(l)).toBeLessThanOrEqual(width);
        expect(v.items.map((x) => x.item.key)).toEqual([...d.rows.map((x) => `vox:${x.card.id}`), ...tools.map((x) => `cap:${x.id}`)]);
        // the selection bar: no grey word on it (below the contrast floor on charcoal)
        expect(v.lines.flat().filter((s) => s.selected && s.text.trim()).every((s) => s.role !== 'secondary' && s.role !== 'border')).toBe(true);
        const head = v.lines.findIndex((l) => /RECORDS/.test(plain(l)));
        if (c >= COLUMNS_FROM) {
          expect(v.lines.length).toBeLessThanOrEqual(height);
          expect(plain(v.lines[head])).toMatch(/TOOLS.*│ RECORDS.*│ (RECORD|TOOL)/);
          // a record is clicked by its row; a tool is reached with the keys (its detail is in the right column)
          if (k < d.rows.length) expect(plain(v.lines[v.items[k].line])).toContain('▸ ');
          else expect(text(v.lines)).toMatch(/TOOL · /);
        } else {
          expect(plain(v.lines[head])).not.toMatch(/│/);
          expect(v.items[k].line).toBeGreaterThanOrEqual(0);
          expect(plain(v.lines[v.items[k].line])).toContain('▸ ');
        }
      }
    }
  });

  it('a record\'s Inspector detail: every value, its tools, its receipt verified now, and the record\'s path', async () => {
    const f = await fixture();
    const d = read(f.root);
    const v = voxView(ctxAt(160, 45, 1), capsOf(f.root), d);
    const item = v.items[1].item as Extract<VoxItem, { kind: 'vox-record' }>;
    const t = text(voxDetail(item, d, 44, g)).replace(/\s+/g, ' ');
    expect(t).toMatch(new RegExp(`RECORD ${f.stl}`));
    expect(t).toMatch(/TOOLS · 1 stl: [^·]+· in Timmy's process/);
    expect(t).toMatch(/✓ verified/);
    expect(t).toMatch(new RegExp(`Record results/vox/${f.stl}\\.json`));
    expect(t).toMatch(/DOCTRINE §15/);
  });

  it('reads only and asks no network: no file changes, no fetch, while reading and drawing', async () => {
    const f = await fixture();
    const files = (dir: string): string => readdirSync(dir, { recursive: true }).map((n) => { const p = join(dir, String(n)); const s = statSync(p); return `${p} ${s.size} ${s.mtimeMs}`; }).sort().join('\n');
    const before = files(f.root);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const d = read(f.root);
    for (const [c, r] of SIZES) for (let k = 0; k < 4; k++) voxView(ctxAt(c, r, k), capsOf(f.root), d);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(files(f.root)).toBe(before);
  });
});

describe('tab 5: the record the companion draws, in words (R6 H143)', () => {
  // FAKE, labelled: Look (tests/helpers/vox-fakes.ts, not OpenCV) and the video record of tests/helpers/vox-panel-kit.ts;
  // real: the REPL's record writer for /detect, the receipts on the per-test chain, src/vox/preview.ts
  it('its entities with provenance and evidence, a video\'s frames with what was measured at each, its files and where each is drawn', async () => {
    const root = kit.temp('wb-vox-r6-');
    put(root, 'refs/photo.png', SMALL);
    const detect = await voxAct(kit, root, (ws) => ws.detect('refs/photo.png color 200,10,10'), { FAKE_QR: 'hello vox' });
    const video = fakeVideoRecord(root).id;
    const d = readVox({ root, chain: readChain('runs'), env: env() });
    expect(d.rows.map((r) => r.card.id)).toEqual([detect, video]);
    const items = voxView(ctxAt(160, 45, 0), capsOf(root), d).items.map((x) => x.item);
    const of = (id: string) => items.find((x) => x.kind === 'vox-record' && x.row.card.id === id) as Extract<VoxItem, { kind: 'vox-record' }>;

    const t = text(voxDetail(of(detect), d, 96, g));
    expect(t).toMatch(/ENTITIES 2/);
    expect(t).toContain('/observations/qr/1 QR 1 "hello vox" · measured · constructed');
    expect(t).toContain('4 corners in px (QR codes decoded) · provenance measured · evidence constructed');
    expect(t).toContain('/observations/color_region colour region rgb(200, 10, 10) · measured · constructed');
    expect(t.replace(/\s+/g, ' ')).toContain('2 px (0.25 of the image) · box 1, 0, 3, 1 px · centroid 1.5, 0.5 px · provenance measured · evidence constructed');
    expect(t).toMatch(/FILES 2/);
    expect(t).toContain('refs/photo.png · the observed image · drawn in the companion');
    expect(t).toContain(`results/vox/${detect}/annotated.png · annotated copy · drawn in the companion`);
    expect(t).not.toMatch(/FRAMES/);

    const v = text(voxDetail(of(video), d, 110, g));
    expect(v).toMatch(/FRAMES 3/);
    expect(v.replace(/\s+/g, ' ')).toContain("0.5 s · frame 5; 1 s · frame 10; 1.5 s · frame 15: the companion draws each with what was measured there, on a timeline (each frame's box and centroid are under ENTITIES)");
    expect(v).toContain('/observations/frames/15 t = 1.5 s (frame 15) · measured · inferred');
    expect(v).toContain('box 112, 40, 144, 72 · centroid 128, 56 (video px) · provenance measured · evidence inferred · estimated');
    expect(v).toContain(`results/vox/${video}/frames/frame-000010.png · frame 10 · drawn in the companion`);
    // c opens the companion on this tab with this record (the address hint panel-vox.js reads)
    expect(voxCompanionHint(of(video))).toBe(`tab=voxvision&vox=${video}`);
    expect(voxCompanionHint(undefined)).toBe('tab=voxvision');
  });
});
