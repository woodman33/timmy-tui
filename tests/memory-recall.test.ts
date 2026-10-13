/**
 * Timmy Memory (round R4, helper H50): /recall over what a project retained, by words (not meaning), through the
 * Workspace, on real files in a temporary project and a REAL receipts chain kept in it (tests/helpers/memory-kit.ts).
 * Each kind of record is written here as its own module writes it where a writer exists (the flows' writeProjectJson,
 * writeMcpCall, the recipe lane's enqueue, /lesson add) and by hand where one does not (a VoxVision record, an
 * observation, an agent run's result, a native run's job.json and verdict line, a workflow run's receipt), each with
 * made-up contents in its module's own shape: no agent, native app, model or MCP server runs here.
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeMcpCall } from '../src/connectors/mcp-records.js';
import { BY_WORDS, recallWords } from '../src/memory/recall.js';
import { readCard } from '../src/recipes/index.js';
import { DETERMINISTIC } from '../src/vision/look.js';
import { enqueue } from '../lanes/recipes/jobs.js';
import { createProjectTools } from '../src/agent/project-tools.js';
import { approvalNeeded } from '../src/repl/approvals.js';
import { replTools } from '../src/repl/main.js';
import { chainOf, memoryKit, put, realSeal, sealIn, sha, text, workspace, writeFlow } from './helpers/memory-kit.js';

const kit = memoryKit();
afterEach(async () => { vi.unstubAllEnvs(); await kit.cleanup(); });

const short = (h: string): string => h.slice(7, 15);
const NATIVE_RUN = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

/** One record of each kind the project keeps, each with a word of its own; returns where each is and its receipt. */
function everyKind(root: string) {
  const at = new Date(Date.now() - 3600_000).toISOString();
  const flow = writeFlow(root, { instruction: 'make the zebra stripes wider', started: at, verdict: 'matches' });
  // VoxVision (results/vox/<id>.json, timmy.vox/1) and its vox receipt naming its bytes.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  put(root, 'refs/photo.png', png);
  const vox = JSON.stringify({
    schema: 'timmy.vox/1', id: 'v1a2b3c4d', action: 'inspect', command: '/inspect refs/photo.png', made_at: at, project: 'p', status: 'ok',
    inputs: [{ path: 'refs/photo.png', sha256: sha(png), bytes: png.length, kind: 'image', kind_by: 'bytes' }], tools: [],
    metrics: [{ name: 'width_px', title: 'Width', value: 4, unit: 'px', tier: DETERMINISTIC, label: 'measured', measured_by: 'a FAKE record' }],
    highlights: [], failures: [], notes: ['a giraffe pattern'],
  }, null, 2);
  put(root, 'results/vox/v1a2b3c4d.json', vox);
  const voxReceipt = sealIn(root, { kind: 'vox', outputs: [{ path: 'results/vox/v1a2b3c4d.json', sha256: sha(vox), bytes: vox.length }] });
  // An observation (results/observations/*.json) and its observe receipt for exactly its bytes and its image.
  put(root, 'refs/pelican.png', png);
  const obs = JSON.stringify({ observation: 1, made_at: at, source: { path: 'refs/pelican.png', sha256: sha(png) }, look: { worker: { name: 'timmy-look', version: '0.0.0-fake' }, image: { width: 4, height: 2 }, measurements: [{ name: 'mean_brightness', value: 0.5, tier: DETERMINISTIC }] } });
  put(root, 'results/observations/pelican-1.json', obs);
  const obsReceipt = sealIn(root, { kind: 'observe', outputs: [{ path: 'results/observations/pelican-1.json', sha256: sha(obs), bytes: obs.length }], files: [{ path: 'refs/pelican.png', sha256: sha(png) }] });
  // A code agent's run (.timmy/agents/<run>/result.json and run.json) and its agent receipt naming result.json.
  const result = JSON.stringify({ agent_run: 1, run: 'a1b2c3d4e', agent: 'qwen', agent_version: null, model: 'qwen3:4b', endpoint: 'local', where: '127.0.0.1', task: 'teach the walrus to swim', job: 'j123456', started_at: at, ended_at: at, outcome: 'completed', why: 'it exited 0 and reported success', files: { added: [], changed: [{ path: 'src/a.txt', size: 1, sha256: 'a'.repeat(64) }], deleted: [], truncated: false } }, null, 2);
  put(root, '.timmy/agents/a1b2c3d4e/result.json', result);
  put(root, '.timmy/agents/a1b2c3d4e/run.json', result);
  const agentReceipt = sealIn(root, { kind: 'agent', outputs: [{ path: '.timmy/agents/a1b2c3d4e/result.json', sha256: sha(result), bytes: result.length }] });
  // An MCP call, by the MCP records' own writer: its server, tool and arguments, and an output only it holds a word of.
  const output = Buffer.from('{"text":"secretoctopus lives here"}');
  const mcp = writeMcpCall({ root, project: 'p', seal: realSeal(root) }, {
    route: 'sdk', server: { name: 'docs', transport: 'stdio' }, tool: 'search', args: { query: 'narwhal facts' }, startedAt: at, endedAt: at, ms: 5,
    outcome: 'answered', called: true, isError: false, output: { bytes: output.length, sha256: sha(output), kept: output, truncated: false }, annotations: null, notes: [],
  });
  if (!mcp.ok) throw new Error(mcp.error);
  // A native run (.timmy/native/<run>/job.json and its verdict line) and the native receipt naming the run.
  put(root, `.timmy/native/${NATIVE_RUN}/job.json`, JSON.stringify({ record: 'timmy-native-run', v: 1, app: 'openscad', run: NATIVE_RUN, program: 'openscad', label: 'OpenSCAD · box.scad · lynx', project: 'p', args: [], expect: [], pre: {}, started_at: at, timeout_ms: 60000 }));
  put(root, `.timmy/native/${NATIVE_RUN}/verdicts.jsonl`, `${JSON.stringify({ judged_at: at, outcome: 'ok', why: 'it wrote box.stl (a FAKE verdict)', exit: { code: 0, signal: null, state: 'completed' }, files: [] })}\n`);
  const nativeReceipt = sealIn(root, { kind: 'native', native: { app: 'openscad', outcome: 'ok', why: 'a FAKE verdict', exit_code: 0, signal: null, files: [], run: NATIVE_RUN } });
  // A recipe job, written (queued, never run) by the recipe lane's own enqueue, and the prediction receipt naming it.
  const executor = join(kit.temp('memory-executor-'), 'never-run.mjs');
  writeFileSync(executor, '// a FAKE executor: written for the job\'s sources, never run\n');
  const job = enqueue({ schema: 'timmy.recipe-request/1', recipe: 'enclosure.tray/1', parameters: readCard().parameters }, { root, executor });
  const recipeReceipt = sealIn(root, { kind: 'predict', sources: [{ path: `.timmy/recipe-jobs/${job.job.id}/job.json`, operation: job.job.id }] });
  // A workflow (upmd) run, as its job's receipt names it.
  const workflowReceipt = sealIn(root, {
    kind: 'workflow', subject: 'workflow · BUILD.md › ocelot · completed',
    job: { id: 'j0c0e01', kind: 'workflow', label: 'BUILD.md › ocelot', state: 'completed', exit_code: 0, steps: [{ name: 'ocelot', state: 'completed' }] },
    prediction: { doc: 'BUILD.md', block: 'ocelot', order: ['ocelot'], expect: 'each block exits 0', met: true },
  });
  return { flow, voxReceipt, obsReceipt, agentReceipt, mcp, nativeReceipt, recipe: job.job.id, recipeReceipt, workflowReceipt };
}

describe('/recall: by words, not meaning, over every kind of retained record', () => {
  it('finds each kind by its own words, with its state, its file and the receipt that seals it', async () => {
    vi.stubEnv('TIMMY_CADQUERY_PYTHON', '');
    const root = kit.temp('memory-recall-');
    const r = everyKind(root);
    const { ws } = workspace(root, kit);
    const lesson = /Lesson\s+(l[0-9a-f]{8})/.exec(text(ws.lesson(`add "the heron lesson" --from ${r.flow.rel} --applies tray`)))![1];
    const out = text(ws.recall('zebra giraffe pelican walrus narwhal lynx enclosure ocelot heron --all'));
    expect(out).toContain(`Recall     zebra giraffe pelican walrus narwhal lynx enclosure ocelot heron · ${BY_WORDS}`);
    const hit = (what: string, file: string, receipt: string): void => {
      const at = out.indexOf(what);
      expect(at, `${what} in ${out}`).toBeGreaterThanOrEqual(0);
      const block = out.slice(at, at + 600);
      expect(block).toContain(file);
      expect(block).toContain(receipt);
    };
    hit(`flow tray ${r.flow.id}  succeeded, readback matches`, r.flow.rel, `receipt ${short(r.flow.receipt!.hash)}`);
    hit('VoxVision inspect v1a2b3c4d  ok', 'results/vox/v1a2b3c4d.json', `receipt ${short(r.voxReceipt.hash)}`);
    hit('observation pelican-1  1 measured value', 'results/observations/pelican-1.json', `receipt ${short(r.obsReceipt.hash)}`);
    hit('agent qwen a1b2c3d4e  completed', '.timmy/agents/a1b2c3d4e/result.json', `receipt ${short(r.agentReceipt.hash)}`);
    hit(`MCP call ${(r.mcp as { id: string }).id}  answered`, (r.mcp as { call: string }).call, `receipt ${(r.mcp as { receipt: string }).receipt}`);
    hit('OpenSCAD (command line) 0a1b2c3d  judged ok', `.timmy/native/${NATIVE_RUN}/job.json`, `receipt ${short(r.nativeReceipt.hash)}`);
    hit(`recipe enclosure.tray/1 ${r.recipe.slice(0, 8)}  queued`, `.timmy/recipe-jobs/${r.recipe}/job.json`, `receipt ${short(r.recipeReceipt.hash)} (its prediction)`);
    hit('workflow run j0c0e01  completed, prediction met', 'BUILD.md', `receipt ${short(r.workflowReceipt.hash)}`);
    hit(`lesson ${lesson}  draft`, `.timmy/memory/lessons/${lesson}.json`, 'receipt ');
    expect(out).toContain('MCP call');
    expect(out).toContain('docs · search · arguments {"query":"narwhal facts"}');
    expect(out).toContain('9 records hold one or more of the words');
    // An MCP call's output is never searched (nor shown): only its server, tool and arguments are.
    const octopus = text(ws.recall('secretoctopus'));
    expect(octopus).toContain('Nothing this project retained holds that word.');
    expect(octopus).toContain(BY_WORDS);
  });

  it('ranks by how many words matched, then newest first; bounded at 10 unless --all', async () => {
    const root = kit.temp('memory-recall-');
    const base = Date.parse('2026-10-01T00:00:00Z');
    const flows = Array.from({ length: 12 }, (_, i) => writeFlow(root, { instruction: `shared word, flow ${i}`, started: new Date(base + i * 60_000).toISOString() }));
    const both = writeFlow(root, { instruction: 'shared and rare together', started: new Date(base - 86_400_000).toISOString() });
    const { ws } = workspace(root, kit);
    const out = text(ws.recall('shared rare'));
    const first = out.split('\n').find((l) => /^\s+\S+ \d{4}-/.test(l))!;
    expect(first).toContain(both.id); // two words matched, though it is the oldest
    expect(out).toContain('13 records hold one or more of the words; ranked by how many words matched, then newest first; 10 shown: /recall shared rare --all shows all');
    const ids = [...out.matchAll(/flow tray (f[0-9a-f]{8})/g)].map((m) => m[1]);
    expect(ids).toHaveLength(10);
    expect(ids.slice(1, 4)).toEqual([flows[11].id, flows[10].id, flows[9].id]); // then newest first
    const all = text(ws.recall('shared rare --all'));
    expect([...all.matchAll(/flow tray (f[0-9a-f]{8})/g)]).toHaveLength(13);
    expect(recallWords('  "Zebra," a zebra  b2 ')).toEqual(['zebra', 'b2']);
  });

  it('names every record it cannot read, never skipping one silently', async () => {
    const root = kit.temp('memory-recall-');
    writeFlow(root, { instruction: 'a readable one' });
    put(root, 'results/flows/f99999999.json', '{ not json');
    put(root, 'results/vox/v99999999.json', '[]');
    mkdirSync(join(root, '.timmy/agents/a99999999'), { recursive: true });
    mkdirSync(join(root, '.timmy/mcp/m99999999'), { recursive: true });
    mkdirSync(join(root, `.timmy/native/${NATIVE_RUN}`), { recursive: true });
    put(root, '.timmy/memory/lessons/l99999999.json', '{"schema":"timmy.lesson/1"}');
    const { ws } = workspace(root, kit);
    const out = text(ws.recall('readable'));
    expect(out).toContain('flow tray');
    expect(out).toContain('Could not read 6 records (not searched):');
    for (const f of ['results/flows/f99999999.json', 'results/vox/v99999999.json', '.timmy/agents/a99999999/', '.timmy/mcp/m99999999/call.json', `.timmy/native/${NATIVE_RUN}/job.json`, '.timmy/memory/lessons/l99999999.json']) expect(out).toContain(f);
    expect(out).toContain('results/vox/v99999999.json  it is not a VoxVision record (timmy.vox/1) Timmy can read');
    expect(readdirSync(join(root, 'results/flows'))).toContain('f99999999.json'); // left as it is
  });

  it('with no words it says how it searches; a word of one character is not a word to search', () => {
    const root = kit.temp('memory-recall-');
    const { ws } = workspace(root, kit);
    const usage = text(ws.recall(''));
    expect(usage).toContain('Recall     /recall <words> [--all]');
    expect(usage).toContain(BY_WORDS);
    expect(usage).toContain('MCP calls (server, tool and arguments, never the output)');
    expect(text(ws.recall('a'))).toContain('Give words of two characters or more');
  });
});

describe('recall_project_work: the agent\'s read-only recall (the same hits, as data)', () => {
  type Exec = (a: Record<string, unknown>) => Promise<Record<string, unknown>>;
  it('gives the hits with their files and receipts, names what it cannot read, scrubs the project\'s folder, and asks nothing', async () => {
    const root = kit.temp('memory-tool-');
    const flow = writeFlow(root, { instruction: `make the zebra wider than ${root}/notes`, verdict: 'matches' });
    put(root, 'results/flows/f99999999.json', '{ not json');
    const tools = createProjectTools({ root: () => root, chain: () => chainOf(root) });
    const tool = tools.find((t) => t.function.name === 'recall_project_work')!;
    const call = (args: Record<string, unknown>): Promise<Record<string, unknown>> => (tool.function as unknown as { execute: Exec }).execute(args);
    const r = await call({ words: 'zebra' });
    expect(r).toMatchObject({ ok: true, how: BY_WORDS, words: ['zebra'], total: 1, shown: 1 });
    expect(r.hits).toEqual([expect.objectContaining({ kind: 'flow', id: flow.id, file: flow.rel, receipt: flow.receipt!.hash.slice(7, 15), matched: ['zebra'] })]);
    expect(r.unreadable).toEqual([expect.objectContaining({ kind: 'flow', file: 'results/flows/f99999999.json' })]);
    expect(JSON.stringify(r)).not.toContain(root);
    expect(String((r.hits as Array<{ line: string }>)[0].line)).toContain('./notes');
    expect(await call({ words: 'x' })).toMatchObject({ ok: false, error: 'Give words of two characters or more.' });
    expect(approvalNeeded('recall_project_work', { words: 'zebra' })).toBeNull();
    expect(replTools().map((t) => t.function.name)).toContain('recall_project_work');
  });
});
