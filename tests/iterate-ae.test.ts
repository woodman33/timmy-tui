/**
 * Round R4 (/iterate ae, helper H41): the After Effects flow, driven end to end through the Workspace: a local code agent
 * changes one ExtendScript authoring script, /ae author's own judged job runs it, aerender renders its first comp, the
 * render is read back outside After Effects and compared with After Effects' own report, and the flow is kept as a record
 * with a receipt. Real files, real child processes, real job lifecycles.
 *
 * FAKE pieces, each labelled:
 * - the code agent is tests/fixtures/fake-code-agent.mjs (a TEST DOUBLE: no model, nothing sent), run through /agent's own
 *   start as Qwen Code on a local endpoint; its PYFILE, PYREPLACE, PYBREAK, OTHERFILE and SLEEP words edit author.jsx;
 * - After Effects is tests/fixtures/fake-afterfx.mjs (a TEST DOUBLE: it runs Timmy's harness and the script on a small
 *   stand-in of After Effects' scripting objects and saves FAKE projects); two tests use a FAKE After Effects that only sleeps;
 * - aerender is tests/fixtures/fake-aerender.mjs (a TEST DOUBLE: for a FAKE project it writes a FAKE video, JSON describing
 *   the comp's solids as coloured rectangles at their keyed positions); FAKE_AERENDER_SHIFT moves them (a render that
 *   disagrees with its project), FAKE_AERENDER_MODE=mov-for-mp4 writes a .mov when asked for a .mp4; one test uses a FAKE
 *   aerender that only sleeps;
 * - ffprobe and ffmpeg are tests/fixtures/fake-ffprobe.mjs and fake-ffmpeg.mjs (TEST DOUBLES that read the FAKE video and
 *   draw the frames asked for); the readback worker is the real workers/readback/video_readback.py, run with this
 *   machine's python3 (the flow tests are skipped without one).
 * No After Effects, aerender, FFmpeg or model runs here: a pass says the flow, the judgements, the readback's arithmetic,
 * the record and the card agree with each other and with the stand-ins, not that After Effects renders what it reports.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { folderProject } from '../src/project/index.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { parseIterateLine } from '../src/repl/iterate.js';
import { AE_ITERATE_USAGE } from '../src/repl/iterate-ae.js';
import { aeFlowCard, type AeCardHelpers } from '../src/repl/board-flows-ae.js';
import { glyphSet } from '../src/term/glyphs.js';
import { hashOf, type Receipt, type ReceiptInput } from '../src/utils/receipts.js';
import { DOCTRINE_15, FLOW_ID } from '../src/flows/iterate.js';
import { FLOW_QUIET_MS } from '../src/repl/recover.js';
import {
  AE_COMPILE_CHECK, AE_READBACK_LABEL, AE_REPORTED_BY, AE_TOLERANCE_RULE, aeIterateTask, compareAeReadback, compFacts, compileCheck, compileWords, differencesText,
  expectedAt, factsChanges, planReadback, type AeFlowRecord, type AeReadbackPlan, type VideoReadback, type VideoSample,
} from '../src/flows/iterate-ae.js';
import type { AeCompReport, AeInterpolation, AeKeyed, AeLayerReport } from '../src/native/ae-author.js';

const REPO = path.resolve(__dirname, '..');
const FIXTURES = path.join(REPO, 'tests', 'fixtures');
const FAKE_AGENT = path.join(FIXTURES, 'fake-code-agent.mjs');
const STARTER = path.join(REPO, 'templates', 'ae-starter', 'author.jsx');
const which = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
const python = which.status === 0 ? which.stdout.trim() : '';
if (!python) {
  // eslint-disable-next-line no-console
  console.log('[iterate-ae.test] the flow tests are skipped: no python3 here (the readback worker is a Python script)');
}

let root: string;
let fixtures: string;
/** The FAKE tools, installed as executables for each test (see the header). */
let fake: { afterfx: string; aerender: string; ffprobe: string; ffmpeg: string };
const spaces: Workspace[] = [];
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const starterBytes = (): Buffer => fs.readFileSync(STARTER);
/** The edit the tests ask the FAKE agent for: the Mover starts at x 480 (the starter's `[240,` → `[480,`). */
const RIGHTER = 'PYFILE:author.jsx PYREPLACE:[240,=>[480,';

/** An executable copy of a FAKE tool in this test's own folder. */
function install(fixture: string, name: string): string {
  const at = path.join(fixtures, 'bin', name);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, fixture), at);
  fs.chmodSync(at, 0o755);
  return at;
}
/** A FAKE program (a test double) that only waits until it is stopped. */
function sleeper(name: string): string {
  const at = path.join(fixtures, 'bin', name);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.writeFileSync(at, `#!/bin/sh\n# a FAKE ${name} (a test double) that only waits until it is stopped\nexec sleep 30\n`, { mode: 0o755 });
  return at;
}

function make(o: { env?: Record<string, string | undefined>; jobsDir?: string } = {}) {
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const env: Record<string, string> = {
    TIMMY_AGENT_QWEN_BIN: FAKE_AGENT, TIMMY_AGENT_MODEL: 'qwen3:4b',
    TIMMY_AFTERFX: fake.afterfx, TIMMY_AERENDER: fake.aerender, TIMMY_FFPROBE: fake.ffprobe, TIMMY_FFMPEG: fake.ffmpeg,
  };
  for (const [k, v] of Object.entries(o.env ?? {})) { if (v === undefined) delete env[k]; else env[k] = v; }
  const deps: WorkspaceDeps = {
    glyphs: glyphSet(true),
    env,
    // python3 is this machine's; ffprobe and ffmpeg are never found on PATH here (only through TIMMY_FFPROBE and TIMMY_FFMPEG).
    onPath: (cmd) => (cmd === 'python3' ? python || null : null),
    notify: (l) => notes.push(l.map((s) => s.text).join('')),
    openWeb: (url) => url,
    link: (t) => t,
    seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
    jobsDir: o.jobsDir ?? path.join(fs.mkdtempSync(path.join(fixtures, 'jobs-')), 'jobs'),
    chdir: () => {},
    // Sealed as appendReceipt seals: each receipt's hash is the hash of its own body (what /board checks against).
    receipts: () => sealed.map((r, i) => {
      const body = { v: 1, id: `rc_${i}`, stream: 'runs', ts: '2026-10-09T09:00:01.000Z', ...r, prev_hash: 'genesis' };
      return { ...body, hash: hashOf({ ...body, hash: '' }) };
    }) as unknown as Receipt[],
  };
  const ws = new Workspace(deps, folderProject(root));
  spaces.push(ws);
  return { ws, notes, sealed };
}

const flowIdIn = (out: string): string => { const m = out.match(/Flow\s+(f[0-9a-f]{8})/); if (!m) throw Error(`no flow in: ${out}`); return m[1]; };
const agentJobIn = (out: string): string => { const m = out.match(/Agent\s+(j[0-9a-f]{6})/); if (!m) throw Error(`no agent job in: ${out}`); return m[1]; };
async function until(pred: () => boolean, ms = 60000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw Error('timed out'); await new Promise((r) => setTimeout(r, 50)); }
}
const recordOf = (id: string): AeFlowRecord => JSON.parse(fs.readFileSync(path.join(root, 'results', 'flows', `${id}.json`), 'utf8')) as AeFlowRecord;
const ended = (sealed: ReceiptInput[], id: string) => (): boolean => sealed.some((r) => r.kind === 'flow' && String(r.subject).includes(id));
const nativeRuns = (): string[] => { try { return fs.readdirSync(path.join(root, '.timmy', 'native')); } catch { return []; } };
const noAbsolute = (s: string): void => { for (const p of new Set([root, fs.realpathSync(root), fixtures, os.tmpdir(), REPO])) expect(s).not.toContain(p); };
const cardOf = (html: string): string => { const m = html.match(/<article class="card flow ae">([\s\S]*?)<\/article>/); if (!m) throw Error('no After Effects card on the board'); return m[1]; };

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'iterate-ae-project-')));
  fixtures = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'iterate-ae-fixtures-')));
  fs.copyFileSync(STARTER, path.join(root, 'author.jsx'));
  fake = {
    afterfx: install('fake-afterfx.mjs', 'AfterFX'), aerender: install('fake-aerender.mjs', 'aerender'),
    ffprobe: install('fake-ffprobe.mjs', 'ffprobe'), ffmpeg: install('fake-ffmpeg.mjs', 'ffmpeg'),
  };
});
afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(fixtures, { recursive: true, force: true });
}, 60000);

// ── the parts that decide (no processes) ────────────────────────────────────────

const linear = (n: number): Array<[AeInterpolation, AeInterpolation]> => Array.from({ length: n }, () => ['linear', 'linear']);
const zero = (n: number): Array<[number[], number[]]> => Array.from({ length: n }, () => [[0, 0], [0, 0]]);
function keyed(keys: Array<[number, number[]]>, more: Partial<AeKeyed> = {}): AeKeyed {
  return { num_keys: keys.length, keys, interpolation: linear(keys.length), spatial_tangents: zero(keys.length), ...more };
}
/** A solid as the harness reports the starter's Mover (the FAKE After Effects' defaults), keyed from (480, 760) to (1680, 760). */
function solid(name: string, o: Partial<AeLayerReport> = {}, t: Partial<NonNullable<AeLayerReport['transform']>> = {}): AeLayerReport {
  return {
    index: 1, name, kind: 'solid', in_point: 0, out_point: 10, enabled: true, three_d: false, effects: 0, masks: 0, blending: 'normal', track_matte: false,
    color: [0.2, 0.75, 0.4], size: [160, 160],
    transform: { position: keyed([[0, [480, 760]], [2, [1680, 760]]]), scale: { value: [100, 100, 100] }, opacity: { value: 100 }, rotation: { value: 0 }, anchor: { value: [80, 80, 0] }, ...t },
    ...o,
  };
}
const compOf = (layers: AeLayerReport[], o: Partial<AeCompReport> = {}): AeCompReport => ({ name: 'Main', width: 1920, height: 1080, fps: 30, duration: 10, num_layers: layers.length, layers, work_area: [0, 10], ...o });
function readOf(samples: VideoSample[], probe: Partial<VideoReadback['probe']> = {}): VideoReadback {
  return {
    ok: true, worker: { name: 'timmy-video-readback', version: '0.1.0' }, tools: {}, source: { name: 'out/ae/a-v1.mp4', sha256: 'a'.repeat(64), bytes: 1 }, unchanged_during_read: true,
    probe: { codec: 'h264', pix_fmt: 'yuv420p', format: 'mov,mp4,m4a,3gp,3g2,mj2', width: 1920, height: 1080, fps: [30, 1], fps_value: 30, duration: 10, duration_from: 'stream', frames: 300, frames_from: 'nb_frames', ...probe },
    scale: 4, scaled: [480, 270], colour_tolerance: 48, colour_metric: 'Euclidean distance in 8-bit RGB', samples, frames: [],
  };
}
const sample = (t: number, at: [number, number] | null, more: Partial<VideoSample> = {}): VideoSample => ({
  layer: 'Mover', time: t, frame: Math.round(t * 30), frame_time: t, colour_rgb8: [51, 191, 102],
  ...(at ? { pixels: 1600, found: true, centroid_comp: at, centroid_video: at } : { pixels: 0, found: false }), ...more,
});

describe('/iterate ae: the parts that decide (no processes)', () => {
  it('the command line: ae, the script, the instruction, --comp and --om (each way, once); the other targets do not take them', () => {
    expect(parseIterateLine('ae author.jsx "move the mover" --comp Main --om "H.264 - Match Render Settings - 15 Mbps" --model qwen3:4b')).toEqual({
      ok: true, request: { recipe: 'ae', file: 'author.jsx', instruction: 'move the mover', agent: 'qwen', model: 'qwen3:4b', comp: 'Main', om: 'H.264 - Match Render Settings - 15 Mbps' },
    });
    expect(parseIterateLine('ae motion/author.jsx move it --comp="Main Comp" --agent=codex')).toEqual({ ok: true, request: { recipe: 'ae', file: 'motion/author.jsx', instruction: 'move it', agent: 'codex', comp: 'Main Comp' } });
    expect(parseIterateLine('ae author.jsx move it')).toEqual({ ok: true, request: { recipe: 'ae', file: 'author.jsx', instruction: 'move it', agent: 'qwen' } });
    expect(parseIterateLine('ae')).toEqual({ ok: false, error: `Name the script: ${AE_ITERATE_USAGE}` });
    expect(parseIterateLine('ae --comp Main')).toEqual({ ok: false, error: `Name the script: ${AE_ITERATE_USAGE}` });
    expect(parseIterateLine('ae author.jsx')).toEqual({ ok: false, error: `Say what to change: ${AE_ITERATE_USAGE}` });
    expect(parseIterateLine('ae author.jsx move --comp')).toEqual({ ok: false, error: `--comp needs a value. Usage: ${AE_ITERATE_USAGE}` });
    expect(parseIterateLine('ae author.jsx move --om a --om=b')).toEqual({ ok: false, error: `--om is given twice. Usage: ${AE_ITERATE_USAGE}` });
    expect(parseIterateLine('ae author.jsx move --paid')).toMatchObject({ ok: false, error: expect.stringContaining('it has no --paid') });
    expect(parseIterateLine('ae author.jsx move --agent opencode')).toMatchObject({ ok: false, error: expect.stringContaining('OpenCode runs on your own account and costs money') });
    expect(parseIterateLine('freecad plate.py longer --comp Main')).toMatchObject({ ok: false, error: expect.stringContaining('No option --comp') });
    expect(parseIterateLine('nuke a.nk longer')).toMatchObject({ ok: false, error: expect.stringContaining('or blender <script.py> (and, for After Effects, ae <script.jsx>)') });
  });

  it('the task: the instruction first, then the one script, ExtendScript (ES3), the harness\'s part, and the script whole', () => {
    const t = aeIterateTask({ instruction: 'start the mover at x 480', scriptRel: 'motion/author.jsx', scriptText: "var comp = app.project.items.addComp('Main', 1920, 1080, 1, 10, 30);\n", name: 'author' });
    expect(t.split('\n')[0]).toBe('start the mover at x 480');
    expect(t).toContain('- Edit only motion/author.jsx. Do not create, change or delete any other file, and run no commands.');
    expect(t).toContain('- Keep it ExtendScript (ES3): var only (no let or const), no arrow functions, template strings or classes');
    expect(t).toContain('do not create, open, save or close a project (Timmy\'s harness does that)');
    expect(t).toContain('saves it as out/ae/author-v<N>.aep');
    expect(t.trimEnd().endsWith("motion/author.jsx now holds:\nvar comp = app.project.items.addComp('Main', 1920, 1080, 1, 10, 30);")).toBe(true);
  });

  it('the compile check: compiled by Node\'s vm.Script and never run; the error and its line; ExtendScript\'s preprocessor lines set aside; said as what it is', () => {
    const ok = compileCheck(starterBytes().toString('utf8'), 'author.jsx');
    expect(ok).toEqual({ checked: true, ok: true, by: "Node's vm.Script", node: process.version });
    // compiled, not run: a script that would leave a mark when run leaves none
    const g = globalThis as { timmyRanIt?: boolean };
    expect(compileCheck('globalThis.timmyRanIt = true;\n', 'mark.jsx')).toMatchObject({ ok: true });
    expect(g.timmyRanIt).toBeUndefined();
    const broken = compileCheck('var a = 1;\nvar b = ;\n', 'motion/broken.jsx');
    expect(broken).toMatchObject({ checked: true, ok: false, by: "Node's vm.Script", error: expect.stringMatching(/^SyntaxError: /), line: 2 });
    const pre = compileCheck('#target aftereffects\n#include "lib.jsx"\nvar a = 1;\nvar b = ;\n', 'pre.jsx');
    expect(pre).toMatchObject({ ok: false, line: 4, set_aside: 2 });
    expect(compileCheck('#target aftereffects\nvar a = 1;\n', 'pre.jsx')).toMatchObject({ ok: true, set_aside: 1 });
    expect(compileWords(ok)).toBe(`compiles (${AE_COMPILE_CHECK}: Node's vm.Script in Node ${process.version}, nothing run; not After Effects' own parser)`);
    expect(AE_COMPILE_CHECK).toBe('a modern-JavaScript compile check of ExtendScript (ES3) source');
    expect(compileWords(broken)).toMatch(new RegExp(`^does not compile: SyntaxError: .+, line 2 \\(${AE_COMPILE_CHECK.replace(/[()]/g, '\\$&')}: Node's vm\\.Script in Node v[0-9.]+, nothing run\\)$`));
    expect(compileWords(pre)).toContain('2 ExtendScript preprocessor lines (#target, #include…) set aside');
  });

  it('where the keys put a layer: its key, held before the first and after the last, linear between linear keys on a straight path; otherwise said, not guessed', () => {
    const p = keyed([[0, [480, 760]], [2, [1680, 760]]]);
    expect(expectedAt(p, 0)).toEqual({ ok: true, at: [480, 760], how: 'its key' });
    expect(expectedAt(p, 1)).toEqual({ ok: true, at: [1080, 760], how: 'linear between its keys at 0 s and 2 s' });
    expect(expectedAt(p, 0.5)).toMatchObject({ ok: true, at: [780, 760] });
    expect(expectedAt(p, 5)).toEqual({ ok: true, at: [1680, 760], how: 'held after its last key' });
    expect(expectedAt(keyed([[1, [0, 0]], [2, [10, 0]]]), 0.5)).toEqual({ ok: true, at: [0, 0], how: 'held before its first key' });
    // hold: the first key's value until the next key
    expect(expectedAt({ ...p, interpolation: [['linear', 'hold'], ['linear', 'linear']] }, 1)).toEqual({ ok: true, at: [480, 760], how: 'held from the key at 0 s (hold)' });
    // eased, not reported, curved, or past the reported keys: compared at key times only
    expect(expectedAt({ ...p, interpolation: [['linear', 'bezier'], ['bezier', 'linear']] }, 1)).toEqual({ ok: false, why: 'it is eased (bezier out, bezier in) between its keys at 0 s and 2 s: compared at key times only' });
    expect(expectedAt({ ...p, interpolation: undefined }, 1)).toEqual({ ok: false, why: 'the interpolation between its keys at 0 s and 2 s was not reported: compared at key times only' });
    expect(expectedAt({ ...p, spatial_tangents: [[[0, 0], [0, 300]], [[0, -300], [0, 0]]] }, 1)).toEqual({ ok: false, why: 'its motion path is curved (its spatial tangents) between its keys at 0 s and 2 s: compared at key times only' });
    expect(expectedAt({ ...p, spatial_tangents: undefined }, 1)).toEqual({ ok: false, why: 'its motion path\'s tangents were not reported between its keys at 0 s and 2 s: compared at key times only' });
    // tangents along the segment, pointing inward (as an auto-bezier path between two keys can be): still the straight path
    expect(expectedAt({ ...p, spatial_tangents: [[[0, 0], [400, 0]], [[-400, 0], [0, 0]]] }, 1)).toMatchObject({ ok: true, at: [1080, 760] });
    expect(expectedAt({ ...p, keys_truncated: true }, 5)).toEqual({ ok: false, why: 'it is past the last key reported (its later keys were not reported)' });
    expect(expectedAt({ value: [1, 2] }, 0)).toEqual({ ok: false, why: 'its Position keys were not reported' });
  });

  it('the plan: solids with Position keys and a colour, at key times and halfway, while shown in the render; every other keyed solid said with why', () => {
    const plan = planReadback(compOf([
      solid('Mover'),
      solid('Hidden', { enabled: false }), solid('Child', { parent: 'Mover' }), solid('Deep', { three_d: true }), solid('FX', { effects: 1 }), solid('Masked', { masks: 2 }),
      solid('Blend', { blending: 'other' }), solid('Matte', { track_matte: true }), solid('Faded', {}, { opacity: { value: 50 } }),
      solid('Fading', {}, { opacity: keyed([[0, [0]], [1, [100]]]) }), solid('Offset', {}, { anchor: { value: [0, 0, 0] } }),
      solid('Split', {}, { position: { separated: true, value: [0, 0] } }), solid('Uncoloured', { color: undefined }), solid('Late', { in_point: 3 }),
      solid('Still', {}, { position: { value: [960, 540, 0] } }), { index: 9, name: 'Title', kind: 'text', text: 'Title', transform: { position: keyed([[0, [0, 0]], [1, [5, 5]]]) } },
    ]));
    if ('error' in plan) throw Error(plan.error);
    expect(plan.layers.map((l) => [l.name, l.colour, l.times])).toEqual([['Mover', [0.2, 0.75, 0.4], [{ t: 0, at: 'key' }, { t: 1, at: 'halfway' }, { t: 2, at: 'key' }]]]);
    expect(plan).toMatchObject({ start: 0, expected_duration: 10, file: { schema: 'timmy.video-readback-plan/1', comp: { width: 1920, height: 1080, start: 0 }, targets: [{ layer: 'Mover', colour: [0.2, 0.75, 0.4], times: [0, 1, 2] }] } });
    expect(plan.not_compared).toEqual([
      'Hidden: it is hidden (its video switch is off)',
      'Child: it is parented to Mover: its Position is in its parent\'s space',
      'Deep: it is a 3D layer: where it lands depends on the camera',
      'FX: it has 1 effect, which can change how it is drawn',
      'Masked: it has 2 masks',
      'Blend: its blending mode is not Normal: its colour mixes with what is under it',
      'Matte: it uses a track matte',
      'Faded: its Opacity is 50, not 100: its colour mixes with what is under it',
      'Fading: its Opacity is keyed',
      'Offset: its Anchor Point (0, 0) is not at its centre (80, 80), so its centre is not at its Position',
      'Split: its Position is separated into X and Y Position, which hold its keys',
      'Uncoloured: its colour was not reported',
      'Late: none of its key times falls while it is shown (3–10 s) in the render',
    ]);
    // a work area from 1 s, 4 s long: the render's frame 0 shows comp time 1, and only the times inside it are read
    const later = planReadback(compOf([solid('Mover')], { work_area: [1, 4] }));
    if ('error' in later) throw Error(later.error);
    expect(later).toMatchObject({ start: 1, expected_duration: 4, file: { comp: { start: 1 }, targets: [{ times: [1, 2] }] } });
    expect(planReadback(compOf([], { fps: null }))).toEqual({ error: 'After Effects\' report of Main has no size, frame rate or duration to compare' });
  });

  it('the comparison: the comp\'s facts exactly or within a frame, each centroid within the tolerance; out of frame, a shared colour or an eased stretch not compared; a layer not found differs', () => {
    const plan = planReadback(compOf([solid('Mover')])) as AeReadbackPlan;
    const good = compareAeReadback(plan, readOf([sample(0, [480, 760]), sample(1, [1081.5, 761]), sample(2, [1680, 760])]));
    expect(good.verdict).toBe('matches');
    expect(good.tolerance).toEqual({ x_px: 38.4, y_px: 21.6, rule: AE_TOLERANCE_RULE, colour: 48, colour_metric: 'Euclidean distance in 8-bit RGB' });
    expect(good.checks.map((c) => [c.name, c.passed])).toEqual([['comp size', true], ['frame rate', true], ['duration (s)', true], ['frame count', true], ['Mover at 0 s', true], ['Mover at 1 s', true], ['Mover at 2 s', true]]);
    expect(good.checks[5]).toEqual({ name: 'Mover at 1 s', reported: [1080, 760], measured: [1081.5, 761], difference: [1.5, 1], tolerance: '38.4 x, 21.6 y comp pixels', passed: true, note: 'linear between its keys at 0 s and 2 s; 1600 pixels of its colour; frame 30' });
    // moved 200 pixels: differs, with the numbers
    const moved = compareAeReadback(plan, readOf([sample(0, [480, 760]), sample(1, [1280, 760]), sample(2, [1680, 760])]));
    expect(moved.verdict).toBe('differs');
    expect(differencesText(moved.checks)).toBe("Mover at 1 s: After Effects' keys put it at (1080, 760), the render shows it at (1280, 760) (off by (200, 0))");
    // not found where After Effects says it is shown: differs
    const gone = compareAeReadback(plan, readOf([sample(0, null)]));
    expect(gone.verdict).toBe('differs');
    expect(gone.checks.at(-1)).toMatchObject({ name: 'Mover at 0 s', passed: false, measured: null, note: 'its key; no pixel within 48 of its colour (51, 191, 102 in 8-bit RGB) in the frame read: it is not where After Effects says it is shown' });
    // a colour that other content shares, a frame the worker could not read: not compared (and so not a pass)
    const shared = compareAeReadback(plan, readOf([sample(0, [700, 700], { pixels: 9000 }), sample(1, null, { pixels: undefined, found: undefined, why: 'ffmpeg gave no frame for frame 30 (it exited 1)' })]));
    expect(shared.verdict).toBe('matches');
    expect(shared.checks.slice(4).map((c) => [c.passed, c.note])).toEqual([
      [null, '9000 pixels of its colour, more than three times what it covers (1600): other content shares its colour, so its centroid is not its own'],
      [null, 'not read: ffmpeg gave no frame for frame 30 (it exited 1)'],
    ]);
    // partly out of frame where its keys put it: only the part inside is drawn, so its centroid is not compared
    const edge = planReadback(compOf([solid('Mover', {}, { position: keyed([[0, [40, 760]], [2, [1680, 760]]]) })])) as AeReadbackPlan;
    expect(compareAeReadback(edge, readOf([sample(0, [80, 760])])).checks.at(-1)).toMatchObject({ passed: null, note: expect.stringMatching(/^its keys put it at least partly outside the frame then \(\(40, 760\)\)/) });
    // eased between its keys: the halfway sample is said, not compared
    const eased = planReadback(compOf([solid('Mover', {}, { position: keyed([[0, [480, 760]], [2, [1680, 760]]], { interpolation: [['linear', 'bezier'], ['bezier', 'linear']] }) })])) as AeReadbackPlan;
    expect(compareAeReadback(eased, readOf([sample(1, [1000, 760])])).checks.at(-1)).toMatchObject({ name: 'Mover at 1 s', passed: null, reported: null, note: expect.stringContaining('compared at key times only') });
    // the comp's facts: another size, a rate off by more than its tolerance, a render as long as the whole comp, not its work area
    const off = compareAeReadback(planReadback(compOf([solid('Mover')], { work_area: [1, 4] })) as AeReadbackPlan, readOf([], { width: 1280, height: 720, fps: [30000, 1001], fps_value: 29.97, duration: 10, frames: 300 }));
    expect(off.verdict).toBe('differs');
    expect(off.checks.slice(0, 4)).toMatchObject([
      { name: 'comp size', reported: [1920, 1080], measured: [1280, 720], passed: false },
      { name: 'frame rate', reported: 30, measured: '30000/1001 (29.97)', passed: false },
      { name: 'duration (s)', reported: 4, measured: 10, passed: false, note: "the comp's work area, 1–5 s; the render is as long as the whole comp (10 s), not its work area" },
      { name: 'frame count', reported: 120, measured: 300, passed: false },
    ]);
  });

  it('before → after: what After Effects reported changed, a line each', () => {
    const before = compFacts(compOf([solid('Mover', {}, { position: keyed([[0, [240, 760]], [2, [1680, 760]]]) }), { index: 2, name: 'Title', kind: 'text', text: 'Title' }, { index: 3, name: 'Old', kind: 'text', text: 'x' }]));
    const after = compFacts(compOf([solid('Mover'), solid('Badge', { color: [1, 0, 0], in_point: 1 }, { position: { value: [100, 100] } }), { index: 3, name: 'Title', kind: 'text', text: 'Hello' }], { width: 1280, height: 720 }));
    expect(factsChanges(before, after)).toEqual([
      'comp Main: 1920x1080, 30 fps, 10 s → 1280x720, 30 fps, 10 s',
      'Mover: Position 0 s (240, 760), 2 s (1680, 760) → 0 s (480, 760), 2 s (1680, 760)',
      '+ Badge (solid [1, 0, 0])',
      'Title: text "Title" → "Hello"',
      '− Old (text "x")',
    ]);
    expect(factsChanges(before, before)).toEqual([]);
  });

  it('the board card: every value escaped, links only through the board\'s helpers, who measured what said with the numbers', () => {
    const EVIL = '<img src=x onerror="alert(1)">&';
    const escaped = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;';
    const record = {
      flow: 1, schema: 'timmy.flow/1', id: 'f0123abcd', kind: 'iterate', target: 'ae', instruction: `move ${EVIL}`, project: 'demo', started_at: '2026-10-09T09:00:00.000Z', outcome: 'differs', ended_in: 'readback',
      why: `differs: ${EVIL}`, options: { comp: EVIL },
      script: { path: 'author.jsx', before: { sha256: 'b'.repeat(64), bytes: 10, lines: 2, kept: '.timmy/flows/f0123abcd/script.before.jsx' }, after: { sha256: 'c'.repeat(64), bytes: 11, lines: 2 },
        change: { added: 1, removed: 1, hunks: [{ before_line: 1, after_line: 1, removed: [`var a = "${EVIL}";`], added: ['var a = 2;'], removed_total: 1, added_total: 1 }], hunks_total: 1, method: 'line diff (longest common subsequence)' },
        syntax: { checked: true, ok: true, by: "Node's vm.Script", node: 'v22.0.0' } },
      agent: { run: 'a01234567', agent: 'qwen', version: null, route: 'local endpoint, no charge', where: '127.0.0.1:11434', model: EVIL, job: 'j000001', outcome: 'completed', cost_usd: 0 },
      author: { job: 'j000002', run: 'r1', state: 'completed', outcome: 'ok', name: EVIL, aep: { path: 'out/ae/a-v1.aep', sha256: 'd'.repeat(64), bytes: 9 }, error: EVIL },
      render: { job: 'j000003', run: 'r2', state: 'completed', comp: EVIL, requested: 'out/ae/a-v1.mp4', om_template: EVIL, outcome: 'ok', why: EVIL, file: { path: 'out/ae/a-v1.mov', sha256: 'e'.repeat(64), bytes: 5, instead: true } },
      readback: {
        job: 'j000004', state: 'completed', label: 'a record\'s own words are not shown', reported_by: 'nor these', verdict: 'differs', video: { path: 'out/ae/a-v1.mov', sha256: 'e'.repeat(64) },
        probe: { codec: EVIL, pix_fmt: null, format: null, width: 1920, height: 1080, fps: [30, 1], fps_value: 30, duration: 10, duration_from: null, frames: 300, frames_from: null },
        tolerance: { x_px: 38.4, y_px: 21.6, rule: EVIL, colour: 48, colour_metric: EVIL },
        checks: [{ name: `${EVIL} at 1 s`, reported: [1080, 760], measured: [1280, 760], difference: [200, 0], tolerance: '38.4 x, 21.6 y comp pixels', passed: false, note: EVIL }],
        not_compared: [`${EVIL}: its Opacity is keyed`], frames: [{ path: '.timmy/flows/f0123abcd/frames/frame-000030.png', frame: 30, time: 1, sha256: 'f'.repeat(64) }],
      },
      before_after: {
        reported_by: 'nor these', before: { ...compFacts(compOf([solid(EVIL, {}, { position: keyed([[0, [240, 760]], [2, [1680, 760]]]) })])), run: 'r0', started_at: '2026-10-09T08:00:00.000Z' },
        after: { ...compFacts(compOf([solid(EVIL)])), run: 'r1' }, changes: [`${EVIL}: Position 0 s (240, 760), 2 s (1680, 760) → 0 s (480, 760), 2 s (1680, 760)`],
      },
      receipts: { agent: 'id1', author: 'id2', render: 'id3', readback: 'id4' }, child_receipts: ['id1', 'id2', 'id3', 'id4'], doctrine: DOCTRINE_15,
    };
    const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    // The Flows section's helpers, as board-flows.ts lends them (a link for a project path, escaped).
    const h: AeCardHelpers = {
      file: (p, label) => `<a class="name" href="../../${esc(String(p))}">${esc(label ?? String(p))}</a>`,
      cmd: (c) => `<button type="button" class="cmd" data-cmd="${esc(c)}"><code>${esc(c)}</code></button>`,
      thumb: (p) => `<a class="thumb" href="../../${esc(String(p))}"><img src="../../${esc(String(p))}" alt="${esc(String(p))}" loading="lazy"></a>`,
    };
    const html = aeFlowCard({ file: 'results/flows/f0123abcd.json', record, check: { status: 'unverified' } }, h, '<div class="status status-unverified">unverified</div>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('onerror="');
    expect(html.split(escaped).length - 1).toBeGreaterThanOrEqual(14);
    expect(html).toContain(`<p class="instruction">move ${escaped}</p>`);
    expect(html).toContain(`<span class="removed">- var a = &quot;${escaped}&quot;;</span>`);
    expect(html).toContain('the comp, before → after: After Effects&#39; own report, as the record says (not verified)');
    expect(html).toContain(`<dt>reported by</dt><dd>${esc(AE_REPORTED_BY)}</dd>`);
    expect(html).toContain(`<p class="meta label">${esc(AE_READBACK_LABEL)}</p>`);
    expect(html).not.toContain('nor these');
    expect(html).not.toContain('a record&#39;s own words');
    expect(html).toContain('<th>After Effects reported</th><th>the render, measured</th>');
    expect(html).toContain('<tr class="bad">');
    expect(html).toContain('ffprobe&#39;s reading of the file');
    expect(html).toContain('<dt>written</dt><dd><a class="name" href="../../out/ae/a-v1.mov">out/ae/a-v1.mov</a> instead of out/ae/a-v1.mp4: aerender&#39;s output module decides the container');
    expect(html).toContain('<img src="../../.timmy/flows/f0123abcd/frames/frame-000030.png"');
    expect(html).toContain('<figcaption>frame 30 · 1 s</figcaption>');
    expect(html).toContain('<td class="changed">0 s (480, 760), 2 s (1680, 760)</td>');
    expect(html).toContain(`compiles (${AE_COMPILE_CHECK}`);
    expect(html).toContain('receipts: agent id1 · After Effects id2 · aerender id3 · readback id4');
    // a record that says ae but is not one Timmy writes: drawn from what is there, nothing thrown
    expect(() => aeFlowCard({ file: 'results/flows/f0000000a.json', record: { kind: 'iterate', target: 'ae', script: { change: { hunks: [7, null] } }, readback: { checks: 'x', frames: [null] }, before_after: { after: { layers: [{ position: { keys: [1, [2]] } }] } } }, check: { status: 'unverified' } }, h, '')).not.toThrow();
  });
});

// ── refusals ────────────────────────────────────────────────────────────────────

describe.skipIf(!python)('/iterate ae refuses before anything is written (FAKE After Effects and aerender)', () => {
  it('a missing, encoded, non-script, hidden, linked or large script, no After Effects, no aerender, no model: nothing written, nothing started', async () => {
    fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(root, 'title.jsxbin'), '@JSXBIN@ES@2.0@');
    fs.symlinkSync('author.jsx', path.join(root, 'linked.jsx'));
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'node_modules', 'author.jsx'), 'var a = 1;\n');
    fs.writeFileSync(path.join(root, 'big.jsx'), `// ${'x'.repeat(300 * 1024)}\n`);
    const cases: Array<[Record<string, string | undefined>, string, RegExp]> = [
      [{}, 'ae missing.jsx "move it"', /No script at missing\.jsx: \/project new <name> --from ae-starter makes a project with one \(author\.jsx\)/],
      [{}, 'ae ../outside.jsx "move it"', /\.\.\/outside\.jsx is outside the project/],
      [{}, 'ae title.jsxbin "move it"', /title\.jsxbin is an encoded ExtendScript \(\.jsxbin\), which an agent cannot edit/],
      [{}, 'ae notes.txt "move it"', /notes\.txt is not an After Effects script \(\.jsx\)/],
      [{}, 'ae node_modules/author.jsx "move it"', /node_modules\/author\.jsx is inside node_modules\/, which the agent's before\/after comparison does not look into/],
      [{}, 'ae linked.jsx "move it"', /linked\.jsx is reached through a symbolic link/],
      [{}, 'ae big.jsx "move it"', /big\.jsx is \d+ bytes: \/iterate ae gives the agent the whole script, and takes scripts up to 256 KB/],
      [{ TIMMY_AFTERFX: path.join(fixtures, 'no-after-effects-here') }, 'ae author.jsx "move it"', /Not started: After Effects \(scripting\) was not found on this machine[\s\S]*so it comes first[\s\S]*Setup: /],
      [{ TIMMY_AERENDER: path.join(fixtures, 'no-aerender-here') }, 'ae author.jsx "move it"', /Not started: [^\n]*aerender[^\n]* was not found on this machine[\s\S]*Setup: /],
      [{ TIMMY_AGENT_MODEL: undefined }, 'ae author.jsx "move it"', /Name the local model: \/iterate ae <script\.jsx>/],
      [{ TIMMY_AGENT_BASE_URL: 'https://models.example.com/v1' }, 'ae author.jsx "move it"', /is not this machine[\s\S]*only a local, free route, and has no --paid/],
    ];
    for (const [env, line, want] of cases) {
      const { ws, sealed } = make({ env });
      const out = text(await ws.iterate(line));
      expect(out, line).toMatch(want);
      expect(ws.jobs.list()).toEqual([]);
      expect(sealed).toEqual([]);
      expect(fs.existsSync(path.join(root, '.timmy'))).toBe(false);
      expect(fs.readFileSync(path.join(root, 'author.jsx'))).toEqual(starterBytes());
      noAbsolute(out);
    }
  });

  it('/iterate shows the After Effects flow\'s usage, whether After Effects and aerender are found and whether a readback can run (said, not run)', async () => {
    const usage = text(await make().ws.iterate(''));
    expect(usage).toContain(`AE         ${AE_ITERATE_USAGE}`);
    expect(usage).toContain('After Effects found (set by its variable), aerender found (set by its variable) · they run when a flow does, not now');
    expect(usage).toContain('the readback can run (python3, ffprobe and ffmpeg found) · checked when a flow reaches it, not now');
    const none = text(await make({ env: { TIMMY_FFPROBE: undefined, TIMMY_FFMPEG: undefined } }).ws.iterate(''));
    expect(none).toContain('no readback: ffprobe is not on PATH and TIMMY_FFPROBE is not set; ffmpeg is not on PATH and TIMMY_FFMPEG is not set · a flow then ends after the render, succeeded without readback · brew install ffmpeg');
  });
});

// ── the flow ────────────────────────────────────────────────────────────────────

describe.skipIf(!python)('/iterate ae end to end (FAKE agent, FAKE After Effects and aerender, FAKE ffprobe and ffmpeg; the real readback worker)', () => {
  it('matches: the agent changes the script, it compiles, After Effects runs it, aerender renders it, the render read back matches After Effects\' report; before and after; record, receipts, list, board', async () => {
    const { ws, notes, sealed } = make();
    // An earlier /ae author run of the same script, judged ok: the "before".
    const first = text(await ws.ae('author author.jsx'));
    const firstJob = /\b(j[0-9a-f]{6})\b/.exec(first.slice(first.indexOf('Running')))![1];
    await ws.jobs.done(firstJob);
    await until(() => sealed.some((r) => r.kind === 'native'));
    const firstRun = String(sealed.find((r) => r.kind === 'native')!.native!.run);
    expect(sealed.find((r) => r.kind === 'native')).toMatchObject({ status: 'ok', native: { app: 'afterfx', outcome: 'ok' } });
    notes.length = 0;

    const out = text(await ws.iterate(`ae author.jsx "start the <Mover> at x 480 & keep the rest ${RIGHTER}"`));
    const id = flowIdIn(out);
    expect(id).toMatch(FLOW_ID);
    expect(out).toContain(`Flow       ${id}  iterate ae author.jsx: start the <Mover> at x 480 & keep the rest ${RIGHTER}`);
    expect(out).toMatch(new RegExp(`Script {5}author\\.jsx {2}\\d+ lines · sha256 [0-9a-f]{12} · kept as read: \\.timmy/flows/${id}/script\\.before\\.jsx`));
    expect(out).toContain('it may change only author.jsx; then After Effects (found, set by its variable) runs it as /ae author --name author does (its window opens), aerender (found, set by its variable) renders the first comp to out/ae/author-v<N>.mp4, and the render is read back outside After Effects and compared with After Effects\' report');
    expect(out).toContain(`Before     run ${firstRun.slice(0, 8)} (judged ok): its comps are set beside this run's, as After Effects reported each`);
    noAbsolute(out);
    await until(ended(sealed, id), 90000);
    const rec = recordOf(id);
    expect(rec).toMatchObject({ schema: 'timmy.flow/1', id, kind: 'iterate', target: 'ae', outcome: 'succeeded', ended_in: 'readback', doctrine: DOCTRINE_15 });
    expect(rec.why).toBe(`the render out/ae/author-v2.mp4 matches After Effects' own report: 1920x1080, 30 fps, 10 s, 300 frames, and 3 positions of Mover within 38.4 x 21.6 comp pixels; ${AE_READBACK_LABEL}`);
    // the script: before (kept, read-only) and after, its change, the compile check
    const now = fs.readFileSync(path.join(root, 'author.jsx'));
    expect(now.toString('utf8')).toContain('position.setValueAtTime(0, [480, H / 2 + 220]);');
    expect(rec.script).toMatchObject({ path: 'author.jsx', before: { sha256: sha(starterBytes()), bytes: starterBytes().length }, after: { sha256: sha(now), bytes: now.length }, change: { added: 1, removed: 1, hunks_total: 1 }, syntax: { checked: true, ok: true, by: "Node's vm.Script" } });
    expect(fs.readFileSync(path.join(root, rec.script.before.kept!))).toEqual(starterBytes());
    expect(fs.statSync(path.join(root, rec.script.before.kept!)).mode & 0o222).toBe(0);
    expect(rec.agent).toMatchObject({ agent: 'qwen', outcome: 'completed', route: 'local endpoint, no charge', cost_usd: 0 });
    // After Effects: /ae author's own judged job, a new version, After Effects' own report
    const a = rec.author!;
    const aep = fs.readFileSync(path.join(root, 'out', 'ae', 'author-v2.aep'));
    expect(a).toMatchObject({ state: 'completed', outcome: 'ok', name: 'author', version: 2, aep: { path: 'out/ae/author-v2.aep', sha256: sha(aep), bytes: aep.length }, result: { path: `.timmy/native/${a.run}/result.json` }, comps: [{ name: 'Main', width: 1920, height: 1080, fps: 30, duration: 10, layers: 3 }] });
    expect(a.copy).toMatchObject({ sha256: sha(now) });
    expect(fs.readFileSync(path.join(root, a.copy!.path))).toEqual(now);
    // aerender: the comp it rendered, the file it was asked for and wrote
    const r = rec.render!;
    const video = fs.readFileSync(path.join(root, 'out', 'ae', 'author-v2.mp4'));
    expect(r).toMatchObject({ state: 'completed', outcome: 'ok', comp: 'Main', requested: 'out/ae/author-v2.mp4', file: { path: 'out/ae/author-v2.mp4', sha256: sha(video), bytes: video.length, instead: false } });
    expect(nativeRuns().sort()).toEqual([firstRun, a.run, r.run].sort());
    // the readback: the worker, ffprobe's facts, the scale, the tolerance, each check, the frames it kept
    const k = rec.readback!;
    expect(k).toMatchObject({
      state: 'completed', verdict: 'matches', worker: { name: 'timmy-video-readback', version: '0.1.0' }, video: { path: 'out/ae/author-v2.mp4', sha256: sha(video) }, plan: { path: `.timmy/flows/${id}/readback-plan.json` },
      probe: { codec: 'h264', width: 1920, height: 1080, fps: [30, 1], duration: 10, frames: 300 }, scale: 4, scaled: [480, 270],
      tolerance: { x_px: 38.4, y_px: 21.6, rule: AE_TOLERANCE_RULE, colour: 48 }, label: AE_READBACK_LABEL, reported_by: AE_REPORTED_BY, not_compared: [],
    });
    expect(k.tools?.ffprobe?.version).toContain('0.0.0-fake');
    expect(k.checks!.map((c) => [c.name, c.reported, c.measured, c.passed])).toEqual([
      ['comp size', [1920, 1080], [1920, 1080], true], ['frame rate', 30, '30/1 (30)', true], ['duration (s)', 10, 10, true], ['frame count', 300, 300, true],
      ['Mover at 0 s', [480, 760], [480, 760], true], ['Mover at 1 s', [1080, 760], [1080, 760], true], ['Mover at 2 s', [1680, 760], [1680, 760], true],
    ]);
    expect(k.frames!.map((f) => [f.path, f.frame, f.time])).toEqual([0, 30, 60].map((n) => [`.timmy/flows/${id}/frames/frame-${String(n).padStart(6, '0')}.png`, n, n / 30]));
    for (const f of k.frames!) expect(sha(fs.readFileSync(path.join(root, f.path)))).toBe(f.sha256);
    expect(JSON.parse(fs.readFileSync(path.join(root, k.plan!.path), 'utf8'))).toEqual({ schema: 'timmy.video-readback-plan/1', comp: { width: 1920, height: 1080, start: 0 }, targets: [{ layer: 'Mover', colour: [0.2, 0.75, 0.4], times: [0, 1, 2] }] });
    // before and after, as After Effects reported each run
    expect(rec.before_after).toMatchObject({
      reported_by: AE_REPORTED_BY, before: { run: firstRun, comp: 'Main', size: [1920, 1080] }, after: { run: a.run, job: a.job, comp: 'Main' },
      changes: ['Mover: Position 0 s (240, 760), 2 s (1680, 760) → 0 s (480, 760), 2 s (1680, 760)'],
    });
    // the receipts: the first run's, then the agent's, After Effects' (native), aerender's (native), the readback's, the flow's
    expect(sealed.map((x) => x.kind)).toEqual(['native', 'agent', 'native', 'native', 'readback', 'flow']);
    expect(sealed[3]).toMatchObject({ kind: 'native', status: 'ok', native: { app: 'aerender', outcome: 'ok' } });
    expect(sealed[4]).toMatchObject({ kind: 'readback', status: 'ok', child_receipts: [rec.receipts.render], sources: [{ path: 'out/ae/author-v2.mp4', sha256: sha(video), role: 'read' }, { path: k.plan!.path }, { flow: id, verdict: 'matches', label: AE_READBACK_LABEL }] });
    expect(sealed[4].outputs).toEqual([
      { path: k.log, sha256: sha(fs.readFileSync(path.join(root, k.log!))), bytes: fs.statSync(path.join(root, k.log!)).size },
      ...k.frames!.map((f) => ({ path: f.path, sha256: f.sha256, bytes: fs.statSync(path.join(root, f.path)).size })),
    ]);
    expect(rec.child_receipts).toEqual([rec.receipts.agent, rec.receipts.author, rec.receipts.render, rec.receipts.readback]);
    const body = fs.readFileSync(path.join(root, 'results', 'flows', `${id}.json`));
    expect(sealed[5]).toMatchObject({ kind: 'flow', status: 'ok', subject: `flow · iterate · ae · ${id} · succeeded`, outputs: [{ path: `results/flows/${id}.json`, sha256: sha(body) }], child_receipts: rec.child_receipts, cost_usd: 0, sources: [{ path: 'author.jsx', sha256: sha(starterBytes()), sha256_after: sha(now) }] });
    // what the operator saw
    const notice = notes.join('\n');
    expect(notice).toContain(`${id}  agent qwen ${rec.agent!.run} completed: changed author.jsx (+1 −1 lines in 1 place) · compiles (${AE_COMPILE_CHECK}: Node's vm.Script in Node ${process.version}, nothing run; not After Effects' own parser)`);
    expect(notice).toContain(`${id}  After Effects: ${a.job} runs author.jsx as submitted (its copy: ${a.copy!.path}) in a new project, saved as out/ae/author-v2.aep · its window opens · judged by its result file · /jobs ${a.job}`);
    expect(notice).toContain(`${id}  aerender: ${r.job} renders Main from out/ae/author-v2.aep to out/ae/author-v2.mp4 · its output module decides the container · /jobs ${r.job}`);
    expect(notice).toContain(`${id}  readback: ${k.job} reads out/ae/author-v2.mp4 outside After Effects (ffprobe, ffmpeg and Timmy's pixel reading): Mover at 3 times · /jobs ${k.job}`);
    expect(notice).toContain(`${id} succeeded: the render out/ae/author-v2.mp4 matches After Effects' own report`);
    expect(notice).toContain('After Effects reported: Main 1920x1080, 30 fps, 10 s, 3 layers: Mover (solid [0.2, 0.75, 0.4]; Position 2 keys: 0 s (480, 760) → 2 s (1680, 760), linear)');
    expect(notice).toContain(`before → after: Mover: Position 0 s (240, 760), 2 s (1680, 760) → 0 s (480, 760), 2 s (1680, 760) · run ${firstRun.slice(0, 8)} → run ${a.run!.slice(0, 8)}, as After Effects reported each`);
    expect(notice).toContain(`the render, read back: 1920x1080, 30 fps, 10 s, 300 frames, h264 · matches · positions within 38.4 x 21.6 comp pixels (${AE_TOLERANCE_RULE})`);
    expect(notice).toContain(AE_READBACK_LABEL);
    noAbsolute(notice);
    noAbsolute(body.toString('utf8'));
    noAbsolute(JSON.stringify(sealed));
    // /iterate lists it
    expect(text(await ws.iterate(''))).toMatch(new RegExp(`${id}\\s+succeeded ae author\\.jsx \\+1 −1 lines in 1 place · readback matches · results/flows/${id}\\.json`));
    // the board: the card, verified; the script's diff; the .aep, the render and the frames as links; who measured what; all escaped
    ws.board('');
    const html = fs.readFileSync(path.join(root, '.timmy/board/index.html'), 'utf8');
    const card = cardOf(html);
    expect(card).toContain(`<strong>${id}</strong> <span class="state state-succeeded">succeeded</span>`);
    expect(card).toContain('<p class="instruction">start the &lt;Mover&gt; at x 480 &amp; keep the rest PYFILE:author.jsx PYREPLACE:[240,=&gt;[480,</p>');
    expect(card).not.toContain('<Mover>');
    expect(card).toContain('status-verified');
    expect(card).toContain('<span class="removed">-   position.setValueAtTime(0, [240, H / 2 + 220]);</span>');
    expect(card).toContain('<span class="added">+   position.setValueAtTime(0, [480, H / 2 + 220]);</span>');
    expect(card).toContain('<dt>change</dt><dd>+1 −1 lines in 1 place</dd>');
    expect(card).toContain('the comp, before → after: After Effects&#39; own report</h4>');
    expect(card).toContain('<li>Mover: Position 0 s (240, 760), 2 s (1680, 760) → 0 s (480, 760), 2 s (1680, 760)</li>');
    expect(card).toContain('the render, read back outside After Effects</h4>');
    expect(card).toContain('<dd class="verdict verdict-matches">matches</dd>');
    expect(card).toContain('<tr class=""><td>Mover at 1 s</td><td>(1080, 760)</td><td>(1080, 760)</td><td>(0, 0)</td><td>within 38.4 x, 21.6 y comp pixels');
    for (const f of ['out/ae/author-v2.mp4', 'out/ae/author-v2.aep', 'author.jsx', `results/flows/${id}.json`, `.timmy/flows/${id}/frames/frame-000030.png`, `.timmy/flows/${id}/readback-plan.json`]) expect(card).toContain(`href="../../${f}"`);
    expect(card).toContain(`<img src="../../.timmy/flows/${id}/frames/frame-000000.png"`);
    expect(card).toContain(`receipts: agent ${rec.receipts.agent} · After Effects ${rec.receipts.author} · aerender ${rec.receipts.render} · readback ${rec.receipts.readback} · flow `);
    noAbsolute(html);
  }, 150000);

  it('differs: a render that puts the Mover 200 pixels right of where After Effects says (FAKE_AERENDER_SHIFT): the numbers, the receipts, the card', async () => {
    const { ws, notes, sealed } = make({ env: { FAKE_AERENDER_SHIFT: '200' } });
    const id = flowIdIn(text(await ws.iterate(`ae author.jsx "start further right ${RIGHTER}"`)));
    await until(ended(sealed, id), 90000);
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'differs', ended_in: 'readback', author: { outcome: 'ok' }, render: { outcome: 'ok' }, readback: { verdict: 'differs', state: 'completed' } });
    expect(rec.why).toBe(`the render out/ae/author-v1.mp4 differs from After Effects' own report: Mover at 0 s: After Effects' keys put it at (480, 760), the render shows it at (680, 760) (off by (200, 0)); Mover at 1 s: After Effects' keys put it at (1080, 760), the render shows it at (1280, 760) (off by (200, 0)); Mover at 2 s: After Effects' keys put it at (1680, 760), the render shows it at (1860, 760) (off by (180, 0)); ${AE_READBACK_LABEL}`);
    expect(rec.readback!.checks!.filter((c) => c.passed === false).map((c) => c.name)).toEqual(['Mover at 0 s', 'Mover at 1 s', 'Mover at 2 s']);
    expect(sealed.find((x) => x.kind === 'readback')).toMatchObject({ status: 'failed', discrepancies: [expect.stringMatching(/^Mover at 0 s: reported \[480,760\], measured \[680,760\]/), expect.any(String), expect.any(String)] });
    expect(sealed.at(-1)).toMatchObject({ kind: 'flow', status: 'failed', subject: `flow · iterate · ae · ${id} · differs` });
    expect(notes.join('\n')).toContain(`${id} differs: the render out/ae/author-v1.mp4 differs from After Effects' own report`);
    ws.board('');
    const card = cardOf(fs.readFileSync(path.join(root, '.timmy/board/index.html'), 'utf8'));
    expect(card).toContain('<span class="state state-differs">differs</span>');
    expect(card).toContain('<dd class="verdict verdict-differs">differs</dd>');
    expect(card).toContain('<tr class="bad"><td>Mover at 1 s</td><td>(1080, 760)</td><td>(1280, 760)</td><td>(200, 0)</td><td>outside 38.4 x, 21.6 y comp pixels');
  }, 120000);

  it('without ffprobe and ffmpeg: "succeeded without readback", with the setup step; never matches', async () => {
    const { ws, sealed } = make({ env: { TIMMY_FFPROBE: undefined, TIMMY_FFMPEG: undefined } });
    const out = text(await ws.iterate(`ae author.jsx "start further right ${RIGHTER}"`));
    const why = 'ffprobe is not on PATH and TIMMY_FFPROBE is not set; ffmpeg is not on PATH and TIMMY_FFMPEG is not set';
    expect(out).toContain(`and the flow ends there: no readback (${why})`);
    const id = flowIdIn(out);
    await until(ended(sealed, id), 90000);
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'succeeded', ended_in: 'readback', author: { outcome: 'ok' }, render: { outcome: 'ok' }, readback: { state: 'not run', setup: `${why}: brew install ffmpeg (it brings ffprobe and ffmpeg), or set TIMMY_FFPROBE and TIMMY_FFMPEG` } });
    expect(rec.readback!.verdict).toBeUndefined();
    expect(rec.why).toBe(`succeeded without readback: After Effects' run and aerender's render (out/ae/author-v1.mp4) are judged ok, but no readback could run (${why}); the render is not compared with After Effects' report. Setup: brew install ffmpeg (it brings ffprobe and ffmpeg), or set TIMMY_FFPROBE and TIMMY_FFMPEG`);
    expect(sealed.map((x) => x.kind)).toEqual(['agent', 'native', 'native', 'flow']);
    expect(rec.child_receipts).toEqual([rec.receipts.agent, rec.receipts.author, rec.receipts.render]);
    expect(fs.existsSync(path.join(root, '.timmy', 'flows', id, 'frames'))).toBe(false);
    expect(text(await ws.iterate(''))).toMatch(new RegExp(`${id}\\s+succeeded ae author\\.jsx \\+1 −1 lines in 1 place · without readback · results/flows/${id}\\.json`));
    ws.board('');
    const card = cardOf(fs.readFileSync(path.join(root, '.timmy/board/index.html'), 'utf8'));
    expect(card).toContain('<dd class="verdict verdict-succeededwithoutreadback">succeeded without readback</dd>');
    expect(card).toContain('<dt>setup</dt><dd>ffprobe is not on PATH');
    expect(card).toContain('no readback: the render was not read back, so it is not compared with After Effects&#39; report');
    expect(card).not.toContain('verdict-matches');
    expect(card).not.toContain('<p class="meta label">');
  }, 120000);

  it('aerender\'s output module decides the container (FAKE_AERENDER_MODE=mov-for-mp4): the .mov it wrote instead is judged, said, read back and compared', async () => {
    const { ws, notes, sealed } = make({ env: { FAKE_AERENDER_MODE: 'mov-for-mp4' } });
    const id = flowIdIn(text(await ws.iterate(`ae author.jsx "start further right ${RIGHTER}" --om "QuickTime (test)"`)));
    await until(ended(sealed, id), 90000);
    const rec = recordOf(id);
    const mov = fs.readFileSync(path.join(root, 'out', 'ae', 'author-v1.mov'));
    expect(fs.existsSync(path.join(root, 'out', 'ae', 'author-v1.mp4'))).toBe(false);
    expect(rec).toMatchObject({ outcome: 'succeeded', options: { om: 'QuickTime (test)' }, render: { outcome: 'ok', requested: 'out/ae/author-v1.mp4', om_template: 'QuickTime (test)', file: { path: 'out/ae/author-v1.mov', sha256: sha(mov), instead: true } }, readback: { verdict: 'matches', video: { path: 'out/ae/author-v1.mov' } } });
    expect(rec.render!.why).toContain("aerender wrote out/ae/author-v1.mov instead of out/ae/author-v1.mp4 (not there): aerender's output module decides the container, and aerender gives the file that container's extension");
    expect(sealed.find((x) => x.kind === 'native' && (x.native as { app?: string }).app === 'aerender')).toMatchObject({ status: 'ok', native: { instead: { requested: 'out/ae/author-v1.mp4', written: 'out/ae/author-v1.mov' } } });
    expect(fs.readFileSync(path.join(root, '.timmy', 'flows', id, 'render.log'), 'utf8')).toContain('output module template "QuickTime (test)" (fake-aerender: recorded, not applied');
    expect(notes.join('\n')).toContain('with the output module template "QuickTime (test)" · its output module decides the container');
    ws.board('');
    const card = cardOf(fs.readFileSync(path.join(root, '.timmy/board/index.html'), 'utf8'));
    expect(card).toContain('instead of out/ae/author-v1.mp4: aerender&#39;s output module decides the container');
    expect(card).toContain('output module template &quot;QuickTime (test)&quot; (After Effects&#39; own name, not checked by Timmy)');
  }, 120000);

  it('the agent changes another file, the script no longer compiles, or nothing changes: stopped before After Effects runs, nothing reverted', async () => {
    const { ws, sealed } = make();
    const other = flowIdIn(text(await ws.iterate(`ae author.jsx "further right ${RIGHTER} OTHERFILE"`)));
    await until(ended(sealed, other));
    const o = recordOf(other);
    expect(o).toMatchObject({ outcome: 'stopped', ended_in: 'checks' });
    expect(o.why).toBe(`the agent changed files other than author.jsx: notes/other.txt (added); After Effects did not run, and nothing was reverted; the agent's output is kept: ${o.agent!.transcript}`);
    expect(o.agent!.others).toEqual([{ path: 'notes/other.txt', how: 'added', sha256_after: sha(fs.readFileSync(path.join(root, 'notes/other.txt'))) }]);
    expect(fs.readFileSync(path.join(root, 'author.jsx'), 'utf8')).toContain('[480, H / 2 + 220]');
    fs.copyFileSync(STARTER, path.join(root, 'author.jsx'));
    fs.rmSync(path.join(root, 'notes'), { recursive: true });
    const broken = flowIdIn(text(await ws.iterate('ae author.jsx "add a helper PYFILE:author.jsx PYBREAK"')));
    await until(ended(sealed, broken));
    const b = recordOf(broken);
    const lines = starterBytes().toString('utf8').split('\n').length;
    expect(b).toMatchObject({ outcome: 'stopped', ended_in: 'checks', script: { syntax: { checked: true, ok: false, by: "Node's vm.Script", error: expect.stringMatching(/^SyntaxError: /), line: lines + 1 } } });
    expect(b.why).toMatch(new RegExp(`^author\\.jsx as the agent left it does not compile: SyntaxError: [^;]+, line ${lines + 1} \\(${AE_COMPILE_CHECK.replace(/[()]/g, '\\$&')}: Node's vm\\.Script in Node v[0-9.]+, nothing run\\); it is left as the agent wrote it; After Effects did not run; the agent's output is kept: `));
    expect(fs.readFileSync(path.join(root, 'author.jsx'), 'utf8')).toContain('def broken(:');
    fs.copyFileSync(STARTER, path.join(root, 'author.jsx'));
    const none = flowIdIn(text(await ws.iterate('ae author.jsx "keep it as it is"')));
    await until(ended(sealed, none));
    expect(recordOf(none)).toMatchObject({ outcome: 'stopped', ended_in: 'checks', why: 'the agent changed nothing; After Effects did not run' });
    expect(nativeRuns()).toEqual([]);
    expect(sealed.map((x) => x.kind)).toEqual(['agent', 'flow', 'agent', 'flow', 'agent', 'flow']);
    // the card of the one that no longer compiles says so
    ws.board('');
    expect(fs.readFileSync(path.join(root, '.timmy/board/index.html'), 'utf8')).toMatch(/<dt>compile check<\/dt><dd class="bad">does not compile: SyntaxError: /);
  }, 120000);
});

// ── stopping and recovery ───────────────────────────────────────────────────────

describe.skipIf(!python)('/stop and recovery for an After Effects flow (FAKE pieces)', () => {
  it('during the agent step: the agent\'s job is cancelled and After Effects never runs; /stop all reaches a second flow', async () => {
    const { ws, sealed } = make();
    const out = text(await ws.iterate(`ae author.jsx "SLEEP ${RIGHTER}"`));
    const id = flowIdIn(out);
    const agent = agentJobIn(out);
    await until(() => (ws.jobs.get(agent)?.pid ?? 0) > 0);
    expect(text(await ws.iterate(''))).toContain(`${id}  running: the agent step · /stop ${id} · ae author.jsx:`);
    // one flow at a time in a project, of any kind: a second After Effects flow and a tray flow are refused while it runs
    expect(text(await ws.iterate('ae author.jsx "again"'))).toContain(`Flow ${id} is still running in this project (its agent step), and one flow at a time runs in a project`);
    expect(text(await ws.iterate('tray "wider"'))).toContain(`Flow ${id} is still running in this project (its agent step)`);
    const stopped = text(await ws.stop(id));
    expect(stopped).toContain(`${id} cancelled`);
    expect(stopped).toContain('stopped with /stop during the agent step; After Effects did not run');
    expect(recordOf(id)).toMatchObject({ outcome: 'cancelled', ended_in: 'agent', agent: { outcome: 'cancelled' } });
    const second = text(await ws.iterate('ae author.jsx "SLEEP"'));
    const two = flowIdIn(second);
    await until(() => (ws.jobs.get(agentJobIn(second))?.pid ?? 0) > 0);
    expect(text(await ws.stop('all'))).toContain(`Flows (/iterate): ${two} cancelled; none starts a next step, and each keeps its record in results/flows/.`);
    expect(recordOf(two)).toMatchObject({ outcome: 'cancelled', ended_in: 'agent' });
    expect(nativeRuns()).toEqual([]);
    expect(sealed.filter((r) => r.kind === 'flow').map((r) => r.status)).toEqual(['cancelled', 'cancelled']);
  }, 90000);

  it('the REPL\'s end (Workspace.close) stops a running flow: its agent job is cancelled, its record written and sealed once', async () => {
    const { ws, sealed } = make();
    const out = text(await ws.iterate(`ae author.jsx "SLEEP ${RIGHTER}"`));
    const id = flowIdIn(out);
    const agent = agentJobIn(out);
    await until(() => (ws.jobs.get(agent)?.pid ?? 0) > 0);
    spaces.splice(spaces.indexOf(ws), 1);
    await ws.close();
    expect(ws.jobs.get(agent)!.state).toBe('cancelled');
    expect(recordOf(id)).toMatchObject({ outcome: 'cancelled', ended_in: 'agent', why: expect.stringContaining('during the agent step; After Effects did not run') });
    expect(sealed.filter((r) => r.kind === 'flow')).toEqual([expect.objectContaining({ subject: `flow · iterate · ae · ${id} · cancelled`, status: 'cancelled' })]);
    expect(nativeRuns()).toEqual([]);
  }, 90000);

  it('during the After Effects run (a FAKE After Effects that only sleeps): its job is cancelled, nothing rendered or read back', async () => {
    const { ws, sealed } = make({ env: { TIMMY_AFTERFX: sleeper('AfterFX-sleeps') } });
    const id = flowIdIn(text(await ws.iterate(`ae author.jsx "further right ${RIGHTER}"`)));
    const label = `After Effects · author author.jsx · flow ${id}`;
    await until(() => ws.jobs.list().some((j) => j.label === label && j.state === 'running' && (j.pid ?? 0) > 0), 90000);
    expect(text(await ws.iterate(''))).toContain(`${id}  running: the author step · /stop ${id} · ae author.jsx:`);
    const job = ws.jobs.list().find((j) => j.label === label)!;
    expect(text(await ws.stop(id))).toContain(`${id} cancelled`);
    expect(ws.jobs.get(job.id)!.state).toBe('cancelled');
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'cancelled', ended_in: 'author', author: { job: job.id, state: 'cancelled' } });
    expect(rec.why).toContain(`stopped with /stop during the After Effects run (job ${job.id}; After Effects itself may still be running the script); whatever it wrote is kept, and nothing was rendered`);
    expect(rec.render).toBeUndefined();
    expect(rec.readback).toBeUndefined();
    expect(sealed.map((r) => r.kind)).toEqual(['agent', 'task', 'flow']);
  }, 120000);

  it('during the render (a FAKE aerender that only sleeps): its job is cancelled, nothing read back', async () => {
    const { ws, sealed } = make({ env: { TIMMY_AERENDER: sleeper('aerender-sleeps') } });
    const id = flowIdIn(text(await ws.iterate(`ae author.jsx "further right ${RIGHTER}"`)));
    const label = `After Effects render · out/ae/author-v1.aep › Main · flow ${id}`;
    await until(() => ws.jobs.list().some((j) => j.label === label && j.state === 'running' && (j.pid ?? 0) > 0), 90000);
    expect(text(await ws.iterate(''))).toContain(`${id}  running: the render step · /stop ${id} · ae author.jsx:`);
    const job = ws.jobs.list().find((j) => j.label === label)!;
    expect(text(await ws.stop(id))).toContain(`${id} cancelled`);
    expect(ws.jobs.get(job.id)!.state).toBe('cancelled');
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'cancelled', ended_in: 'render', author: { outcome: 'ok' }, render: { job: job.id, state: 'cancelled', comp: 'Main', requested: 'out/ae/author-v1.mp4' } });
    expect(rec.why).toContain(`stopped with /stop during the render (job ${job.id}); whatever it wrote is kept, and nothing was read back`);
    expect(rec.readback).toBeUndefined();
    expect(sealed.map((r) => r.kind)).toEqual(['agent', 'native', 'task', 'flow']);
  }, 120000);

  it('during the readback (a FAKE ffprobe that sleeps): its job is cancelled, no verdict, sealed as cancelled', async () => {
    const { ws, sealed } = make({ env: { FAKE_FFPROBE_MODE: 'sleep' } });
    const id = flowIdIn(text(await ws.iterate(`ae author.jsx "further right ${RIGHTER}"`)));
    const label = `readback out/ae/author-v1.mp4 · flow ${id}`;
    await until(() => ws.jobs.list().some((j) => j.label === label && j.state === 'running' && (j.pid ?? 0) > 0), 90000);
    expect(text(await ws.iterate(''))).toContain(`${id}  running: the readback step · /stop ${id} · ae author.jsx:`);
    const job = ws.jobs.list().find((j) => j.label === label)!;
    expect(text(await ws.stop(id))).toContain(`${id} cancelled`);
    expect(ws.jobs.get(job.id)!.state).toBe('cancelled');
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'cancelled', ended_in: 'readback', render: { outcome: 'ok' }, readback: { state: 'cancelled', job: job.id, reason: 'stopped with /stop before it finished: no verdict' } });
    expect(rec.readback!.verdict).toBeUndefined();
    expect(sealed.find((r) => r.kind === 'readback')).toMatchObject({ status: 'cancelled' });
    expect(sealed.at(-1)).toMatchObject({ kind: 'flow', status: 'cancelled' });
  }, 120000);

  it('after a restart: a flow whose session ended during its After Effects run gets its interrupted record and receipt once', async () => {
    const first = make({ env: { TIMMY_AFTERFX: sleeper('AfterFX-sleeps') } });
    const id = flowIdIn(text(await first.ws.iterate(`ae author.jsx "further right ${RIGHTER}"`)));
    const stateFile = path.join(root, '.timmy', 'flows', id, 'state.json');
    await until(() => { try { const s = JSON.parse(fs.readFileSync(stateFile, 'utf8')); return s.step === 'author' && s.author?.state === 'running'; } catch { return false; } }, 90000);
    const left = fs.readFileSync(stateFile);
    const state = JSON.parse(left.toString('utf8'));
    await first.ws.stop(id);
    await until(ended(first.sealed, id));
    // SYNTHETIC: as if that session had ended without its stop path: its record gone, its state as it was, ten minutes old.
    fs.rmSync(path.join(root, 'results', 'flows', `${id}.json`));
    fs.writeFileSync(stateFile, left);
    const old = new Date(Date.now() - FLOW_QUIET_MS - 60_000);
    fs.utimesSync(stateFile, old, old);
    const { ws, notes, sealed } = make();
    const report = (await ws.startRecovery)!;
    expect(report.items.filter((i) => i.kind === 'flow').map((i) => [i.id, i.did])).toEqual([[id, 'interrupted']]);
    const rec = JSON.parse(fs.readFileSync(path.join(root, 'results', 'flows', `${id}.json`), 'utf8'));
    const run8 = String(state.author.run).slice(0, 8);
    expect(rec).toMatchObject({ id, target: 'ae', outcome: 'interrupted', ended_in: 'author' });
    expect(rec.why).toBe(`the REPL running it ended during its After Effects run (its job ${state.author.job} has no record in this Timmy's jobs folder); After Effects run ${run8} is judged from its own record (a native run, below); nothing was read back; recorded after a restart, and nothing was run again`);
    expect(rec.recovered.next).toEqual([
      `After Effects run ${run8} keeps its own record in .timmy/native/${state.author.run}/; /recover judges it once its job has ended`,
      'author.jsx holds the agent\'s change: /ae author author.jsx runs it',
      `/iterate ae author.jsx "further right ${RIGHTER}" starts a new flow from author.jsx as it is now`,
    ]);
    expect(rec.child_receipts).toEqual([state.receipts.agent]);
    expect(sealed.filter((r) => r.kind === 'flow')).toEqual([expect.objectContaining({ subject: `flow · iterate · ae · ${id} · interrupted`, status: 'failed', child_receipts: rec.child_receipts })]);
    expect(notes.join('\n')).toContain(`1 flow was interrupted: ${id} (record written)`);
    expect(text(await ws.recover(''))).not.toContain(`flow ${id} was interrupted`);
    expect(text(await ws.iterate(''))).toMatch(new RegExp(`${id}\\s+interrupted ae author\\.jsx \\+1 −1 lines in 1 place`));
  }, 150000);
});
