#!/usr/bin/env node
// fake-openscad.mjs: a TEST DOUBLE of OpenSCAD's command line, for tests/native-openscad.test.ts. It is not OpenSCAD:
// it has no language and no geometry engine, and renders nothing. It stands in only for the command line and the
// behaviour Timmy's OpenSCAD route relies on:
//   openscad --version                     prints "OpenSCAD version 2026.09.23 (fake)" on stderr and exits 0
//   openscad -o <x.stl> --export-format binstl [-D name=value]... [--summary all --summary-file <f>] <model.scad>
//   openscad -o <x.png> --render --imgsize=W,H --autocenter --viewall [-D name=value]... <model.scad>
// For an STL it writes a FAKE mesh: a box whose size comes from -D width=, depth=, height= (10, 20 and 30 when not
// given), so a test can see the parameters reach the program and Timmy's readback measure them. It says each -D it
// got as an ECHO line. Its messages go to stderr, as OpenSCAD's do. It looks for each `include <f>` and `use <f>` of
// the model where OpenSCAD documents it looks (beside the model, then each OPENSCADPATH folder): a TRACE line says
// where it found one, a WARNING says it found none.
// The mode: FAKE_OPENSCAD_MODE, else a line `// fake-openscad: <mode>` in the model, else ok:
//   ok           the box; exit 0
//   warn         the box, a WARNING, a DEPRECATED and two ECHO lines; exit 0
//   error        an ERROR line (a parse error) and "Execution aborted"; no file; exit 1
//   error-wrote  the box and an ERROR line; exit 0
//   open         the box without its top (two triangles fewer); exit 0
//   fin          the box and one more triangle on its bottom front edge (a non-manifold edge); exit 0
//   inward       the box with each triangle's corners reversed (its normals inward); exit 0
//   ascii        the box as an ASCII STL, though binstl was asked for (to exercise Timmy's ASCII reading); exit 0
//   garbage      a file that is no STL; exit 0
//   empty        "Current top level object is empty."; no file; exit 1
//   empty0       the same, exit 0
//   no-summary   refuses --summary as a build without it does ("unrecognised option '--summary'"), exit 1;
//                without the option, the box
//   png-fail     the box; the preview says it cannot make an OpenGL context and exits 1
//   hang         prints a line and waits until it is stopped
// A command line it does not expect exits 2, as a mistyped OpenSCAD call would fail.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const say = (line) => process.stderr.write(`${line}\n`);
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === '--version') { say('OpenSCAD version 2026.09.23 (fake)'); process.exit(0); }

let out;
let format;
let summary;
let summaryFile;
let render = false;
let imgsize;
const defines = [];
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '-o') out = argv[++i];
  else if (a === '--export-format') format = argv[++i];
  else if (a === '-D') defines.push(argv[++i]);
  else if (a === '--summary') summary = argv[++i];
  else if (a === '--summary-file') summaryFile = argv[++i];
  else if (a === '--render') render = true;
  else if (a === '--autocenter' || a === '--viewall') { /* framing: nothing to do in a fake */ }
  else if (a.startsWith('--imgsize=')) imgsize = a.slice('--imgsize='.length);
  else if (a.startsWith('-')) { say(`unrecognised option '${a}'`); process.exit(1); }
  else positional.push(a);
}
const input = positional[0];
if (positional.length !== 1 || !/\.scad$/i.test(input) || !out) { say('fake-openscad: expected -o <file> [options] <model.scad>'); process.exit(2); }
let text;
try { text = readFileSync(input, 'utf8'); } catch { say(`ERROR: Can't open input file '${input}'!`); process.exit(1); }
const mode = process.env.FAKE_OPENSCAD_MODE || /^\s*\/\/\s*fake-openscad:\s*([\w-]+)/m.exec(text)?.[1] || 'ok';
if (mode === 'no-summary' && (summary !== undefined || summaryFile !== undefined)) {
  say("unrecognised option '--summary'");
  say('Usage: openscad [options] file.scad (fake)');
  process.exit(1);
}
const preview = /\.png$/i.test(out);
if (!preview && format !== 'binstl') { say('fake-openscad: an STL is asked for with --export-format binstl'); process.exit(2); }
if (preview && (!render || !/^\d+,\d+$/.test(imgsize ?? ''))) { say('fake-openscad: a preview is asked for with --render and --imgsize=W,H'); process.exit(2); }

say('Parsing design (AST generation)...');
const values = {};
for (const d of defines) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(d ?? '');
  if (!m) { say(`ERROR: Parser error in file "<command line>": ${d}`); process.exit(1); }
  values[m[1]] = m[2];
  say(`ECHO: "fake-openscad -D ${d.replace(/"/g, '\\"')}"`);
}
const folders = (process.env.OPENSCADPATH || '').split(path.delimiter).filter(Boolean);
for (const m of text.matchAll(/^\s*(?:include|use)\s*<([^>]+)>/gm)) {
  const f = m[1];
  if (existsSync(path.join(path.dirname(input), f))) say(`TRACE: fake-openscad found <${f}> beside the model`);
  else if (folders.some((d) => existsSync(path.join(d, f)))) say(`TRACE: fake-openscad found <${f}> on OPENSCADPATH`);
  else say(`WARNING: Can't open include file '${f}'.`);
}

if (mode === 'hang') {
  say('Rendering Polygon Mesh using Manifold... (fake: waiting until stopped)');
  setInterval(() => {}, 1 << 30);
} else {
  finish();
}

function finish() {
  if (mode === 'error') { say(`ERROR: Parser error in file "${input}", line 3: syntax error`); say('Execution aborted'); process.exit(1); }
  if (mode === 'empty' || mode === 'empty0') { say('Current top level object is empty.'); process.exit(mode === 'empty' ? 1 : 0); }
  if (preview) {
    if (mode === 'png-fail') { say("Can't create OpenGL OffscreenView. Code: -1."); say('ERROR: Unable to make an OpenGL context (fake)'); process.exit(1); }
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`FAKE preview ${imgsize}\n`)]));
    say('fake-openscad: preview written');
    process.exit(0);
  }
  const size = (name, fallback) => { const n = values[name] === undefined ? fallback : Number(values[name]); return Number.isFinite(n) && n > 0 ? n : fallback; };
  const w = size('width', 10);
  const d = size('depth', 20);
  const h = size('height', 30);
  let tris = box(w, d, h);
  if (mode === 'open') tris = tris.filter((_, i) => i !== 2 && i !== 3);
  if (mode === 'fin') tris.push([[0, 0, 0], [w, 0, 0], [w / 2, -5, 0]]);
  if (mode === 'inward') tris = tris.map(([a, b, c]) => [a, c, b]);
  const bytes = mode === 'ascii' ? ascii(tris) : mode === 'garbage' ? Buffer.from('this is not an STL\n') : binary(tris);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  if (summaryFile) {
    const all = tris.flat();
    const lo = [0, 1, 2].map((k) => Math.min(...all.map((p) => p[k])));
    const hi = [0, 1, 2].map((k) => Math.max(...all.map((p) => p[k])));
    writeFileSync(summaryFile, `${JSON.stringify({ note: 'fake-openscad summary (a test double)', geometry: { dimensions: 3, facets: tris.length, bounding_box: { min: lo, max: hi, size: hi.map((v, k) => v - lo[k]) } } }, null, 2)}\n`);
  }
  if (mode === 'warn') {
    say(`WARNING: Ignoring unknown variable "lenght" in file ${path.basename(input)}, line 7`);
    say('DEPRECATED: The assign() module will be removed in future releases. Use a regular assignment instead. (fake)');
    say('ECHO: "fake echo 1"');
    say('ECHO: "fake echo 2"');
  }
  if (mode === 'error-wrote') say(`ERROR: Assertion 'wall > 0' failed in file ${path.basename(input)}, line 40`);
  say('Total rendering time: 0:00:00.010');
  process.exit(0);
}

/** A box [0,w]×[0,d]×[0,h]: twelve triangles, corners counter-clockwise seen from outside. Order: bottom, top, front, back, left, right. */
function box(w, d, h) {
  const p = (x, y, z) => [x * w, y * d, z * h];
  const [p000, p100, p110, p010, p001, p101, p111, p011] = [p(0, 0, 0), p(1, 0, 0), p(1, 1, 0), p(0, 1, 0), p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)];
  return [
    [p000, p010, p110], [p000, p110, p100],
    [p001, p101, p111], [p001, p111, p011],
    [p000, p100, p101], [p000, p101, p001],
    [p010, p011, p111], [p010, p111, p110],
    [p000, p001, p011], [p000, p011, p010],
    [p100, p110, p111], [p100, p111, p101],
  ];
}

function binary(tris) {
  const buf = Buffer.alloc(84 + 50 * tris.length);
  buf.write('fake-openscad binary STL (a test double)', 0, 'latin1');
  buf.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => {
    const at = 84 + i * 50 + 12;
    t.flat().forEach((v, k) => buf.writeFloatLE(v, at + k * 4));
  });
  return buf;
}

function ascii(tris) {
  const facets = tris.map((t) => `  facet normal 0 0 0\n    outer loop\n${t.map((v) => `      vertex ${v.join(' ')}\n`).join('')}    endloop\n  endfacet\n`).join('');
  return Buffer.from(`solid fake\n${facets}endsolid fake\n`);
}
