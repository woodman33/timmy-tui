#!/usr/bin/env node
// fake-illustrator.mjs: a TEST DOUBLE of Adobe Illustrator, for tests/native-illustrator.test.ts. It is NOT Illustrator:
// it draws nothing, and the documents it saves are not .ai files. It stands in for osascript, the one way Timmy asks
// Illustrator to run a script:
//   osascript -e 'with timeout of N seconds' -e 'tell application "<app>" to do javascript file "<harness.jsx>"' -e 'end timeout'
// It runs the harness (plain ES3 JavaScript) in a Node vm against a small stand-in of Illustrator's scripting objects
// (app, documents.add and open, artboards, layers, pathItems.rectangle/roundedRectangle/ellipse/polygon/star/add and
// setEntirePath, textFrames.pointText, RGBColor, File, Folder, $.evalFile), so the harness Timmy generates and the starter
// scripts really run here. What it writes is its own:
//   a FAKE .ai (a first line naming this fake, then JSON of its document), which its app.open reads back (and nothing else);
//   an SVG it renders from its document, in the form it guesses Illustrator's SVG export has (rect, circle, ellipse,
//     polygon, polyline, line and path elements; texts as <text>): its own rendering, NOT Illustrator's output;
//   a FAKE PDF (the PDF header line, then a line naming this fake: not a PDF anyone can open);
//   a real PNG of the artboard's size in pixels (one colour), whose header Timmy reads.
// Its geometry follows the scripting guide's names and argument orders, in one coordinate space with y growing upward
// (Illustrator's scripting convention); a text's bounds are this fake's own estimate (no fonts here).
// It prints the harness's return value, as osascript prints the result of do javascript; its own lines start
// "fake-illustrator (FAKE Adobe Illustrator)".
// FAKE_AI_MODE picks what it does:
//   ok            (the default) runs the harness
//   not-allowed   runs nothing, prints osascript's refusal to send Apple events (-1743) and exits 1
//   timeout       runs nothing, prints an AppleEvent timeout (-1712) and exits 1
//   syntax        runs nothing, prints an AppleScript compile error (-2741) and exits 1
//   no-run        runs nothing and exits 0
//   open-doc      the document the run opens (or saves) is already open in Illustrator
//   double-ext    exportFile adds its extension to a name that already has it (badge-v1.svg.svg)
//   no-png        this Illustrator has no ExportOptionsPNG24
//   svg-differs   its SVG export leaves the topmost shape out
//   vanish-ai     runs the harness, then deletes the .ai it saved
//   write-fail    every file opened for writing fails
// An unknown mode, or a command line that is not osascript's, exits 2. A harness that will not run exits 3. A preference
// changed, or the alert level left changed, is a violation: printed to stderr, exit 4.
import { deflateSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const MODES = new Set(['ok', 'not-allowed', 'timeout', 'syntax', 'no-run', 'open-doc', 'double-ext', 'no-png', 'svg-differs', 'vanish-ai', 'write-fail']);
const mode = process.env.FAKE_AI_MODE || 'ok';
const say = (s) => process.stdout.write(`fake-illustrator (FAKE Adobe Illustrator): ${s}\n`);
const argv = process.argv.slice(2);

const lines = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== '-e') { process.stderr.write(`fake-illustrator: expected only -e arguments, got ${argv[i]}\n`); process.exit(2); }
  lines.push(argv[++i] ?? '');
}
const m = /^with timeout of (\d+) seconds\ntell application "((?:[^"\\]|\\.)*)" to do javascript file "((?:[^"\\]|\\.)*)"\nend timeout$/.exec(lines.join('\n'));
if (!m) {
  process.stderr.write('fake-illustrator: expected -e "with timeout of N seconds" -e "tell application \\"<app>\\" to do javascript file \\"<file>\\"" -e "end timeout"\n');
  process.exit(2);
}
if (!MODES.has(mode)) {
  process.stderr.write(`fake-illustrator: unknown FAKE_AI_MODE ${mode}\n`);
  process.exit(2);
}
const unquote = (s) => s.replace(/\\(["\\])/g, '$1');
const appName = unquote(m[2]);
const harnessPath = unquote(m[3]);
say(`osascript asked "${appName}" to do javascript file ${path.basename(harnessPath)}`);
if (mode === 'no-run') { say('ran nothing (FAKE_AI_MODE=no-run)'); process.exit(0); }
if (mode === 'not-allowed') {
  process.stderr.write(`execution error: Not authorized to send Apple events to ${appName}. (-1743)\n`);
  process.exit(1);
}
if (mode === 'timeout') {
  process.stderr.write(`execution error: ${appName} got an error: AppleEvent timed out. (-1712)\n`);
  process.exit(1);
}
if (mode === 'syntax') {
  process.stderr.write('0:52: syntax error: Expected end of line, etc. but found identifier. (-2741)\n');
  process.exit(1);
}

// ── constants (their values are this fake's; the harness compares with the names) ───────────────────────────

const en = (name, keys) => Object.freeze(Object.fromEntries(keys.map((k) => [k, `${name}.${k}`])));
const DocumentColorSpace = en('DocumentColorSpace', ['RGB', 'CMYK']);
const UserInteractionLevel = en('UserInteractionLevel', ['DISPLAYALERTS', 'DONTDISPLAYALERTS']);
const SaveOptions = en('SaveOptions', ['DONOTSAVECHANGES', 'SAVECHANGES', 'PROMPTTOSAVECHANGES']);
const ExportType = en('ExportType', ['SVG', 'PNG24', 'PNG8', 'JPEG', 'TIFF', 'PHOTOSHOP', 'GIF', 'AUTOCAD', 'FLASH', 'WOSVG']);
const TextType = en('TextType', ['POINTTEXT', 'AREATEXT', 'PATHTEXT']);
const SVGFontSubsetting = en('SVGFontSubsetting', ['ALLGLYPHS', 'GLYPHSUSED', 'COMMONENGLISH', 'COMMONROMAN', 'GLYPHSUSEDPLUSENGLISH', 'GLYPHSUSEDPLUSROMAN', 'None']);
const SVGDocumentEncoding = en('SVGDocumentEncoding', ['ASCII', 'UTF8', 'UTF16']);
const CoordinateSystem = en('CoordinateSystem', ['DOCUMENTCOORDINATESYSTEM', 'ARTBOARDCOORDINATESYSTEM']);
const Justification = en('Justification', ['LEFT', 'CENTER', 'RIGHT', 'FULLJUSTIFY']);
const RulerUnits = en('RulerUnits', ['Points', 'Millimeters', 'Inches']);
const aiError = (s) => new Error(`Illustrator error: ${s} (FAKE)`);

class RGBColor { constructor() { this.red = 0; this.green = 0; this.blue = 0; } get typename() { return 'RGBColor'; } }
class NoColor { get typename() { return 'NoColor'; } }
class ExportOptionsSVG { constructor() { this.coordinatePrecision = 3; this.documentEncoding = SVGDocumentEncoding.ASCII; this.fontSubsetting = SVGFontSubsetting.ALLGLYPHS; this.preserveEditability = false; this.saveMultipleArtboards = false; this.embedRasterImages = false; } }
class ExportOptionsPNG24 { constructor() { this.artBoardClipping = false; this.horizontalScale = 100; this.verticalScale = 100; this.transparency = true; this.antiAliasing = true; this.saveAsHTML = false; } }
class IllustratorSaveOptions { constructor() { this.pdfCompatible = true; } }
class PDFSaveOptions { constructor() { this.preserveEditability = true; this.viewAfterSaving = false; } }

// ── files ───────────────────────────────────────────────────────────────────────────────────────────────────

class FakeFile {
  constructor(p) { this.fsName = path.resolve(String(p)); this.encoding = 'UTF-8'; this.lineFeed = 'Unix'; this.error = ''; this._mode = null; this._out = []; }
  get fullName() { return this.fsName; }
  get name() { return encodeURI(path.basename(this.fsName)); }
  get displayName() { return path.basename(this.fsName); }
  get exists() { try { return statSync(this.fsName).isFile(); } catch { return false; } }
  get length() { try { return statSync(this.fsName).size; } catch { return -1; } }
  get parent() { return new FakeFolder(path.dirname(this.fsName)); }
  open(m) {
    if (m === 'w' || m === 'a' || m === 'e') {
      if (mode === 'write-fail') { this.error = 'Permission denied (FAKE: FAKE_AI_MODE=write-fail)'; return false; }
      this._mode = 'w';
      this._out = [];
      return true;
    }
    if (m === 'r') {
      if (!this.exists) { this.error = 'File or folder does not exist'; return false; }
      this._mode = 'r';
      return true;
    }
    this.error = `unknown mode ${String(m)}`;
    return false;
  }
  read() {
    if (this._mode !== 'r') return '';
    const b = readFileSync(this.fsName);
    return this.encoding === 'BINARY' ? b.toString('latin1') : b.toString('utf8');
  }
  write(...parts) {
    if (this._mode !== 'w') { this.error = 'not open for writing'; return false; }
    this._out.push(parts.map(String).join(''));
    return true;
  }
  writeln(...parts) { return this.write(...parts, '\n'); }
  close() {
    if (this._mode === 'w') {
      const t = this._out.join('');
      try { writeFileSync(this.fsName, this.encoding === 'BINARY' ? Buffer.from(t, 'latin1') : Buffer.from(t, 'utf8')); } catch (e) { this.error = e.message; this._mode = null; return false; }
    }
    this._mode = null;
    return true;
  }
  remove() { try { unlinkSync(this.fsName); return true; } catch { return false; } }
}
class FakeFolder {
  constructor(p) { this.fsName = path.resolve(String(p)); }
  get exists() { try { return statSync(this.fsName).isDirectory(); } catch { return false; } }
  get name() { return encodeURI(path.basename(this.fsName)); }
  create() { try { mkdirSync(this.fsName, { recursive: true }); return true; } catch { return false; } }
  getFiles(mask) {
    let names = [];
    try { names = readdirSync(this.fsName); } catch { return []; }
    const glob = mask ? new RegExp(`^${String(mask).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`) : null;
    return names.filter((n) => !glob || glob.test(n)).map((n) => {
      const at = path.join(this.fsName, n);
      try { return statSync(at).isDirectory() ? new FakeFolder(at) : new FakeFile(at); } catch { return new FakeFile(at); }
    });
  }
}
function File(p) { return new FakeFile(p); }
File.prototype = FakeFile.prototype;
function Folder(p) { return new FakeFolder(p); }
Folder.prototype = FakeFolder.prototype;

// ── the document model ────────────────────────────────────────────────────────────────────────────────────

/** A collection as scripts see one: indexable, with a length and the given methods (a fresh array each time it is read). */
const coll = (items, methods = {}) => Object.assign([...items], methods, {
  getByName(n) { const it = items.find((x) => x.name === n); if (!it) throw aiError(`no item named ${n}`); return it; },
});
const colour = (c) => (c && c.typename === 'RGBColor' ? `#${[c.red, c.green, c.blue].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase()}` : null);

class PathItem {
  constructor(layer, g) {
    this._layer = layer; this._g = g; this.name = ''; this.closed = g.kind !== 'poly' || g.closed !== false;
    this.filled = true; this.stroked = true; this.fillColor = new RGBColor(); this.strokeColor = new RGBColor(); this.strokeWidth = 1;
    this.guides = false; this.clipping = false; this.hidden = false; this.opacity = 100;
  }
  get typename() { return 'PathItem'; }
  get layer() { return this._layer; }
  get parent() { return this._layer; }
  get pathPoints() {
    const g = this._g;
    const n = g.kind === 'poly' ? g.points.length : g.kind === 'rrect' ? 8 : 4;
    return coll(Array.from({ length: n }, () => ({ typename: 'PathPoint' })));
  }
  get geometricBounds() {
    const g = this._g;
    if (g.kind === 'poly') {
      const xs = g.points.map((p) => p[0]);
      const ys = g.points.map((p) => p[1]);
      return [Math.min(...xs), Math.max(...ys), Math.max(...xs), Math.min(...ys)];
    }
    return [g.left, g.top, g.left + g.width, g.top - g.height];
  }
  get visibleBounds() { const b = this.geometricBounds; const h = this.stroked ? this.strokeWidth / 2 : 0; return [b[0] - h, b[1] + h, b[2] + h, b[3] - h]; }
  get position() { const b = this.geometricBounds; return [b[0], b[1]]; }
  set position(p) { const b = this.geometricBounds; this.translate(p[0] - b[0], p[1] - b[1]); }
  get width() { const b = this.geometricBounds; return b[2] - b[0]; }
  get height() { const b = this.geometricBounds; return b[1] - b[3]; }
  get area() { return this.width * this.height; }
  translate(dx, dy) {
    const g = this._g;
    if (g.kind === 'poly') g.points = g.points.map(([x, y]) => [x + dx, y + dy]);
    else { g.left += dx; g.top += dy; }
  }
  setEntirePath(points) {
    if (!Array.isArray(points) || points.some((p) => !Array.isArray(p) || p.length < 2)) throw aiError('setEntirePath takes an array of [x, y] points');
    this._g = { kind: 'poly', points: points.map((p) => [Number(p[0]), Number(p[1])]), closed: this.closed };
  }
  remove() { this._layer._items = this._layer._items.filter((x) => x !== this); }
}

class TextFrame {
  constructor(layer, anchor) {
    this._layer = layer; this._anchor = [Number(anchor[0]), Number(anchor[1])]; this.contents = ''; this.name = ''; this.hidden = false; this.kind = TextType.POINTTEXT;
    this._size = 12; this._fill = new RGBColor(); this._just = Justification.LEFT;
    const self = this;
    this.textRange = { characterAttributes: { get size() { return self._size; }, set size(v) { self._size = Number(v); }, get fillColor() { return self._fill; }, set fillColor(v) { self._fill = v; }, textFont: { name: 'FakeSans' } } };
  }
  get typename() { return 'TextFrame'; }
  get layer() { return this._layer; }
  get parent() { return this._layer; }
  get anchor() { return [...this._anchor]; }
  get paragraphs() {
    const self = this;
    return coll([{ paragraphAttributes: { get justification() { return self._just; }, set justification(v) { self._just = v; } } }]);
  }
  /** This fake's own estimate (no fonts here): 0.6 of the size per character, the size tall. */
  get geometricBounds() {
    const w = 0.6 * this._size * String(this.contents).length;
    const left = this._just === Justification.CENTER ? this._anchor[0] - w / 2 : this._just === Justification.RIGHT ? this._anchor[0] - w : this._anchor[0];
    return [left, this._anchor[1] + 0.8 * this._size, left + w, this._anchor[1] - 0.2 * this._size];
  }
  get position() { const b = this.geometricBounds; return [b[0], b[1]]; }
  set position(p) { const b = this.geometricBounds; this._anchor = [this._anchor[0] + p[0] - b[0], this._anchor[1] + p[1] - b[1]]; }
  translate(dx, dy) { this._anchor = [this._anchor[0] + dx, this._anchor[1] + dy]; }
  remove() { this._layer._items = this._layer._items.filter((x) => x !== this); }
}

class Layer {
  constructor(doc, name) { this._doc = doc; this.name = name; this.visible = true; this.locked = false; this._items = []; }
  get typename() { return 'Layer'; }
  get parent() { return this._doc; }
  get layers() { return coll([]); }
  get pageItems() { return coll(this._items); }
  get pathItems() {
    const add = (g) => { const p = new PathItem(this, g); this._items.unshift(p); this._doc.saved = false; return p; };
    return coll(this._items.filter((x) => x instanceof PathItem), {
      rectangle: (top, left, width, height) => add({ kind: 'rect', top: Number(top), left: Number(left), width: Number(width), height: Number(height) }),
      roundedRectangle: (top, left, width, height, hr = 15, vr = 20) => add({ kind: 'rrect', top: Number(top), left: Number(left), width: Number(width), height: Number(height), hr: Number(hr), vr: Number(vr) }),
      ellipse: (top, left, width, height) => add({ kind: 'ellipse', top: Number(top), left: Number(left), width: Number(width), height: Number(height) }),
      polygon: (cx = 200, cy = 300, r = 50, sides = 8) => add({ kind: 'poly', closed: true, points: Array.from({ length: sides }, (_, k) => { const a = Math.PI / 2 + (2 * Math.PI * k) / sides; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }) }),
      star: (cx = 200, cy = 300, r = 50, ir = 20, points = 5) => add({ kind: 'poly', closed: true, points: Array.from({ length: 2 * points }, (_, k) => { const a = Math.PI / 2 + (Math.PI * k) / points; const rr = k % 2 ? ir : r; return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)]; }) }),
      add: () => add({ kind: 'poly', closed: true, points: [] }),
    });
  }
  get textFrames() {
    const add = (anchor) => { const t = new TextFrame(this, anchor); this._items.unshift(t); this._doc.saved = false; return t; };
    return coll(this._items.filter((x) => x instanceof TextFrame), { pointText: (anchor) => add(anchor), add: () => add([0, 0]) });
  }
  get compoundPathItems() { return coll([]); }
}

class Artboard {
  constructor(rect, name) { this._rect = rect; this.name = name; }
  get typename() { return 'Artboard'; }
  get artboardRect() { return [...this._rect]; }
  set artboardRect(r) {
    if (!Array.isArray(r) || r.length !== 4 || r.some((v) => typeof v !== 'number' || !Number.isFinite(v))) throw aiError('an artboard rect is [left, top, right, bottom]');
    if (!(r[2] > r[0]) || !(r[1] > r[3])) throw aiError('an artboard rect needs right > left and top > bottom');
    this._rect = [...r];
  }
}

const AI_HEAD = 'FAKE-AI 1 (written by tests/fixtures/fake-illustrator.mjs, a test double; not an Illustrator document)';

class Document {
  constructor(file = null) {
    this._path = file; this.saved = true; this.documentColorSpace = DocumentColorSpace.RGB; this.rulerUnits = RulerUnits.Points;
    this._artboards = [new Artboard([0, 0, 612, -792], 'Artboard 1')];
    this._layers = [new Layer(this, 'Layer 1')];
    this._active = 0;
  }
  get typename() { return 'Document'; }
  get name() { return this._path ? path.basename(this._path) : 'Untitled-1'; }
  get fullName() { if (!this._path) throw aiError('the document has not been saved'); return new FakeFile(this._path); }
  get path() { if (!this._path) throw aiError('the document has not been saved'); return new FakeFolder(path.dirname(this._path)); }
  get artboards() { return coll(this._artboards, { getActiveArtboardIndex: () => this._active, setActiveArtboardIndex: (k) => { this._active = k; } }); }
  get layers() { return coll(this._layers); }
  get activeLayer() { return this._layers[0]; }
  get pathItems() { const l = this._layers[0]; return coll(this._layers.flatMap((x) => x._items.filter((i) => i instanceof PathItem)), { rectangle: (...a) => l.pathItems.rectangle(...a), ellipse: (...a) => l.pathItems.ellipse(...a), polygon: (...a) => l.pathItems.polygon(...a), star: (...a) => l.pathItems.star(...a), roundedRectangle: (...a) => l.pathItems.roundedRectangle(...a), add: () => l.pathItems.add() }); }
  get textFrames() { const l = this._layers[0]; return coll(this._layers.flatMap((x) => x._items.filter((i) => i instanceof TextFrame)), { pointText: (a) => l.textFrames.pointText(a), add: () => l.textFrames.add() }); }
  get compoundPathItems() { return coll([]); }
  get groupItems() { return coll([]); }
  get rasterItems() { return coll([]); }
  get placedItems() { return coll([]); }
  get symbolItems() { return coll([]); }
  get meshItems() { return coll([]); }
  get pluginItems() { return coll([]); }
  get pageItems() { return coll(this._layers.flatMap((x) => x._items)); }

  _dump() {
    return {
      artboards: this._artboards.map((a) => ({ rect: a._rect, name: a.name })),
      layers: this._layers.map((l) => ({
        name: l.name, visible: l.visible, locked: l.locked,
        items: l._items.map((it) => (it instanceof PathItem
          ? { type: 'path', g: it._g, name: it.name, closed: it.closed, filled: it.filled, stroked: it.stroked, fill: colour(it.fillColor), stroke: colour(it.strokeColor), strokeWidth: it.strokeWidth, guides: it.guides, clipping: it.clipping, hidden: it.hidden }
          : { type: 'text', anchor: it._anchor, contents: it.contents, name: it.name, size: it._size, fill: colour(it._fill), just: it._just, hidden: it.hidden })),
      })),
    };
  }
  _writeAi(file) {
    try { if (!statSync(path.dirname(file)).isDirectory()) throw new Error(); } catch { throw aiError(`the folder for ${path.basename(file)} does not exist`); }
    writeFileSync(file, `${AI_HEAD}\n${JSON.stringify(this._dump())}\n`);
  }
  saveAs(file, options) {
    if (!(file instanceof FakeFile)) throw aiError('saveAs takes a File');
    if (options instanceof PDFSaveOptions) {
      writeFileSync(file.fsName, `%PDF-1.4\n% FAKE: written by tests/fixtures/fake-illustrator.mjs, a test double; not a PDF anyone can open\n%%EOF\n`);
    } else this._writeAi(file.fsName);
    this._path = file.fsName;
    this.saved = true;
  }
  save() {
    if (!this._path) throw new Error('fake-illustrator: save() of a document never saved would ask a person for a name (FAKE)');
    this._writeAi(this._path);
    this.saved = true;
  }
  exportFile(file, type, options) {
    if (!(file instanceof FakeFile)) throw aiError('exportFile takes a File');
    const ext = type === ExportType.SVG ? '.svg' : type === ExportType.PNG24 ? '.png' : null;
    if (!ext) throw aiError(`this fake exports SVG and PNG24 only, not ${type}`);
    let at = file.fsName;
    if (mode === 'double-ext' || !at.toLowerCase().endsWith(ext)) at += ext;
    if (type === ExportType.SVG) writeFileSync(at, renderSvg(this, options ?? new ExportOptionsSVG()));
    else writeFileSync(at, renderPng(this, options ?? new ExportOptionsPNG24()));
  }
  close(how) {
    if (how === SaveOptions.SAVECHANGES) this.save();
    app._docs = app._docs.filter((d) => d !== this);
    return true;
  }
}

function readDocument(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { throw aiError(`can not open "${path.basename(file)}"`); }
  if (!text.startsWith(AI_HEAD.slice(0, 8))) throw aiError(`"${path.basename(file)}" is not a document this fake can read: it opens only the FAKE documents it saved`);
  const data = JSON.parse(text.slice(text.indexOf('\n') + 1));
  const d = new Document(file);
  d._artboards = data.artboards.map((a) => new Artboard(a.rect, a.name));
  d._layers = data.layers.map((l) => {
    const layer = new Layer(d, l.name);
    layer.visible = l.visible; layer.locked = l.locked;
    layer._items = l.items.map((it) => {
      if (it.type === 'path') {
        const p = new PathItem(layer, it.g);
        Object.assign(p, { name: it.name, closed: it.closed, filled: it.filled, stroked: it.stroked, strokeWidth: it.strokeWidth, guides: it.guides, clipping: it.clipping, hidden: it.hidden });
        p.fillColor = hexColour(it.fill); p.strokeColor = hexColour(it.stroke);
        return p;
      }
      const t = new TextFrame(layer, it.anchor);
      Object.assign(t, { contents: it.contents, name: it.name, hidden: it.hidden });
      t._size = it.size; t._fill = hexColour(it.fill); t._just = it.just;
      return t;
    });
    return layer;
  });
  d.saved = true;
  return d;
}
function hexColour(h) {
  const c = new RGBColor();
  if (typeof h === 'string' && /^#[0-9A-F]{6}$/i.test(h)) { c.red = parseInt(h.slice(1, 3), 16); c.green = parseInt(h.slice(3, 5), 16); c.blue = parseInt(h.slice(5, 7), 16); }
  return c;
}

// ── what it writes: an SVG of its own guess, a PNG of the artboard's size ─────────────────────────────────────

function renderSvg(doc, o) {
  const P = Number.isInteger(o.coordinatePrecision) && o.coordinatePrecision >= 1 && o.coordinatePrecision <= 7 ? o.coordinatePrecision : 3;
  const f = (n) => { const s = String(Number(n.toFixed(P))); return s === '-0' ? '0' : s; };
  const ab = doc._artboards[doc._active]._rect;
  const W = ab[2] - ab[0];
  const H = ab[1] - ab[3];
  const X = (x) => x - ab[0];
  const Y = (y) => ab[1] - y;
  const ascii = o.documentEncoding !== SVGDocumentEncoding.UTF8;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[^\x00-\x7e]/gu, (c) => (ascii ? `&#x${c.codePointAt(0).toString(16).toUpperCase()};` : c));
  const styles = [];
  const cls = (decl) => { let k = styles.indexOf(decl); if (k < 0) { styles.push(decl); k = styles.length - 1; } return `st${k}`; };
  const shapeStyle = (it) => cls(`fill:${it.filled ? colour(it.fillColor) ?? '#000000' : 'none'};${it.stroked ? `stroke:${colour(it.strokeColor) ?? '#000000'};stroke-width:${f(it.strokeWidth)};` : ''}`);
  const out = [];
  const multi = doc._layers.length > 1;
  for (const layer of [...doc._layers].reverse()) {
    const items = [...layer._items].reverse(); // paint order: bottom first
    // svg-differs: the topmost shape of the top layer is left out
    const topShape = mode === 'svg-differs' && layer === doc._layers[0] ? [...items].reverse().find((x) => x instanceof PathItem) : undefined;
    const shown = items.filter((x) => x !== topShape);
    const body = [];
    for (const it of shown) {
      const hid = it.hidden ? ' style="display:none;"' : '';
      if (it instanceof TextFrame) {
        const anchor = it._just === Justification.CENTER ? ' text-anchor="middle"' : it._just === Justification.RIGHT ? ' text-anchor="end"' : '';
        const parts = String(it.contents).split(/\r\n|\r|\n/);
        const inner = parts.length === 1 ? esc(parts[0]) : parts.map((p, k) => `<tspan x="0" y="${f(k * it._size * 1.2)}">${esc(p)}</tspan>`).join('');
        body.push(`<text transform="matrix(1 0 0 1 ${f(X(it._anchor[0]))} ${f(Y(it._anchor[1]))})" class="${cls(`fill:${colour(it._fill) ?? '#000000'};`)} ${cls(`font-family:'FakeSans';font-size:${f(it._size)}px;`)}"${anchor}${hid}>${inner}</text>`);
        continue;
      }
      if (it.guides) continue; // guides are not exported
      const g = it._g;
      const c = shapeStyle(it);
      if (g.kind === 'rect') body.push(`<rect x="${f(X(g.left))}" y="${f(Y(g.top))}" class="${c}" width="${f(g.width)}" height="${f(g.height)}"${hid}/>`);
      else if (g.kind === 'ellipse') {
        const cx = f(X(g.left + g.width / 2));
        const cy = f(Y(g.top - g.height / 2));
        body.push(g.width === g.height ? `<circle class="${c}" cx="${cx}" cy="${cy}" r="${f(g.width / 2)}"${hid}/>` : `<ellipse class="${c}" cx="${cx}" cy="${cy}" rx="${f(g.width / 2)}" ry="${f(g.height / 2)}"${hid}/>`);
      } else if (g.kind === 'rrect') {
        // Corners as cubic curves, in relative commands: the reader's relative chain and curve extremes are exercised.
        const k = 0.5523;
        const x0 = X(g.left); const y0 = Y(g.top); const w = g.width; const h = g.height; const rx = Math.min(g.hr, w / 2); const ry = Math.min(g.vr, h / 2);
        const d = `M${f(x0 + rx)},${f(y0)}h${f(w - 2 * rx)}c${f(rx * k)},0,${f(rx)},${f(ry * (1 - k))},${f(rx)},${f(ry)}v${f(h - 2 * ry)}c0,${f(ry * k)},${f(-rx * (1 - k))},${f(ry)},${f(-rx)},${f(ry)}h${f(-(w - 2 * rx))}c${f(-rx * k)},0,${f(-rx)},${f(-ry * (1 - k))},${f(-rx)},${f(-ry)}v${f(-(h - 2 * ry))}c0,${f(-ry * k)},${f(rx * (1 - k))},${f(-ry)},${f(rx)},${f(-ry)}z`;
        body.push(`<path class="${c}" d="${d}"${hid}/>`);
      } else {
        const pts = g.points.map(([x, y]) => `${f(X(x))},${f(Y(y))}`);
        if (it.closed) body.push(`<polygon class="${c}" points="${pts.join(' ')}"${hid}/>`);
        else if (g.points.length === 2) body.push(`<line class="${c}" x1="${f(X(g.points[0][0]))}" y1="${f(Y(g.points[0][1]))}" x2="${f(X(g.points[1][0]))}" y2="${f(Y(g.points[1][1]))}"${hid}/>`);
        else body.push(`<polyline class="${c}" points="${pts.join(' ')}"${hid}/>`);
      }
    }
    if (multi) out.push(`<g id="${esc(layer.name).replace(/"/g, '&quot;')}"${layer.visible ? '' : ' style="display:none;"'}>`, ...body, '</g>');
    else out.push(...body);
  }
  return [
    `<?xml version="1.0" encoding="${ascii ? 'iso-8859-1' : 'utf-8'}"?>`,
    '<!-- Generator: fake-illustrator.mjs (FAKE Adobe Illustrator, a test double; not Illustrator\'s output)  -->',
    `<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px"`,
    `\t width="${f(W)}px" height="${f(H)}px" viewBox="0 0 ${f(W)} ${f(H)}" style="enable-background:new 0 0 ${f(W)} ${f(H)};" xml:space="preserve">`,
    '<style type="text/css">',
    ...styles.map((s, k) => `\t.st${k}{${s}}`),
    '</style>',
    ...out,
    '</svg>',
    '',
  ].join('\n');
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return (buf) => { let c = 0xffffffff; for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
})();
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(td));
  return Buffer.concat([len, td, crc]);
}
/** A real PNG, one colour, of the artboard's size at the export's scale (one pixel per point at 100 %). */
function renderPng(doc, o) {
  const ab = doc._artboards[doc._active]._rect;
  const w = Math.max(1, Math.round(((ab[2] - ab[0]) * (o.horizontalScale ?? 100)) / 100));
  const h = Math.max(1, Math.round(((ab[1] - ab[3]) * (o.verticalScale ?? 100)) / 100));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.alloc(1 + w * 3, 0x12); row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ── the application ────────────────────────────────────────────────────────────────────────────────────────

const violation = (what) => () => {
  process.stderr.write(`fake-illustrator (FAKE Adobe Illustrator): VIOLATION: the script called ${what}; Timmy's harness must never change a preference\n`);
  process.exit(4);
};
const INITIAL_LEVEL = UserInteractionLevel.DISPLAYALERTS;
const app = {
  version: '30.0.0 (FAKE)',
  userInteractionLevel: INITIAL_LEVEL,
  coordinateSystem: CoordinateSystem.ARTBOARDCOORDINATESYSTEM,
  _docs: [],
  get documents() {
    return coll(this._docs, {
      add: (space = DocumentColorSpace.RGB, width, height) => {
        const d = new Document();
        d.documentColorSpace = space;
        if (typeof width === 'number' && typeof height === 'number') d._artboards = [new Artboard([0, 0, width, -height], 'Artboard 1')];
        d.saved = false;
        this._docs.unshift(d);
        return d;
      },
    });
  },
  get activeDocument() { if (!this._docs.length) throw aiError('there is no document'); return this._docs[0]; },
  open(file) {
    const f = file instanceof FakeFile ? file : new FakeFile(file);
    const already = this._docs.find((d) => d._path === f.fsName);
    if (already) return already;
    const d = readDocument(f.fsName);
    this._docs.unshift(d);
    return d;
  },
  preferences: {
    setBooleanPreference: violation('app.preferences.setBooleanPreference'),
    setIntegerPreference: violation('app.preferences.setIntegerPreference'),
    setRealPreference: violation('app.preferences.setRealPreference'),
    setStringPreference: violation('app.preferences.setStringPreference'),
    removePreference: violation('app.preferences.removePreference'),
  },
};

if (mode === 'open-doc') {
  // The document the run is to open (edit, inspect) or save (author), already open in this Illustrator.
  const cfg = /^\/\* timmy-illustrator-config \*\/ (\{.*\})$/m.exec(readFileSync(harnessPath, 'utf8'));
  const c = cfg ? JSON.parse(cfg[1]) : {};
  const target = c.open ?? c.save;
  if (target) {
    let d;
    try { d = readDocument(target); } catch { d = new Document(target); }
    d.saved = false;
    app._docs.push(d);
    say(`${path.basename(target)} is open in it, with unsaved changes (FAKE_AI_MODE=open-doc)`);
  }
}

const sandbox = {
  app, File, Folder, RGBColor, NoColor, ExportOptionsSVG, ExportOptionsPNG24, IllustratorSaveOptions, PDFSaveOptions,
  DocumentColorSpace, UserInteractionLevel, SaveOptions, ExportType, TextType, SVGFontSubsetting, SVGDocumentEncoding, CoordinateSystem, Justification, RulerUnits,
};
if (mode === 'no-png') delete sandbox.ExportOptionsPNG24;
const context = vm.createContext(sandbox);
const $ = {
  fileName: path.resolve(harnessPath),
  global: vm.runInContext('this', context),
  writeln() {},
  write() {},
  evalFile(file) {
    const at = typeof file === 'string' ? path.resolve(file) : file.fsName;
    const text = readFileSync(at, 'utf8');
    try { return vm.runInContext(text, context, { filename: at }); } catch (e) {
      // ExtendScript gives an error from $.evalFile its line; the stand-in takes it from the stack.
      const escaped = at.replace(/[.*+?^$()|[\]\\{}]/g, (ch) => `\\${ch}`);
      const ln = e && typeof e.stack === 'string' ? new RegExp(`${escaped}:(\\d+)`).exec(e.stack) : null;
      if (ln && e && typeof e === 'object') e.line = Number(ln[1]);
      throw e;
    }
  },
};
context.$ = $;

let value;
try {
  value = vm.runInContext(readFileSync(harnessPath, 'utf8'), context, { filename: harnessPath, timeout: 30_000 });
} catch (e) {
  process.stderr.write(`fake-illustrator (FAKE Adobe Illustrator): the harness itself did not run, as Illustrator would show in an error dialog: ${e && e.stack ? e.stack : e}\n`);
  process.exit(3);
}
if (app.userInteractionLevel !== INITIAL_LEVEL) {
  process.stderr.write(`fake-illustrator (FAKE Adobe Illustrator): VIOLATION: the alert level was left at ${app.userInteractionLevel}, not put back to ${INITIAL_LEVEL}\n`);
  process.exit(4);
}
if (mode === 'vanish-ai') {
  const cfg = /^\/\* timmy-illustrator-config \*\/ (\{.*\})$/m.exec(readFileSync(harnessPath, 'utf8'));
  const save = cfg ? JSON.parse(cfg[1]).save : null;
  if (save) { try { unlinkSync(save); } catch { /* not there */ } }
  say('deleted the document it saved (FAKE_AI_MODE=vanish-ai)');
}
say(`${app._docs.length} document${app._docs.length === 1 ? '' : 's'} left open`);
// osascript prints the result of do javascript.
process.stdout.write(`${String(value)}\n`);
process.exit(0);
