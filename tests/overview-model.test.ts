/**
 * Round R4 (helper H78): Timmy God's Eye View's model (src/overview) and `/overview`, from records the real writers made in
 * an os.tmpdir() project: a REPL Workspace on the project's own REAL receipts chain (tests/helpers/ops-sandbox.ts) ran
 * `/measure` (Timmy's own STL reader, real), `/iterate scad` (a flow, its agent run, an OpenSCAD run, an operation, their
 * receipts), `/run` of a workflow whose second block fails, and `/lesson add` (a draft lesson: something waiting on you).
 *
 * FAKE pieces, labelled where they are used: the code agent (tests/fixtures/fake-code-agent.mjs) and OpenSCAD
 * (tests/fixtures/fake-openscad.mjs) are TEST DOUBLES with no model and no geometry engine; upmd is the TEST DOUBLE
 * tests/fixtures/fake-upmd.mjs (its blocks run for real through sh). The cube STL is generated here. Nothing leaves this
 * machine; every folder is under os.tmpdir() and is removed when the tests end.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeJson, runDir, type AgentRunRecord } from '../src/code-agents/index.js';
import { writeOperationRecord, OPERATION_SCHEMA } from '../src/ops/operations.js';
import { buildOverview, MAP_LABEL, OVERVIEW_SCHEMA, OVERVIEW_SECTIONS, type Overview } from '../src/overview/index.js';
import { projectId } from '../src/project/index.js';
import { overviewFirstLines, overviewLines } from '../src/repl/overview.js';
import { glyphSet } from '../src/term/glyphs.js';
import { appendReceipt, readChain, type ReceiptInput } from '../src/utils/receipts.js';
import { act, opsKit, REPO, replOf, sandbox, text, type Sandbox } from './helpers/ops-sandbox.js';
import { cubeStl } from './helpers/vox-fakes.js';

const kit = opsKit();
const F = '```';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const g = glyphSet(true);
const plain = (lines: Array<Array<{ text: string }>>): string[] => lines.map((l) => l.map((x) => x.text).join(''));
async function until(what: string, pred: () => boolean, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 50)); }
}
/** The project's own stores, as the REPL of the sandbox uses them. */
const stores = (s: Sandbox) => ({ jobsDir: path.join(s.home, 'timmy', 'jobs'), store: path.join(s.root, '.timmy', 'receipts'), env: { TIMMY_HOME: path.join(s.home, 'timmy') } });

describe("God's Eye View from the records the real writers made (FAKE agent, OpenSCAD and upmd, labelled)", () => {
  let s: Sandbox;
  let o: Overview;
  let repl: Overview;
  let flow: string;
  let lesson: string;

  beforeAll(async () => {
    s = sandbox(kit, 'overview-');
    const { ws } = replOf(kit, s);
    // VoxVision: /measure on a generated cube, read by Timmy's own STL reader (real), sealed on the real chain.
    fs.mkdirSync(path.join(s.root, 'models'), { recursive: true });
    fs.writeFileSync(path.join(s.root, 'models', 'cube.stl'), cubeStl(10));
    await ws.operate('/measure models/cube.stl', 'repl', () => ws.measure('models/cube.stl'));
    await (ws as unknown as { vox: { settle(ms: number): Promise<void> } }).vox.settle(30_000);
    // A flow: /iterate scad with the FAKE code agent and the FAKE OpenSCAD (width 60 -> 100).
    const instruction = 'make it 100 wide PYFILE:box.params.json PYREPLACE:60,=>100,';
    const out = text(await ws.operate(`/iterate scad box.scad "${instruction}"`, 'repl', () => ws.iterate(`scad box.scad "${instruction}"`)));
    flow = /\b(f[0-9a-f]{8})\b/.exec(out)?.[1] ?? '';
    expect(flow, out).toMatch(/^f[0-9a-f]{8}$/);
    await ws.ops.done(ws.ops.latest!);
    // A workflow whose second block fails, run through the TEST DOUBLE upmd (its blocks run for real through sh).
    fs.writeFileSync(path.join(s.root, 'WORK.md'), ['# Work', '', `${F}bash [name:first]`, 'echo first', F, '', `${F}bash [name:broken, deps:first]`, 'echo broken; exit 3', F, ''].join('\n'));
    await ws.operate('/run WORK.md broken', 'repl', () => ws.run('WORK.md broken'));
    await until('the workflow run to end', () => ws.jobs.list().some((j) => j.kind === 'workflow' && ['completed', 'failed', 'cancelled'].includes(j.state)));
    // Memory: a draft lesson from the flow's record (it waits on you: check it).
    const added = text(await ws.operate(`/lesson add "the box is 100 wide" --from results/flows/${flow}.json`, 'repl', () => ws.lesson(`add "the box is 100 wide" --from results/flows/${flow}.json`)));
    lesson = /\b(l[0-9a-f]{8})\b/.exec(added)?.[1] ?? '';
    expect(lesson, added).toMatch(/^l[0-9a-f]{8}$/);
    // Outside a REPL (as Timmy Canvas would read it), and through the REPL's own /overview --json.
    o = buildOverview(s.root, { name: 'project', ...stores(s) });
    repl = JSON.parse(text(await ws.overview('--json'))) as Overview;
  }, 240_000);
  afterAll(() => kit.cleanup(), 60_000);

  it('is one JSON model with every section, each with its as_of, its counts and no absolute path', () => {
    expect(o.schema).toBe(OVERVIEW_SCHEMA);
    expect(JSON.parse(JSON.stringify(o))).toEqual(o);
    for (const id of OVERVIEW_SECTIONS) {
      expect(o[id].as_of, id).toMatch(ISO);
      expect(['read', 'partial', 'unknown'], id).toContain(o[id].state);
      for (const c of o[id].counts) { expect(Number.isInteger(c.n), `${id}: ${c.of}`).toBe(true); expect(c.of.length, id).toBeGreaterThan(3); }
    }
    const json = JSON.stringify(o) + JSON.stringify(repl);
    for (const p of new Set([s.base, s.root, s.home, os.tmpdir(), os.homedir()])) expect(json).not.toContain(p);
    expect(o.project.project_id).toBe(projectId(s.root));
    expect(o.project.changed.at).toMatch(ISO);
  });

  it('lists what needs you, the same list as Waiting on you: the draft lesson, with its record and the command that checks it', () => {
    const item = o.needs.items.find((i) => i.title.includes(lesson));
    expect(item, JSON.stringify(o.needs, null, 1)).toBeDefined();
    expect(item!.kind).toBe('lesson');
    expect(item!.source).toMatchObject({ record: `.timmy/memory/lessons/${lesson}.json`, command: `/lesson check ${lesson}`, board: 'room-decisions' });
    expect(o.needs.total).toBeGreaterThanOrEqual(1);
    expect(o.needs.urgent).toBeDefined();
    // The REPL's own overview reads the same list.
    expect(repl.needs.items.map((i) => i.title)).toEqual(o.needs.items.map((i) => i.title));
  });

  it('shows each agent run and flow with its assignment in its own words, its route, its handoffs and its cost as recorded', () => {
    const f = o.agents.items.find((a) => a.id === flow)!;
    expect(f, JSON.stringify(o.agents.items.map((a) => a.id))).toBeDefined();
    expect(f.kind).toBe('flow');
    expect(f.assignment).toEqual({ text: 'make it 100 wide PYFILE:box.params.json PYREPLACE:60,=>100,', from: `its instruction, in results/flows/${flow}.json` });
    expect(f.life).toBe('ended');
    expect(f.handoffs.map((h) => h.state.split(':')[0])).toEqual(expect.arrayContaining(['agent', 'openscad']));
    expect(f.source).toMatchObject({ record: `results/flows/${flow}.json`, command: `/room ${flow}`, board: 'room' });
    const a = o.agents.items.find((x) => x.kind === 'agent')!;
    expect(a.assignment?.from).toBe(`its task, in .timmy/agents/${a.id}/run.json`);
    expect(a.assignment?.text).toContain('make it 100 wide');
    expect(a.route).toBe('local endpoint, no charge');
    // Free on a local endpoint, as its record says: a recorded 0, never an unknown made 0.
    expect(a.cost).toMatchObject({ kind: 'free', usd: 0 });
    expect(a.handoffs.some((h) => h.state === `the agent step of flow ${flow}`)).toBe(true);
    expect(o.agents.counts.find((c) => /running/.test(c.of))?.n).toBe(0);
    expect(o.agents.operations.length).toBeGreaterThan(0);
  });

  it('shows each workflow with its blocks in run order, the last run\'s state of each, and a failed block as its blocker', () => {
    const w = o.workflows.items.find((x) => x.doc === 'WORK.md')!;
    expect(w, JSON.stringify(o.workflows)).toBeDefined();
    expect(w.blocks.map((b) => [b.name, b.needs])).toEqual([['first', []], ['broken', ['first']]]);
    expect(w.last_run?.blocks.map((b) => `${b.name} ${b.word}`)).toEqual(['first completed', 'broken failed']);
    expect(w.last_run?.life).toBe('ended');
    expect(w.blockers[0]).toMatchObject({ block: 'broken' });
    expect(w.blockers[0].why).toMatch(/^failed in run j[0-9a-f]{6} \(exit 3\)$/);
    expect(w.source).toEqual({ record: 'WORK.md', command: '/workflows WORK.md', board: 'workflows' });
    expect(o.workflows.urgent?.text).toContain('WORK.md › broken');
  });

  it('shows the native app runs with their verdicts, the files they made by kind and editor, and the results to review', () => {
    const scad = o.apps.runs.find((r) => r.kind === 'native')!;
    expect(scad, JSON.stringify(o.apps.runs)).toBeDefined();
    expect(scad.app).toMatch(/OpenSCAD/);
    expect(scad.source.command).toBe(`/room ${scad.id}`);
    const params = o.apps.artifacts.find((a) => a.path === 'box.params.json');
    expect(params, JSON.stringify(o.apps.artifacts)).toMatchObject({ kind: 'editable' });
    const stl = o.apps.artifacts.find((a) => /\.stl$/.test(a.path) && a.path.startsWith('out/'));
    expect(stl).toMatchObject({ kind: 'export' });
    expect(stl!.source.command).toBe(`/measure ${stl!.path}`);
    // The kinds are listed editable first.
    const order = o.apps.artifacts.map((a) => a.kind);
    expect(order.indexOf('editable')).toBeLessThan(order.lastIndexOf('export'));
    const result = o.apps.results.find((r) => r.changes > 0);
    expect(result?.source.command).toMatch(/^\/review o[0-9a-f]{8}$/);
    expect(result?.source.board).toBe('review');
  });

  it('shows the VoxVision record with its values labelled exactly as the record labels them, and its geometry highlight', () => {
    const v = o.spatial.items.find((i) => i.action === 'measure')!;
    expect(v, JSON.stringify(o.spatial)).toBeDefined();
    expect(v.check).toBe('verified');
    expect(v.metrics.length).toBeGreaterThan(0);
    for (const m of v.metrics) expect(['measured', 'estimated', 'unknown', 'CAD checked', 'model prediction', 'stale']).toContain(m.word);
    expect(v.metrics.some((m) => m.word === 'measured')).toBe(true);
    const h = v.highlights.find((x) => x.shown);
    expect(h).toMatchObject({ from: 'geometry', label: `geometry from ${v.file}` });
    expect(v.source).toMatchObject({ record: v.file, command: `/open ${v.file}`, board: 'voxvision' });
    expect(v.viewer).toBe(`/vox view ${v.id}`);
  });

  it('shows the receipts with the chain head verified by the existing verifier, and the costs as recorded', () => {
    const chain = readChain('runs', s.root);
    expect(o.history.receipts.known).toBe(true);
    expect(o.history.receipts.project).toBe(chain.filter((r) => r.project_id === projectId(s.root)).length);
    expect(o.history.head).toMatchObject({ id: chain.at(-1)!.hash.slice(7, 15), verified: true, source: { command: 'timmy verify' } });
    // Only free local runs here: no reported amount, so no sum (never a made-up $0), nothing unknown.
    expect(o.history.costs.reported).toBeUndefined();
    expect(o.history.costs.unknown.runs).toBe(0);
    expect(o.history.costs.free.runs).toBeGreaterThanOrEqual(1);
    expect(o.history.lessons.draft).toBe(1);
  });

  it('draws an abstract map, labelled as a layout and not geometry, whose links are the ones the records name', () => {
    expect(o.map.label).toBe(MAP_LABEL);
    expect(MAP_LABEL).toBe('layout, not geometry');
    const agent = o.agents.items.find((x) => x.kind === 'agent')!;
    expect(o.map.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: `a:${agent.id}`, to: `w:${flow}` })]));
    expect(o.map.edges.some((e) => e.from === `w:${flow}` && e.to === 'f:box.params.json')).toBe(true);
    for (const e of o.map.edges) expect(e.why.length).toBeGreaterThan(10);
  });

  it('/overview fits 80 columns and about 25 lines, what needs you first; a section and --all in full', () => {
    const first = plain(overviewFirstLines(o, { glyphs: g }));
    expect(first.length).toBeLessThanOrEqual(25);
    for (const l of first) expect(Array.from(l).length, l).toBeLessThanOrEqual(80);
    expect(first[1]).toMatch(/^ {2}Needs you {3}/);
    expect(first.slice(1).map((l) => l.slice(2, 13).trim())).toEqual(['Needs you', '', 'Agents', 'Workflows', 'Apps', 'Spatial', 'History', 'Project', 'Map', 'In full']);
    expect(first[2].trim()).toBe(o.needs.urgent!.source.command);
    // Narrower: still within the width.
    for (const l of plain(overviewFirstLines(o, { glyphs: g, width: 60 }))) expect(Array.from(l).length, l).toBeLessThanOrEqual(60);
    const agents = plain(overviewLines(o, 'agents', { glyphs: g })).join('\n');
    expect(agents).toContain(`asked   make it 100 wide`);
    expect(agents).toContain(`/room ${flow}`);
    const all = plain(overviewLines(o, '--all', { glyphs: g })).join('\n');
    for (const t of ['NEEDS YOU', 'AGENTS', 'WORKFLOWS', 'APPS', 'SPATIAL', 'HISTORY', 'PROJECT', 'MAP']) expect(all).toContain(`  ${t}`);
    expect(all).toContain(MAP_LABEL);
    expect(plain(overviewLines(o, 'nonsense', { glyphs: g }))).toEqual(['  Usage: /overview [needs|agents|workflows|apps|spatial|history|project|map] [--all] [--json]']);
    // --json prints the model itself.
    expect(JSON.parse(plain(overviewLines(o, '--json', { glyphs: g })).join('\n'))).toEqual(o);
  });

  it("the REPL's /overview and the overview read outside it agree on what they read", () => {
    expect(repl.schema).toBe(OVERVIEW_SCHEMA);
    expect(repl.agents.items.map((a) => `${a.kind}:${a.id}:${a.life}`).sort()).toEqual(o.agents.items.map((a) => `${a.kind}:${a.id}:${a.life}`).sort());
    expect(repl.workflows.items.map((w) => w.doc)).toEqual(o.workflows.items.map((w) => w.doc));
    expect(repl.spatial.items.map((v) => `${v.id}:${v.check}`)).toEqual(o.spatial.items.map((v) => `${v.id}:${v.check}`));
    expect(repl.history.head?.id).toBe(o.history.head?.id);
    // Outside a REPL it says what only a REPL holds; the REPL's own does not.
    expect(o.notes.join(' ')).toMatch(/Read outside a REPL/);
    expect(repl.notes.join(' ')).not.toMatch(/Read outside a REPL/);
  });

  it("timmy act '/overview --json' --json (the real CLI as a child process) carries the same model in its lines", async () => {
    const run = act(kit, s, ['/overview --json', '--json']);
    const done = await run.done;
    expect(done.code, done.stderr).toBe(0);
    const res = JSON.parse(done.stdout) as { outcome: string; lines: string[] };
    expect(res.outcome).toBe('answered');
    const model = JSON.parse(res.lines.join('\n')) as Overview;
    expect(model.schema).toBe(OVERVIEW_SCHEMA);
    expect(model.workflows.items.map((w) => w.doc)).toEqual(['WORK.md']);
    expect(model.needs.items.some((i) => i.title.includes(lesson))).toBe(true);
  }, 120_000);
});

describe('honesty: a gone owner, an unreadable record, a missing cost', () => {
  const dirs: string[] = [];
  const children: ChildProcess[] = [];
  const groups: number[] = [];
  afterAll(() => {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
    for (const pg of groups) { try { process.kill(-pg, 'SIGKILL'); } catch { /* gone */ } }
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });
  const temp = (prefix: string): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); dirs.push(d); return d; };
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); } catch { return false; }
    try { return !/^\S+ \(.*\) [ZX] /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; }
  };

  it('a job whose REPL ended while it runs is "left", and "stale" once its process is gone too; never "running"', async () => {
    const base = temp('overview-gone-');
    const root = path.join(base, 'project');
    const jobsDir = path.join(base, 'jobs');
    fs.mkdirSync(root, { recursive: true });
    // A REAL child process stands in for a REPL: it starts one real job through Timmy's own job manager, then is killed with
    // SIGKILL (never closed), as a crashed REPL is. The job's process group goes on running.
    const script = path.join(base, 'owner.mjs');
    fs.writeFileSync(script, [
      "// A stand-in REPL for tests/overview-model.test.ts: it starts one real job and waits to be killed.",
      "import fs from 'node:fs';",
      'const [jobsDir, root, idFile, mod] = process.argv.slice(2);',
      'const { JobManager } = await import(mod);',
      'const jm = new JobManager({ dir: jobsDir });',
      "const job = jm.start({ kind: 'task', label: 'a long task for the overview test', project: 'project', root, command: 'sleep', args: ['120'] });",
      'for (let i = 0; i < 100 && !jm.get(job.id)?.pid; i++) await new Promise((r) => setTimeout(r, 50));',
      "fs.writeFileSync(idFile + '.tmp', JSON.stringify(jm.get(job.id)));",
      "fs.renameSync(idFile + '.tmp', idFile);",
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    const idFile = path.join(base, 'job.json');
    const owner = spawn(process.execPath, ['--import', 'tsx', script, jobsDir, root, idFile, pathToFileURL(path.join(REPO, 'src', 'jobs', 'index.ts')).href], { cwd: REPO, stdio: 'ignore' });
    children.push(owner);
    await until('the stand-in REPL to start its job', () => fs.existsSync(idFile), 60_000);
    const job = JSON.parse(fs.readFileSync(idFile, 'utf8')) as { id: string; pid: number; owner: { pid: number; startedAt: string } };
    groups.push(job.pid);
    expect(job.owner.pid).toBe(owner.pid);
    expect(alive(job.pid)).toBe(true);
    // Its operation, through the operations module's own writer, naming that same process as the one that writes it.
    expect(writeOperationRecord(root, {
      schema: OPERATION_SCHEMA, id: 'o0a1b2c3d', request: '/run a long task', via: 'repl', project: 'project', started: job.owner.startedAt, ended: null,
      state: 'running', parent: null, runs: [{ kind: 'job', id: job.id, at: job.owner.startedAt }], owner: { pid: job.owner.pid, started: job.owner.startedAt },
    }).ok).toBe(true);
    // While the stand-in runs: running, proven.
    const before = buildOverview(root, { name: 'project', jobsDir, store: null, env: { TIMMY_HOME: path.join(base, 'home') } });
    expect(before.workflows.jobs.find((j) => j.id === job.id)?.life).toBe('running');
    expect(before.history.operations).toMatchObject({ running: 1, left: 0 });
    // The REPL dies (SIGKILL), and is reaped: its job's process group goes on.
    const exited = new Promise((r) => owner.once('exit', r));
    owner.kill('SIGKILL');
    await exited;
    expect(alive(job.pid)).toBe(true);
    const left = buildOverview(root, { name: 'project', jobsDir, store: null, env: { TIMMY_HOME: path.join(base, 'home') } });
    const item = left.workflows.jobs.find((j) => j.id === job.id)!;
    expect(item.life).toBe('left');
    expect(item.life_why).toMatch(/still runs in its own process group \d+, and the Timmy that started it has ended/);
    expect(left.history.operations).toMatchObject({ running: 0, left: 1 });
    const op = left.agents.operations.find((x) => x.id === 'o0a1b2c3d');
    expect(op?.life).toBe('left');
    expect(left.workflows.urgent?.text).toContain(`job ${job.id}`);
    const shown = plain(overviewLines(left, 'workflows', { glyphs: g })).join('\n');
    expect(shown).toContain(`${job.id}  left running`);
    expect(shown).not.toMatch(new RegExp(`${job.id}\\s+running`));
    // Its process group is killed too: stale (its process is gone), still never running.
    process.kill(-job.pid, 'SIGKILL');
    await until('the job\'s process to be gone', () => !alive(job.pid), 20_000);
    const stale = buildOverview(root, { name: 'project', jobsDir, store: null, env: { TIMMY_HOME: path.join(base, 'home') } });
    expect(stale.workflows.jobs.find((j) => j.id === job.id)?.life).toBe('stale');
    expect(JSON.stringify(stale.workflows.jobs)).not.toContain('"life":"running"');
  }, 120_000);

  it('a record that cannot be read is shown as unknown with its reason, and so is a receipts store that cannot be read', () => {
    const base = temp('overview-unreadable-');
    const root = path.join(base, 'project');
    fs.mkdirSync(path.join(root, '.timmy', 'operations'), { recursive: true });
    fs.mkdirSync(path.join(root, 'results', 'vox'), { recursive: true });
    fs.writeFileSync(path.join(root, '.timmy', 'operations', 'o00000001.json'), JSON.stringify({ schema: 'something else', id: 'o00000001' }));
    fs.writeFileSync(path.join(root, 'results', 'vox', 'v00000001.json'), '{ not json');
    // The store's runs.jsonl is a folder: it cannot be read as a chain.
    const store = path.join(base, 'store');
    fs.mkdirSync(path.join(store, 'runs.jsonl'), { recursive: true });
    const o = buildOverview(root, { name: 'project', jobsDir: path.join(base, 'jobs'), store, env: { TIMMY_HOME: path.join(base, 'home') } });
    expect(o.history.unreadable).toEqual([{ record: '.timmy/operations/o00000001.json', why: 'its schema is not timmy.operation/1' }]);
    expect(o.spatial.unreadable).toHaveLength(1);
    expect(o.spatial.unreadable[0].record).toBe('results/vox/v00000001.json');
    expect(o.spatial.unreadable[0].why).toMatch(/^not JSON/);
    expect(o.history.receipts).toMatchObject({ known: false, why: "the receipts store could not be read: the store's runs.jsonl is not a file" });
    expect(o.history.state).not.toBe('read');
    expect(o.history.why).toContain("the store's runs.jsonl is not a file");
    expect(o.history.head).toBeNull();
    const shown = plain(overviewLines(o, 'history', { glyphs: g })).join('\n');
    expect(shown).toContain("unknown: the receipts store could not be read: the store's runs.jsonl is not a file");
    expect(shown).not.toContain('no receipts yet');
    expect(shown).toContain('.timmy/operations/o00000001.json could not be read: its schema is not timmy.operation/1');
    // No store named at all: the receipts are not known either, and nothing claims an empty chain.
    const none = buildOverview(root, { name: 'project', env: { TIMMY_HOME: path.join(base, 'home') } });
    expect(none.history.receipts).toMatchObject({ known: false, why: 'no receipts store was named, so no receipt was read' });
    expect(none.agents.state).toBe('partial');
    expect(none.notes.join(' ')).toContain('No jobs folder was named');
  });

  it('a request whose cost did not come back is unknown (null), counted apart and never summed as 0', () => {
    const base = temp('overview-cost-');
    const root = path.join(base, 'project');
    fs.mkdirSync(root, { recursive: true });
    // The project's own store: appendReceipt writes it in the project's .timmy (no pin or package above a test folder).
    const store = path.join(root, '.timmy', 'receipts');
    const pid = projectId(root);
    // Two code agent runs' results through the agent module's own writer: one paid run that reported no cost, one that did.
    const run = (id: string, cost: number | null, basis: string): void => {
      const dir = runDir(root, id);
      fs.mkdirSync(dir, { recursive: true });
      const rec: AgentRunRecord = {
        agent_run: 1, run: id, agent: 'claude', agent_version: '0.0.0', model: 'a-paid-model', endpoint: 'remote', where: 'your Claude account',
        task: `task of ${id}`, job: 'j000000', started_at: '2026-10-10T10:00:00.000Z', ended_at: '2026-10-10T10:01:00.000Z', exit_code: 0, signal: null,
        outcome: 'completed', why: 'it ended by itself', cost_usd: cost, cost_basis: basis,
      };
      writeJson(path.join(dir, 'result.json'), rec);
    };
    run('a00000001', null, 'unknown: the agent reported no cost');
    run('a00000002', 0.0123, 'as the agent reported it');
    // And a receipt of this project sealed on a real chain (the receipts writer), so the store is known.
    appendReceipt('runs', { kind: 'note', subject: 'overview test', policy: 'auto', project_id: pid } as ReceiptInput, root);
    expect(readChain('runs', root)).toHaveLength(1);
    const o = buildOverview(root, { name: 'project', jobsDir: path.join(base, 'jobs'), store, env: { TIMMY_HOME: path.join(base, 'home') } });
    const unknown = o.agents.items.find((a) => a.id === 'a00000001')!;
    expect(unknown.cost).toEqual({ kind: 'unknown', usd: null, words: 'unknown: the agent reported no cost' });
    const known = o.agents.items.find((a) => a.id === 'a00000002')!;
    expect(known.cost).toMatchObject({ kind: 'known', usd: 0.0123 });
    expect(o.history.costs.reported).toEqual({ usd: 0.0123, runs: 1 });
    expect(o.history.costs.unknown).toEqual({ runs: 1 });
    expect(o.history.costs.words).toContain('1 run of unknown cost');
    const shown = plain(overviewLines(o, 'history', { glyphs: g })).join('\n');
    expect(shown).toContain('$0.0123 known (1 run)');
    expect(shown).toContain('1 run of unknown cost');
    expect(plain(overviewLines(o, 'agents', { glyphs: g })).join('\n')).toContain('cost    unknown: the agent reported no cost');
  });
});
