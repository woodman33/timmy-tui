/**
 * Round R4 (H55): a project on disk for the canvas project tests, made of real record files, written as Timmy's own
 * writers write them where one exists (the tray recipe's writeParams, the OpenSCAD parameter text, a job through the real
 * JobManager) and in their documented shape otherwise (a flow record, a VoxVision record). The receipts are sealed as
 * appendReceipt seals them (each hash the hash of its own body, hashOf) into a runs.jsonl of a temporary store, unsigned:
 * the readers the canvas uses check hashes and paths, not signatures. Everything lives under os.tmpdir().
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { JobManager } from '../../src/jobs/index.js';
import { scadParamsText } from '../../src/native/scad-params.js';
import { projectId } from '../../src/project/index.js';
import { readCard } from '../../src/recipes/index.js';
import { writeParams } from '../../src/recipes/params-file.js';
import { hashOf } from '../../src/utils/receipts.js';

export const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

/** Hostile text, as a person or a model might write it into a title or an instruction. */
export const HOSTILE_TITLE = 'Build <img src=x onerror="window.__xss=1"> & "quoted" \'single\'';
export const HOSTILE_INSTRUCTION = 'make it wider <script>window.__xss=2</script></li><li>';

export interface CanvasProject {
  base: string;
  root: string;
  /** the project's folder as the server resolves it */
  real: string;
  jobs: string;
  store: string;
  pid: string;
  flow: string;
  flowFile: string;
  voxId: string;
  voxFile: string;
  /** seals a receipt into the store's runs.jsonl; its short id back */
  seal: (r: Record<string, unknown>) => string;
  write: (rel: string, text: string | Buffer) => void;
}

/** A flow record of the tray recipe, in its documented shape (src/flows/iterate.ts FlowRecord). */
export function flowRecord(id: string, outcome: string, instruction = HOSTILE_INSTRUCTION): string {
  return `${JSON.stringify({
    flow: 1, schema: 'timmy.flow/1', id, kind: 'iterate', recipe: 'enclosure.tray/1', instruction, project: 'demo',
    started_at: '2026-10-10T05:00:00.000Z', ended_at: '2026-10-10T05:02:00.000Z', outcome,
    parameters: { path: 'recipes/tray.params.json', created: false, before: { sha256: '0'.repeat(64), values: { width: 140 } } },
    readback: { state: 'completed', verdict: outcome === 'succeeded' ? 'matches' : 'differs', tolerance: { bounds_mm: 0.01, volume_relative: 0.001 }, scope: 'The readback measures the delivered CAD file.' },
  }, null, 2)}\n`;
}

export async function makeCanvasProject(prefix = 'canvas-project-'): Promise<CanvasProject> {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const root = join(base, 'demo');
  const jobs = join(base, 'jobs');
  const store = join(base, 'store');
  mkdirSync(root, { recursive: true });
  mkdirSync(store, { recursive: true });
  const real = realpathSync(root);
  const pid = projectId(root);
  const write = (rel: string, text: string | Buffer): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  let n = 0;
  const seal = (r: Record<string, unknown>): string => {
    n += 1;
    const body = { v: 1, id: `rc_test_${n}`, stream: 'runs', ts: new Date(Date.UTC(2026, 9, 10, 5, 0, n)).toISOString(), policy: 'human-gated', status: 'ok', project: 'demo', project_id: pid, ...r, prev_hash: 'genesis' };
    const receipt = { ...body, hash: hashOf({ ...body, hash: '' }) };
    writeFileSync(join(store, 'runs.jsonl'), `${JSON.stringify(receipt)}\n`, { flag: 'a' });
    return receipt.hash.slice(7, 15);
  };

  // A workflow document: a hostile title, two blocks, the second naming the OpenSCAD model's parameter file.
  write('BUILD.md', `# ${HOSTILE_TITLE}\n\nBuild, then render.\n\n\`\`\`bash [name:build]\necho build\n\`\`\`\n\n\`\`\`bash [name:render] [needs:build]\ncat box.params.json\n\`\`\`\n`);
  // The OpenSCAD model and its parameter file, as the parameter checker writes it.
  write('box.scad', 'width = 60; depth = 40; height = 30;\ncube([width, depth, height]);\n');
  write('box.params.json', scadParamsText('box.scad', { width: 90, depth: 40, height: 30 }));
  // The tray recipe's parameter file, through the recipe's own writer.
  const tray = readCard().parameters;
  const wrote = writeParams(root, { ...tray, width: tray.width + 5 });
  if (!wrote.ok) throw new Error(`writeParams: ${wrote.error}`);
  seal({ kind: 'edit', subject: 'edit · recipes/tray.params.json', files: [{ path: 'recipes/tray.params.json', sha256: wrote.sha256 }] });

  // A flow record, sealed by its flow receipt (exactly these bytes): verified.
  const flow = 'f1a2b3c4d';
  const flowFile = `results/flows/${flow}.json`;
  const flowText = flowRecord(flow, 'succeeded');
  write(flowFile, flowText);
  seal({ kind: 'flow', subject: `flow · iterate · tray · ${flow} · succeeded`, outputs: [{ path: flowFile, sha256: sha(flowText), bytes: Buffer.byteLength(flowText) }] });
  // A record that cannot be read as one: named, with why.
  write('results/flows/f0badbad0.json', '{ "schema": "timmy.flow/1", "id": ');

  // A VoxVision record, its input and its highlight, sealed by its vox receipt.
  const stl = Buffer.from('solid empty\nendsolid empty\n');
  write('part.stl', stl);
  const voxId = 'v1a2b3c4d';
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>\n';
  write(`results/vox/${voxId}/bbox.svg`, svg);
  const voxFile = `results/vox/${voxId}.json`;
  const voxText = `${JSON.stringify({
    schema: 'timmy.vox/1', id: voxId, action: 'measure', command: '/measure part.stl', made_at: '2026-10-10T05:03:00.000Z', status: 'ok',
    inputs: [{ path: 'part.stl', sha256: sha(stl), bytes: stl.length, kind: 'mesh' }],
    tools: [{ tool: 'stl', name: "Timmy's STL reader", ran: 'in process' }],
    metrics: [{ name: 'triangles', title: 'Triangles', value: 0, method: 'counted', tier: 'deterministic computation', measured_by: "Timmy's STL reader" }],
    claims: [], failures: [], notes: [],
    highlights: [{ path: `results/vox/${voxId}/bbox.svg`, sha256: sha(svg), type: 'image/svg+xml', drawn_from: ['part.stl'], drawn_by: 'Timmy' }],
  }, null, 2)}\n`;
  write(voxFile, voxText);
  seal({ kind: 'vox', subject: 'vox · measure · part.stl · ok', outputs: [{ path: voxFile, sha256: sha(voxText), bytes: Buffer.byteLength(voxText) }, { path: `results/vox/${voxId}/bbox.svg`, sha256: sha(svg), bytes: Buffer.byteLength(svg) }] });

  // A chat turn of this project, sealed.
  seal({ kind: 'turn', subject: 'turn · a question', model_requested: 'test/model', ms: 1200, tool_outcomes: [] });

  // A job of this project, run to its end by the real JobManager (its record is the one the Control Room reads).
  const manager = new JobManager({ dir: jobs });
  const job = manager.start({ kind: 'task', label: 'echo hello', project: 'demo', root, command: process.execPath, args: ['-e', 'console.log("hello")'] });
  await manager.done(job.id);

  return { base, root, real, jobs, store, pid, flow, flowFile, voxId, voxFile, seal, write };
}
