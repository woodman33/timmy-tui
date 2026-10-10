/**
 * Round R4 (/iterate ae, helper H41): the After Effects variant of the connected workflow, without the REPL. A local code
 * agent changes one ExtendScript authoring script; After Effects runs it as /ae author does (src/native/ae-author.ts: a
 * per-run harness makes a new project, runs the script, saves out/ae/<name>-v<N>.aep and reads its comps back); aerender
 * renders a comp of that project (src/native aerenderJob, the file it writes judged by the R4 rule for a file of the same
 * name with another extension); a readback worker reads the render outside After Effects
 * (workers/readback/video_readback.py: ffprobe, ffmpeg and Timmy's own pixel reading) and Timmy compares what it measured
 * with After Effects' own report. This module holds what those steps decide: the agent's task, the compile check, the
 * readback's plan, its output read, the comparison and its tolerance, the comp's facts before and after, and the flow
 * record (results/flows/<flow-id>.json, the flow schema timmy.flow/1 with `target: 'ae'`).
 *
 * Who measured what goes with every number: After Effects' report is After Effects reading its own project, inside After
 * Effects; the readback is the rendered file read by FFmpeg's tools and Timmy's arithmetic, outside it. It checks the
 * render against After Effects' report, not After Effects' renderer itself (AE_READBACK_LABEL).
 *
 * The script pieces below (the line diff, the judge of what the agent changed, the folders the agent's comparison does
 * not see) are COPIED from src/flows/iterate-native.ts (round R4, H33), not imported or moved: other helpers edit that file
 * this round. They behave the same; once both settle, one copy can replace the other.
 */
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT_SKIP, type ChangeSet } from '../code-agents/index.js';
import { aeSpecFromRecord, type AeCompReport, type AeKeyed, type AeLayerReport, type AeValue } from '../native/ae-author.js';
import { listNativeRuns, readNativeRecord } from '../native/index.js';
import { packagedPath, packageRoot } from '../utils/asset-dirs.js';
import { DOCTRINE_15, FLOW_SCHEMA, judgeAgentChanges, type AgentChanges, type FlowOutcome, type OtherChange } from './iterate.js';

export { DOCTRINE_15 };

function packaged(rel: string): string {
  return packagedPath(rel, import.meta.url, { kind: 'file' }) ?? path.join(packageRoot(import.meta.url) ?? fileURLToPath(new URL('.', import.meta.url)), rel);
}
/** workers/readback/video_readback.py at the package root (as the other readback workers are found). */
export const VIDEO_READBACK_SCRIPT = packaged('workers/readback/video_readback.py');
/** The readback's time limit as a job (one ffprobe and a frame per sampled time), and the most its log may hold. */
export const VIDEO_READBACK_TIMEOUT_MS = 10 * 60_000;
export const VIDEO_READBACK_MAX_OUTPUT = 1024 * 1024;
/** What the readback is and is not, said with its numbers on the record, the card and the notices. */
export const AE_READBACK_LABEL = 'measured from the rendered file by ffprobe, ffmpeg and Timmy\'s pixel reading, outside After Effects; it checks the render against After Effects\' own report, not After Effects\' renderer itself';
/** Who reported the comp's facts. */
export const AE_REPORTED_BY = 'After Effects\' own report of its own project (the harness reading it inside After Effects)';
/** The agent is given the whole script, so /iterate ae takes scripts up to this size. */
export const AE_FILE_MAX_BYTES = 256 * 1024;
/** The render asked of aerender: out/ae/<name>-v<N>.mp4. Its output module decides the container; the file it wrote is judged. */
export const AE_RENDER_EXT = '.mp4';
/** The position tolerance, in words. */
export const AE_TOLERANCE_RULE = '2% of the comp\'s width or height, or 2 pixels of the scaled frame (in comp pixels), whichever is larger';
/** The setup step when ffprobe or ffmpeg is missing. */
export const AE_FFMPEG_SETUP = 'brew install ffmpeg (it brings ffprobe and ffmpeg), or set TIMMY_FFPROBE and TIMMY_FFMPEG';
/** The readback reads at most this many samples (times x layers), as the worker does. */
export const AE_MAX_SAMPLES = 120;
const MAX_SAMPLES_PER_LAYER = 40;
const MAX_LAYERS_COMPARED = 8;

const objOf = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const n3 = (n: number | null | undefined): string => (finite(n) ? String(r3(n)) : '?');
const xy = (v: AeValue | undefined): [number, number] | undefined => (Array.isArray(v) && v.length >= 2 && finite(v[0]) && finite(v[1]) ? [v[0], v[1]] : undefined);
const pointText = (p: [number, number] | number[] | undefined | null): string => (p && p.length >= 2 ? `(${n3(p[0])}, ${n3(p[1])})` : '?');

// ── the script: where it may be, and the agent's task ───────────────────────────

/**
 * COPIED from src/flows/iterate-native.ts: why a file there cannot be iterated, or undefined. The agent's before/after
 * snapshot (src/code-agents) does not look into .git, node_modules, .timmy or dist. Compared without case.
 */
export function unseenFolder(rel: string): string | undefined {
  const skip = new Set([...SNAPSHOT_SKIP].map((s) => s.toLowerCase()));
  return rel.split('/').slice(0, -1).find((part) => skip.has(part.toLowerCase()));
}

/** COPIED from src/flows/iterate-native.ts: only `fileRel` may have changed (the tray's judgeAgentChanges, naming it). */
export function judgeFileChanges(files: (ChangeSet & { truncated?: boolean }) | undefined, fileRel: string): AgentChanges {
  const j = judgeAgentChanges(files, fileRel);
  if (j.ok) return j;
  if (j.reason === 'missing') return { ...j, why: `the agent run left no record of what it changed, so whether it changed only ${fileRel} is not known` };
  if (j.reason === 'incomplete') return { ...j, why: `the project has more files than the agent run compared, so whether it changed only ${fileRel} is not known` };
  return j;
}

/**
 * What the local code agent is asked: the operator's instruction first (so the agent's job label shows it), then fixed
 * rules: the one file it may change, what Timmy does with it after, to keep it ExtendScript (ES3), and to leave making,
 * opening, saving and closing projects to the harness. The script's text now is given whole.
 */
export function aeIterateTask(o: { instruction: string; scriptRel: string; scriptText: string; name: string }): string {
  return [
    o.instruction.trim(),
    '',
    `Do this by changing the file ${o.scriptRel} in this project, and nothing else. It is an After Effects script (ExtendScript, which is ES3 JavaScript). After you finish, Timmy runs it inside After Effects as /ae author does: its harness makes a new, empty project and saves it as out/ae/${o.name}-v<N>.aep, runs this script, saves the project again and reads its comps back; then aerender renders a comp of it, and Timmy reads the rendered video outside After Effects (ffprobe, ffmpeg and its own pixel reading) and compares it with what After Effects reported.`,
    '',
    'Rules:',
    `- Edit only ${o.scriptRel}. Do not create, change or delete any other file, and run no commands.`,
    '- Keep it ExtendScript (ES3): var only (no let or const), no arrow functions, template strings or classes, no Array forEach, map or filter, and no JSON object.',
    '- Build in app.project as it is: do not create, open, save or close a project (Timmy\'s harness does that), and change no preference.',
    '- Find properties by match name (ADBE Transform Group, ADBE Position, ADBE Text Document and so on), as the script does, so it works in any language After Effects runs in.',
    '- Change only what the instruction asks for; keep everything else as it is.',
    '- If the instruction cannot be done in this script, change nothing and say why.',
    '',
    `${o.scriptRel} now holds:`,
    o.scriptText.trimEnd(),
  ].join('\n');
}

// ── the script's change (COPIED from src/flows/iterate-native.ts) ───────────────

export interface ScriptHunk {
  /** where it starts, 1-based, in the script before and after */
  before_line: number;
  after_line: number;
  /** the lines taken out and put in (the first 8 of each, each cut at 160 characters) */
  removed: string[];
  added: string[];
  removed_total: number;
  added_total: number;
}
export interface ScriptChange {
  added: number;
  removed: number;
  /** the first 6 places that changed */
  hunks: ScriptHunk[];
  hunks_total: number;
  method: 'line diff (longest common subsequence)' | 'whole middle replaced (too long to compare line by line)';
}

const MAX_HUNKS = 6;
const MAX_HUNK_LINES = 8;
const MAX_LINE_CHARS = 160;
const DIFF_CELLS = 2_250_000;

const linesOf = (s: string): string[] => {
  const l = s.split('\n');
  if (l.length && l[l.length - 1] === '') l.pop();
  return l;
};
const cut = (l: string): string => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…` : l);

/** The script's change, line by line (the common start and end set aside, the middle by its longest common subsequence). */
export function scriptChange(before: string, after: string): ScriptChange {
  const a = linesOf(before);
  const b = linesOf(after);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const am = a.slice(p, a.length - s);
  const bm = b.slice(p, b.length - s);
  const n = am.length;
  const m = bm.length;
  const ops: Array<{ op: '=' | '-' | '+'; i: number; j: number }> = [];
  let method: ScriptChange['method'] = 'line diff (longest common subsequence)';
  if (n * m <= DIFF_CELLS) {
    const w = m + 1;
    const t = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) t[i * w + j] = am[i] === bm[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) { ops.push({ op: '=', i, j }); i++; j++; } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) { ops.push({ op: '-', i, j }); i++; } else { ops.push({ op: '+', i, j }); j++; }
    }
    for (; i < n; i++) ops.push({ op: '-', i, j });
    for (; j < m; j++) ops.push({ op: '+', i, j });
  } else {
    method = 'whole middle replaced (too long to compare line by line)';
    for (let i = 0; i < n; i++) ops.push({ op: '-', i, j: 0 });
    for (let j = 0; j < m; j++) ops.push({ op: '+', i: n, j });
  }
  const hunks: ScriptHunk[] = [];
  let total = 0;
  let added = 0;
  let removed = 0;
  for (let k = 0; k < ops.length;) {
    if (ops[k].op === '=') { k++; continue; }
    const start = ops[k];
    const h: ScriptHunk = { before_line: p + start.i + 1, after_line: p + start.j + 1, removed: [], added: [], removed_total: 0, added_total: 0 };
    for (; k < ops.length && ops[k].op !== '='; k++) {
      const o = ops[k];
      if (o.op === '-') { h.removed_total++; if (h.removed.length < MAX_HUNK_LINES) h.removed.push(cut(am[o.i])); } else { h.added_total++; if (h.added.length < MAX_HUNK_LINES) h.added.push(cut(bm[o.j])); }
    }
    total++;
    added += h.added_total;
    removed += h.removed_total;
    if (hunks.length < MAX_HUNKS) hunks.push(h);
  }
  return { added, removed, hunks, hunks_total: total, method };
}

/** "+1 −1 lines in 1 place" */
export const changeText = (c: ScriptChange): string =>
  `+${c.added} −${c.removed} line${c.added + c.removed === 1 ? '' : 's'} in ${c.hunks_total} place${c.hunks_total === 1 ? '' : 's'}`;

/** Lines in a text, as the records count them (a final newline ends the last line). */
export const lineCount = (t: string): number => (t ? t.split('\n').length - (t.endsWith('\n') ? 1 : 0) : 0);

// ── the compile check ───────────────────────────────────────────────────────────

/** Who compiles: Node's vm.Script, which compiles and never runs (the script is not executed). */
export const AE_COMPILE_BY = 'Node\'s vm.Script';
/** What the check is, in the words every notice, record reason and card uses. */
export const AE_COMPILE_CHECK = 'a modern-JavaScript compile check of ExtendScript (ES3) source';
/** ExtendScript's preprocessor lines (#target, #include...): ExtendScript reads them, modern JavaScript does not. */
const PREPROCESSOR = /^\s*#(?:target|targetengine|include|includepath|script|strict|engine)\b/;

export type AeCompileCheck =
  | { checked: true; ok: true; by: string; node: string; set_aside?: number }
  | { checked: true; ok: false; by: string; node: string; error: string; line: number | null; set_aside?: number }
  | { checked: false; why: string };

/**
 * A modern-JavaScript compile check of ExtendScript (ES3) source: Node's vm.Script compiles it (sloppy mode) and nothing
 * runs. ExtendScript's own preprocessor lines are set aside first (blank lines, so the line numbers hold) and counted. It
 * is not After Effects' parser: ES3 that compiles here can still fail in After Effects, and the reverse is rare (E4X).
 */
export function compileCheck(source: string, rel: string): AeCompileCheck {
  let setAside = 0;
  const code = source.split('\n').map((l) => { if (PREPROCESSOR.test(l)) { setAside++; return ''; } return l; }).join('\n');
  const aside = setAside ? { set_aside: setAside } : {};
  try {
    const compiled = new vm.Script(code, { filename: rel });
    void compiled;
    return { checked: true, ok: true, by: AE_COMPILE_BY, node: process.version, ...aside };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const esc = rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const at = typeof err.stack === 'string' ? new RegExp(`^${esc}:(\\d+)`, 'm').exec(err.stack) : null;
    return { checked: true, ok: false, by: AE_COMPILE_BY, node: process.version, error: `${err.name}: ${err.message}`.slice(0, 300), line: at ? Number(at[1]) : null, ...aside };
  }
}

/** The check in words, saying what it is (for the notices, the record's reason and the board). */
export function compileWords(c: AeCompileCheck | undefined): string {
  if (!c) return 'not compiled';
  if (!c.checked) return `not compiled: ${c.why}`;
  const aside = c.set_aside ? `; ${c.set_aside} ExtendScript preprocessor line${c.set_aside === 1 ? '' : 's'} (#target, #include…) set aside` : '';
  if (c.ok) return `compiles (${AE_COMPILE_CHECK}: ${c.by} in Node ${c.node}, nothing run; not After Effects' own parser${aside})`;
  return `does not compile: ${c.error}${c.line !== null ? `, line ${c.line}` : ''} (${AE_COMPILE_CHECK}: ${c.by} in Node ${c.node}, nothing run${aside})`;
}

// ── the comp's facts, before and after ──────────────────────────────────────────

/** A comp as After Effects reported it, cut to what the flow shows (at most 40 layers, 8 keys each). */
export interface AeCompFacts {
  comp: string | null;
  size: [number | null, number | null];
  fps: number | null;
  duration: number | null;
  layers: Array<{
    name: string | null; kind: string; text?: string; colour?: Array<number | null>; span?: [number | null, number | null];
    position?: { value?: AeValue; num_keys?: number; keys?: Array<[number | null, AeValue]> };
  }>;
  layers_total: number;
}

export function compFacts(c: AeCompReport): AeCompFacts {
  const layers = (Array.isArray(c.layers) ? c.layers : []).slice(0, 40).map((l) => {
    const p = l.transform?.position;
    return {
      name: l.name, kind: l.kind,
      ...(typeof l.text === 'string' ? { text: l.text } : {}),
      ...(Array.isArray(l.color) ? { colour: [...l.color] } : {}),
      ...(l.in_point !== undefined || l.out_point !== undefined ? { span: [finite(l.in_point) ? l.in_point : null, finite(l.out_point) ? l.out_point : null] as [number | null, number | null] } : {}),
      ...(p ? { position: p.keys?.length ? { num_keys: p.num_keys ?? p.keys.length, keys: p.keys.slice(0, 8) } : { value: p.value ?? null } } : {}),
    };
  });
  return {
    comp: c.name ?? null, size: [finite(c.width) ? c.width : null, finite(c.height) ? c.height : null], fps: finite(c.fps) ? c.fps : null,
    duration: finite(c.duration) ? c.duration : null, layers, layers_total: Array.isArray(c.layers) ? c.layers.length : 0,
  };
}

const valueWords = (v: AeValue | undefined): string => (Array.isArray(v) ? `(${v.map((x) => n3(x)).join(', ')})` : typeof v === 'number' ? n3(v) : v === undefined || v === null ? '?' : String(v));
/** A layer's Position in words: "0 s (240, 760), 2 s (1680, 760)" or "(960, 540)". */
export function positionWords(p: AeCompFacts['layers'][number]['position']): string {
  if (!p) return 'not reported';
  if (p.keys?.length) return `${p.keys.map(([t, v]) => `${n3(t)} s ${valueWords(v)}`).join(', ')}${(p.num_keys ?? 0) > p.keys.length ? `, … (${p.num_keys} keys)` : ''}`;
  return valueWords(p.value);
}
const colourWords = (c: Array<number | null> | undefined): string => (Array.isArray(c) ? `[${c.map((x) => n3(x)).join(', ')}]` : 'none');
const layerWords = (l: AeCompFacts['layers'][number]): string => `${l.name ?? '(unnamed)'} (${l.kind}${l.text !== undefined ? ` "${l.text}"` : ''}${l.colour ? ` ${colourWords(l.colour)}` : ''})`;

/** What changed between two reports of a comp, a line each: the comp's size, rate or length; layers added, gone or changed. */
export function factsChanges(before: AeCompFacts, after: AeCompFacts): string[] {
  const out: string[] = [];
  const size = (f: AeCompFacts): string => `${n3(f.size[0])}x${n3(f.size[1])}, ${n3(f.fps)} fps, ${n3(f.duration)} s`;
  if (size(before) !== size(after)) out.push(`comp ${after.comp ?? '?'}: ${size(before)} → ${size(after)}`);
  const byName = (f: AeCompFacts): Map<string, AeCompFacts['layers'][number]> => {
    const m = new Map<string, AeCompFacts['layers'][number]>();
    for (const l of f.layers) if (l.name !== null && !m.has(l.name)) m.set(l.name, l);
    return m;
  };
  const b = byName(before);
  const a = byName(after);
  for (const [name, l] of a) {
    const old = b.get(name);
    if (!old) { out.push(`+ ${layerWords(l)}`); continue; }
    if (old.kind !== l.kind) out.push(`${name}: ${old.kind} → ${l.kind}`);
    if ((old.text ?? null) !== (l.text ?? null)) out.push(`${name}: text "${old.text ?? ''}" → "${l.text ?? ''}"`);
    if (colourWords(old.colour) !== colourWords(l.colour)) out.push(`${name}: colour ${colourWords(old.colour)} → ${colourWords(l.colour)}`);
    const span = (x: typeof l): string => (x.span ? `${n3(x.span[0])}–${n3(x.span[1])} s` : 'not reported');
    if (span(old) !== span(l)) out.push(`${name}: in–out ${span(old)} → ${span(l)}`);
    if (positionWords(old.position) !== positionWords(l.position)) out.push(`${name}: Position ${positionWords(old.position)} → ${positionWords(l.position)}`);
  }
  for (const [name, l] of b) if (!a.has(name)) out.push(`− ${layerWords(l)}`);
  if (before.layers_total > before.layers.length || after.layers_total > after.layers.length) out.push(`(the first ${Math.min(before.layers.length, after.layers.length)} layers of each report were compared)`);
  return out;
}

/** A comp chosen from a report: by name when asked, else the first. */
export function chooseComp(comps: AeCompReport[] | undefined, name?: string): { ok: true; comp: AeCompReport } | { ok: false; why: string } {
  const list = Array.isArray(comps) ? comps : [];
  if (!list.length) return { ok: false, why: 'After Effects reported no comp in the project' };
  if (name === undefined) return { ok: true, comp: list[0] };
  const found = list.find((c) => c.name === name);
  if (found) return { ok: true, comp: found };
  const names = list.map((c) => c.name ?? '(unnamed)');
  return { ok: false, why: `After Effects reported no comp named ${name} (it lists ${names.slice(0, 12).join(', ')}${names.length > 12 ? ` and ${names.length - 12} more` : ''})` };
}

/**
 * The newest /ae author run of this script as it was before the agent (the same path and sha256), judged ok, started
 * before the flow: its run token, job and start, to read its comps as "before". Undefined, with the reason, when none.
 */
export function previousAeAuthor(root: string, scriptRel: string, sha256: string, before: string): { run: string; job?: string; started_at: string } | { none: string } {
  let runs: ReturnType<typeof listNativeRuns> = [];
  try { runs = listNativeRuns(root); } catch { runs = []; }
  let ofScript = 0;
  for (const r of runs) {
    if (r.app !== 'afterfx' || r.started_at >= before) continue;
    let spec: ReturnType<typeof aeSpecFromRecord>;
    try { spec = aeSpecFromRecord(root, r.run); } catch { continue; }
    if (spec.ae.mode !== 'author' || spec.ae.script?.source !== scriptRel) continue;
    ofScript++;
    if (spec.ae.script.sha256 !== sha256 || r.verdicts.at(-1)?.outcome !== 'ok') continue;
    let job: string | undefined;
    try { job = readNativeRecord(root, r.run)?.started?.job; } catch { job = undefined; }
    return { run: r.run, ...(job ? { job } : {}), started_at: r.started_at };
  }
  return { none: ofScript ? `no earlier /ae author run of ${scriptRel} as it was before the agent ran was judged ok` : `no earlier /ae author run of ${scriptRel} in this project` };
}

/** The comps an After Effects run's result file reports (After Effects' own report), or undefined. */
export function reportedComps(root: string, run: string): AeCompReport[] | undefined {
  try {
    const rec = readNativeRecord(root, run);
    const data = rec?.result.state === 'read' ? objOf(rec.result.data) : undefined;
    return data && Array.isArray(data.comps) ? data.comps as AeCompReport[] : undefined;
  } catch { return undefined; }
}

// ── the readback's plan ─────────────────────────────────────────────────────────

/** The plan file the worker reads (its schema, the comp, and each layer's colour and times). */
export interface AeReadbackPlanFile {
  schema: 'timmy.video-readback-plan/1';
  comp: { width: number; height: number; start: number };
  targets: Array<{ layer: string; colour: number[]; times: number[] }>;
}
/** One layer to be read back: its report, and the times sampled (each a key's time or halfway between two). */
export interface AeLayerPlan { layer: AeLayerReport; name: string; colour: number[]; times: Array<{ t: number; at: 'key' | 'halfway' }> }
export interface AeReadbackPlan {
  comp: { name: string; width: number; height: number; fps: number; duration: number; work_area?: [number, number] };
  /** what the render should cover: frame 0 shows comp time `start`; `duration` seconds (the work area when it is not the whole comp) */
  start: number;
  expected_duration: number;
  layers: AeLayerPlan[];
  /** solids with Position keyframes that are not read back, each with why */
  not_compared: string[];
  file: AeReadbackPlanFile;
}

const eps = 1e-6;

/** Why a solid with Position keyframes cannot be compared by its centroid, or undefined. */
function whyNotComparable(l: AeLayerReport): string | undefined {
  const t = l.transform;
  if (t?.position?.separated) return 'its Position is separated into X and Y Position, which hold its keys';
  if (l.enabled === false) return 'it is hidden (its video switch is off)';
  if (l.three_d === true) return 'it is a 3D layer: where it lands depends on the camera';
  if (l.parent) return `it is parented to ${l.parent}: its Position is in its parent's space`;
  if ((l.effects ?? 0) > 0) return `it has ${l.effects} effect${l.effects === 1 ? '' : 's'}, which can change how it is drawn`;
  if ((l.masks ?? 0) > 0) return `it has ${l.masks} mask${l.masks === 1 ? '' : 's'}`;
  if (l.blending === 'other') return 'its blending mode is not Normal: its colour mixes with what is under it';
  if (l.track_matte === true) return 'it uses a track matte';
  const o = t?.opacity;
  if (!o) return 'its Opacity was not reported';
  if (o.keys?.length) return 'its Opacity is keyed';
  if (!finite(o.value) || Math.abs(o.value - 100) > eps) return `its Opacity is ${valueWords(o.value)}, not 100: its colour mixes with what is under it`;
  const a = t?.anchor;
  if (!a) return 'its Anchor Point was not reported';
  if (a.keys?.length) return 'its Anchor Point is keyed';
  const size = Array.isArray(l.size) && finite(l.size[0]) && finite(l.size[1]) ? l.size : undefined;
  const anchor = xy(a.value);
  if (!size || !anchor) return 'its size or Anchor Point was not reported';
  if (Math.abs(anchor[0] - size[0] / 2) > 0.5 || Math.abs(anchor[1] - size[1] / 2) > 0.5) return `its Anchor Point ${pointText(anchor)} is not at its centre ${pointText([size[0] / 2, size[1] / 2])}, so its centre is not at its Position`;
  const keys = t?.position?.keys ?? [];
  if (keys.some(([time, v]) => !finite(time) || !xy(v))) return 'a key\'s time or value was not reported';
  return undefined;
}

/**
 * The plan: which solids are read back (a colour reported, Position keyframes, nothing that moves its centre off its
 * Position or changes its colour), at each key's time and halfway between keys, within the layer's in and out points and
 * the render's span. The render's frame 0 is the work area's start when the work area is not the whole comp (aerender's
 * render settings decide what it renders; Timmy does not check them), else 0.
 */
export function planReadback(c: AeCompReport): AeReadbackPlan | { error: string } {
  if (!finite(c.width) || !finite(c.height) || !finite(c.fps) || !finite(c.duration) || c.width <= 0 || c.height <= 0 || c.fps <= 0 || c.duration <= 0) {
    return { error: `After Effects' report of ${c.name ?? 'the comp'} has no size, frame rate or duration to compare` };
  }
  const wa = Array.isArray(c.work_area) && finite(c.work_area[0]) && finite(c.work_area[1]) ? c.work_area : undefined;
  const whole = !wa || (Math.abs(wa[0]) < eps && Math.abs(wa[1] - c.duration) < eps);
  const start = whole ? 0 : wa[0];
  const span = whole ? c.duration : wa[1];
  const layers: AeLayerPlan[] = [];
  const notCompared: string[] = [];
  let total = 0;
  for (const l of Array.isArray(c.layers) ? c.layers : []) {
    if (l.kind !== 'solid') continue;
    const name = l.name ?? `layer ${l.index}`;
    // Separated dimensions: X Position and Y Position hold the keys (Position itself has none), so the solid is said, not skipped.
    if (l.transform?.position?.separated) { notCompared.push(`${name}: its Position is separated into X and Y Position, which hold its keys`); continue; }
    const keys = l.transform?.position?.keys;
    if (!keys?.length) continue;
    const colour = Array.isArray(l.color) && l.color.length === 3 && l.color.every((x) => finite(x) && x >= 0 && x <= 1) ? l.color as number[] : undefined;
    if (!colour) { notCompared.push(`${name}: its colour was not reported`); continue; }
    const why = whyNotComparable(l);
    if (why) { notCompared.push(`${name}: ${why}`); continue; }
    if (layers.length >= MAX_LAYERS_COMPARED) { notCompared.push(`${name}: past the ${MAX_LAYERS_COMPARED} layers one readback compares`); continue; }
    const from = finite(l.in_point) ? Math.max(l.in_point, start) : start;
    const to = finite(l.out_point) ? Math.min(l.out_point, start + span) : start + span;
    const wanted: Array<{ t: number; at: 'key' | 'halfway' }> = [];
    for (let i = 0; i < keys.length; i++) {
      wanted.push({ t: keys[i][0] as number, at: 'key' });
      if (i + 1 < keys.length) wanted.push({ t: ((keys[i][0] as number) + (keys[i + 1][0] as number)) / 2, at: 'halfway' });
    }
    const seen = new Set<string>();
    const times = wanted.filter((w) => w.t >= from - eps && w.t < to - eps).filter((w) => { const k = r3(w.t).toFixed(3); if (seen.has(k)) return false; seen.add(k); return true; });
    const outside = wanted.length - times.length;
    const room = Math.min(MAX_SAMPLES_PER_LAYER, AE_MAX_SAMPLES - total);
    const kept = times.slice(0, Math.max(0, room));
    if (outside > 0 && !kept.length) { notCompared.push(`${name}: none of its key times falls while it is shown (${n3(from)}–${n3(to)} s) in the render`); continue; }
    if (!kept.length) { notCompared.push(`${name}: past the ${AE_MAX_SAMPLES} samples one readback reads`); continue; }
    if (times.length > kept.length) notCompared.push(`${name}: ${times.length - kept.length} more of its times are not read (a readback reads at most ${MAX_SAMPLES_PER_LAYER} per layer and ${AE_MAX_SAMPLES} in all)`);
    total += kept.length;
    layers.push({ layer: l, name, colour: [...colour], times: kept });
  }
  return {
    comp: { name: c.name ?? '(unnamed)', width: c.width, height: c.height, fps: c.fps, duration: c.duration, ...(wa ? { work_area: [wa[0], wa[1]] as [number, number] } : {}) },
    start, expected_duration: span, layers, not_compared: notCompared,
    file: { schema: 'timmy.video-readback-plan/1', comp: { width: c.width, height: c.height, start }, targets: layers.map((p) => ({ layer: p.name, colour: p.colour, times: p.times.map((x) => x.t) })) },
  };
}

// ── the worker's output ─────────────────────────────────────────────────────────

export interface VideoSample {
  layer: string; time: number; frame: number; frame_time: number; colour_rgb8: number[];
  pixels?: number; found?: boolean; centroid_comp?: [number, number]; centroid_video?: [number, number]; box_video?: number[]; why?: string;
}
export interface VideoReadback {
  ok: true;
  worker: { name: string; version: string };
  python?: string;
  tools: { ffprobe?: { found?: string | null; version?: string | null }; ffmpeg?: { found?: string | null; version?: string | null } };
  source: { name: string; sha256: string; bytes: number };
  unchanged_during_read: boolean;
  probe: {
    codec: string | null; pix_fmt: string | null; format: string | null; width: number; height: number; fps: [number, number]; fps_value: number;
    duration: number | null; duration_from: string | null; frames: number | null; frames_from: string | null;
  };
  scale: number;
  scaled: [number, number];
  colour_tolerance: number;
  colour_metric: string;
  samples: VideoSample[];
  frames: Array<{ frame: number; time: number; png?: string; written?: boolean; sha256?: string; bytes?: number; why?: string }>;
  samples_left_out?: number;
}
export interface VideoReadbackFailure { ok: false; worker?: { name: string; version: string }; code: string; error: string }

const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const numOrNull = (v: unknown): number | null => (finite(v) ? v : null);
const pair = (v: unknown): [number, number] | undefined => (Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]) ? [v[0], v[1]] : undefined);

/**
 * The worker's output (stdout and stderr as the job logged them): its one JSON line is the last line that parses as an
 * object naming a worker. A success must carry what it claims (the source's sha256, the probe's size and frame rate, its
 * samples); anything less is a failure, with the reason. Nothing is filled in.
 */
export function parseVideoReadback(output: string): VideoReadback | VideoReadbackFailure {
  let found: Record<string, unknown> | undefined;
  for (const line of output.split('\n').reverse()) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const o = objOf(JSON.parse(t));
      if (o && objOf(o.worker) && typeof o.ok === 'boolean') { found = o; break; }
    } catch { /* not the worker's line */ }
  }
  if (!found) return { ok: false, code: 'no-output', error: output.trim() ? 'the worker printed no result line (its output is kept in the log)' : 'the worker printed nothing' };
  const w = objOf(found.worker)!;
  const worker = text(w.name) && text(w.version) ? { name: w.name, version: w.version } : undefined;
  if (!worker) return { ok: false, code: 'malformed', error: 'the result line names no worker version' };
  if (found.ok !== true) {
    const e = objOf(found.error);
    return { ok: false, worker, code: text(e?.code) ? e!.code as string : 'failed', error: text(e?.message) ? (e!.message as string).slice(0, 400) : 'the worker reported a failure without a message' };
  }
  const src = objOf(found.source);
  if (!src || !text(src.sha256) || !/^[0-9a-f]{64}$/.test(src.sha256) || !finite(src.bytes)) return { ok: false, worker, code: 'malformed', error: 'the result line has no sha256 of what it read' };
  const p = objOf(found.probe);
  const fps = pair(p?.fps);
  if (!p || !finite(p.width) || !finite(p.height) || !fps || !finite(p.fps_value)) return { ok: false, worker, code: 'malformed', error: 'the result line has no size or frame rate from ffprobe' };
  const scaled = pair(found.scaled);
  if (!finite(found.scale) || !scaled || !finite(found.colour_tolerance)) return { ok: false, worker, code: 'malformed', error: 'the result line does not say the scale it read at or its colour tolerance' };
  if (!Array.isArray(found.samples) || !Array.isArray(found.frames)) return { ok: false, worker, code: 'malformed', error: 'the result line has no samples or frames list' };
  const samples: VideoSample[] = [];
  for (const raw of found.samples) {
    const s = objOf(raw);
    if (!s || !text(s.layer) || !finite(s.time) || !finite(s.frame) || !finite(s.frame_time)) return { ok: false, worker, code: 'malformed', error: 'a sample names no layer, time or frame' };
    const c = pair(s.centroid_comp);
    if (s.found === true && !c) return { ok: false, worker, code: 'malformed', error: `a sample of ${s.layer} says found but gives no centroid` };
    samples.push({
      layer: s.layer, time: s.time, frame: s.frame, frame_time: s.frame_time, colour_rgb8: Array.isArray(s.colour_rgb8) ? (s.colour_rgb8 as unknown[]).filter(finite) : [],
      ...(finite(s.pixels) ? { pixels: s.pixels } : {}), ...(typeof s.found === 'boolean' ? { found: s.found } : {}),
      ...(c ? { centroid_comp: c } : {}), ...(pair(s.centroid_video) ? { centroid_video: pair(s.centroid_video)! } : {}),
      ...(Array.isArray(s.box_video) && s.box_video.length === 4 && s.box_video.every(finite) ? { box_video: s.box_video as number[] } : {}),
      ...(text(s.why) ? { why: s.why.slice(0, 300) } : {}),
    });
  }
  const frames = (found.frames as unknown[]).map(objOf).filter((f): f is Record<string, unknown> => !!f && finite(f.frame)).map((f) => ({
    frame: f.frame as number, time: finite(f.time) ? f.time : 0,
    ...(text(f.png) && /^frame-\d{6}\.png$/.test(f.png) ? { png: f.png } : {}), ...(typeof f.written === 'boolean' ? { written: f.written } : {}),
    ...(text(f.sha256) && /^[0-9a-f]{64}$/.test(f.sha256) ? { sha256: f.sha256 } : {}), ...(finite(f.bytes) ? { bytes: f.bytes } : {}), ...(text(f.why) ? { why: f.why.slice(0, 300) } : {}),
  }));
  const tools = objOf(found.tools) ?? {};
  const tool = (v: unknown): { found?: string | null; version?: string | null } | undefined => { const o = objOf(v); return o ? { found: strOrNull(o.found), version: strOrNull(o.version) } : undefined; };
  return {
    ok: true, worker, ...(text(found.python) ? { python: found.python } : {}),
    tools: { ...(tool(tools.ffprobe) ? { ffprobe: tool(tools.ffprobe)! } : {}), ...(tool(tools.ffmpeg) ? { ffmpeg: tool(tools.ffmpeg)! } : {}) },
    source: { name: text(src.name) ? src.name : '', sha256: src.sha256, bytes: src.bytes },
    unchanged_during_read: found.unchanged_during_read === true,
    probe: {
      codec: strOrNull(p.codec), pix_fmt: strOrNull(p.pix_fmt), format: strOrNull(p.format), width: p.width as number, height: p.height as number, fps, fps_value: p.fps_value as number,
      duration: numOrNull(p.duration), duration_from: strOrNull(p.duration_from), frames: numOrNull(p.frames), frames_from: strOrNull(p.frames_from),
    },
    scale: found.scale as number, scaled, colour_tolerance: found.colour_tolerance as number, colour_metric: text(found.colour_metric) ? found.colour_metric : '',
    samples, frames, ...(finite(found.samples_left_out) ? { samples_left_out: found.samples_left_out } : {}),
  };
}

// ── the comparison ──────────────────────────────────────────────────────────────

/** One check: After Effects' report (or the position it implies) against what the readback measured. */
export interface AeReadbackCheck {
  name: string;
  /** After Effects' own report, or the position its keys put the layer at then */
  reported: unknown;
  measured: unknown;
  difference?: number | number[] | null;
  tolerance: string;
  /** null: not compared (`note` says why) */
  passed: boolean | null;
  note?: string;
}
export interface AeTolerance { x_px: number; y_px: number; rule: string; colour: number; colour_metric: string }

/** Where a layer's keys put its Position at comp time `t`, and how; or why that cannot be said. */
export function expectedAt(p: AeKeyed, t: number): { ok: true; at: [number, number]; how: string } | { ok: false; why: string } {
  const keys = (p.keys ?? []).filter((k): k is [number, AeValue] => finite(k[0]) && !!xy(k[1]));
  if (!keys.length) return { ok: false, why: 'its Position keys were not reported' };
  for (const [kt, v] of keys) if (Math.abs(kt - t) < eps) return { ok: true, at: xy(v)!, how: 'its key' };
  if (t < keys[0][0]) return { ok: true, at: xy(keys[0][1])!, how: 'held before its first key' };
  const last = keys[keys.length - 1];
  if (t > last[0]) {
    if (p.keys_truncated) return { ok: false, why: 'it is past the last key reported (its later keys were not reported)' };
    return { ok: true, at: xy(last[1])!, how: 'held after its last key' };
  }
  const i = keys.findIndex((k, n) => n + 1 < keys.length && k[0] < t && t < keys[n + 1][0]);
  const [t0, v0] = keys[i];
  const [t1, v1] = keys[i + 1];
  const outType = p.interpolation?.[i]?.[1] ?? null;
  const inType = p.interpolation?.[i + 1]?.[0] ?? null;
  if (outType === 'hold') return { ok: true, at: xy(v0)!, how: `held from the key at ${n3(t0)} s (hold)` };
  if (outType === null || inType === null) return { ok: false, why: `the interpolation between its keys at ${n3(t0)} s and ${n3(t1)} s was not reported: compared at key times only` };
  if (outType !== 'linear' || inType !== 'linear') return { ok: false, why: `it is eased (${outType} out, ${inType} in) between its keys at ${n3(t0)} s and ${n3(t1)} s: compared at key times only` };
  const a = xy(v0)!;
  const b = xy(v1)!;
  const straight = straightPath(a, b, p.spatial_tangents?.[i]?.[1], p.spatial_tangents?.[i + 1]?.[0]);
  if (straight !== true) return { ok: false, why: `${straight} between its keys at ${n3(t0)} s and ${n3(t1)} s: compared at key times only` };
  const u = (t - t0) / (t1 - t0);
  return { ok: true, at: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], how: `linear between its keys at ${n3(t0)} s and ${n3(t1)} s` };
}

/**
 * Whether the motion path between two keys is the straight segment, travelled once: true, or the words why not. Both
 * spatial tangents zero, or both along the segment, pointing inward and together no longer than it (a cubic whose
 * control points lie on the segment in order). With linear interpolation in time, After Effects moves at a constant
 * speed along the path, so the position is then the linear interpolation.
 */
function straightPath(a: [number, number], b: [number, number], out: AeValue | undefined, inn: AeValue | undefined): true | string {
  const to = xy(out ?? undefined);
  const ti = xy(inn ?? undefined);
  if (!to || !ti) return 'its motion path\'s tangents were not reported';
  const len = (v: [number, number]): number => Math.hypot(v[0], v[1]);
  if (len(to) < eps && len(ti) < eps) return true;
  const d: [number, number] = [b[0] - a[0], b[1] - a[1]];
  const L = len(d);
  if (L < eps) return 'its motion path is a loop';
  const cross = (u: [number, number]): number => Math.abs(d[0] * u[1] - d[1] * u[0]);
  const dot = (u: [number, number]): number => d[0] * u[0] + d[1] * u[1];
  const along = cross(to) <= 1e-6 * L * Math.max(1, len(to)) && cross(ti) <= 1e-6 * L * Math.max(1, len(ti)) && dot(to) >= 0 && dot(ti) <= 0;
  return along && len(to) + len(ti) <= L * (1 + 1e-9) ? true : 'its motion path is curved (its spatial tangents)';
}

/** The tolerance: 2% of the comp's width or height, or 2 pixels of the scaled frame in comp pixels, whichever is larger. */
export function aeTolerance(comp: { width: number; height: number }, read: Pick<VideoReadback, 'scale' | 'probe' | 'colour_tolerance' | 'colour_metric'>): AeTolerance {
  const px = (size: number, video: number): number => 2 * read.scale * (size / video);
  return {
    x_px: r3(Math.max(0.02 * comp.width, px(comp.width, read.probe.width))), y_px: r3(Math.max(0.02 * comp.height, px(comp.height, read.probe.height))),
    rule: AE_TOLERANCE_RULE, colour: read.colour_tolerance, colour_metric: read.colour_metric,
  };
}

/**
 * After Effects' report against the render: the comp's size, frame rate, duration and frame count against ffprobe's,
 * then each sampled solid's centroid against where its keys put it then (its key, or linear between keys when both keys
 * are linear and its path is straight; held before the first and after the last). A sample at a time between keys whose
 * interpolation is not linear, or not reported, is not compared (its note says why); a layer not found where After
 * Effects says it is shown differs. matches only when every check made passes.
 */
export function compareAeReadback(plan: AeReadbackPlan, read: VideoReadback): { verdict: 'matches' | 'differs'; checks: AeReadbackCheck[]; tolerance: AeTolerance; not_compared: string[] } {
  const c = plan.comp;
  const pr = read.probe;
  const checks: AeReadbackCheck[] = [];
  checks.push({ name: 'comp size', reported: [c.width, c.height], measured: [pr.width, pr.height], difference: [pr.width - c.width, pr.height - c.height], tolerance: 'exact', passed: pr.width === c.width && pr.height === c.height });
  const fpsTol = Math.max(1e-3, 1e-4 * c.fps);
  checks.push({ name: 'frame rate', reported: c.fps, measured: `${pr.fps[0]}/${pr.fps[1]} (${n3(pr.fps_value)})`, difference: r3(pr.fps_value - c.fps), tolerance: `${fpsTol} fps`, passed: Math.abs(pr.fps_value - c.fps) <= fpsTol });
  const frame = 1 / c.fps;
  // The render's expected length: the comp's, or its work area's when the work area is not the whole comp (said in the note).
  const area = plan.start || Math.abs(plan.expected_duration - c.duration) > eps ? `the comp's work area, ${n3(plan.start)}–${n3(plan.start + plan.expected_duration)} s` : '';
  const reportedDuration = r3(plan.expected_duration);
  if (pr.duration === null) checks.push({ name: 'duration (s)', reported: reportedDuration, measured: null, tolerance: 'one frame', passed: null, note: [area, 'ffprobe gave no duration'].filter(Boolean).join('; ') });
  else {
    const d = pr.duration - plan.expected_duration;
    const ok = Math.abs(d) <= frame + eps;
    const whole = area && !ok && Math.abs(pr.duration - c.duration) <= frame + eps ? `the render is as long as the whole comp (${n3(c.duration)} s), not its work area` : '';
    const note = [area, whole].filter(Boolean).join('; ');
    checks.push({ name: 'duration (s)', reported: reportedDuration, measured: r3(pr.duration), difference: r3(d), tolerance: `one frame (${n3(frame)} s)`, passed: ok, ...(note ? { note } : {}) });
  }
  const want = Math.round(plan.expected_duration * c.fps);
  if (pr.frames === null) checks.push({ name: 'frame count', reported: want, measured: null, tolerance: 'exact', passed: null, note: 'ffprobe gave no frame count' });
  else checks.push({ name: 'frame count', reported: want, measured: pr.frames, difference: pr.frames - want, tolerance: 'exact', passed: pr.frames === want, note: `${pr.frames_from ?? 'counted'}; After Effects' duration x frame rate` });
  const tol = aeTolerance(c, read);
  const notCompared = [...plan.not_compared];
  for (const lp of plan.layers) {
    const pos = lp.layer.transform!.position!;
    const scaled = scaleOf(lp.layer);
    for (const s of read.samples.filter((x) => x.layer === lp.name)) {
      const name = `${lp.name} at ${n3(s.frame_time)} s`;
      if (s.why) { checks.push({ name, reported: null, measured: null, tolerance: '', passed: null, note: `not read: ${s.why}` }); continue; }
      const e = expectedAt(pos, s.frame_time);
      if (!e.ok) { checks.push({ name, reported: null, measured: s.centroid_comp ?? null, tolerance: '', passed: null, note: e.why }); continue; }
      // Its half extent on screen: half its scaled size when it is not rotated, else half its diagonal (any rotation).
      const rot = lp.layer.transform?.rotation;
      const upright = !!rot && !rot.keys?.length && finite(rot.value) && Math.abs(rot.value % 360) < eps;
      const half: [number, number] = scaled ? (upright ? [scaled[0] / 2, scaled[1] / 2] : [Math.hypot(scaled[0], scaled[1]) / 2, Math.hypot(scaled[0], scaled[1]) / 2]) : [0, 0];
      if (scaled && (e.at[0] - half[0] < -eps || e.at[1] - half[1] < -eps || e.at[0] + half[0] > c.width + eps || e.at[1] + half[1] > c.height + eps)) {
        checks.push({ name, reported: e.at, measured: s.centroid_comp ?? null, tolerance: '', passed: null, note: `its keys put it at least partly outside the frame then (${pointText(e.at)}), where only the part inside is drawn: not compared` });
        continue;
      }
      if (!s.found || !s.centroid_comp) {
        checks.push({ name, reported: e.at, measured: null, tolerance: `${tol.x_px} x, ${tol.y_px} y comp pixels`, passed: false, note: `${e.how}; no pixel within ${tol.colour} of its colour (${s.colour_rgb8.join(', ')} in 8-bit RGB) in the frame read: it is not where After Effects says it is shown` });
        continue;
      }
      const area = scaled ? (scaled[0] * scaled[1]) * (pr.width / c.width) * (pr.height / c.height) / (read.scale * read.scale) : undefined;
      if (area !== undefined && finite(s.pixels) && s.pixels > 3 * area + 64) {
        checks.push({ name, reported: e.at, measured: s.centroid_comp, tolerance: '', passed: null, note: `${s.pixels} pixels of its colour, more than three times what it covers (${Math.round(area)}): other content shares its colour, so its centroid is not its own` });
        continue;
      }
      const d: [number, number] = [r3(s.centroid_comp[0] - e.at[0]), r3(s.centroid_comp[1] - e.at[1])];
      checks.push({
        name, reported: [r3(e.at[0]), r3(e.at[1])], measured: s.centroid_comp, difference: d, tolerance: `${tol.x_px} x, ${tol.y_px} y comp pixels`,
        passed: Math.abs(d[0]) <= tol.x_px && Math.abs(d[1]) <= tol.y_px, note: `${e.how}; ${s.pixels ?? 0} pixels of its colour; frame ${s.frame}`,
      });
    }
  }
  if (read.samples_left_out) notCompared.push(`${read.samples_left_out} samples the worker did not read (its own limits)`);
  return { verdict: checks.some((x) => x.passed === false) ? 'differs' : 'matches', checks, tolerance: tol, not_compared: notCompared };
}

/** A solid's size on screen in comp pixels at its (static) Scale, or undefined when Scale is keyed or not reported. */
function scaleOf(l: AeLayerReport): [number, number] | undefined {
  const s = l.transform?.scale;
  const sc = s && !s.keys?.length ? xy(s.value) : undefined;
  if (!sc || !Array.isArray(l.size) || !finite(l.size[0]) || !finite(l.size[1])) return undefined;
  return [Math.abs(l.size[0] * sc[0] / 100), Math.abs(l.size[1] * sc[1] / 100)];
}

/** The failing checks in words, for the verdict's why. */
export function differencesText(checks: AeReadbackCheck[]): string {
  return checks.filter((c) => c.passed === false).slice(0, 6).map((c) => {
    const pts = (v: unknown): string => (Array.isArray(v) ? pointText(v as number[]) : v === null || v === undefined ? 'nothing' : String(v));
    return c.name.includes(' at ') && Array.isArray(c.reported)
      ? `${c.name}: After Effects' keys put it at ${pts(c.reported)}, the render shows it at ${pts(c.measured)}${Array.isArray(c.difference) ? ` (off by ${pts(c.difference)})` : ''}`
      : `${c.name}: After Effects reported ${pts(c.reported)}, the render has ${pts(c.measured)}`;
  }).join('; ');
}

// ── the flow record ─────────────────────────────────────────────────────────────

export type AeFlowStep = 'prepare' | 'agent' | 'checks' | 'author' | 'render' | 'readback' | 'record';

/** The agent's part of a flow record (as the other flows keep it). */
export interface AeFlowAgentPart {
  run: string; agent: string; version: string | null; route: string; where: string; model: string | null; job: string;
  outcome?: string; why?: string;
  files_changed?: Array<{ path: string; how: 'added' | 'changed' | 'deleted'; sha256_before?: string | null; sha256_after?: string | null }>;
  /** files other than the script it changed (the flow stopped before After Effects ran; nothing was reverted) */
  others?: OtherChange[];
  result?: string; transcript?: string; progress?: string;
  cost_usd?: number | null; cost_basis?: string;
  receipt?: string;
}

/** An After Effects flow's record, results/flows/<flow-id>.json: the flow schema (timmy.flow/1) with target 'ae'. */
export interface AeFlowRecord {
  flow: 1;
  schema: typeof FLOW_SCHEMA;
  id: string;
  kind: 'iterate';
  target: 'ae';
  instruction: string;
  project: string;
  started_at: string;
  ended_at?: string;
  outcome: FlowOutcome;
  ended_in?: AeFlowStep;
  why?: string;
  /** what the line asked: the comp to render (--comp) and an output module template (--om, passed as given) */
  options?: { comp?: string; om?: string };
  script: {
    path: string;
    before: { sha256: string; bytes: number; lines: number; kept?: string };
    after?: { sha256: string; bytes: number; lines: number };
    change?: ScriptChange;
    syntax?: AeCompileCheck;
  };
  agent?: AeFlowAgentPart;
  /** the /ae author run: After Effects runs the script in a new project and reports it */
  author?: {
    job?: string; run?: string; record?: string; state: string;
    outcome?: 'ok' | 'failed' | 'unknown'; why?: string; name?: string; version?: number;
    aep?: { path: string; sha256: string; bytes: number };
    copy?: { path: string; sha256: string };
    result?: { path: string; sha256?: string };
    ae_version?: string;
    comps?: Array<{ name: string | null; width: number | null; height: number | null; fps: number | null; duration: number | null; layers: number }>;
    error?: string; stage?: string; error_line?: number;
    log?: string; failure_files?: string[]; receipt?: string;
  };
  /** the aerender run of the comp, and the file it wrote */
  render?: {
    job?: string; run?: string; record?: string; state: string; comp?: string; requested?: string; om_template?: string;
    outcome?: 'ok' | 'failed' | 'unknown'; why?: string;
    file?: { path: string; sha256: string; bytes?: number; instead: boolean };
    log?: string; failure_files?: string[]; receipt?: string; error?: string;
  };
  readback?: {
    job?: string;
    /** 'not run' when it could not start (the setup step is `setup`) */
    state: string;
    worker?: { name: string; version: string };
    tools?: VideoReadback['tools'];
    plan?: { path: string; sha256: string };
    video?: { path: string; sha256: string };
    probe?: VideoReadback['probe'];
    scale?: number; scaled?: [number, number];
    tolerance?: AeTolerance;
    checks?: AeReadbackCheck[];
    not_compared?: string[];
    frames?: Array<{ path: string; frame: number; time: number; sha256: string }>;
    verdict?: 'matches' | 'differs' | 'failed';
    reason?: string; setup?: string; log?: string; receipt?: string;
    label: string;
    reported_by: string;
  };
  /** the comp as an earlier judged-ok /ae author run of the script as it was reported it, and as this run's did */
  before_after?: {
    reported_by: string;
    before: (AeCompFacts & { run: string; job?: string; started_at: string }) | null;
    before_note?: string;
    after?: AeCompFacts & { run: string; job?: string };
    changes?: string[];
  };
  receipts: { agent?: string; author?: string; render?: string; readback?: string };
  child_receipts: string[];
  doctrine: string;
}

/** Whether a record (as read from its file) is an After Effects flow's. */
export function isAeFlowRecord(r: unknown): r is AeFlowRecord {
  const o = objOf(r);
  return !!o && o.kind === 'iterate' && o.target === 'ae' && !!objOf(o.script);
}

/** An After Effects flow in a few words for /iterate's list ("ae author.jsx +1 −1 lines in 1 place"); '' for any other record. */
export function aeFlowSummary(r: unknown): string {
  if (!isAeFlowRecord(r)) return '';
  const p = typeof r.script.path === 'string' ? r.script.path : '?';
  const c = objOf(r.script.change) && finite(r.script.change!.added) ? ` ${changeText(r.script.change!)}` : '';
  const without = r.outcome === 'succeeded' && r.readback?.state === 'not run' ? ' · without readback' : '';
  return `ae ${p}${c}${without}`;
}
