/**
 * Round R4 (/iterate blender, helper H26): the Blender flow, driven end to end through the Workspace: a local code agent
 * changes a Blender scene script, Blender runs it as a judged native job, a second Blender process reads the saved .blend
 * back, and the flow is kept as a record with a receipt. Real files, real child processes, real job lifecycles.
 *
 * FAKE pieces, each labelled:
 * - the code agent is tests/fixtures/fake-code-agent.mjs (a TEST DOUBLE: no model, nothing sent), run through /agent's own
 *   start, as Qwen Code on a local endpoint (TIMMY_AGENT_QWEN_BIN); its PYREPLACE, PYCLAIM and PYBREAK words edit scene.py;
 * - Blender is tests/fixtures/fake-blender.mjs (a TEST DOUBLE, as in tests/native-blender.test.ts): the scene run hands
 *   the script to python3 with the stand-in bpy (tests/fixtures/blender-stub), and the second pass hands the real
 *   workers/readback/blend_readback.py to python3 with the stand-in bpy opening the stand-in .blend (JSON). No Blender
 *   runs here: a pass says the flow, the readback worker, the comparison and the record agree with each other and with
 *   the stand-in, not that Blender saves or reads its files this way.
 * - the Python syntax check runs this machine's real python3 (these tests are skipped without one).
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
import { flowsSection } from '../src/repl/board-flows.js';
import { glyphSet } from '../src/term/glyphs.js';
import { hashOf, type Receipt, type ReceiptInput } from '../src/utils/receipts.js';
import { DOCTRINE_15, FLOW_ID } from '../src/flows/iterate.js';
import {
  BLEND_READBACK_SCOPE, BLEND_READBACK_SCRIPT, blenderIterateTask, changeText, compareBlendReadback, judgeScriptChanges, parseBlendReadback, parseSyntaxOutput,
  reportedByResult, scriptChange, syntaxText, unseenFolder, type BlendRead, type BlenderFlowRecord,
} from '../src/flows/iterate-blender.js';

const REPO = path.resolve(__dirname, '..');
const FIXTURES = path.join(REPO, 'tests', 'fixtures');
const STUB = path.join(FIXTURES, 'blender-stub');
const FAKE_AGENT = path.join(FIXTURES, 'fake-code-agent.mjs');
const STARTER = path.join(REPO, 'templates', 'blender-starter', 'scene.py');
const which = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
const python = which.status === 0 ? which.stdout.trim() : '';
if (!python) {
  // eslint-disable-next-line no-console
  console.log('[iterate-blender.test] the flow tests are skipped: no python3 here (the stand-in bpy and the syntax check need one)');
}

let root: string;
let fixtures: string;
let fakeBlender: string;
const spaces: Workspace[] = [];
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

function make(o: { env?: Record<string, string | undefined>; python?: boolean; python3?: string } = {}) {
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const env: Record<string, string> = {
    TIMMY_AGENT_QWEN_BIN: FAKE_AGENT, TIMMY_AGENT_MODEL: 'qwen3:4b', TIMMY_BLENDER: fakeBlender,
    // FAKE: the fake Blender's scene run hands the script to python3 with the stand-in bpy
    FAKE_BLENDER_MODE: 'python', FAKE_BLENDER_PYTHON: python, PYTHONPATH: STUB, PYTHONDONTWRITEBYTECODE: '1',
  };
  for (const [k, v] of Object.entries(o.env ?? {})) { if (v === undefined) delete env[k]; else env[k] = v; }
  const deps: WorkspaceDeps = {
    glyphs: glyphSet(true),
    env,
    onPath: (cmd) => (cmd === 'python3' && o.python !== false ? o.python3 ?? python : null),
    notify: (l) => notes.push(l.map((s) => s.text).join('')),
    openWeb: (url) => url,
    link: (t) => t,
    seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
    jobsDir: path.join(fs.mkdtempSync(path.join(fixtures, 'jobs-')), 'jobs'),
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
const recordOf = (id: string): BlenderFlowRecord => JSON.parse(fs.readFileSync(path.join(root, 'results', 'flows', `${id}.json`), 'utf8')) as BlenderFlowRecord;
const ended = (sealed: ReceiptInput[], id: string) => (): boolean => sealed.some((r) => r.kind === 'flow' && String(r.subject).includes(id));
const nativeRuns = (): string[] => { try { return fs.readdirSync(path.join(root, '.timmy', 'native')); } catch { return []; } };
const noAbsolute = (s: string): void => { for (const p of new Set([root, fs.realpathSync(root), fixtures, os.tmpdir(), REPO])) expect(s).not.toContain(p); };
const starterBytes = (): Buffer => fs.readFileSync(STARTER);

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'iterate-blender-project-')));
  fixtures = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'iterate-blender-fixtures-')));
  fs.copyFileSync(STARTER, path.join(root, 'scene.py'));
  fakeBlender = path.join(fixtures, 'bin', 'blender');
  fs.mkdirSync(path.dirname(fakeBlender), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, 'fake-blender.mjs'), fakeBlender);
  fs.chmodSync(fakeBlender, 0o755);
});
afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(fixtures, { recursive: true, force: true });
}, 60000);

// ── the parts that decide ───────────────────────────────────────────────────────

const read = (o: Partial<BlendRead> = {}): BlendRead => ({
  scene: 'Scene', objects: ['Aim', 'Camera', 'Cube'].map((name) => ({ name, type: name === 'Camera' ? 'CAMERA' : name === 'Aim' ? 'EMPTY' : 'MESH', dimensions: [2, 2, 2], location: [0, 0, 1], materials: name === 'Cube' ? ['Green'] : [] })),
  objects_total: 3, materials: [{ name: 'Green', users: 1, fake_user: false }], materials_used: ['Green'], cameras: [{ name: 'Camera', data: 'Camera', lens: 50 }], active_camera: 'Camera',
  scenes: [], frame_range: [1, 250], render_resolution: [640, 400], resolution_percentage: 100, units: null, ...o,
});

describe('/iterate blender: the parts that decide (no processes)', () => {
  it('the task: the instruction first, then the one script, what Timmy does with it, and the script whole', () => {
    const t = blenderIterateTask({ instruction: 'make the sphere red', scriptRel: 'scenes/scene.py', scriptText: 'import bpy\n' });
    expect(t.split('\n')[0]).toBe('make the sphere red');
    expect(t).toContain('Edit only scenes/scene.py. Do not create, change or delete any other file, and run no commands.');
    expect(t).toContain('blender -b --factory-startup --python scenes/scene.py');
    expect(t).toContain('Keep what it reports true to the scene it builds: the objects, the materials its objects use and the active camera.');
    expect(t.trimEnd().endsWith('scenes/scene.py now holds:\nimport bpy')).toBe(true);
  });

  it('what the agent changed: the script only; the sentences name the script', () => {
    const c = (p: string) => ({ path: p, size: 1, sha256: 'b'.repeat(64), previous_sha256: 'a'.repeat(64) });
    expect(judgeScriptChanges({ added: [], changed: [c('scene.py')], deleted: [], truncated: false }, 'scene.py')).toMatchObject({ ok: true, params: 'changed' });
    expect(judgeScriptChanges({ added: [], changed: [], deleted: [], truncated: false }, 'scene.py')).toEqual({ ok: true, params: 'unchanged' });
    const other = judgeScriptChanges({ added: [c('notes/x.txt')], changed: [c('scene.py')], deleted: [], truncated: false }, 'scene.py');
    expect(other).toMatchObject({ ok: false, reason: 'others', why: 'the agent changed files other than scene.py: notes/x.txt (added)' });
    expect(judgeScriptChanges(undefined, 'scene.py')).toMatchObject({ ok: false, why: 'the agent run left no record of what it changed, so whether it changed only scene.py is not known' });
    expect(judgeScriptChanges({ added: [], changed: [c('scene.py')], deleted: [], truncated: true }, 'scene.py')).toMatchObject({ ok: false, reason: 'incomplete', why: expect.stringContaining('whether it changed only scene.py is not known') });
    expect(judgeScriptChanges({ added: [], changed: [], deleted: [c('scene.py')], truncated: false }, 'scene.py')).toMatchObject({ ok: false, why: 'the agent deleted scene.py' });
  });

  it('where a script cannot be seen by the agent\'s comparison: .git, node_modules, .timmy and dist, without case', () => {
    expect(unseenFolder('.timmy/flows/x.py')).toBe('.timmy');
    expect(unseenFolder('a/dist/b.py')).toBe('dist');
    expect(unseenFolder('Node_Modules/x.py')).toBe('Node_Modules');
    expect(unseenFolder('scenes/scene.py')).toBeUndefined();
    expect(unseenFolder('dist.py')).toBeUndefined();
  });

  it('the script\'s change: line by line, the places that changed, each line cut at 160 characters', () => {
    const c = scriptChange('a\nb\nc\n', 'a\nB\nc\nd\n');
    expect(c).toMatchObject({ added: 2, removed: 1, hunks_total: 2, method: 'line diff (longest common subsequence)' });
    expect(c.hunks).toEqual([
      { before_line: 2, after_line: 2, removed: ['b'], added: ['B'], removed_total: 1, added_total: 1 },
      { before_line: 4, after_line: 4, removed: [], added: ['d'], removed_total: 0, added_total: 1 },
    ]);
    expect(changeText(c)).toBe('+2 −1 lines in 2 places');
    expect(scriptChange('same\n', 'same\n')).toMatchObject({ added: 0, removed: 0, hunks: [], hunks_total: 0 });
    expect(scriptChange('x\n', `${'y'.repeat(200)}\n`).hunks[0].added[0]).toBe(`${'y'.repeat(160)}…`);
    // an insertion inside a block is one place, the rest kept
    const starter = starterBytes().toString('utf8');
    const edited = starter.replace('"Sphere"', '"Ball"');
    const s = scriptChange(starter, edited);
    expect(s).toMatchObject({ added: 1, removed: 1, hunks_total: 1 });
    expect(s.hunks[0].removed[0]).toContain('"Sphere"');
    expect(s.hunks[0].added[0]).toContain('"Ball"');
  });

  it('the syntax check\'s answer: parses, or the error with its line; no answer is no check', () => {
    expect(parseSyntaxOutput('{"python": "3.11.9", "ok": true}\n')).toEqual({ ok: true, python: '3.11.9' });
    expect(parseSyntaxOutput('{"python": "3.11.9", "ok": false, "error": "SyntaxError: invalid syntax", "line": 4, "offset": 12}')).toEqual({ ok: false, python: '3.11.9', error: 'SyntaxError: invalid syntax', line: 4, offset: 12 });
    expect(parseSyntaxOutput('xcrun: error: no developer tools\n')).toBeUndefined();
    expect(syntaxText({ checked: true, ok: true, python: '3.11.9', by: 'python3' })).toBe('parses as Python (an AST parse by python3 3.11.9; this machine\'s python3, not Blender\'s own)');
    expect(syntaxText({ checked: true, ok: false, python: '3.11.9', by: 'python3', error: 'SyntaxError: invalid syntax', line: 4, offset: 1 })).toBe('does not parse as Python: SyntaxError: invalid syntax, line 4 (an AST parse by python3 3.11.9)');
    expect(syntaxText({ checked: false, why: 'no python3 on PATH' })).toBe('not checked as Python: no python3 on PATH');
  });

  it('what the run reported: objects, materials, camera, resolution and frames, or why a field cannot be compared', () => {
    expect(reportedByResult({ ok: true, objects: ['Cube'], materials: [{ name: 'Green' }], camera: 'Camera', resolution: [640, 400], frame_range: [1, 24] })).toEqual({ objects: ['Cube'], materials: ['Green'], camera: 'Camera', resolution: [640, 400], frame_range: [1, 24] });
    expect(reportedByResult({ ok: true, camera: null })).toEqual({ camera: null });
    expect(reportedByResult({ ok: true, objects: 3, resolution: [640.5, 400], camera: 7 })).toEqual({ unreadable: ['objects is not a list of names', 'camera is not a name', 'resolution is not two whole numbers'] });
    expect(reportedByResult('x')).toEqual({ unreadable: ['the result file is not a JSON object'] });
  });

  it('the comparison: each reported thing against what was read; an idle material noted, not counted; nothing to compare fails', () => {
    const all = { objects: ['Aim', 'Camera', 'Cube'], materials: ['Green'], camera: 'Camera', resolution: [640, 400] };
    const ok = compareBlendReadback(all, read());
    expect(ok.verdict).toBe('matches');
    expect(ok.checks.map((c) => [c.name, c.passed])).toEqual([['objects', true], ['materials', true], ['camera', true], ['resolution', true]]);
    // Blender keeps a material no object uses (the factory cube's, R3 row 133): noted, not a difference
    const idle = compareBlendReadback(all, read({ materials: [{ name: 'Green', users: 1, fake_user: false }, { name: 'Material', users: 0, fake_user: false }] }));
    expect(idle.verdict).toBe('matches');
    expect(idle.checks[1].note).toBe('in the .blend but used by no object of its scene, and not reported (not counted): Material');
    const off = compareBlendReadback({ ...all, objects: ['Aim', 'Camera', 'Ball'], materials: ['Green', 'Gold'], camera: 'Cam2' }, read({ materials_used: ['Green', 'Red'], materials: [{ name: 'Green', users: 1, fake_user: false }, { name: 'Red', users: 1, fake_user: false }] }));
    expect(off.verdict).toBe('differs');
    expect(off.checks.find((c) => c.name === 'objects')!.differences).toEqual(['reported, not in the .blend\'s scene: Ball', 'in the .blend\'s scene, not reported: Cube']);
    expect(off.checks.find((c) => c.name === 'materials')!.differences).toEqual(['reported, not in the .blend: Gold', 'used by the scene\'s objects, not reported: Red']);
    expect(off.checks.find((c) => c.name === 'camera')!.differences).toEqual(['the .blend\'s active camera is Camera; the result reported Cam2']);
    // objects the worker could not list whole are not compared; the rest still decide
    const cut = compareBlendReadback(all, read({ objects_total: 5000 }));
    expect(cut.checks[0]).toMatchObject({ name: 'objects', passed: null, note: expect.stringContaining('listed 3 of the scene\'s 5000 objects') });
    expect(cut.verdict).toBe('matches');
    expect(compareBlendReadback({ resolution: [640, 400] }, read())).toMatchObject({ verdict: 'failed', reason: expect.stringContaining('reported none of objects, materials or camera') });
    expect(compareBlendReadback({ unreadable: ['objects is not a list of names'] }, read()).reason).toContain('(objects is not a list of names)');
  });

  it('the second pass\'s output: its one JSON line among Blender\'s own, every claimed value present, or a failure with the reason', () => {
    const good = {
      ok: true, worker: { name: 'timmy-blend-readback', version: '0.1.0' }, blender_version: '4.2.3 LTS', file: { name: 'out/scene.blend', opened: 'out/scene.blend' }, scene: 'Scene',
      objects: [{ name: 'Cube', type: 'MESH', dimensions: [2, 2, 2], location: [0, 0, 1], materials: ['Green'] }], objects_total: 1,
      materials: [{ name: 'Green', users: 1, fake_user: false }], materials_used: ['Green'], cameras: [], active_camera: null, scenes: [{ name: 'Scene', objects: 1 }],
      frame_range: [1, 250], render_resolution: [640, 400], resolution_percentage: 100, units: null,
    };
    const parsed = parseBlendReadback(`Blender 4.2.3 LTS\nRead blend: "scene.blend"\n${JSON.stringify(good)}\n\nBlender quit\n`);
    expect(parsed).toMatchObject({ ok: true, worker: good.worker, blender_version: '4.2.3 LTS', file: { opened: 'out/scene.blend' }, read: { objects_total: 1, active_camera: null, render_resolution: [640, 400] } });
    expect(parseBlendReadback('Blender quit\n')).toMatchObject({ ok: false, code: 'no-output' });
    expect(parseBlendReadback(JSON.stringify({ ok: false, worker: good.worker, error: { code: 'no-file', message: 'Blender has no .blend open' } }))).toEqual({ ok: false, worker: good.worker, code: 'no-file', error: 'Blender has no .blend open' });
    const { objects: _o, ...noObjects } = good;
    expect(parseBlendReadback(JSON.stringify(noObjects))).toMatchObject({ ok: false, code: 'malformed', error: 'the result line has no objects' });
    expect(parseBlendReadback(JSON.stringify({ ...good, active_camera: 3 }))).toMatchObject({ ok: false, error: 'the result line has no active camera (a name or null)' });
  });

  it('the command line: blender, the script, the instruction; the same options and refusals as the tray', () => {
    expect(parseIterateLine('blender scenes/scene.py "make the sphere red" --model qwen3:4b')).toEqual({ ok: true, request: { recipe: 'blender', script: 'scenes/scene.py', instruction: 'make the sphere red', agent: 'qwen', model: 'qwen3:4b' } });
    expect(parseIterateLine('blender')).toMatchObject({ ok: false, error: expect.stringContaining('Name the script: /iterate blender <script.py>') });
    expect(parseIterateLine('blender scene.py')).toMatchObject({ ok: false, error: expect.stringContaining('Say what to change: /iterate blender <script.py>') });
    expect(parseIterateLine('blender scene.py --paid redder')).toMatchObject({ ok: false, error: expect.stringContaining('it has no --paid') });
    expect(parseIterateLine('blender scene.py redder --agent codex')).toMatchObject({ ok: false, error: expect.stringContaining('Codex runs on your own account and costs money') });
    expect(parseIterateLine('vase "taller"')).toMatchObject({ ok: false, error: expect.stringContaining('or blender <script.py>') });
  });

  it('the board says what to do when there is no flow, for both kinds', () => {
    expect(flowsSection({ list: [], more: 0 }, { live: false, base: '../../' }).html).toContain('/iterate blender &lt;script.py&gt; &quot;&lt;instruction&gt;&quot; does the same for a Blender script');
  });
});

// ── the readback worker itself ──────────────────────────────────────────────────

describe.skipIf(!python)('workers/readback/blend_readback.py against the stand-in bpy (python3 in Blender\'s place)', () => {
  const runWorker = (env: Record<string, string>, args: string[], cwd = root) => {
    const r = spawnSync(python, [BLEND_READBACK_SCRIPT, '--', ...args], { encoding: 'utf8', cwd, env: { PATH: process.env.PATH ?? '', PYTHONDONTWRITEBYTECODE: '1', ...env }, timeout: 60000 });
    const line = r.stdout.trim().split('\n').at(-1) ?? '';
    return { status: r.status, stderr: r.stderr, json: JSON.parse(line) as Record<string, any> };
  };
  /** The starter run once with the stand-in bpy, as a person runs it by hand: out/scene.blend, out/render.png, out/timmy-result.json. */
  const runStarter = () => {
    const r = spawnSync(python, ['scene.py', '--'], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', PYTHONPATH: STUB, PYTHONDONTWRITEBYTECODE: '1', TIMMY_ROOT: root, TIMMY_BLENDER_LIB: path.join(REPO, 'workers', 'blender') }, timeout: 60000 });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(fs.readFileSync(path.join(root, 'out', 'timmy-result.json'), 'utf8')) as Record<string, unknown>;
  };

  it('reads the starter\'s saved scene back: each object\'s type, dimensions and location, materials, camera, frames and resolution', () => {
    const result = runStarter();
    expect(result).toMatchObject({ ok: true, camera: 'Camera' });
    const r = runWorker({ PYTHONPATH: STUB, BPY_STUB_OPEN: path.join(root, 'out', 'scene.blend') }, ['--as', 'out/scene.blend']);
    expect(r.status, r.stderr).toBe(0);
    const parsed = parseBlendReadback(JSON.stringify(r.json));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed).toMatchObject({ worker: { name: 'timmy-blend-readback', version: '0.1.0' }, blender_version: '4.2.0 (stand-in)', file: { name: 'out/scene.blend', opened: 'out/scene.blend' } });
    expect(parsed.read.objects.map((o) => [o.name, o.type])).toEqual([['Aim', 'EMPTY'], ['Camera', 'CAMERA'], ['Cube', 'MESH'], ['Cylinder', 'MESH'], ['Ground', 'MESH'], ['Sphere', 'MESH'], ['Sun', 'LIGHT']]);
    expect(parsed.read.objects.find((o) => o.name === 'Cylinder')).toEqual({ name: 'Cylinder', type: 'MESH', dimensions: [1.4, 1.4, 2.4], location: [2.4, -0.4, 1.2], materials: ['Timmy Green'] });
    expect(parsed.read).toMatchObject({ objects_total: 7, active_camera: 'Camera', cameras: [{ name: 'Camera', data: 'Camera', lens: 50 }], frame_range: [1, 250], render_resolution: [640, 400], materials_used: ['Off White', 'Timmy Green'] });
    expect(compareBlendReadback(reportedByResult(result), parsed.read).verdict).toBe('matches');
    expect(JSON.stringify(r.json)).not.toContain(root);
  });

  it('says what is wrong in one JSON line: a usage error (64), no bpy (2), no file open (2), a file Blender could not read (2)', () => {
    const usage = runWorker({ PYTHONPATH: STUB }, ['--bogus']);
    expect(usage).toMatchObject({ status: 64, json: { ok: false, worker: { name: 'timmy-blend-readback' }, error: { code: 'usage' } } });
    expect(runWorker({}, [])).toMatchObject({ status: 2, json: { ok: false, error: { code: 'no-bpy' } } });
    expect(runWorker({ PYTHONPATH: STUB }, ['--as', 'out/scene.blend'])).toMatchObject({ status: 2, json: { ok: false, error: { code: 'no-file' } } });
    fs.writeFileSync(path.join(root, 'not.blend'), 'not a stand-in blend');
    const bad = runWorker({ PYTHONPATH: STUB, BPY_STUB_OPEN: path.join(root, 'not.blend') }, ['--as', 'not.blend']);
    expect(bad).toMatchObject({ status: 2, json: { ok: false, error: { code: 'no-file' } } });
    expect(bad.stderr).toContain('stand-in bpy: not.blend is not a stand-in .blend');
  });
});

// ── the flow ──────────────────────────────────────────────────────────────────

describe.skipIf(!python)('/iterate blender refuses before anything is written (FAKE Blender)', () => {
  it('a missing, outside, hidden, linked or non-Python script, no Blender, no model, or a paid route: nothing written, nothing started', async () => {
    fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
    fs.symlinkSync('scene.py', path.join(root, 'linked.py'));
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'dist', 'scene.py'), 'import bpy\n');
    const cases: Array<[Record<string, string | undefined>, string, RegExp]> = [
      [{}, 'blender missing.py "redder"', /No script at missing\.py: \/project new <name> --from blender-starter/],
      [{}, 'blender ../outside.py "redder"', /\.\.\/outside\.py is outside the project/],
      [{}, 'blender notes.txt "redder"', /notes\.txt is not a Python file/],
      [{}, 'blender dist/scene.py "redder"', /dist\/scene\.py is inside dist\/, which the agent's before\/after comparison does not look into/],
      [{}, 'blender linked.py "redder"', /linked\.py is reached through a symbolic link/],
      [{ TIMMY_BLENDER: path.join(fixtures, 'no-blender-here') }, 'blender scene.py "redder"', /Blender \(Python, headless\) was not found on this machine \(TIMMY_BLENDER is set, but nothing runnable is there\)[\s\S]*Blender comes first[\s\S]*Setup: install Blender/],
      [{ TIMMY_AGENT_MODEL: undefined }, 'blender scene.py "redder"', /Name the local model: \/iterate blender <script\.py>/],
      [{}, 'blender scene.py "redder" --paid', /has no --paid/],
      [{ TIMMY_AGENT_BASE_URL: 'https://models.example.com/v1' }, 'blender scene.py "redder"', /is not this machine[\s\S]*only a local, free route/],
    ];
    for (const [env, line, want] of cases) {
      const { ws, sealed } = make({ env });
      const out = text(await ws.iterate(line));
      expect(out).toMatch(want);
      expect(ws.jobs.list()).toEqual([]);
      expect(sealed).toEqual([]);
      expect(fs.existsSync(path.join(root, '.timmy'))).toBe(false);
      expect(sha(fs.readFileSync(path.join(root, 'scene.py')))).toBe(sha(starterBytes()));
      noAbsolute(out);
    }
  });

  it('/iterate shows the Blender flow\'s usage and whether Blender is found (found, not run)', async () => {
    const { ws } = make();
    const out = text(await ws.iterate(''));
    expect(out).toContain('Blender    /iterate blender <script.py> "<instruction>" [--agent qwen] [--model <local model>]');
    expect(out).toContain('Blender found (set by TIMMY_BLENDER) · it runs when a flow does, not now');
    const none = make({ env: { TIMMY_BLENDER: path.join(fixtures, 'no-blender-here') } });
    expect(text(await none.ws.iterate(''))).toContain('Blender not found (TIMMY_BLENDER is set, but nothing runnable is there) · install Blender; or set TIMMY_BLENDER to its blender program');
  });
});

describe.skipIf(!python)('/iterate blender end to end (FAKE agent, FAKE Blender with the stand-in bpy)', () => {
  it('succeeds: the agent edits scene.py, it parses, Blender runs it as a judged job, the second pass matches; record, receipts, list, board', async () => {
    const { ws, notes, sealed } = make();
    const out = text(await ws.iterate('blender scene.py "rename the sphere to Ball PYREPLACE:Sphere=>Ball"'));
    const id = flowIdIn(out);
    expect(id).toMatch(FLOW_ID);
    expect(out).toContain(`Flow       ${id}  iterate blender scene.py: rename the sphere to Ball PYREPLACE:Sphere=>Ball`);
    expect(out).toMatch(/Script {5}scene\.py {2}\d+ lines · sha256 [0-9a-f]{12} · kept as read: \.timmy\/flows\/f[0-9a-f]{8}\/script\.before\.py/);
    expect(out).toContain('local endpoint, no charge');
    expect(out).toContain('then Blender (found, set by TIMMY_BLENDER) runs it as a judged job, and a second Blender process reads its .blend back');
    expect(out).toContain(`/stop ${id} stops the flow`);
    noAbsolute(out);
    await until(ended(sealed, id));
    const rec = recordOf(id);
    expect(rec).toMatchObject({ schema: 'timmy.flow/1', id, kind: 'iterate', target: 'blender', outcome: 'succeeded', ended_in: 'readback', doctrine: DOCTRINE_15 });
    // the script: before (kept, read-only) and after, the change, the syntax check by this machine's python3
    const now = fs.readFileSync(path.join(root, 'scene.py'));
    expect(now.toString('utf8')).toContain('"Ball"');
    expect(rec.script).toMatchObject({ path: 'scene.py', before: { sha256: sha(starterBytes()), bytes: starterBytes().length }, after: { sha256: sha(now), bytes: now.length } });
    expect(fs.readFileSync(path.join(root, rec.script.before.kept!))).toEqual(starterBytes());
    expect(fs.statSync(path.join(root, rec.script.before.kept!)).mode & 0o222).toBe(0);
    expect(rec.script.change).toMatchObject({ added: 1, removed: 1, hunks_total: 1 });
    expect(rec.script.syntax).toMatchObject({ checked: true, ok: true, by: 'python3' });
    // the agent: only scene.py changed, at no charge
    expect(rec.agent).toMatchObject({ agent: 'qwen', outcome: 'completed', route: 'local endpoint, no charge', cost_usd: 0 });
    expect(rec.agent!.files_changed).toEqual([{ path: 'scene.py', how: 'changed', sha256_before: sha(starterBytes()), sha256_after: sha(now) }]);
    // Blender: the judged native job, its copy, its result, the files it made, what it reported
    const b = rec.blender!;
    expect(b).toMatchObject({ state: 'completed', outcome: 'ok', blender_version: '4.2.0 (stand-in)', copy: { path: `.timmy/native/${b.run}/source/scene.py`, sha256: sha(now) }, result: { path: `.timmy/native/${b.run}/result.json` } });
    expect(b.files).toEqual(expect.arrayContaining([
      { path: 'out/scene.blend', sha256: sha(fs.readFileSync(path.join(root, 'out', 'scene.blend'))), change: 'created' },
      { path: 'out/render.png', sha256: sha(fs.readFileSync(path.join(root, 'out', 'render.png'))), change: 'created' },
    ]));
    expect(b.blend).toEqual({ path: 'out/scene.blend', sha256: sha(fs.readFileSync(path.join(root, 'out', 'scene.blend'))) });
    expect(b.renders).toEqual([{ path: 'out/render.png', sha256: sha(fs.readFileSync(path.join(root, 'out', 'render.png'))) }]);
    expect(b.reported).toEqual({ objects: ['Aim', 'Ball', 'Camera', 'Cube', 'Cylinder', 'Ground', 'Sun'], materials: ['Timmy Green', 'Off White'], camera: 'Camera', resolution: [640, 400] });
    expect(nativeRuns()).toEqual([b.run]);
    // the second pass: a separate process, the real readback worker on the stand-in bpy; Timmy's own sha256 before and after
    const k = rec.readback!;
    expect(k).toMatchObject({ state: 'completed', verdict: 'matches', worker: { name: 'timmy-blend-readback', version: '0.1.0' }, blender_version: '4.2.0 (stand-in)', scope: BLEND_READBACK_SCOPE, blend: { path: 'out/scene.blend', sha256_before: b.blend!.sha256, sha256_after: b.blend!.sha256 } });
    expect(k.read!.objects.map((o) => o.name)).toEqual(['Aim', 'Ball', 'Camera', 'Cube', 'Cylinder', 'Ground', 'Sun']);
    expect(k.read!.objects.find((o) => o.name === 'Ball')).toEqual({ name: 'Ball', type: 'MESH', dimensions: [2, 2, 2], location: [0, 0.6, 1], materials: ['Off White'] });
    expect(k.read).toMatchObject({ active_camera: 'Camera', frame_range: [1, 250], render_resolution: [640, 400], materials_used: ['Off White', 'Timmy Green'] });
    expect(k.checks!.map((c) => [c.name, c.passed])).toEqual([['objects', true], ['materials', true], ['camera', true], ['resolution', true]]);
    expect(fs.readFileSync(path.join(root, k.log!), 'utf8')).toContain('fake-blender: -b scene.blend --factory-startup --python-exit-code 1 --python blend_readback.py');
    expect(fs.readFileSync(path.join(root, b.log!), 'utf8')).toContain('fake-blender: -b --factory-startup --python-exit-code 1 --python scene.py');
    // the receipts: the agent's, the Blender run's (native, judged ok), the second pass's (readback), then the flow's
    const kinds = sealed.map((r) => r.kind);
    expect(kinds).toEqual(['agent', 'native', 'readback', 'flow']);
    expect(sealed[1]).toMatchObject({ status: 'ok', native: { app: 'blender', outcome: 'ok', run: b.run } });
    expect(sealed[2]).toMatchObject({ kind: 'readback', status: 'ok', sources: [{ path: 'out/scene.blend', sha256: b.blend!.sha256, role: 'read' }, { flow: id, verdict: 'matches', units: 'Blender units' }], child_receipts: [rec.receipts.blender] });
    expect(sealed[2].files).toBeUndefined();
    expect(rec.child_receipts).toEqual([rec.receipts.agent, rec.receipts.blender, rec.receipts.readback]);
    const body = fs.readFileSync(path.join(root, 'results', 'flows', `${id}.json`));
    expect(sealed[3]).toMatchObject({ kind: 'flow', status: 'ok', subject: `flow · iterate · blender · ${id} · succeeded`, outputs: [{ path: `results/flows/${id}.json`, sha256: sha(body), bytes: body.length }], child_receipts: rec.child_receipts, cost_usd: 0, sources: [{ path: 'scene.py', sha256: sha(starterBytes()), sha256_after: sha(now) }] });
    // what the operator saw, with no absolute path
    const notice = notes.join('\n');
    expect(notice).toContain(`${id}  agent qwen ${rec.agent!.run} completed: changed scene.py (+1 −1 lines in 1 place) · parses as Python (an AST parse by python3`);
    expect(notice).toMatch(new RegExp(`${id} {2}Blender: j[0-9a-f]{6} runs scene\\.py as submitted \\(its copy: \\.timmy/native/${b.run}/source/scene\\.py\\) · judged by its result file`));
    expect(notice).toMatch(new RegExp(`${id} {2}second pass: j[0-9a-f]{6} opens out/scene\\.blend in a separate Blender process and reads it back`));
    expect(notice).toContain(`${id} succeeded: the second pass over out/scene.blend matches what Blender's run reported (objects, materials, camera, resolution)`);
    expect(notice).toContain('read back from out/scene.blend: 7 objects (Aim, Ball, Camera, Cube, Cylinder, Ground, Sun), 2 materials in use, camera Camera, frames 1–250, 640 x 400');
    expect(notice).toContain(BLEND_READBACK_SCOPE);
    noAbsolute(notice);
    noAbsolute(body.toString('utf8'));
    noAbsolute(JSON.stringify(sealed));
    // /iterate lists it
    expect(text(await ws.iterate(''))).toMatch(new RegExp(`${id}\\s+succeeded blender scene\\.py \\+1 −1 lines in 1 place · readback matches · results/flows/${id}\\.json`));
    // the board: the flow as a card, verified by its flow receipt; the render as a picture; the files as links
    ws.board('');
    const html = fs.readFileSync(path.join(root, '.timmy/board/index.html'), 'utf8');
    expect(html).toContain('<h2 id="flows">Flows <span class="count">1</span></h2>');
    const card = html.match(/<article class="card flow blender">([\s\S]*?)<\/article>/)![1];
    expect(card).toContain(`<strong>${id}</strong> <span class="state state-succeeded">succeeded</span>`);
    expect(card).toContain('iterate blender · scene.py · started');
    expect(card).toContain('status-verified');
    expect(card).toContain('<a class="thumb" href="../../out/render.png"><img src="../../out/render.png"');
    expect(card).toContain('<span class="removed">-     add(bpy, bpy.ops.mesh.primitive_uv_sphere_add, white, &quot;Sphere&quot;');
    expect(card).toContain('<span class="added">+     add(bpy, bpy.ops.mesh.primitive_uv_sphere_add, white, &quot;Ball&quot;');
    expect(card).toContain('<dt>change</dt><dd>+1 −1 lines in 1 place</dd>');
    expect(card).toContain('parses as Python');
    expect(card).toContain('read back from the .blend by a second Blender process');
    expect(card).toContain(BLEND_READBACK_SCOPE);
    expect(card).toContain('<dd class="verdict verdict-matches">matches · compared: objects, materials, camera, resolution</dd>');
    expect(card).toContain('<dt>objects</dt><dd>Aim, Ball, Camera, Cube, Cylinder, Ground, Sun <span class="tier">as the result reported</span></dd>');
    expect(card).toContain('<dt>materials</dt><dd>in use: Off White, Timmy Green <span class="tier">as the result reported</span></dd>');
    expect(card).toContain('<dt>camera</dt><dd>Camera <span class="tier">as the result reported</span></dd>');
    expect(card).toContain('<dt>resolution</dt><dd>640 x 400 <span class="tier">as the result reported</span></dd>');
    expect(card).toContain('<dt>cameras</dt><dd>Camera (lens 50 mm, active)</dd>');
    expect(card).toContain('<tr><td>Ball</td><td>MESH</td><td>2 x 2 x 2</td><td>(0, 0.6, 1)</td></tr>');
    expect(card).toContain(DOCTRINE_15);
    for (const f of ['out/render.png', 'out/scene.blend', 'scene.py', `results/flows/${id}.json`]) expect(card).toContain(`href="../../${f}"`);
    expect(card).toContain(`receipts: agent ${rec.receipts.agent} · Blender ${rec.receipts.blender} · second pass ${rec.receipts.readback} · flow `);
    expect(html.match(/<article class="card flow/g)).toHaveLength(1);
    noAbsolute(html);
    // an edited record is no longer verified: its values are shown as the file says
    const edited = body.toString('utf8').replace('"name": "Sun"', '"name": "Edited"');
    expect(edited).not.toBe(body.toString('utf8'));
    fs.writeFileSync(path.join(root, 'results', 'flows', `${id}.json`), edited);
    ws.board('');
    const after = fs.readFileSync(path.join(root, '.timmy/board/index.html'), 'utf8').match(/<article class="card flow blender">([\s\S]*?)<\/article>/)![1];
    expect(after).toContain('status-unverified');
    expect(after).toContain('the file changed after it was sealed');
    expect(after).toContain('read back from the .blend, as the record says (not verified)');
    expect(after).toContain('<tr><td>Edited</td><td>LIGHT</td>');
    expect(after).not.toContain('<section class="measured readback blend">');
  }, 120000);

  it('the agent changes another file: stopped before Blender runs, the files listed, nothing reverted', async () => {
    const { ws, sealed } = make();
    const id = flowIdIn(text(await ws.iterate('blender scene.py "PYREPLACE:Sphere=>Ball OTHERFILE"')));
    await until(ended(sealed, id));
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'stopped', ended_in: 'checks' });
    expect(rec.why).toBe(`the agent changed files other than scene.py: notes/other.txt (added); Blender did not run, and nothing was reverted; the agent's output is kept: ${rec.agent!.transcript}`);
    expect(rec.agent!.others).toEqual([{ path: 'notes/other.txt', how: 'added', sha256_after: sha(fs.readFileSync(path.join(root, 'notes/other.txt'))) }]);
    expect(fs.readFileSync(path.join(root, 'scene.py'), 'utf8')).toContain('"Ball"');
    expect(nativeRuns()).toEqual([]);
    expect(rec.blender).toBeUndefined();
    expect(sealed.map((r) => r.kind)).toEqual(['agent', 'flow']);
    expect(sealed.at(-1)).toMatchObject({ status: 'failed', child_receipts: [rec.receipts.agent] });
  }, 90000);

  it('a script that no longer parses as Python stops the flow with the error and its line; the file stays as the agent wrote it', async () => {
    const { ws, sealed } = make();
    const id = flowIdIn(text(await ws.iterate('blender scene.py "add a helper PYBREAK"')));
    await until(ended(sealed, id));
    const rec = recordOf(id);
    const lines = starterBytes().toString('utf8').split('\n').length;
    expect(rec).toMatchObject({ outcome: 'stopped', ended_in: 'checks', script: { syntax: { checked: true, ok: false, by: 'python3', error: expect.stringMatching(/^SyntaxError: /), line: lines + 1 } } });
    expect(rec.why).toMatch(/^scene\.py as the agent left it does not parse as Python: SyntaxError: [^;]+, line \d+ \(an AST parse by python3 [0-9.]+\); it is left as the agent wrote it; Blender did not run; the agent's output is kept: /);
    expect(fs.readFileSync(path.join(root, 'scene.py'), 'utf8')).toContain('def broken(:');
    expect(nativeRuns()).toEqual([]);
    expect(sealed.map((r) => r.kind)).toEqual(['agent', 'flow']);
  }, 90000);

  it('without python3 the syntax check is not made, and said so; Blender\'s own run then fails on the broken script, its failure kept', async () => {
    const { ws, notes, sealed } = make({ python: false });
    const id = flowIdIn(text(await ws.iterate('blender scene.py "add a helper PYBREAK"')));
    await until(ended(sealed, id));
    const rec = recordOf(id);
    expect(rec.script.syntax).toEqual({ checked: false, why: 'no python3 on PATH' });
    expect(notes.join('\n')).toContain('not checked as Python: no python3 on PATH');
    expect(rec).toMatchObject({ outcome: 'failed', ended_in: 'blender', blender: { outcome: 'failed', state: 'failed' } });
    expect(rec.why).toMatch(/^Blender's run is judged failed, not ok: no result file, and blender exited 1; nothing was read back; kept: /);
    expect(rec.blender!.failure_files).toContain(rec.blender!.log);
    expect(fs.readFileSync(path.join(root, rec.blender!.log!), 'utf8')).toContain('SyntaxError');
    expect(rec.readback).toBeUndefined();
    expect(sealed.map((r) => r.kind)).toEqual(['agent', 'native', 'flow']);
    expect(sealed[1]).toMatchObject({ status: 'failed', native: { app: 'blender', outcome: 'failed' } });
  }, 90000);

  it('no change: "the agent changed nothing; Blender did not run"', async () => {
    const { ws, sealed } = make();
    const id = flowIdIn(text(await ws.iterate('blender scene.py "keep it as it is"')));
    await until(ended(sealed, id));
    expect(recordOf(id)).toMatchObject({ outcome: 'stopped', ended_in: 'checks', why: 'the agent changed nothing; Blender did not run' });
    expect(nativeRuns()).toEqual([]);
  }, 90000);

  it('the Blender run fails: the flow failed in its Blender step, the raw failure kept and named; no second pass', async () => {
    const { ws, sealed } = make({ env: { BPY_STUB_RENDER_FAIL: '1' } });
    const id = flowIdIn(text(await ws.iterate('blender scene.py "PYREPLACE:Sphere=>Ball"')));
    await until(ended(sealed, id));
    const rec = recordOf(id);
    const b = rec.blender!;
    expect(rec).toMatchObject({ outcome: 'failed', ended_in: 'blender', blender: { state: 'completed', outcome: 'failed' } });
    expect(b.why).toMatch(/^the script reported ok: false: RuntimeError: render\.render returned \['CANCELLED'\]/);
    expect(rec.why).toContain('Blender\'s run is judged failed, not ok: the script reported ok: false: RuntimeError: render.render returned');
    expect(b.failure_files).toEqual([`.timmy/native/${b.run}/result.json`, `.timmy/native/${b.run}/verdicts.jsonl`, `.timmy/flows/${id}/blender.log`, 'out/scene.blend']);
    for (const f of b.failure_files!) expect(fs.existsSync(path.join(root, f))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, b.result!.path), 'utf8'))).toMatchObject({ ok: false, error: expect.stringContaining('render.render returned') });
    expect(rec.readback).toBeUndefined();
    expect(sealed.map((r) => r.kind)).toEqual(['agent', 'native', 'flow']);
    expect(sealed.at(-1)).toMatchObject({ kind: 'flow', status: 'failed' });
  }, 90000);

  it('the second pass differs from what the run reported: verdict differs with the differences, not a success', async () => {
    const { ws, notes, sealed } = make();
    const id = flowIdIn(text(await ws.iterate('blender scene.py "claim a gold material PYCLAIM:Gold"')));
    await until(ended(sealed, id));
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'differs', ended_in: 'readback', blender: { outcome: 'ok' }, readback: { verdict: 'differs' } });
    expect(rec.blender!.reported!.materials).toEqual(['Timmy Green', 'Off White', 'Gold']);
    expect(rec.readback!.checks!.find((c) => c.name === 'materials')).toMatchObject({ passed: false, differences: ['reported, not in the .blend: Gold'] });
    expect(rec.why).toBe('the second pass over out/scene.blend differs from what Blender\'s run reported: materials: reported, not in the .blend: Gold');
    expect(sealed.find((r) => r.kind === 'readback')).toMatchObject({ status: 'failed', discrepancies: ['materials: reported, not in the .blend: Gold'] });
    expect(sealed.at(-1)).toMatchObject({ kind: 'flow', status: 'failed' });
    expect(notes.join('\n')).toContain(`${id} differs`);
    ws.board('');
    const card = fs.readFileSync(path.join(root, '.timmy/board/index.html'), 'utf8').match(/<article class="card flow blender">([\s\S]*?)<\/article>/)![1];
    expect(card).toContain('<dd class="verdict verdict-differs">differs');
    expect(card).toContain('<dd class="bad">reported, not in the .blend: Gold <span class="tier">reported: Timmy Green, Off White, Gold</span></dd>');
  }, 120000);

  it('a second pass that cannot read the file: verdict failed with the worker\'s reason, its output kept', async () => {
    // FAKE: the fake Blender's ok mode writes a .blend the stand-in cannot open (not its JSON)
    const { ws, sealed } = make({ env: { FAKE_BLENDER_MODE: 'ok' } });
    const id = flowIdIn(text(await ws.iterate('blender scene.py "PYREPLACE:Sphere=>Ball"')));
    await until(ended(sealed, id));
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'failed', ended_in: 'readback', blender: { outcome: 'ok' }, readback: { verdict: 'failed', reason: expect.stringMatching(/^no-file: Blender has no \.blend open/) } });
    expect(fs.readFileSync(path.join(root, rec.readback!.log!), 'utf8')).toContain('stand-in bpy: scene.blend is not a stand-in .blend');
    expect(sealed.find((r) => r.kind === 'readback')).toMatchObject({ status: 'failed' });
  }, 120000);
});

describe.skipIf(!python)('/stop stops a Blender flow (FAKE pieces)', () => {
  it('during the agent step: the agent\'s job is cancelled, Blender never runs; one flow at a time, of either kind', async () => {
    const { ws, sealed } = make();
    // two starts at once: the first holds the project while its agent starts, so the second is refused
    const [out, raced] = (await Promise.all([ws.iterate('blender scene.py "SLEEP PYREPLACE:Sphere=>Ball"'), ws.iterate('blender scene.py "redder"')])).map(text);
    const id = flowIdIn(out);
    expect(raced).toContain(`Flow ${id} is still running in this project (its prepare step)`);
    const agent = agentJobIn(out);
    await until(() => (ws.jobs.get(agent)?.pid ?? 0) > 0);
    expect(text(await ws.iterate('blender scene.py "redder"'))).toContain(`Flow ${id} is still running in this project (its agent step)`);
    expect(text(await ws.iterate('tray "PARAM:width=180"'))).toContain(`Flow ${id} is still running in this project (its agent step)`);
    expect(ws.jobs.list()).toHaveLength(1);
    expect(text(await ws.iterate(''))).toContain(`${id}  running: the agent step · /stop ${id} · blender scene.py:`);
    const stopped = text(await ws.stop(id));
    expect(stopped).toContain(`${id} cancelled`);
    expect(stopped).toContain('stopped with /stop during the agent step; Blender did not run');
    expect(ws.jobs.get(agent)!.state).toBe('cancelled');
    expect(recordOf(id)).toMatchObject({ outcome: 'cancelled', ended_in: 'agent', agent: { outcome: 'cancelled' } });
    expect(nativeRuns()).toEqual([]);
    expect(sealed.at(-1)).toMatchObject({ kind: 'flow', status: 'cancelled' });
    expect(text(await ws.stop(id))).toContain(`${id} already ended (cancelled)`);
  }, 90000);

  it('during the checks: the syntax check\'s python3 is stopped, Blender never runs', async () => {
    // FAKE: a python3 that answers nothing for 30 s, so the flow is still in its checks when /stop comes
    const slow = path.join(fixtures, 'slow-python3');
    fs.writeFileSync(slow, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    const { ws, sealed } = make({ python3: slow });
    const id = flowIdIn(text(await ws.iterate('blender scene.py "PYREPLACE:Sphere=>Ball"')));
    const end = Date.now() + 60000;
    while (!text(await ws.iterate('')).includes(`${id}  running: the checks step`)) {
      if (Date.now() > end) throw Error('timed out');
      await new Promise((r) => setTimeout(r, 50));
    }
    const started = Date.now();
    const stopped = text(await ws.stop(id));
    expect(Date.now() - started).toBeLessThan(15000);
    expect(stopped).toContain(`${id} cancelled`);
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'cancelled', ended_in: 'checks', why: 'stopped with /stop during the checks; Blender did not run', script: { syntax: { checked: false, why: 'stopped with /stop' } } });
    expect(nativeRuns()).toEqual([]);
    expect(sealed.map((r) => r.kind)).toEqual(['agent', 'flow']);
    expect(sealed.at(-1)).toMatchObject({ status: 'cancelled' });
  }, 90000);

  it('during the Blender run: its job is cancelled, what it wrote kept, no second pass', async () => {
    const { ws, sealed } = make({ env: { FAKE_BLENDER_MODE: 'sleep' } });
    const id = flowIdIn(text(await ws.iterate('blender scene.py "PYREPLACE:Sphere=>Ball"')));
    await until(() => ws.jobs.list().some((j) => j.label === `Blender · scene.py · flow ${id}` && j.state === 'running' && (j.pid ?? 0) > 0), 90000);
    const job = ws.jobs.list().find((j) => j.label === `Blender · scene.py · flow ${id}`)!;
    const stopped = text(await ws.stop(id));
    expect(stopped).toContain(`${id} cancelled`);
    expect(ws.jobs.get(job.id)!.state).toBe('cancelled');
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'cancelled', ended_in: 'blender', blender: { job: job.id, state: 'cancelled' } });
    expect(rec.why).toContain(`stopped with /stop during the Blender run (job ${job.id}); whatever it wrote is kept, and nothing was read back`);
    expect(rec.readback).toBeUndefined();
    expect(sealed.map((r) => r.kind)).toEqual(['agent', 'task', 'flow']);
    expect(sealed[1]).toMatchObject({ status: 'cancelled' });
    expect(sealed.at(-1)).toMatchObject({ kind: 'flow', status: 'cancelled' });
  }, 90000);

  it('during the second pass: its job is cancelled, no verdict; /stop all reaches a Blender flow too', async () => {
    const { ws, sealed } = make({ env: { FAKE_BLENDER_READBACK: 'sleep' } });
    const id = flowIdIn(text(await ws.iterate('blender scene.py "PYREPLACE:Sphere=>Ball"')));
    await until(() => ws.jobs.list().some((j) => j.label.startsWith('readback out/scene.blend in Blender') && j.state === 'running' && (j.pid ?? 0) > 0), 90000);
    const job = ws.jobs.list().find((j) => j.label.startsWith('readback out/scene.blend in Blender'))!;
    expect(job.label).toBe(`readback out/scene.blend in Blender · flow ${id}`);
    const stopped = text(await ws.stop(id));
    expect(stopped).toContain(`${id} cancelled`);
    expect(ws.jobs.get(job.id)!.state).toBe('cancelled');
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'cancelled', ended_in: 'readback', blender: { outcome: 'ok' }, readback: { state: 'cancelled', job: job.id } });
    expect(rec.readback!.verdict).toBeUndefined();
    expect(sealed.find((r) => r.kind === 'readback')).toMatchObject({ status: 'cancelled' });
    // /stop all: a second flow, stopped in its agent step
    const out = text(await ws.iterate('blender scene.py "SLEEP"'));
    const second = flowIdIn(out);
    await until(() => (ws.jobs.get(agentJobIn(out))?.pid ?? 0) > 0);
    const all = text(await ws.stop('all'));
    expect(all).toContain(`Flows (/iterate): ${second} cancelled; none starts a next step, and each keeps its record in results/flows/.`);
    expect(recordOf(second)).toMatchObject({ outcome: 'cancelled', ended_in: 'agent' });
  }, 150000);
});
