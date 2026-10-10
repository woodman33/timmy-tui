/**
 * Round R4 (/iterate, helper H24): the connected flow, driven end to end through the Workspace: a local code agent
 * changes recipes/tray.params.json, the recipe rebuilds as a durable job, a separate worker reads the delivered STEP
 * back, and the flow is kept as a record with a receipt. Real files, real child processes, real job lifecycles.
 *
 * FAKE pieces, each labelled:
 * - the code agent is tests/fixtures/fake-code-agent.mjs (a TEST DOUBLE: no model, nothing sent), run through /agent's
 *   own start, as Qwen Code on a local endpoint (TIMMY_AGENT_QWEN_BIN);
 * - the recipe runs through the jobs.ts executor seam with a SYNTHETIC fixture executor (as tests/recipe-repl.test.ts):
 *   labelled synthetic files and signed receipts, no CadQuery; TIMMY_CADQUERY_PYTHON names a FAKE file never executed;
 * - the readback is tests/fixtures/fake-step-readback.mjs (a TEST DOUBLE that measures nothing), except where the real
 *   workers/readback/step_readback.py runs: its failure paths with this machine's python3, and a real measurement
 *   only when TIMMY_CADQUERY_PYTHON names a Python with CadQuery (skipped otherwise, with the reason).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { folderProject } from '../src/project/index.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { COMMANDS } from '../src/repl/commands.js';
import { parseIterateLine } from '../src/repl/iterate.js';
import { checkFlowRecord, flowsSection } from '../src/repl/board-flows.js';
import { approvalNeeded } from '../src/repl/approvals.js';
import { replTools } from '../src/repl/main.js';
import { createIterateTools } from '../src/agent/iterate-tools.js';
import { glyphSet } from '../src/term/glyphs.js';
import { hashOf, type Receipt, type ReceiptInput } from '../src/utils/receipts.js';
import { jobDirectory, status } from '../lanes/recipes/jobs.js';
import { DOCTRINE_15, EXPORTS, recipeCapabilityRow } from '../src/recipes/index.js';
import {
  compareReadback, FLOW_ID, iterateTask, judgeAgentChanges, paramDiff, parseReadbackOutput, READBACK_SCRIPT, READBACK_TOLERANCE, type FlowRecord, type ReadbackMeasured,
} from '../src/flows/iterate.js';

const FAKE_AGENT = path.resolve('tests/fixtures/fake-code-agent.mjs');
const FAKE_READBACK = path.resolve('tests/fixtures/fake-step-readback.mjs');
const PARAMS = 'recipes/tray.params.json';

let root: string;
let fixtures: string;
let fakePython: string;
const spaces: Workspace[] = [];
let supervisors: Promise<void>[] = [];
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** A SYNTHETIC fixture executor for the jobs.ts seam (as tests/recipe-repl.test.ts): labelled files, signed receipts, no geometry. */
function fakeExecutor(mode: 'complete' | 'reported-failure' | 'wait'): string {
  const file = path.join(fixtures, `fake-recipe-${mode}.mts`);
  const module = (name: string) => JSON.stringify(pathToFileURL(path.resolve(name)).href);
  fs.writeFileSync(file, `
// FAKE recipe executor (test fixture): SYNTHETIC files only; no CadQuery, no Open3D, no Python.
import fs from 'node:fs'; import path from 'node:path'; import {randomUUID} from 'node:crypto';
import {loadJob,jobDirectory,recordResult} from ${module('lanes/recipes/jobs.ts')};
import {appendReceipt} from ${module('src/utils/receipts.ts')};
import {sha,prediction,validate} from ${module('lanes/recipes/tray.ts')};
const mode=${JSON.stringify(mode)};
const [,root,id]=process.argv.slice(2), job=loadJob(root,id), dir=jobDirectory(root,id), workspace=path.join(dir,'workspace');
fs.appendFileSync(path.join(dir,'executions.txt'),'fake execution\\n');
if(mode==='wait')await new Promise(r=>setTimeout(r,20000));
const p=validate(job.request), pred=prediction(p);
const run=randomUUID(), base=path.join(workspace,'.timmy','recipe-runs',run);fs.mkdirSync(base,{recursive:true});
fs.writeFileSync(path.join(base,'request.json'),JSON.stringify(job.request));
fs.writeFileSync(path.join(base,'prediction.json'),JSON.stringify(pred,null,2)+'\\n');
fs.writeFileSync(path.join(base,'build.py'),'SYNTHETIC fixture source; not the recipe');
const common={subject:'SYNTHETIC recipe fixture; no geometry claim',policy:'auto',cost_usd:0};
const prediction_=appendReceipt('runs',{...common,status:'ok',kind:'recipe.prediction',sources:['request.json','prediction.json','build.py'].map(n=>({path:path.join(base,n),sha256:sha(fs.readFileSync(path.join(base,n)))}))},workspace);
const native=path.join(base,'native');fs.mkdirSync(native);
const failed=mode==='reported-failure';
const exports=failed?[]:${JSON.stringify(EXPORTS)}.map(f=>{fs.writeFileSync(path.join(native,f),'SYNTHETIC '+f+'; not geometry');return {file:f,sha256:sha(fs.readFileSync(path.join(native,f)))};});
const labels=[...Array.from({length:12},(_,i)=>'Stage check '+(i+1)),'Native bounds','Native analytic volume','Native valid single solid','STEP reimport bounds','STEP reimport analytic volume','STEP reimport valid single solid','STL closed, manifold, orientable','STL one component, no self intersections','STL volume agrees within 0.1%','Every construction stage validated',...Array.from({length:8},(_,i)=>'axis '+(i+1))];
const result={schema:'timmy.tray-build/1',engine:'SYNTHETIC fixture',synthetic:true,variant:{measured:{bounds:pred.bounds,volume:pred.volumeMm3},mesh:{engine:'SYNTHETIC mesh fixture'},checks:labels.map((label,i)=>({id:'geometry.'+String(i+1).padStart(2,'0'),label,passed:!failed}))}};
fs.writeFileSync(path.join(native,'result.json'),JSON.stringify(result));
fs.writeFileSync(path.join(base,'native.log'),failed?'SYNTHETIC native failure for the test':'SYNTHETIC native log');
const sources=[path.join(native,'result.json'),path.join(base,'native.log'),...exports.map(e=>path.join(native,e.file))].map(f=>({path:f,sha256:sha(fs.readFileSync(f))}));
const receipt=appendReceipt('runs',{...common,status:failed?'failed':'ok',kind:'recipe.build',child_receipts:[prediction_.id],sources},workspace);
const report={state:failed?'failed':'succeeded',run,parameters:p,predictionReceipt:prediction_.id,receipt:receipt.id,receiptHash:receipt.hash,checksPassed:failed?null:30,exports,error:failed?'SYNTHETIC failure':undefined};
fs.writeFileSync(path.join(base,'report.json'),JSON.stringify(report,null,2)+'\\n');
recordResult(root,id,{...report,directory:base});
`);
  return file;
}

type ReadbackMode = 'match' | 'differ' | 'fail' | 'garbage' | 'sleep' | 'wrongbytes';

function make(o: { recipe?: 'complete' | 'reported-failure' | 'wait'; readback?: ReadbackMode; env?: Record<string, string | undefined> } = {}) {
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const env: Record<string, string> = { TIMMY_AGENT_QWEN_BIN: FAKE_AGENT, TIMMY_AGENT_MODEL: 'qwen3:4b', TIMMY_CADQUERY_PYTHON: fakePython };
  for (const [k, v] of Object.entries(o.env ?? {})) { if (v === undefined) delete env[k]; else env[k] = v; }
  const deps: WorkspaceDeps = {
    glyphs: glyphSet(true),
    env,
    onPath: () => null,
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
    // FAKE: the jobs.ts executor seam and a fast watcher poll; the supervisor is observed so teardown can wait for it.
    recipeTest: {
      executor: fakeExecutor(o.recipe ?? 'complete'),
      pollMs: 100,
      onSupervisor: (child: ChildProcess) => { supervisors.push(new Promise((r) => { child.once('close', () => r()); child.once('error', () => r()); })); },
    },
    // FAKE: the readback test double instead of TIMMY_CADQUERY_PYTHON workers/readback/step_readback.py.
    iterateTest: { readback: (step) => ({ command: process.execPath, args: [FAKE_READBACK, o.readback ?? 'match', step.abs, '--as', step.rel] }), settleMs: 15000 },
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
const recordOf = (id: string): FlowRecord => JSON.parse(fs.readFileSync(path.join(root, 'results', 'flows', `${id}.json`), 'utf8')) as FlowRecord;
const ended = (sealed: ReceiptInput[], id: string) => (): boolean => sealed.some((r) => r.kind === 'flow' && String(r.subject).includes(id));
const recipeJobs = (): string[] => { try { return fs.readdirSync(path.join(root, '.timmy', 'recipe-jobs')); } catch { return []; } };
const noAbsolute = (s: string): void => { for (const p of new Set([root, fs.realpathSync(root), fixtures, os.tmpdir()])) expect(s).not.toContain(p); };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'iterate-project-'));
  fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'iterate-fixtures-'));
  fakePython = path.join(fixtures, 'fake-python');
  fs.writeFileSync(fakePython, '#!/bin/sh\necho "FAKE: not a Python; never executed by these tests"\nexit 1\n', { mode: 0o755 });
  supervisors = [];
});
afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  await Promise.race([Promise.all(supervisors), new Promise((r) => setTimeout(r, 25000))]);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(fixtures, { recursive: true, force: true });
}, 60000);

describe('/iterate: the parts that decide (no processes)', () => {
  it('the task: the instruction first, then the one file, its shape, only the named parameters and the ranges in mm', () => {
    const t = iterateTask({ instruction: 'make it 180 mm wide', paramsRel: PARAMS, fileText: '{"schema":"timmy.recipe-params/1"}\n' });
    expect(t.split('\n')[0]).toBe('make it 180 mm wide');
    expect(t).toContain(`Edit only ${PARAMS}. Do not create, change or delete any other file, and run no commands.`);
    expect(t).toContain('"schema" stays "timmy.recipe-params/1", "recipe" stays "enclosure.tray/1"');
    expect(t).toContain('Change only the parameters the instruction names');
    expect(t).toContain('width: overall width (X), 40 to 1000');
    expect(t).toContain('supportOffset: edge to each support and bore axis, above wall + 6, below min(width, 80)/2 - 6');
    expect(t).toContain('bore: bore diameter, above 0, below 12');
    expect(t.trimEnd().endsWith('{"schema":"timmy.recipe-params/1"}')).toBe(true);
  });

  it('what the agent changed: only the parameter file passes; anything else, a deleted file or an incomplete comparison stops', () => {
    const c = (p: string) => ({ path: p, size: 1, sha256: 'b'.repeat(64), previous_sha256: 'a'.repeat(64) });
    expect(judgeAgentChanges({ added: [], changed: [c(PARAMS)], deleted: [], truncated: false }, PARAMS)).toMatchObject({ ok: true, params: 'changed' });
    expect(judgeAgentChanges({ added: [], changed: [], deleted: [], truncated: false }, PARAMS)).toEqual({ ok: true, params: 'unchanged' });
    const other = judgeAgentChanges({ added: [c('notes/x.txt')], changed: [c(PARAMS), c('src/a.ts')], deleted: [c('old.txt')], truncated: false }, PARAMS);
    expect(other).toMatchObject({ ok: false, reason: 'others' });
    if (!other.ok) expect(other.why).toBe(`the agent changed files other than ${PARAMS}: notes/x.txt (added), src/a.ts (changed), old.txt (deleted)`);
    expect(judgeAgentChanges({ added: [], changed: [], deleted: [c(PARAMS)], truncated: false }, PARAMS)).toMatchObject({ ok: false, reason: 'deleted' });
    expect(judgeAgentChanges({ added: [], changed: [c(PARAMS)], deleted: [], truncated: true }, PARAMS)).toMatchObject({ ok: false, reason: 'incomplete' });
    expect(judgeAgentChanges(undefined, PARAMS)).toMatchObject({ ok: false, reason: 'missing' });
  });

  it('the parameter diff marks each changed value', () => {
    expect(paramDiff({ width: 140, wall: 3, supportOffset: 10, bore: 3 }, { width: 180, wall: 3, supportOffset: 10, bore: 3 })).toEqual([
      { name: 'width', before: 140, after: 180, changed: true },
      { name: 'wall', before: 3, after: 3, changed: false },
      { name: 'supportOffset', before: 10, after: 10, changed: false },
      { name: 'bore', before: 3, after: 3, changed: false },
    ]);
  });

  it('the readback output: the worker\'s one JSON line, every claimed value present, or a failure with the reason', () => {
    const good = { ok: true, worker: { name: 'timmy-step-readback', version: '0.1.0' }, source: { name: 'a.step', sha256: 'c'.repeat(64), bytes: 10 }, units: 'mm', valid: true, solids: 1, bounds: { min: [0, 0, 0], max: [1, 2, 3], size: [1, 2, 3] }, volume_mm3: 6 };
    expect(parseReadbackOutput(`OCCT warning on stderr\n${JSON.stringify(good)}\n`)).toMatchObject({ ok: true, valid: true, solids: 1, bounds: { size: [1, 2, 3] }, volume_mm3: 6 });
    expect(parseReadbackOutput('')).toMatchObject({ ok: false, code: 'no-output' });
    expect(parseReadbackOutput('not json')).toMatchObject({ ok: false, code: 'no-output' });
    expect(parseReadbackOutput(JSON.stringify({ ok: false, worker: good.worker, error: { code: 'no-ocp', message: 'OCP is not importable' } }))).toMatchObject({ ok: false, code: 'no-ocp', error: 'OCP is not importable' });
    const { volume_mm3: _v, ...noVolume } = good;
    expect(parseReadbackOutput(JSON.stringify(noVolume))).toMatchObject({ ok: false, code: 'malformed', error: 'the result line has no volume' });
    expect(parseReadbackOutput(JSON.stringify({ ...good, units: 'm' }))).toMatchObject({ ok: false, code: 'malformed' });
    expect(parseReadbackOutput(JSON.stringify({ ...good, bounds: { size: [1, 2] } }))).toMatchObject({ ok: false, error: 'the result line has no bounding box' });
  });

  it('the comparison: the recipe gate\'s tolerances (1e-6 mm, 1e-8 relative), each check with its numbers', () => {
    expect(READBACK_TOLERANCE).toEqual({ bounds_mm: 1e-6, volume_relative: 1e-8 });
    const m = (size: number[], volume: number, extra: Partial<ReadbackMeasured> = {}): ReadbackMeasured => ({ ok: true, worker: { name: 'w', version: '1' }, source: { name: 'a', sha256: 'c'.repeat(64), bytes: 1 }, valid: true, solids: 1, bounds: { min: [0, 0, 0], max: size, size }, volume_mm3: volume, ...extra });
    const pred = { bounds: [180, 80, 30], volume: 100000 };
    expect(compareReadback(pred, m([180 + 5e-7, 80, 30], 100000 * (1 + 5e-9))).verdict).toBe('matches');
    const off = compareReadback(pred, m([180.5, 80, 30], 100000));
    expect(off.verdict).toBe('differs');
    expect(off.checks.find((c) => c.name === 'bounds x (mm)')).toMatchObject({ predicted: 180, measured: 180.5, passed: false });
    expect(compareReadback(pred, m([180, 80, 30], 100000 * (1 + 2e-8))).verdict).toBe('differs');
    expect(compareReadback(pred, m([180, 80, 30], 100000, { solids: 2 })).checks.find((c) => c.name === 'solids')).toMatchObject({ passed: false });
    expect(compareReadback(pred, m([180, 80, 30], 100000, { valid: false })).verdict).toBe('differs');
  });

  it('the command line: tray and an instruction; --agent qwen and --model; no --paid, no paid agent', () => {
    expect(parseIterateLine('tray "make it 180 mm wide" --model qwen3:4b')).toEqual({ ok: true, request: { recipe: 'tray', instruction: 'make it 180 mm wide', agent: 'qwen', model: 'qwen3:4b' } });
    expect(parseIterateLine('tray --agent qwen widen it to 160')).toMatchObject({ ok: true, request: { instruction: 'widen it to 160', agent: 'qwen' } });
    expect(parseIterateLine('tray --paid widen it')).toMatchObject({ ok: false, error: expect.stringContaining('it has no --paid') });
    expect(parseIterateLine('tray --agent claude widen it')).toMatchObject({ ok: false, error: expect.stringContaining('Claude Code runs on your own account and costs money') });
    expect(parseIterateLine('tray')).toMatchObject({ ok: false, error: expect.stringContaining('Say what to change') });
    expect(parseIterateLine('vase "taller"')).toMatchObject({ ok: false, error: expect.stringContaining('No recipe vase') });
    // R4 (H26): /iterate blender is its own flow (tests/iterate-blender.test.ts)
    expect(parseIterateLine('blender scene.py "x"')).toEqual({ ok: true, request: { recipe: 'blender', script: 'scene.py', instruction: 'x', agent: 'qwen' } });
    expect(parseIterateLine('tray --fast x')).toMatchObject({ ok: false, error: expect.stringContaining('No option --fast') });
    const c = COMMANDS.find((x) => x.name === 'iterate');
    expect(c?.group).toBe('work');
    expect(`  /${'iterate'.padEnd(11)} ${c?.description}`.length).toBeLessThanOrEqual(60);
  });
});

describe('the board\'s Flows section (no processes)', () => {
  const record = (o: Partial<FlowRecord> = {}): FlowRecord => ({
    flow: 1, schema: 'timmy.flow/1', id: 'f0123abcd', kind: 'iterate', recipe: 'enclosure.tray/1', instruction: 'make it <script>alert(1)</script> wider', project: 'p',
    started_at: '2026-10-09T09:00:00.000Z', outcome: 'stopped', ended_in: 'checks', why: 'the agent changed nothing; nothing was rebuilt',
    parameters: { path: PARAMS, created: false, before: { sha256: 'a'.repeat(64), values: { width: 140, wall: 3, supportOffset: 10, bore: 3 } } },
    receipts: {}, child_receipts: [], doctrine: DOCTRINE_15, ...o,
  });
  it('says what to do when there is no flow, and draws a card with every string escaped', () => {
    expect(flowsSection({ list: [], more: 0 }, { live: false, base: '../../' }).html).toContain('No flows yet: /iterate tray &quot;&lt;instruction&gt;&quot;');
    const html = flowsSection({ list: [{ file: 'results/flows/f0123abcd.json', record: record(), check: { status: 'unverified', reasons: ['no flow receipt names this file'] } }], more: 2 }, { live: false, base: '../../' });
    expect(html.toc).toBe('<a href="#flows">Flows <b>3</b></a>');
    expect(html.html).toContain('make it &lt;script&gt;alert(1)&lt;/script&gt; wider');
    expect(html.html).not.toContain('<script>');
    expect(html.html).toContain('no flow receipt names this file');
    expect(html.html).toContain('and 2 more: /iterate');
    // no readback, so no measured values and no section claiming any
    expect(html.html).not.toContain('measured from the CAD file');
  });
  it('a path from a record is a link only inside the project; the live board names files as text', () => {
    const r = record({ rebuild: { state: 'succeeded', outputs: [{ path: '../../etc/x.step', sha256: 'b'.repeat(64), bytes: 1 }, { path: 'https://example.com/a.stl', sha256: 'c'.repeat(64), bytes: 1 }, { path: 'out/recipes/abcd1234/bores.stl', sha256: 'd'.repeat(64), bytes: 1 }] } });
    const f = { file: 'results/flows/f0123abcd.json', record: r, check: { status: 'unverified' as const, reasons: [] } };
    const html = flowsSection({ list: [f], more: 0 }, { live: false, base: '../../' }).html;
    expect(html).toContain('href="../../out/recipes/abcd1234/bores.stl"');
    expect(html.match(/not a project path/g)).toHaveLength(2);
    expect(html).not.toMatch(/href="[^"]*(\.\.\/etc|https)/);
    const live = flowsSection({ list: [f], more: 0 }, { live: true, base: '../../' }).html;
    expect(live).not.toContain('<a ');
    expect(live).toContain('<span class="name">out/recipes/abcd1234/bores.stl</span>');
  });
  it('verified only when a flow receipt of this project sealed exactly these bytes', () => {
    const rc = (o: Record<string, unknown>) => ({ kind: 'flow', project_id: 'pid', hash: 'sha256_0123456789abcdef', outputs: [{ path: 'results/flows/f0123abcd.json', sha256: 'e'.repeat(64), bytes: 1 }], ...o }) as unknown as Receipt;
    expect(checkFlowRecord('results/flows/f0123abcd.json', 'e'.repeat(64), [rc({})], 'pid')).toEqual({ status: 'verified', receipt: '01234567', reasons: [] });
    expect(checkFlowRecord('results/flows/f0123abcd.json', 'f'.repeat(64), [rc({})], 'pid')).toMatchObject({ status: 'unverified', reasons: [expect.stringContaining('changed after it was sealed')] });
    expect(checkFlowRecord('results/flows/f0123abcd.json', 'e'.repeat(64), [rc({ project_id: 'other' })], 'pid')).toMatchObject({ status: 'unverified', reasons: ['no flow receipt names this file'] });
    expect(checkFlowRecord('results/flows/f0123abcd.json', 'e'.repeat(64), [rc({ kind: 'agent' })], 'pid').status).toBe('unverified');
  });
});

describe('/iterate refuses before anything is written', () => {
  it('a paid route, a cloud model, no model, no recipe runtime or an unusable parameter file: nothing written, nothing started', async () => {
    const cases: Array<[Record<string, string | undefined>, string, RegExp]> = [
      [{}, 'tray --paid widen it', /has no --paid/],
      // (round R4, H25: --agent codex is Codex's local route now, tested in tests/codex-local.test.ts; a paid agent is still refused)
      [{}, 'tray widen it --agent opencode', /OpenCode runs on your own account and costs money/],
      [{}, 'tray widen it --model qwen3-coder:480b:cloud', /cloud model[\s\S]*\/iterate runs only a local, free route, and has no --paid/],
      [{ TIMMY_AGENT_BASE_URL: 'https://models.example.com/v1' }, 'tray widen it', /is not this machine[\s\S]*only a local, free route/],
      [{ TIMMY_AGENT_MODEL: undefined }, 'tray widen it', /Name the local model/],
      [{ TIMMY_CADQUERY_PYTHON: undefined }, 'tray widen it', /TIMMY_CADQUERY_PYTHON is not set[\s\S]*the runtime comes first/],
    ];
    for (const [env, line, want] of cases) {
      const { ws, sealed } = make({ env });
      const out = text(await ws.iterate(line));
      expect(out).toMatch(want);
      expect(fs.existsSync(path.join(root, PARAMS))).toBe(false);
      expect(ws.jobs.list()).toEqual([]);
      expect(sealed).toEqual([]);
    }
    fs.mkdirSync(path.join(root, 'recipes'));
    fs.writeFileSync(path.join(root, PARAMS), '{"schema":"timmy.recipe-params/1","recipe":"enclosure.tray/1","parameters":{"width":20}}');
    const { ws } = make();
    const out = text(await ws.iterate('tray widen it'));
    expect(out).toContain(`${PARAMS} is not a usable parameter file`);
    expect(out).toContain('Conflicting tray dimensions');
    expect(ws.jobs.list()).toEqual([]);
    expect(fs.existsSync(path.join(root, '.timmy', 'agents'))).toBe(false);
  });
});

describe('/iterate end to end (FAKE agent, FAKE recipe executor, FAKE readback)', () => {
  it('succeeds: parameter file written from the defaults, agent edit, rebuild, readback matches, record and receipts', async () => {
    const { ws, notes, sealed } = make();
    const out = text(await ws.iterate('tray "make it 180 mm wide PARAM:width=180"'));
    const id = flowIdIn(out);
    expect(id).toMatch(FLOW_ID);
    expect(out).toContain(`${PARAMS}  width 140, wall 3, supportOffset 10, bore 3`);
    expect(out).toContain('it did not exist: written from the recipe card\'s defaults before the agent ran');
    expect(out).toContain('local endpoint, no charge');
    expect(out).toContain(`/stop ${id} stops the flow`);
    noAbsolute(out);
    await until(ended(sealed, id));
    const rec = recordOf(id);
    expect(rec).toMatchObject({ schema: 'timmy.flow/1', id, kind: 'iterate', recipe: 'enclosure.tray/1', instruction: 'make it 180 mm wide PARAM:width=180', outcome: 'succeeded', ended_in: 'readback', doctrine: DOCTRINE_15 });
    // the parameters, before and after, with the diff
    expect(rec.parameters).toMatchObject({ path: PARAMS, created: true, before: { values: { width: 140, wall: 3, supportOffset: 10, bore: 3 } }, after: { values: { width: 180, wall: 3, supportOffset: 10, bore: 3 } } });
    expect(rec.parameters.after!.sha256).toBe(sha(fs.readFileSync(path.join(root, PARAMS))));
    expect(rec.parameters.diff!.filter((d) => d.changed)).toEqual([{ name: 'width', before: 140, after: 180, changed: true }]);
    // R4 (H65): the bytes the agent was given, kept in the flow's folder (read-only), as the script flows keep theirs
    expect(rec.parameters.before.kept).toBe(`.timmy/flows/${id}/params.before.json`);
    expect(sha(fs.readFileSync(path.join(root, rec.parameters.before.kept!)))).toBe(rec.parameters.before.sha256);
    expect(fs.statSync(path.join(root, rec.parameters.before.kept!)).mode & 0o222).toBe(0);
    // the agent step: its run, its route, what it changed with sha256 before and after, its cost and receipt
    expect(rec.agent).toMatchObject({ agent: 'qwen', model: 'qwen3:4b', outcome: 'completed', route: 'local endpoint, no charge', cost_usd: 0, cost_basis: 'local endpoint' });
    expect(rec.agent!.files_changed).toEqual([{ path: PARAMS, how: 'changed', sha256_before: rec.parameters.before.sha256, sha256_after: rec.parameters.after!.sha256 }]);
    expect(fs.existsSync(path.join(root, rec.agent!.transcript!))).toBe(true);
    // the rebuild: the recipe job, its sealed prediction, the delivered outputs with their sha256
    const uuid = rec.rebuild!.operation!;
    expect(status(root, uuid).state).toBe('succeeded');
    expect(rec.rebuild).toMatchObject({ state: 'succeeded', predicted: { bounds_mm: [180, 80, 30] }, parameters_file: { path: PARAMS, sha256: rec.parameters.after!.sha256 } });
    const step = rec.rebuild!.outputs!.find((o) => o.path.endsWith('/console-tray.step'))!;
    expect(step.path).toBe(`out/recipes/${uuid.slice(0, 8)}/console-tray.step`);
    expect(step.sha256).toBe(sha(fs.readFileSync(path.join(root, step.path))));
    expect(rec.rebuild!.outputs!.map((o) => path.basename(o.path)).sort()).toEqual([...EXPORTS, 'prediction.json', 'report.json', 'request.json'].sort());
    // the readback: a separate worker (here the labelled FAKE), the measured values, the verdict with the gate's tolerance
    expect(rec.readback).toMatchObject({ state: 'completed', verdict: 'matches', worker: { name: 'fake-step-readback' }, step: { path: step.path, sha256: step.sha256 }, measured: { bounds_mm: [180, 80, 30], valid: true, solids: 1, sha256: step.sha256 }, tolerance: { bounds_mm: 1e-6, volume_relative: 1e-8 } });
    expect(rec.readback!.checks!.every((c) => c.passed)).toBe(true);
    expect(fs.readFileSync(path.join(root, rec.readback!.log!), 'utf8')).toContain('FAKE readback');
    // the receipts: agent, prediction (sealed before the build), build (the watcher job), readback; then the flow's
    const kinds = sealed.map((r) => r.kind);
    expect(kinds.indexOf('predict')).toBeGreaterThan(kinds.indexOf('agent'));
    expect(kinds.at(-1)).toBe('flow');
    expect(rec.child_receipts).toEqual([rec.receipts.agent, rec.receipts.prediction, rec.receipts.build, rec.receipts.readback]);
    expect(rec.child_receipts.every((r) => typeof r === 'string')).toBe(true);
    const flow = sealed.at(-1)!;
    const body = fs.readFileSync(path.join(root, 'results', 'flows', `${id}.json`));
    expect(flow).toMatchObject({ kind: 'flow', status: 'ok', outputs: [{ path: `results/flows/${id}.json`, sha256: sha(body), bytes: body.length }], child_receipts: rec.child_receipts, cost_usd: 0, files: [{ path: PARAMS, created: true }] });
    const readback = sealed.find((r) => r.kind === 'readback')!;
    expect(readback).toMatchObject({ status: 'ok', sources: [{ path: step.path, sha256: step.sha256, role: 'read' }, { flow: id, verdict: 'matches' }], child_receipts: [rec.receipts.prediction] });
    expect(readback.files).toBeUndefined();
    // what the operator saw, with no absolute path; DOCTRINE §15 with the measured values
    const notice = notes.join('\n');
    expect(notice).toContain(`${id}  agent qwen ${rec.agent!.run} completed: changed ${PARAMS} · width 140 → 180`);
    expect(notice).toContain(`${id}  rebuild: recipe job ${uuid}`);
    expect(notice).toContain(`${id} succeeded: the readback of the delivered STEP matches the sealed prediction`);
    expect(notice).toContain('measured from the CAD file: 180 x 80 x 30 mm');
    expect(notice).toContain(DOCTRINE_15);
    noAbsolute(notice);
    noAbsolute(body.toString('utf8'));
    noAbsolute(JSON.stringify(sealed));
    // /iterate lists it
    expect(text(await ws.iterate(''))).toMatch(new RegExp(`${id}\\s+succeeded width 140 → 180 · readback matches · results/flows/${id}\\.json`));
    // the board: the flow as a card, verified by its flow receipt; measured values labelled, with DOCTRINE §15; files linked
    expect(text(ws.board(''))).toMatch(/Flows 1/);
    const html = fs.readFileSync(path.join(root, '.timmy/board/index.html'), 'utf8');
    expect(html).toContain('<h2 id="flows">Flows <span class="count">1</span></h2>');
    const card = html.match(/<article class="card flow">([\s\S]*?)<\/article>/)![1];
    expect(card).toContain(`<strong>${id}</strong> <span class="state state-succeeded">succeeded</span>`);
    expect(card).toContain('make it 180 mm wide PARAM:width=180');
    expect(card).toContain('status-verified');
    expect(card).toContain('<dt>width</dt><dd><span class="was">140</span> → <strong class="changed">180</strong> <span class="tier">changed</span></dd>');
    expect(card).toContain('<dt>wall</dt><dd>3</dd>');
    expect(card).toContain('measured from the CAD file (the STEP read back in its own process)');
    expect(card).toContain('<dt>bounds</dt><dd>180 x 80 x 30 mm <span class="tier">predicted 180 x 80 x 30 mm</span></dd>');
    expect(card).toContain('matches · within 1e-6 mm and 1e-8 relative of the prediction');
    expect(card).toContain(DOCTRINE_15);
    expect(card).toContain('fake-step-readback 0.0.0-fake (a FAKE readback, not a measurement)');
    const out8 = `out/recipes/${uuid.slice(0, 8)}`;
    for (const f of ['console-tray.step', 'outer.stl', 'cavity.stl', 'bosses.stl', 'bores.stl']) expect(card).toContain(`href="../../${out8}/${f}"`);
    expect(card).toContain(`href="../../${PARAMS}"`);
    expect(card).toContain(`receipts: agent ${rec.receipts.agent} · prediction ${rec.receipts.prediction} · build ${rec.receipts.build} · readback ${rec.receipts.readback} · flow `);
    // the record is shown as a flow, not again as an output
    expect(html.match(new RegExp(`data-cmd="/open results/flows/${id}\\.json"`, 'g'))).toHaveLength(1);
    noAbsolute(html);
    // an edited record is no longer verified: its values are shown as the file says
    const edited = body.toString('utf8').replace(/("measured": \{\s*"bounds_mm": \[\s*)180/, '$1999');
    expect(edited).not.toBe(body.toString('utf8'));
    fs.writeFileSync(path.join(root, 'results', 'flows', `${id}.json`), edited);
    ws.board('');
    const after = fs.readFileSync(path.join(root, '.timmy/board/index.html'), 'utf8').match(/<article class="card flow">([\s\S]*?)<\/article>/)![1];
    expect(after).toContain('status-unverified');
    expect(after).toContain('the file changed after it was sealed');
    expect(after).toContain('measured from the CAD file, as the record says (not verified)');
    expect(after).toContain('999 x 80 x 30 mm');
    expect(after).toContain(DOCTRINE_15);
    expect(after).not.toContain('<section class="measured readback">');
  }, 120000);

  it('the agent changes another file: stopped before the build, the files listed, nothing reverted', async () => {
    const { ws, sealed } = make();
    const id = flowIdIn(text(await ws.iterate('tray "PARAM:width=180 OTHERFILE"')));
    await until(ended(sealed, id));
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'stopped', ended_in: 'checks' });
    expect(rec.why).toBe(`the agent changed files other than ${PARAMS}: notes/other.txt (added); nothing was built, and nothing was reverted; the agent's output is kept: ${rec.agent!.transcript}`);
    expect(rec.agent!.others).toEqual([{ path: 'notes/other.txt', how: 'added', sha256_after: sha(fs.readFileSync(path.join(root, 'notes/other.txt'))) }]);
    expect(fs.existsSync(path.join(root, 'notes/other.txt'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, PARAMS), 'utf8')).parameters.width).toBe(180);
    expect(recipeJobs()).toEqual([]);
    expect(rec.rebuild).toBeUndefined();
    expect(sealed.map((r) => r.kind)).toEqual(['agent', 'flow']);
    expect(sealed.at(-1)).toMatchObject({ status: 'failed', child_receipts: [rec.receipts.agent] });
  }, 90000);

  it('an invalid parameter file stops the flow with the reason; the file and the agent\'s output are kept', async () => {
    const { ws, sealed } = make();
    const id = flowIdIn(text(await ws.iterate('tray "make it tiny PARAMSBAD"')));
    await until(ended(sealed, id));
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'stopped', ended_in: 'checks', parameters: { invalid: { error: expect.stringContaining('Conflicting tray dimensions') } } });
    expect(rec.why).toContain(`${PARAMS} as the agent left it is not valid: Conflicting tray dimensions`);
    expect(rec.why).toContain('it is left as the agent wrote it; nothing was rebuilt');
    expect(JSON.parse(fs.readFileSync(path.join(root, PARAMS), 'utf8')).parameters.width).toBe(5);
    expect(fs.existsSync(path.join(root, rec.agent!.transcript!))).toBe(true);
    expect(recipeJobs()).toEqual([]);
  }, 90000);

  it('no change: "the agent changed nothing; nothing was rebuilt"', async () => {
    fs.mkdirSync(path.join(root, 'recipes'));
    fs.writeFileSync(path.join(root, PARAMS), '{"schema":"timmy.recipe-params/1","recipe":"enclosure.tray/1","parameters":{"width":150}}\n');
    const { ws, sealed } = make();
    const out = text(await ws.iterate('tray "keep it as it is"'));
    expect(out).not.toContain('did not exist');
    const id = flowIdIn(out);
    await until(ended(sealed, id));
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'stopped', ended_in: 'checks', why: 'the agent changed nothing; nothing was rebuilt', parameters: { created: false, before: { values: { width: 150 } } } });
    expect(recipeJobs()).toEqual([]);
  }, 90000);

  it('the recipe job fails: the flow failed, the raw failure kept and named; no readback', async () => {
    const { ws, sealed } = make({ recipe: 'reported-failure' });
    const id = flowIdIn(text(await ws.iterate('tray "PARAM:width=160"')));
    await until(ended(sealed, id));
    const rec = recordOf(id);
    const uuid = rec.rebuild!.operation!;
    expect(rec).toMatchObject({ outcome: 'failed', ended_in: 'build', rebuild: { state: 'failed' } });
    expect(rec.rebuild!.failure_files).toEqual(expect.arrayContaining([`.timmy/recipe-jobs/${uuid}/worker.log`, expect.stringMatching(/recipe-runs\/[0-9a-f-]{36}\/native\.log$/)]));
    for (const f of rec.rebuild!.failure_files!) expect(fs.existsSync(path.join(root, f))).toBe(true);
    expect(rec.why).toContain(`recipe job ${uuid} failed`);
    expect(rec.why).toContain('kept: .timmy/recipe-jobs/');
    expect(rec.readback).toBeUndefined();
    expect(sealed.find((r) => r.kind === 'readback')).toBeUndefined();
    expect(sealed.at(-1)).toMatchObject({ kind: 'flow', status: 'failed' });
  }, 120000);

  it('the readback differs from the prediction: verdict differs with the numbers, not a success', async () => {
    const { ws, notes, sealed } = make({ readback: 'differ' });
    const id = flowIdIn(text(await ws.iterate('tray "PARAM:width=180"')));
    await until(ended(sealed, id));
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'differs', ended_in: 'readback', readback: { verdict: 'differs', measured: { bounds_mm: [180.5, 80, 30] } } });
    expect(rec.readback!.checks!.find((c) => c.name === 'bounds x (mm)')).toMatchObject({ predicted: 180, measured: 180.5, passed: false });
    expect(rec.why).toContain('the readback differs from the sealed prediction: bounds x (mm): measured 180.5, predicted 180');
    expect(sealed.find((r) => r.kind === 'readback')).toMatchObject({ status: 'failed', discrepancies: ['bounds x (mm): measured 180.5, predicted 180'] });
    expect(sealed.at(-1)).toMatchObject({ kind: 'flow', status: 'failed' });
    expect(notes.join('\n')).toContain(`${id} differs`);
    expect(notes.join('\n')).toContain(DOCTRINE_15);
  }, 120000);

  it('a readback that fails or reads other bytes: verdict failed, its output kept', async () => {
    for (const mode of ['fail', 'wrongbytes'] as const) {
      const { ws, sealed } = make({ readback: mode });
      // each flow changes the width again (the second starts from the first one's file)
      const id = flowIdIn(text(await ws.iterate(`tray "PARAM:width=${mode === 'fail' ? 170 : 175}"`)));
      await until(ended(sealed, id));
      const rec = recordOf(id);
      expect(rec).toMatchObject({ outcome: 'failed', ended_in: 'readback', readback: { verdict: 'failed' } });
      expect(rec.readback!.reason).toMatch(mode === 'fail' ? /^not-step: FAKE: OpenCascade could not read the file as STEP/ : /read bytes other than the delivered STEP/);
      expect(fs.readFileSync(path.join(root, rec.readback!.log!), 'utf8')).toContain('FAKE readback');
    }
  }, 180000);
});

describe('iterate_recipe, the agent\'s tool (FAKE pieces)', () => {
  it('asks each time; starts the same flow as /iterate, answered as data (started, not finished); refusals as data', async () => {
    expect(approvalNeeded('iterate_recipe', { recipe: 'enclosure.tray/1', instruction: 'make it 180 mm wide' })).toEqual({
      reason: 'starts a local code agent that may change recipes/tray.params.json, then rebuilds the CAD tray and reads it back on this machine', summary: 'make it 180 mm wide', session: false,
    });
    expect(replTools(undefined, undefined, { iterate: { start: async () => ({}) } }).map((t) => (t as unknown as { function: { name: string } }).function.name)).toContain('iterate_recipe');
    expect(recipeCapabilityRow({}).tools).toContain('iterate_recipe');
    const { ws, sealed } = make();
    const [tool] = createIterateTools({ start: (i) => ws.iterateForTool(i) });
    const exec = (tool as unknown as { function: { execute: (i: unknown) => Promise<Record<string, any>> } }).function.execute;
    const started = await exec({ recipe: 'enclosure.tray/1', instruction: 'make it 180 mm wide PARAM:width=180' });
    expect(started).toMatchObject({ ok: true, flow: expect.stringMatching(FLOW_ID), agent_job: expect.stringMatching(/^j[0-9a-f]{6}$/), parameters_file: { path: PARAMS, written_from_defaults: true }, record_when_done: `results/flows/${started.flow}.json`, doctrine: DOCTRINE_15 });
    expect(started.note).toContain('Started, not finished');
    await until(ended(sealed, started.flow));
    expect(recordOf(started.flow)).toMatchObject({ outcome: 'succeeded', instruction: 'make it 180 mm wide PARAM:width=180' });
    const bare = make({ env: { TIMMY_AGENT_MODEL: undefined } });
    const [t2] = createIterateTools({ start: (i) => bare.ws.iterateForTool(i) });
    const refused = await (t2 as unknown as { function: { execute: (i: unknown) => Promise<Record<string, any>> } }).function.execute({ recipe: 'enclosure.tray/1', instruction: 'wider' });
    expect(refused).toMatchObject({ ok: false, started: false, error: expect.stringContaining('Name the local model') });
  }, 120000);
});

describe('/stop stops the flow (FAKE pieces)', () => {
  it('during the agent step: the agent\'s job is cancelled, nothing is built', async () => {
    const { ws, sealed } = make();
    const out = text(await ws.iterate('tray "SLEEP PARAM:width=180"'));
    const id = flowIdIn(out);
    const agent = agentJobIn(out);
    await until(() => (ws.jobs.get(agent)?.pid ?? 0) > 0);
    // one flow at a time in a project: a second is refused while this one runs
    expect(text(await ws.iterate('tray "PARAM:width=200"'))).toContain(`Flow ${id} is still running in this project (its agent step)`);
    expect(ws.jobs.list()).toHaveLength(1);
    const stopped = text(await ws.stop(id));
    expect(stopped).toContain(`${id} cancelled`);
    expect(stopped).toContain('stopped with /stop during the agent step; nothing was built');
    expect(ws.jobs.get(agent)!.state).toBe('cancelled');
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'cancelled', ended_in: 'agent', agent: { outcome: 'cancelled' } });
    expect(recipeJobs()).toEqual([]);
    expect(sealed.at(-1)).toMatchObject({ kind: 'flow', status: 'cancelled' });
    expect(text(await ws.stop(id))).toContain(`${id} already ended (cancelled)`);
  }, 90000);

  it('during the build: the recipe\'s own cancel first, then the watcher; the recipe job ends cancelled, run once', async () => {
    const { ws, sealed } = make({ recipe: 'wait' });
    const id = flowIdIn(text(await ws.iterate('tray "PARAM:width=180"')));
    await until(() => recipeJobs().length === 1 && fs.existsSync(path.join(jobDirectory(root, recipeJobs()[0]), 'executions.txt')), 90000);
    const uuid = recipeJobs()[0];
    const stopped = text(await ws.stop(id));
    expect(stopped).toContain(`${id} cancelled`);
    expect(fs.existsSync(path.join(jobDirectory(root, uuid), 'cancel.json'))).toBe(true);
    expect(status(root, uuid).state).toBe('cancelled');
    expect(fs.readFileSync(path.join(jobDirectory(root, uuid), 'executions.txt'), 'utf8').trim().split('\n')).toHaveLength(1);
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'cancelled', ended_in: 'build', rebuild: { operation: uuid, state: 'cancelled' } });
    expect(rec.why).toContain(`stopped with /stop during the build: recipe job ${uuid} cancelled`);
    expect(rec.readback).toBeUndefined();
    expect(sealed.at(-1)).toMatchObject({ kind: 'flow', status: 'cancelled' });
  }, 120000);

  it('during the readback: its job is cancelled, no verdict; /stop all reaches a flow too', async () => {
    const { ws, sealed } = make({ readback: 'sleep' });
    const id = flowIdIn(text(await ws.iterate('tray "PARAM:width=180"')));
    await until(() => ws.jobs.list().some((j) => j.label.startsWith('readback ') && j.state === 'running' && (j.pid ?? 0) > 0), 90000);
    const job = ws.jobs.list().find((j) => j.label.startsWith('readback '))!;
    expect(job.label).toContain(`flow ${id}`);
    const stopped = text(await ws.stop(id));
    expect(stopped).toContain(`${id} cancelled`);
    expect(ws.jobs.get(job.id)!.state).toBe('cancelled');
    const rec = recordOf(id);
    expect(rec).toMatchObject({ outcome: 'cancelled', ended_in: 'readback', readback: { state: 'cancelled', job: job.id } });
    expect(rec.readback!.verdict).toBeUndefined();
    expect(sealed.find((r) => r.kind === 'readback')).toMatchObject({ status: 'cancelled' });
    // /stop all: a second flow, stopped in its agent step
    const out = text(await ws.iterate('tray "SLEEP"'));
    const second = flowIdIn(out);
    await until(() => (ws.jobs.get(agentJobIn(out))?.pid ?? 0) > 0);
    const all = text(await ws.stop('all'));
    expect(all).toContain(`Flows (/iterate): ${second} cancelled; none starts a next step, and each keeps its record in results/flows/.`);
    expect(recordOf(second)).toMatchObject({ outcome: 'cancelled', ended_in: 'agent' });
  }, 150000);
});

// ── the real readback worker ─────────────────────────────────────────────────────

const python3 = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0 ? 'python3' : null;
const run = (py: string, args: string[]) => {
  const r = spawnSync(py, [READBACK_SCRIPT, ...args], { encoding: 'utf8', timeout: 120000 });
  const line = r.stdout.trim().split('\n').at(-1) ?? '';
  return { status: r.status, json: JSON.parse(line) as Record<string, any> };
};

describe.skipIf(!python3)('workers/readback/step_readback.py, the real worker, with this machine\'s python3', () => {
  it('says what is wrong in one JSON line: a usage error (64), a missing file (2), and no OCP here (3) after hashing the file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readback-'));
    try {
      const usage = run(python3!, []);
      expect(usage.status).toBe(64);
      expect(usage.json).toMatchObject({ ok: false, worker: { name: 'timmy-step-readback', version: '0.1.0' }, error: { code: 'usage' } });
      expect(run(python3!, [path.join(dir, 'missing.step')])).toMatchObject({ status: 2, json: { ok: false, error: { code: 'unreadable' } } });
      const step = path.join(dir, 'a.step');
      fs.writeFileSync(step, 'ISO-10303-21; not really a STEP file\n');
      const hasOcp = spawnSync(python3!, ['-c', 'import OCP'], { encoding: 'utf8' }).status === 0;
      const r = run(python3!, [step, '--as', 'out/a.step']);
      if (hasOcp) expect(r.json).toMatchObject({ ok: false, error: { code: 'not-step' } });
      else {
        expect(r.status).toBe(3);
        expect(r.json).toMatchObject({ ok: false, error: { code: 'no-ocp' }, source: { name: 'out/a.step', sha256: sha(fs.readFileSync(step)), bytes: fs.statSync(step).size } });
      }
      // what the worker printed reads as a failure, with its reason
      expect(parseReadbackOutput(JSON.stringify(r.json))).toMatchObject({ ok: false });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

const cadPython = process.env.TIMMY_CADQUERY_PYTHON;
const cadReady = !!cadPython && path.isAbsolute(cadPython) && fs.existsSync(cadPython) && spawnSync(cadPython, ['-c', 'import cadquery, OCP'], { encoding: 'utf8' }).status === 0;
if (!cadReady) {
  // eslint-disable-next-line no-console
  console.log(`[iterate.test] the real STEP readback is skipped: ${cadPython ? 'TIMMY_CADQUERY_PYTHON cannot import cadquery and OCP' : 'TIMMY_CADQUERY_PYTHON is not set'} (it needs a Python with CadQuery)`);
}

describe.skipIf(!cadReady)('workers/readback/step_readback.py on a real STEP (TIMMY_CADQUERY_PYTHON with CadQuery)', () => {
  it('reads a CadQuery box back in its own process: one valid solid, its bounds and volume, the sha256 of its bytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readback-real-'));
    try {
      const step = path.join(dir, 'box.step');
      const made = spawnSync(cadPython!, ['-c', `import cadquery as cq; cq.exporters.export(cq.Workplane("XY").box(180, 80, 30), ${JSON.stringify(step)})`], { encoding: 'utf8', timeout: 120000 });
      expect(made.status, made.stderr).toBe(0);
      const r = run(cadPython!, [step, '--as', 'box.step']);
      expect(r.status, JSON.stringify(r.json)).toBe(0);
      const parsed = parseReadbackOutput(JSON.stringify(r.json));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.source.sha256).toBe(sha(fs.readFileSync(step)));
      expect(compareReadback({ bounds: [180, 80, 30], volume: 180 * 80 * 30 }, parsed).verdict).toBe('matches');
      expect(compareReadback({ bounds: [181, 80, 30], volume: 180 * 80 * 30 }, parsed).verdict).toBe('differs');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 180000);
});
