#!/usr/bin/env node
// fake-afterfx.mjs: a TEST DOUBLE of After Effects, for tests/native-ae-author.test.ts. It is NOT After Effects:
// it renders nothing, and the "projects" it saves are not .aep files. It stands in for the two ways Timmy has
// After Effects run a script:
//   osascript -e 'with timeout of N seconds' -e 'tell application "<app>" to DoScriptFile "<harness.jsx>"' -e 'end timeout'
//   <After Effects program> -r <harness.jsx>
// It runs the harness (plain ES3 JavaScript) in a Node vm against a small stand-in of After Effects' scripting
// objects (app, app.project, items.addComp, layers.addSolid/addText/addNull, properties and keyframes,
// TextDocument, File, Folder, $.evalFile), so the harness Timmy generates and the starter scripts really run here.
// A project it saves is a FAKE .aep: a first line naming this fake, then JSON of the stand-in project, which its
// app.open reads back (and nothing else). On the osascript route it prints the harness's return value, as osascript
// prints DoScriptFile's result; its own lines start "fake-afterfx (FAKE After Effects)".
// FAKE_AE_MODE picks what it does:
//   ok              (the default) runs the harness
//   write-pref-off  the write preference reads 0 and every file opened for writing fails
//   no-run          runs nothing and exits 0 (After Effects never ran the script)
//   crash           runs nothing, prints an osascript error (AppleEvent timed out, -1712) and exits 1
//   not-allowed     runs nothing, prints osascript's refusal to control the app (-1743) and exits 1
//   save-noop       app.project.save answers true and writes nothing
//   vanish-aep      runs the harness, then deletes the project it saved
//   dirty           the project open before the run has unsaved changes
// An unknown mode, or a command line that is neither route, exits 2. A harness that will not run exits 3.
// Changing a preference is a violation: it is printed to stderr and the fake exits 4.
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const MODES = new Set(['ok', 'write-pref-off', 'no-run', 'crash', 'not-allowed', 'save-noop', 'vanish-aep', 'dirty']);
const mode = process.env.FAKE_AE_MODE || 'ok';
const say = (s) => process.stdout.write(`fake-afterfx (FAKE After Effects): ${s}\n`);
const argv = process.argv.slice(2);

let route;
let harnessPath;
let appName;
if (argv[0] === '-r' && argv[1]) {
  route = 'binary';
  harnessPath = argv[1];
} else if (argv.includes('-e')) {
  route = 'osascript';
  const lines = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '-e') lines.push(argv[++i] ?? '');
  const m = /^with timeout of (\d+) seconds\ntell application "((?:[^"\\]|\\.)*)" to DoScriptFile "((?:[^"\\]|\\.)*)"\nend timeout$/.exec(lines.join('\n'));
  if (!m) {
    process.stderr.write('fake-afterfx: expected -e "with timeout of N seconds" -e "tell application \\"<app>\\" to DoScriptFile \\"<file>\\"" -e "end timeout"\n');
    process.exit(2);
  }
  const unquote = (s) => s.replace(/\\(["\\])/g, '$1');
  appName = unquote(m[2]);
  harnessPath = unquote(m[3]);
} else {
  process.stderr.write('fake-afterfx: expected osascript arguments or -r <script>\n');
  process.exit(2);
}
if (!MODES.has(mode)) {
  process.stderr.write(`fake-afterfx: unknown FAKE_AE_MODE ${mode}\n`);
  process.exit(2);
}
say(route === 'osascript' ? `osascript asked "${appName}" to DoScriptFile ${path.basename(harnessPath)}` : `started with -r ${path.basename(harnessPath)}`);
if (mode === 'no-run') { say('ran nothing (FAKE_AE_MODE=no-run)'); process.exit(0); }
if (mode === 'crash') {
  process.stderr.write(`execution error: ${appName ?? 'After Effects'} got an error: AppleEvent timed out. (-1712) (fake-afterfx, FAKE)\n`);
  process.exit(1);
}
if (mode === 'not-allowed') {
  process.stderr.write(`execution error: Not authorized to send Apple events to ${appName ?? 'After Effects'}. (-1743) (fake-afterfx, FAKE)\n`);
  process.exit(1);
}

// ── the stand-in object model ────────────────────────────────────────────────────

const PropertyType = Object.freeze({ PROPERTY: 6212, NAMED_GROUP: 6213, INDEXED_GROUP: 6214 });
const CloseOptions = Object.freeze({ DO_NOT_SAVE_CHANGES: 1, PROMPT_TO_SAVE_CHANGES: 2, SAVE_CHANGES: 3 });
const ParagraphJustification = Object.freeze({ LEFT_JUSTIFY: 7413, RIGHT_JUSTIFY: 7414, CENTER_JUSTIFY: 7415 });
const aeError = (s) => new Error(`After Effects error: ${s} (FAKE)`);

class TextDocument {
  constructor(text = '') {
    this.text = String(text);
    this.fontSize = 36;
    this.applyFill = true;
    this.fillColor = [1, 1, 1];
    this.font = 'FakeSans';
    this.justification = ParagraphJustification.LEFT_JUSTIFY;
  }
}
const copy = (v) => (v instanceof TextDocument ? Object.assign(new TextDocument(v.text), v) : Array.isArray(v) ? [...v] : v);

class Property {
  constructor(name, matchName, value) { this.name = name; this.matchName = matchName; this._value = value; this._keys = []; }
  get propertyType() { return PropertyType.PROPERTY; }
  get numKeys() { return this._keys.length; }
  get value() { return copy(this._keys.length ? this._keys[0].v : this._value); }
  setValue(v) {
    if (this._keys.length) throw aeError(`can not set a value without a time on ${this.name}, which has keyframes`);
    this._value = copy(v);
  }
  setValueAtTime(t, v) {
    if (typeof t !== 'number' || !Number.isFinite(t)) throw aeError('a keyframe time must be a number');
    const at = this._keys.findIndex((k) => k.t === t);
    if (at >= 0) this._keys[at].v = copy(v);
    else { this._keys.push({ t, v: copy(v) }); this._keys.sort((a, b) => a.t - b.t); }
  }
  keyTime(i) { return this._keys[i - 1].t; }
  keyValue(i) { return copy(this._keys[i - 1].v); }
}

class Group {
  constructor(name, matchName, children = []) { this.name = name; this.matchName = matchName; this._children = children; }
  get propertyType() { return PropertyType.NAMED_GROUP; }
  get numProperties() { return this._children.length; }
  property(k) {
    if (typeof k === 'number') {
      const c = this._children[k - 1];
      if (!c) throw aeError(`no property at index ${k} of ${this.name}`);
      return c;
    }
    return this._children.find((c) => c.name === k || c.matchName === k) ?? null;
  }
}

const transformGroup = (w, h, cw, ch) => new Group('Transform', 'ADBE Transform Group', [
  new Property('Anchor Point', 'ADBE Anchor Point', [w / 2, h / 2, 0]),
  new Property('Position', 'ADBE Position', [cw / 2, ch / 2, 0]),
  new Property('Scale', 'ADBE Scale', [100, 100, 100]),
  new Property('Rotation', 'ADBE Rotate Z', 0),
  new Property('Opacity', 'ADBE Opacity', 100),
]);

class SolidSource { constructor(color) { this.color = [...color]; } }
class FootageItem { constructor(name, w, h, main) { this.name = name; this.width = w; this.height = h; this.mainSource = main; } }
class FolderItem { constructor(name) { this.name = name; } }

class Layer extends Group {
  constructor(comp, name, matchName) { super(name, matchName); this._comp = comp; this.enabled = true; this.nullLayer = false; this.adjustmentLayer = false; this.source = null; }
  get index() { return this._comp._layers.indexOf(this) + 1; }
  get containingComp() { return this._comp; }
  get transform() { return this.property('ADBE Transform Group'); }
}
class AVLayer extends Layer {}
class TextLayer extends AVLayer {}
class ShapeLayer extends AVLayer {}
class CameraLayer extends Layer {}
class LightLayer extends Layer {}

const inRange = (v, lo, hi, what) => { if (typeof v !== 'number' || !(v >= lo && v <= hi)) throw aeError(`${what} ${String(v)} is out of range`); };

class LayerCollection {
  constructor(comp) { this._comp = comp; }
  get length() { return this._comp._layers.length; }
  addSolid(color, name, w, h, pixelAspect, duration) {
    if (!Array.isArray(color) || color.length !== 3) throw aeError('a solid colour is [r, g, b]');
    inRange(w, 4, 30000, 'width'); inRange(h, 4, 30000, 'height'); inRange(pixelAspect, 0.01, 100, 'pixel aspect');
    if (duration !== undefined) inRange(duration, 0, 10800, 'duration');
    const c = this._comp;
    const src = new FootageItem(String(name), w, h, new SolidSource(color));
    c._project._items.push(src);
    const l = new AVLayer(c, String(name), 'ADBE AV Layer');
    l.source = src;
    l._children = [new Group('Masks', 'ADBE Mask Parade'), new Group('Effects', 'ADBE Effect Parade'), transformGroup(w, h, c.width, c.height)];
    c._layers.unshift(l);
    return l;
  }
  addText(t) {
    const c = this._comp;
    const doc = t instanceof TextDocument ? copy(t) : new TextDocument(t === undefined ? '' : t);
    const l = new TextLayer(c, doc.text, 'ADBE Text Layer');
    l._children = [new Group('Text', 'ADBE Text Properties', [new Property('Source Text', 'ADBE Text Document', doc)]), new Group('Effects', 'ADBE Effect Parade'), transformGroup(0, 0, c.width, c.height)];
    c._layers.unshift(l);
    return l;
  }
  addNull(duration) {
    if (duration !== undefined) inRange(duration, 0, 10800, 'duration');
    const c = this._comp;
    const l = new AVLayer(c, 'Null 1', 'ADBE AV Layer');
    l.nullLayer = true;
    l._children = [new Group('Effects', 'ADBE Effect Parade'), transformGroup(100, 100, c.width, c.height)];
    c._layers.unshift(l);
    return l;
  }
}

class CompItem {
  constructor(project, name, w, h, pixelAspect, duration, frameRate) {
    this._project = project; this.name = name; this.width = w; this.height = h; this.pixelAspect = pixelAspect; this.duration = duration; this.frameRate = frameRate;
    this._layers = [];
    this.layers = new LayerCollection(this);
  }
  get numLayers() { return this._layers.length; }
  layer(k) {
    if (typeof k === 'number') {
      const l = this._layers[k - 1];
      if (!l) throw aeError(`no layer ${k} in ${this.name}`);
      return l;
    }
    return this._layers.find((l) => l.name === k) ?? null;
  }
  openInViewer() { return null; }
}

class ItemCollection {
  constructor(project) { this._project = project; }
  get length() { return this._project._items.length; }
  addComp(name, w, h, pixelAspect, duration, frameRate) {
    if (typeof name !== 'string') throw aeError('a comp name is a string');
    inRange(w, 4, 30000, 'width'); inRange(h, 4, 30000, 'height'); inRange(pixelAspect, 0.01, 100, 'pixel aspect');
    inRange(duration, 0, 10800, 'duration'); inRange(frameRate, 1, 999, 'frame rate');
    const c = new CompItem(this._project, name, w, h, pixelAspect, duration, frameRate);
    this._project._items.push(c);
    this._project.dirty = true;
    return c;
  }
}

const AEP_HEAD = 'FAKE-AEP 1 (written by tests/fixtures/fake-afterfx.mjs, a test double; not an After Effects project)';

function dumpProps(g, prefix, out) {
  for (const c of g._children) {
    const at = prefix ? `${prefix}/${c.matchName}` : c.matchName;
    if (c instanceof Property) out.push({ at, value: c._value instanceof TextDocument ? { textDocument: { ...c._value } } : c._value, keys: c._keys });
    else dumpProps(c, at, out);
  }
  return out;
}
function findProp(g, at) {
  let cur = g;
  for (const part of at.split('/')) { cur = cur?._children?.find((c) => c.matchName === part); if (!cur) return null; }
  return cur;
}

class Project {
  constructor(file = null) { this.file = file; this.dirty = false; this._items = []; this.items = new ItemCollection(this); }
  get numItems() { return this._items.length; }
  item(i) {
    const it = this._items[i - 1];
    if (!it) throw aeError(`no item at index ${i}`);
    return it;
  }
  save(file) {
    const target = file ?? this.file;
    if (!target) throw new Error('fake-afterfx: save() with no file would open a Save dialog in After Effects (FAKE)');
    if (mode === 'save-noop') { this.file = target; this.dirty = false; return true; }
    try { if (!statSync(path.dirname(target.fsName)).isDirectory()) throw new Error(); } catch { throw aeError(`the folder for ${path.basename(target.fsName)} does not exist`); }
    const comps = this._items.filter((i) => i instanceof CompItem).map((c) => ({
      name: c.name, width: c.width, height: c.height, pixelAspect: c.pixelAspect, duration: c.duration, frameRate: c.frameRate,
      layers: c._layers.map((l) => ({
        kind: l instanceof TextLayer ? 'text' : l.nullLayer ? 'null' : 'solid', name: l.name,
        solid: l.source ? { color: l.source.mainSource.color, width: l.source.width, height: l.source.height } : null,
        props: dumpProps(l, '', []),
      })),
    }));
    writeFileSync(target.fsName, `${AEP_HEAD}\n${JSON.stringify({ comps })}\n`);
    this.file = target;
    this.dirty = false;
    return true;
  }
  close() { app.project = new Project(); return true; }
}

function readProject(file) {
  let text;
  try { text = readFileSync(file.fsName, 'utf8'); } catch { throw aeError(`can not open "${path.basename(file.fsName)}"`); }
  if (!text.startsWith(AEP_HEAD.slice(0, 10))) throw aeError(`"${path.basename(file.fsName)}" is not a project this fake can read: it opens only the FAKE projects it saved`);
  const data = JSON.parse(text.slice(text.indexOf('\n') + 1));
  const p = new Project(file);
  for (const c of data.comps) {
    const comp = p.items.addComp(c.name, c.width, c.height, c.pixelAspect, c.duration, c.frameRate);
    for (const l of [...c.layers].reverse()) {
      const layer = l.kind === 'text' ? comp.layers.addText('') : l.kind === 'null' ? comp.layers.addNull() : comp.layers.addSolid(l.solid.color, l.name, l.solid.width, l.solid.height, 1);
      layer.name = l.name;
      for (const saved of l.props) {
        const prop = findProp(layer, saved.at);
        if (!prop) continue;
        prop._value = saved.value && saved.value.textDocument ? Object.assign(new TextDocument(), saved.value.textDocument) : saved.value;
        prop._keys = saved.keys;
      }
    }
  }
  p.dirty = false;
  return p;
}

class FakeFile {
  constructor(p) { this.fsName = path.resolve(String(p)); this.encoding = 'UTF-8'; this.lineFeed = 'Unix'; this.error = ''; this._mode = null; this._out = []; }
  get fullName() { return this.fsName; }
  get name() { return path.basename(this.fsName); }
  get exists() { try { return statSync(this.fsName).isFile(); } catch { return false; } }
  get length() { try { return statSync(this.fsName).size; } catch { return -1; } }
  get parent() { return new FakeFolder(path.dirname(this.fsName)); }
  open(m) {
    if (m === 'w' || m === 'a' || m === 'e') {
      if (mode === 'write-pref-off') { this.error = 'Permission denied (FAKE: "Allow Scripts to Write Files and Access Network" is off)'; return false; }
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
  create() { try { mkdirSync(this.fsName, { recursive: true }); return true; } catch { return false; } }
}
function File(p) { return new FakeFile(p); }
function Folder(p) { return new FakeFolder(p); }

const violation = (what) => () => {
  process.stderr.write(`fake-afterfx (FAKE After Effects): VIOLATION: the script called ${what}; Timmy's harness must never change a preference\n`);
  process.exit(4);
};
const initial = new Project();
if (mode === 'dirty') { initial.items.addComp('Unsaved work', 1280, 720, 1, 5, 25); initial.dirty = true; }
const app = {
  version: '25.0x1 (FAKE)',
  project: initial,
  preferences: {
    getPrefAsLong(section, key) {
      if (section !== 'Main Pref Section' || key !== 'Pref_SCRIPTING_FILE_NETWORK_SECURITY') throw aeError('no such preference');
      return mode === 'write-pref-off' ? 0 : 1;
    },
    setPrefAsLong: violation('app.preferences.setPrefAsLong'),
    savePrefAsLong: violation('app.preferences.savePrefAsLong'),
    saveToDisk: violation('app.preferences.saveToDisk'),
  },
  beginSuppressDialogs() { this._suppressed = true; },
  endSuppressDialogs() { this._suppressed = false; },
  newProject() {
    if (this.project.dirty) throw new Error('fake-afterfx: newProject() with unsaved changes would ask a person to save them (FAKE)');
    this.project = new Project();
    return this.project;
  },
  open(file) {
    if (this.project.dirty) throw new Error('fake-afterfx: open() with unsaved changes would ask a person to save them (FAKE)');
    this.project = readProject(file instanceof FakeFile ? file : new FakeFile(file));
    return this.project;
  },
};

const context = vm.createContext({
  app, File, Folder, TextDocument, PropertyType, CloseOptions, ParagraphJustification,
  CompItem, FootageItem, FolderItem, SolidSource, AVLayer, TextLayer, ShapeLayer, CameraLayer, LightLayer,
});
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
      const escaped = at.replace(/[.*+?^$()|[\]\\{}]/g, (c) => `\\${c}`);
      const m = e && typeof e.stack === 'string' ? new RegExp(`${escaped}:(\\d+)`).exec(e.stack) : null;
      if (m && e && typeof e === 'object') e.line = Number(m[1]);
      throw e;
    }
  },
};
context.$ = $;

let value;
try {
  value = vm.runInContext(readFileSync(harnessPath, 'utf8'), context, { filename: harnessPath, timeout: 30_000 });
} catch (e) {
  process.stderr.write(`fake-afterfx (FAKE After Effects): the harness itself did not run, as After Effects would show in an error dialog: ${e && e.stack ? e.stack : e}\n`);
  process.exit(3);
}
if (mode === 'vanish-aep') {
  const m = /^\/\* timmy-ae-config \*\/ (\{.*\})$/m.exec(readFileSync(harnessPath, 'utf8'));
  const save = m ? JSON.parse(m[1]).save : null;
  if (save) { try { unlinkSync(save); } catch { /* not there */ } }
  say('deleted the project it saved (FAKE_AE_MODE=vanish-aep)');
}
// osascript prints the result of DoScriptFile; the -r route has no such channel.
if (route === 'osascript') process.stdout.write(`${String(value)}\n`);
process.exit(0);
