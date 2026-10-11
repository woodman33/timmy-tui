/**
 * Adobe Illustrator authoring, editing and reading back as Timmy jobs (round R4, helper H64), on the pattern of After
 * Effects' (src/native/ae-author.ts). Illustrator is scripted (ExtendScript, .jsx) only through the application itself, and
 * Timmy asks it from the command line through osascript, on macOS, with Adobe's AppleScript command "do javascript":
 *
 *   osascript -e 'with timeout of N seconds' -e 'tell application "Adobe Illustrator" to do javascript file "<harness.jsx>"' -e 'end timeout'
 *
 * (illustratorOsascriptArgs below is the one place that sentence is written.) Illustrator starts, or comes forward, and its
 * window opens. macOS may first ask whether the app Timmy runs in may control Illustrator (Privacy & Security ›
 * Automation): that is the operator's to answer; Timmy never grants it, never changes it and never opens System Settings.
 * When osascript reports it was not allowed (-1743), the run says exactly that and how the operator grants it.
 *
 * Each run keeps its own folder, .timmy/native/<run>/ (the native module's record: job.json, started.json, verdicts.jsonl),
 * and this module adds to it:
 *   harness.jsx       generated for this run, read-only, its sha256 recorded. It makes a new document (author), or opens
 *                     the one given and at once saves it as a new version (edit), or opens it only to read it (inspect);
 *                     runs the script inside try/catch; saves; exports SVG and PDF (and PNG when Illustrator's export
 *                     options allow it); reads the document back (artboards, layers, path items with their bounds, text
 *                     frames' contents); closes what it made or opened; and writes result.json. It never touches a
 *                     document that is already open in Illustrator, never saves over the document it was given, and sets
 *                     Illustrator's alert level only for the run, putting it back as it was.
 *   script.*          the script as submitted, copied byte for byte, read-only: the copy is what runs, and the harness
 *                     hashes it as Illustrator reads it (script_sha256_read).
 *   illustrator.json  this module's record of the run: mode, the harness's and the inputs' sha256, the files it will write.
 *   inspect.svg       inspect only: the SVG Illustrator exported of the document it read, for Timmy's own reading.
 *
 * Judged first by the native module's own rules (judgeNativeJob: the result is this run's, echoes the input's sha256 as
 * submitted and says ok; the .ai, .svg and .pdf were created during this run, not reused), then here: the harness is
 * unchanged, the saved document is the one this run was to write (every file's sha256 computed by Timmy after the run),
 * and a document given to edit or inspect is byte for byte as it was. What the result says of artboards, layers, paths
 * and texts is Illustrator's own report of its own document. Beside it, Timmy reads the exported SVG itself
 * (src/native/svg-readback.ts) and compares: the artboard's size, the number of shapes, the texts and the shapes'
 * bounds agree, or differ with both numbers. That reading is of the export, by Timmy, not by Illustrator.
 *
 * Status: implemented; not run with Illustrator. tests/native-illustrator.test.ts runs the generated harness, and the
 * starter (templates/illustrator-starter), on a stand-in of Illustrator's scripting objects (tests/fixtures/
 * fake-illustrator.mjs, a labelled TEST DOUBLE standing in for osascript and Illustrator). The AppleScript sentence and
 * the export options follow Adobe's scripting documentation; no run in this repository has driven Illustrator yet.
 */
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, appendFileSync, closeSync, constants, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { JobRecord } from '../jobs/index.js';
import { resolveInside } from '../project/index.js';
import type { Segment } from '../term/theme.js';
import { appBundleName } from './ae-author.js';
import {
  judgeNativeJob, listNativeRuns, locateNative, NATIVE_APPS, NATIVE_RUNS_DIR, NativeNotFound, nativeReceiptFields, preStates, readNativeRecord, readNativeResult,
  sha256File, writeSubmission, type FinderSeams, type NativeJobSpec, type NativeJudgement, type NativeMeta, type NativeVerdictLine, type PreState,
} from './index.js';
import { fileStart, readPngSize, readSvgFile, SVG_SHAPES, type SvgRead, type SvgShape } from './svg-readback.js';
import { AUTOMATION_PLACE, HOST_APP } from './automation-words.js';

type Env = Record<string, string | undefined>;

export type IllustratorMode = 'author' | 'edit' | 'inspect';
export const ILLUSTRATOR_MODES: readonly IllustratorMode[] = ['author', 'edit', 'inspect'];
/** Where new documents and their exports are saved, relative to the project. */
export const ILLUSTRATOR_OUT_DIR = 'out/illustrator';
/** The first word of the line the harness returns: osascript prints it, the job's log keeps it. */
export const ILLUSTRATOR_MARK = 'TIMMY-AI';
/** The SVG export's coordinate precision (Illustrator's coordinatePrecision, 1 to 7; 3 is its documented default). */
export const SVG_PRECISION = 3;
/** The PNG export's scale: 100 % (one pixel per point, 72 per inch). */
export const PNG_SCALE = 100;
/** What the harness reads back at most, and the largest file it hashes inside Illustrator. */
export const ILLUSTRATOR_LIMITS = { artboards: 100, layers: 200, path_items: 500, text_frames: 200, text_chars: 1000, walk: 5000, depth: 64, hash_bytes: 4 * 1024 * 1024 } as const;

const SCRIPT_EXT = /\.(jsx|js)$/i;
const DOC_EXT = /\.ai$/i;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MTIME_SLACK_MS = 2000;

export { AUTOMATION_PLACE };
/** What macOS's Automation permission means here, said before a run (r21: macOS names the app in its question). */
const AUTOMATION_BEFORE = `macOS may ask once whether ${HOST_APP} may control Adobe Illustrator (${AUTOMATION_PLACE}; its question names that app): that is yours to answer; Timmy never grants it, changes it or opens System Settings`;
const NO_RESULT_HINT = 'possible causes, not checked: a dialog in Illustrator waiting for a person, Illustrator quitting, or macOS waiting for the Automation question to be answered; the raw output is in the job\'s log';

/** The usage lines /illustrator shows. */
export const ILLUSTRATOR_USAGE = [
  '/illustrator author <script.jsx> [--name <doc>]   Illustrator makes a new document: out/illustrator/<doc>-v<N>.ai, .svg, .pdf (.png when it can)',
  '/illustrator edit <doc.ai> <script.jsx>           the next version is saved with its exports; the document given is never written',
  '/illustrator inspect <doc.ai>                     Illustrator reads a document back; Timmy reads its SVG export itself',
];
/** What a run is judged by, said when it starts. */
export const ILLUSTRATOR_JUDGED = 'judged by its result file, the files it writes (Timmy\'s sha256) and Timmy\'s own reading of the SVG';

// ── how Timmy asks Illustrator ───────────────────────────────────────────────────

const appleString = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * osascript's arguments: Adobe's AppleScript command "do javascript" given the harness's file, inside a timeout of its
 * own (an Apple event otherwise gives up after 2 minutes). The one place this sentence is written.
 */
export function illustratorOsascriptArgs(appName: string, harness: string, seconds: number): string[] {
  return ['-e', `with timeout of ${Math.max(1, Math.floor(seconds))} seconds`, '-e', `tell application ${appleString(appName)} to do javascript file ${appleString(harness)}`, '-e', 'end timeout'];
}

/** The application's name for AppleScript: its .app bundle's (Illustrator is asked only that way), or why there is none. */
export function illustratorAppName(program: string): { appName: string } | { error: string } {
  const appName = appBundleName(program);
  return appName ? { appName } : { error: `${path.basename(program)} is not inside an application (.app): Timmy asks Illustrator through osascript, on macOS, by its application's name; set TIMMY_ILLUSTRATOR to Adobe Illustrator.app` };
}

const executable = (file: string): boolean => {
  try { if (!statSync(file).isFile()) return false; accessSync(file, constants.X_OK); return true; } catch { return false; }
};

/** osascript on a PATH, or undefined. */
export function osascriptOn(env: Env): string | undefined {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const at = path.join(dir, 'osascript');
    if (executable(at)) return at;
  }
  return undefined;
}

// ── the harness ──────────────────────────────────────────────────────────────────

/** A file the harness writes: where, and as the project names it. */
interface Target { path: string; rel: string }

/** What one run's harness is told, baked into it (Illustrator does not pass a job's environment to a script). */
export interface IllustratorHarnessConfig {
  v: 1;
  run: string;
  mode: IllustratorMode;
  /** the project folder */
  root: string;
  result: string;
  /** the run's copy of the script (author, edit) */
  script: string | null;
  /** the folder of the script as submitted, for a script that finds files beside it (TIMMY.scriptDir) */
  script_dir: string | null;
  /** the sha256 of this run's input as Timmy recorded it at submission: the script, or for inspect the document */
  input_sha256: string;
  /** edit, inspect: the document given */
  open: string | null;
  open_rel: string | null;
  /** author, edit: the new version (.ai) */
  save: string | null;
  save_rel: string | null;
  /** the exports: author and edit write all three into out/illustrator; inspect writes only the SVG, into the run's folder */
  exports: { svg: Target; pdf: Target | null; png: Target | null };
  svg_precision: number;
  png_scale: number;
  limits: typeof ILLUSTRATOR_LIMITS;
}

const HARNESS_HEAD = String.raw`// Timmy: Illustrator harness, generated for one run by src/native/illustrator.ts. Do not edit: its sha256 is recorded,
// and a changed harness is not the run's. It runs inside Adobe Illustrator (osascript: do javascript file).
// It never touches a document already open in Illustrator; it never saves over the document it was given; it sets the
// alert level for the run only and puts it back; it closes what it made or opened; it writes this run's result file.
// ExtendScript (ES3): no JSON, let, const, arrow functions or Array.forEach here.
`;

const HARNESS_BODY = String.raw`  var LIM = T.limits;
  var R = {
    timmy_illustrator: 1, ok: false, run: T.run, mode: T.mode, script_sha256: T.input_sha256, files: {}, exports: {},
    stage: 'started', error: 'the harness started and did not finish: Illustrator stopped, or was stopped, before the run ended',
    started_at: iso(new Date()), svg_precision: T.svg_precision
  };
  var failed = false;
  return main();

  function main() {
    var head = 'TIMMY-AI ' + T.run;
    var level = null;
    var quiet = false;
    var doc = null;
    var ours = false;
    try { level = app.userInteractionLevel; app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS; quiet = true; } catch (e0) {}
    R.alerts_suppressed = quiet;
    try { R.illustrator_version = String(app.version); } catch (e1) {}
    var probe = writeText(T.result, toJSON(R));
    if (probe !== '') {
      restore(level, quiet);
      return head + ' ok=false result=not-written reason=' + oneLine(probe);
    }
    try {
      R.stage = 'input';
      if (T.script) R.script_sha256_read = hashFile(T.script);
      R.harness_sha256_read = selfHash();
      R.stage = 'guard';
      R.open_documents = docCount();
      if (T.open && isOpen(T.open)) throw new Error(T.open_rel + ' is open in Illustrator; Timmy neither saves nor closes a document open there: close it in Illustrator, then run again');
      if (T.save && isOpen(T.save)) throw new Error(T.save_rel + ' is open in Illustrator; Timmy never saves over a document open there: close it in Illustrator, then run again');
      R.stage = 'document';
      if (T.mode === 'author') {
        doc = app.documents.add(DocumentColorSpace.RGB);
        ours = true;
        saveAi(doc);
      } else {
        doc = app.open(new File(T.open));
        if (!doc) throw new Error('Illustrator did not open ' + T.open_rel);
        ours = true;
        if (T.mode === 'edit') saveAi(doc);
      }
      if (T.mode !== 'inspect') {
        R.stage = 'script';
        $.global.TIMMY = { v: 1, run: T.run, mode: T.mode, root: T.root, scriptDir: T.script_dir, document: doc, saveTo: T.save, source: T.open };
        try { $.evalFile(new File(T.script)); } catch (es) { fail('script', es); }
        if (!failed) {
          R.stage = 'save';
          if (!alive(doc)) throw new Error('the script closed the document Timmy ' + (T.mode === 'author' ? 'made' : 'opened') + '; nothing was saved after it');
          var at = docPath(doc);
          if (!samePath(at, T.save)) throw new Error('the script saved the document as another file (' + (at ? baseName(at) : 'none') + '); Timmy saves only to ' + T.save_rel);
          doc.save();
          R.saved = true;
          R.saved_path = docPath(doc);
          R.stage = 'export';
          exportSvg(doc);
          if (T.exports.png) exportPng(doc);
        }
      } else {
        R.stage = 'export';
        try { exportSvg(doc); } catch (ei) { R.exports.svg = { path: T.exports.svg.rel, written: false, error: describe(ei) }; }
      }
    } catch (e2) {
      fail(R.stage, e2);
    }
    if (ours && alive(doc)) {
      try { R.readback = readback(doc); } catch (e3) { R.readback_error = describe(e3); }
      if (!failed && T.exports.pdf) {
        R.stage = 'export';
        try { exportPdf(doc); } catch (e4) { fail('export', e4); }
      }
      try { doc.close(SaveOptions.DONOTSAVECHANGES); R.closed = true; } catch (e5) { R.closed = false; R.close_error = describe(e5); }
    }
    if (!failed) {
      R.ok = true;
      R.stage = 'done';
      delete R.error;
    }
    R.ended_at = iso(new Date());
    var wrote = writeText(T.result, toJSON(R));
    restore(level, quiet);
    return head + ' ok=' + (R.ok ? 'true' : 'false') + (wrote === '' ? ' result=written' : ' result=not-written reason=' + oneLine(wrote));
  }

  function fail(stage, e) {
    failed = true;
    R.ok = false;
    R.stage = stage;
    R.error = describe(e);
    var ln = lineOf(e);
    if (ln !== null) R.error_line = ln;
  }

  function restore(level, quiet) {
    if (!quiet) return;
    try { app.userInteractionLevel = level; } catch (e) {}
  }

  // -- documents ----------------------------------------------------------------

  function docCount() {
    try { return app.documents.length; } catch (e) { return null; }
  }

  function docPath(d) {
    try { return d.fullName ? String(d.fullName.fsName) : null; } catch (e) { return null; }
  }

  function samePath(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    return String(a).toLowerCase() === String(b).toLowerCase();
  }

  function isOpen(p) {
    var n = docCount();
    for (var i = 0; i < n; i++) {
      var d = null;
      try { d = app.documents[i]; } catch (e) { continue; }
      if (samePath(docPath(d), p)) return true;
    }
    return false;
  }

  function alive(d) {
    if (!d) return false;
    try { var n = d.name; return n !== undefined; } catch (e) { return false; }
  }

  function baseName(p) {
    var s = String(p);
    var k = s.lastIndexOf('/');
    return k >= 0 ? s.substring(k + 1) : s;
  }

  function saveAi(d) {
    d.saveAs(new File(T.save), new IllustratorSaveOptions());
    if (!new File(T.save).exists) throw new Error('Illustrator reported the document saved, but there is no file at ' + T.save_rel);
    var at = docPath(d);
    if (!samePath(at, T.save)) throw new Error('Illustrator saved the document as ' + (at ? baseName(at) : 'an unknown file') + ', not ' + T.save_rel);
  }

  function opt(o, k, v, unset) {
    try { o[k] = v; } catch (e) { unset.push(k); }
  }

  // The files in a path's folder whose names start like its own, for a file Illustrator did not write where it was asked.
  function nearby(p) {
    try {
      var f = new File(p);
      var stem = String(f.displayName || decodeURI(f.name)).replace(/\.[^.]*$/, '');
      var list = f.parent.getFiles(stem + '*');
      var names = [];
      for (var i = 0; i < list.length && names.length < 10; i++) {
        if (list[i] instanceof File && String(list[i].fsName) !== String(f.fsName)) names.push(String(list[i].displayName || decodeURI(list[i].name)));
      }
      return names.length ? '; in its folder, files of that name: ' + names.join(', ') : '; no file of that name is in its folder';
    } catch (e) { return ''; }
  }

  function exportSvg(d) {
    var x = T.exports.svg;
    var note = { path: x.rel, written: false };
    R.exports.svg = note;
    var o = new ExportOptionsSVG();
    var unset = [];
    opt(o, 'coordinatePrecision', T.svg_precision, unset);
    opt(o, 'embedRasterImages', true, unset);
    opt(o, 'preserveEditability', false, unset);
    opt(o, 'saveMultipleArtboards', false, unset);
    opt(o, 'includeFileInfo', false, unset);
    opt(o, 'includeVariablesAndDatasets', false, unset);
    opt(o, 'slices', false, unset);
    try { opt(o, 'fontSubsetting', SVGFontSubsetting.None, unset); } catch (e1) { unset.push('fontSubsetting'); }
    try { opt(o, 'documentEncoding', SVGDocumentEncoding.UTF8, unset); } catch (e2) { unset.push('documentEncoding'); }
    if (unset.length) note.options_not_set = unset;
    d.exportFile(new File(x.path), ExportType.SVG, o);
    if (!new File(x.path).exists) throw new Error('Illustrator did not write ' + x.rel + nearby(x.path));
    note.written = true;
  }

  function exportPng(d) {
    var x = T.exports.png;
    var note = { path: x.rel, written: false };
    R.exports.png = note;
    if (typeof ExportOptionsPNG24 === 'undefined') { note.skipped = 'this Illustrator has no ExportOptionsPNG24'; return; }
    try {
      var o = new ExportOptionsPNG24();
      var unset = [];
      opt(o, 'artBoardClipping', true, unset);
      opt(o, 'antiAliasing', true, unset);
      opt(o, 'transparency', true, unset);
      opt(o, 'saveAsHTML', false, unset);
      opt(o, 'horizontalScale', T.png_scale, unset);
      opt(o, 'verticalScale', T.png_scale, unset);
      if (unset.length) note.options_not_set = unset;
      d.exportFile(new File(x.path), ExportType.PNG24, o);
      if (!new File(x.path).exists) { note.skipped = 'Illustrator did not write it' + nearby(x.path); return; }
      note.written = true;
      note.scale = T.png_scale;
    } catch (e) { note.skipped = 'Illustrator\'s PNG export failed: ' + describe(e); }
  }

  // Last: saving as PDF makes the PDF the document's file, so nothing is saved after it.
  function exportPdf(d) {
    var x = T.exports.pdf;
    var note = { path: x.rel, written: false };
    R.exports.pdf = note;
    var o = new PDFSaveOptions();
    var unset = [];
    opt(o, 'preserveEditability', false, unset);
    opt(o, 'viewAfterSaving', false, unset);
    if (unset.length) note.options_not_set = unset;
    d.saveAs(new File(x.path), o);
    if (!new File(x.path).exists) throw new Error('Illustrator did not write ' + x.rel + nearby(x.path));
    note.written = true;
  }

  // -- what the document holds, as Illustrator reports it -----------------------

  function readback(d) {
    var rb = { state: failed ? 'as the script left it, not saved' : (T.mode === 'inspect' ? 'as opened' : 'as saved') };
    rb.name = get(d, 'name');
    rb.color_space = str(function () { return d.documentColorSpace; });
    rb.ruler_units = str(function () { return d.rulerUnits; });
    rb.coordinate_system = str(function () { return app.coordinateSystem; });
    var n = num(function () { return d.artboards.length; });
    var abs = [];
    for (var i = 0; i < n; i++) {
      if (i >= LIM.artboards) { rb.artboards_truncated = true; break; }
      var a = null;
      try { a = d.artboards[i]; } catch (e0) { continue; }
      var r = null;
      try { r = rect(a.artboardRect); } catch (e1) {}
      abs.push({ index: i + 1, name: get(a, 'name'), rect: r, width: r ? r[2] - r[0] : null, height: r ? r[1] - r[3] : null });
    }
    rb.artboards = abs;
    rb.artboards_total = n;
    try { rb.active_artboard = d.artboards.getActiveArtboardIndex() + 1; } catch (e2) {}
    var layers = [];
    var count = { n: 0 };
    layersOf(d, 0, layers, count);
    rb.layers = layers;
    rb.layers_total = count.n;
    var drawn = { shapes: 0, bounds: null, texts: [], hidden: 0, guides: 0, clipping: 0, in_compound: 0 };
    rb.path_items = paths(d, drawn);
    rb.path_items_total = num(function () { return d.pathItems.length; });
    rb.compound_paths = compounds(d, drawn);
    rb.compound_paths_total = num(function () { return d.compoundPathItems.length; });
    rb.text_frames = texts(d, drawn);
    rb.text_frames_total = num(function () { return d.textFrames.length; });
    rb.counts = {
      groups: num(function () { return d.groupItems.length; }), raster: num(function () { return d.rasterItems.length; }),
      placed: num(function () { return d.placedItems.length; }), symbols: num(function () { return d.symbolItems.length; }),
      meshes: num(function () { return d.meshItems.length; }), plugins: num(function () { return d.pluginItems.length; })
    };
    rb.drawn = drawn;
    return rb;
  }

  function layersOf(parent, depth, out, count) {
    var n = num(function () { return parent.layers.length; });
    for (var i = 0; i < n; i++) {
      var l = null;
      try { l = parent.layers[i]; } catch (e) { continue; }
      count.n++;
      if (out.length < LIM.layers) out.push({ name: get(l, 'name'), depth: depth, visible: get(l, 'visible'), locked: get(l, 'locked'), items: num(function () { return l.pageItems.length; }) });
      if (depth + 1 < LIM.depth) layersOf(l, depth + 1, out, count);
    }
  }

  function paths(d, drawn) {
    var list = [];
    var total = num(function () { return d.pathItems.length; });
    for (var i = 0; i < total; i++) {
      if (i >= LIM.walk) { drawn.truncated = true; break; }
      var p = null;
      try { p = d.pathItems[i]; } catch (e0) { continue; }
      var b = null;
      try { b = rect(p.geometricBounds); } catch (e1) {}
      var guide = flag(p, 'guides');
      var clip = flag(p, 'clipping');
      var inCompound = typeOf(parentOf(p)) === 'CompoundPathItem';
      var hidden = hiddenNow(p);
      if (list.length < LIM.path_items) {
        var info = { layer: layerName(p), name: get(p, 'name'), closed: get(p, 'closed'), filled: get(p, 'filled'), stroked: get(p, 'stroked'), points: num(function () { return p.pathPoints.length; }), bounds: b };
        if (guide) info.guides = true;
        if (clip) info.clipping = true;
        if (inCompound) info.in_compound = true;
        if (hidden) info.hidden = true;
        list.push(info);
      }
      if (guide) drawn.guides++;
      else if (clip) drawn.clipping++;
      else if (inCompound) drawn.in_compound++;
      else if (hidden) drawn.hidden++;
      else { drawn.shapes++; drawn.bounds = union(drawn.bounds, b); }
    }
    return list;
  }

  function compounds(d, drawn) {
    var list = [];
    var total = num(function () { return d.compoundPathItems.length; });
    for (var i = 0; i < total; i++) {
      if (i >= LIM.walk) { drawn.truncated = true; break; }
      var c = null;
      try { c = d.compoundPathItems[i]; } catch (e0) { continue; }
      var b = null;
      try { b = rect(c.geometricBounds); } catch (e1) {}
      var clip = false;
      try { clip = c.pathItems.length > 0 && c.pathItems[0].clipping === true; } catch (e2) {}
      var hidden = hiddenNow(c);
      if (list.length < LIM.path_items) {
        var info = { layer: layerName(c), name: get(c, 'name'), paths: num(function () { return c.pathItems.length; }), bounds: b };
        if (clip) info.clipping = true;
        if (hidden) info.hidden = true;
        list.push(info);
      }
      if (clip) drawn.clipping++;
      else if (hidden) drawn.hidden++;
      else { drawn.shapes++; drawn.bounds = union(drawn.bounds, b); }
    }
    return list;
  }

  function texts(d, drawn) {
    var list = [];
    var total = num(function () { return d.textFrames.length; });
    for (var i = 0; i < total; i++) {
      if (i >= LIM.walk) { drawn.truncated = true; break; }
      var t = null;
      try { t = d.textFrames[i]; } catch (e0) { continue; }
      var s = '';
      try { s = String(t.contents); } catch (e1) { s = ''; }
      var cut = s.length > LIM.text_chars;
      if (cut) s = s.substring(0, LIM.text_chars);
      var hidden = hiddenNow(t);
      if (list.length < LIM.text_frames) {
        var b = null;
        try { b = rect(t.geometricBounds); } catch (e2) {}
        var info = { layer: layerName(t), name: get(t, 'name'), kind: str(function () { return t.kind; }), contents: s, bounds: b };
        if (cut) info.contents_truncated = true;
        if (hidden) info.hidden = true;
        list.push(info);
      }
      if (hidden) drawn.hidden++;
      else {
        if (drawn.texts.length < LIM.text_frames) drawn.texts.push(s);
        else drawn.texts_truncated = true;
        if (cut) drawn.texts_truncated = true;
      }
    }
    return list;
  }

  function typeOf(o) {
    try { return o ? String(o.typename) : null; } catch (e) { return null; }
  }

  function parentOf(o) {
    try { return o.parent; } catch (e) { return null; }
  }

  function layerName(o) {
    try { return o.layer ? String(o.layer.name) : null; } catch (e) { return null; }
  }

  function flag(o, k) {
    try { return o[k] === true; } catch (e) { return false; }
  }

  // Hidden itself, or under a hidden group or a layer that is not visible.
  function hiddenNow(it) {
    var p = it;
    for (var d = 0; p && d < LIM.depth; d++) {
      var t = typeOf(p);
      if (t === 'Document' || t === null) return false;
      if (t === 'Layer') { if (get(p, 'visible') === false) return true; }
      else if (flag(p, 'hidden')) return true;
      p = parentOf(p);
    }
    return false;
  }

  function rect(v) {
    if (!v || typeof v.length !== 'number' || v.length !== 4) return null;
    var out = [];
    for (var i = 0; i < 4; i++) {
      if (typeof v[i] !== 'number' || !isFinite(v[i])) return null;
      out.push(v[i]);
    }
    return out;
  }

  function union(a, b) {
    if (!b) return a;
    if (!a) return [b[0], b[1], b[2], b[3]];
    return [Math.min(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2]), Math.min(a[3], b[3])];
  }

  function num(fn) {
    try { var v = fn(); return typeof v === 'number' && isFinite(v) ? v : 0; } catch (e) { return 0; }
  }

  function str(fn) {
    try { var v = fn(); return v === null || v === undefined ? null : String(v); } catch (e) { return null; }
  }

  function get(o, k) {
    try {
      var v = o[k];
      return (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') ? v : null;
    } catch (e) { return null; }
  }

  // -- files, text, JSON, sha256 (ES3) ------------------------------------------

  function hashFile(p) {
    try {
      var f = new File(p);
      if (!f.exists) return null;
      if (f.length > LIM.hash_bytes) return null;
      f.encoding = 'BINARY';
      if (!f.open('r')) return null;
      var s = f.read();
      f.close();
      return sha256Hex(s);
    } catch (e) { return null; }
  }

  function selfHash() {
    try {
      var me = $.fileName;
      return me ? hashFile(me) : null;
    } catch (e) { return null; }
  }

  function writeText(p, text) {
    var why = '';
    try {
      var f = new File(p);
      f.encoding = 'UTF-8';
      f.lineFeed = 'Unix';
      if (!f.open('w')) return 'could not open it for writing' + (f.error ? ': ' + f.error : '');
      if (!f.write(text)) why = 'could not write it' + (f.error ? ': ' + f.error : '');
      f.close();
    } catch (e) { why = describe(e); }
    return why;
  }

  function describe(e) {
    var m = '';
    try {
      if (e === null || e === undefined) m = 'an error with no message';
      else if (typeof e === 'object' && e.message !== undefined) m = (e.name && e.name !== 'Error' ? e.name + ': ' : '') + e.message;
      else m = String(e);
    } catch (x) { m = 'an error that could not be described'; }
    return oneLine(m).substring(0, 2000);
  }

  function lineOf(e) {
    try { if (e && typeof e.line === 'number') return e.line; } catch (x) {}
    return null;
  }

  function oneLine(s) { return String(s).replace(/[\r\n\t]+/g, ' '); }

  function pad(n, w) {
    var s = String(n);
    while (s.length < w) s = '0' + s;
    return s;
  }

  function iso(d) {
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1, 2) + '-' + pad(d.getUTCDate(), 2) + 'T' + pad(d.getUTCHours(), 2) + ':' +
      pad(d.getUTCMinutes(), 2) + ':' + pad(d.getUTCSeconds(), 2) + '.' + pad(d.getUTCMilliseconds(), 3) + 'Z';
  }

  function q(s) {
    var out = '"';
    var c;
    var h;
    s = String(s);
    for (var i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c === 34) out += '\\"';
      else if (c === 92) out += '\\\\';
      else if (c === 10) out += '\\n';
      else if (c === 13) out += '\\r';
      else if (c === 9) out += '\\t';
      else if (c < 32 || c > 126) {
        h = c.toString(16);
        while (h.length < 4) h = '0' + h;
        out += '\\u' + h;
      } else out += s.charAt(i);
    }
    return out + '"';
  }

  function toJSON(v) {
    var t = typeof v;
    var parts = [];
    if (v === null || v === undefined) return 'null';
    if (t === 'boolean') return v ? 'true' : 'false';
    if (t === 'number') return isFinite(v) ? String(v) : 'null';
    if (t === 'string') return q(v);
    if (Object.prototype.toString.call(v) === '[object Array]') {
      for (var i = 0; i < v.length; i++) parts.push(toJSON(v[i]));
      return '[' + parts.join(',') + ']';
    }
    if (t === 'object') {
      for (var k in v) {
        if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
        if (v[k] === undefined || typeof v[k] === 'function') continue;
        parts.push(q(k) + ':' + toJSON(v[k]));
      }
      return '{' + parts.join(',') + '}';
    }
    return 'null';
  }

  function sha256Hex(bytes) {
    var K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var n = bytes.length;
    var total = ((n + 9 + 63) >> 6) << 4;
    var words = [];
    var w = [];
    var i;
    var j;
    for (i = 0; i < total; i++) words[i] = 0;
    for (i = 0; i < n; i++) words[i >> 2] |= (bytes.charCodeAt(i) & 0xff) << (24 - ((i & 3) << 3));
    words[n >> 2] |= 0x80 << (24 - ((n & 3) << 3));
    words[total - 1] = (n * 8) >>> 0;
    words[total - 2] = Math.floor(n / 0x20000000);
    for (i = 0; i < total; i += 16) {
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (j = 0; j < 64; j++) {
        if (j < 16) w[j] = words[i + j] | 0;
        else {
          var x = w[j - 15];
          var y = w[j - 2];
          var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
          var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
          w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
        }
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[j] + w[j]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        h = g;
        g = f;
        f = e;
        e = (d + t1) | 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0;
      H[1] = (H[1] + b) | 0;
      H[2] = (H[2] + c) | 0;
      H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0;
      H[5] = (H[5] + f) | 0;
      H[6] = (H[6] + g) | 0;
      H[7] = (H[7] + h) | 0;
    }
    var hex = '';
    for (i = 0; i < 8; i++) {
      var hx = (H[i] >>> 0).toString(16);
      while (hx.length < 8) hx = '0' + hx;
      hex += hx;
    }
    return hex;
  }`;

/** JSON with every character outside printable ASCII escaped: the harness file is plain ASCII whatever the paths hold. */
const asciiJson = (v: unknown): string => JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** One run's harness: plain ES3 for ExtendScript, its configuration on the line marked timmy-illustrator-config. */
export function illustratorHarness(config: IllustratorHarnessConfig): string {
  return `${HARNESS_HEAD}(function (T) {\n${HARNESS_BODY}\n}(\n/* timmy-illustrator-config */ ${asciiJson(config)}\n));\n`;
}

/** The configuration baked into a harness (what tests and a reader of the run's folder see). */
export function illustratorHarnessConfig(text: string): IllustratorHarnessConfig | undefined {
  const m = /^\/\* timmy-illustrator-config \*\/ (\{.*\})$/m.exec(text);
  if (!m) return undefined;
  try { return JSON.parse(m[1]) as IllustratorHarnessConfig; } catch { return undefined; }
}

// ── a run ────────────────────────────────────────────────────────────────────────

export interface IllustratorJobInput {
  mode: IllustratorMode;
  /** author, edit: the script, relative to root (.jsx or .js) */
  script?: string;
  /** edit, inspect: the document, relative to root (.ai) */
  docFile?: string;
  /** author: the new document's name (default: the script's); its versions are out/illustrator/<name>-v<N>.ai */
  name?: string;
  root: string;
  project: string;
  timeoutMs?: number;
  /** the Illustrator program, inside its .app (default: found by locateNative('illustrator'), TIMMY_ILLUSTRATOR first) */
  bin?: string;
  /** added to the job's environment */
  env?: NodeJS.ProcessEnv;
  /** where the finder looks, and the PATH osascript is found on (default: this process's environment with `env` over it) */
  findEnv?: Env;
  seams?: FinderSeams;
  /** the osascript program (default: osascript on that PATH) */
  osascript?: string;
  label?: string;
}

/** A file a run writes into the project, as its record names it. */
export interface IllustratorTarget { path: string; rel: string }
/** What judging a run needs beyond the native module's meta, carried on its spec and in its illustrator.json. */
export interface IllustratorRunMeta {
  mode: IllustratorMode;
  route: 'osascript';
  appName: string;
  name: string;
  version?: number;
  harness: { path: string; rel: string; sha256: string };
  script?: { source: string; copy: string; copyRel: string; sha256: string };
  source?: { path: string; rel: string; sha256: string; bytes: number };
  saved?: IllustratorTarget;
  exports: { svg: IllustratorTarget; pdf?: IllustratorTarget; png?: IllustratorTarget };
  svgPrecision: number;
  pngScale: number;
}
export interface IllustratorJobSpec extends NativeJobSpec { illustrator: IllustratorRunMeta }

export function isIllustratorJobSpec(spec: unknown): spec is IllustratorJobSpec {
  return Boolean(spec && typeof spec === 'object' && 'illustrator' in spec && 'native' in spec && (spec as { native?: { app?: unknown } }).native?.app === 'illustrator');
}

/** illustrator.json: this module's part of a run's record, written once at submission. Paths relative to the project. */
interface IllustratorRunRecord {
  record: 'timmy-illustrator-run';
  v: 1;
  run: string;
  mode: IllustratorMode;
  route: 'osascript';
  app_name: string;
  name: string;
  version?: number;
  harness: { path: string; sha256: string };
  script?: { source: string; copy: string; sha256: string };
  source?: { path: string; sha256: string; bytes: number };
  saved?: string;
  exports: { svg: string; pdf?: string; png?: string };
  svg_precision: number;
  png_scale: number;
}

function realRoot(root: string): string {
  try { return realpathSync(root); } catch { throw new Error('the project folder is gone'); }
}
function inside(root: string, rel: string): { path: string; rel: string } {
  const at = resolveInside(root, rel);
  if ('error' in at) throw new Error(at.error);
  return at;
}
const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const listDir = (dir: string): string[] => { try { return readdirSync(dir); } catch { return []; } };
const relTo = (root: string, abs: string): string => path.relative(root, abs).split(path.sep).join('/');

/** A file name for a document: letters, digits, dot, dash and underscore; no version suffix (-v<N>), which Timmy adds. */
export function illustratorStem(name: string): string {
  const s = path.basename(name.trim().replace(/\\/g, '/'))
    .replace(DOC_EXT, '').replace(SCRIPT_EXT, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').replace(/-v\d+$/i, '').slice(0, 80);
  return s || 'artwork';
}

/** The next free version of a name in out/illustrator: past every file of it there and every name another run will write. */
function nextVersion(root: string, stem: string): number {
  const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${esc}-v(\\d+)\\.(?:ai|svg|pdf|png)$`, 'i');
  const taken = [0];
  for (const name of listDir(path.join(root, ...ILLUSTRATOR_OUT_DIR.split('/')))) {
    const m = pattern.exec(name);
    if (m) taken.push(Number(m[1]));
  }
  for (const r of listNativeRuns(root)) {
    if (r.app !== 'illustrator') continue;
    for (const e of readNativeRecord(root, r.run)?.job.expect ?? []) {
      const m = path.posix.dirname(e) === ILLUSTRATOR_OUT_DIR ? pattern.exec(path.posix.basename(e)) : null;
      if (m) taken.push(Number(m[1]));
    }
  }
  return Math.max(...taken) + 1;
}

const pidAlive = (pid: unknown): boolean => {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/**
 * Illustrator runs one script at a time, and a second run would wait behind the first or be timed out by it: refused while
 * another Illustrator run of this project started, is not judged, its process is there and its time limit has not passed.
 */
function refuseBusy(root: string, now: number): void {
  for (const r of listNativeRuns(root)) {
    if (r.app !== 'illustrator' || r.verdicts.length) continue;
    const rec = readNativeRecord(root, r.run);
    if (!rec?.started) continue;
    if (rec.started.pid !== undefined && !pidAlive(rec.started.pid)) continue;
    const until = Date.parse(rec.job.started_at) + rec.job.timeout_ms + 60_000;
    if (!(until > now)) continue;
    throw new Error(`another Illustrator run (${r.run.slice(0, 8)}, job ${rec.started.job}, started ${rec.job.started_at}) has not been judged yet; Illustrator runs one script at a time: wait for it, or /stop ${rec.started.job}`);
  }
}

function findProgram(input: IllustratorJobInput, env: Env): string {
  if (input.bin) return input.bin;
  const { found, problem } = locateNative('illustrator', env, input.seams ?? {});
  if (!found) throw new NativeNotFound('illustrator', NATIVE_APPS.illustrator.setup, problem);
  return found.path;
}

function labelOf(mode: IllustratorMode, script: string | undefined, source: string | undefined, saved: string | undefined): string {
  if (mode === 'author') return `Illustrator · author ${script} → ${saved}`;
  if (mode === 'edit') return `Illustrator · edit ${source} with ${script} → ${saved}`;
  return `Illustrator · inspect ${source}`;
}

/**
 * A task job that has Illustrator run this run's harness through osascript (Illustrator starts, or comes forward, and its
 * window opens). Making the spec writes the run's folder: the script's copy, the harness, illustrator.json and the native
 * module's job.json. Nothing is written in the project outside .timmy/native/<run>/ except out/illustrator/, made for the
 * new version.
 */
export function illustratorJob(input: IllustratorJobInput): IllustratorJobSpec {
  const mode = input.mode;
  if (!ILLUSTRATOR_MODES.includes(mode)) throw new Error(`no Illustrator mode ${String(mode)}: author, edit or inspect`);
  const root = realRoot(input.root);
  let script: { path: string; rel: string; bytes: Buffer; sha256: string } | undefined;
  if (mode !== 'inspect') {
    if (!input.script) throw new Error(`/illustrator ${mode} needs a script (.jsx)`);
    const at = inside(root, input.script);
    let bytes: Buffer;
    try {
      if (!statSync(at.path).isFile()) throw new Error('not a file');
      bytes = readFileSync(at.path);
    } catch { throw new Error(`no script at ${at.rel}`); }
    if (!SCRIPT_EXT.test(at.rel)) throw new Error(`${at.rel} is not an Illustrator script (.jsx or .js)`);
    script = { ...at, bytes, sha256: sha256(bytes) };
  }
  let source: { path: string; rel: string; sha256: string; bytes: number } | undefined;
  if (mode !== 'author') {
    if (!input.docFile) throw new Error(`/illustrator ${mode} needs the document (.ai)`);
    const at = inside(root, input.docFile);
    if (!DOC_EXT.test(at.rel)) throw new Error(`${at.rel} is not an Illustrator document (.ai)`);
    let bytes = -1;
    try { const s = statSync(at.path); if (s.isFile()) bytes = s.size; } catch { /* missing */ }
    if (bytes < 0) throw new Error(`no document at ${at.rel}`);
    const digest = sha256File(at.path);
    if (!digest) throw new Error(`${at.rel} cannot be read`);
    source = { ...at, sha256: digest, bytes };
  }
  const env: Env = input.findEnv ?? { ...process.env, ...input.env };
  const program = findProgram(input, env);
  const named = illustratorAppName(program);
  if ('error' in named) throw new Error(named.error);
  const osascript = input.osascript ?? osascriptOn(env);
  if (!osascript) throw new Error('osascript was not found on PATH: Timmy asks Illustrator through osascript, which macOS keeps at /usr/bin/osascript');
  const submittedMs = Date.now();
  refuseBusy(root, submittedMs);

  const name = mode === 'author' ? illustratorStem(input.name ?? path.basename(script!.rel)) : illustratorStem(path.basename(source!.rel));
  const run = randomUUID();
  const record = path.join(root, NATIVE_RUNS_DIR, run);
  const version = mode === 'inspect' ? undefined : nextVersion(root, name);
  const out = (ext: string): IllustratorTarget => inside(root, `${ILLUSTRATOR_OUT_DIR}/${name}-v${version}.${ext}`);
  const saved = version !== undefined ? out('ai') : undefined;
  const exports: IllustratorRunMeta['exports'] = version !== undefined
    ? { svg: out('svg'), pdf: out('pdf'), png: out('png') }
    : { svg: { path: path.join(record, 'inspect.svg'), rel: relTo(root, path.join(record, 'inspect.svg')) } };
  mkdirSync(record, { recursive: true });
  if (saved) mkdirSync(path.dirname(saved.path), { recursive: true });

  // The script as submitted, byte for byte and read-only: the copy is what Illustrator runs.
  let scriptMeta: IllustratorRunMeta['script'];
  if (script) {
    const ext = (SCRIPT_EXT.exec(script.rel)?.[0] ?? '.jsx').toLowerCase();
    const copy = path.join(record, `script${ext}`);
    writeFileSync(copy, script.bytes, { flag: 'wx', mode: 0o444 });
    scriptMeta = { source: script.rel, copy, copyRel: relTo(root, copy), sha256: script.sha256 };
  }
  const result = path.join(record, 'result.json');
  const config: IllustratorHarnessConfig = {
    v: 1, run, mode, root, result,
    script: scriptMeta?.copy ?? null, script_dir: script ? path.dirname(script.path) : null,
    input_sha256: script ? script.sha256 : source!.sha256,
    open: source?.path ?? null, open_rel: source?.rel ?? null, save: saved?.path ?? null, save_rel: saved?.rel ?? null,
    exports: { svg: exports.svg, pdf: exports.pdf ?? null, png: exports.png ?? null },
    svg_precision: SVG_PRECISION, png_scale: PNG_SCALE, limits: ILLUSTRATOR_LIMITS,
  };
  const harnessText = illustratorHarness(config);
  const harnessPath = path.join(record, 'harness.jsx');
  writeFileSync(harnessPath, harnessText, { flag: 'wx', mode: 0o444 });
  const harness = { path: harnessPath, rel: relTo(root, harnessPath), sha256: sha256(harnessText) };

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // osascript gives up a little before the job's own limit, so its own message says why.
  const args = illustratorOsascriptArgs(named.appName, harnessPath, Math.max(5, Math.floor(timeoutMs / 1000) - 5));
  const expect = saved ? [saved.rel, exports.svg.rel, exports.pdf!.rel] : [];
  const native: NativeMeta = {
    app: 'illustrator', root, run, record, result, expect,
    input: script ? { path: script.rel, sha256: script.sha256 } : { path: source!.rel, sha256: source!.sha256 },
    pre: preStates(root, [...expect, ...(exports.png ? [exports.png.rel] : [])]), submittedMs,
  };
  const meta: IllustratorRunMeta = {
    mode, route: 'osascript', appName: named.appName, name, ...(version !== undefined ? { version } : {}), harness,
    ...(scriptMeta ? { script: scriptMeta } : {}), ...(source ? { source } : {}), ...(saved ? { saved } : {}),
    exports, svgPrecision: SVG_PRECISION, pngScale: PNG_SCALE,
  };
  const spec: IllustratorJobSpec = {
    kind: 'task', label: input.label ?? labelOf(mode, script?.rel, source?.rel, saved?.rel), project: input.project, root,
    command: osascript, args, ...(input.env ? { env: input.env } : {}), timeoutMs, native, illustrator: meta,
  };
  const rec: IllustratorRunRecord = {
    record: 'timmy-illustrator-run', v: 1, run, mode, route: 'osascript', app_name: named.appName, name, ...(version !== undefined ? { version } : {}),
    harness: { path: harness.rel, sha256: harness.sha256 },
    ...(scriptMeta ? { script: { source: scriptMeta.source, copy: scriptMeta.copyRel, sha256: scriptMeta.sha256 } } : {}),
    ...(source ? { source: { path: source.rel, sha256: source.sha256, bytes: source.bytes } } : {}),
    ...(saved ? { saved: saved.rel } : {}),
    exports: { svg: exports.svg.rel, ...(exports.pdf ? { pdf: exports.pdf.rel } : {}), ...(exports.png ? { png: exports.png.rel } : {}) },
    svg_precision: SVG_PRECISION, png_scale: PNG_SCALE,
  };
  writeFileSync(path.join(record, 'illustrator.json'), `${JSON.stringify(rec, null, 2)}\n`, { flag: 'wx' });
  // job.json keeps the arguments with the project folder written as ".", inside the AppleScript text too.
  writeSubmission({ ...spec, args: args.map((a) => a.split(`${root}${path.sep}`).join(`.${path.sep}`)) });
  return spec;
}

// ── what Illustrator reported, read defensively ────────────────────────────────────

export type Rect4 = [number, number, number, number];
/** The document as Illustrator reported it (the harness's readback): its own report of its own document, not an independent one. */
export interface IllustratorReport {
  state?: string;
  name?: string | null;
  color_space?: string | null;
  coordinate_system?: string | null;
  artboards: Array<{ index: number; name: string | null; rect: Rect4 | null; width: number | null; height: number | null }>;
  artboards_total?: number;
  active_artboard?: number;
  layers: Array<{ name: string | null; depth: number; visible: boolean | null; locked: boolean | null; items: number | null }>;
  layers_total?: number;
  path_items: Array<{ layer: string | null; name: string | null; closed: boolean | null; points: number | null; bounds: Rect4 | null; guides?: true; clipping?: true; in_compound?: true; hidden?: true }>;
  path_items_total?: number;
  compound_paths_total?: number;
  text_frames: Array<{ layer: string | null; name: string | null; kind: string | null; contents: string; contents_truncated?: true; bounds: Rect4 | null; hidden?: true }>;
  text_frames_total?: number;
  counts?: Record<string, number>;
  /** what it draws: shapes (path items not in a compound path, not guides, not clipping, not hidden; and compound paths), their bounds, its texts */
  drawn?: { shapes: number; bounds: Rect4 | null; texts: string[]; texts_truncated?: true; hidden: number; guides: number; clipping: number; in_compound: number; truncated?: true };
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined);
const numOr = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strOr = (v: unknown): string | null => (typeof v === 'string' ? v.slice(0, 2000) : null);
const boolOr = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const rect4 = (v: unknown): Rect4 | null => (Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? [v[0], v[1], v[2], v[3]] : null);
const arr = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const count = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);

/** The harness's readback as Timmy takes it: each field checked for its type, lists bounded; undefined when there is none. */
export function illustratorReport(v: unknown): IllustratorReport | undefined {
  const r = obj(v);
  if (!r) return undefined;
  const L = ILLUSTRATOR_LIMITS;
  const d = obj(r.drawn);
  return {
    ...(typeof r.state === 'string' ? { state: r.state.slice(0, 200) } : {}),
    name: strOr(r.name), color_space: strOr(r.color_space), coordinate_system: strOr(r.coordinate_system),
    artboards: arr(r.artboards, L.artboards).map(obj).filter((a): a is Obj => !!a).map((a) => ({ index: count(a.index), name: strOr(a.name), rect: rect4(a.rect), width: numOr(a.width), height: numOr(a.height) })),
    ...(typeof r.artboards_total === 'number' ? { artboards_total: count(r.artboards_total) } : {}),
    ...(typeof r.active_artboard === 'number' ? { active_artboard: count(r.active_artboard) } : {}),
    layers: arr(r.layers, L.layers).map(obj).filter((a): a is Obj => !!a).map((a) => ({ name: strOr(a.name), depth: count(a.depth), visible: boolOr(a.visible), locked: boolOr(a.locked), items: numOr(a.items) })),
    ...(typeof r.layers_total === 'number' ? { layers_total: count(r.layers_total) } : {}),
    path_items: arr(r.path_items, L.path_items).map(obj).filter((a): a is Obj => !!a).map((a) => ({
      layer: strOr(a.layer), name: strOr(a.name), closed: boolOr(a.closed), points: numOr(a.points), bounds: rect4(a.bounds),
      ...(a.guides === true ? { guides: true as const } : {}), ...(a.clipping === true ? { clipping: true as const } : {}),
      ...(a.in_compound === true ? { in_compound: true as const } : {}), ...(a.hidden === true ? { hidden: true as const } : {}),
    })),
    ...(typeof r.path_items_total === 'number' ? { path_items_total: count(r.path_items_total) } : {}),
    ...(typeof r.compound_paths_total === 'number' ? { compound_paths_total: count(r.compound_paths_total) } : {}),
    text_frames: arr(r.text_frames, L.text_frames).map(obj).filter((a): a is Obj => !!a).map((a) => ({
      layer: strOr(a.layer), name: strOr(a.name), kind: strOr(a.kind), contents: (strOr(a.contents) ?? '').slice(0, L.text_chars), bounds: rect4(a.bounds),
      ...(a.contents_truncated === true ? { contents_truncated: true as const } : {}), ...(a.hidden === true ? { hidden: true as const } : {}),
    })),
    ...(typeof r.text_frames_total === 'number' ? { text_frames_total: count(r.text_frames_total) } : {}),
    ...(obj(r.counts) ? { counts: Object.fromEntries(Object.entries(obj(r.counts)!).slice(0, 20).map(([k, x]) => [k.slice(0, 40), count(x)])) } : {}),
    ...(d ? {
      drawn: {
        shapes: count(d.shapes), bounds: rect4(d.bounds), texts: arr(d.texts, L.text_frames).map((t) => (typeof t === 'string' ? t.slice(0, L.text_chars) : '')),
        ...(d.texts_truncated === true ? { texts_truncated: true as const } : {}),
        hidden: count(d.hidden), guides: count(d.guides), clipping: count(d.clipping), in_compound: count(d.in_compound), ...(d.truncated === true ? { truncated: true as const } : {}),
      },
    } : {}),
  };
}

// ── Timmy's own reading of the export, against Illustrator's report ───────────────

export type ReadbackVerdict = 'agrees' | 'differs' | 'not compared';
/** Timmy's own reading of the exported SVG (and PNG), compared with Illustrator's report: each part agrees, or differs with both numbers. */
export interface IllustratorCheck {
  verdict: ReadbackVerdict;
  /** the SVG read, relative to the project */
  svg: string;
  /** when nothing could be compared, why */
  why?: string;
  /** the active artboard's size (points) against the SVG's (user units: Illustrator writes 1 pt as 1); tolerance from the digits the SVG wrote */
  artboard?: { illustrator: [number, number]; svg: [number, number]; from: 'viewBox' | 'width and height'; agrees: boolean; tolerance: [number, number] };
  /** drawn shapes: Illustrator's count against the SVG's shape elements, by element */
  shapes?: { illustrator: number; svg: number; by_element: Partial<Record<SvgShape, number>>; agrees: boolean };
  /** the drawn texts' characters, compared with spaces and line breaks left out, in any order */
  texts?: { illustrator: string[]; svg: string[]; agrees: boolean };
  /** the drawn shapes' bounds in the SVG's user units, [minX, minY, maxX, maxY]; Illustrator's from its geometric bounds and the artboard */
  bounds?: { illustrator: Rect4 | null; svg: Rect4 | null; agrees: boolean | null; tolerance: number | null; why?: string };
  /** the PNG's pixels against the artboard at the export's scale, within one pixel for rounding */
  png?: { path: string; size: [number, number] | null; expected: [number, number] | null; agrees: boolean | null; why?: string };
  /** what the SVG reading noted (an entity not expanded, a script element not run, CSS not evaluated...) */
  notes: string[];
}

const squeeze = (s: string): string => s.replace(/\s+/g, '');
const round = (n: number): number => Math.round(n * 1e6) / 1e6;
/** Half a unit in the last place a number was written with: what its digits can establish. */
const halfUnit = (decimals: number): number => 0.5 * 10 ** -Math.max(-6, Math.min(12, decimals));

/** The artboard the SVG holds: the active one when Illustrator named it, else the first. */
function svgArtboard(rep: IllustratorReport): IllustratorReport['artboards'][number] | undefined {
  const k = rep.active_artboard;
  return (k && rep.artboards.find((a) => a.index === k)) || rep.artboards[0];
}

/**
 * Timmy's reading of the SVG against Illustrator's report. Each part is compared only when both sides have it; the verdict
 * is "differs" when any compared part differs, "agrees" when every compared part agrees, else "not compared" (and why).
 */
export function compareIllustratorReadback(svgRel: string, reading: SvgRead, rep: IllustratorReport | undefined, o: { precision: number; png?: { rel: string; abs: string; scale: number } }): IllustratorCheck {
  const notes = reading.ok ? reading.notes : [];
  const base = { svg: svgRel, notes };
  if (!reading.ok) return { ...base, verdict: 'not compared', why: `Timmy could not read ${svgRel}: ${reading.why}` };
  if (!rep) return { ...base, verdict: 'not compared', why: 'Illustrator reported nothing of the document to compare with' };
  const out: IllustratorCheck = { ...base, verdict: 'not compared' };
  const ab = svgArtboard(rep);
  const abRect = ab?.rect ?? null;
  if (ab && typeof ab.width === 'number' && typeof ab.height === 'number') {
    const vb = reading.viewBox;
    const plain = (l: typeof reading.width): boolean => !!l && (l.unit === '' || l.unit === 'px');
    if (vb) {
      const tol: [number, number] = [halfUnit(vb.decimals[2]), halfUnit(vb.decimals[3])];
      out.artboard = { illustrator: [round(ab.width), round(ab.height)], svg: [vb.box[2], vb.box[3]], from: 'viewBox', tolerance: tol, agrees: Math.abs(vb.box[2] - ab.width) <= tol[0] && Math.abs(vb.box[3] - ab.height) <= tol[1] };
    } else if (plain(reading.width) && plain(reading.height)) {
      const tol: [number, number] = [halfUnit(reading.width!.decimals), halfUnit(reading.height!.decimals)];
      out.artboard = { illustrator: [round(ab.width), round(ab.height)], svg: [reading.width!.value, reading.height!.value], from: 'width and height', tolerance: tol, agrees: Math.abs(reading.width!.value - ab.width) <= tol[0] && Math.abs(reading.height!.value - ab.height) <= tol[1] };
    }
  }
  const drawn = rep.drawn;
  if (drawn && !drawn.truncated) {
    const by: Partial<Record<SvgShape, number>> = {};
    for (const k of SVG_SHAPES) if (reading.shapes[k]) by[k] = reading.shapes[k];
    out.shapes = { illustrator: drawn.shapes, svg: reading.shapeTotal, by_element: by, agrees: drawn.shapes === reading.shapeTotal };
    if (!drawn.texts_truncated && reading.textTotal <= reading.texts.length) {
      const a = drawn.texts.map(squeeze).sort();
      const b = reading.texts.map(squeeze).sort();
      out.texts = { illustrator: drawn.texts, svg: reading.texts, agrees: a.length === b.length && a.every((x, k) => x === b[k]) };
    }
    // Illustrator's bounds are [left, top, right, bottom] with y up; the SVG's user space starts at the artboard's top left
    // (the viewBox's minX and minY) with y down.
    const vb = reading.viewBox?.box ?? [0, 0, 0, 0];
    const ill: Rect4 | null = drawn.bounds && abRect
      ? [round(drawn.bounds[0] - abRect[0] + vb[0]), round(abRect[1] - drawn.bounds[1] + vb[1]), round(drawn.bounds[2] - abRect[0] + vb[0]), round(abRect[1] - drawn.bounds[3] + vb[1])]
      : null;
    if (!reading.bounds.computed) out.bounds = { illustrator: ill, svg: null, agrees: null, tolerance: null, why: `Timmy did not compute the SVG's bounds: ${reading.bounds.why}` };
    else if (drawn.bounds && !abRect) out.bounds = { illustrator: null, svg: reading.bounds.box, agrees: null, tolerance: reading.bounds.tolerance, why: 'Illustrator reported no artboard to place its bounds in' };
    else {
      const svgBox = reading.bounds.box;
      const tol = reading.bounds.tolerance;
      let agrees: boolean | null;
      if (!ill || !svgBox) agrees = !ill && !svgBox;
      else agrees = tol === null ? null : ill.every((x, k) => Math.abs(x - svgBox[k]) <= tol);
      out.bounds = { illustrator: ill, svg: svgBox ? [round(svgBox[0]), round(svgBox[1]), round(svgBox[2]), round(svgBox[3])] : null, agrees, tolerance: tol === null ? null : round(tol), ...(agrees === null ? { why: 'the precision the SVG was written at is not known' } : {}) };
    }
  }
  if (o.png) {
    const size = readPngSize(o.png.abs);
    const expected: [number, number] | null = ab && typeof ab.width === 'number' && typeof ab.height === 'number' ? [round((ab.width * o.png.scale) / 100), round((ab.height * o.png.scale) / 100)] : null;
    if ('why' in size) out.png = { path: o.png.rel, size: null, expected, agrees: null, why: size.why };
    else out.png = { path: o.png.rel, size: [size.width, size.height], expected, agrees: expected ? Math.abs(size.width - expected[0]) <= 1 && Math.abs(size.height - expected[1]) <= 1 : null, ...(expected ? {} : { why: 'Illustrator reported no artboard size' }) };
  }
  const parts = [out.artboard?.agrees, out.shapes?.agrees, out.texts?.agrees, out.bounds?.agrees ?? undefined, out.png?.agrees ?? undefined].filter((x): x is boolean => typeof x === 'boolean');
  out.verdict = parts.some((x) => !x) ? 'differs' : parts.length ? 'agrees' : 'not compared';
  if (out.verdict === 'not compared') out.why = drawn?.truncated ? `the document has more than ${ILLUSTRATOR_LIMITS.walk.toLocaleString('en-US')} items of a kind, past what the harness reads` : 'neither the artboard, the shapes, the texts nor the bounds could be compared';
  return out;
}

// ── judging a run ────────────────────────────────────────────────────────────────

/** A file a run was to write, as Timmy found it after the run (its sha256 Timmy's). */
export interface IllustratorFileState { path: string; present: boolean; created: boolean; sha256?: string; bytes?: number; starts?: string }
/** What the harness said of an export: written, or why not (an option it could not set is named). */
export interface IllustratorExportNote { written: boolean; error?: string; skipped?: string; options_not_set?: string[] }
export interface IllustratorReadback {
  mode: IllustratorMode;
  route: 'osascript';
  appName: string;
  /** author, edit: the new .ai */
  saved?: IllustratorFileState;
  exports: { svg?: IllustratorFileState & { harness?: IllustratorExportNote }; pdf?: IllustratorFileState & { harness?: IllustratorExportNote }; png?: IllustratorFileState & { harness?: IllustratorExportNote } };
  /** edit, inspect: the document given, and whether its bytes are as they were at submission */
  source?: { path: string; sha256: string; unchanged: boolean | null };
  harness: { path: string; sha256: string; unchanged: boolean; read?: string };
  /** the document as Illustrator reported it: its own report, not an independent reading */
  report?: IllustratorReport;
  /** Timmy's own reading of the exported SVG (and PNG), against that report */
  check?: IllustratorCheck;
  illustrator_version?: string;
  /** the harness closed what it made or opened */
  closed?: boolean;
  stage?: string;
  error?: string;
  error_line?: number;
  /** the line the harness returned, as osascript printed it */
  status?: string;
  /** what osascript itself reported, exactly, with its code */
  osascript?: { text: string; code: number };
  result_file: string;
}
export interface IllustratorJudgement extends NativeJudgement { illustrator: IllustratorReadback }

const LIVE = new Set(['queued', 'running', 'ready']);

/** The last 64 KB of the job's log, or ''. */
function logTail(logPath: string): string {
  if (!logPath) return '';
  let fd: number | undefined;
  try {
    fd = openSync(logPath, 'r');
    const size = fstatSync(fd).size;
    const n = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    return buf.toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) closeSync(fd); }
}

/** The harness's own line for this run in the log (the last one), or undefined. */
function statusLine(tail: string, run: string): string | undefined {
  const last = tail.split('\n').filter((l) => l.includes(`${ILLUSTRATOR_MARK} ${run}`)).at(-1)?.trim();
  return last ? last.slice(last.indexOf(ILLUSTRATOR_MARK)) : undefined;
}

/** What osascript itself reported, exactly: its last execution or compile error and its code. */
export function osascriptReported(tail: string): { text: string; code: number } | undefined {
  const all = [...tail.matchAll(/(?:execution|syntax) error: (.*?) \((-?\d+)\)/g)];
  const last = all.at(-1);
  return last ? { text: last[1].trim(), code: Number(last[2]) } : undefined;
}

/**
 * osascript's codes that name the step; anything else is quoted as it was reported. -1743 is macOS's refusal to let the
 * app Timmy runs in send Apple events to Illustrator: the operator grants it; Timmy never does, nor opens the settings.
 */
export function osascriptWhy(e: { text: string; code: number }): string {
  if (e.code === -1743) {
    return `macOS did not let osascript control Adobe Illustrator: osascript reported "${e.text}" (-1743). The operator grants this, once: ${AUTOMATION_PLACE}, then under ${HOST_APP} turn on Adobe Illustrator, and run again; Timmy never grants it and never opens System Settings`;
  }
  if (e.code === -1712) return `the Apple event to Illustrator timed out: osascript reported "${e.text}" (-1712), and no result file was written: Illustrator may still be running the script, a dialog may be waiting in it, or the run needs a longer time limit`;
  if (e.code === -2741 || e.code === -2740) return `osascript could not compile the AppleScript that asks Illustrator: it reported "${e.text}" (${e.code}); Timmy asks with "do javascript file" (src/native/illustrator.ts), which this Illustrator may not know`;
  return `osascript reported "${e.text}" (${e.code}), and no result file was written`;
}

/** Whether a file at a path the result names is the file at `want` (both resolved, links followed when there). */
function samePath(named: unknown, want: string): boolean {
  if (typeof named !== 'string' || !named) return false;
  const real = (p: string): string => { try { return realpathSync(p); } catch { return path.resolve(p); } };
  return real(named) === real(want);
}

/** A file this run was to write: there, created during this run (from its state at submission), its sha256 and size now. */
function fileState(t: IllustratorTarget, pre: PreState | undefined, sinceMs: number): IllustratorFileState {
  let s;
  try { s = statSync(t.path); } catch { return { path: t.rel, present: false, created: false }; }
  if (!s.isFile()) return { path: t.rel, present: false, created: false };
  const digest = sha256File(t.path);
  const fresh = s.size > 0 && s.mtimeMs >= sinceMs - MTIME_SLACK_MS;
  const changed = !pre || pre.state !== 'present' || s.size !== pre.size || s.mtimeMs !== pre.mtimeMs || digest !== pre.sha256;
  const starts = fileStart(t.path);
  return { path: t.rel, present: true, created: fresh && changed, ...(digest ? { sha256: digest } : {}), bytes: s.size, ...(starts ? { starts } : {}) };
}

function exportNote(v: unknown): IllustratorExportNote | undefined {
  const n = obj(v);
  if (!n) return undefined;
  return {
    written: n.written === true,
    ...(typeof n.error === 'string' ? { error: n.error.slice(0, 2000) } : {}),
    ...(typeof n.skipped === 'string' ? { skipped: n.skipped.slice(0, 2000) } : {}),
    ...(Array.isArray(n.options_not_set) ? { options_not_set: n.options_not_set.filter((x): x is string => typeof x === 'string').slice(0, 20) } : {}),
  };
}

/** The final judgement as verdicts.jsonl keeps it, with Timmy's reading's verdict beside it. */
interface IllustratorVerdictLine extends NativeVerdictLine { readback?: { verdict: ReadbackVerdict; by: string } }

/** Appends the final judgement to the run's verdicts.jsonl, unless its last line already says the same. */
function appendVerdict(dir: string | undefined, j: IllustratorJudgement, jobId?: string): void {
  if (!dir) return;
  const file = path.join(dir, 'verdicts.jsonl');
  try {
    let last: IllustratorVerdictLine | undefined;
    try {
      const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
      last = lines.length ? JSON.parse(lines[lines.length - 1]) as IllustratorVerdictLine : undefined;
    } catch { /* none yet, or a torn line: a new line follows */ }
    const verdict = j.illustrator.check?.verdict;
    if (last && last.outcome === j.outcome && last.why === j.why && last.job === jobId && last.readback?.verdict === verdict) return;
    const line: IllustratorVerdictLine = {
      judged_at: new Date().toISOString(), ...(jobId ? { job: jobId } : {}), outcome: j.outcome, why: j.why, exit: j.exit, files: j.files,
      ...(verdict ? { readback: { verdict, by: 'Timmy, reading the exported SVG itself' } } : {}),
    };
    appendFileSync(file, `${JSON.stringify(line)}\n`);
  } catch { /* the judgement stands without its record */ }
}

/**
 * A finished Illustrator run, judged: the native module's judgement of the result file and the files (judgeNativeJob,
 * which this calls without letting it record), then this run's own checks, in order:
 *   failed   the harness could not write its result; osascript was refused (-1743, said exactly with how the operator
 *            grants it) or failed with no result; the harness reported ok: false (the stage, the error, its line); the
 *            result names another file as the saved document; the document given changed during the run.
 *   unknown  the harness changed after Timmy wrote it, or Illustrator read a different harness.
 * Beside the outcome, an ok run's export is read by Timmy itself and compared with Illustrator's report (`check`): agrees,
 * or differs with both numbers. Then the final judgement alone is appended to the run's verdicts.jsonl. A job still going is
 * unknown and not recorded.
 */
export function judgeIllustratorJob(job: JobRecord, spec: IllustratorJobSpec): IllustratorJudgement {
  const a = spec.illustrator;
  // An inspect run carries no user script: the code that runs is the harness (kept read-only, checked unchanged after the
  // run and as Illustrator read it); the document it opens is data, checked byte for byte before and after here.
  const { input: _doc, ...noScript } = spec.native;
  const base = judgeNativeJob(job, { ...(a.mode === 'inspect' ? noScript : spec.native), record: undefined });
  const read = spec.native.result ? readNativeResult(spec.native.result) : { state: 'missing' as const };
  const r = read.state === 'read' ? obj(read.data) : undefined;
  const sinceMs = spec.native.submittedMs ?? Date.parse(job.startedAt);
  const harnessNow = sha256File(a.harness.path);
  const harnessRead = typeof r?.harness_sha256_read === 'string' ? r.harness_sha256_read.toLowerCase() : undefined;
  const sourceNow = a.source ? sha256File(a.source.path) : undefined;
  const sourceUnchanged = a.source ? (sourceNow === undefined ? false : sourceNow === a.source.sha256) : null;
  const pre = spec.native.pre ?? {};
  const saved = a.saved ? fileState(a.saved, pre[a.saved.rel], sinceMs) : undefined;
  const ex = obj(r?.exports);
  const svg = { ...fileState(a.exports.svg, pre[a.exports.svg.rel], sinceMs), ...(exportNote(ex?.svg) ? { harness: exportNote(ex?.svg)! } : {}) };
  const pdf = a.exports.pdf ? { ...fileState(a.exports.pdf, pre[a.exports.pdf.rel], sinceMs), ...(exportNote(ex?.pdf) ? { harness: exportNote(ex?.pdf)! } : {}) } : undefined;
  const png = a.exports.png ? { ...fileState(a.exports.png, pre[a.exports.png.rel], sinceMs), ...(exportNote(ex?.png) ? { harness: exportNote(ex?.png)! } : {}) } : undefined;
  const tail = logTail(job.logPath);
  const status = statusLine(tail, spec.native.run);
  const reported = osascriptReported(tail);
  const report = illustratorReport(r?.readback);
  const failedR = r && r.ok !== true;
  const readback: IllustratorReadback = {
    mode: a.mode, route: 'osascript', appName: a.appName,
    ...(saved ? { saved } : {}),
    exports: { svg, ...(pdf ? { pdf } : {}), ...(png ? { png } : {}) },
    ...(a.source ? { source: { path: a.source.rel, sha256: a.source.sha256, unchanged: sourceUnchanged } } : {}),
    harness: { path: a.harness.rel, sha256: a.harness.sha256, unchanged: harnessNow === a.harness.sha256, ...(harnessRead ? { read: harnessRead } : {}) },
    ...(report ? { report } : {}),
    ...(typeof r?.illustrator_version === 'string' ? { illustrator_version: r.illustrator_version.slice(0, 80) } : {}),
    ...(typeof r?.closed === 'boolean' ? { closed: r.closed } : {}),
    ...(failedR && typeof r.stage === 'string' ? { stage: r.stage.slice(0, 40) } : {}),
    ...(failedR && typeof r.error === 'string' ? { error: r.error.slice(0, 2000) } : {}),
    ...(failedR && typeof r.error_line === 'number' ? { error_line: r.error_line } : {}),
    ...(status ? { status } : {}),
    ...(reported ? { osascript: reported } : {}),
    result_file: relTo(spec.root, spec.native.result ?? ''),
  };
  if (!job.stale && LIVE.has(job.state)) return { ...base, illustrator: readback };

  // The exit recorded is osascript's (it asked Illustrator to run the harness).
  const baseWhy = base.why.replace(/\bAdobe Illustrator (?=(?:exited|timed out|was stopped|ended|did not run|was left|wrote no))/g, 'osascript ');
  const exitWords = baseWhy.includes('; ') ? baseWhy.slice(baseWhy.lastIndexOf('; ') + 2) : baseWhy;
  let outcome = base.outcome;
  let why = baseWhy;
  if (read.state === 'missing' && status && /\bresult=not-written\b/.test(status)) {
    outcome = 'failed';
    why = `the harness could not write its result file (${status.replace(/^.*?\breason=/, '') || 'no reason given'}), so it stopped before touching any document: check that the project folder is writable`;
  } else if (read.state === 'missing' && reported) {
    // osascript's own report names the reason; the outcome stays the native module's (no result file).
    why = `${osascriptWhy(reported)}; ${baseWhy}`;
  } else if (read.state === 'missing') {
    why = `${baseWhy}; ${NO_RESULT_HINT}`;
  } else if (r?.stage === 'started' && status && /\bresult=not-written\b/.test(status)) {
    outcome = /\bok=true\b/.test(status) ? 'unknown' : 'failed';
    why = `the harness ended (it said ${/\bok=true\b/.test(status) ? 'ok' : 'not ok'}) but could not write its final result (${status.replace(/^.*?\breason=/, '') || 'no reason given'}), so the result file still holds its first, provisional state; ${baseWhy}`;
  } else if (failedR && r.run === spec.native.run && outcome === 'failed') {
    // The harness's own words: the stage it stopped at, the error and its line.
    why = `the run reported ok: false at its ${String(r.stage ?? 'unknown')} stage: ${String(r.error ?? 'no error given')}${typeof r.error_line === 'number' ? ` (line ${r.error_line})` : ''}; ${exitWords}`;
  }
  if (outcome === 'ok') {
    if (harnessNow !== a.harness.sha256) {
      outcome = 'unknown';
      why = `${a.harness.rel} ${harnessNow ? 'changed' : 'is gone'} since Timmy wrote it, so what ran cannot be bound to this run; ${baseWhy}`;
    } else if (harnessRead && harnessRead !== a.harness.sha256) {
      outcome = 'unknown';
      why = `Illustrator read a harness whose sha256 is not the one Timmy wrote for this run; ${baseWhy}`;
    } else if (a.saved && r && r.saved === true && !samePath(r.saved_path, a.saved.path)) {
      outcome = 'failed';
      why = `the result names ${typeof r.saved_path === 'string' && r.saved_path ? 'another file' : 'no file'} as the saved document, not ${a.saved.rel}; ${baseWhy}`;
    }
  }
  if (a.source && sourceUnchanged === false) {
    outcome = 'failed';
    why = `${a.source.rel} ${sourceNow ? 'changed' : 'is gone'} during the run (its sha256 is not the one recorded at submission): Timmy never writes it, so the script or something else did${a.saved ? `; this run's new version is ${a.saved.rel}` : ''}; ${baseWhy}`;
  }
  // Timmy's own reading of the SVG export, for a run that is ok and whose SVG this run created.
  let check: IllustratorCheck | undefined;
  if (outcome === 'ok' && svg.present && svg.created) {
    const reading = readSvgFile(a.exports.svg.path, { precision: a.svgPrecision });
    check = compareIllustratorReadback(a.exports.svg.rel, reading, report, {
      precision: a.svgPrecision, ...(png?.present && png.created && a.exports.png ? { png: { rel: a.exports.png.rel, abs: a.exports.png.path, scale: a.pngScale } } : {}),
    });
  } else if (outcome === 'ok' && a.mode === 'inspect') {
    check = { verdict: 'not compared', svg: a.exports.svg.rel, why: `Illustrator did not export the SVG Timmy reads${svg.harness?.error ? ` (${svg.harness.error})` : ''}`, notes: [] };
  }
  if (check) readback.check = check;
  if (outcome === 'ok') {
    const made = [svg, pdf, png].filter((f): f is IllustratorFileState => !!f && f.present && f.created).map((f) => path.posix.basename(f.path));
    const list = made.length > 1 ? `${made.slice(0, -1).join(', ')} and ${made.at(-1)}` : made.join('');
    const files = a.saved && saved ? `${a.saved.rel} was created by this run (sha256 ${short(saved.sha256)}, computed by Timmy after the run)${list ? `, with ${list}` : ''}` : `${a.source?.rel} is unchanged`;
    const told = report ? `; Illustrator reported ${report.drawn ? `${report.drawn.shapes} shape${report.drawn.shapes === 1 ? '' : 's'} and ${report.drawn.texts.length} text${report.drawn.texts.length === 1 ? '' : 's'}` : 'its document'} (its own report)` : '';
    const ours = check ? `; Timmy's own reading of the SVG ${check.verdict === 'agrees' ? 'agrees' : check.verdict === 'differs' ? 'differs' : 'was not compared'}` : '';
    why = `the result file is this run's, from ${spec.native.input?.path ?? 'its input'} as submitted, and says ok; ${files}${a.mode === 'edit' && a.source ? `; ${a.source.rel} is unchanged` : ''}${told}${ours}; ${exitWords}`;
  }
  const j: IllustratorJudgement = { ...base, outcome, why, illustrator: readback };
  appendVerdict(spec.native.record, j, job.id);
  return j;
}

/** A judgement as a receipt carries it: the native fields (app illustrator) and the run's own, with project-relative names only. */
export function illustratorReceiptFields(j: IllustratorJudgement): ReturnType<typeof nativeReceiptFields> & { native: { illustrator: Record<string, unknown> } } {
  const base = nativeReceiptFields('illustrator', j);
  const a = j.illustrator;
  const file = (f: IllustratorFileState | undefined) => (f ? { path: f.path, present: f.present, created: f.created, ...(f.sha256 ? { sha256: f.sha256 } : {}), ...(f.bytes !== undefined ? { bytes: f.bytes } : {}) } : undefined);
  const c = a.check;
  return {
    ...base,
    native: {
      ...base.native,
      illustrator: {
        mode: a.mode, route: a.route, app_name: a.appName,
        ...(a.saved ? { saved: file(a.saved) } : {}),
        exports: { svg: file(a.exports.svg), ...(a.exports.pdf ? { pdf: file(a.exports.pdf) } : {}), ...(a.exports.png ? { png: file(a.exports.png) } : {}) },
        ...(a.source ? { source: { ...a.source } } : {}),
        harness_sha256: a.harness.sha256, harness_unchanged: a.harness.unchanged,
        ...(a.illustrator_version ? { illustrator_version: a.illustrator_version } : {}),
        ...(a.report ? {
          report: {
            artboards: a.report.artboards_total ?? a.report.artboards.length, layers: a.report.layers_total ?? a.report.layers.length,
            ...(a.report.drawn ? { shapes: a.report.drawn.shapes, texts: a.report.drawn.texts.length } : {}), reported_by: 'Illustrator, about its own document',
          },
        } : {}),
        ...(c ? {
          readback: {
            verdict: c.verdict, by: 'Timmy, reading the exported SVG itself', svg: c.svg, ...(c.why ? { why: c.why } : {}),
            ...(c.artboard ? { artboard: c.artboard } : {}), ...(c.shapes ? { shapes: c.shapes } : {}),
            ...(c.texts ? { texts: { agrees: c.texts.agrees, illustrator: c.texts.illustrator.length, svg: c.texts.svg.length } } : {}),
            ...(c.bounds ? { bounds: c.bounds } : {}), ...(c.png ? { png: c.png } : {}),
          },
        } : {}),
        ...(a.stage ? { stage: a.stage } : {}),
        ...(a.error_line !== undefined ? { error_line: a.error_line } : {}),
        ...(a.osascript ? { osascript: { code: a.osascript.code } } : {}),
      },
    },
  };
}

// ── after a restart ──────────────────────────────────────────────────────────────

/** A run's spec rebuilt from its folder (job.json and illustrator.json), every name in them checked to lead inside the project. */
export function illustratorSpecFromRecord(root: string, run: string): IllustratorJobSpec {
  const base = realRoot(root);
  const rec = readNativeRecord(base, run);
  if (!rec || rec.job.app !== 'illustrator') throw new Error(`no record of an Illustrator run ${run} in this project`);
  const ir = JSON.parse(readFileSync(path.join(rec.dir, 'illustrator.json'), 'utf8')) as IllustratorRunRecord;
  if (ir.record !== 'timmy-illustrator-run' || ir.run !== run || !ILLUSTRATOR_MODES.includes(ir.mode)) throw new Error(`the record of run ${run} has no Illustrator part (illustrator.json)`);
  const within = (rel: string): string => {
    const at = resolveInside(base, rel);
    if ('error' in at) throw new Error(`the record of run ${run} names ${rel}, which does not lead inside the project: ${at.error}`);
    return at.path;
  };
  const target = (rel: string): IllustratorTarget => ({ path: within(rel), rel });
  const j = rec.job;
  const expect = Array.isArray(j.expect) ? j.expect.filter((n): n is string => typeof n === 'string') : [];
  for (const n of expect) within(n);
  const native: NativeMeta = {
    app: 'illustrator', root: base, run, record: rec.dir, expect, pre: j.pre ?? {}, submittedMs: Date.parse(j.started_at),
    ...(j.result ? { result: within(j.result) } : {}), ...(j.input ? { input: j.input } : {}),
  };
  const meta: IllustratorRunMeta = {
    mode: ir.mode, route: 'osascript', appName: ir.app_name, name: ir.name, ...(ir.version ? { version: ir.version } : {}),
    harness: { path: within(ir.harness.path), rel: ir.harness.path, sha256: ir.harness.sha256 },
    ...(ir.script ? { script: { source: ir.script.source, copy: within(ir.script.copy), copyRel: ir.script.copy, sha256: ir.script.sha256 } } : {}),
    ...(ir.source ? { source: { path: within(ir.source.path), rel: ir.source.path, sha256: ir.source.sha256, bytes: ir.source.bytes } } : {}),
    ...(ir.saved ? { saved: target(ir.saved) } : {}),
    exports: { svg: target(ir.exports.svg), ...(ir.exports.pdf ? { pdf: target(ir.exports.pdf) } : {}), ...(ir.exports.png ? { png: target(ir.exports.png) } : {}) },
    svgPrecision: typeof ir.svg_precision === 'number' ? ir.svg_precision : SVG_PRECISION, pngScale: typeof ir.png_scale === 'number' ? ir.png_scale : PNG_SCALE,
  };
  return { kind: 'task', label: j.label, project: j.project, root: base, command: j.program, args: j.args, timeoutMs: j.timeout_ms, native, illustrator: meta };
}

/**
 * Judges an Illustrator run again from its folder after a restart (or after osascript gave up while Illustrator went on):
 * with the job's record when the caller has it (`job`, or `findJob` given the id its started.json names), else as a run
 * whose exit was not recorded, which never decides.
 */
export function reconcileIllustrator(root: string, run: string, opts: { job?: JobRecord; findJob?: (id: string) => JobRecord | undefined } = {}): IllustratorJudgement {
  const spec = illustratorSpecFromRecord(root, run);
  const rec = readNativeRecord(spec.root, run);
  const found = opts.job ?? (rec?.started && opts.findJob ? opts.findJob(rec.started.job) : undefined);
  const job: JobRecord = found ?? {
    id: rec?.started?.job ?? 'j000000', kind: 'task', label: spec.label, project: spec.project, root: spec.root, command: spec.command, args: spec.args,
    state: 'running', startedAt: rec?.job.started_at ?? new Date(0).toISOString(), steps: [], logPath: '', lines: 0, stale: true,
  };
  return judgeIllustratorJob(job, spec);
}

// ── what the REPL and the agent are told ───────────────────────────────────────────

type Line = Segment[];
const quoteArg = (s: string): string => (/[\s"']/.test(s) ? `"${s.replace(/"/g, '')}"` : s);
const short = (sha: string | undefined): string => (sha ? `${sha.slice(0, 12)}…` : 'none');
const size = (n: number | undefined): string => (n === undefined ? '' : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const n3 = (v: number): string => String(Math.round(v * 1000) / 1000);
const pair = (p: [number, number] | null | undefined, sep = ' × '): string => (p ? `${n3(p[0])}${sep}${n3(p[1])}` : '?');
const box = (b: Rect4 | null | undefined): string => (b ? `(${n3(b[0])}, ${n3(b[1])})–(${n3(b[2])}, ${n3(b[3])})` : 'none');
const quoted = (s: string): string => `"${s.length > 40 ? `${s.slice(0, 40)}…` : s}"`;

/** Said before the run: Illustrator opens its window, the Automation question, what stops a run, and what it will save. */
export function illustratorStartLines(spec: IllustratorJobSpec, sep: string): Line[] {
  const a = spec.illustrator;
  const base = (t: IllustratorTarget | undefined): string => (t ? path.posix.basename(t.rel) : '');
  const saves = a.mode === 'author' ? `${a.saved?.rel}, a new document; ${base(a.exports.svg)} and ${base(a.exports.pdf)} beside it, and ${base(a.exports.png)} when Illustrator's PNG export allows`
    : a.mode === 'edit' ? `${a.saved?.rel}, the next version, with ${base(a.exports.svg)} and ${base(a.exports.pdf)} (and ${base(a.exports.png)} when it can); ${a.source?.rel} is never written`
      : `nothing in the project: it opens ${a.source?.rel} to read it, exports an SVG into the run's folder for Timmy's own reading, and closes it unsaved`;
  return [
    [{ text: '  App        ', role: 'secondary' }, { text: `${a.appName}, asked through osascript (do javascript): it starts, or comes forward, and its window opens; the script runs only inside it`, role: 'estimate' }],
    [{ text: '  Before     ', role: 'secondary' }, { text: `${AUTOMATION_BEFORE}${sep}a document Timmy is to open that is already open in Illustrator stops the run untouched`, role: 'secondary' }],
    [{ text: '  Saves      ', role: 'secondary' }, { text: saves }],
  ];
}

/** Illustrator's report in one line: artboards, layers, shapes and texts, as it reported them. */
export function illustratorReportLine(rep: IllustratorReport | undefined): string {
  if (!rep) return 'nothing reported';
  const ab = svgArtboard(rep);
  const boards = `${rep.artboards_total ?? rep.artboards.length} artboard${(rep.artboards_total ?? rep.artboards.length) === 1 ? '' : 's'}${ab && ab.width !== null && ab.height !== null ? ` (${n3(ab.width)} × ${n3(ab.height)} pt${rep.artboards.length > 1 ? `, #${ab.index}` : ''})` : ''}`;
  const layers = `${rep.layers_total ?? rep.layers.length} layer${(rep.layers_total ?? rep.layers.length) === 1 ? '' : 's'}`;
  const d = rep.drawn;
  const shapes = d ? `${d.shapes} shape${d.shapes === 1 ? '' : 's'}${d.hidden || d.guides || d.clipping ? ` (and ${[d.hidden ? `${d.hidden} hidden` : '', d.guides ? `${d.guides} guide${d.guides === 1 ? '' : 's'}` : '', d.clipping ? `${d.clipping} clipping` : ''].filter(Boolean).join(', ')})` : ''}` : '';
  const texts = d ? (d.texts.length ? `${d.texts.length} text${d.texts.length === 1 ? '' : 's'} ${d.texts.slice(0, 3).map(quoted).join(', ')}${d.texts.length > 3 ? ', …' : ''}` : 'no text') : '';
  return [boards, layers, shapes, texts].filter(Boolean).join(', ');
}

/** Timmy's reading against Illustrator's report, in one line: each part's words, "differs" with both numbers. */
export function illustratorCheckLine(c: IllustratorCheck): string {
  if (c.verdict === 'not compared') return `not compared: ${c.why ?? 'nothing to compare'}`;
  const parts: string[] = [];
  if (c.artboard) parts.push(c.artboard.agrees ? `artboard ${pair(c.artboard.svg)} (${c.artboard.from})` : `artboard differs: Illustrator ${pair(c.artboard.illustrator)}, the SVG ${pair(c.artboard.svg)} (${c.artboard.from})`);
  if (c.shapes) {
    const counts = c.shapes.by_element;
    const by = SVG_SHAPES.filter((k) => counts[k]).map((k) => `${k} ${counts[k]}`).join(', ');
    parts.push(c.shapes.agrees ? `${c.shapes.svg} shape${c.shapes.svg === 1 ? '' : 's'}${by ? ` (${by})` : ''}` : `shapes differ: Illustrator ${c.shapes.illustrator}, the SVG ${c.shapes.svg}${by ? ` (${by})` : ''}`);
  }
  if (c.texts) parts.push(c.texts.agrees ? (c.texts.svg.length ? `text ${c.texts.svg.slice(0, 3).map(quoted).join(', ')}` : 'no text') : `texts differ: Illustrator ${c.texts.illustrator.map(quoted).join(', ') || 'none'}, the SVG ${c.texts.svg.map(quoted).join(', ') || 'none'}`);
  if (c.bounds) {
    parts.push(c.bounds.agrees === null ? `bounds not compared: ${c.bounds.why ?? 'unknown'}` : c.bounds.agrees ? `bounds ${box(c.bounds.svg)}${c.bounds.tolerance !== null ? ` within ±${c.bounds.tolerance}` : ''}` : `bounds differ: Illustrator ${box(c.bounds.illustrator)}, the SVG ${box(c.bounds.svg)} (±${c.bounds.tolerance ?? '?'})`);
  }
  if (c.png) parts.push(c.png.agrees === null ? `PNG not compared: ${c.png.why ?? 'unknown'}` : c.png.agrees ? `PNG ${pair(c.png.size)} px` : `PNG differs: ${pair(c.png.size)} px, the artboard at ${PNG_SCALE} % is ${pair(c.png.expected)}`);
  return `${c.verdict}: ${parts.join('; ')}`;
}

/** The next steps after a good run: edit its next version, or have Illustrator read it back. */
export function illustratorNextSteps(j: IllustratorJudgement, spec: IllustratorJobSpec): string[] {
  const a = spec.illustrator;
  const target = a.mode === 'inspect' ? a.source?.rel : a.saved?.rel;
  if (j.outcome !== 'ok' || !target) return [];
  const steps = [`/illustrator edit ${quoteArg(target)} <script.jsx> saves its next version (the starter's edit.jsx relabels the badge)`];
  if (a.mode !== 'inspect') steps.push(`/illustrator inspect ${quoteArg(target)} has Illustrator read it back, and Timmy its SVG export`);
  return steps;
}

/** Said when the run ends: the outcome, the files with Timmy's sha256, Illustrator's report, Timmy's own reading and the next step. */
export function illustratorEndLines(j: IllustratorJudgement, spec: IllustratorJobSpec, o: { id: string; label: string; glyphs: { ok: string; fail: string }; sep: string; scrub: (s: string) => string; receipt?: string }): Line[] {
  const a = j.illustrator;
  const mark = j.outcome === 'ok' ? o.glyphs.ok : j.outcome === 'failed' ? o.glyphs.fail : '?';
  const lines: Line[] = [[
    { text: `  ${mark} `, role: j.outcome === 'failed' ? 'failure' : undefined },
    { text: `${o.id} ${j.outcome}`, role: j.outcome === 'failed' ? 'failure' : 'strong' },
    { text: `  ${o.label}: ${o.scrub(j.why)}${o.receipt ? `${o.sep}receipt ${o.receipt}` : ''}${o.sep}/results`, role: 'secondary' },
  ]];
  if (a.saved) {
    const how = a.saved.present ? `${a.saved.created ? 'created by this run' : 'not created by this run'}${o.sep}sha256 ${short(a.saved.sha256)} (Timmy's, after the run)${a.saved.bytes !== undefined ? `${o.sep}${size(a.saved.bytes)}` : ''}` : 'not there';
    // The harness saves the new version before the script runs and not again after an error: say what it holds.
    const held = a.saved.present && a.stage === 'script' ? `${o.sep}it holds the document as saved before the script's error` : '';
    lines.push([{ text: '      saved    ', role: 'secondary' }, { text: `${a.saved.path}${o.sep}${how}${held}`, role: a.saved.present && a.saved.created ? undefined : 'failure' }]);
  }
  if (a.mode !== 'inspect') {
    const words = (f: IllustratorReadback['exports']['svg'], optional = false): string | undefined => {
      if (!f) return undefined;
      const name = path.posix.basename(f.path);
      if (f.present && f.created) return `${name} (created, sha256 ${short(f.sha256)}, ${size(f.bytes)})`;
      if (optional && f.harness?.skipped) return `${name}: not exported (${o.scrub(f.harness.skipped)})`;
      if (f.harness?.error) return `${name}: not written (${o.scrub(f.harness.error)})`;
      return f.present ? `${name}: there, not created by this run` : `${name}: not there`;
    };
    const ex = [words(a.exports.svg), words(a.exports.pdf), words(a.exports.png, true)].filter(Boolean).join(o.sep);
    if (ex) lines.push([{ text: '      exports  ', role: 'secondary' }, { text: ex, role: a.exports.svg?.created && a.exports.pdf?.created ? undefined : 'failure' }]);
  }
  if (a.source) {
    lines.push([{ text: '      given    ', role: 'secondary' }, { text: `${a.source.path}${o.sep}${a.source.unchanged ? 'unchanged (sha256 as at submission)' : 'CHANGED during the run'}`, role: a.source.unchanged ? 'secondary' : 'failure' }]);
  }
  if (a.report) {
    lines.push([{ text: '      reported ', role: 'secondary' }, { text: `${o.scrub(illustratorReportLine(a.report))}${o.sep}as Illustrator reported its own document, not an independent reading`, role: 'secondary' }]);
  }
  if (a.check) {
    lines.push([{ text: '      readback ', role: 'secondary' }, { text: `${o.scrub(illustratorCheckLine(a.check))}${o.sep}Timmy's own reading of ${a.check.svg}`, role: a.check.verdict === 'differs' ? 'failure' : undefined }]);
  }
  if (a.error) {
    lines.push([{ text: '      error    ', role: 'secondary' }, { text: `${a.stage ? `at ${a.stage}` : ''}${a.error_line !== undefined ? ` (line ${a.error_line})` : ''}: ${o.scrub(a.error)}${o.sep}${a.result_file}${o.sep}/jobs ${o.id} for the raw output`, role: 'failure' }]);
  } else if (j.outcome !== 'ok') {
    lines.push([{ text: '      look     ', role: 'secondary' }, { text: `${a.result_file}${o.sep}/jobs ${o.id} for the raw output`, role: 'secondary' }]);
  }
  for (const step of illustratorNextSteps(j, spec)) lines.push([{ text: '      next     ', role: 'secondary' }, { text: step }]);
  return lines;
}

/** The agent's note on a started run. */
export function illustratorToolNote(spec: IllustratorJobSpec, jobId: string): string {
  const a = spec.illustrator;
  const files = a.saved ? `${a.saved.rel}, ${a.exports.svg.rel} and ${a.exports.pdf?.rel} having been created by this run (sha256 by Timmy)` : '';
  return [
    `Started, not finished: Adobe Illustrator (${a.appName}, through osascript) starts or comes forward and opens its window to run this run's harness; /jobs ${jobId} follows it.`,
    `It is judged when it ends, by the harness's result file (${relTo(spec.root, spec.native.result ?? '')})${files ? ` and ${files}` : ''}${a.source ? `; ${a.source.rel} must stay unchanged` : ''}; Timmy then reads the SVG export itself and compares it with Illustrator's report (agrees, or differs with both numbers).`,
    'macOS may ask the operator once to allow Automation for Illustrator; Timmy never grants it. A document already open in Illustrator is never touched.',
    a.mode === 'inspect' ? 'What Illustrator reports is its own reading of its file; Timmy\'s reading of the SVG is the independent one.' : 'Do not claim the artwork is made until the job is judged ok.',
  ].join(' ');
}

/** The /illustrator words: undefined when there are none (the usage), an error with the usage, or the run asked for. */
export function parseIllustratorArgs(words: string[]): { mode: IllustratorMode; script?: string; docFile?: string; name?: string } | { error: string } | undefined {
  if (!words.length) return undefined;
  const mode = words[0];
  if (mode !== 'author' && mode !== 'edit' && mode !== 'inspect') return { error: `No /illustrator ${mode}: author, edit or inspect. Usage: ${ILLUSTRATOR_USAGE[0].replace(/\s{2,}.*$/, '')}` };
  const usage = { error: `Usage: ${ILLUSTRATOR_USAGE[ILLUSTRATOR_MODES.indexOf(mode)].replace(/\s{2,}.*$/, '')}` };
  const rest = words.slice(1);
  if (mode === 'author') {
    let name: string | undefined;
    const pos: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--name') { name = rest[++i]; if (!name) return usage; } else if (rest[i].startsWith('--name=')) { name = rest[i].slice('--name='.length); if (!name) return usage; }
      else if (/^--\S/.test(rest[i])) return { error: `No option ${rest[i]}: author takes --name <doc>. ${usage.error}` };
      else pos.push(rest[i]);
    }
    return pos.length === 1 ? { mode, script: pos[0], ...(name ? { name } : {}) } : usage;
  }
  if (mode === 'edit') return rest.length === 2 ? { mode, docFile: rest[0], script: rest[1] } : usage;
  return rest.length === 1 ? { mode, docFile: rest[0] } : usage;
}

/** What /illustrator says a run will do, in a few words (its Running line). */
export function illustratorWhat(p: { mode: IllustratorMode; script?: string; docFile?: string }): string {
  return p.mode === 'author' ? `Illustrator makes a document from ${p.script}` : p.mode === 'edit' ? `Illustrator edits the next version of ${p.docFile} with ${p.script}` : `Illustrator reads ${p.docFile} back`;
}
