/**
 * Round R4 (/iterate freecad, helper H33): the FreeCAD flow, driven end to end through the Workspace: a local code agent
 * changes one FreeCAD Python script, /freecad's own judged native job runs it, its STEP is read back exactly as
 * /freecad readback reads it, and the flow is kept as a record with a receipt. Real files, real child processes, real job
 * lifecycles. Also here: --agent codex for /iterate freecad.
 *
 * FAKE pieces, each labelled:
 * - the code agent is tests/fixtures/fake-code-agent.mjs (a TEST DOUBLE: no model, nothing sent), run through /agent's own
 *   start as Qwen Code on a local endpoint (TIMMY_AGENT_QWEN_BIN); its PYFILE, PYREPLACE and PYBREAK words edit plate.py;
 * - freecadcmd is tests/fixtures/fake-freecadcmd.mjs behind a TEST wrapper (as in tests/native-freecad.test.ts): python3
 *   runs the script the way FreeCAD's source says freecadcmd takes a .py file, with the stand-in FreeCAD and Part modules
 *   (tests/fixtures/freecad-stub: volumes and bounding boxes by formula, FAKE .FCStd and STEP files with no geometry);
 *   one test uses a FAKE freecadcmd that only sleeps;
 * - the readback is tests/fixtures/fake-freecad-readback.mjs (a TEST DOUBLE that copies the stand-in's numbers out of the
 *   FAKE STEP and measures nothing), given through /freecad readback's own test seam, so the flow runs /freecad readback's
 *   own runner around it;
 * - the Python syntax check runs this machine's real python3 (these tests are skipped without one);
 * - for --agent codex: tests/fixtures/fake-codex.mjs (a TEST DOUBLE of codex-cli) and a FAKE Ollama on 127.0.0.1.
 * No FreeCAD, OCP, Codex, Ollama or model runs here: a pass says the flow, the judgement, the readback's record and the
 * flow record agree with each other and with the stand-ins, not that FreeCAD accepts the calls.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { folderProject } from '../src/project/index.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { parseIterateLine } from '../src/repl/iterate.js';
import { createIterateTools } from '../src/agent/iterate-tools.js';
import { glyphSet } from '../src/term/glyphs.js';
import { hashOf, type Receipt, type ReceiptInput } from '../src/utils/receipts.js';
import { DOCTRINE_15, FLOW_ID } from '../src/flows/iterate.js';
import { FLOW_QUIET_MS } from '../src/repl/recover.js';
import { FREECAD_READBACK_SCOPE, readReadbacks } from '../src/native/freecad.js';
import { freecadIterateTask, stepMeasure, type FreecadFlowRecord } from '../src/flows/iterate-freecad.js';

const REPO = path.resolve(__dirname, '..');
const FIXTURES = path.join(REPO, 'tests', 'fixtures');
const STUB = path.join(FIXTURES, 'freecad-stub');
const FAKE_AGENT = path.join(FIXTURES, 'fake-code-agent.mjs');
const FAKE_FREECADCMD = path.join(FIXTURES, 'fake-freecadcmd.mjs');
const FAKE_READBACK = path.join(FIXTURES, 'fake-freecad-readback.mjs');
const FAKE_CODEX = path.join(FIXTURES, 'fake-codex.mjs');
const STARTER = path.join(REPO, 'templates', 'freecad-starter', 'plate.py');
const which = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
const python = which.status === 0 ? which.stdout.trim() : '';
if (!python) {
  // eslint-disable-next-line no-console
  console.log('[iterate-freecad.test] the flow tests are skipped: no python3 here (the stand-in FreeCAD and the syntax check need one)');
}

let root: string;
let fixtures: string;
let wrapper: string;
const spaces: Workspace[] = [];
const servers: Server[] = [];
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const starterBytes = (): Buffer => fs.readFileSync(STARTER);
/** The edit the tests ask the FAKE agent for: the plate 120 mm long (DEFAULTS' "length": 100.0 → 120.0). */
const LONGER = 'PYFILE:plate.py PYREPLACE:100.0,=>120.0,';

type ReadbackMode = 'match' | 'differ' | 'fail' | 'sleep';

function make(o: { env?: Record<string, string | undefined>; readback?: ReadbackMode; python?: boolean; python3?: string; jobsDir?: string } = {}) {
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const env: Record<string, string> = { TIMMY_AGENT_QWEN_BIN: FAKE_AGENT, TIMMY_AGENT_MODEL: 'qwen3:4b', TIMMY_FREECADCMD: wrapper };
  for (const [k, v] of Object.entries(o.env ?? {})) { if (v === undefined) delete env[k]; else env[k] = v; }
  const deps: WorkspaceDeps = {
    glyphs: glyphSet(true),
    env,
    // python3 is found on PATH as this machine's, or as the one a test gives (o.python3), or not at all (python: false).
    onPath: (cmd) => (cmd === 'python3' && o.python !== false ? o.python3 ?? python : null),
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
    // FAKE: /freecad readback's test seam, the readback test double instead of TIMMY_CADQUERY_PYTHON workers/readback/step_readback.py.
    ...(o.readback ? { freecadTest: { readback: (step: { abs: string; rel: string }) => ({ command: process.execPath, args: [FAKE_READBACK, o.readback!, step.abs, '--as', step.rel] }) } } : {}),
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
const recordOf = (id: string): FreecadFlowRecord => JSON.parse(fs.readFileSync(path.join(root, 'results', 'flows', `${id}.json`), 'utf8')) as FreecadFlowRecord;
const ended = (sealed: ReceiptInput[], id: string) => (): boolean => sealed.some((r) => r.kind === 'flow' && String(r.subject).includes(id));
const nativeRuns = (): string[] => { try { return fs.readdirSync(path.join(root, '.timmy', 'native')); } catch { return []; } };
const noAbsolute = (s: string): void => { for (const p of new Set([root, fs.realpathSync(root), fixtures, os.tmpdir(), REPO])) expect(s).not.toContain(p); };

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'iterate-freecad-project-')));
  fixtures = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'iterate-freecad-fixtures-')));
  fs.copyFileSync(STARTER, path.join(root, 'plate.py'));
  // A TEST wrapper: the FAKE freecadcmd with the stand-in FreeCAD and Part modules (as tests/native-freecad.test.ts).
  wrapper = path.join(fixtures, 'bin', 'freecadcmd-wrapper');
  fs.mkdirSync(path.dirname(wrapper), { recursive: true });
  fs.writeFileSync(wrapper, `#!/bin/sh\n# a TEST wrapper: the FAKE freecadcmd with the stand-in FreeCAD and Part modules\nPYTHONPATH='${STUB}' FAKE_FREECAD_PYTHON='${python}' FAKE_FREECAD_MODE=python PYTHONDONTWRITEBYTECODE=1 exec '${process.execPath}' '${FAKE_FREECADCMD}' "$@"\n`, { mode: 0o755 });
});
afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(fixtures, { recursive: true, force: true });
}, 60000);

// ── the parts that decide ───────────────────────────────────────────────────────

describe('/iterate freecad: the parts that decide (no processes)', () => {
  it('the task: the instruction first, then the one script, how freecadcmd takes it, and the script whole', () => {
    const t = freecadIterateTask({ instruction: 'make it 120 mm long', scriptRel: 'parts/plate.py', scriptText: 'import FreeCAD\n' });
    expect(t.split('\n')[0]).toBe('make it 120 mm long');
    expect(t).toContain('- Edit only parts/plate.py. Do not create, change or delete any other file, and run no commands.');
    expect(t).toContain('timmy_freecad.run_script(main) called at the top level (never under if __name__ == "__main__", which an import does not run)');
    expect(t.trimEnd().endsWith('parts/plate.py now holds:\nimport FreeCAD')).toBe(true);
  });

  it('FreeCAD\'s report of a STEP export: the preferred one, else the only one with a whole shape', () => {
    const shape = (x: number) => ({ valid: true, solids: 1, volume_mm3: x, bounds: { min: [0, 0, 0], max: [x, 1, 1], size: [x, 1, 1] } });
    const report = { exports: [{ path: 'out/a.step', format: 'STEP', objects: ['A'], shape: shape(2) }, { path: 'out/b.step', format: 'STEP', objects: ['B'], shape: shape(3) }, { path: 'out/c.stl', format: 'STL', objects: [], shape: shape(4) }] };
    expect(stepMeasure(report)).toBeUndefined();
    expect(stepMeasure(report, 'out/b.step')).toEqual({ step: 'out/b.step', objects: ['B'], valid: true, solids: 1, size: [3, 1, 1], min: [0, 0, 0], max: [3, 1, 1], volume_mm3: 3 });
    expect(stepMeasure({ exports: [report.exports[0]] })?.step).toBe('out/a.step');
  });

  it('the command line: freecad, the script, the instruction; codex is a local route; paid agents and --paid are refused', () => {
    expect(parseIterateLine('freecad parts/plate.py "make it 120 mm long" --model qwen3:4b')).toEqual({ ok: true, request: { recipe: 'freecad', file: 'parts/plate.py', instruction: 'make it 120 mm long', agent: 'qwen', model: 'qwen3:4b' } });
    expect(parseIterateLine('freecad plate.py longer --agent=codex')).toEqual({ ok: true, request: { recipe: 'freecad', file: 'plate.py', instruction: 'longer', agent: 'codex' } });
    expect(parseIterateLine('freecad')).toMatchObject({ ok: false, error: expect.stringContaining('Name the script: /iterate freecad <script.py> "<instruction>" [--agent qwen|codex]') });
    expect(parseIterateLine('freecad plate.py')).toMatchObject({ ok: false, error: expect.stringContaining('Say what to change: /iterate freecad <script.py>') });
    expect(parseIterateLine('freecad plate.py longer --paid')).toMatchObject({ ok: false, error: expect.stringContaining('it has no --paid') });
    expect(parseIterateLine('freecad plate.py longer --agent opencode')).toMatchObject({ ok: false, error: expect.stringContaining('OpenCode runs on your own account and costs money') });
  });
});

// ── refusals ────────────────────────────────────────────────────────────────────

describe.skipIf(!python)('/iterate freecad refuses before anything is written (FAKE freecadcmd)', () => {
  it('a missing, outside, hidden, linked, large or non-Python script, no freecadcmd, no model, or a remote endpoint: nothing written, nothing started', async () => {
    fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
    fs.symlinkSync('plate.py', path.join(root, 'linked.py'));
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'node_modules', 'plate.py'), 'import FreeCAD\n');
    fs.writeFileSync(path.join(root, 'big.py'), `# ${'x'.repeat(300 * 1024)}\n`);
    const cases: Array<[Record<string, string | undefined>, string, RegExp]> = [
      [{}, 'freecad missing.py "longer"', /No script at missing\.py: \/project new <name> --from freecad-starter/],
      [{}, 'freecad ../outside.py "longer"', /\.\.\/outside\.py is outside the project/],
      [{}, 'freecad notes.txt "longer"', /notes\.txt is not a Python file \(\.py\): \/iterate freecad changes a FreeCAD Python script/],
      [{}, 'freecad node_modules/plate.py "longer"', /node_modules\/plate\.py is inside node_modules\/, which the agent's before\/after comparison does not look into/],
      [{}, 'freecad linked.py "longer"', /linked\.py is reached through a symbolic link/],
      [{}, 'freecad big.py "longer"', /big\.py is \d+ bytes: \/iterate freecad gives the agent the whole script, and takes scripts up to 256 KB/],
      [{ TIMMY_FREECADCMD: path.join(fixtures, 'no-freecad-here') }, 'freecad plate.py "longer"', /FreeCAD \(freecadcmd, headless\) was not found on this machine[\s\S]*FreeCAD comes first[\s\S]*Setup: /],
      [{ TIMMY_AGENT_MODEL: undefined }, 'freecad plate.py "longer"', /Name the local model: \/iterate freecad <script\.py>/],
      [{ TIMMY_AGENT_BASE_URL: 'https://models.example.com/v1' }, 'freecad plate.py "longer"', /is not this machine[\s\S]*only a local, free route, and has no --paid/],
    ];
    for (const [env, line, want] of cases) {
      const { ws, sealed } = make({ env });
      const out = text(await ws.iterate(line));
      expect(out).toMatch(want);
      expect(ws.jobs.list()).toEqual([]);
      expect(sealed).toEqual([]);
      expect(fs.existsSync(path.join(root, '.timmy'))).toBe(false);
      expect(fs.readFileSync(path.join(root, 'plate.py'))).toEqual(starterBytes());
      noAbsolute(out);
    }
  });

  it('/iterate shows the FreeCAD flow\'s usage, whether freecadcmd is found and whether a readback can run (said, not run)', async () => {
    expect(text(await make().ws.iterate(''))).toMatch(/FreeCAD {4}\/iterate freecad <script\.py> "<instruction>" \[--agent qwen\|codex\] \[--model <local model>\][\s\S]*freecadcmd found \(set by TIMMY_FREECADCMD\) · it runs when a flow does, not now[\s\S]*no readback: TIMMY_CADQUERY_PYTHON is not set: set TIMMY_CADQUERY_PYTHON/);
    expect(text(await make({ readback: 'match' }).ws.iterate(''))).toContain('the readback can run · checked when a flow reaches it, not now');
  });
});

// ── the flow ────────────────────────────────────────────────────────────────────

describe.skipIf(!python)('/iterate freecad end to end (FAKE agent, FAKE freecadcmd with the stand-in FreeCAD, FAKE readback)', () => {
  it('matches: the agent changes the script, it parses, FreeCAD runs it as a judged job, the STEP read back matches FreeCAD\'s report; before and after; record, receipts, list, board', async () => {
    const { ws, notes, sealed } = make({ readback: 'match' });
    // An earlier FreeCAD run of the same script, judged ok: the "before".
    const first = text(await ws.freecad('plate.py'));
    const firstJob = /Running\s+(j[0-9a-f]{6})/.exec(first)![1];
    await ws.jobs.done(firstJob);
    const firstRun = sealed.find((r) => r.kind === 'native')!.native!.run!;
    expect(sealed.find((r) => r.kind === 'native')).toMatchObject({ status: 'ok', native: { app: 'freecad', outcome: 'ok' } });
    const out = text(await ws.iterate(`freecad plate.py "make the <plate> 120 mm long & keep the holes ${LONGER}"`));
    const id = flowIdIn(out);
    expect(id).toMatch(FLOW_ID);
    expect(out).toContain(`Flow       ${id}  iterate freecad plate.py: make the <plate> 120 mm long & keep the holes`);
    expect(out).toMatch(/Script {5}plate\.py {2}\d+ lines · sha256 [0-9a-f]{12} · kept as read: \.timmy\/flows\/f[0-9a-f]{8}\/script\.before\.py/);
    expect(out).toContain('then FreeCAD (found, set by TIMMY_FREECADCMD) runs it as a judged job, and its STEP is read back in a separate process as /freecad readback reads it');
    expect(out).toContain(`Before     run ${firstRun.slice(0, 8)} (judged ok): 100 x 60 x 6 mm, 35,203.606 mm3 in out/plate.step, as FreeCAD reported it`);
    noAbsolute(out);
    await until(ended(sealed, id));
    const rec = recordOf(id);
    expect(rec).toMatchObject({ schema: 'timmy.flow/1', id, kind: 'iterate', target: 'freecad', outcome: 'succeeded', ended_in: 'readback', doctrine: DOCTRINE_15 });
    expect(rec.why).toBe('the readback of out/plate.step matches FreeCAD\'s report within 1e-6 mm and 1e-8 relative (both are OpenCascade: not an independent kernel\'s confirmation)');
    // the script: before (kept, read-only) and after, the change, the syntax check by this machine's python3
    const now = fs.readFileSync(path.join(root, 'plate.py'));
    expect(now.toString('utf8')).toContain('"length": 120.0,');
    expect(rec.script).toMatchObject({ path: 'plate.py', before: { sha256: sha(starterBytes()), bytes: starterBytes().length }, after: { sha256: sha(now), bytes: now.length }, change: { added: 1, removed: 1, hunks_total: 1 }, syntax: { checked: true, ok: true, by: 'python3' } });
    expect(fs.readFileSync(path.join(root, rec.script.before.kept!))).toEqual(starterBytes());
    expect(fs.statSync(path.join(root, rec.script.before.kept!)).mode & 0o222).toBe(0);
    expect(rec.agent).toMatchObject({ agent: 'qwen', outcome: 'completed', route: 'local endpoint, no charge', cost_usd: 0 });
    // FreeCAD: /freecad's own judged job, its copy, its result, the document and the STEP, FreeCAD's report
    const c = rec.freecad!;
    expect(c).toMatchObject({ state: 'completed', outcome: 'ok', version: '1.0.0', copy: { path: `.timmy/native/${c.run}/source/timmy_${c.run!.slice(0, 8)}_plate.py`, sha256: sha(now) }, result: { path: `.timmy/native/${c.run}/result.json` } });
    expect(c.fcstd).toEqual([{ path: 'out/plate.FCStd', sha256: sha(fs.readFileSync(path.join(root, 'out', 'plate.FCStd'))) }]);
    expect(c.step).toEqual({ path: 'out/plate.step', sha256: sha(fs.readFileSync(path.join(root, 'out', 'plate.step'))) });
    expect(c.reported).toMatchObject({ valid: true, solids: 1, bounds: { min: [0, 0, 0], max: [120, 60, 6], size: [120, 60, 6] }, objects: ['Plate'] });
    expect(c.checks).toEqual([{ label: 'plate bounds', passed: true }, { label: 'plate analytic volume', passed: true }, { label: 'plate is one valid solid', passed: true }]);
    expect(nativeRuns().sort()).toEqual([firstRun, c.run].sort());
    // the readback: /freecad readback's own runner, record and receipt
    const k = rec.readback!;
    expect(k).toMatchObject({ state: 'completed', verdict: 'matches', worker: { name: 'fake-step-readback' }, step: c.step, tolerance: { bounds_mm: 1e-6, volume_relative: 1e-8 }, scope: FREECAD_READBACK_SCOPE, record: `.timmy/native/${c.run}/readbacks.jsonl` });
    expect(k.measured).toMatchObject({ valid: true, solids: 1, bounds: { max: [120, 60, 6] }, geometry: { provenance: 'generated', evidence: 'checked' } });
    expect(k.reported).toMatchObject({ measured_by: "FreeCAD's own report of its own document, in the process that built it" });
    const [line] = readReadbacks(path.join(root, '.timmy', 'native', c.run!));
    expect(line).toMatchObject({ job: k.job, verdict: 'matches', run: c.run, log: k.log, receipt: k.receipt });
    expect(fs.readFileSync(path.join(root, k.log!), 'utf8')).toContain('FAKE readback: numbers copied');
    // before and after, each labelled with its run, as FreeCAD reported each
    expect(rec.before_after).toMatchObject({
      measured_by: "FreeCAD's own report of its own document, in the process that built it",
      before: { run: firstRun, job: firstJob, step: 'out/plate.step', size: [100, 60, 6] }, after: { run: c.run, job: c.job, step: 'out/plate.step', size: [120, 60, 6] },
    });
    expect(rec.before_after!.after!.volume_mm3 - rec.before_after!.before!.volume_mm3).toBeCloseTo(20 * 60 * 6, 6);
    // the receipts: the first run's, then the agent's, the flow's FreeCAD run (native), the readback's, and the flow's
    expect(sealed.map((r) => r.kind)).toEqual(['native', 'agent', 'native', 'readback', 'flow']);
    expect(sealed[3]).toMatchObject({ kind: 'readback', status: 'ok', child_receipts: [rec.receipts.freecad], sources: [{ path: 'out/plate.step', sha256: c.step!.sha256, role: 'read' }, { freecad_run: c.run, verdict: 'matches' }] });
    expect(rec.child_receipts).toEqual([rec.receipts.agent, rec.receipts.freecad, rec.receipts.readback]);
    const body = fs.readFileSync(path.join(root, 'results', 'flows', `${id}.json`));
    expect(sealed[4]).toMatchObject({ kind: 'flow', status: 'ok', subject: `flow · iterate · freecad · ${id} · succeeded`, outputs: [{ path: `results/flows/${id}.json`, sha256: sha(body) }], child_receipts: rec.child_receipts, cost_usd: 0, sources: [{ path: 'plate.py', sha256: sha(starterBytes()), sha256_after: sha(now) }] });
    // what the operator saw
    const notice = notes.join('\n');
    expect(notice).toContain(`${id}  agent qwen ${rec.agent!.run} completed: changed plate.py (+1 −1 lines in 1 place) · parses as Python (an AST parse by python3`);
    expect(notice).toContain("this machine's python3, not FreeCAD's own)");
    expect(notice).toContain(`${id}  FreeCAD: ${c.job} runs plate.py as submitted (its copy: ${c.copy!.path}, as module timmy_${c.run!.slice(0, 8)}_plate)`);
    expect(notice).toContain(`${id}  readback: ${k.job} reads out/plate.step back in its own process (OCP's STEP reader), as /freecad readback does`);
    expect(notice).toMatch(new RegExp(`${k.job} readback matches  out/plate\\.step · FreeCAD run ${c.run!.slice(0, 8)} · receipt id4`));
    expect(notice).toContain(`${id} succeeded: the readback of out/plate.step matches FreeCAD's report`);
    expect(notice).toMatch(/FreeCAD reported {3}out\/plate\.step: 1 valid solid, 120 x 60 x 6 mm, 42,403\.\d+ mm3/);
    expect(notice).toMatch(/readback measured {2}1 valid solid, 120 x 60 x 6 mm, 42,403\.\d+ mm3 · fake-step-readback/);
    expect(notice).toContain(`before → after: 100 x 60 x 6 mm, 35,203.606 mm3 (run ${firstRun.slice(0, 8)}) → 120 x 60 x 6 mm, 42,403.606 mm3 (run ${c.run!.slice(0, 8)})`);
    expect(notice).toContain(DOCTRINE_15);
    noAbsolute(notice);
    noAbsolute(body.toString('utf8'));
    noAbsolute(JSON.stringify(sealed));
    // /iterate lists it
    expect(text(await ws.iterate(''))).toMatch(new RegExp(`${id}\\s+succeeded freecad plate\\.py \\+1 −1 lines in 1 place · readback matches · results/flows/${id}\\.json`));
    // the board: the card, verified; the script's diff; the document and the STEP as links; both measurements; all escaped
    ws.board('');
    const html = fs.readFileSync(path.join(root, '.timmy/board/index.html'), 'utf8');
    const card = html.match(/<article class="card flow freecad">([\s\S]*?)<\/article>/)![1];
    expect(card).toContain(`<strong>${id}</strong> <span class="state state-succeeded">succeeded</span>`);
    expect(card).toContain('<p class="instruction">make the &lt;plate&gt; 120 mm long &amp; keep the holes PYFILE:plate.py PYREPLACE:100.0,=&gt;120.0,</p>');
    expect(card).not.toContain('<plate>');
    expect(card).toContain('status-verified');
    expect(card).toContain('<span class="removed">- DEFAULTS = {&quot;length&quot;: 100.0,');
    expect(card).toContain('<span class="added">+ DEFAULTS = {&quot;length&quot;: 120.0,');
    expect(card).toContain('<dt>change</dt><dd>+1 −1 lines in 1 place</dd>');
    expect(card).toContain('measured from the CAD file: FreeCAD&#39;s report, and the STEP read back in its own process');
    expect(card).toContain('<dd class="verdict verdict-matches">matches <span class="tier">within 0.000001 mm and 1e-8 relative</span></dd>');
    expect(card).toMatch(/<dt>FreeCAD reported<\/dt><dd>out\/plate\.step: 1 valid solid, 120 x 60 x 6 mm, 42403\.\d+ mm3/);
    expect(card).toMatch(/<dt>readback measured<\/dt><dd>1 valid solid, 120 x 60 x 6 mm, 42403\.\d+ mm3/);
    expect(card).toContain(`<span class="tier">run ${firstRun.slice(0, 8)} (job ${firstJob})</span>`);
    expect(card).toContain(DOCTRINE_15);
    for (const f of ['out/plate.FCStd', 'out/plate.step', 'plate.py', `results/flows/${id}.json`]) expect(card).toContain(`href="../../${f}"`);
    expect(card).toContain(`receipts: agent ${rec.receipts.agent} · FreeCAD ${rec.receipts.freecad} · readback ${rec.receipts.readback} · flow `);
    noAbsolute(html);
  }, 120000);

  it('the agent changes another file, the script no longer parses, or nothing changes: stopped before FreeCAD runs, nothing reverted', async () => {
    const { ws, sealed } = make({ readback: 'match' });
    const other = flowIdIn(text(await ws.iterate(`freecad plate.py "longer ${LONGER} OTHERFILE"`)));
    await until(ended(sealed, other));
    const o = recordOf(other);
    expect(o).toMatchObject({ outcome: 'stopped', ended_in: 'checks' });
    expect(o.why).toBe(`the agent changed files other than plate.py: notes/other.txt (added); FreeCAD did not run, and nothing was reverted; the agent's output is kept: ${o.agent!.transcript}`);
    expect(o.agent!.others).toEqual([{ path: 'notes/other.txt', how: 'added', sha256_after: sha(fs.readFileSync(path.join(root, 'notes/other.txt'))) }]);
    expect(fs.readFileSync(path.join(root, 'plate.py'), 'utf8')).toContain('"length": 120.0,');
    fs.copyFileSync(STARTER, path.join(root, 'plate.py'));
    fs.rmSync(path.join(root, 'notes'), { recursive: true });
    const broken = flowIdIn(text(await ws.iterate('freecad plate.py "add a helper PYFILE:plate.py PYBREAK"')));
    await until(ended(sealed, broken));
    const b = recordOf(broken);
    const lines = starterBytes().toString('utf8').split('\n').length;
    expect(b).toMatchObject({ outcome: 'stopped', ended_in: 'checks', script: { syntax: { checked: true, ok: false, by: 'python3', error: expect.stringMatching(/^SyntaxError: /), line: lines + 1 } } });
    expect(b.why).toMatch(/^plate\.py as the agent left it does not parse as Python: SyntaxError: [^;]+, line \d+ \(an AST parse by python3 [0-9.]+\); it is left as the agent wrote it; FreeCAD did not run; the agent's output is kept: /);
    expect(fs.readFileSync(path.join(root, 'plate.py'), 'utf8')).toContain('def broken(:');
    fs.copyFileSync(STARTER, path.join(root, 'plate.py'));
    const none = flowIdIn(text(await ws.iterate('freecad plate.py "keep it as it is"')));
    await until(ended(sealed, none));
    expect(recordOf(none)).toMatchObject({ outcome: 'stopped', ended_in: 'checks', why: 'the agent changed nothing; FreeCAD did not run' });
    expect(nativeRuns()).toEqual([]);
    expect(sealed.map((r) => r.kind)).toEqual(['agent', 'flow', 'agent', 'flow', 'agent', 'flow']);
  }, 120000);

  it('a readback that differs: the flow differs, with the numbers; a FreeCAD run that fails: failed in its FreeCAD step, its raw failure kept', async () => {
    const { ws, notes, sealed } = make({ readback: 'differ' });
    const id = flowIdIn(text(await ws.iterate(`freecad plate.py "longer ${LONGER}"`)));
    await until(ended(sealed, id));
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'differs', ended_in: 'readback', freecad: { outcome: 'ok' }, readback: { verdict: 'differs', state: 'completed' } });
    expect(rec.why).toMatch(/^the readback of out\/plate\.step differs from FreeCAD's report: bounds max x \(mm\): FreeCAD reported 120, the readback measured 120\.5 \(difference 0\.500\); volume \(mm3\): FreeCAD reported 42403\.\d+, the readback measured 42404\.\d+ \(difference 1\.00\)$/);
    expect(rec.readback!.checks!.filter((c) => !c.passed).map((c) => c.name)).toEqual(['bounds max x (mm)', 'volume (mm3)']);
    expect(sealed.find((r) => r.kind === 'readback')).toMatchObject({ status: 'failed' });
    expect(sealed.at(-1)).toMatchObject({ kind: 'flow', status: 'failed' });
    expect(notes.join('\n')).toContain(`${id} differs`);
    ws.board('');
    const card = fs.readFileSync(path.join(root, '.timmy/board/index.html'), 'utf8').match(/<article class="card flow freecad">([\s\S]*?)<\/article>/)![1];
    expect(card).toContain('<dd class="verdict verdict-differs">differs');
    expect(card).toContain('<dt>bounds max x (mm)</dt><dd class="bad">FreeCAD reported 120, the readback measured 120.5 <span class="tier">outside the tolerance</span></dd>');
    // A run that fails: a length the plate refuses, so the script reports ok: false.
    fs.copyFileSync(STARTER, path.join(root, 'plate.py'));
    const bad = flowIdIn(text(await ws.iterate('freecad plate.py "a negative length PYFILE:plate.py PYREPLACE:100.0,=>-5.0,"')));
    await until(ended(sealed, bad));
    const f = recordOf(bad);
    const c = f.freecad!;
    expect(f).toMatchObject({ outcome: 'failed', ended_in: 'freecad', freecad: { outcome: 'failed' } });
    expect(f.why).toMatch(/^FreeCAD's run is judged failed, not ok: the script reported ok: false: ValueError: length must be a positive number of millimetres, not -5\.0[\s\S]*; nothing was read back; kept: /);
    expect(c.failure_files).toEqual(expect.arrayContaining([`.timmy/native/${c.run}/result.json`, `.timmy/native/${c.run}/verdicts.jsonl`, `.timmy/flows/${bad}/freecad.log`]));
    for (const x of c.failure_files!) expect(fs.existsSync(path.join(root, x))).toBe(true);
    expect(c.error).toMatch(/^ValueError: length must be a positive number/);
    expect(f.readback).toBeUndefined();
  }, 120000);

  it('without TIMMY_CADQUERY_PYTHON: "succeeded without readback", with the setup step; never matches', async () => {
    const { ws, sealed } = make();
    const out = text(await ws.iterate(`freecad plate.py "longer ${LONGER}"`));
    expect(out).toContain('and the flow ends there: no readback (TIMMY_CADQUERY_PYTHON is not set: set TIMMY_CADQUERY_PYTHON to the absolute path of a Python with CadQuery (its OCP reads the STEP))');
    const id = flowIdIn(out);
    await until(ended(sealed, id));
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'succeeded', ended_in: 'readback', freecad: { outcome: 'ok' }, readback: { state: 'not run', setup: 'TIMMY_CADQUERY_PYTHON is not set: set TIMMY_CADQUERY_PYTHON to the absolute path of a Python with CadQuery (its OCP reads the STEP)' } });
    expect(rec.readback!.verdict).toBeUndefined();
    expect(rec.why).toBe(`succeeded without readback: FreeCAD's run is judged ok, but no readback could run (TIMMY_CADQUERY_PYTHON is not set: set TIMMY_CADQUERY_PYTHON to the absolute path of a Python with CadQuery (its OCP reads the STEP)); its STEP is not compared with FreeCAD's report: /freecad readback ${rec.freecad!.run!.slice(0, 8)} does it once the setup is done`);
    expect(sealed.map((r) => r.kind)).toEqual(['agent', 'native', 'flow']);
    expect(rec.child_receipts).toEqual([rec.receipts.agent, rec.receipts.freecad]);
    expect(text(await ws.iterate(''))).toMatch(new RegExp(`${id}\\s+succeeded freecad plate\\.py \\+1 −1 lines in 1 place · without readback · results/flows/${id}\\.json`));
    ws.board('');
    const card = fs.readFileSync(path.join(root, '.timmy/board/index.html'), 'utf8').match(/<article class="card flow freecad">([\s\S]*?)<\/article>/)![1];
    expect(card).toContain('<dd class="verdict verdict-none">succeeded without readback</dd>');
    expect(card).toContain('<dt>setup</dt><dd>TIMMY_CADQUERY_PYTHON is not set');
    expect(card).not.toContain('verdict-matches');
  }, 90000);
});

// ── stopping and recovery ───────────────────────────────────────────────────────

describe.skipIf(!python)('/stop and recovery for a FreeCAD flow (FAKE pieces)', () => {
  it('during the agent step and the checks: the agent\'s job is cancelled, FreeCAD never runs; /stop all reaches it', async () => {
    const { ws, sealed } = make({ readback: 'match' });
    const out = text(await ws.iterate(`freecad plate.py "SLEEP ${LONGER}"`));
    const id = flowIdIn(out);
    const agent = agentJobIn(out);
    await until(() => (ws.jobs.get(agent)?.pid ?? 0) > 0);
    expect(text(await ws.iterate(''))).toContain(`${id}  running: the agent step · /stop ${id} · freecad plate.py:`);
    const stopped = text(await ws.stop(id));
    expect(stopped).toContain(`${id} cancelled`);
    expect(stopped).toContain('stopped with /stop during the agent step; FreeCAD did not run');
    expect(recordOf(id)).toMatchObject({ outcome: 'cancelled', ended_in: 'agent', agent: { outcome: 'cancelled' } });
    // FAKE: a python3 that answers nothing for 30 s, so the flow is still in its checks when /stop comes
    const slow = path.join(fixtures, 'slow-python3');
    fs.writeFileSync(slow, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    const checks = make({ readback: 'match', python3: slow });
    const second = flowIdIn(text(await checks.ws.iterate(`freecad plate.py "longer ${LONGER}"`)));
    const end = Date.now() + 60000;
    while (!text(await checks.ws.iterate('')).includes(`${second}  running: the checks step`)) {
      if (Date.now() > end) throw Error('timed out');
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(text(await checks.ws.stop(second))).toContain(`${second} cancelled`);
    expect(recordOf(second)).toMatchObject({ outcome: 'cancelled', ended_in: 'checks', why: 'stopped with /stop during the checks; FreeCAD did not run', script: { syntax: { checked: false, why: 'stopped with /stop' } } });
    // /stop all: a third flow, stopped in its agent step
    fs.copyFileSync(STARTER, path.join(root, 'plate.py'));
    const third = text(await ws.iterate('freecad plate.py "SLEEP"'));
    const three = flowIdIn(third);
    await until(() => (ws.jobs.get(agentJobIn(third))?.pid ?? 0) > 0);
    expect(text(await ws.stop('all'))).toContain(`Flows (/iterate): ${three} cancelled; none starts a next step, and each keeps its record in results/flows/.`);
    expect(recordOf(three)).toMatchObject({ outcome: 'cancelled', ended_in: 'agent' });
    expect(nativeRuns()).toEqual([]);
    expect(sealed.filter((r) => r.kind === 'flow').every((r) => r.status === 'cancelled')).toBe(true);
  }, 120000);

  it('the REPL\'s end (Workspace.close) stops a running flow: its agent job is cancelled, its record written and sealed once', async () => {
    const { ws, sealed } = make({ readback: 'match' });
    const out = text(await ws.iterate(`freecad plate.py "SLEEP ${LONGER}"`));
    const id = flowIdIn(out);
    const agent = agentJobIn(out);
    await until(() => (ws.jobs.get(agent)?.pid ?? 0) > 0);
    spaces.splice(spaces.indexOf(ws), 1);
    await ws.close();
    expect(ws.jobs.get(agent)!.state).toBe('cancelled');
    // The same words as the tray's and Blender's flows use for the REPL's end (it stops them through the same abort).
    expect(recordOf(id)).toMatchObject({ outcome: 'cancelled', ended_in: 'agent', why: expect.stringContaining('during the agent step; FreeCAD did not run') });
    expect(sealed.filter((r) => r.kind === 'flow')).toEqual([expect.objectContaining({ subject: `flow · iterate · freecad · ${id} · cancelled`, status: 'cancelled' })]);
    expect(nativeRuns()).toEqual([]);
  }, 90000);

  it('during the FreeCAD run (a FAKE freecadcmd that only sleeps): its job is cancelled, nothing read back', async () => {
    const sleeper = path.join(fixtures, 'bin', 'freecadcmd-sleeps');
    fs.writeFileSync(sleeper, '#!/bin/sh\n# a FAKE freecadcmd (test double) that only waits until it is stopped\nexec sleep 30\n', { mode: 0o755 });
    const { ws, sealed } = make({ readback: 'match', env: { TIMMY_FREECADCMD: sleeper } });
    const id = flowIdIn(text(await ws.iterate(`freecad plate.py "longer ${LONGER}"`)));
    await until(() => ws.jobs.list().some((j) => j.label === `FreeCAD · plate.py · flow ${id}` && j.state === 'running' && (j.pid ?? 0) > 0), 90000);
    const job = ws.jobs.list().find((j) => j.label === `FreeCAD · plate.py · flow ${id}`)!;
    expect(text(await ws.stop(id))).toContain(`${id} cancelled`);
    expect(ws.jobs.get(job.id)!.state).toBe('cancelled');
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'cancelled', ended_in: 'freecad', freecad: { job: job.id, state: 'cancelled' } });
    expect(rec.why).toContain(`stopped with /stop during the FreeCAD run (job ${job.id}); whatever it wrote is kept, and nothing was read back`);
    expect(rec.readback).toBeUndefined();
    expect(sealed.map((r) => r.kind)).toEqual(['agent', 'task', 'flow']);
  }, 90000);

  it('during the readback: its job is cancelled, recorded beside the run with no verdict, sealed as cancelled', async () => {
    const { ws, sealed } = make({ readback: 'sleep' });
    const id = flowIdIn(text(await ws.iterate(`freecad plate.py "longer ${LONGER}"`)));
    await until(() => ws.jobs.list().some((j) => j.label.startsWith('readback out/plate.step') && j.label.endsWith(`flow ${id}`) && j.state === 'running' && (j.pid ?? 0) > 0), 90000);
    const job = ws.jobs.list().find((j) => j.label.endsWith(`flow ${id}`) && j.label.startsWith('readback'))!;
    expect(job.label).toMatch(new RegExp(`^readback out/plate\\.step · FreeCAD run [0-9a-f]{8} · flow ${id}$`));
    expect(text(await ws.iterate(''))).toContain(`${id}  running: the readback step · /stop ${id} · freecad plate.py:`);
    expect(text(await ws.stop(id))).toContain(`${id} cancelled`);
    expect(ws.jobs.get(job.id)!.state).toBe('cancelled');
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'cancelled', ended_in: 'readback', freecad: { outcome: 'ok' }, readback: { state: 'cancelled', job: job.id, reason: 'stopped with /stop before it finished: no verdict' } });
    expect(rec.readback!.verdict).toBeUndefined();
    expect(readReadbacks(path.join(root, '.timmy', 'native', rec.freecad!.run!))).toEqual([expect.objectContaining({ job: job.id, state: 'cancelled' })]);
    expect(sealed.find((r) => r.kind === 'readback')).toMatchObject({ status: 'cancelled' });
    expect(sealed.at(-1)).toMatchObject({ kind: 'flow', status: 'cancelled' });
  }, 90000);

  it('after a restart: a flow whose session ended during its readback gets its interrupted record and receipt once', async () => {
    const first = make({ readback: 'sleep' });
    const id = flowIdIn(text(await first.ws.iterate(`freecad plate.py "longer ${LONGER}"`)));
    const stateFile = path.join(root, '.timmy', 'flows', id, 'state.json');
    await until(() => { try { const s = JSON.parse(fs.readFileSync(stateFile, 'utf8')); return s.step === 'readback' && s.readback?.state === 'running'; } catch { return false; } }, 90000);
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
    const run8 = String(state.freecad.run).slice(0, 8);
    expect(rec).toMatchObject({ id, target: 'freecad', outcome: 'interrupted', ended_in: 'readback' });
    expect(rec.why).toBe(`the REPL running it ended during its readback (its job ${state.readback.job} has no record in this Timmy's jobs folder); there is no verdict; recorded after a restart, and nothing was run again`);
    expect(rec.recovered.next).toEqual([
      `/jobs ${state.readback.job} shows the readback's output while this Timmy's jobs folder keeps it`,
      `/freecad readback ${run8} reads its STEP back again`,
      'plate.py holds the agent\'s change: /freecad plate.py runs it',
      `/iterate freecad plate.py "longer ${LONGER}" starts a new flow from plate.py as it is now`,
    ]);
    expect(rec.child_receipts).toEqual([state.receipts.agent, state.receipts.freecad]);
    expect(sealed.filter((r) => r.kind === 'flow')).toEqual([expect.objectContaining({ subject: `flow · iterate · freecad · ${id} · interrupted`, status: 'failed', child_receipts: rec.child_receipts })]);
    expect(notes.join('\n')).toContain(`1 flow was interrupted: ${id} (record written)`);
    expect(text(await ws.recover(''))).not.toContain(`flow ${id} was interrupted`);
    expect(text(await ws.iterate(''))).toMatch(new RegExp(`${id}\\s+interrupted freecad plate\\.py \\+1 −1 lines in 1 place`));
  }, 120000);
});

// ── --agent codex, and the agent's tool ──────────────────────────────────────────

/** A FAKE Ollama on 127.0.0.1: GET /api/tags lists `models`; anything else is 404. */
async function fakeOllama(models: string[]): Promise<{ url: string; host: string }> {
  const server = createServer((req, res) => {
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
  return { url: `http://127.0.0.1:${port}/v1`, host: `127.0.0.1:${port}` };
}

describe.skipIf(!python)('--agent codex for /iterate freecad, and iterate_native (FAKE codex, FAKE Ollama)', () => {
  it('accepted: Codex\'s local route runs at no charge (the FAKE codex edits src/a.txt, so the flow stops before FreeCAD); refused when remote or paid', async () => {
    const ollama = await fakeOllama(['qwen3:4b']);
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.txt'), 'first line\n');
    const codex = { TIMMY_AGENT_CODEX_BIN: FAKE_CODEX, TIMMY_AGENT_BASE_URL: ollama.url };
    const { ws, sealed } = make({ env: codex });
    const out = text(await ws.iterate('freecad plate.py "longer" --agent codex'));
    expect(out).toContain(`Codex codex-cli 0.0.0-fake (a FAKE Codex, not the real one) · model qwen3:4b at ${ollama.host} · local endpoint, no charge`);
    const id = flowIdIn(out);
    await until(ended(sealed, id));
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'stopped', ended_in: 'checks', agent: { agent: 'codex', route: 'local endpoint, no charge', outcome: 'completed', cost_usd: 0 } });
    expect(rec.why).toMatch(/^the agent changed files other than plate\.py: src\/a\.txt \(changed\); FreeCAD did not run/);
    expect(nativeRuns()).toEqual([]);
    for (const [env, line, want] of [
      [{ TIMMY_AGENT_BASE_URL: 'https://models.example.com/v1' }, 'freecad plate.py "longer" --agent codex', /Remote, so it may cost money: models\.example\.com is not this machine/],
      [{}, 'freecad plate.py "longer" --agent codex --model gpt-oss:120b-cloud', /is a cloud model/],
      [{}, 'freecad plate.py "longer" --agent codex --paid', /it has no --paid/],
    ] as Array<[Record<string, string>, string, RegExp]>) {
      const w = make({ env: { ...codex, ...env } });
      expect(text(await w.ws.iterate(line))).toMatch(want);
      expect(w.ws.jobs.list()).toEqual([]);
      expect(w.sealed).toEqual([]);
    }
  }, 90000);

  it('iterate_native starts the same flow as /iterate freecad, answered as data', async () => {
    const { ws, sealed } = make({ readback: 'match' });
    const [, native] = createIterateTools({ start: (r) => ws.iterateForTool(r) });
    const exec = (native as unknown as { function: { execute: (i: unknown) => Promise<Record<string, any>> } }).function.execute;
    const started = await exec({ app: 'freecad', file: 'plate.py', instruction: `longer ${LONGER}` });
    expect(started).toMatchObject({ ok: true, target: 'freecad', flow: expect.stringMatching(FLOW_ID), file_the_agent_may_change: { path: 'plate.py', sha256: sha(starterBytes()) }, doctrine: DOCTRINE_15 });
    expect(started.note).toContain('Started, not finished');
    await until(ended(sealed, started.flow));
    expect(recordOf(started.flow)).toMatchObject({ outcome: 'succeeded', readback: { verdict: 'matches' } });
  }, 90000);
});
