/**
 * Round R4 (/iterate scad, helper H33): the OpenSCAD flow, driven end to end through the Workspace: a local code agent
 * changes only the values in a model's parameter file, /scad --png runs as the judged native job, the flow's verdict
 * comes from that run's own judgement and readback, and the flow is kept as a record with a receipt. Real files, real
 * child processes, real job lifecycles. Also here: --agent codex for /iterate blender and /iterate scad.
 *
 * FAKE pieces, each labelled:
 * - the code agent is tests/fixtures/fake-code-agent.mjs (a TEST DOUBLE: no model, nothing sent), run through /agent's own
 *   start as Qwen Code on a local endpoint (TIMMY_AGENT_QWEN_BIN); its PYFILE and PYREPLACE words edit the parameter file;
 * - OpenSCAD is tests/fixtures/fake-openscad.mjs (a TEST DOUBLE, as in tests/native-openscad.test.ts): it has no geometry
 *   engine; it writes a box sized by -D width, depth and height, and a summary from the same triangles. Its mode comes
 *   from a `// fake-openscad: <mode>` line in the model (no-summary, open, hang). One test wraps it (a FAKE wrapper,
 *   written below) to move its summary's bounding box, so the summary disagrees with the STL;
 * - for --agent codex: tests/fixtures/fake-codex.mjs (a TEST DOUBLE of codex-cli) and a FAKE Ollama on 127.0.0.1 that
 *   only lists models; Blender is tests/fixtures/fake-blender.mjs (never reached: the flow stops before it runs).
 * No OpenSCAD, Codex, Ollama or model runs here: a pass says the flow, the judgement, the comparison and the record agree
 * with each other and with the stand-ins, not that OpenSCAD exports these files this way.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { folderProject } from '../src/project/index.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { parseIterateLine } from '../src/repl/iterate.js';
import { flowsSection } from '../src/repl/board-flows.js';
import { approvalNeeded } from '../src/repl/approvals.js';
import { createIterateTools } from '../src/agent/iterate-tools.js';
import { glyphSet } from '../src/term/glyphs.js';
import { hashOf, type Receipt, type ReceiptInput } from '../src/utils/receipts.js';
import { DOCTRINE_15, FLOW_ID } from '../src/flows/iterate.js';
import { FLOW_QUIET_MS } from '../src/repl/recover.js';
import {
  compareScadRun, SCAD_COMPARE_SCOPE, scadDiffText, scadIterateTask, scadNameChanges, scadParamDiff, type ScadFlowRecord,
} from '../src/flows/iterate-scad.js';
import { readStlFile, type StlReadback } from '../src/native/stl-readback.js';

const REPO = path.resolve(__dirname, '..');
const FIXTURES = path.join(REPO, 'tests', 'fixtures');
const FAKE_AGENT = path.join(FIXTURES, 'fake-code-agent.mjs');
const FAKE_OPENSCAD = path.join(FIXTURES, 'fake-openscad.mjs');
const FAKE_CODEX = path.join(FIXTURES, 'fake-codex.mjs');
const STARTER = path.join(REPO, 'templates', 'scad-starter');
const PARAMS = 'box.params.json';

let root: string;
let fixtures: string;
let fakeOpenscad: string;
const spaces: Workspace[] = [];
const servers: Server[] = [];
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

function make(o: { env?: Record<string, string | undefined>; jobsDir?: string; recoverAtStart?: boolean } = {}) {
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const env: Record<string, string> = { TIMMY_AGENT_QWEN_BIN: FAKE_AGENT, TIMMY_AGENT_MODEL: 'qwen3:4b', TIMMY_OPENSCAD: fakeOpenscad };
  for (const [k, v] of Object.entries(o.env ?? {})) { if (v === undefined) delete env[k]; else env[k] = v; }
  const deps: WorkspaceDeps = {
    glyphs: glyphSet(true),
    env,
    onPath: () => null,
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
    ...(o.recoverAtStart === undefined ? {} : { recoverAtStart: o.recoverAtStart }),
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
const recordOf = (id: string): ScadFlowRecord => JSON.parse(fs.readFileSync(path.join(root, 'results', 'flows', `${id}.json`), 'utf8')) as ScadFlowRecord;
const ended = (sealed: ReceiptInput[], id: string) => (): boolean => sealed.some((r) => r.kind === 'flow' && String(r.subject).includes(id));
const nativeRuns = (): string[] => { try { return fs.readdirSync(path.join(root, '.timmy', 'native')); } catch { return []; } };
const noAbsolute = (s: string): void => { for (const p of new Set([root, fs.realpathSync(root), fixtures, os.tmpdir(), REPO])) expect(s).not.toContain(p); };
const starterParams = (): Buffer => fs.readFileSync(path.join(STARTER, PARAMS));
const write = (rel: string, body: string): void => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
/** A model whose FAKE OpenSCAD mode is `mode`, with a parameter file naming width 10. */
function model(name: string, mode: string): void {
  write(`${name}.scad`, `// fake-openscad: ${mode}\nwidth = 10;\ncube([width, 20, 30]);\n`);
  write(`${name}.params.json`, `${JSON.stringify({ schema: 'timmy.scad-params/1', model: `${name}.scad`, parameters: { width: 10 } }, null, 2)}\n`);
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'iterate-scad-project-')));
  fixtures = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'iterate-scad-fixtures-')));
  for (const f of ['box.scad', PARAMS]) fs.copyFileSync(path.join(STARTER, f), path.join(root, f));
  fakeOpenscad = path.join(fixtures, 'bin', 'openscad');
  fs.mkdirSync(path.dirname(fakeOpenscad), { recursive: true });
  fs.copyFileSync(FAKE_OPENSCAD, fakeOpenscad);
  fs.chmodSync(fakeOpenscad, 0o755);
});
afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(fixtures, { recursive: true, force: true });
}, 60000);

// ── the parts that decide ───────────────────────────────────────────────────────

/** Timmy's reading of a box the FAKE OpenSCAD writes, as /scad's judgement records it. */
function boxReading(): StlReadback {
  const dir = fs.mkdtempSync(path.join(fixtures, 'stl-'));
  // a closed box of 12 triangles, written as binary STL (the shape fake-openscad.mjs writes for -D width=4 depth=5 height=6)
  const p = (x: number, y: number, z: number) => [x * 4, y * 5, z * 6];
  const [a, b, c, d, e, f, g, h] = [p(0, 0, 0), p(1, 0, 0), p(1, 1, 0), p(0, 1, 0), p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)];
  const tris = [[a, d, c], [a, c, b], [e, f, g], [e, g, h], [a, b, f], [a, f, e], [d, h, g], [d, g, c], [a, e, h], [a, h, d], [b, c, g], [b, g, f]];
  const buf = Buffer.alloc(84 + 50 * tris.length);
  buf.writeUInt32LE(tris.length, 80);
  tris.forEach((t, i) => t.flat().forEach((v, k) => buf.writeFloatLE(v, 84 + i * 50 + 12 + k * 4)));
  fs.writeFileSync(path.join(dir, 'box.stl'), buf);
  const r = readStlFile(path.join(dir, 'box.stl'), 'out/scad/x/box.stl');
  if (!r.ok) throw Error(r.error);
  return r.readback;
}

describe('/iterate scad: the parts that decide (no processes)', () => {
  it('the task: the instruction first, then the one file, values only, the names, the file whole and the model read only', () => {
    const t = scadIterateTask({ instruction: 'make it 100 wide', paramsRel: 'parts/box.params.json', modelRel: 'parts/box.scad', names: ['width', 'part'], paramsText: '{"x": 1}\n', modelText: 'width = 60;\n' });
    expect(t.split('\n')[0]).toBe('make it 100 wide');
    expect(t).toContain('- Edit only parts/box.params.json. Do not create, change or delete any other file (parts/box.scad included), and run no commands.');
    expect(t).toContain('- Change values only. Keep every name it holds (width, part); add no name and remove none.');
    expect(t).toContain('"schema" stays "timmy.scad-params/1", "model" stays "box.scad"');
    expect(t).toContain('parts/box.params.json now holds:\n{"x": 1}');
    expect(t.trimEnd().endsWith('parts/box.scad (read only: what each parameter does) holds:\nwidth = 60;')).toBe(true);
    expect(scadIterateTask({ instruction: 'x', paramsRel: 'b.params.json', modelRel: 'b.scad', names: ['w'], paramsText: '{}', modelBytes: 99999 })).toContain('b.scad is 99999 bytes, so it is not quoted here: read it for what each parameter does, and do not change it.');
  });

  it('the parameters: each before and after, changed where the value or its kind differs; names added and removed', () => {
    const before = { width: 60, part: 'both', lid: true };
    const diff = scadParamDiff(before, { width: 100, part: 'lid', lid: true });
    expect(diff).toEqual([
      { name: 'width', before: 60, after: 100, changed: true },
      { name: 'part', before: 'both', after: 'lid', changed: true },
      { name: 'lid', before: true, after: true, changed: false },
    ]);
    expect(scadDiffText(diff)).toBe('width 60 → 100, part "both" → "lid"');
    expect(scadParamDiff({ w: 60 }, { w: '60' })[0].changed).toBe(true);
    expect(scadNameChanges(before, { width: 1, lid: true, thickness: 2 })).toEqual({ added: ['thickness'], removed: ['part'] });
    expect(scadDiffText(scadParamDiff({ w: 1 }, { w: 1 }))).toBe('no value changed');
  });

  it('the comparison: matches; no summary when refused (never matches); differs on a box or an open mesh; failed otherwise', () => {
    const m = boxReading();
    expect(m).toMatchObject({ manifold: true, oriented: true, bbox: { size: [4, 5, 6] } });
    const written = { state: 'written' as const, path: 's.json', bbox: { min: [0, 0, 0] as [number, number, number], max: [4, 5, 6] as [number, number, number] }, agrees: true, differs_by: 0 };
    expect(compareScadRun({ readback: m, summary: written })).toMatchObject({ verdict: 'matches' });
    const refused = compareScadRun({ readback: m, summary: { state: 'refused', line: "unrecognised option '--summary'" } });
    expect(refused).toMatchObject({ verdict: 'no summary', reason: "this OpenSCAD refused --summary (unrecognised option '--summary'): there is no summary to compare with" });
    expect(refused.checks.find((c) => c.name === "OpenSCAD's summary")!.passed).toBeNull();
    const off = compareScadRun({ readback: m, summary: { ...written, bbox: { min: [0, 0, 0], max: [4.5, 5, 6] }, agrees: false, differs_by: 0.5 } });
    expect(off.verdict).toBe('differs');
    expect(off.reason).toBe("OpenSCAD's summary: OpenSCAD's own bounding box, from (0, 0, 0) to (4.5, 5, 6), differs from Timmy's, from (0, 0, 0) to (4, 5, 6), by up to 0.5");
    const open = compareScadRun({ readback: { ...m, manifold: false, oriented: false, boundary_edges: 4 }, summary: written });
    expect(open).toMatchObject({ verdict: 'differs', reason: expect.stringMatching(/^closed mesh: not edge-manifold: 4 boundary edges/) });
    expect(compareScadRun({ readback_error: { kind: 'malformed', error: 'not an STL' }, summary: written })).toMatchObject({ verdict: 'failed', reason: 'Timmy could not read the STL back (malformed: not an STL)' });
    expect(compareScadRun({ readback: m, summary: { state: 'not written', path: 's.json' } })).toMatchObject({ verdict: 'failed', reason: 'OpenSCAD accepted --summary but wrote no summary file' });
  });

  it('the command line: scad, the model, the instruction; codex is a local route here too; paid agents and --paid are refused', () => {
    expect(parseIterateLine('scad parts/box.scad "make it 100 wide" --model qwen3:4b')).toEqual({ ok: true, request: { recipe: 'scad', file: 'parts/box.scad', instruction: 'make it 100 wide', agent: 'qwen', model: 'qwen3:4b' } });
    expect(parseIterateLine('scad box.scad "wider" --agent codex')).toEqual({ ok: true, request: { recipe: 'scad', file: 'box.scad', instruction: 'wider', agent: 'codex' } });
    expect(parseIterateLine('blender scene.py "redder" --agent codex')).toEqual({ ok: true, request: { recipe: 'blender', script: 'scene.py', instruction: 'redder', agent: 'codex' } });
    expect(parseIterateLine('scad')).toMatchObject({ ok: false, error: expect.stringContaining('Name the model: /iterate scad <model.scad> "<instruction>" [--agent qwen|codex]') });
    expect(parseIterateLine('scad box.scad')).toMatchObject({ ok: false, error: expect.stringContaining('Say what to change: /iterate scad <model.scad>') });
    expect(parseIterateLine('scad box.scad wider --paid')).toMatchObject({ ok: false, error: expect.stringContaining('it has no --paid') });
    expect(parseIterateLine('scad box.scad wider --agent claude')).toMatchObject({ ok: false, error: expect.stringContaining('Claude Code runs on your own account and costs money') });
    expect(parseIterateLine('vase "taller"')).toMatchObject({ ok: false, error: expect.stringContaining('scad <model.scad>, freecad <script.py> or blender <script.py>') });
  });

  it('the board says what to do when there is no flow, for every kind', () => {
    expect(flowsSection({ list: [], more: 0 }, { live: false, base: '../../' }).html).toContain('/iterate scad &lt;model.scad&gt; and /iterate freecad &lt;script.py&gt; for OpenSCAD and FreeCAD');
  });
});

// ── refusals ────────────────────────────────────────────────────────────────────

describe('/iterate scad refuses before anything is written (FAKE OpenSCAD)', () => {
  it('a missing, outside, linked or non-.scad model, a missing, invalid or empty parameter file, no OpenSCAD, no model: nothing written, nothing started', async () => {
    write('notes.txt', 'x');
    fs.symlinkSync('box.scad', path.join(root, 'linked.scad'));
    write('bare.scad', 'cube(1);\n');
    write('bad.scad', 'cube(1);\n');
    write('bad.params.json', '{"schema": "timmy.scad-params/1", "model": "bad.scad", "parameters": {"v": [1, 2]}}\n');
    write('empty.scad', 'cube(1);\n');
    write('empty.params.json', '{"schema": "timmy.scad-params/1", "model": "empty.scad", "parameters": {}}\n');
    const cases: Array<[Record<string, string | undefined>, string, RegExp]> = [
      [{}, 'scad missing.scad "wider"', /No model at missing\.scad: \/project new <name> --from scad-starter/],
      [{}, 'scad ../outside.scad "wider"', /\.\.\/outside\.scad is outside the project/],
      [{}, 'scad notes.txt "wider"', /notes\.txt is not an OpenSCAD model \(\.scad\)/],
      [{}, 'scad linked.scad "wider"', /linked\.scad is reached through a symbolic link/],
      [{}, 'scad bare.scad "wider"', /No bare\.params\.json beside bare\.scad: \/iterate scad lets the agent change only that file, and Timmy cannot read a model's defaults out of its \.scad reliably\. Make it first .*"schema": "timmy\.scad-params\/1", "model": "bare\.scad"/],
      [{}, 'scad bad.scad "wider"', /bad\.params\.json is not a usable parameter file: v must be a number, true or false, or text \(a vector is refused\)/],
      [{}, 'scad empty.scad "wider"', /empty\.params\.json names no parameter: the agent may change values only/],
      [{ TIMMY_OPENSCAD: path.join(fixtures, 'no-openscad-here') }, 'scad box.scad "wider"', /OpenSCAD \(command line\) was not found on this machine[\s\S]*OpenSCAD comes first[\s\S]*Setup: install OpenSCAD/],
      [{ TIMMY_AGENT_MODEL: undefined }, 'scad box.scad "wider"', /Name the local model: \/iterate scad <model\.scad>/],
      [{ TIMMY_AGENT_BASE_URL: 'https://models.example.com/v1' }, 'scad box.scad "wider"', /is not this machine[\s\S]*only a local, free route, and has no --paid/],
    ];
    for (const [env, line, want] of cases) {
      const { ws, sealed } = make({ env });
      const out = text(await ws.iterate(line));
      expect(out).toMatch(want);
      expect(ws.jobs.list()).toEqual([]);
      expect(sealed).toEqual([]);
      expect(fs.existsSync(path.join(root, '.timmy'))).toBe(false);
      expect(fs.readFileSync(path.join(root, PARAMS))).toEqual(starterParams());
      noAbsolute(out);
    }
  });

  it('/iterate shows the OpenSCAD flow\'s usage and whether OpenSCAD is found (found, not run)', async () => {
    const { ws } = make();
    const out = text(await ws.iterate(''));
    expect(out).toContain('OpenSCAD   /iterate scad <model.scad> "<instruction>" [--agent qwen|codex] [--model <local model>]');
    expect(out).toContain('OpenSCAD found (set by TIMMY_OPENSCAD) · it runs when a flow does, not now');
    expect(out).toContain('Blender    /iterate blender <script.py> "<instruction>" [--agent qwen|codex] [--model <local model>]');
  });
});

// ── the flow ────────────────────────────────────────────────────────────────────

describe('/iterate scad end to end (FAKE agent, FAKE OpenSCAD)', () => {
  it('matches: the agent changes two values, /scad --png runs as a judged job, Timmy\'s reading agrees with OpenSCAD\'s summary; before and after; record, receipts, list, board', async () => {
    const { ws, notes, sealed } = make();
    // An earlier /scad run of the same model, judged ok: the "before".
    const first = text(await ws.scad('box.scad'));
    const firstJob = /Running\s+(j[0-9a-f]{6})/.exec(first)![1];
    await ws.jobs.done(firstJob);
    const firstRun = sealed.find((r) => r.kind === 'native')!.native!.run!;
    expect(sealed.find((r) => r.kind === 'native')).toMatchObject({ status: 'ok', native: { app: 'openscad', outcome: 'ok' } });
    const out = text(await ws.iterate('scad box.scad "make it <wider> & deeper PYFILE:box.params.json PYREPLACE:60,=>100, PYREPLACE:40,=>50,"'));
    const id = flowIdIn(out);
    expect(id).toMatch(FLOW_ID);
    expect(out).toContain(`Flow       ${id}  iterate scad box.scad: make it <wider> & deeper`);
    expect(out).toMatch(/Parameters box\.params\.json {2}width 60, depth 40, height 30, wall 2, lid_gap 0\.3, part "both" · sha256 [0-9a-f]{12} · kept as read: \.timmy\/flows\/f[0-9a-f]{8}\/params\.before\.json/);
    expect(out).toContain('local endpoint, no charge');
    expect(out).toContain('it may change only the values in box.params.json; then OpenSCAD (found, set by TIMMY_OPENSCAD) runs /scad box.scad --png as a judged job');
    expect(out).toContain(`Before     run ${firstRun.slice(0, 8)} (judged ok): 60 x 40 x 30, volume 72000, as Timmy measured its STL`);
    noAbsolute(out);
    await until(ended(sealed, id));
    const rec = recordOf(id);
    expect(rec).toMatchObject({ schema: 'timmy.flow/1', id, kind: 'iterate', target: 'scad', outcome: 'succeeded', ended_in: 'readback', doctrine: DOCTRINE_15 });
    expect(rec.why).toMatch(/^Timmy's reading of out\/scad\/[0-9a-f]{8}\/box\.stl \(100 x 50 x 30, volume 150000, closed and consistently oriented\) matches OpenSCAD's own summary of the same export$/);
    // the parameters: before (kept, read-only) and after, the diff
    const now = fs.readFileSync(path.join(root, PARAMS));
    expect(rec.model).toEqual({ path: 'box.scad', sha256: sha(fs.readFileSync(path.join(root, 'box.scad'))), bytes: fs.statSync(path.join(root, 'box.scad')).size });
    expect(rec.parameters).toMatchObject({ path: PARAMS, before: { sha256: sha(starterParams()), values: { width: 60, depth: 40 } }, after: { sha256: sha(now), values: { width: 100, depth: 50, part: 'both' } } });
    expect(fs.readFileSync(path.join(root, rec.parameters.before.kept!))).toEqual(starterParams());
    expect(fs.statSync(path.join(root, rec.parameters.before.kept!)).mode & 0o222).toBe(0);
    expect(rec.parameters.diff!.filter((d) => d.changed)).toEqual([{ name: 'width', before: 60, after: 100, changed: true }, { name: 'depth', before: 40, after: 50, changed: true }]);
    expect(rec.agent).toMatchObject({ agent: 'qwen', outcome: 'completed', route: 'local endpoint, no charge', cost_usd: 0 });
    expect(rec.agent!.files_changed).toEqual([{ path: PARAMS, how: 'changed', sha256_before: sha(starterParams()), sha256_after: sha(now) }]);
    // OpenSCAD: /scad's own judged job, with the file's values as -D, the STL and the preview
    const o = rec.openscad!;
    expect(o).toMatchObject({ state: 'completed', outcome: 'ok', version: '2026.09.23 (fake)', copy: { path: `.timmy/native/${o.run}/source/box.scad` }, params_file: { path: PARAMS, sha256: sha(now) } });
    expect(o.defines).toEqual(['width=100', 'depth=50', 'height=30', 'wall=2', 'lid_gap=0.3', 'part="both"']);
    expect(o.stl).toMatchObject({ path: `out/scad/${o.run!.slice(0, 8)}/box.stl`, made: true, change: 'created', sha256: sha(fs.readFileSync(path.join(root, o.stl!.path))) });
    expect(o.png).toMatchObject({ path: `out/scad/${o.run!.slice(0, 8)}/box.png`, made: true });
    expect(nativeRuns().sort()).toEqual([firstRun, o.run].sort());
    // the verdict: Timmy's reading against OpenSCAD's own summary
    const k = rec.readback!;
    expect(k).toMatchObject({ verdict: 'matches', scope: SCAD_COMPARE_SCOPE, measured: { size: [100, 50, 30], volume: 150000, manifold: true, oriented: true, stl: o.stl!.path }, summary: { state: 'written', agrees: true, differs_by: 0 } });
    expect(k.checks!.map((c) => [c.name, c.passed])).toEqual([["Timmy's reading", true], ['closed mesh', true], ['consistent orientation', true], ["OpenSCAD's summary", true]]);
    // before and after, each labelled with its run, measured by Timmy
    expect(rec.before_after).toMatchObject({ before: { run: firstRun, job: firstJob, size: [60, 40, 30], volume: 72000 }, after: { run: o.run, job: o.job, size: [100, 50, 30], volume: 150000 } });
    expect(rec.before_after!.measured_by).toMatch(/^Timmy's own reading of each run's exported STL \(timmy-stl-readback\/1\)/);
    // the receipts: the first /scad run, then the agent's, the flow's OpenSCAD run (native, judged ok) and the flow's
    expect(sealed.map((r) => r.kind)).toEqual(['native', 'agent', 'native', 'flow']);
    expect(sealed[2]).toMatchObject({ status: 'ok', native: { app: 'openscad', outcome: 'ok', run: o.run } });
    expect(rec.child_receipts).toEqual([rec.receipts.agent, rec.receipts.openscad]);
    const body = fs.readFileSync(path.join(root, 'results', 'flows', `${id}.json`));
    expect(sealed[3]).toMatchObject({
      kind: 'flow', status: 'ok', subject: `flow · iterate · scad · ${id} · succeeded`, outputs: [{ path: `results/flows/${id}.json`, sha256: sha(body), bytes: body.length }], child_receipts: rec.child_receipts, cost_usd: 0,
      sources: [{ path: PARAMS, sha256: sha(starterParams()), sha256_after: sha(now) }, { path: 'box.scad' }],
    });
    // what the operator saw, with no absolute path
    const notice = notes.join('\n');
    expect(notice).toContain(`${id}  agent qwen ${rec.agent!.run} completed: changed ${PARAMS} · width 60 → 100, depth 40 → 50`);
    expect(notice).toContain(`${id}  OpenSCAD: ${o.job} exports box.scad with -D width=100 -D depth=50 -D height=30 -D wall=2 -D lid_gap=0.3 -D part="both" from its copy .timmy/native/${o.run}/source/box.scad`);
    expect(notice).toMatch(new RegExp(`${o.job} ok  OpenSCAD · box\\.scad · flow ${id}`));
    expect(notice).toContain(`${id} succeeded: Timmy's reading of`);
    expect(notice).toContain(`measured by Timmy from ${o.stl!.path}: 100 x 50 x 30, volume 150000 (enclosed) · timmy-stl-readback/1 · OpenSCAD's own summary: agrees · matches`);
    expect(notice).toContain(`before → after: 60 x 40 x 30, 72000 (run ${firstRun.slice(0, 8)}) → 100 x 50 x 30, 150000 (run ${o.run!.slice(0, 8)})`);
    expect(notice).toContain(DOCTRINE_15);
    noAbsolute(notice);
    noAbsolute(body.toString('utf8'));
    noAbsolute(JSON.stringify(sealed));
    // /iterate lists it
    expect(text(await ws.iterate(''))).toMatch(new RegExp(`${id}\\s+succeeded scad box\\.scad width 60 → 100, depth 40 → 50 · readback matches · results/flows/${id}\\.json`));
    // the board: the flow as a card, verified by its flow receipt; the preview as a picture; the files as links; all escaped
    ws.board('');
    const html = fs.readFileSync(path.join(root, '.timmy/board/index.html'), 'utf8');
    expect(html).toContain('<h2 id="flows">Flows <span class="count">1</span></h2>');
    const card = html.match(/<article class="card flow scad">([\s\S]*?)<\/article>/)![1];
    expect(card).toContain(`<strong>${id}</strong> <span class="state state-succeeded">succeeded</span>`);
    expect(card).toContain('<p class="instruction">make it &lt;wider&gt; &amp; deeper PYFILE:box.params.json PYREPLACE:60,=&gt;100, PYREPLACE:40,=&gt;50,</p>');
    expect(card).not.toContain('<wider>');
    expect(card).toContain('status-verified');
    expect(card).toContain(`<a class="thumb" href="../../${o.png!.path}"><img src="../../${o.png!.path}"`);
    expect(card).toContain('<dt>width</dt><dd><span class="was">60</span> → <strong class="changed">100</strong> <span class="tier">changed</span></dd>');
    expect(card).toContain('<dt>part</dt><dd>&quot;both&quot;</dd>');
    expect(card).toContain('measured from the CAD file: Timmy&#39;s own reading of the exported STL, against OpenSCAD&#39;s own summary');
    expect(card).toContain('<dd class="verdict verdict-matches">matches</dd>');
    expect(card).toContain('<dt>size</dt><dd>100 x 50 x 30 (x × y × z in the file&#39;s units: millimetres by OpenSCAD&#39;s convention)</dd>');
    expect(card).toContain(`<dt>before</dt><dd>60 x 40 x 30, volume 72000 <span class="tier">run ${firstRun.slice(0, 8)} (job ${firstJob})</span></dd>`);
    expect(card).toContain(`<dt>after</dt><dd>100 x 50 x 30, volume 150000 <span class="tier">run ${o.run!.slice(0, 8)} (job ${o.job})</span></dd>`);
    expect(card).toContain(DOCTRINE_15);
    for (const f of [o.stl!.path, o.png!.path, PARAMS, 'box.scad', `results/flows/${id}.json`]) expect(card).toContain(`href="../../${f}"`);
    expect(card).toContain(`receipts: agent ${rec.receipts.agent} · OpenSCAD ${rec.receipts.openscad} · flow `);
    noAbsolute(html);
    // an edited record is no longer verified: its values are shown as the file says
    fs.writeFileSync(path.join(root, 'results', 'flows', `${id}.json`), body.toString('utf8').replace('"volume": 150000', '"volume": 1'));
    ws.board('');
    const after = fs.readFileSync(path.join(root, '.timmy/board/index.html'), 'utf8').match(/<article class="card flow scad">([\s\S]*?)<\/article>/)![1];
    expect(after).toContain('status-unverified');
    expect(after).toContain('the file changed after it was sealed');
    expect(after).toContain('measured from the CAD file, as the record says (not verified)');
    expect(after).not.toContain('<section class="measured readback native">');
  }, 120000);

  it('the agent changes another file: stopped before OpenSCAD runs, the files listed, nothing reverted', async () => {
    const { ws, sealed } = make();
    const id = flowIdIn(text(await ws.iterate('scad box.scad "wider PYFILE:box.params.json PYREPLACE:60,=>100, OTHERFILE"')));
    await until(ended(sealed, id));
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'stopped', ended_in: 'checks' });
    expect(rec.why).toBe(`the agent changed files other than ${PARAMS}: notes/other.txt (added); OpenSCAD did not run, and nothing was reverted; the agent's output is kept: ${rec.agent!.transcript}`);
    expect(rec.agent!.others).toEqual([{ path: 'notes/other.txt', how: 'added', sha256_after: sha(fs.readFileSync(path.join(root, 'notes/other.txt'))) }]);
    expect(fs.readFileSync(path.join(root, PARAMS), 'utf8')).toContain('"width": 100');
    expect(nativeRuns()).toEqual([]);
    expect(rec.openscad).toBeUndefined();
    expect(sealed.map((r) => r.kind)).toEqual(['agent', 'flow']);
    expect(sealed.at(-1)).toMatchObject({ status: 'failed', child_receipts: [rec.receipts.agent] });
  }, 90000);

  it('a parameter file that no longer checks, a name added, or no change: stopped before OpenSCAD runs, the file as the agent left it', async () => {
    const { ws, sealed } = make();
    const bad = flowIdIn(text(await ws.iterate('scad box.scad "PYFILE:box.params.json PYREPLACE:scad-params/1=>scad-params/9"')));
    await until(ended(sealed, bad));
    expect(recordOf(bad)).toMatchObject({ outcome: 'stopped', ended_in: 'checks', parameters: { invalid: { sha256: sha(fs.readFileSync(path.join(root, PARAMS))), error: 'schema must be timmy.scad-params/1' } } });
    expect(recordOf(bad).why).toMatch(/^box\.params\.json as the agent left it does not check: schema must be timmy\.scad-params\/1; it is left as the agent wrote it; OpenSCAD did not run; the agent's output is kept: /);
    expect(fs.readFileSync(path.join(root, PARAMS), 'utf8')).toContain('timmy.scad-params/9');
    fs.copyFileSync(path.join(STARTER, PARAMS), path.join(root, PARAMS));
    const added = flowIdIn(text(await ws.iterate('scad box.scad \'add a thickness PYFILE:box.params.json PYREPLACE:"width":=>"thickness":2,"width":\'')));
    await until(ended(sealed, added));
    const rec = recordOf(added);
    expect(rec).toMatchObject({ outcome: 'stopped', ended_in: 'checks', parameters: { names: { added: ['thickness'], removed: [] } } });
    expect(rec.why).toMatch(/^the agent added thickness in box\.params\.json, and may change values only; it is left as the agent wrote it; OpenSCAD did not run/);
    expect(rec.parameters.diff!.find((d) => d.name === 'thickness')).toEqual({ name: 'thickness', before: null, after: 2, changed: true });
    fs.copyFileSync(path.join(STARTER, PARAMS), path.join(root, PARAMS));
    const none = flowIdIn(text(await ws.iterate('scad box.scad "keep it as it is"')));
    await until(ended(sealed, none));
    expect(recordOf(none)).toMatchObject({ outcome: 'stopped', ended_in: 'checks', why: 'the agent changed nothing; OpenSCAD did not run' });
    expect(nativeRuns()).toEqual([]);
    expect(sealed.map((r) => r.kind)).toEqual(['agent', 'flow', 'agent', 'flow', 'agent', 'flow']);
  }, 120000);

  it('this OpenSCAD refuses --summary: "succeeded, no OpenSCAD summary to compare", never matches', async () => {
    model('refuse', 'no-summary');
    const { ws, notes, sealed } = make();
    const id = flowIdIn(text(await ws.iterate('scad refuse.scad "twice as wide PYFILE:refuse.params.json PYREPLACE:10=>20"')));
    await until(ended(sealed, id));
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'succeeded', ended_in: 'readback', openscad: { outcome: 'ok' }, readback: { verdict: 'no summary', summary: { state: 'refused', line: "unrecognised option '--summary'" }, measured: { size: [20, 20, 30] } } });
    expect(rec.why).toBe(`succeeded, no OpenSCAD summary to compare: this OpenSCAD refused --summary (unrecognised option '--summary'): there is no summary to compare with; only Timmy's reading of ${rec.openscad!.stl!.path} is there (20 x 20 x 30, volume 12000, closed and consistently oriented)`);
    expect(rec.readback!.verdict).not.toBe('matches');
    expect(notes.join('\n')).toContain(`${id} succeeded: succeeded, no OpenSCAD summary to compare`);
    expect(sealed.at(-1)).toMatchObject({ kind: 'flow', status: 'ok' });
    expect(text(await ws.iterate(''))).toMatch(new RegExp(`${id}\\s+succeeded scad refuse\\.scad width 10 → 20 · readback no summary`));
  }, 90000);

  it('a bounding box that differs (a FAKE wrapper moves the summary\'s), and a mesh that is not closed: differs, never a success', async () => {
    // FAKE wrapper: fake-openscad.mjs, then its summary's bounding box moved 0.5 along x, so OpenSCAD's report disagrees.
    const skew = path.join(fixtures, 'bin', 'openscad-skewed.mjs');
    fs.writeFileSync(skew, `#!/usr/bin/env node
// A FAKE wrapper (test double): fake-openscad.mjs with the same arguments, then the summary's bounding box moved.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const r = spawnSync(process.execPath, [${JSON.stringify(FAKE_OPENSCAD)}, ...args], { stdio: 'inherit' });
const i = args.indexOf('--summary-file');
if (i >= 0 && existsSync(args[i + 1])) { const j = JSON.parse(readFileSync(args[i + 1], 'utf8')); j.geometry.bounding_box.max[0] += 0.5; writeFileSync(args[i + 1], JSON.stringify(j)); }
process.exit(r.status ?? 1);
`, { mode: 0o755 });
    const skewed = make({ env: { TIMMY_OPENSCAD: skew } });
    const id = flowIdIn(text(await skewed.ws.iterate('scad box.scad "PYFILE:box.params.json PYREPLACE:60,=>100,"')));
    await until(ended(skewed.sealed, id));
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'differs', ended_in: 'readback', openscad: { outcome: 'ok' }, readback: { verdict: 'differs', summary: { state: 'written', agrees: false, differs_by: 0.5 } } });
    expect(rec.why).toBe("the readback of " + rec.openscad!.stl!.path + " differs: OpenSCAD's summary: OpenSCAD's own bounding box, from (0, 0, 0) to (100.5, 40, 30), differs from Timmy's, from (0, 0, 0) to (100, 40, 30), by up to 0.5");
    expect(skewed.sealed.at(-1)).toMatchObject({ kind: 'flow', status: 'failed' });
    skewed.ws.board('');
    const card = fs.readFileSync(path.join(root, '.timmy/board/index.html'), 'utf8').match(/<article class="card flow scad">([\s\S]*?)<\/article>/)![1];
    expect(card).toContain('<dd class="verdict verdict-differs">differs</dd>');
    expect(card).toContain('<dt>OpenSCAD&#39;s summary</dt><dd class="bad">');
    // A mesh that is not closed (the FAKE OpenSCAD's open mode: the box without its top).
    model('open', 'open');
    const { ws, sealed } = make();
    const second = flowIdIn(text(await ws.iterate('scad open.scad "PYFILE:open.params.json PYREPLACE:10=>12"')));
    await until(ended(sealed, second));
    const open = recordOf(second);
    expect(open).toMatchObject({ outcome: 'differs', openscad: { outcome: 'ok' }, readback: { verdict: 'differs', measured: { manifold: false, oriented: false } } });
    expect(open.why).toMatch(/differs: closed mesh: not edge-manifold: 4 boundary edges \(one triangle: the mesh is open\)/);
  }, 120000);

  it('an OpenSCAD run that fails: failed in its OpenSCAD step, its ERROR line and raw output kept and named; nothing compared', async () => {
    model('broken', 'error');
    const { ws, sealed } = make();
    const id = flowIdIn(text(await ws.iterate('scad broken.scad "PYFILE:broken.params.json PYREPLACE:10=>12"')));
    await until(ended(sealed, id));
    const rec = recordOf(id);
    const o = rec.openscad!;
    // the runner exits non-zero when OpenSCAD's export does: the job failed, and the run is judged by its own record
    expect(rec).toMatchObject({ outcome: 'failed', ended_in: 'openscad', openscad: { outcome: 'failed', state: 'failed' } });
    expect(rec.why).toMatch(/^OpenSCAD's run is judged failed, not ok: no STL was written by this run: openscad exited 1; OpenSCAD reported 1 ERROR line \(first: ERROR: Parser error in file /);
    expect(o.failure_files).toEqual([`.timmy/native/${o.run}/runner.json`, `.timmy/native/${o.run}/logs/export.stderr`, `.timmy/native/${o.run}/verdicts.jsonl`, `.timmy/flows/${id}/openscad.log`]);
    for (const f of o.failure_files!) expect(fs.existsSync(path.join(root, f))).toBe(true);
    expect(o.messages!.lines[0]).toMatch(/^ERROR: Parser error in file "\.\/\.timmy\/native\/[0-9a-f-]{36}\/source\/broken\.scad", line 3: syntax error$/);
    expect(rec.readback).toBeUndefined();
    expect(sealed.map((r) => r.kind)).toEqual(['agent', 'native', 'flow']);
    expect(sealed[1]).toMatchObject({ status: 'failed', native: { app: 'openscad', outcome: 'failed' } });
  }, 90000);
});

// ── stopping and recovery ───────────────────────────────────────────────────────

describe('/stop and recovery for an OpenSCAD flow (FAKE pieces)', () => {
  it('during the agent step: the agent\'s job is cancelled, OpenSCAD never runs; one flow at a time, of any kind; /stop all reaches it', async () => {
    fs.copyFileSync(path.join(REPO, 'templates', 'blender-starter', 'scene.py'), path.join(root, 'scene.py'));
    const { ws, sealed } = make();
    const [out, raced] = (await Promise.all([ws.iterate('scad box.scad "SLEEP PYFILE:box.params.json PYREPLACE:60,=>100,"'), ws.iterate('scad box.scad "wider"')])).map(text);
    const id = flowIdIn(out);
    expect(raced).toContain(`Flow ${id} is still running in this project (its prepare step)`);
    const agent = agentJobIn(out);
    await until(() => (ws.jobs.get(agent)?.pid ?? 0) > 0);
    expect(text(await ws.iterate('tray "PARAM:width=180"'))).toContain(`Flow ${id} is still running in this project (its agent step)`);
    expect(text(await ws.iterate('blender scene.py "redder"'))).toContain(`Flow ${id} is still running in this project (its agent step)`);
    expect(text(await ws.iterate(''))).toContain(`${id}  running: the agent step · /stop ${id} · scad box.scad:`);
    const stopped = text(await ws.stop(id));
    expect(stopped).toContain(`${id} cancelled`);
    expect(stopped).toContain('stopped with /stop during the agent step; OpenSCAD did not run');
    expect(ws.jobs.get(agent)!.state).toBe('cancelled');
    expect(recordOf(id)).toMatchObject({ outcome: 'cancelled', ended_in: 'agent', agent: { outcome: 'cancelled' } });
    expect(nativeRuns()).toEqual([]);
    expect(sealed.at(-1)).toMatchObject({ kind: 'flow', status: 'cancelled', subject: `flow · iterate · scad · ${id} · cancelled` });
    // /stop all: a second flow, stopped in its agent step
    const second = text(await ws.iterate('scad box.scad "SLEEP"'));
    const two = flowIdIn(second);
    await until(() => (ws.jobs.get(agentJobIn(second))?.pid ?? 0) > 0);
    expect(text(await ws.stop('all'))).toContain(`Flows (/iterate): ${two} cancelled; none starts a next step, and each keeps its record in results/flows/.`);
    expect(recordOf(two)).toMatchObject({ outcome: 'cancelled', ended_in: 'agent' });
  }, 90000);

  it('during the OpenSCAD run: its job is cancelled, what it wrote kept, nothing compared (an OpenSCAD flow runs no readback job: its reading is made when its run is judged)', async () => {
    model('slow', 'hang');
    const { ws, sealed } = make();
    const id = flowIdIn(text(await ws.iterate('scad slow.scad "PYFILE:slow.params.json PYREPLACE:10=>12"')));
    await until(() => ws.jobs.list().some((j) => j.label === `OpenSCAD · slow.scad · flow ${id}` && j.state === 'running' && (j.pid ?? 0) > 0), 90000);
    const job = ws.jobs.list().find((j) => j.label === `OpenSCAD · slow.scad · flow ${id}`)!;
    expect(text(await ws.iterate(''))).toContain(`${id}  running: the openscad step · /stop ${id} · scad slow.scad:`);
    const stopped = text(await ws.stop(id));
    expect(stopped).toContain(`${id} cancelled`);
    expect(ws.jobs.get(job.id)!.state).toBe('cancelled');
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'cancelled', ended_in: 'openscad', openscad: { job: job.id, state: 'cancelled' } });
    expect(rec.why).toContain(`stopped with /stop during the OpenSCAD run (job ${job.id}); whatever it wrote is kept, and nothing was compared`);
    expect(rec.readback).toBeUndefined();
    expect(sealed.map((r) => r.kind)).toEqual(['agent', 'task', 'flow']);
    expect(sealed[1]).toMatchObject({ status: 'cancelled' });
  }, 90000);

  it('after a restart: a flow whose session ended during its OpenSCAD run gets its interrupted record and receipt once; /iterate and the board show it', async () => {
    model('slow', 'hang');
    const jobsDir = path.join(fs.mkdtempSync(path.join(fixtures, 'jobs-')), 'jobs');
    const first = make({ jobsDir });
    const id = flowIdIn(text(await first.ws.iterate('scad slow.scad "PYFILE:slow.params.json PYREPLACE:10=>12"')));
    await until(() => first.ws.jobs.list().some((j) => j.label === `OpenSCAD · slow.scad · flow ${id}` && j.state === 'running'), 90000);
    // The state file as the flow wrote it in its OpenSCAD step: what a session that ended now would leave behind.
    const stateFile = path.join(root, '.timmy', 'flows', id, 'state.json');
    await until(() => JSON.parse(fs.readFileSync(stateFile, 'utf8')).step === 'openscad' && JSON.parse(fs.readFileSync(stateFile, 'utf8')).openscad?.state === 'running');
    const left = fs.readFileSync(stateFile);
    const job = JSON.parse(left.toString('utf8')).openscad.job as string;
    await first.ws.stop(id);
    await until(ended(first.sealed, id));
    // SYNTHETIC: as if that session had ended without its stop path: its record gone, its state as it was, ten minutes old.
    fs.rmSync(path.join(root, 'results', 'flows', `${id}.json`));
    fs.writeFileSync(stateFile, left);
    const old = new Date(Date.now() - FLOW_QUIET_MS - 60_000);
    fs.utimesSync(stateFile, old, old);
    const { ws, notes, sealed } = make({ jobsDir: path.join(fs.mkdtempSync(path.join(fixtures, 'jobs-')), 'jobs') });
    const report = (await ws.startRecovery)!;
    expect(report.items.filter((i) => i.kind === 'flow').map((i) => [i.id, i.did])).toEqual([[id, 'interrupted']]);
    const rec = JSON.parse(fs.readFileSync(path.join(root, 'results', 'flows', `${id}.json`), 'utf8'));
    const run8 = String(rec.openscad.run).slice(0, 8);
    expect(rec).toMatchObject({ id, target: 'scad', outcome: 'interrupted', ended_in: 'openscad', instruction: 'PYFILE:slow.params.json PYREPLACE:10=>12' });
    expect(rec.why).toBe(`the REPL running it ended during its OpenSCAD run (its job ${job} has no record in this Timmy's jobs folder); OpenSCAD run ${run8} is judged from its own record (a native run, below); nothing was compared; recorded after a restart, and nothing was run again`);
    expect(rec.recovered.next).toEqual([
      `OpenSCAD run ${run8} keeps its own record in .timmy/native/${rec.openscad.run}/; /recover judges it once its job has ended`,
      'slow.params.json holds the agent\'s change (width 10 → 12): /scad slow.scad runs it',
      '/iterate scad slow.scad "PYFILE:slow.params.json PYREPLACE:10=>12" starts a new flow from slow.params.json as it is now',
    ]);
    expect(rec.recovered.state_file).toEqual({ path: `.timmy/flows/${id}/state.json`, sha256: sha(left) });
    expect(sealed.filter((r) => r.kind === 'flow')).toEqual([expect.objectContaining({ subject: `flow · iterate · scad · ${id} · interrupted`, status: 'failed', child_receipts: [rec.receipts.agent] })]);
    expect(notes.join('\n')).toContain(`1 flow was interrupted: ${id} (record written)`);
    expect(text(await ws.recover(''))).not.toContain(`flow ${id} was interrupted`);
    expect(sealed.filter((r) => r.kind === 'flow')).toHaveLength(1);
    expect(text(await ws.iterate(''))).toMatch(new RegExp(`${id}\\s+interrupted scad slow\\.scad width 10 → 12`));
    ws.board('');
    const card = fs.readFileSync(path.join(root, '.timmy/board/index.html'), 'utf8').match(/<article class="card flow scad">([\s\S]*?)<\/article>/)![1];
    expect(card).toContain(`<strong>${id}</strong> <span class="state state-interrupted">interrupted</span>`);
    expect(card).toContain('status-verified');
  }, 120000);
});

// ── --agent codex, and the agent's tool ──────────────────────────────────────────

/** A FAKE Ollama on 127.0.0.1: GET /api/tags lists `models`; anything else is 404. Each request is recorded. */
async function fakeOllama(models: string[]): Promise<{ url: string; host: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: models.map((name) => ({ name, model: name, size: 1 })) }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not here (a FAKE Ollama)');
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const a = server.address();
  const port = typeof a === 'object' && a ? a.port : 0;
  return { url: `http://127.0.0.1:${port}/v1`, host: `127.0.0.1:${port}`, requests };
}

describe('--agent codex for /iterate scad and /iterate blender (FAKE codex, FAKE Ollama)', () => {
  it('accepted: Codex\'s local route runs at no charge (the FAKE codex edits src/a.txt, so the flow stops before the app runs); refused when remote, a cloud model or not listed', async () => {
    const ollama = await fakeOllama(['qwen3:4b']);
    write('src/a.txt', 'first line\n');
    // FAKE: Blender for /iterate blender's start (never run: the flow stops before it).
    const fakeBlender = path.join(fixtures, 'bin', 'blender');
    fs.copyFileSync(path.join(FIXTURES, 'fake-blender.mjs'), fakeBlender);
    fs.chmodSync(fakeBlender, 0o755);
    fs.copyFileSync(path.join(REPO, 'templates', 'blender-starter', 'scene.py'), path.join(root, 'scene.py'));
    const codex = { TIMMY_AGENT_CODEX_BIN: FAKE_CODEX, TIMMY_AGENT_BASE_URL: ollama.url, TIMMY_BLENDER: fakeBlender };
    for (const [line, file] of [['scad box.scad "wider" --agent codex', PARAMS], ['blender scene.py "redder" --agent codex', 'scene.py']] as const) {
      const { ws, sealed } = make({ env: codex });
      const out = text(await ws.iterate(line));
      const id = flowIdIn(out);
      expect(out).toContain(`Codex codex-cli 0.0.0-fake (a FAKE Codex, not the real one) · model qwen3:4b at ${ollama.host} · local endpoint, no charge`);
      await until(ended(sealed, id));
      const rec = JSON.parse(fs.readFileSync(path.join(root, 'results', 'flows', `${id}.json`), 'utf8'));
      expect(rec).toMatchObject({ outcome: 'stopped', ended_in: 'checks', agent: { agent: 'codex', model: 'qwen3:4b', where: ollama.host, route: 'local endpoint, no charge', outcome: 'completed', cost_usd: 0 } });
      expect(rec.why).toMatch(new RegExp(`^the agent changed files other than ${file.replace('.', '\\.')}: src/a\\.txt \\(changed\\)`));
      expect(sealed.find((r) => r.kind === 'agent')).toMatchObject({ status: 'ok', cost_usd: 0, agent: { name: 'codex', endpoint: 'local', outcome: 'completed' } });
      expect(nativeRuns()).toEqual([]);
    }
    // each start asked the FAKE Ollama for its list (the flow's own check, then /agent's start): nothing else
    expect(ollama.requests).toEqual(['GET /api/tags', 'GET /api/tags', 'GET /api/tags', 'GET /api/tags']);
    const cases: Array<[Record<string, string>, string, RegExp]> = [
      [{ TIMMY_AGENT_BASE_URL: 'https://models.example.com/v1' }, 'scad box.scad "wider" --agent codex', /Remote, so it may cost money: models\.example\.com is not this machine[\s\S]*\/iterate runs only a local, free route, and has no --paid/],
      [{ TIMMY_AGENT_BASE_URL: 'https://models.example.com/v1' }, 'blender scene.py "redder" --agent codex', /models\.example\.com is not this machine/],
      [{}, 'scad box.scad "wider" --agent codex --model gpt-oss:120b-cloud', /is a cloud model[\s\S]*Codex's local route runs only on this machine's Ollama/],
      [{}, 'blender scene.py "redder" --agent codex --model llama3.2:3b', /does not list llama3\.2:3b[\s\S]*codex --oss downloads a model it does not find/],
      [{}, 'scad box.scad "wider" --agent codex --model llama3.2:3b', /does not list llama3\.2:3b/],
      [{}, 'scad box.scad "wider" --agent codex --paid', /it has no --paid/],
    ];
    fs.rmSync(path.join(root, 'results'), { recursive: true, force: true });
    fs.rmSync(path.join(root, '.timmy'), { recursive: true, force: true });
    for (const [env, line, want] of cases) {
      const { ws, sealed } = make({ env: { ...codex, ...env } });
      const out = text(await ws.iterate(line));
      expect(out).toMatch(want);
      expect(ws.jobs.list()).toEqual([]);
      expect(sealed).toEqual([]);
      expect(fs.existsSync(path.join(root, '.timmy'))).toBe(false);
    }
  }, 120000);
});

describe('iterate_native, the agent\'s tool (FAKE pieces)', () => {
  it('asks each time; starts the same flow as /iterate scad, answered as data (started, not finished); refusals as data', async () => {
    // R4 (H40): the box names the app, the file and the instruction (tests/repl-approvals.test.ts has the long ones)
    expect(approvalNeeded('iterate_native', { app: 'openscad', file: 'box.scad', instruction: 'wider' })).toEqual({
      reason: 'starts a local code agent that may change one file in your project (an OpenSCAD model\'s <model>.params.json, or a FreeCAD script), then runs OpenSCAD or FreeCAD on this machine and reads the result back', summary: 'openscad box.scad: wider', session: false,
    });
    const { ws, sealed } = make();
    const tools = createIterateTools({ start: (r) => ws.iterateForTool(r) });
    expect(tools.map((t) => (t as unknown as { function: { name: string } }).function.name)).toEqual(['iterate_recipe', 'iterate_native']);
    const exec = (tools[1] as unknown as { function: { execute: (i: unknown) => Promise<Record<string, any>> } }).function.execute;
    const started = await exec({ app: 'openscad', file: 'box.scad', instruction: 'wider PYFILE:box.params.json PYREPLACE:60,=>70,' });
    expect(started).toMatchObject({ ok: true, flow: expect.stringMatching(FLOW_ID), target: 'scad', agent_job: expect.stringMatching(/^j[0-9a-f]{6}$/), file_the_agent_may_change: { path: PARAMS, sha256: sha(starterParams()) }, record_when_done: `results/flows/${started.flow}.json`, doctrine: DOCTRINE_15 });
    expect(started.note).toContain('Started, not finished');
    await until(ended(sealed, started.flow));
    expect(recordOf(started.flow)).toMatchObject({ outcome: 'succeeded', readback: { measured: { size: [70, 40, 30] } } });
    expect(await exec({ app: 'openscad', file: 'nothing.scad', instruction: 'wider' })).toMatchObject({ ok: false, started: false, error: expect.stringContaining('No model at nothing.scad') });
    expect(await exec({ app: 'openscad', file: ' ', instruction: 'wider' })).toMatchObject({ ok: false, started: false, error: expect.stringContaining('name the file') });
  }, 90000);
});
