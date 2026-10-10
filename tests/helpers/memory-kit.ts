/**
 * Test helpers for Timmy Memory (round R4, helper H50): temporary projects, and a Workspace whose seal appends to a REAL
 * receipts chain kept in the project itself (appendReceipt with the project as its store: hash-chained, and signed with
 * an ed25519 key made in the project's own .timmy/keys), read back with readChain. Nothing here is a fake; each test
 * names the FAKE pieces it uses (the code agent, the native apps) where it uses them.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DOCTRINE_15, FLOW_SCHEMA, writeProjectJson } from '../../src/flows/iterate.js';
import { folderProject, projectId } from '../../src/project/index.js';
import { RECIPE_ID } from '../../src/recipes/index.js';
import { Workspace, type WorkspaceDeps } from '../../src/repl/workspace.js';
import { glyphSet } from '../../src/term/glyphs.js';
import { appendReceipt, readChain, type Receipt, type ReceiptInput } from '../../src/utils/receipts.js';

export const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
export const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
export const put = (root: string, rel: string, body: string | Buffer): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
export const read = (root: string, rel: string): string => readFileSync(join(root, rel), 'utf8');

/** Temporary folders and workspaces, cleaned up by `cleanup()` (call it in afterEach). */
export function memoryKit() {
  const dirs: string[] = [];
  const spaces: Workspace[] = [];
  return {
    temp: (prefix: string): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); dirs.push(d); return d; },
    track: (w: Workspace): Workspace => { spaces.push(w); return w; },
    cleanup: async (): Promise<void> => {
      for (const w of spaces.splice(0)) await w.close();
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    },
  };
}
export type MemoryKit = ReturnType<typeof memoryKit>;

/** The REPL's seal, on a real chain in the project: the receipt's short hash back (as /receipts shows it). */
export const realSeal = (root: string) => (input: ReceiptInput): string => appendReceipt('runs', input, root).hash.slice(7, 15);
/** The project's runs chain as it is now. */
export const chainOf = (root: string): Receipt[] => readChain('runs', root);
/** Seals one receipt of this project on its chain (as a flow, a vox action or a job would), and returns it. */
export function sealIn(root: string, input: Partial<ReceiptInput> & { kind: string }): Receipt {
  return appendReceipt('runs', { subject: `${input.kind} · test`, policy: 'human-gated', status: 'ok', project: 'p', project_id: projectId(root), ...input } as ReceiptInput, root);
}

/** A Workspace on `root` with the real chain, no recovery at its start, its jobs folder outside the project. */
export function workspace(root: string, kit: MemoryKit, o: { env?: Record<string, string>; onPath?: (cmd: string) => string | null; extra?: Partial<WorkspaceDeps> } = {}) {
  const notes: string[] = [];
  const opened: string[] = [];
  const ws = new Workspace({
    glyphs: glyphSet(true),
    env: o.env ?? {},
    onPath: o.onPath ?? (() => null),
    notify: (l) => notes.push(l.map((s) => s.text).join('')),
    openWeb: (url) => { opened.push(url); return `Open ${url}`; },
    link: (t) => t,
    seal: realSeal(root),
    jobsDir: join(kit.temp('memory-jobs-'), 'jobs'),
    chdir: () => {},
    receipts: () => chainOf(root),
    recoverAtStart: false,
    ...o.extra,
  }, folderProject(root));
  kit.track(ws);
  return { ws, notes, opened };
}

/**
 * A flow record as the flows write it (writeFlowRecord: results/flows/<id>.json through a temporary file), and its `flow`
 * receipt naming exactly its bytes, as a flow's end seals it. Its parts are made up for the test (no agent or recipe ran):
 * what is real is the file, its sha256 and the receipt on the chain.
 */
export function writeFlow(root: string, o: {
  id?: string; kind?: 'tray' | 'blender' | 'scad' | 'freecad' | 'ae'; instruction: string; outcome?: string; verdict?: string | null;
  started?: string; ended?: string | null; cost?: number | null; lessons?: string[]; recovered?: boolean; seal?: boolean;
}): { id: string; rel: string; sha256: string; receipt?: Receipt } {
  const id = o.id ?? `f${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')}`;
  const kind = o.kind ?? 'tray';
  const started = o.started ?? new Date().toISOString();
  const outcome = o.outcome ?? 'succeeded';
  const record: Record<string, unknown> = {
    flow: 1, schema: FLOW_SCHEMA, id, kind: 'iterate', ...(kind === 'tray' ? { recipe: RECIPE_ID } : { target: kind }), instruction: o.instruction, project: 'p',
    started_at: started, ...(o.ended === null ? {} : { ended_at: o.ended ?? new Date(Date.parse(started) + 60_000).toISOString() }), outcome,
    ended_in: outcome === 'succeeded' ? 'readback' : 'checks', why: outcome === 'succeeded' ? 'the readback matches' : `it ended ${outcome}`,
    ...(kind === 'tray'
      ? { parameters: { path: 'recipes/tray.params.json', created: false, before: { sha256: 'a'.repeat(64), values: { width: 140 } }, after: { sha256: 'b'.repeat(64), values: { width: 180 } }, diff: [{ name: 'width', before: 140, after: 180, changed: true }] } }
      : { script: { path: `model.${kind}`, before: { sha256: 'a'.repeat(64), bytes: 10, lines: 1 } } }),
    agent: { run: 'a12345678', agent: 'qwen', version: null, route: 'local endpoint, no charge', where: '127.0.0.1', model: 'qwen3:4b', job: 'j123456', outcome: 'completed', ...(o.cost === undefined ? {} : { cost_usd: o.cost, cost_basis: o.cost === null ? 'unknown' : 'local endpoint' }) },
    ...(o.verdict === null || o.verdict === undefined ? {} : { readback: { state: 'completed', verdict: o.verdict, tolerance: { bounds_mm: 1e-6, volume_relative: 1e-8 }, scope: 'the CAD file' } }),
    receipts: {}, child_receipts: [], doctrine: DOCTRINE_15,
    ...(o.lessons ? { lessons: o.lessons.map((l) => ({ id: l, sha256: 'c'.repeat(64), status: 'checked' })) } : {}),
    ...(o.recovered ? { recovered: { at: new Date().toISOString(), step: 'agent', next: [] } } : {}),
  };
  const w = writeProjectJson(root, `results/flows/${id}.json`, record);
  if (!w.ok) throw new Error(w.error);
  const receipt = o.seal === false ? undefined : sealIn(root, { kind: 'flow', subject: `flow · iterate · ${kind} · ${id} · ${outcome}`, outputs: [{ path: w.path, sha256: w.sha256, bytes: w.bytes }] });
  return { id, rel: w.path, sha256: w.sha256, ...(receipt ? { receipt } : {}) };
}

export async function until(pred: () => boolean, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)); }
}
