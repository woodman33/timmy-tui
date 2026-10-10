/**
 * Round R4 (helper H27): OpenSCAD as a judged native route (/scad; run_native app openscad) with parameters and an
 * independent readback of the STL in Timmy's own TypeScript.
 *
 * The readback and parameter tests run on meshes and files made here. Every run below goes through Timmy's REAL job
 * manager and its REAL runner (workers/scad/timmy_scad_run.mjs, a Node child process), with a TEST DOUBLE in
 * OpenSCAD's place: tests/fixtures/fake-openscad.mjs, which writes known meshes (a box sized by -D width, depth and
 * height). No OpenSCAD runs in this suite: a pass says Timmy's side (the run's folder, the copy, the runner, the
 * judgement, the readback, the REPL, the agent tool and the /tools row) holds, not that OpenSCAD was driven.
 */
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNativeTools } from '../src/agent/native-tools.js';
import { capabilities, type CapabilityRow, type ProbeDeps } from '../src/capabilities/index.js';
import { JobManager, type JobRecord } from '../src/jobs/index.js';
import { nativeCapabilityRows, nativeRunIndex, NativeNotFound, noteNativeStarted, readNativeRecord, type NativeJobSpec } from '../src/native/index.js';
import {
  isScadJobSpec, judgeScadJob, reconcileScad, scadJob, scadReceiptFields, scanMessages, SCAD_USAGE, type ScadJobInput, type ScadJobSpec,
} from '../src/native/openscad.js';
import {
  checkScadParams, defineFor, mergeScadParams, nameProblem, paramsFileFor, parseScadParams, parseScadWords, readScadParams, scadParamsText, unassignedNames, valueProblem,
} from '../src/native/scad-params.js';
import { DOCTRINE_15, measureMesh, parseStl, readbackOf, readStlFile, topologyWords, volumeWords } from '../src/native/stl-readback.js';
import { folderProject } from '../src/project/index.js';
import { DOCTRINE_15 as RECIPE_DOCTRINE_15 } from '../src/recipes/index.js';
import { approvalNeeded } from '../src/repl/approvals.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { ReceiptInput } from '../src/utils/receipts.js';

const REPO = path.resolve(__dirname, '..');
const FAKE = path.join(__dirname, 'fixtures', 'fake-openscad.mjs');
const BOX = 'width = 10;\ndepth = 20;\nheight = 30;\ncube([width, depth, height]);\n';
let tmp = '';
let root = '';
let managers: JobManager[] = [];
let spaces: Workspace[] = [];

beforeEach(() => {
  // resolved: on macOS the temp folder is reached through a link, and the job specs resolve the project folder
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'timmy-scad-')));
  root = path.join(tmp, 'project');
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'box.scad'), BOX);
  managers = [];
  spaces = [];
});
afterEach(async () => {
  for (const w of spaces) await w.close();
  for (const m of managers) await m.stopAll();
  rmSync(tmp, { recursive: true, force: true });
});

const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
/** An executable copy of the fake at `at` (made executable here, whatever the checkout's modes). */
function install(at = path.join(tmp, 'bin', 'openscad')): string {
  mkdirSync(path.dirname(at), { recursive: true });
  copyFileSync(FAKE, at);
  chmodSync(at, 0o755);
  return at;
}
function manager(): JobManager {
  const m = new JobManager({ dir: path.join(tmp, 'jobs') });
  managers.push(m);
  return m;
}
/** A run of box.scad with the fake as OpenSCAD; `mode` sets FAKE_OPENSCAD_MODE. */
function job(extra: Partial<ScadJobInput> = {}, mode?: string): ScadJobSpec {
  return scadJob({ model: 'box.scad', root, project: 'demo', timeoutMs: 30_000, bin: install(), ...(mode ? { env: { FAKE_OPENSCAD_MODE: mode } } : {}), ...extra });
}
/** Starts a run as the REPL and the agent tool do (noting its job in the run's folder) and waits for its end. */
async function run(spec: NativeJobSpec): Promise<{ m: JobManager; job: JobRecord }> {
  const m = manager();
  const started = m.start(spec);
  noteNativeStarted(spec, started);
  return { m, job: await m.done(started.id) };
}
async function judged(mode?: string, extra: Partial<ScadJobInput> = {}) {
  const spec = job(extra, mode);
  const { job: done } = await run(spec);
  return { spec, done, j: judgeScadJob(done, spec) };
}

// ── meshes made here ─────────────────────────────────────────────────────────────

type P = [number, number, number];
type Tri = [P, P, P];
/** A box: twelve triangles, corners counter-clockwise seen from outside. Order: bottom, top, front, back, left, right. */
function box(w: number, d: number, h: number, o: P = [0, 0, 0]): Tri[] {
  const p = (x: number, y: number, z: number): P => [o[0] + x * w, o[1] + y * d, o[2] + z * h];
  const [p000, p100, p110, p010, p001, p101, p111, p011] = [p(0, 0, 0), p(1, 0, 0), p(1, 1, 0), p(0, 1, 0), p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)];
  return [
    [p000, p010, p110], [p000, p110, p100], [p001, p101, p111], [p001, p111, p011], [p000, p100, p101], [p000, p101, p001],
    [p010, p011, p111], [p010, p111, p110], [p000, p001, p011], [p000, p011, p010], [p100, p110, p111], [p100, p111, p101],
  ];
}
function binary(tris: Tri[], header = 'a test mesh'): Buffer {
  const buf = Buffer.alloc(84 + 50 * tris.length);
  buf.write(header, 0, 'latin1');
  buf.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => t.flat().forEach((v, k) => buf.writeFloatLE(v, 84 + i * 50 + 12 + k * 4)));
  return buf;
}
function ascii(tris: Tri[], fmt: (v: number) => string = String): string {
  return `solid test\n${tris.map((t) => `  facet normal 0 0 0\n    outer loop\n${t.map((p) => `      vertex ${p.map(fmt).join(' ')}\n`).join('')}    endloop\n  endfacet\n`).join('')}endsolid test\n`;
}
function measure(buf: Buffer) {
  const p = parseStl(buf);
  if ('error' in p) throw new Error(p.error);
  return { ...measureMesh(p.triangles), format: p.format };
}

describe("Timmy's own STL readback (no OpenSCAD)", () => {
  it('a unit cube: 12 triangles, 8 corners, volume 1, area 6, edge-manifold and consistently oriented', () => {
    const m = measure(binary(box(1, 1, 1)));
    expect(m).toMatchObject({
      format: 'binary', triangles: 12, corners: 8, edges: 18, boundary_edges: 0, non_manifold_edges: 0, misoriented_edges: 0,
      collapsed_triangles: 0, zero_area_triangles: 0, manifold: true, oriented: true,
    });
    expect(m.volume).toBe(1);
    expect(m.area).toBe(6);
    expect(m.bbox).toEqual({ min: [0, 0, 0], max: [1, 1, 1], size: [1, 1, 1] });
    expect(topologyWords(m)).toBe('edge-manifold: every edge shared by exactly two triangles, consistently oriented');
    expect(volumeWords(m)).toBe('1 (enclosed; normals outward)');
  });

  it('binary and ASCII of one mesh measure the same (coordinates read as 32-bit floats)', () => {
    const tris = box(1.7, 0.3, 2.2, [0.1, -2.5, 1 / 3]);
    const b = measure(binary(tris));
    const a = measure(Buffer.from(ascii(tris, (v) => Math.fround(v).toPrecision(9))));
    expect([b.format, a.format]).toEqual(['binary', 'ascii']);
    const { format: _b, ...fromBinary } = b;
    const { format: _a, ...fromAscii } = a;
    expect(fromAscii).toEqual(fromBinary);
    expect(b.manifold && b.oriented).toBe(true);
    expect(b.volume).toBeCloseTo(1.7 * 0.3 * 2.2, 5);
    // keywords in any case, exponents in the numbers
    const shouted = ascii(box(1, 1, 1), (v) => v.toExponential()).replace(/facet|vertex|loop|solid|normal/g, (w) => w.toUpperCase());
    expect(measure(Buffer.from(shouted))).toMatchObject({ format: 'ascii', triangles: 12, volume: 1, area: 6, manifold: true });
  });

  it('an open box: four boundary edges, not edge-manifold, and its signed volume is not called enclosed', () => {
    const m = measure(binary(box(1, 1, 1).filter((_, i) => i !== 2 && i !== 3)));
    expect(m).toMatchObject({ triangles: 10, edges: 17, boundary_edges: 4, non_manifold_edges: 0, manifold: false, oriented: false });
    expect(topologyWords(m)).toBe('not edge-manifold: 4 boundary edges (one triangle: the mesh is open)');
    expect(volumeWords(m)).toMatch(/, signed: not an enclosed volume \(the mesh is not closed and consistently oriented\)$/);
  });

  it('a third triangle on an edge: one non-manifold edge and the new triangle\'s two boundary edges', () => {
    const m = measure(binary([...box(1, 1, 1), [[0, 0, 0], [1, 0, 0], [0.5, -1, 0]]]));
    expect(m).toMatchObject({ triangles: 13, non_manifold_edges: 1, boundary_edges: 2, manifold: false });
    expect(m.bbox?.min).toEqual([0, -1, 0]);
    expect(topologyWords(m)).toBe('not edge-manifold: 2 boundary edges (one triangle: the mesh is open), 1 non-manifold edge (three or more triangles)');
  });

  it('every triangle reversed: still closed and consistent, the volume negative; one reversed: three misoriented edges', () => {
    const inward = measure(binary(box(2, 2, 2).map(([a, b, c]): Tri => [a, c, b])));
    expect(inward).toMatchObject({ manifold: true, oriented: true, volume: -8, area: 24 });
    expect(volumeWords(inward)).toBe('-8 (enclosed, negative: the normals face inward)');
    const mixed = box(1, 1, 1);
    mixed[0] = [mixed[0][0], mixed[0][2], mixed[0][1]];
    const m = measure(binary(mixed));
    expect(m).toMatchObject({ manifold: true, oriented: false, misoriented_edges: 3 });
    expect(topologyWords(m)).toBe('edge-manifold, but 3 edges shared by two triangles running the same way (inconsistent orientation)');
  });

  it('a repeated corner is a collapsed triangle (no edges); three corners on a line have zero area', () => {
    const m = measure(binary([...box(1, 1, 1), [[0, 0, 0], [0, 0, 0], [1, 0, 0]], [[0, 0, 0], [0.5, 0, 0], [1, 0, 0]]]));
    expect(m).toMatchObject({ triangles: 14, collapsed_triangles: 1, zero_area_triangles: 1, manifold: false });
    expect(m.area).toBe(6);
    expect(topologyWords(m)).toMatch(/1 collapsed triangle \(a repeated corner\)/);
  });

  it('-0 and +0 are one corner; a binary file whose header starts with "solid" is read as binary', () => {
    const tris = box(1, 1, 1).map((t, i): Tri => (i < 6 ? t.map((p) => p.map((v) => (v === 0 ? -0 : v))) as Tri : t));
    expect(measure(binary(tris, 'solid but binary'))).toMatchObject({ format: 'binary', corners: 8, manifold: true, oriented: true });
  });

  it('refuses what is not a well-formed STL, with the reason', () => {
    expect(parseStl(Buffer.alloc(10))).toEqual({ error: expect.stringMatching(/^10 bytes: too short for a binary STL/) });
    expect(parseStl(Buffer.concat([binary(box(1, 1, 1)), Buffer.from([0])]))).toEqual({
      error: 'not an STL: a binary STL with the 12 triangles its header declares is 684 bytes, this file is 685; and it does not start with "solid" as an ASCII STL does',
    });
    const two = ascii(box(1, 1, 1)).replace(/(outer loop\n(?:.*\n){2}).*\n/, '$1');
    expect(parseStl(Buffer.from(two))).toEqual({ error: expect.stringMatching(/^not a well-formed ASCII STL: line 6: "endloop" where "vertex" was expected$/) });
    expect(parseStl(Buffer.from(ascii(box(1, 1, 1)).replace('vertex 0 0 0', 'vertex 0 abc 0')))).toEqual({ error: expect.stringMatching(/line 4: "abc" is not a coordinate/) });
    expect(parseStl(Buffer.from(ascii(box(1, 1, 1)).replace('endsolid test\n', '')))).toEqual({ error: expect.stringMatching(/no endsolid/) });
    const nan = binary(box(1, 1, 1));
    nan.writeFloatLE(Number.NaN, 84 + 12);
    expect(readbackOf(nan, 'nan.stl', 'x')).toMatchObject({ ok: false, kind: 'malformed', error: expect.stringMatching(/triangle 1 has a coordinate that is not a finite number/) });
  });

  it('reads a file once: the sha256 of the bytes it measured, DOCTRINE §15 tags and sentence; a missing or too large file is said so', () => {
    const file = path.join(tmp, 'cube.stl');
    writeFileSync(file, binary(box(1, 1, 1)));
    const r = readStlFile(file, 'cube.stl');
    if (!r.ok) throw new Error(r.error);
    expect(r.readback).toMatchObject({
      measured_by: 'timmy-stl-readback/1', tier: 'deterministic computation', file: 'cube.stl', sha256: sha(file), bytes: 684, format: 'binary',
      provenance: 'generated', evidence: 'checked', notice: DOCTRINE_15, triangles: 12, volume: 1,
    });
    expect(r.readback.scope).toMatch(/not a measurement of a physical part/);
    expect(r.readback.independent_of).toMatch(/no OpenSCAD/);
    expect(readStlFile(file, 'cube.stl', { maxBytes: 100 })).toMatchObject({ ok: false, kind: 'too large' });
    expect(readStlFile(path.join(tmp, 'none.stl'), 'none.stl')).toMatchObject({ ok: false, kind: 'missing' });
    expect(measureMesh(new Float32Array(0))).toMatchObject({ triangles: 0, bbox: null, manifold: false });
  });

  it('carries DOCTRINE §15 word for word, the same sentence the recipe shows', () => {
    expect(DOCTRINE_15).toBe(RECIPE_DOCTRINE_15);
    expect(DOCTRINE_15).toBe('Timmy can compute and verify dimensions of generated CAD. Converting that CAD cannot establish the dimensions or density of a physical object.');
  });
});

describe('parameters: what OpenSCAD is given as -D', () => {
  it('admits names of letters, digits and _, never a keyword or anything else', () => {
    for (const ok of ['width', '_x9', 'lid_gap']) expect(nameProblem(ok)).toBeUndefined();
    for (const bad of ['9x', 'a-b', '$fn', 'a b', '', 'x;y']) expect(nameProblem(bad)).toMatch(/not a parameter name/);
    for (const kw of ['module', 'true', 'undef', 'include', 'for']) expect(nameProblem(kw)).toMatch(/OpenSCAD keyword/);
  });

  it('writes each value itself: numbers as JavaScript writes them, true or false, text quoted and escaped', () => {
    expect([defineFor('w', 60), defineFor('w', 0.3), defineFor('w', -2.5), defineFor('w', 1e21), defineFor('w', -0)]).toEqual(['w=60', 'w=0.3', 'w=-2.5', 'w=1e+21', 'w=0']);
    expect(defineFor('f', true)).toBe('f=true');
    expect(defineFor('t', 'Lid "A" \\ 1')).toBe('t="Lid \\"A\\" \\\\ 1"');
    // text stays text: it cannot end its own string and add a statement
    expect(defineFor('t', '"; cube(1000); x="')).toBe('t="\\"; cube(1000); x=\\""');
    expect(() => defineFor('w', Number.NaN)).toThrow(/finite/);
    expect(() => defineFor('w', Infinity)).toThrow(/finite/);
    expect(valueProblem('v', [1, 2])).toMatch(/a vector is refused/);
    expect(valueProblem('v', null)).toMatch(/null is refused/);
    expect(valueProblem('t', 'a\nb')).toMatch(/control character/);
    expect(checkScadParams({ width: 1, 'bad-name': 2 })).toEqual({ ok: false, error: expect.stringMatching(/bad-name is not a parameter name/) });
  });

  it("/scad's words: the model, name=value (numbers, true or false, quoted text) and --png; anything else refused", () => {
    expect(parseScadWords('box.scad')).toEqual({ model: 'box.scad', params: {}, png: false });
    expect(parseScadWords(`box.scad width=80 lid_gap=.25 hollow=false label="Lid A" part='lid' --png`))
      .toEqual({ model: 'box.scad', params: { width: 80, lid_gap: 0.25, hollow: false, label: 'Lid A', part: 'lid' }, png: true });
    expect(parseScadWords('"my models/a box.scad" n=1e-3 empty=""')).toEqual({ model: 'my models/a box.scad', params: { n: 0.001, empty: '' }, png: false });
    expect(parseScadWords('box.scad label=Lid')).toEqual({ error: 'label=Lid: a value is a number, true or false, or text in quotes (label="Lid")' });
    expect(parseScadWords('box.scad width=[1,2]')).toEqual({ error: expect.stringMatching(/width=\[1,2\]: a value is a number/) });
    expect(parseScadWords('box.scad w=1 w=2')).toEqual({ error: 'w is given twice' });
    expect(parseScadWords('box.scad $fn=10')).toEqual({ error: expect.stringMatching(/\$fn is not a parameter name/) });
    expect(parseScadWords('box.scad --pngs')).toEqual({ error: expect.stringMatching(/unknown option --pngs: \/scad takes --png/) });
    expect(parseScadWords('a.scad b.scad')).toEqual({ error: expect.stringMatching(/one model per run/) });
    expect(parseScadWords('box.scad label="open')).toEqual({ error: 'a double quote is not closed' });
    expect(parseScadWords('box.scad w=')).toEqual({ error: expect.stringMatching(/give w a value/) });
    expect(parseScadWords('box.scad t="a"b')).toEqual({ error: expect.stringMatching(/text is one quoted value/) });
    expect(parseScadWords('box.scad w=1e999')).toEqual({ error: 'w must be a finite number' });
  });

  it('the parameter file: <model>.params.json beside the model, checked against its name; words override it', () => {
    mkdirSync(path.join(root, 'models'));
    writeFileSync(path.join(root, 'models', 'box.scad'), BOX);
    const text = scadParamsText('box.scad', { width: 60, part: 'both', hollow: true });
    writeFileSync(path.join(root, 'models', 'box.params.json'), text);
    expect(paramsFileFor('models/box.scad')).toBe('models/box.params.json');
    expect(paramsFileFor('Box.SCAD')).toBe('Box.params.json');
    const read = readScadParams(root, 'models/box.scad');
    expect(read).toEqual({ ok: true, exists: true, path: 'models/box.params.json', sha256: sha(path.join(root, 'models', 'box.params.json')), bytes: Buffer.byteLength(text), parameters: { width: 60, part: 'both', hollow: true } });
    expect(readScadParams(root, 'box.scad')).toEqual({ ok: true, exists: false, path: 'box.params.json' });
    const merged = mergeScadParams(read.ok && read.exists ? read.parameters : {}, { width: 80, label: 'Lid' });
    expect(merged.params).toEqual({ width: { value: 80, from: 'words' }, part: { value: 'both', from: 'file' }, hollow: { value: true, from: 'file' }, label: { value: 'Lid', from: 'words' } });
    expect(merged.defines).toEqual(['width=80', 'part="both"', 'hollow=true', 'label="Lid"']);
  });

  it('refuses a parameter file that does not check, or a link at its place, with the reason; nothing starts', () => {
    const file = path.join(root, 'box.params.json');
    const cases: Array<[unknown, RegExp]> = [
      [{ schema: 'timmy.recipe-params/1', model: 'box.scad', parameters: {} }, /schema must be timmy\.scad-params\/1/],
      [{ schema: 'timmy.scad-params/1', model: 'lid.scad', parameters: {} }, /model must be box\.scad, the file it sits beside \(it says lid\.scad\)/],
      [{ schema: 'timmy.scad-params/1', model: 'box.scad', parameters: {}, note: 'x' }, /unexpected field note/],
      [{ schema: 'timmy.scad-params/1', model: 'box.scad', parameters: { size: [1, 2] } }, /a vector is refused/],
    ];
    for (const [body, error] of cases) {
      writeFileSync(file, JSON.stringify(body));
      expect(readScadParams(root, 'box.scad')).toMatchObject({ ok: false, path: 'box.params.json', error: expect.stringMatching(error) });
      expect(() => job()).toThrow(/the parameter file box\.params\.json is refused/);
    }
    expect(parseScadParams('{', 'box.scad')).toEqual({ ok: false, error: expect.stringMatching(/^not JSON/) });
    rmSync(file);
    // a link at its place: to a file outside the project, or to another file in it
    writeFileSync(path.join(tmp, 'elsewhere.json'), scadParamsText('box.scad', { width: 1 }));
    symlinkSync(path.join(tmp, 'elsewhere.json'), file);
    expect(readScadParams(root, 'box.scad')).toMatchObject({ ok: false, error: 'box.params.json leads outside the project' });
    rmSync(file);
    writeFileSync(path.join(root, 'other.json'), scadParamsText('box.scad', { width: 1 }));
    symlinkSync(path.join(root, 'other.json'), file);
    expect(readScadParams(root, 'box.scad')).toMatchObject({ ok: false, error: 'box.params.json is a symbolic link; Timmy reads a parameter file only in place' });
    expect(() => job()).toThrow(/is a symbolic link/);
    expect(existsSync(path.join(root, '.timmy', 'native'))).toBe(false);
  });

  it('names the parameters the model does not assign at the start of a line (comments do not count)', () => {
    const text = 'width = 1;\n// depth = 2\n/* height = 3 */\n  lid_gap=0.3;\nwidth == 2;\n';
    expect(unassignedNames(text, ['width', 'depth', 'height', 'lid_gap', 'widht'])).toEqual(['depth', 'height', 'widht']);
  });
});

describe('an OpenSCAD job: its folder, the copy it runs and OPENSCADPATH', () => {
  it('Node runs Timmy\'s runner on a read-only configuration; the copy is read-only and hashed; the outputs are new', () => {
    const s = job({ params: { width: 60 }, png: true });
    const record = path.join(root, '.timmy', 'native', s.native.run);
    const config = path.join(record, 'runner-config.json');
    const copy = path.join(record, 'source', 'box.scad');
    const out = `out/scad/${s.native.run.slice(0, 8)}`;
    expect(isScadJobSpec(s)).toBe(true);
    expect(s.kind).toBe('task');
    expect(s.command).toBe(process.execPath);
    expect(s.args).toEqual([path.join(REPO, 'workers', 'scad', 'timmy_scad_run.mjs'), config]);
    expect(s.label).toBe(`OpenSCAD · box.scad → ${out}/box.stl`);
    expect(s.native).toMatchObject({
      app: 'openscad', expect: [`${out}/box.stl`, `${out}/box.png`], input: { path: 'box.scad', sha256: sha(path.join(root, 'box.scad')) },
      copy: { path: `.timmy/native/${s.native.run}/source/box.scad`, sha256: sha(path.join(root, 'box.scad')) },
      pre: { [`${out}/box.stl`]: { state: 'absent' }, [`${out}/box.png`]: { state: 'absent' } },
    });
    expect(statSync(copy).mode & 0o777).toBe(0o444);
    expect(sha(copy)).toBe(sha(path.join(root, 'box.scad')));
    expect(statSync(config).mode & 0o777).toBe(0o444);
    expect(sha(config)).toBe(s.scad.runner.config.sha256);
    const steps = JSON.parse(readFileSync(config, 'utf8')).steps;
    const stl = path.join(root, out, 'box.stl');
    const summary = path.join(record, 'openscad-summary.json');
    expect(steps.version.args).toEqual(['--version']);
    expect(steps.export.args).toEqual(['-o', stl, '--export-format', 'binstl', '-D', 'width=60', '--summary', 'all', '--summary-file', summary, copy]);
    expect(steps.export.fallback.args).toEqual(['-o', stl, '--export-format', 'binstl', '-D', 'width=60', copy]);
    expect(steps.png.args).toEqual(['-o', path.join(root, out, 'box.png'), '--render', '--imgsize=800,600', '--autocenter', '--viewall', '-D', 'width=60', copy]);
    expect(String(s.env?.OPENSCADPATH).split(path.delimiter)[0]).toBe(root);
    expect(existsSync(path.join(root, out))).toBe(true);
    expect(readNativeRecord(root, s.native.run)?.job).toMatchObject({ app: 'openscad', run: s.native.run, input: { path: 'box.scad' }, expect: [`${out}/box.stl`, `${out}/box.png`] });
    expect(JSON.parse(readFileSync(path.join(record, 'scad.json'), 'utf8'))).toMatchObject({
      record: 'timmy-scad-run', run: s.native.run, model: { path: 'box.scad' }, params: { width: { value: 60, from: 'words' } }, defines: ['width=60'],
      stl: `${out}/box.stl`, png: { path: `${out}/box.png`, size: [800, 600] }, runner: { config: `.timmy/native/${s.native.run}/runner-config.json`, config_sha256: s.scad.runner.config.sha256 },
    });
  });

  it('keeps the OPENSCADPATH folders the environment had, after the model\'s own folder', () => {
    mkdirSync(path.join(root, 'models'));
    writeFileSync(path.join(root, 'models', 'part.scad'), BOX);
    const libs = path.join(tmp, 'libs');
    const s = job({ model: 'models/part.scad', env: { OPENSCADPATH: libs } });
    expect(String(s.env?.OPENSCADPATH).split(path.delimiter)).toEqual([path.join(root, 'models'), libs]);
  });

  it('refuses a model outside the project, not .scad, or missing, and bad parameters; without OpenSCAD found, NativeNotFound with the step', () => {
    expect(() => job({ model: '../x.scad' })).toThrow(/outside the project/);
    writeFileSync(path.join(root, 'notes.txt'), 'x');
    expect(() => job({ model: 'notes.txt' })).toThrow(/notes\.txt is not an OpenSCAD model \(\.scad\)/);
    expect(() => job({ model: 'missing.scad' })).toThrow(/no model at missing\.scad/);
    expect(() => job({ params: { width: [1] } })).toThrow(/width must be a number, true or false, or text \(a vector is refused\)/);
    let notFound: unknown;
    try { scadJob({ model: 'box.scad', root, project: 'demo', findEnv: {}, seams: { platform: 'darwin', applications: path.join(tmp, 'Applications'), onPath: () => null } }); } catch (e) { notFound = e; }
    expect(notFound).toBeInstanceOf(NativeNotFound);
    expect((notFound as NativeNotFound).setup).toMatch(/TIMMY_OPENSCAD/);
    expect(existsSync(path.join(root, '.timmy', 'native'))).toBe(false);
  });

  it('says before the run when a parameter is not assigned in the model, or the model calls import()', () => {
    writeFileSync(path.join(root, 'logo.scad'), 'width = 1;\nlinear_extrude(2) import("logo.svg");\n');
    const s = job({ model: 'logo.scad', params: { width: 2, widht: 3 } });
    expect(s.scad.notes).toEqual([
      expect.stringMatching(/^widht: no "name = …" line in logo\.scad's own text; OpenSCAD defines a -D name whether or not the model uses it/),
      expect.stringMatching(/^logo\.scad calls import\(\) or surface\(\): OpenSCAD looks for a file named there beside the copy it runs/),
    ]);
  });
});

describe('OpenSCAD runs, judged (the fake openscad; Timmy\'s real runner and jobs)', () => {
  it('ok: the STL created by this run, the -D values reached the program, and Timmy\'s own reading measures what it wrote', async () => {
    const { spec, done, j } = await judged('warn', { params: { width: 60, depth: 40, height: 30 } });
    expect(done.state).toBe('completed');
    expect(j.outcome).toBe('ok');
    expect(j.why).toMatch(/^out\/scad\/[0-9a-f]{8}\/box\.stl was created by this run from box\.scad as submitted \(OpenSCAD ran the read-only copy kept at submission; its sha256 was checked when it was made and again after the run\); openscad exited 0 with no ERROR line and 2 warning lines; Timmy's own reading: binary STL, 12 triangles, edge-manifold$/);
    const stl = path.join(root, spec.scad.stl.rel);
    expect(j.scad.stl).toEqual({ path: spec.scad.stl.rel, present: true, change: 'created', made: true, sha256: sha(stl), bytes: 684 });
    expect(j.scad.readback).toMatchObject({ format: 'binary', triangles: 12, corners: 8, manifold: true, oriented: true, sha256: sha(stl), provenance: 'generated', evidence: 'checked', notice: DOCTRINE_15 });
    expect(j.scad.readback?.bbox).toEqual({ min: [0, 0, 0], max: [60, 40, 30], size: [60, 40, 30] });
    expect([j.scad.readback?.volume, j.scad.readback?.area]).toEqual([72000, 10800]);
    expect(j.scad.version).toBe('2026.09.23 (fake)');
    expect(j.scad.messages).toMatchObject({ from: 'stderr', errors: 0, warnings: 2, echo: 5, trace: 0 });
    expect(j.scad.messages.lines).toEqual([
      { kind: 'WARNING', text: 'WARNING: Ignoring unknown variable "lenght" in file box.scad, line 7' },
      { kind: 'DEPRECATED', text: 'DEPRECATED: The assign() module will be removed in future releases. Use a regular assignment instead. (fake)' },
    ]);
    expect(j.scad.summary).toMatchObject({ state: 'written', path: `.timmy/native/${spec.native.run}/openscad-summary.json`, agrees: true, differs_by: 0 });
    expect(j.scad.steps.map((s) => [s.name, s.attempt, s.exit_code])).toEqual([['version', 1, 0], ['export', 1, 0]]);
    expect(j.source).toMatchObject({ copy_state: 'intact', established_by: ['retained copy'] });
    // the run's record: the verdict appended, the reading kept
    const record = path.join(root, '.timmy', 'native', spec.native.run);
    const verdicts = readFileSync(path.join(record, 'verdicts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(verdicts.at(-1)).toMatchObject({ job: done.id, outcome: 'ok', files: [{ path: spec.scad.stl.rel, written: true, change: 'created' }] });
    expect(JSON.parse(readFileSync(path.join(record, 'readback.json'), 'utf8'))).toMatchObject({ ok: true, readback: { sha256: sha(stl), triangles: 12 } });
    judgeScadJob(done, spec);
    expect(readFileSync(path.join(record, 'verdicts.jsonl'), 'utf8').trim().split('\n')).toHaveLength(verdicts.length);
    // the receipt's fields: project-relative names only, Timmy's reading with DOCTRINE §15
    const sealed = scadReceiptFields(j, root);
    expect(sealed.status).toBe('ok');
    expect(sealed.native).toMatchObject({
      app: 'openscad', outcome: 'ok', run: spec.native.run, input: { path: 'box.scad' },
      scad: {
        defines: ['width=60', 'depth=40', 'height=30'], params: { width: { value: 60, from: 'words' } }, openscad_version: '2026.09.23 (fake)',
        readback: { notice: DOCTRINE_15, provenance: 'generated', evidence: 'checked', bbox: { size: [60, 40, 30] } }, messages: { errors: 0, warnings: 2 },
        steps: [{ name: 'version', exit_code: 0 }, { name: 'export', exit_code: 0 }],
      },
    });
    expect(JSON.stringify(sealed)).not.toContain(tmp);
  });

  it('use <> and include <> beside the original resolve through OPENSCADPATH; a missing one is OpenSCAD\'s WARNING, kept word for word', async () => {
    writeFileSync(path.join(root, 'parts.scad'), 'module part() { cube(1); }\n');
    writeFileSync(path.join(root, 'box.scad'), `include <parts.scad>\nuse <missing.scad>\n${BOX}`);
    const { spec, j } = await judged();
    expect(j.outcome).toBe('ok');
    expect(j.scad.messages).toMatchObject({ warnings: 1, trace: 1 });
    expect(j.scad.messages.lines).toEqual([{ kind: 'WARNING', text: "WARNING: Can't open include file 'missing.scad'." }]);
    // the copy alone in its folder: parts.scad was found on OPENSCADPATH, not beside the file OpenSCAD ran
    const stderr = readFileSync(path.join(root, '.timmy', 'native', spec.native.run, 'logs', 'export.stderr'), 'utf8');
    expect(stderr).toContain('TRACE: fake-openscad found <parts.scad> on OPENSCADPATH');
    expect(readdirSync(path.join(root, '.timmy', 'native', spec.native.run, 'source'))).toEqual(['box.scad']);
  });

  it('an ERROR and exit 1 with no STL: failed, the ERROR line word for word from the export\'s own stderr', async () => {
    const { spec, j } = await judged('error');
    expect(j.outcome).toBe('failed');
    expect(j.why).toMatch(/^no STL was written by this run: openscad exited 1; OpenSCAD reported 1 ERROR line \(first: ERROR: Parser error in file ".*\/source\/box\.scad", line 3: syntax error\)$/);
    expect(j.scad.messages.lines).toEqual([{ kind: 'ERROR', text: `ERROR: Parser error in file "${spec.scad.copy.path}", line 3: syntax error` }]);
    expect(j.scad.stl).toMatchObject({ present: false, made: false, change: 'absent' });
    const sealed = scadReceiptFields(j, root);
    expect(sealed.status).toBe('failed');
    expect(sealed.native.scad).toMatchObject({ messages: { errors: 1, lines: [{ kind: 'ERROR', text: `ERROR: Parser error in file "./.timmy/native/${spec.native.run}/source/box.scad", line 3: syntax error` }] } });
    expect(JSON.stringify(sealed)).not.toContain(tmp);
  });

  it('an ERROR line beside an STL written is unknown; an empty object (no STL) is failed, exit 0 or not', async () => {
    const wrote = (await judged('error-wrote')).j;
    expect(wrote.outcome).toBe('unknown');
    expect(wrote.why).toMatch(/was created by this run and openscad exited 0, but OpenSCAD reported 1 ERROR line \(first: ERROR: Assertion 'wall > 0' failed in file box\.scad, line 40\): the STL may not hold the whole model$/);
    expect(scadReceiptFields(wrote, root).status).toBeUndefined();
    const empty0 = (await judged('empty0')).j;
    expect(empty0.outcome).toBe('failed');
    expect(empty0.why).toBe('no STL was written by this run: openscad exited 0');
    expect((await judged('empty')).j.why).toBe('no STL was written by this run: openscad exited 1');
  });

  it('an open mesh is ok but not edge-manifold; inward normals give a negative volume; ASCII is read too', async () => {
    const open = (await judged('open', { params: { width: 2, depth: 2, height: 2 } })).j;
    expect(open.outcome).toBe('ok');
    expect(open.why).toMatch(/Timmy's own reading: binary STL, 10 triangles, not edge-manifold$/);
    expect(open.scad.readback).toMatchObject({ boundary_edges: 4, manifold: false });
    const inward = (await judged('inward', { params: { width: 2, depth: 2, height: 2 } })).j;
    expect(inward.scad.readback).toMatchObject({ manifold: true, oriented: true, volume: -8 });
    const text = (await judged('ascii', { params: { width: 2, depth: 3, height: 4 } })).j;
    expect(text.outcome).toBe('ok');
    expect(text.scad.readback).toMatchObject({ format: 'ascii', triangles: 12, volume: 24, bbox: { size: [2, 3, 4] } });
  });

  it('a file that is not an STL is failed: Timmy cannot read it', async () => {
    const { j } = await judged('garbage');
    expect(j.outcome).toBe('failed');
    expect(j.why).toMatch(/was created by this run and openscad exited 0, but Timmy cannot read it as an STL: 19 bytes: too short for a binary STL/);
    expect(j.scad.readback_error).toMatchObject({ kind: 'malformed' });
  });

  it('a build without --summary: its line is kept, the export runs again without the option, and that is said', async () => {
    const { j } = await judged('no-summary');
    expect(j.outcome).toBe('ok');
    expect(j.scad.summary).toEqual({ state: 'refused', line: "unrecognised option '--summary'" });
    expect(j.scad.steps.map((s) => [s.name, s.attempt, s.exit_code])).toEqual([['version', 1, 0], ['export', 1, 1], ['export', 2, 0]]);
    expect(j.why).toMatch(/; this OpenSCAD refused the summary options, so the export ran again without them$/);
    expect(j.scad.messages.errors).toBe(0);
  });

  it('--png: the preview is made beside the STL; when it fails, the STL\'s outcome stands and the preview says why', async () => {
    const made = (await judged(undefined, { png: true })).j;
    expect(made.outcome).toBe('ok');
    expect(made.scad.png).toMatchObject({ made: true, change: 'created', size: [800, 600] });
    expect(made.files.map((f) => [f.path.replace(/^out\/scad\/[0-9a-f]{8}\//, ''), f.written])).toEqual([['box.stl', true], ['box.png', true]]);
    const failed = (await judged('png-fail', { png: true })).j;
    expect(failed.outcome).toBe('ok');
    expect(failed.scad.png).toMatchObject({ made: false, present: false });
    expect(failed.scad.png?.why).toBe('openscad exited 1; ERROR: Unable to make an OpenGL context (fake)');
    expect(failed.why).toMatch(/; no preview: openscad exited 1; ERROR: Unable to make an OpenGL context \(fake\)$/);
    const skipped = (await judged('error', { png: true })).j;
    expect(skipped.scad.png?.why).toBe('skipped: the export did not exit 0');
  });

  it('created against reused: the same bytes already at the output path are not this run\'s work; other bytes are changed by it', async () => {
    const first = (await judged(undefined, { outDir: 'out/fixed' })).j;
    expect(first.outcome).toBe('ok');
    const again = (await judged(undefined, { outDir: 'out/fixed' })).j;
    expect(again.scad.stl).toMatchObject({ change: 'reused', made: false });
    expect(again.outcome).toBe('unknown');
    expect(again.why).toBe('out/fixed/box.stl: there before this run with the same bytes: reused, not written by this run; openscad exited 0');
    const changed = (await judged(undefined, { outDir: 'out/fixed', params: { width: 11 } })).j;
    expect(changed.outcome).toBe('ok');
    expect(changed.why).toMatch(/^out\/fixed\/box\.stl was changed by this run from box\.scad/);
  });

  it('the copy kept at submission is what binds the run: changed after it, unknown; the original edited after it, still ok and said so', async () => {
    const { spec, done, j } = await judged();
    expect(j.outcome).toBe('ok');
    writeFileSync(path.join(root, 'box.scad'), `${BOX}// edited after the run\n`);
    const edited = judgeScadJob(done, spec);
    expect(edited.outcome).toBe('ok');
    expect(edited.why).toMatch(/; box\.scad itself has changed since it was submitted, which did not change what ran$/);
    chmodSync(spec.scad.copy.path, 0o644);
    writeFileSync(spec.scad.copy.path, 'cube(1);\n');
    const tampered = judgeScadJob(done, spec);
    expect(tampered.outcome).toBe('unknown');
    expect(tampered.why).toMatch(/^the copy of box\.scad kept at submission \(\.timmy\/native\/[0-9a-f-]{36}\/source\/box\.scad\) no longer holds the submitted bytes, so what ran cannot be shown to be what was submitted/);
  });

  it('a stop: the runner records it, and with no STL the run is failed; a live job is unknown and not recorded', async () => {
    const spec = job({}, 'hang');
    const m = manager();
    const started = m.start(spec);
    const runnerJson = path.join(root, '.timmy', 'native', spec.native.run, 'runner.json');
    const until = Date.now() + 15_000;
    while (Date.now() < until && !(existsSync(runnerJson) && /"name": "export"/.test(readFileSync(runnerJson, 'utf8')))) await new Promise((r) => setTimeout(r, 50));
    const live = judgeScadJob(m.get(started.id)!, spec);
    expect(live.outcome).toBe('unknown');
    expect(live.why).toBe('still running: it is judged when it ends');
    expect(existsSync(path.join(root, '.timmy', 'native', spec.native.run, 'verdicts.jsonl'))).toBe(false);
    const stopped = await m.stop(started.id);
    expect(stopped?.state).toBe('cancelled');
    const record = JSON.parse(readFileSync(runnerJson, 'utf8'));
    expect(record.interrupted).toBe('SIGTERM');
    const j = judgeScadJob(stopped!, spec);
    expect(j.outcome).toBe('failed');
    expect(j.why).toMatch(/^no STL was written by this run: openscad (was stopped \(SIGTERM\) before it ended; the job was stopped|ended by SIGTERM)$/);
  });

  it('after a restart, the run is judged again from its folder, the runner\'s record saying how OpenSCAD ended', async () => {
    const { spec, done } = await judged();
    const orphan = reconcileScad(root, spec.native.run);
    expect(orphan.outcome).toBe('ok');
    expect(orphan.exit).toEqual({ state: 'unknown', code: null, signal: null });
    expect(reconcileScad(root, spec.native.run, { findJob: (id) => (id === done.id ? done : undefined) }).exit).toMatchObject({ state: 'completed', code: 0 });
    expect(() => reconcileScad(root, '00000000-0000-4000-8000-000000000000')).toThrow(/no record of an OpenSCAD run/);
  });

  it('reads OpenSCAD\'s message kinds only at the start of a line, keeping error and warning lines and counting ECHO and TRACE', () => {
    const m = scanMessages('ECHO: 1\nTRACE: t\nWARNING: w\r\nnot ERROR: x\nEXPORT-ERROR: e\nFONT-WARNING: f\n', 'stderr');
    expect(m).toEqual({ from: 'stderr', errors: 1, warnings: 2, echo: 1, trace: 1, lines: [{ kind: 'WARNING', text: 'WARNING: w' }, { kind: 'EXPORT-ERROR', text: 'EXPORT-ERROR: e' }, { kind: 'FONT-WARNING', text: 'FONT-WARNING: f' }] });
    const many = scanMessages(Array.from({ length: 45 }, (_, i) => `WARNING: ${i}`).join('\n'), 'stderr');
    expect([many.warnings, many.lines.length, many.more]).toEqual([45, 40, 5]);
  });
});

describe('/scad in the REPL', () => {
  const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
  const jobIdOf = (out: string): string => { const m = /\b(j[0-9a-f]{6})\b/.exec(out); if (!m) throw new Error(`no job id in: ${out}`); return m[1]; };
  const settle = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));
  function make(env: Record<string, string>) {
    const notes: string[] = [];
    const sealed: ReceiptInput[] = [];
    const ws = new Workspace({
      glyphs: glyphSet(true), env, onPath: () => null, notify: (l) => notes.push(l.map((s) => s.text).join('')),
      openWeb: (url) => `Open ${url} in your browser.`, link: (t) => t, seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
      jobsDir: path.join(tmp, 'ws-jobs'), chdir: () => {},
    }, folderProject(root));
    spaces.push(ws);
    return { ws, notes, sealed };
  }

  it('says what runs before it starts, then the STL, Timmy\'s reading with DOCTRINE §15, OpenSCAD\'s lines and the next step; the receipt has no paths', async () => {
    const { ws, notes, sealed } = make({ TIMMY_OPENSCAD: install() });
    const usage = text(await ws.scad(''));
    for (const u of SCAD_USAGE) expect(usage).toContain(u);
    const started = text(await ws.scad('box.scad width=60 depth=40 height=30 --png'));
    expect(started).toMatch(/App {8}OpenSCAD at TIMMY_OPENSCAD: headless, no window; Timmy's runner \(workers\/scad\/timmy_scad_run\.mjs\) runs it and records each step/);
    expect(started).toMatch(/Model {6}box\.scad · sha256 [0-9a-f]{12}… · OpenSCAD runs a read-only copy kept at \.timmy\/native\/[0-9a-f-]{36}\/source\/box\.scad/);
    expect(started).toMatch(/Params {5}width=60 · depth=40 · height=30\n/);
    expect(started).toMatch(/Includes {3}use <…> and include <…> resolve beside box\.scad: the project folder is first on OPENSCADPATH/);
    expect(started).toMatch(/Saves {6}out\/scad\/[0-9a-f]{8}\/box\.stl \(binary STL\) · out\/scad\/[0-9a-f]{8}\/box\.png \(a 800x600 preview\) · then Timmy reads the STL back itself/);
    expect(started).toMatch(/Running {4}j[0-9a-f]{6} {2}OpenSCAD exports box\.scad · judged by its exit, the STL it writes and Timmy's own reading of that STL · \/jobs j[0-9a-f]{6} · \/stop j[0-9a-f]{6}/);
    const id = jobIdOf(started.slice(started.indexOf('Running')));
    await ws.jobs.done(id);
    await settle();
    const ended = notes.join('\n');
    expect(ended).toMatch(new RegExp(`${id} ok  OpenSCAD · box\\.scad → out/scad/[0-9a-f]{8}/box\\.stl: out/scad/[0-9a-f]{8}/box\\.stl was created by this run from box\\.scad as submitted .* · receipt id1 · /results`));
    expect(ended).toMatch(/stl {6}out\/scad\/[0-9a-f]{8}\/box\.stl · created by this run · sha256 [0-9a-f]{12}… \(Timmy's, after the run\) · 684 B/);
    expect(ended).toMatch(/mesh {5}binary STL · 12 triangles · 8 corners · edge-manifold: every edge shared by exactly two triangles, consistently oriented/);
    expect(ended).toMatch(/size {5}60 × 40 × 30 \(x × y × z in the file's units: STL records none; OpenSCAD models are millimetres by convention\) · from \(0, 0, 0\) to \(60, 40, 30\)/);
    expect(ended).toMatch(/volume {3}72000 \(enclosed; normals outward\) · surface area 10800/);
    expect(ended).toMatch(/measured by Timmy's own reading of the exported STL \(its own TypeScript, independent of OpenSCAD's engine\) · provenance generated · evidence checked/);
    expect(ended).toContain(`notice   ${DOCTRINE_15}`);
    expect(ended).toMatch(/openscad OpenSCAD 2026\.09\.23 \(fake\) · export exited 0 · 0 ERROR lines, 0 warning lines, 3 ECHO/);
    expect(ended).toMatch(/summary  \.timmy\/native\/[0-9a-f-]{36}\/openscad-summary\.json · OpenSCAD's own report, not Timmy's · its bounding box agrees with Timmy's reading/);
    expect(ended).toMatch(/png {6}out\/scad\/[0-9a-f]{8}\/box\.png · created by this run · 800x600/);
    expect(ended).toMatch(/next {5}\/open out\/scad\/[0-9a-f]{8}\/box\.png/);
    expect(ended).toMatch(/next {5}\/scad box\.scad width=60 {3}runs it again with a value changed \(or keep the values in box\.params\.json\)/);
    const receipt = sealed.find((r) => r.kind === 'native');
    expect(receipt).toMatchObject({ status: 'ok', native: { app: 'openscad', outcome: 'ok', scad: { readback: { bbox: { size: [60, 40, 30] }, notice: DOCTRINE_15 } } } });
    expect(JSON.stringify(receipt)).not.toContain(root);
    expect(JSON.stringify(receipt)).not.toContain(tmp);
  });

  it('a failed run shows OpenSCAD\'s ERROR line word for word and where its output is', async () => {
    writeFileSync(path.join(root, 'broken.scad'), '// fake-openscad: error\ncube(\n');
    const { ws, notes, sealed } = make({ TIMMY_OPENSCAD: install() });
    const started = text(await ws.scad('broken.scad'));
    const id = jobIdOf(started.slice(started.indexOf('Running')));
    await ws.jobs.done(id);
    await settle();
    const ended = notes.join('\n');
    expect(ended).toMatch(new RegExp(`${id} failed  OpenSCAD · broken\\.scad → out/scad/[0-9a-f]{8}/broken\\.stl: no STL was written by this run: openscad exited 1`));
    expect(ended).toMatch(/· ERROR: Parser error in file "\.\/\.timmy\/native\/[0-9a-f-]{36}\/source\/broken\.scad", line 3: syntax error/);
    expect(ended).toMatch(new RegExp(`look {5}\\.timmy/native/[0-9a-f-]{36}/logs/export\\.stderr · /jobs ${id} for the raw output`));
    expect(ended).not.toMatch(/next /);
    expect(sealed.find((r) => r.kind === 'native')).toMatchObject({ status: 'failed', native: { app: 'openscad', outcome: 'failed' } });
  });

  it('refuses a bad word, and says the step when OpenSCAD is not found; nothing starts', async () => {
    const { ws } = make({});
    expect(text(await ws.scad('box.scad label=Lid'))).toContain('label=Lid: a value is a number, true or false, or text in quotes (label="Lid")');
    expect(text(await ws.scad('width=3'))).toMatch(/Name the model \(\.scad\)\./);
    const missing = text(await ws.scad('box.scad'));
    expect(missing).toContain('OpenSCAD (command line) was not found on this machine');
    expect(missing).toContain('Setup: install OpenSCAD with openscad on PATH, or set TIMMY_OPENSCAD');
    expect(ws.jobs.list()).toHaveLength(0);
  });

  it('the starter: /scad box.scad takes box.params.json, a word overrides it, and every name in it is assigned in box.scad', async () => {
    for (const f of ['box.scad', 'box.params.json', 'README.md']) copyFileSync(path.join(REPO, 'templates', 'scad-starter', f), path.join(root, f));
    const file = readScadParams(root, 'box.scad');
    expect(file).toMatchObject({ ok: true, exists: true, parameters: { width: 60, depth: 40, height: 30, wall: 2, lid_gap: 0.3, part: 'both' } });
    expect(unassignedNames(readFileSync(path.join(root, 'box.scad'), 'utf8'), Object.keys(file.ok && file.exists ? file.parameters : {}))).toEqual([]);
    expect(readFileSync(path.join(root, 'README.md'), 'utf8')).toContain(DOCTRINE_15);
    const { ws, notes } = make({ TIMMY_OPENSCAD: install() });
    const started = text(await ws.scad('box.scad width=80'));
    expect(started).toContain('Params     width=80 · depth=40 (box.params.json) · height=30 (box.params.json) · wall=2 (box.params.json) · lid_gap=0.3 (box.params.json) · part="both" (box.params.json)');
    expect(started).not.toMatch(/Note/);
    await ws.jobs.done(jobIdOf(started.slice(started.indexOf('Running'))));
    await settle();
    // the fake sizes its box from width, depth and height: the file's values and the word reached the program
    expect(notes.join('\n')).toMatch(/size {5}80 × 40 × 30 /);
    expect(notes.join('\n')).toMatch(/runs it again with a value changed \(a word overrides box\.params\.json\)/);
  });
});

describe('run_native app openscad, and its /tools row', () => {
  it('asks first, refuses a call without a model or with a bad parameter, then starts a run that answers at once', async () => {
    expect(approvalNeeded('run_native', { app: 'openscad', model: 'box.scad' })).toMatchObject({ reason: expect.stringMatching(/OpenSCAD/), summary: 'openscad' });
    const m = manager();
    const bin = install();
    const started: NativeJobSpec[] = [];
    const [tool] = createNativeTools({ root: () => root, project: () => 'demo', start: (spec) => m.start(spec), find: { openscad: () => ({ app: 'openscad', path: bin, how: 'env' }) }, onStarted: (_job, spec) => void started.push(spec) });
    const call = (tool.function as unknown as { execute: (a: Record<string, unknown>) => Promise<Record<string, unknown>> }).execute;
    expect(await call({ app: 'openscad' })).toMatchObject({ ok: false, error: 'openscad needs model: the .scad file, relative to the project' });
    expect(await call({ app: 'openscad', model: 'box.scad', parameters: { 'bad-name': 1 } })).toMatchObject({ ok: false, error: expect.stringMatching(/bad-name is not a parameter name.*; nothing started$/) });
    expect(m.list()).toHaveLength(0);
    const answer = await call({ app: 'openscad', model: 'box.scad', parameters: { width: 12, label: 'Lid' }, png: true, timeout_minutes: 1 });
    expect(answer).toMatchObject({
      ok: true, app: 'openscad', model: 'box.scad', stl: expect.stringMatching(/^out\/scad\/[0-9a-f]{8}\/box\.stl$/), png: expect.stringMatching(/^out\/scad\/[0-9a-f]{8}\/box\.png$/),
      defines: ['width=12', 'label="Lid"'], notes: [expect.stringMatching(/^label: no "name = …" line in box\.scad's own text/)],
    });
    expect(String(answer.note)).toMatch(/^Started, not finished: OpenSCAD runs headless on a read-only copy of box\.scad with -D width=12 -D label="Lid", exporting out\/scad\/[0-9a-f]{8}\/box\.stl and the preview/);
    expect(String(answer.note)).toContain(DOCTRINE_15);
    expect(isScadJobSpec(started[0])).toBe(true);
    const done = await m.done(String(answer.job));
    const j = judgeScadJob(done, started[0] as ScadJobSpec);
    expect(j.outcome).toBe('ok');
    expect(j.scad.readback?.bbox?.size).toEqual([12, 20, 30]);
    const [missing] = createNativeTools({ root: () => root, project: () => 'demo', start: (spec) => m.start(spec), find: { openscad: () => null } });
    expect(await (missing.function as unknown as { execute: (a: Record<string, unknown>) => Promise<Record<string, unknown>> }).execute({ app: 'openscad', model: 'box.scad' }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/OpenSCAD \(command line\) was not found/), setup: expect.stringMatching(/TIMMY_OPENSCAD/) });
  });

  it('/tools: found by TIMMY_OPENSCAD or PATH, never by an /Applications scan; "implemented; not run" until a sealed run of its own', async () => {
    const apps = path.join(tmp, 'Applications');
    const inApp = install(path.join(apps, 'OpenSCAD.app', 'Contents', 'MacOS', 'OpenSCAD'));
    const row = (env: Record<string, string>, onPath: (p: string) => string | null = () => null): CapabilityRow | undefined =>
      nativeCapabilityRows(env, { platform: 'darwin', applications: apps, onPath }).find((r) => r.id === 'openscad');
    expect(row({})).toMatchObject({ kind: 'adapter', name: 'OpenSCAD (command line)', rung: 'needs setup', exercisedBy: 'native:openscad', tools: ['run_native'] });
    expect(row({})?.detail).toBe('not found: TIMMY_OPENSCAD is not set, no openscad on PATH; implemented; not run');
    expect(row({})?.setup).toBe('install OpenSCAD with openscad on PATH, or set TIMMY_OPENSCAD');
    expect(row({ TIMMY_OPENSCAD: install() })).toMatchObject({ rung: 'installed', detail: 'openscad at TIMMY_OPENSCAD; implemented; not run; exports a .scad model to a binary STL (/scad), read back by Timmy\'s own STL reader' });
    expect(row({ TIMMY_OPENSCAD: path.join(apps, 'OpenSCAD.app') })?.rung).toBe('installed');
    expect(row({}, (p) => (p === 'openscad' ? '/usr/bin/openscad' : null))?.detail).toMatch(/^openscad on PATH at \/usr\/bin\/openscad; implemented; not run/);
    expect(existsSync(inApp)).toBe(true); // there, and still not found by a scan
    const none: ProbeDeps = {
      env: {}, onPath: () => false, canvasBuilt: () => false, studio: async () => ({ state: 'not-running' }), studioBase: 'http://127.0.0.1:4337',
      ollama: async () => ({ ok: false, models: [] }), openrouter: async () => 'no-key', modelKeySource: () => null, model: 'm', http: async () => null,
      lanes: () => [], adapters: () => [], receipts: () => ({ ok: true, count: 0 }), exercised: () => new Map(), edgeSet: () => false, exists: () => false,
    };
    const sealed = (ts: string, app: string, outcome: string, status?: string): Record<string, unknown> =>
      ({ kind: 'native', ts, hash: `sha256_${ts}`, ...(status ? { status } : {}), native: { app, outcome, why: 'a reason', exit_code: 0, signal: null, files: [] } });
    const byId = (rows: CapabilityRow[]) => Object.fromEntries(rows.map((r) => [r.id, r]));
    const other = byId(await capabilities({ ...none, nativeRuns: () => nativeRunIndex([sealed('2026-10-09T09:00:00Z', 'blender', 'ok', 'ok')]) }));
    expect(other.openscad.exercised).toBeUndefined();
    expect(other.openscad.detail).toMatch(/implemented; not run/);
    const failed = byId(await capabilities({ ...none, nativeRuns: () => nativeRunIndex([sealed('2026-10-09T10:00:00Z', 'openscad', 'failed', 'failed')]) }));
    expect(failed.openscad.exercised).toBeUndefined();
    expect(failed.openscad.detail).toMatch(/last run failed: a reason, 2026-10-09T10:00:00Z/);
    const ok = byId(await capabilities({ ...none, nativeRuns: () => nativeRunIndex([sealed('2026-10-09T11:00:00Z', 'openscad', 'ok', 'ok')]) }));
    expect(ok.openscad.exercised).toBe('2026-10-09T11:00:00Z');
  });
});
