/**
 * After Effects authoring and editing as Timmy jobs (round R4, helper H23). aerender (src/native/index.ts)
 * renders an EXISTING project; it cannot make or change one. After Effects is scripted (ExtendScript, .jsx)
 * only through the application itself, so each run starts it, or brings it forward, and its window opens:
 *
 *   macOS    osascript -e 'with timeout of N seconds' -e 'tell application "<app>" to DoScriptFile "<harness.jsx>"' -e 'end timeout'
 *   Windows  AfterFX.exe -r <harness.jsx>   (also any After Effects program that is not inside a .app bundle)
 *
 * Each run keeps its own folder, .timmy/native/<run>/ (the native module's record: job.json, started.json,
 * verdicts.jsonl), and this module adds to it:
 *   harness.jsx  generated for this run, read-only, its sha256 recorded. It makes a new project (author), or
 *                opens the given one and at once saves it as a new version (edit), or opens it only to read it
 *                (inspect); runs the script inside try/catch; saves; reads the comps and layers back; and writes
 *                result.json. It reads the preference that lets scripts write files and never changes it; it
 *                stops before touching a project open with unsaved changes; it never saves over the project it
 *                was given.
 *   script.*     the script as submitted, copied byte for byte, read-only: the copy is what runs, and the
 *                harness hashes it as After Effects reads it (script_sha256_read).
 *   ae.json      this module's record of the run: mode, route, the harness's and the inputs' sha256, the new version.
 *   result.json  written by the harness: this run's token, the input's sha256 echoed, ok, the saved project's path,
 *                the comps (name, size, duration, fps, layers, keyframe counts), an error with its stage and line.
 *                R4 (H41): also each comp's work area, and each layer's in and out points, what decides how it is drawn
 *                (enabled, 3D, parent, effect and mask counts, blending, track matte), the keyframes of Position, Scale,
 *                Opacity, Rotation and Anchor Point as [time, value] with each key's interpolation (and spatial tangents),
 *                or their value when they have none (at most 50 keys per property, 5000 in all), and a solid's colour
 *                [r, g, b] in 0..1 and size. Read with the scripting guide's names; added after the first real runs, so
 *                exercised on the stand-in only (see below).
 *
 * Judged first by the native module's own rules (judgeNativeJob: the result is this run's, echoes the input's
 * sha256 as submitted and says ok; the new version was created during this run, not reused), then here: the
 * harness is unchanged, the saved project is the one this run was to write (its sha256 computed by Timmy after
 * the run, never by the script), and a project given to edit or inspect is byte for byte as it was. What the
 * result says of comps and layers is After Effects' own report of its own project, not an independent reading.
 *
 * The operator ran this route on a Mac with After Effects 2026 (round R4): /ae author, /ae inspect and /ae edit of the
 * starter were judged ok there. The harness's R4 (H41) additions (work areas, in and out points, transform keyframes,
 * solid colours) came after those runs and have run only here: tests/native-ae-author.test.ts runs the generated harness
 * on a stand-in of After Effects' scripting objects (tests/fixtures/fake-afterfx.mjs, a labelled test double).
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { JobRecord } from '../jobs/index.js';
import { resolveInside } from '../project/index.js';
import type { Segment } from '../term/theme.js';
import {
  judgeNativeJob, listNativeRuns, locateNative, NATIVE_APPS, NATIVE_RUNS_DIR, NativeNotFound, nativeReceiptFields, preStates, readNativeRecord, readNativeResult,
  sha256File, writeSubmission, type FinderSeams, type NativeJobSpec, type NativeJudgement, type NativeMeta, type NativeVerdictLine, type PreState,
} from './index.js';
import { AUTOMATION_PLACE, HOST_APP } from './automation-words.js';

type Env = Record<string, string | undefined>;

export type AeMode = 'author' | 'edit' | 'inspect';
export const AE_MODES: readonly AeMode[] = ['author', 'edit', 'inspect'];
/** osascript asks the running (or starting) application; binary starts the program with -r. */
export type AeRoute = 'osascript' | 'binary';
/** Where new versions are saved, relative to the project. */
export const AE_OUT_DIR = 'out/ae';
/** The first word of the line the harness returns: osascript prints it, the job's log keeps it. */
export const AE_MARK = 'TIMMY-AE';
/**
 * What the harness reads back at most ("where cheap"), and the largest file it hashes inside After Effects. R4 (H41): the
 * keyframes it reports of Position, Scale, Opacity, Rotation and Anchor Point, at most 50 per property and 5000 in all.
 */
export const AE_LIMITS = { comps: 200, layers: 300, props_per_layer: 400, props_total: 30000, depth: 6, hash_bytes: 4 * 1024 * 1024, keys_per_prop: 50, keys_total: 5000 } as const;

const SCRIPT_EXT = /\.(jsx|jsxbin|js)$/i;
const PROJECT_EXT = /\.(aep|aepx)$/i;
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const MTIME_SLACK_MS = 2000;
const RUN_DIR = NATIVE_RUNS_DIR.split(path.sep).join('/');

const PREF = '"Allow Scripts to Write Files and Access Network"';
const PREF_WHERE = 'After Effects > Settings (Preferences in older versions) > Scripting & Expressions; on Windows, Edit > Preferences > Scripting & Expressions';
/** The exact step when After Effects says scripts may not write files. */
export const AE_PREF_OFF = `After Effects reports its ${PREF} setting off and the harness could not write its result file, so it stopped before touching any project: turn that setting on (${PREF_WHERE}), then run again; Timmy never changes it`;
const NO_RESULT_HINT = `possible causes, not checked: a dialog in After Effects waiting for a person, After Effects quitting, or its ${PREF} setting off (${PREF_WHERE}); the raw output is in the job's log`;

/** The usage lines /ae shows. */
export const AE_USAGE = [
  '/ae author <script.jsx> [--name <project>]   After Effects writes a new project: out/ae/<project>-v<N>.aep',
  '/ae edit <project.aep> <script.jsx>          a new version is saved; the project given is never written',
  '/ae inspect <project.aep>                    After Effects reads a project back (its own reader, not an independent one)',
  '/ae <project.aep> <comp> <output file> [--om <template>]   renders an existing project with aerender',
];
/**
 * R4 (H41): what /ae's usage says of --om and of the file aerender writes. Template names are After Effects' own; aerender's
 * output module decides the container, so a file of the output's name with another extension is judged in its place.
 */
export const AE_RENDER_NOTES = [
  '--om <template> is passed to aerender as -OMtemplate <template>: the names are After Effects\' own output module templates, which differ by version and language; Timmy does not check them',
  'the output module decides the container: when aerender writes the output\'s name with another extension (asked for .mov, it wrote .mp4), that one file, made by the run, is judged in its place',
];

/** R4 (H41): `/ae <project.aep> <comp> <output file> [--om <template>]`, read; an error says the usage. */
export function parseAeRenderArgs(words: string[]): { projectFile: string; comp: string; output: string; omTemplate?: string } | { error: string } {
  const usage = { error: `Usage: ${AE_USAGE[3].replace(/\s{2,}.*$/, '')}` };
  const pos: string[] = [];
  let om: string | undefined;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === '--om') {
      om = words[++i];
      if (om === undefined || !om.trim()) return { error: `--om needs an output module template's name (After Effects' own name, as its Output Module menu shows it). ${usage.error}` };
    } else if (w.startsWith('--om=')) {
      om = w.slice('--om='.length);
      if (!om.trim()) return { error: `--om needs an output module template's name (After Effects' own name, as its Output Module menu shows it). ${usage.error}` };
    } else if (/^--\S/.test(w)) return { error: `No option ${w}: the render form takes --om <template>. ${usage.error}` };
    else pos.push(w);
  }
  if (pos.length !== 3) return usage;
  return { projectFile: pos[0], comp: pos[1], output: pos[2], ...(om !== undefined ? { omTemplate: om } : {}) };
}

// ── finding After Effects and how to ask it ──────────────────────────────────────

/** The .app bundle an executable sits in (its name is what AppleScript's `tell application` takes), or undefined. */
export function appBundleName(file: string): string | undefined {
  const parts = file.split(/[\\/]+/);
  for (let i = parts.length - 1; i >= 0; i--) if (/\.app$/i.test(parts[i]) && parts[i].length > 4) return parts[i].slice(0, -4);
  return undefined;
}

/** macOS with the program inside an application bundle: osascript asks it by name; otherwise the program runs with -r. */
export function aeRouteFor(program: string, platform: NodeJS.Platform = process.platform): { route: AeRoute; appName?: string } {
  const appName = platform === 'darwin' ? appBundleName(program) : undefined;
  return appName ? { route: 'osascript', appName } : { route: 'binary' };
}

const appleString = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** osascript's arguments: DoScriptFile inside a timeout of its own (an Apple event otherwise gives up after 2 minutes). */
export function osascriptArgs(appName: string, harness: string, seconds: number): string[] {
  return ['-e', `with timeout of ${Math.max(1, Math.floor(seconds))} seconds`, '-e', `tell application ${appleString(appName)} to DoScriptFile ${appleString(harness)}`, '-e', 'end timeout'];
}

// ── the harness ──────────────────────────────────────────────────────────────────

/** What one run's harness is told, baked into it (After Effects does not pass a job's environment to a script). */
export interface AeHarnessConfig {
  v: 1;
  run: string;
  mode: AeMode;
  /** the project folder, as After Effects should open paths in it */
  root: string;
  result: string;
  /** the run's copy of the script (author, edit) */
  script: string | null;
  /** the folder of the script as submitted, for a script that finds files beside it (TIMMY.scriptDir) */
  script_dir: string | null;
  /** the sha256 of this run's input as Timmy recorded it at submission: the script, or for inspect the project */
  input_sha256: string;
  /** edit, inspect: the project given */
  open: string | null;
  open_rel: string | null;
  /** author, edit: the new version */
  save: string | null;
  save_rel: string | null;
  limits: typeof AE_LIMITS;
}

const HARNESS_HEAD = String.raw`// Timmy: After Effects harness, generated for one run by src/native/ae-author.ts. Do not edit: its sha256 is
// recorded, and a changed harness is not the run's. It runs inside After Effects (osascript DoScriptFile, or -r).
// It reads the preference that lets scripts write files and never changes it; it stops before touching a project
// open with unsaved changes; it never saves over a project it was given; it writes this run's result file.
// ExtendScript (ES3): no JSON, let, const, arrow functions or Array.forEach here.
`;

const HARNESS_BODY = String.raw`  var LIM = T.limits;
  var R = {
    timmy_ae: 1, ok: false, run: T.run, mode: T.mode, script_sha256: T.input_sha256, files: {},
    stage: 'started', error: 'the harness started and did not finish: After Effects stopped, or was stopped, before the run ended',
    started_at: iso(new Date())
  };
  return main();

  function main() {
    var head = 'TIMMY-AE ' + T.run;
    var suppressed = false;
    var failed = false;
    var ours = false;
    try { app.beginSuppressDialogs(); suppressed = true; } catch (e0) {}
    R.dialogs_suppressed = suppressed;
    try { R.ae_version = String(app.version); } catch (e1) {}
    var pref = writePreference();
    R.write_preference = pref === 1 ? 'on' : (pref === 0 ? 'off' : 'unknown');
    var probe = writeText(T.result, toJSON(R));
    if (probe !== '') {
      endDialogs(suppressed);
      return head + ' ok=false result=not-written write-preference=' + R.write_preference + ' reason=' + oneLine(probe);
    }
    function fail(stage, e) {
      failed = true;
      R.ok = false;
      R.stage = stage;
      R.error = describe(e);
      var ln = lineOf(e);
      if (ln !== null) R.error_line = ln;
    }
    try {
      R.stage = 'input';
      if (T.script) R.script_sha256_read = hashFile(T.script);
      R.harness_sha256_read = selfHash();
      R.stage = 'guard';
      var dirty = projectDirty();
      R.open_project_dirty = dirty;
      if (dirty === true) throw new Error('After Effects has a project open with unsaved changes; Timmy neither saves nor closes it: save or close it in After Effects, then run again');
      R.stage = 'project';
      if (T.mode === 'author') {
        if (!app.newProject()) throw new Error('After Effects did not make a new project');
        ours = true;
        saveTo(T.save, T.save_rel);
      } else {
        if (!app.open(new File(T.open))) throw new Error('After Effects did not open ' + T.open_rel);
        ours = true;
        if (T.mode === 'edit') saveTo(T.save, T.save_rel);
      }
      if (T.mode !== 'inspect') {
        R.stage = 'script';
        $.global.TIMMY = { v: 1, run: T.run, mode: T.mode, root: T.root, scriptDir: T.script_dir, saveTo: T.save, source: T.open };
        try { $.evalFile(new File(T.script)); } catch (es) { fail('script', es); }
        if (!failed) {
          R.stage = 'save';
          saveTo(T.save, T.save_rel);
          R.saved = true;
        }
      }
    } catch (e2) {
      fail(R.stage, e2);
    }
    if (ours) {
      try { readback(); } catch (e3) { R.readback_error = describe(e3); }
      if (T.mode === 'inspect') {
        try { app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); R.closed_unsaved = true; } catch (e4) { R.closed_unsaved = false; }
      }
    }
    if (!failed) {
      R.ok = true;
      R.stage = 'done';
      delete R.error;
    }
    R.ended_at = iso(new Date());
    var wrote = writeText(T.result, toJSON(R));
    endDialogs(suppressed);
    return head + ' ok=' + (R.ok ? 'true' : 'false') + (wrote === '' ? ' result=written' : ' result=not-written reason=' + oneLine(wrote));
  }

  function endDialogs(suppressed) {
    if (!suppressed) return;
    try { app.endSuppressDialogs(false); } catch (e) {}
  }

  function writePreference() {
    var sections = ['Main Pref Section', 'Main Pref Section v2'];
    for (var i = 0; i < sections.length; i++) {
      try {
        var v = app.preferences.getPrefAsLong(sections[i], 'Pref_SCRIPTING_FILE_NETWORK_SECURITY');
        if (v === 1) return 1;
        if (v === 0) return 0;
      } catch (e) {}
    }
    return -1;
  }

  function projectDirty() {
    try {
      var p = app.project;
      if (!p) return false;
      if (p.dirty === true) return true;
      if (p.dirty === false) return false;
    } catch (e) {}
    return null;
  }

  function saveTo(p, rel) {
    var f = new File(p);
    var done = app.project.save(f);
    if (done === false) throw new Error('After Effects did not save the project as ' + rel);
    if (!new File(p).exists) throw new Error('After Effects reported the project saved, but there is no file at ' + rel);
  }

  function readback() {
    var p = app.project;
    var f = null;
    try { f = p.file; } catch (e0) {}
    R.project = { path: f ? String(f.fsName) : null, saved: R.saved === true };
    var budget = { left: LIM.props_total, truncated: false, keys: LIM.keys_total, keys_truncated: false };
    var comps = [];
    var n = 0;
    try { n = p.numItems; } catch (e1) { n = 0; }
    R.items = n;
    for (var i = 1; i <= n; i++) {
      var it = null;
      try { it = p.item(i); } catch (e2) { continue; }
      if (!isComp(it)) continue;
      if (comps.length >= LIM.comps) { R.comps_truncated = true; break; }
      comps.push(readComp(it, budget));
    }
    R.comps = comps;
    if (budget.truncated) R.keyframes_truncated = true;
    if (budget.keys_truncated) R.transform_keys_truncated = true;
  }

  function isComp(it) {
    try { return typeof CompItem !== 'undefined' && it instanceof CompItem; } catch (e) { return false; }
  }

  function readComp(c, budget) {
    var info = {
      name: get(c, 'name'), width: get(c, 'width'), height: get(c, 'height'), pixel_aspect: get(c, 'pixelAspect'),
      duration: get(c, 'duration'), fps: get(c, 'frameRate'), num_layers: get(c, 'numLayers'), layers: []
    };
    var was = get(c, 'workAreaStart');
    var wad = get(c, 'workAreaDuration');
    if (typeof was === 'number' && typeof wad === 'number') info.work_area = [was, wad];
    var n = typeof info.num_layers === 'number' ? info.num_layers : 0;
    for (var i = 1; i <= n; i++) {
      if (i > LIM.layers) { info.layers_truncated = true; break; }
      var l = null;
      try { l = c.layer(i); } catch (e) { continue; }
      if (!l) continue;
      var li = { index: i, name: get(l, 'name'), kind: kindOf(l) };
      var keys = [];
      var local = { left: LIM.props_per_layer, truncated: false };
      walk(l, '', '', 0, keys, budget, local);
      if (keys.length) li.keyframes = keys;
      if (local.truncated) li.keyframes_truncated = true;
      if (li.kind === 'text') {
        var t = textOf(l);
        if (t !== null) li.text = t;
      }
      layerFacts(l, li, budget);
      info.layers.push(li);
    }
    return info;
  }

  // R4 (H41): a layer's in and out points, what decides where it is drawn, its transform's keyframes, a solid's colour.
  function layerFacts(l, li, budget) {
    li.in_point = get(l, 'inPoint');
    li.out_point = get(l, 'outPoint');
    var en = get(l, 'enabled');
    if (en !== null) li.enabled = en;
    var td = get(l, 'threeDLayer');
    if (td !== null) li.three_d = td;
    try { if (l.parent) li.parent = String(l.parent.name); } catch (e0) {}
    var fx = countOf(l, 'ADBE Effect Parade');
    if (fx !== null) li.effects = fx;
    var mk = countOf(l, 'ADBE Mask Parade');
    if (mk !== null) li.masks = mk;
    try { if (typeof BlendingMode !== 'undefined' && typeof l.blendingMode === 'number') li.blending = l.blendingMode === BlendingMode.NORMAL ? 'normal' : 'other'; } catch (e1) {}
    try { if (typeof TrackMatteType !== 'undefined' && typeof l.trackMatteType === 'number') li.track_matte = l.trackMatteType !== TrackMatteType.NO_TRACK_MATTE; } catch (e2) {}
    var tf = transformOf(l, budget);
    if (tf) li.transform = tf;
    if (li.kind === 'solid') {
      try {
        var col = valueOf(l.source.mainSource.color);
        if (col && col.length === 3) li.color = col;
      } catch (e3) {}
      try {
        var s = l.source;
        if (typeof s.width === 'number' && typeof s.height === 'number') li.size = [s.width, s.height];
      } catch (e4) {}
    }
  }

  function countOf(l, match) {
    try {
      var g = l.property(match);
      return g && typeof g.numProperties === 'number' ? g.numProperties : null;
    } catch (e) { return null; }
  }

  function transformOf(l, budget) {
    var g = null;
    try { g = l.property('ADBE Transform Group'); } catch (e0) { return null; }
    if (!g) return null;
    var want = [['position', 'ADBE Position'], ['scale', 'ADBE Scale'], ['opacity', 'ADBE Opacity'], ['rotation', 'ADBE Rotate Z'], ['anchor', 'ADBE Anchor Point']];
    var out = {};
    var any = false;
    for (var i = 0; i < want.length; i++) {
      var p = null;
      try { p = g.property(want[i][1]); } catch (e1) { p = null; }
      if (!p) continue;
      out[want[i][0]] = keyed(p, budget);
      any = true;
    }
    return any ? out : null;
  }

  // A property's value (no keyframes), or its keyframes as [time, value], their interpolation and, when spatial, tangents.
  function keyed(p, budget) {
    var r = {};
    var n = 0;
    try { n = p.numKeys; } catch (e0) { n = 0; }
    if (typeof n !== 'number' || n < 0) n = 0;
    try { if (p.dimensionsSeparated === true) r.separated = true; } catch (e1) {}
    if (n === 0) {
      try { r.value = valueOf(p.value); } catch (e2) { r.value = null; }
      return r;
    }
    r.num_keys = n;
    var spatial = false;
    try { spatial = p.isSpatial === true; } catch (e3) {}
    var keys = [];
    var interp = [];
    var tangents = [];
    var m = n < LIM.keys_per_prop ? n : LIM.keys_per_prop;
    for (var k = 1; k <= m; k++) {
      if (budget.keys <= 0) { budget.keys_truncated = true; break; }
      budget.keys--;
      var t = null;
      var v = null;
      try { t = p.keyTime(k); } catch (e4) {}
      try { v = valueOf(p.keyValue(k)); } catch (e5) {}
      keys.push([typeof t === 'number' && isFinite(t) ? t : null, v]);
      interp.push([interpOf(p, 'keyInInterpolationType', k), interpOf(p, 'keyOutInterpolationType', k)]);
      if (spatial) tangents.push([tangentOf(p, 'keyInSpatialTangent', k), tangentOf(p, 'keyOutSpatialTangent', k)]);
    }
    r.keys = keys;
    r.interpolation = interp;
    if (spatial) r.spatial_tangents = tangents;
    if (keys.length < n) r.keys_truncated = true;
    return r;
  }

  function interpOf(p, fn, k) {
    try {
      if (typeof KeyframeInterpolationType === 'undefined') return null;
      var v = p[fn](k);
      if (v === KeyframeInterpolationType.LINEAR) return 'linear';
      if (v === KeyframeInterpolationType.BEZIER) return 'bezier';
      if (v === KeyframeInterpolationType.HOLD) return 'hold';
    } catch (e) {}
    return null;
  }

  function tangentOf(p, fn, k) {
    try { return valueOf(p[fn](k)); } catch (e) { return null; }
  }

  // A number, a boolean, or an array of at most 4 numbers (a point, a size, a colour); anything else is null.
  function valueOf(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'boolean') return v;
    if (v && typeof v === 'object' && typeof v.length === 'number' && v.length > 0 && v.length <= 4) {
      var out = [];
      for (var i = 0; i < v.length; i++) out.push(typeof v[i] === 'number' && isFinite(v[i]) ? v[i] : null);
      return out;
    }
    return null;
  }

  function walk(g, prefix, mprefix, depth, out, budget, local) {
    var n = 0;
    try { n = g.numProperties; } catch (e0) { return; }
    for (var i = 1; i <= n; i++) {
      if (budget.left <= 0) { budget.truncated = true; return; }
      if (local.left <= 0) { local.truncated = true; return; }
      budget.left--;
      local.left--;
      var p = null;
      try { p = g.property(i); } catch (e1) { continue; }
      if (!p) continue;
      var nm = String(get(p, 'name'));
      var mn = String(get(p, 'matchName'));
      var at = prefix ? prefix + ' > ' + nm : nm;
      var mat = mprefix ? mprefix + '/' + mn : mn;
      var type = null;
      try { type = p.propertyType; } catch (e2) {}
      if (type === PropertyType.PROPERTY) {
        var k = 0;
        try { k = p.numKeys; } catch (e3) { k = 0; }
        if (k > 0) out.push({ path: at, match: mat, keys: k });
      } else if (depth + 1 < LIM.depth) {
        walk(p, at, mat, depth + 1, out, budget, local);
      }
    }
  }

  function kindOf(l) {
    try { if (typeof TextLayer !== 'undefined' && l instanceof TextLayer) return 'text'; } catch (e0) {}
    try { if (typeof ShapeLayer !== 'undefined' && l instanceof ShapeLayer) return 'shape'; } catch (e1) {}
    try { if (typeof CameraLayer !== 'undefined' && l instanceof CameraLayer) return 'camera'; } catch (e2) {}
    try { if (typeof LightLayer !== 'undefined' && l instanceof LightLayer) return 'light'; } catch (e3) {}
    try { if (l.nullLayer === true) return 'null'; } catch (e4) {}
    try { if (l.adjustmentLayer === true) return 'adjustment'; } catch (e5) {}
    try {
      var s = l.source;
      if (s) {
        if (typeof CompItem !== 'undefined' && s instanceof CompItem) return 'precomp';
        if (s.mainSource && typeof SolidSource !== 'undefined' && s.mainSource instanceof SolidSource) return 'solid';
        return 'footage';
      }
    } catch (e6) {}
    return 'layer';
  }

  function textOf(l) {
    try {
      var s = String(l.property('ADBE Text Properties').property('ADBE Text Document').value.text);
      return s.length > 200 ? s.substring(0, 200) + '...' : s;
    } catch (e) { return null; }
  }

  function get(o, k) {
    try {
      var v = o[k];
      return (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') ? v : null;
    } catch (e) { return null; }
  }

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
      else if (typeof e === 'object' && e.message !== undefined) m = (e.name ? e.name + ': ' : '') + e.message;
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

/** One run's harness: plain ES3 for ExtendScript, its configuration on the line marked timmy-ae-config. */
export function aeHarness(config: AeHarnessConfig): string {
  return `${HARNESS_HEAD}(function (T) {\n${HARNESS_BODY}\n}(\n/* timmy-ae-config */ ${asciiJson(config)}\n));\n`;
}

/** The configuration baked into a harness (what tests and a reader of the run's folder see). */
export function aeHarnessConfig(text: string): AeHarnessConfig | undefined {
  const m = /^\/\* timmy-ae-config \*\/ (\{.*\})$/m.exec(text);
  if (!m) return undefined;
  try { return JSON.parse(m[1]) as AeHarnessConfig; } catch { return undefined; }
}

// ── a run ────────────────────────────────────────────────────────────────────────

export interface AeScriptJobInput {
  mode: AeMode;
  /** author, edit: the script, relative to root (.jsx, .jsxbin or .js) */
  script?: string;
  /** edit, inspect: the project, relative to root (.aep or .aepx) */
  projectFile?: string;
  /** author: the new project's name (default: the script's); its versions are out/ae/<name>-v<N>.aep */
  name?: string;
  root: string;
  project: string;
  timeoutMs?: number;
  /** the After Effects program (default: found by locateNative('afterfx'), TIMMY_AFTERFX first) */
  bin?: string;
  /** added to the job's environment */
  env?: NodeJS.ProcessEnv;
  /** where the finder looks (default: this process's environment with `env` over it) */
  findEnv?: Env;
  seams?: FinderSeams;
  /** default process.platform: on macOS a program inside a .app bundle is asked through osascript */
  platform?: NodeJS.Platform;
  /** the osascript program (default: osascript on PATH) */
  osascript?: string;
  label?: string;
}

/** What judging a run needs beyond the native module's meta, carried on its spec and in its ae.json. */
export interface AeRunMeta {
  mode: AeMode;
  route: AeRoute;
  appName?: string;
  name: string;
  version?: number;
  harness: { path: string; rel: string; sha256: string };
  script?: { source: string; copy: string; copyRel: string; sha256: string };
  source?: { path: string; rel: string; sha256: string; bytes: number };
  saved?: { path: string; rel: string };
}
export interface AeJobSpec extends NativeJobSpec { ae: AeRunMeta }

export function isAeJobSpec(spec: unknown): spec is AeJobSpec {
  return Boolean(spec && typeof spec === 'object' && 'ae' in spec && 'native' in spec && (spec as { native?: { app?: unknown } }).native?.app === 'afterfx');
}

/** ae.json: this module's part of a run's record, written once at submission. Paths relative to the project. */
interface AeRunRecord {
  record: 'timmy-ae-run';
  v: 1;
  run: string;
  mode: AeMode;
  route: AeRoute;
  app_name?: string;
  name: string;
  version?: number;
  harness: { path: string; sha256: string };
  script?: { source: string; copy: string; sha256: string };
  source?: { path: string; sha256: string; bytes: number };
  saved?: string;
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

function readInput(root: string, rel: string, kind: string): { path: string; rel: string; bytes: Buffer; sha256: string } {
  const at = inside(root, rel);
  let bytes: Buffer;
  try {
    if (!statSync(at.path).isFile()) throw new Error('not a file');
    bytes = readFileSync(at.path);
  } catch { throw new Error(`no ${kind} at ${at.rel}`); }
  return { ...at, bytes, sha256: sha256(bytes) };
}

/** A file name for a project: letters, digits, dot, dash and underscore; no version suffix (-v<N>), which Timmy adds. */
export function aeStem(name: string): string {
  const s = path.basename(name.trim().replace(/\\/g, '/'))
    .replace(PROJECT_EXT, '').replace(SCRIPT_EXT, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').replace(/-v\d+$/i, '').slice(0, 80);
  return s || 'project';
}

/** The next free version of a name in out/ae: past every file there and every name another run of this project will write. */
function nextVersion(root: string, stem: string, ext: '.aep' | '.aepx'): { path: string; rel: string; version: number } {
  const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${esc}-v(\\d+)\\.aepx?$`, 'i');
  const taken = [0];
  for (const name of listDir(path.join(root, ...AE_OUT_DIR.split('/')))) {
    const m = pattern.exec(name);
    if (m) taken.push(Number(m[1]));
  }
  for (const r of listNativeRuns(root)) {
    if (r.app !== 'afterfx') continue;
    for (const e of readNativeRecord(root, r.run)?.job.expect ?? []) {
      const m = path.posix.dirname(e) === AE_OUT_DIR ? pattern.exec(path.posix.basename(e)) : null;
      if (m) taken.push(Number(m[1]));
    }
  }
  const version = Math.max(...taken) + 1;
  const at = inside(root, `${AE_OUT_DIR}/${stem}-v${version}${ext}`);
  return { ...at, version };
}

const pidAlive = (pid: unknown): boolean => {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/**
 * After Effects runs one script at a time, and a second run would replace the first one's project: refused while
 * another After Effects script run of this project started, is not judged, its process is there and its time
 * limit has not passed (another project's runs are not visible here).
 */
function refuseBusy(root: string, now: number): void {
  for (const r of listNativeRuns(root)) {
    if (r.app !== 'afterfx' || r.verdicts.length) continue;
    const rec = readNativeRecord(root, r.run);
    if (!rec?.started) continue;
    if (rec.started.pid !== undefined && !pidAlive(rec.started.pid)) continue;
    const until = Date.parse(rec.job.started_at) + rec.job.timeout_ms + 60_000;
    if (!(until > now)) continue;
    throw new Error(`another After Effects script run (${r.run.slice(0, 8)}, job ${rec.started.job}, started ${rec.job.started_at}) has not been judged yet; After Effects runs one script at a time and a second would replace its project: wait for it, or /stop ${rec.started.job}`);
  }
}

function findProgram(input: AeScriptJobInput): string {
  if (input.bin) return input.bin;
  const { found, problem } = locateNative('afterfx', input.findEnv ?? { ...process.env, ...input.env }, input.seams ?? {});
  if (!found) throw new NativeNotFound('afterfx', NATIVE_APPS.afterfx.setup, problem);
  return found.path;
}

function labelOf(mode: AeMode, script: string | undefined, source: string | undefined, saved: string | undefined): string {
  if (mode === 'author') return `After Effects · author ${script} → ${saved}`;
  if (mode === 'edit') return `After Effects · edit ${source} with ${script} → ${saved}`;
  return `After Effects · inspect ${source}`;
}

/**
 * A task job that has After Effects run this run's harness: through osascript on macOS (After Effects starts, or
 * comes forward, and its window opens), or `<program> -r <harness>` elsewhere. Making the spec writes the run's
 * folder: the script's copy, the harness, ae.json and the native module's job.json. Nothing is written in the
 * project outside .timmy/native/<run>/ except out/ae/, made for the new version.
 */
export function aeScriptJob(input: AeScriptJobInput): AeJobSpec {
  const mode = input.mode;
  if (!AE_MODES.includes(mode)) throw new Error(`no After Effects mode ${String(mode)}: author, edit or inspect`);
  const root = realRoot(input.root);
  let script: { path: string; rel: string; bytes: Buffer; sha256: string } | undefined;
  if (mode !== 'inspect') {
    if (!input.script) throw new Error(`/ae ${mode} needs a script (.jsx)`);
    script = readInput(root, input.script, 'script');
    if (!SCRIPT_EXT.test(script.rel)) throw new Error(`${script.rel} is not an After Effects script (.jsx, .jsxbin or .js)`);
  }
  let source: { path: string; rel: string; sha256: string; bytes: number } | undefined;
  if (mode !== 'author') {
    if (!input.projectFile) throw new Error(`/ae ${mode} needs the project (.aep or .aepx)`);
    const at = inside(root, input.projectFile);
    if (!PROJECT_EXT.test(at.rel)) throw new Error(`${at.rel} is not an After Effects project (.aep or .aepx)`);
    let bytes = -1;
    try { const s = statSync(at.path); if (s.isFile()) bytes = s.size; } catch { /* missing */ }
    if (bytes < 0) throw new Error(`no project file at ${at.rel}`);
    const digest = sha256File(at.path);
    if (!digest) throw new Error(`${at.rel} cannot be read`);
    source = { ...at, sha256: digest, bytes };
  }
  const program = findProgram(input);
  const { route, appName } = aeRouteFor(program, input.platform ?? process.platform);
  const submittedMs = Date.now();
  refuseBusy(root, submittedMs);

  const name = mode === 'author' ? aeStem(input.name ?? path.basename(script!.rel)) : aeStem(path.basename(source!.rel));
  const saved = mode === 'inspect' ? undefined : nextVersion(root, name, mode === 'edit' && /\.aepx$/i.test(source!.rel) ? '.aepx' : '.aep');
  const run = randomUUID();
  const record = path.join(root, NATIVE_RUNS_DIR, run);
  mkdirSync(record, { recursive: true });
  if (saved) mkdirSync(path.dirname(saved.path), { recursive: true });

  // The script as submitted, byte for byte and read-only: the copy is what After Effects runs.
  let scriptMeta: AeRunMeta['script'];
  if (script) {
    const ext = (SCRIPT_EXT.exec(script.rel)?.[0] ?? '.jsx').toLowerCase();
    const copy = path.join(record, `script${ext}`);
    writeFileSync(copy, script.bytes, { flag: 'wx', mode: 0o444 });
    scriptMeta = { source: script.rel, copy, copyRel: relTo(root, copy), sha256: script.sha256 };
  }
  const result = path.join(record, 'result.json');
  const config: AeHarnessConfig = {
    v: 1, run, mode, root, result,
    script: scriptMeta?.copy ?? null, script_dir: script ? path.dirname(script.path) : null,
    input_sha256: script ? script.sha256 : source!.sha256,
    open: source?.path ?? null, open_rel: source?.rel ?? null, save: saved?.path ?? null, save_rel: saved?.rel ?? null,
    limits: AE_LIMITS,
  };
  const harnessText = aeHarness(config);
  const harnessPath = path.join(record, 'harness.jsx');
  writeFileSync(harnessPath, harnessText, { flag: 'wx', mode: 0o444 });
  const harness = { path: harnessPath, rel: relTo(root, harnessPath), sha256: sha256(harnessText) };

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // osascript gives up a little before the job's own limit, so its own message says why.
  const command = route === 'osascript' ? (input.osascript ?? 'osascript') : program;
  const args = route === 'osascript' ? osascriptArgs(appName!, harnessPath, Math.max(5, Math.floor(timeoutMs / 1000) - 5)) : ['-r', harnessPath];
  const expect = saved ? [saved.rel] : [];
  const native: NativeMeta = {
    app: 'afterfx', root, run, record, result, expect,
    input: script ? { path: script.rel, sha256: script.sha256 } : { path: source!.rel, sha256: source!.sha256 },
    pre: preStates(root, expect), submittedMs,
  };
  // A program started here (the -r route) finds its licence and preferences in HOME (TIMMY_NATIVE_HOME in a sandbox).
  const home = route === 'binary' ? (input.env?.TIMMY_NATIVE_HOME ?? process.env.TIMMY_NATIVE_HOME) : undefined;
  const env = input.env || home ? { ...input.env, ...(home ? { HOME: home } : {}) } : undefined;
  const ae: AeRunMeta = {
    mode, route, ...(appName ? { appName } : {}), name, ...(saved ? { version: saved.version } : {}), harness,
    ...(scriptMeta ? { script: scriptMeta } : {}), ...(source ? { source } : {}), ...(saved ? { saved: { path: saved.path, rel: saved.rel } } : {}),
  };
  const spec: AeJobSpec = {
    kind: 'task', label: input.label ?? labelOf(mode, script?.rel, source?.rel, saved?.rel), project: input.project, root,
    command, args, ...(env ? { env } : {}), timeoutMs, native, ae,
  };
  const rec: AeRunRecord = {
    record: 'timmy-ae-run', v: 1, run, mode, route, ...(appName ? { app_name: appName } : {}), name, ...(saved ? { version: saved.version } : {}),
    harness: { path: harness.rel, sha256: harness.sha256 },
    ...(scriptMeta ? { script: { source: scriptMeta.source, copy: scriptMeta.copyRel, sha256: scriptMeta.sha256 } } : {}),
    ...(source ? { source: { path: source.rel, sha256: source.sha256, bytes: source.bytes } } : {}),
    ...(saved ? { saved: saved.rel } : {}),
  };
  writeFileSync(path.join(record, 'ae.json'), `${JSON.stringify(rec, null, 2)}\n`, { flag: 'wx' });
  // job.json keeps the arguments with the project folder written as ".", inside the AppleScript text too.
  writeSubmission({ ...spec, args: args.map((a) => a.split(`${root}${path.sep}`).join(`.${path.sep}`)) });
  return spec;
}

// ── judging a run ────────────────────────────────────────────────────────────────

/** R4 (H41): a key's temporal interpolation, as After Effects reported it; null when it did not say. */
export type AeInterpolation = 'linear' | 'bezier' | 'hold' | null;
/** A value as the harness reports it: a number, a boolean, or a point, size or colour (at most 4 numbers). */
export type AeValue = number | boolean | Array<number | null> | null;
/**
 * R4 (H41): a transform property as the harness read it: its value when it has no keyframes; else its keyframes as
 * [time in seconds, value] (the first 50; `num_keys` is how many it has), each key's [in, out] temporal interpolation and,
 * for a spatial property (Position, Anchor Point), each key's [in, out] spatial tangent.
 */
export interface AeKeyed {
  value?: AeValue;
  num_keys?: number;
  keys?: Array<[number | null, AeValue]>;
  keys_truncated?: true;
  interpolation?: Array<[AeInterpolation, AeInterpolation]>;
  spatial_tangents?: Array<[AeValue, AeValue]>;
  /** Position's dimensions are separated: X Position and Y Position hold its keys, not Position */
  separated?: true;
}
export interface AeLayerReport {
  index: number; name: string | null; kind: string; text?: string; keyframes?: Array<{ path: string; match: string; keys: number }>;
  /** R4 (H41): when the layer starts and ends in the comp, in seconds */
  in_point?: number | null; out_point?: number | null;
  /** R4 (H41): what decides where and how it is drawn */
  enabled?: boolean; three_d?: boolean; parent?: string; effects?: number; masks?: number; blending?: 'normal' | 'other'; track_matte?: boolean;
  /** R4 (H41): a solid's source colour as [r, g, b] in 0..1, and its size in pixels */
  color?: Array<number | null>; size?: number[];
  /** R4 (H41): Position, Scale, Opacity, Rotation (Z) and Anchor Point */
  transform?: { position?: AeKeyed; scale?: AeKeyed; opacity?: AeKeyed; rotation?: AeKeyed; anchor?: AeKeyed };
}
export interface AeCompReport {
  name: string | null; width: number | null; height: number | null; duration: number | null; fps: number | null; num_layers: number | null; layers: AeLayerReport[];
  /** R4 (H41): the work area, [start, duration] in seconds (what aerender renders by default) */
  work_area?: [number, number];
}

/** What a run left, beside the outcome: the new version (its sha256 Timmy's), the inputs, and After Effects' own report. */
export interface AeReadback {
  mode: AeMode;
  route: AeRoute;
  appName?: string;
  saved?: { path: string; present: boolean; created: boolean; sha256?: string; bytes?: number };
  /** edit, inspect: the project given, and whether its bytes are as they were at submission */
  source?: { path: string; sha256: string; unchanged: boolean | null };
  harness: { path: string; sha256: string; unchanged: boolean; read?: string };
  /** comps and layers as After Effects reported them about its own project: not an independent reading */
  comps?: AeCompReport[];
  ae_version?: string;
  write_preference?: string;
  /** the stage the harness stopped at, the error and its line, when it failed */
  stage?: string;
  error?: string;
  error_line?: number;
  /** the line the harness returned, as osascript printed it (none on the -r route) */
  status?: string;
  result_file: string;
}
export interface AeJudgement extends NativeJudgement { ae: AeReadback }

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
  const last = tail.split('\n').filter((l) => l.includes(`${AE_MARK} ${run}`)).at(-1)?.trim();
  return last ? last.slice(last.indexOf(AE_MARK)) : undefined;
}

/** What osascript itself reported, exactly: its last "execution error" and its code. */
function osascriptError(tail: string): { text: string; code: number } | undefined {
  const all = [...tail.matchAll(/execution error: (.*?) \((-?\d+)\)/g)];
  const last = all.at(-1);
  return last ? { text: last[1].trim(), code: Number(last[2]) } : undefined;
}

/** osascript's codes that name the step; anything else is quoted as it was reported. */
function osascriptWhy(e: { text: string; code: number }): string {
  if (e.code === -1743) return `macOS did not let osascript control After Effects (osascript reported: ${e.text} (-1743)): allow ${HOST_APP} under ${AUTOMATION_PLACE}, then run again`;
  if (e.code === -1712) return `the Apple event to After Effects timed out (osascript reported: ${e.text} (-1712)) and no result file was written: After Effects may still be running the script, a dialog may be waiting in it, or the run needs a longer time limit`;
  return `osascript reported: ${e.text} (${e.code}), and no result file was written`;
}

/** Whether a file at a path the result names is the file at `want` (both resolved, links followed when there). */
function samePath(named: unknown, want: string): boolean {
  if (typeof named !== 'string' || !named) return false;
  const real = (p: string): string => { try { return realpathSync(p); } catch { return path.resolve(p); } };
  return real(named) === real(want);
}

/** The new version: there, created during this run (from its state at submission), its sha256 and size now. */
function savedState(abs: string, rel: string, pre: PreState | undefined, sinceMs: number): NonNullable<AeReadback['saved']> {
  let s;
  try { s = statSync(abs); } catch { return { path: rel, present: false, created: false }; }
  if (!s.isFile()) return { path: rel, present: false, created: false };
  const digest = sha256File(abs);
  const fresh = s.size > 0 && s.mtimeMs >= sinceMs - MTIME_SLACK_MS;
  const changed = !pre || pre.state !== 'present' || s.size !== pre.size || s.mtimeMs !== pre.mtimeMs || digest !== pre.sha256;
  return { path: rel, present: true, created: fresh && changed, ...(digest ? { sha256: digest } : {}), bytes: s.size };
}

function compsOf(r: Record<string, unknown> | undefined): AeCompReport[] | undefined {
  return r && Array.isArray(r.comps) ? (r.comps as AeCompReport[]) : undefined;
}

/** Appends the final judgement to the run's verdicts.jsonl, unless its last line already says the same. */
function appendVerdict(dir: string | undefined, j: NativeJudgement, jobId?: string): void {
  if (!dir) return;
  const file = path.join(dir, 'verdicts.jsonl');
  try {
    let last: NativeVerdictLine | undefined;
    try {
      const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
      last = lines.length ? JSON.parse(lines[lines.length - 1]) as NativeVerdictLine : undefined;
    } catch { /* none yet, or a torn line: a new line follows */ }
    if (last && last.outcome === j.outcome && last.why === j.why && last.job === jobId) return;
    const line: NativeVerdictLine = {
      judged_at: new Date().toISOString(), ...(jobId ? { job: jobId } : {}), outcome: j.outcome, why: j.why, exit: j.exit, files: j.files,
      ...(j.checked ? { checked: j.checked } : {}),
    };
    appendFileSync(file, `${JSON.stringify(line)}\n`);
  } catch { /* the judgement stands without its record */ }
}

/**
 * A finished After Effects script run, judged: the native module's judgement of the result file and the new
 * version (judgeNativeJob, which this calls without letting it record), then this run's own checks, in order:
 *   failed   the harness reported it could not write its result (the write preference, named exactly); the
 *            result names another file as the saved project; the project given changed during the run.
 *   unknown  the harness changed after Timmy wrote it, or After Effects read a different harness.
 * Then the final judgement alone is appended to the run's verdicts.jsonl. A job still going is unknown and not recorded.
 */
export function judgeAeJob(job: JobRecord, spec: AeJobSpec): AeJudgement {
  const a = spec.ae;
  // R4 merge: an inspect run carries no user script. The code that runs is the harness (kept read-only, checked
  // unchanged after the run and as After Effects read it, below); the project it opens is data, checked byte for
  // byte before and after by this module. So the native module's script binding (a kept copy or a read digest of
  // a script) is asked of author and edit runs only.
  const { input: _project, ...noScript } = spec.native;
  const base = judgeNativeJob(job, { ...(a.mode === 'inspect' ? noScript : spec.native), record: undefined });
  const read = spec.native.result ? readNativeResult(spec.native.result) : { state: 'missing' as const };
  const r = read.state === 'read' && read.data && typeof read.data === 'object' && !Array.isArray(read.data) ? read.data as Record<string, unknown> : undefined;
  const harnessNow = sha256File(a.harness.path);
  const harnessRead = typeof r?.harness_sha256_read === 'string' ? r.harness_sha256_read.toLowerCase() : undefined;
  const sourceNow = a.source ? sha256File(a.source.path) : undefined;
  const sourceUnchanged = a.source ? (sourceNow === undefined ? false : sourceNow === a.source.sha256) : null;
  const saved = a.saved ? savedState(a.saved.path, a.saved.rel, spec.native.pre?.[a.saved.rel], spec.native.submittedMs ?? Date.parse(job.startedAt)) : undefined;
  const tail = logTail(job.logPath);
  const status = statusLine(tail, spec.native.run);
  const reported = a.route === 'osascript' ? osascriptError(tail) : undefined;
  const comps = compsOf(r);
  const readback: AeReadback = {
    mode: a.mode, route: a.route, ...(a.appName ? { appName: a.appName } : {}),
    ...(saved ? { saved } : {}),
    ...(a.source ? { source: { path: a.source.rel, sha256: a.source.sha256, unchanged: sourceUnchanged } } : {}),
    harness: { path: a.harness.rel, sha256: a.harness.sha256, unchanged: harnessNow === a.harness.sha256, ...(harnessRead ? { read: harnessRead } : {}) },
    ...(comps ? { comps } : {}),
    ...(typeof r?.ae_version === 'string' ? { ae_version: r.ae_version } : {}),
    ...(typeof r?.write_preference === 'string' ? { write_preference: r.write_preference } : {}),
    ...(r && r.ok !== true && typeof r.stage === 'string' ? { stage: r.stage } : {}),
    ...(r && r.ok !== true && typeof r.error === 'string' ? { error: r.error } : {}),
    ...(r && r.ok !== true && typeof r.error_line === 'number' ? { error_line: r.error_line } : {}),
    ...(status ? { status } : {}),
    result_file: relTo(spec.root, spec.native.result ?? ''),
  };
  if (!job.stale && LIVE.has(job.state)) return { ...base, ae: readback };

  // On the osascript route the exit recorded is osascript's (it asked After Effects to run the harness).
  const baseWhy = a.route === 'osascript' ? base.why.replace(/\bAfter Effects (?=(?:exited|timed out|was stopped|ended|did not run|was left)\b)/g, 'osascript ') : base.why;
  let outcome = base.outcome;
  let why = baseWhy;
  if (read.state === 'missing' && status && /\bresult=not-written\b/.test(status)) {
    outcome = 'failed';
    why = /\bwrite-preference=off\b/.test(status) ? AE_PREF_OFF
      : `the harness could not write its result file (${status.replace(/^.*?\breason=/, '') || 'no reason given'}), so it stopped before touching any project: check ${PREF} (${PREF_WHERE}) and that the project folder is writable`;
  } else if (read.state === 'missing' && reported) {
    // osascript's own report names the reason; the outcome stays the native module's (no result file).
    why = `${osascriptWhy(reported)}; ${baseWhy}`;
  } else if (read.state === 'missing') {
    why = `${baseWhy}; ${NO_RESULT_HINT}`;
  } else if (r?.stage === 'started' && status && /\bresult=not-written\b/.test(status)) {
    // The first write (the provisional result) worked and the last did not: the result file is not this run's ending.
    outcome = /\bok=true\b/.test(status) ? 'unknown' : 'failed';
    why = `the harness ended (it said ${/\bok=true\b/.test(status) ? 'ok' : 'not ok'}) but could not write its final result (${status.replace(/^.*?\breason=/, '') || 'no reason given'}), so the result file still holds its first, provisional state; ${baseWhy}`;
  }
  if (outcome === 'ok') {
    if (harnessNow !== a.harness.sha256) {
      outcome = 'unknown';
      why = `${a.harness.rel} ${harnessNow ? 'changed' : 'is gone'} since Timmy wrote it, so what ran cannot be bound to this run; ${baseWhy}`;
    } else if (harnessRead && harnessRead !== a.harness.sha256) {
      outcome = 'unknown';
      why = `After Effects read a harness whose sha256 is not the one Timmy wrote for this run; ${baseWhy}`;
    } else if (a.saved && r && !samePath((r.project as { path?: unknown } | undefined)?.path, a.saved.path)) {
      const named = (r.project as { path?: unknown } | undefined)?.path;
      outcome = 'failed';
      why = `the result names ${typeof named === 'string' && named ? 'another file' : 'no file'} as the saved project, not ${a.saved.rel}; ${baseWhy}`;
    }
  }
  if (a.source && sourceUnchanged === false) {
    outcome = 'failed';
    why = `${a.source.rel} ${sourceNow ? 'changed' : 'is gone'} during the run (its sha256 is not the one recorded at submission): Timmy never writes it, so the script or something else did${a.saved ? `; this run's new version is ${a.saved.rel}` : ''}; ${baseWhy}`;
  }
  if (outcome === 'ok') {
    // The native module's sentence counts digests the script recorded; here the script records none: Timmy hashes.
    const exit = baseWhy.includes('; ') ? baseWhy.slice(baseWhy.lastIndexOf('; ') + 2) : '';
    const what = a.saved && saved ? `${a.saved.rel} was created by this run (sha256 ${short(saved.sha256)}, computed by Timmy after the run)` : `${a.source?.rel} is unchanged`;
    const told = comps ? `; After Effects reported ${comps.length} comp${comps.length === 1 ? '' : 's'} (its own report)` : '';
    why = `the result file is this run's, from ${spec.native.input?.path ?? 'its input'} as submitted, and says ok; ${what}${a.mode === 'edit' && a.source ? `; ${a.source.rel} is unchanged` : ''}${told}${exit ? `; ${exit}` : ''}`;
  }
  const j: AeJudgement = { ...base, outcome, why, ae: readback };
  appendVerdict(spec.native.record, j, job.id);
  return j;
}

/** A judgement as a receipt carries it: the native fields (app afterfx) and the run's own, with project-relative names only. */
export function aeReceiptFields(j: AeJudgement): ReturnType<typeof nativeReceiptFields> & { native: { ae: Record<string, unknown> } } {
  const base = nativeReceiptFields('afterfx', j);
  const a = j.ae;
  const layers = (a.comps ?? []).reduce((n, c) => n + (Array.isArray(c.layers) ? c.layers.length : 0), 0);
  return {
    ...base,
    native: {
      ...base.native,
      ae: {
        mode: a.mode, route: a.route,
        ...(a.saved ? { saved: { ...a.saved } } : {}),
        ...(a.source ? { source: { ...a.source } } : {}),
        harness_sha256: a.harness.sha256, harness_unchanged: a.harness.unchanged,
        ...(a.ae_version ? { ae_version: a.ae_version } : {}),
        ...(a.write_preference ? { write_preference: a.write_preference } : {}),
        ...(a.comps ? { comps: a.comps.length, layers, reported_by: 'After Effects, about its own project' } : {}),
        ...(a.stage ? { stage: a.stage } : {}),
        ...(a.error_line !== undefined ? { error_line: a.error_line } : {}),
      },
    },
  };
}

// ── after a restart ──────────────────────────────────────────────────────────────

/** A run's spec rebuilt from its folder (job.json and ae.json), every name in them checked to lead inside the project. */
export function aeSpecFromRecord(root: string, run: string): AeJobSpec {
  const base = realRoot(root);
  const rec = readNativeRecord(base, run);
  if (!rec || rec.job.app !== 'afterfx') throw new Error(`no record of an After Effects script run ${run} in this project`);
  const ae = JSON.parse(readFileSync(path.join(rec.dir, 'ae.json'), 'utf8')) as AeRunRecord;
  if (ae.record !== 'timmy-ae-run' || ae.run !== run || !AE_MODES.includes(ae.mode)) throw new Error(`the record of run ${run} has no After Effects part (ae.json)`);
  const within = (rel: string): string => {
    const at = resolveInside(base, rel);
    if ('error' in at) throw new Error(`the record of run ${run} names ${rel}, which does not lead inside the project: ${at.error}`);
    return at.path;
  };
  const j = rec.job;
  const expect = Array.isArray(j.expect) ? j.expect.filter((n): n is string => typeof n === 'string') : [];
  for (const n of expect) within(n);
  const native: NativeMeta = {
    app: 'afterfx', root: base, run, record: rec.dir, expect, pre: j.pre ?? {}, submittedMs: Date.parse(j.started_at),
    ...(j.result ? { result: within(j.result) } : {}), ...(j.input ? { input: j.input } : {}),
  };
  const meta: AeRunMeta = {
    mode: ae.mode, route: ae.route, ...(ae.app_name ? { appName: ae.app_name } : {}), name: ae.name, ...(ae.version ? { version: ae.version } : {}),
    harness: { path: within(ae.harness.path), rel: ae.harness.path, sha256: ae.harness.sha256 },
    ...(ae.script ? { script: { source: ae.script.source, copy: within(ae.script.copy), copyRel: ae.script.copy, sha256: ae.script.sha256 } } : {}),
    ...(ae.source ? { source: { path: within(ae.source.path), rel: ae.source.path, sha256: ae.source.sha256, bytes: ae.source.bytes } } : {}),
    ...(ae.saved ? { saved: { path: within(ae.saved), rel: ae.saved } } : {}),
  };
  return { kind: 'task', label: j.label, project: j.project, root: base, command: j.program, args: j.args, timeoutMs: j.timeout_ms, native, ae: meta };
}

/**
 * Judges an After Effects script run again from its folder after a restart (or after osascript gave up while
 * After Effects went on): with the job's record when the caller has it (`job`, or `findJob` given the id its
 * started.json names), else as a run whose exit was not recorded, which never decides.
 */
export function reconcileAe(root: string, run: string, opts: { job?: JobRecord; findJob?: (id: string) => JobRecord | undefined } = {}): AeJudgement {
  const spec = aeSpecFromRecord(root, run);
  const rec = readNativeRecord(spec.root, run);
  const found = opts.job ?? (rec?.started && opts.findJob ? opts.findJob(rec.started.job) : undefined);
  const job: JobRecord = found ?? {
    id: rec?.started?.job ?? 'j000000', kind: 'task', label: spec.label, project: spec.project, root: spec.root, command: spec.command, args: spec.args,
    state: 'running', startedAt: rec?.job.started_at ?? new Date(0).toISOString(), steps: [], logPath: '', lines: 0, stale: true,
  };
  return judgeAeJob(job, spec);
}

// ── what the REPL and the agent are told ───────────────────────────────────────────

type Line = Segment[];
const quoteArg = (s: string): string => (/[\s"']/.test(s) ? `"${s.replace(/"/g, '')}"` : s);
const short = (sha: string | undefined): string => (sha ? `${sha.slice(0, 12)}…` : 'none');
const size = (n: number | undefined): string => (n === undefined ? '' : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

function howItRuns(a: AeRunMeta): string {
  return a.route === 'osascript'
    ? `${a.appName}, asked through osascript: it starts, or comes forward, and its window opens (a script runs only inside the application)`
    : 'started with -r and the harness: its window opens (a script runs only inside the application); on Windows, when After Effects is already running, the job can end before the script does: the result file decides';
}

/** Said before the run: After Effects opens its window, what stops a run, the preference, and what it will save. */
export function aeStartLines(spec: AeJobSpec, sep: string): Line[] {
  const a = spec.ae;
  const saves = a.mode === 'author' ? `${a.saved?.rel}, a new project`
    : a.mode === 'edit' ? `${a.saved?.rel}, a new version; ${a.source?.rel} is never written`
      : `nothing: it opens ${a.source?.rel} to read it and closes it unsaved`;
  return [
    [{ text: '  App        ', role: 'secondary' }, { text: howItRuns(a), role: 'estimate' }],
    [{ text: '  Before     ', role: 'secondary' }, { text: `a project open in After Effects with unsaved changes stops the run untouched${sep}scripts must be allowed to write files: ${PREF} (${PREF_WHERE}); Timmy never changes it`, role: 'secondary' }],
    [{ text: '  Saves      ', role: 'secondary' }, { text: saves }],
  ];
}

/** R4 (H41): the transform properties the harness reports keyframes of, by match name. */
const TRANSFORM_MATCH: Record<string, 'position' | 'scale' | 'opacity' | 'rotation' | 'anchor'> = {
  'ADBE Position': 'position', 'ADBE Scale': 'scale', 'ADBE Opacity': 'opacity', 'ADBE Rotate Z': 'rotation', 'ADBE Anchor Point': 'anchor',
};
const n3 = (v: number): string => String(Math.round(v * 1000) / 1000);
/** A reported value in words: 12.5, (240, 760), true. */
export const aeValueText = (v: AeValue | undefined): string => (Array.isArray(v) ? `(${v.map((x) => (x === null ? '?' : n3(x))).join(', ')})` : typeof v === 'number' ? n3(v) : v === undefined || v === null ? '?' : String(v));
/** R4 (H41): a keyed property in words: "Position 2 keys: 0 s (240, 760) → 2 s (1680, 760), linear". */
export function aeKeyedText(label: string, k: AeKeyed): string {
  const n = k.num_keys ?? 0;
  const keys = k.keys ?? [];
  const shown = keys.slice(0, 3).map(([t, v]) => `${t === null ? '?' : n3(t)} s ${aeValueText(v)}`).join(' → ');
  const more = n > 3 ? ` → … (${n} keys${k.keys_truncated ? `, ${keys.length} reported` : ''})` : '';
  const types = [...new Set((k.interpolation ?? []).flat())];
  const interp = !types.length ? '' : types.every((t) => t === 'linear') ? ', linear' : `, ${types.map((t) => t ?? 'interpolation not reported').join('/')}`;
  return `${label} ${n} key${n === 1 ? '' : 's'}: ${shown}${more}${interp}`;
}
/** A solid's colour as "[0.2, 0.75, 0.4]". */
const colourText = (c: Array<number | null> | undefined): string => (Array.isArray(c) ? `[${c.map((x) => (x === null ? '?' : n3(x))).join(', ')}]` : '');

function compWords(c: AeCompReport): string {
  const fps = typeof c.fps === 'number' ? `${Math.round(c.fps * 100) / 100} fps` : 'fps unknown';
  const dur = typeof c.duration === 'number' ? `${Math.round(c.duration * 100) / 100} s` : 'duration unknown';
  const layers = (c.layers ?? []).slice(0, 6).map((l) => {
    // R4 (H41): a transform property's keyframes with their times, values and interpolation, when the harness read them
    const keys = (l.keyframes ?? []).map((k) => {
      const which = TRANSFORM_MATCH[k.match.split('/').at(-1) ?? ''];
      const t = which ? l.transform?.[which] : undefined;
      const label = k.path.split(' > ').at(-1) ?? k.path;
      return t?.keys?.length ? aeKeyedText(label, t) : `${label} ${k.keys} key${k.keys === 1 ? '' : 's'}`;
    });
    const text = l.text !== undefined ? ` "${l.text.length > 40 ? `${l.text.slice(0, 40)}…` : l.text}"` : '';
    const colour = l.color ? ` ${colourText(l.color)}` : '';
    const whole = typeof l.in_point === 'number' && typeof l.out_point === 'number' && l.in_point <= 0 && typeof c.duration === 'number' && l.out_point >= c.duration;
    const span = typeof l.in_point === 'number' && typeof l.out_point === 'number' && !whole ? `, ${n3(l.in_point)}–${n3(l.out_point)} s` : '';
    return `${l.name ?? '(unnamed)'} (${l.kind}${text}${colour}${span}${keys.length ? `; ${keys.join(', ')}` : ''})`;
  });
  const more = (c.layers?.length ?? 0) > 6 ? `, and ${(c.layers?.length ?? 0) - 6} more` : '';
  return `${c.name ?? '(unnamed)'} ${c.width ?? '?'}x${c.height ?? '?'}, ${fps}, ${dur}, ${c.num_layers ?? 0} layer${c.num_layers === 1 ? '' : 's'}${layers.length ? `: ${layers.join(', ')}${more}` : ''}`;
}

/** The comps as After Effects reported them, in one line. */
export function aeCompsLine(comps: AeCompReport[] | undefined): string {
  if (!comps) return 'no comps reported';
  if (!comps.length) return 'no comps';
  const shown = comps.slice(0, 3).map(compWords).join('; ');
  return `${comps.length} comp${comps.length === 1 ? '' : 's'}: ${shown}${comps.length > 3 ? `; and ${comps.length - 3} more` : ''}`;
}

/** The next steps after a good run: render the saved project with aerender, or have After Effects read it back. */
export function aeNextSteps(j: AeJudgement, spec: AeJobSpec): string[] {
  const a = spec.ae;
  const target = a.mode === 'inspect' ? a.source?.rel : a.saved?.rel;
  if (j.outcome !== 'ok' || !target) return [];
  const comp = j.ae.comps?.find((c) => typeof c.name === 'string' && c.name)?.name;
  const stem = a.mode === 'inspect' ? path.posix.basename(target).replace(PROJECT_EXT, '') : `${a.name}-v${a.version}`;
  // R4 (H41): .mp4, as After Effects 2026's default output module was seen to write (H.264); its output module decides the
  // container either way, and the file aerender writes is judged by that rule (src/native/index.ts).
  const steps = [`/ae ${quoteArg(target)} ${comp ? quoteArg(comp) : '<comp>'} out/${stem}.mp4 renders it with aerender (its output module decides the container; the file it writes is judged, as any render)`];
  if (a.mode !== 'inspect') steps.push(`/ae inspect ${quoteArg(target)} has After Effects read it back (the same application reading its own file, not an independent reader)`);
  return steps;
}

/** Said when the run ends: the outcome, the new version with Timmy's sha256, After Effects' report, and the next step. */
export function aeEndLines(j: AeJudgement, spec: AeJobSpec, o: { id: string; label: string; glyphs: { ok: string; fail: string }; sep: string; scrub: (s: string) => string; receipt?: string }): Line[] {
  const a = j.ae;
  const mark = j.outcome === 'ok' ? o.glyphs.ok : j.outcome === 'failed' ? o.glyphs.fail : '?';
  const lines: Line[] = [[
    { text: `  ${mark} `, role: j.outcome === 'failed' ? 'failure' : undefined },
    { text: `${o.id} ${j.outcome}`, role: j.outcome === 'failed' ? 'failure' : 'strong' },
    { text: `  ${o.label}: ${o.scrub(j.why)}${o.receipt ? `${o.sep}receipt ${o.receipt}` : ''}${o.sep}/results`, role: 'secondary' },
  ]];
  if (a.saved) {
    const how = a.saved.present ? `${a.saved.created ? 'created by this run' : 'not created by this run'}${o.sep}sha256 ${short(a.saved.sha256)} (Timmy's, after the run)${a.saved.bytes !== undefined ? `${o.sep}${size(a.saved.bytes)}` : ''}` : 'not there';
    // The harness saves the new version before the script runs and not again after an error: say what it holds.
    const held = a.saved.present && a.stage === 'script' ? `${o.sep}it holds the project as saved before the script's error` : '';
    lines.push([{ text: '      saved    ', role: 'secondary' }, { text: `${a.saved.path}${o.sep}${how}${held}`, role: a.saved.present && a.saved.created ? undefined : 'failure' }]);
  }
  if (a.source) {
    lines.push([{ text: '      given    ', role: 'secondary' }, { text: `${a.source.path}${o.sep}${a.source.unchanged ? 'unchanged (sha256 as at submission)' : 'CHANGED during the run'}`, role: a.source.unchanged ? 'secondary' : 'failure' }]);
  }
  if (a.comps) {
    lines.push([{ text: '      reported ', role: 'secondary' }, { text: `${o.scrub(aeCompsLine(a.comps))}${o.sep}as After Effects reported its own project, not an independent reading`, role: 'secondary' }]);
  }
  if (a.error) {
    lines.push([{ text: '      error    ', role: 'secondary' }, { text: `${a.stage ? `at ${a.stage}` : ''}${a.error_line !== undefined ? ` (line ${a.error_line})` : ''}: ${o.scrub(a.error)}${o.sep}${a.result_file}${o.sep}/jobs ${o.id} for the raw output`, role: 'failure' }]);
  } else if (j.outcome !== 'ok') {
    lines.push([{ text: '      look     ', role: 'secondary' }, { text: `${a.result_file}${o.sep}/jobs ${o.id} for the raw output`, role: 'secondary' }]);
  }
  for (const step of aeNextSteps(j, spec)) lines.push([{ text: '      next     ', role: 'secondary' }, { text: step }]);
  return lines;
}

/** The agent's note on a started run. */
export function aeToolNote(spec: AeJobSpec, jobId: string): string {
  const a = spec.ae;
  return [
    `Started, not finished: After Effects ${a.route === 'osascript' ? `(${a.appName}, through osascript)` : '(with -r)'} starts or comes forward and opens its window to run this run's harness; /jobs ${jobId} follows it.`,
    `It is judged when it ends, by the harness's result file (${relTo(spec.root, spec.native.result ?? '')})${a.saved ? ` and ${a.saved.rel} having been created by this run (its sha256 computed by Timmy)` : ''}${a.source ? `; ${a.source.rel} must stay unchanged` : ''}.`,
    `A project open in After Effects with unsaved changes stops the run; scripts must be allowed to write files (${PREF}); Timmy never changes that setting.`,
    a.mode === 'inspect' ? 'What it reports is After Effects reading its own file, not an independent reader.' : 'Do not claim the project is made until the job is judged ok; then /ae <aep> <comp> <out> renders it with aerender.',
  ].join(' ');
}

/** The /ae words for authoring: undefined when the first word is not author, edit or inspect (the render route). */
export function parseAeScriptArgs(words: string[]): { mode: AeMode; script?: string; projectFile?: string; name?: string } | { error: string } | undefined {
  const mode = words[0];
  if (mode !== 'author' && mode !== 'edit' && mode !== 'inspect') return undefined;
  const usage = { error: `Usage: ${AE_USAGE[AE_MODES.indexOf(mode)].replace(/\s{2,}.*$/, '')}` };
  const rest = words.slice(1);
  if (mode === 'author') {
    let name: string | undefined;
    const pos: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--name') { name = rest[++i]; if (!name) return usage; } else if (rest[i].startsWith('--name=')) name = rest[i].slice('--name='.length);
      else pos.push(rest[i]);
    }
    return pos.length === 1 ? { mode, script: pos[0], ...(name ? { name } : {}) } : usage;
  }
  if (mode === 'edit') return rest.length === 2 ? { mode, projectFile: rest[0], script: rest[1] } : usage;
  return rest.length === 1 ? { mode, projectFile: rest[0] } : usage;
}
