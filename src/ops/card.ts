/**
 * Round R4 (H51): the operation card, one request followed through everything it made, for `/op`, `/ops` and the top of
 * the board's Control Room. Read from the project's own records, whichever process wrote them (a REPL and the
 * `timmy act` runs a workflow's blocks started share one operation id):
 *
 *   the request            its operation record (.timmy/operations/<id>.json): the line, where it came from, its state;
 *   the workflow           each /run of a upmd document under it (its job): the blocks as they ran, and the document checked
 *                          against the prediction receipt that named its sha256 before it ran;
 *   flows                  each flow record (or running state file) naming the operation: its verdict in words, its steps
 *                          with who did each (src/room flowHandoff), checked against its flow receipt;
 *   native outputs         the files its flows and native runs name with a sha256 (the editable source, the STL, STEP,
 *                          .blend or render), each hashed now: as sealed, stale when it changed, or gone;
 *   VoxVision              each record naming the operation, and each record (of any operation) whose inputs are those
 *                          outputs' bytes, checked as the board checks them (src/repl/board-vox.ts readVoxRecord);
 *   lessons                .timmy/memory/lessons/*.json (timmy.lesson/1, written by Timmy Memory) whose evidence names a
 *                          record, output or receipt of the operation, or that name it; each piece of evidence checked
 *                          (its file's sha256 now, its receipt on the chain). The folder may be absent; a file that
 *                          cannot be read is named with why;
 *   receipts               every receipt sealed under it (operation_id).
 *
 * Every item says how it was checked and shows the command that acts on it. Nothing here runs, seals or writes; every
 * string a record gives goes through the caller's scrub (the project's folder as ".", the home folder as "~").
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { JobRecord } from '../jobs/index.js';
import type { Receipt } from '../utils/receipts.js';
import { FLOWS_DIR } from '../flows/iterate.js';
import { readBoardFlows, type BoardFlow } from '../repl/board-flows.js';
import { flowHandoff, type RoomStep } from '../room/index.js';
import { readVoxRecord, type VoxCard } from '../repl/board-vox.js';
import { VOX_DIR, VOX_ID } from '../vox/record.js';
import { wordText } from '../vox/words.js';
import { AGENTS_DIR, listAgentRuns } from '../code-agents/index.js';
import { listNativeRuns, readNativeRecord } from '../native/index.js';
import { MCP_CALL_ID, MCP_CALLS_DIR } from '../connectors/mcp-records.js';
import { flowClaims } from './outcome.js';
import { listOperationRecords, operationRel, readOperationRecord, type OperationRecord } from './operations.js';
import { runBlocks } from '../workflows/run-blocks.js'; // R4 (H67)
import { blockReceiptsOf } from '../workflows/block-receipts.js'; // R4 (H74): each block's own receipt
import { OPERATION_ID } from './context.js';
import { writerState } from './process-proof.js';

export const LESSONS_DIR = '.timmy/memory/lessons';
export const LESSON_SCHEMA = 'timmy.lesson/1';
/** Files larger than this are named, not hashed (a render can be gigabytes). */
const HASH_LIMIT = 256 * 1024 * 1024;
const RECORD_MAX = 1024 * 1024;
const MAX_LESSON_FILES = 400;

export type CardTone = 'ok' | 'failed' | 'stopped' | 'attention' | 'running' | 'neutral';
/** How an item was checked: verified (a receipt sealed exactly these bytes, and what it names is unchanged), stale (it was,
 *  and something it names changed since), unverified (no receipt holds it), missing (a file it names is gone). */
export type CheckStatus = 'verified' | 'stale' | 'unverified' | 'missing';
export interface CardCheck { status: CheckStatus; words: string; receipt?: string }

export interface CardStep { name: string; state: string; code?: number; owner?: string; role?: string; job?: string; receipt?: string; detail?: string; here?: string }

export interface CardWorkflow { doc: string; block: string; job: string; state: string; tone: CardTone; steps: CardStep[]; check: CardCheck; commands: string[] }
export interface CardFlow { id: string; kind: string; instruction?: string; outcome: string; verdict: string; tone: CardTone; steps: CardStep[]; file: string; check: CardCheck; commands: string[] }
export interface CardOutput { path: string; role: string; by: string; sha256?: string; check: CardCheck; commands: string[] }
export interface CardVox { id: string; file: string; action: string; status: string; tone: CardTone; inputs: string[]; values: string[]; about: 'this operation' | 'its outputs'; check: CardCheck; commands: string[] }
export interface CardLesson {
  id: string; file: string; text: string; status: string; tone: CardTone; evidence: Array<{ what: string; check: CardCheck }>; commands: string[];
  /** how it relates to the operation (r19, ledger row 158): made from its records, given to one of its runs, or both */
  relation?: string;
}
export interface CardRun { kind: string; id: string; role: string; state: string; tone: CardTone }

export interface OperationCard {
  id: string;
  request: string;
  via?: string;
  /** its state in words, as its record says (interrupted: its record says running and the Timmy writing it is gone) */
  state: string;
  tone: CardTone;
  why?: string;
  note?: string;
  started?: string;
  ended?: string | null;
  parent?: string | null;
  /** its record, or why there is none here */
  record?: string;
  recordError?: string;
  workflows: CardWorkflow[];
  flows: CardFlow[];
  outputs: CardOutput[];
  vox: CardVox[];
  lessons: CardLesson[];
  /** lesson files that could not be read, each with why */
  lessonErrors: string[];
  runs: CardRun[];
  receipts: Array<{ id: string; kind: string; status?: string }>;
  commands: string[];
  /** R4 (H60): what of it waits on a person now (src/room/decisions.ts), each in a few words; absent when nothing does */
  waiting?: string[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const shortReceipt = (r: Receipt): string => (typeof r.hash === 'string' && r.hash.length > 15 ? r.hash.slice(7, 15) : String(r.id ?? '?'));
const short = (s: string | undefined): string => (s ? s.slice(0, 12) : '?');

// ── files and their sha256 now ────────────────────────────────────────────────

// R4 (H65): with the file's inode and device: another file reached by the same path (a link replaced, a file renamed over it)
// within one tick of the file system's clock, with the same size, was given the hash of the file that was there before.
const hashes = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; ino: number; dev: number; sha256: string }>();
/** A project file's sha256 now: null when it is gone, 'large' past HASH_LIMIT, undefined when it cannot be read or is outside. */
export function shaNow(root: string, rel: string): string | null | 'large' | undefined {
  let real: string;
  try { real = fs.realpathSync(root); } catch { return undefined; }
  const abs = path.resolve(real, rel);
  if (abs !== real && !abs.startsWith(real + path.sep)) return undefined;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return undefined;
    const r = fs.realpathSync(abs);
    if (r !== real && !r.startsWith(real + path.sep)) return undefined;
    if (st.size > HASH_LIMIT) return 'large';
    const known = hashes.get(abs);
    if (known && known.size === st.size && known.mtimeMs === st.mtimeMs && known.ctimeMs === st.ctimeMs && known.ino === st.ino && known.dev === st.dev) return known.sha256;
    const sha = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    if (hashes.size > 4000) hashes.clear();
    hashes.set(abs, { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: st.ino, dev: st.dev, sha256: sha });
    return sha;
  } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined; }
}

function readJson(root: string, rel: string, max = RECORD_MAX): { ok: true; value: unknown; sha256: string } | { ok: false; error: string } {
  try {
    const abs = path.join(root, rel);
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) return { ok: false, error: 'it is a symbolic link' };
    if (!st.isFile()) return { ok: false, error: 'it is not a file' };
    if (st.size > max) return { ok: false, error: `it is larger than ${Math.round(max / 1024)} KB` };
    const buf = fs.readFileSync(abs);
    return { ok: true, value: JSON.parse(buf.toString('utf8')), sha256: createHash('sha256').update(buf).digest('hex') };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, error: code === 'ENOENT' ? 'it is not there' : code ? `${code}` : 'it is not JSON' };
  }
}

const listDir = (root: string, rel: string, test: RegExp): string[] => { try { return fs.readdirSync(path.join(root, rel)).filter((n) => test.test(n)); } catch { return []; } };

// ── the index: every record of the project, by the operation it names ────────

export interface OpIndex {
  root: string;
  chain: readonly Receipt[];
  scrub: (t: string) => string;
  records: Map<string, { record: OperationRecord; rel: string }>;
  unreadableRecords: Array<{ rel: string; error: string }>;
  jobs: Map<string, JobRecord[]>;
  flows: Map<string, BoardFlow[]>;
  /** every flow record and state file, with the raw `operation` it names (the board's flows are bounded) */
  vox: Array<{ card: VoxCard; operation?: string }>;
  agents: Map<string, string[]>;
  natives: Map<string, string[]>;
  mcps: Map<string, string[]>;
  receipts: Map<string, Receipt[]>;
}

export interface IndexContext {
  root: string;
  projectId: string;
  chain: readonly Receipt[];
  /** this project's jobs (the Workspace's list: its own and earlier sessions' records) */
  jobs: readonly JobRecord[];
  scrub: (t: string) => string;
}

const push = <T>(m: Map<string, T[]>, k: string | undefined, v: T): void => { if (!k || !OPERATION_ID.test(k)) return; const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };

/** Reads the project's records once: each operation's record, and every run record that names an operation. */
export function buildIndex(c: IndexContext): OpIndex {
  const root = c.root;
  const records = new Map<string, { record: OperationRecord; rel: string }>();
  const listed = listOperationRecords(root, 400);
  for (const r of listed.list) records.set(r.record.id, r);
  const jobs = new Map<string, JobRecord[]>();
  for (const j of c.jobs) push(jobs, j.operation, j);
  // Flows: every record and state file whose raw JSON names an operation, then checked by the board's own reader.
  const flowRels: string[] = [];
  const flowOp = new Map<string, string>();
  for (const n of listDir(root, FLOWS_DIR, /^f[0-9a-f]{8}\.json$/)) {
    const rel = `${FLOWS_DIR}/${n}`;
    const r = readJson(root, rel);
    const op = r.ok ? str(obj(r.value)?.operation) : undefined;
    if (op && OPERATION_ID.test(op)) { flowRels.push(rel); flowOp.set(n.slice(0, -5), op); }
  }
  const flows = new Map<string, BoardFlow[]>();
  // readBoardFlows also reads the state files of the flows that run (no record yet): their state names the operation too.
  const read = readBoardFlows(root, flowRels, { receipts: c.chain, projectId: c.projectId, scrub: c.scrub });
  for (const f of read.list) push(flows, flowOp.get(String(f.record.id)) ?? str((f.record as unknown as Obj).operation), f);
  for (const f of read.running ?? []) push(flows, str((f.record as unknown as Obj).operation), f);
  const vox: OpIndex['vox'] = [];
  for (const n of listDir(root, VOX_DIR, /^v[0-9a-f]{8}\.json$/)) {
    const rel = `${VOX_DIR}/${n}`;
    let text: string;
    let sha: string;
    try {
      const abs = path.join(root, rel);
      if (fs.lstatSync(abs).isSymbolicLink() || fs.statSync(abs).size > RECORD_MAX) continue;
      const buf = fs.readFileSync(abs);
      text = buf.toString('utf8');
      sha = createHash('sha256').update(buf).digest('hex');
    } catch { continue; }
    const card = readVoxRecord({ root, file: rel, text, fileSha256: sha, chain: c.chain, projectId: c.projectId });
    if (!card || !VOX_ID.test(card.id)) continue;
    let op: string | undefined;
    try { op = str(obj(JSON.parse(text))?.operation); } catch { op = undefined; }
    vox.push({ card, ...(op ? { operation: op } : {}) });
  }
  const agents = new Map<string, string[]>();
  try { for (const r of listAgentRuns(root)) push(agents, (r as { operation?: string }).operation, r.run); } catch { /* none */ }
  const natives = new Map<string, string[]>();
  try {
    for (const n of listNativeRuns(root)) {
      const rec = readJson(root, `.timmy/native/${n.run}/job.json`);
      push(natives, rec.ok ? str(obj(rec.value)?.operation) : undefined, n.run);
    }
  } catch { /* none */ }
  const mcps = new Map<string, string[]>();
  for (const id of listDir(root, MCP_CALLS_DIR, MCP_CALL_ID)) {
    const rec = readJson(root, `${MCP_CALLS_DIR}/${id}/call.json`);
    push(mcps, rec.ok ? str(obj(rec.value)?.operation) : undefined, id);
  }
  const receipts = new Map<string, Receipt[]>();
  for (const r of c.chain) if (r && r.project_id === c.projectId) push(receipts, str(r.operation_id), r);
  return { root, chain: c.chain, scrub: c.scrub, records, unreadableRecords: listed.unreadable, jobs, flows, vox, agents, natives, mcps, receipts };
}

/** Every operation the index knows of: by its record, or by the runs and receipts that name it (another process's). */
export function knownOperations(ix: OpIndex): string[] {
  const ids = new Set<string>([...ix.records.keys(), ...ix.jobs.keys(), ...ix.flows.keys(), ...ix.receipts.keys(), ...ix.agents.keys()]);
  for (const v of ix.vox) if (v.operation) ids.add(v.operation);
  return [...ids];
}

// ── the parts of a card ───────────────────────────────────────────────────────

const toneOf = (state: string): CardTone => (/^(running|starting|queued|ready)/.test(state) ? 'running'
  : /^(succeeded|completed|ok|matches|answered|verified|checked)/.test(state) ? 'ok'
    : /^(stopped|cancelled|interrupted|retired)/.test(state) ? 'stopped'
      : /^(refused|needs-setup|needs setup|draft|stale|unverified|untrusted|partial)/.test(state) ? 'attention'
        : /^(failed|differs|unknown)/.test(state) ? 'failed' : 'neutral');

/** The role a run plays in an operation, from its kind (never guessed: "role not recorded" otherwise). */
export function roleOf(kind: string, label = '', step?: string): string {
  if (step) {
    if (step === 'agent' || step === 'build' || ['openscad', 'freecad', 'blender', 'author', 'render'].includes(step)) return 'builder';
    if (step === 'readback' || step === 'checks') return 'checker';
    return 'role not recorded';
  }
  switch (kind) {
    case 'chat': return 'planner';
    case 'agent': case 'native': case 'recipe': return 'builder';
    case 'flow': return 'builder and checker';
    case 'look': case 'vox': return 'observer';
    case 'job':
      if (/^readback\b/.test(label)) return 'checker';
      if (/^vox\b/.test(label) || /^look\b/.test(label)) return 'observer';
      return 'role not recorded';
    default: return 'role not recorded';
  }
}

/** The files a flow record names with the sha256 its run gave them: its editable source after the change, then its natives. */
export function flowOutputs(record: unknown): Array<{ path: string; role: string; sha256?: string }> {
  const r = obj(record) ?? {};
  const p = (k: string): Obj | undefined => obj(r[k]);
  const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj).filter((x): x is Obj => !!x) : []);
  const out: Array<{ path: unknown; role: string; sha256?: unknown }> = [
    { path: p('parameters')?.path, role: 'the editable source (its parameters)', sha256: obj(p('parameters')?.after)?.sha256 },
    { path: p('script')?.path, role: 'the editable source (its script)', sha256: obj(p('script')?.after)?.sha256 },
    ...list(p('rebuild')?.outputs).map((o) => ({ path: o.path, role: /\.(step|stp)$/i.test(String(o.path)) ? 'STEP' : /\.stl$/i.test(String(o.path)) ? 'STL' : 'export', sha256: o.sha256 })),
    { path: obj(p('openscad')?.stl)?.path, role: 'STL', sha256: obj(p('openscad')?.stl)?.sha256 },
    { path: obj(p('openscad')?.png)?.path, role: 'render', sha256: obj(p('openscad')?.png)?.sha256 },
    ...list(p('freecad')?.fcstd).map((o) => ({ path: o.path, role: 'editable .FCStd', sha256: o.sha256 })),
    { path: obj(p('freecad')?.step)?.path, role: 'STEP', sha256: obj(p('freecad')?.step)?.sha256 },
    { path: obj(p('blender')?.blend)?.path, role: 'editable .blend', sha256: obj(p('blender')?.blend)?.sha256 },
    ...list(p('blender')?.renders).map((o) => ({ path: o.path, role: 'render', sha256: o.sha256 })),
    { path: obj(p('author')?.aep)?.path, role: 'editable .aep', sha256: obj(p('author')?.aep)?.sha256 },
    { path: obj(p('render')?.file)?.path, role: 'render', sha256: obj(p('render')?.file)?.sha256 },
  ];
  const seen = new Set<string>();
  return out.flatMap((o) => {
    const rel = str(o.path);
    if (!rel || rel.startsWith('/') || rel.split('/').includes('..') || seen.has(rel)) return [];
    // A source with no `after` was not changed by the flow: it is the source, not an output of the run.
    if (o.role.startsWith('the editable source') && !str(o.sha256)) return [];
    seen.add(rel);
    return [{ path: rel, role: o.role, ...(str(o.sha256) ? { sha256: String(o.sha256) } : {}) }];
  });
}

/** What to type to act on a file, by its kind. */
export function fileCommands(rel: string, role: string): string[] {
  const q = /\s/.test(rel) ? `"${rel}"` : rel;
  if (/\.(step|stp)$/i.test(rel)) return [`/inspect ${q}`, `/measure ${q}`];
  if (/\.stl$/i.test(rel)) return [`/measure ${q}`, `/inspect ${q}`];
  if (/\.blend$/i.test(rel)) return [`/measure ${q}`];
  if (/\.(png|jpe?g|webp|mp4|mov)$/i.test(rel)) return [`/inspect ${q}`];
  if (role.startsWith('the editable source')) return [`/open ${q}`, `/edit ${q}`];
  return [`/open ${q}`];
}

/** A file's check against the sha256 a record (sealed or not) gives it. */
function fileCheck(root: string, rel: string, sha256: string | undefined, sealed: { receipt?: string; verified: boolean; why?: string }): CardCheck {
  const now = shaNow(root, rel);
  if (now === null) return { status: 'missing', words: `gone since its run${sha256 ? ` (it was sha256 ${short(sha256)})` : ''}` };
  if (now === undefined) return { status: 'unverified', words: 'it cannot be read now' };
  if (now === 'large') return { status: 'unverified', words: `larger than ${HASH_LIMIT / 1024 / 1024} MB: not hashed here` };
  if (!sha256) return { status: 'unverified', words: `its record names no sha256 (sha256 ${short(now)} now)` };
  if (now !== sha256) return { status: 'stale', words: `changed since its run: sha256 ${short(now)} now, ${short(sha256)} as recorded`, ...(sealed.receipt ? { receipt: sealed.receipt } : {}) };
  return sealed.verified
    ? { status: 'verified', words: `sha256 ${short(sha256)}, as receipt ${sealed.receipt} sealed its record`, ...(sealed.receipt ? { receipt: sealed.receipt } : {}) }
    : { status: 'unverified', words: `sha256 ${short(sha256)} as its record says; ${sealed.why ?? 'no receipt sealed that record'}` };
}

function workflowParts(ix: OpIndex, id: string): CardWorkflow[] {
  const jobs = (ix.jobs.get(id) ?? []).filter((j) => j.kind === 'workflow');
  const predictions = (ix.receipts.get(id) ?? []).filter((r) => r.kind === 'predict');
  return jobs.map((j): CardWorkflow => {
    const label = ix.scrub(j.label);
    const m = /^(.*) › (\S+)$/.exec(label);
    const doc = m?.[1] ?? label;
    const block = m?.[2] ?? '';
    const p = predictions.find((r) => r.prediction?.doc === doc && r.prediction?.block === block);
    const predicted = p?.files?.find((f) => f.path === doc)?.sha256;
    const now = shaNow(ix.root, doc);
    const check: CardCheck = !p ? { status: 'unverified', words: 'no prediction receipt of this operation names the document' }
      : now === null ? { status: 'missing', words: `${doc} is gone since it ran`, receipt: shortReceipt(p) }
        : !predicted || typeof now !== 'string' ? { status: 'unverified', words: 'its sha256 could not be compared', receipt: shortReceipt(p) }
          : now === predicted ? { status: 'verified', words: `the document as it ran (sha256 ${short(now)}), as prediction receipt ${shortReceipt(p)} sealed it`, receipt: shortReceipt(p) }
            : { status: 'stale', words: `the document changed since it ran: sha256 ${short(now)} now, ${short(predicted)} when it ran (receipt ${shortReceipt(p)})`, receipt: shortReceipt(p) };
    const order = p?.prediction?.order ?? [];
    // R4 (H74): each block that ran with its own receipt
    const own = blockReceiptsOf(ix.chain, j.id);
    const steps: CardStep[] = j.steps.map((s) => ({ name: s.name, state: s.state, ...(s.code !== undefined ? { code: s.code } : {}), ...(own.get(s.name) ? { receipt: own.get(s.name)!.receipt } : {}) }));
    // R4 (H67, r20): a block with no step reads as the workflow card reads it: "not run" only where that is known
    const unseen = runBlocks(j, order);
    for (const name of order) if (!steps.some((s) => s.name === name)) steps.push({ name, state: unseen.find((b) => b.name === name)?.word ?? 'not run' });
    const state = j.stale ? `${j.state}; its process is gone` : j.state === 'cancelled' ? 'stopped' : j.state;
    return {
      doc, block, job: j.id, state, tone: toneOf(state), steps, check,
      commands: [...(block ? [`/run ${doc} ${block}`] : []), `/workflows ${doc}`, `/jobs ${j.id}`],
    };
  });
}

function flowParts(ix: OpIndex, id: string): { flows: CardFlow[]; outputs: CardOutput[] } {
  const flows: CardFlow[] = [];
  const outputs: CardOutput[] = [];
  for (const f of ix.flows.get(id) ?? []) {
    const r = f.record as unknown as Obj;
    const fid = String(r.id ?? '?');
    const kind = str(r.target) ?? 'tray';
    const outcome = String(r.outcome ?? 'unknown');
    const running = !!f.live && outcome === 'running';
    const verdict = str(obj(r.readback)?.verdict);
    const words = running ? `running: its ${String(r.step ?? '?')} step` : `${outcome}${verdict ? `; readback ${verdict}` : ''}${str(r.why) ? `: ${str(r.why)}` : ''}`;
    const verified = f.check.status === 'verified';
    const check: CardCheck = running
      ? { status: 'unverified', words: 'running: no record yet (its state file, as its session last wrote it)' }
      : verified ? { status: 'verified', words: `receipt ${f.check.receipt} sealed this record's bytes`, ...(f.check.receipt ? { receipt: f.check.receipt } : {}) }
        : { status: 'unverified', words: f.check.reasons.join('; ') || 'no flow receipt sealed this record' };
    let steps: RoomStep[] = [];
    try { steps = flowHandoff(r); } catch { steps = []; }
    flows.push({
      id: fid, kind, ...(str(r.instruction) ? { instruction: String(r.instruction) } : {}), outcome: running ? 'running' : outcome, verdict: words, tone: running ? 'running' : toneOf(outcome),
      steps: steps.map((s) => ({ name: s.name, state: String(s.state), owner: s.owner, role: roleOf('flow', '', stepKey(s.name)), ...(s.job ? { job: s.job } : {}), ...(s.receipt ? { receipt: s.receipt } : {}), ...(s.detail ? { detail: s.detail } : {}), ...(s.here ? { here: s.here } : {}) })),
      file: f.file, check,
      commands: [...(running ? [`/stop ${fid}`] : []), `/room ${fid}`, ...(running ? [] : [`/open ${f.file}`])],
    });
    if (running) continue;
    for (const o of flowOutputs(r)) {
      if (outputs.some((x) => x.path === o.path)) continue;
      outputs.push({ path: o.path, role: o.role, by: `flow ${fid}`, ...(o.sha256 ? { sha256: o.sha256 } : {}), check: fileCheck(ix.root, o.path, o.sha256, { verified, ...(f.check.receipt ? { receipt: f.check.receipt } : {}), why: f.check.reasons[0] }), commands: fileCommands(o.path, o.role) });
    }
  }
  return { flows, outputs };
}

/** A step's own key from the words the step strip names it by (src/repl/board-steps.ts). */
function stepKey(name: string): string {
  const n = name.toLowerCase();
  if (/agent/.test(n)) return 'agent';
  if (/check/.test(n)) return 'checks';
  if (/readback|read back|compare/.test(n)) return 'readback';
  if (/rebuild|build|recipe/.test(n)) return 'build';
  if (/openscad|export/.test(n)) return 'openscad';
  if (/freecad/.test(n)) return 'freecad';
  if (/blender/.test(n)) return 'blender';
  if (/render|aerender/.test(n)) return 'render';
  if (/author|after effects/.test(n)) return 'author';
  return n;
}

/** The files the operation's own native runs (not its flows') wrote, judged by their result files. */
function nativeOutputs(ix: OpIndex, id: string, known: CardOutput[]): CardOutput[] {
  const out: CardOutput[] = [];
  for (const run of ix.natives.get(id) ?? []) {
    let rec: ReturnType<typeof readNativeRecord>;
    try { rec = readNativeRecord(ix.root, run); } catch { rec = undefined; }
    const last = rec?.verdicts.at(-1);
    if (!rec || !last) continue;
    const sealed = ix.chain.find((r) => r.kind === 'native' && r.native?.run === run);
    for (const f of last.files ?? []) {
      const rel = str((f as { path?: unknown }).path);
      if (!rel || rel.startsWith('/') || known.some((k) => k.path === rel) || out.some((o) => o.path === rel)) continue;
      if (!(f as { present?: boolean }).present || !(f as { written?: boolean }).written) continue;
      const sha = str((f as { sha256?: unknown }).sha256);
      const sealedSha = sealed?.native?.files?.find((x) => x.path === rel)?.sha256;
      const verified = !!sealed && !!sha && sealedSha === sha;
      out.push({
        path: rel, role: 'written by its native run', by: `${rec.job.app} run ${run.slice(0, 8)}`, ...(sha ? { sha256: sha } : {}),
        check: fileCheck(ix.root, rel, sha, { verified, ...(sealed ? { receipt: shortReceipt(sealed) } : {}), why: sealed ? 'its native receipt names other bytes' : 'no native receipt names the run' }),
        commands: fileCommands(rel, ''),
      });
    }
  }
  return out;
}

function voxParts(ix: OpIndex, id: string, outputs: CardOutput[]): CardVox[] {
  const byOutput = new Map(outputs.filter((o) => o.sha256).map((o) => [o.path, o.sha256]));
  const out: CardVox[] = [];
  for (const v of ix.vox) {
    const mine = v.operation === id;
    const about = !mine && v.card.inputs.some((i) => i.sha256 && byOutput.get(i.path) === i.sha256);
    if (!mine && !about) continue;
    const c = v.card;
    // The receipt by the short id the REPL names receipts with (the newest vox receipt of this project sealing this path).
    const seal = [...ix.chain].reverse().find((r) => r.kind === 'vox' && r.outputs?.[0]?.path === c.file);
    const receipt = seal ? shortReceipt(seal) : undefined;
    const check: CardCheck = c.check.status === 'verified'
      ? { status: 'verified', words: `receipt ${receipt ?? '?'} sealed this record, and its inputs are the bytes it names`, ...(receipt ? { receipt } : {}) }
      : { status: c.check.status, words: ix.scrub(c.check.reasons.join('; ') || 'not verified'), ...(receipt ? { receipt } : {}) };
    const word = (x: unknown): string => (typeof x === 'number' ? String(Number(x.toPrecision(7))) : typeof x === 'string' ? x : JSON.stringify(x));
    // R4 (H61): each value's status word (stale or unknown when the record's check says so), then who measured it.
    const values = c.metrics.filter((m) => !m.malformed && !m.name.startsWith('file_')).slice(0, 6)
      .map((m) => `${m.title}: ${Array.isArray(m.value) ? m.value.map(word).join(' x ') : word(m.value)}${m.unit ? ` ${m.unit}` : ''} · ${m.said ? wordText(m.said) : 'unknown: no word recorded'} (${m.label ?? m.tier ?? 'who measured it is not named'})`);
    out.push({
      id: c.id, file: c.file, action: c.action, status: c.status, tone: toneOf(c.status), inputs: c.inputs.map((i) => ix.scrub(i.path)), values: values.map(ix.scrub),
      about: mine ? 'this operation' : 'its outputs', check,
      commands: [...(c.command ? [ix.scrub(c.command)] : []), `/open ${c.file}`],
    });
  }
  return out;
}

/** The project's lessons whose evidence names one of these files or receipts, or that name the operation; and the unreadable files. */
export function readLessons(ix: OpIndex, id: string, names: { files: Set<string>; receipts: Set<string>; given?: Map<string, string[]> }): { lessons: CardLesson[]; errors: string[] } {
  const lessons: CardLesson[] = [];
  const errors: string[] = [];
  let entries: string[];
  try { entries = fs.readdirSync(path.join(ix.root, LESSONS_DIR)).filter((n) => n.endsWith('.json')).sort(); } catch { return { lessons, errors }; }
  for (const n of entries.slice(0, MAX_LESSON_FILES)) {
    const rel = `${LESSONS_DIR}/${n}`;
    const r = readJson(ix.root, rel, 256 * 1024);
    if (!r.ok) { errors.push(`${rel}: ${r.error}`); continue; }
    const l = obj(r.value);
    if (!l || l.schema !== LESSON_SCHEMA) { errors.push(`${rel}: not a ${LESSON_SCHEMA} lesson`); continue; }
    const evidence = Array.isArray(l.evidence) ? l.evidence.map(obj).filter((e): e is Obj => !!e) : [];
    const names_ = (e: Obj): boolean => (str(e.path) !== undefined && names.files.has(String(e.path)))
      || (str(e.receipt) !== undefined && (names.receipts.has(String(e.receipt)) || names.receipts.has(String(e.receipt).slice(7, 15))));
    const lid = str(l.id) ?? n.slice(0, -5);
    const madeHere = l.operation === id || evidence.some(names_);
    const givenTo = names.given?.get(lid) ?? [];
    if (!madeHere && !givenTo.length) continue;
    const relation = [madeHere ? 'made from this operation\'s records' : '', givenTo.length ? `given to ${givenTo.join(', ')} as context when it started` : ''].filter(Boolean).join('; ');
    const checks = evidence.slice(0, 12).map((e) => {
      const what = [str(e.path) ? ix.scrub(String(e.path)) : '', str(e.receipt) ? `receipt ${String(e.receipt).replace(/^sha256_/, '').slice(0, 12)}` : ''].filter(Boolean).join(' · ') || '(names nothing)';
      const rel_ = str(e.path);
      const onChain = str(e.receipt) ? ix.chain.some((x) => x.hash === e.receipt || shortReceipt(x) === e.receipt || x.id === e.receipt) : undefined;
      if (rel_) {
        const c = fileCheck(ix.root, rel_, str(e.sha256), { verified: onChain === true, ...(str(e.receipt) ? { receipt: String(e.receipt).slice(0, 15) } : {}), why: onChain === false ? 'its receipt is not on this chain' : 'it names no receipt' });
        return { what, check: c.status === 'verified' ? { ...c, words: `sha256 ${short(str(e.sha256))} now as when it was checked; its receipt is on the chain` } : c };
      }
      return { what, check: onChain ? { status: 'verified' as const, words: 'its receipt is on the chain' } : { status: 'unverified' as const, words: onChain === false ? 'its receipt is not on this chain' : 'it names no file and no receipt' } };
    });
    const status = str(l.status) ?? 'unknown';
    const stale = checks.some((x) => x.check.status === 'stale' || x.check.status === 'missing');
    lessons.push({
      id: lid, file: rel, text: ix.scrub(String(l.text ?? '')).slice(0, 600), status: stale && status === 'checked' ? 'checked, but its evidence changed since' : status,
      tone: stale ? 'attention' : toneOf(status), evidence: checks, commands: [`/open ${rel}`], relation,
    });
  }
  if (entries.length > MAX_LESSON_FILES) errors.push(`${entries.length - MAX_LESSON_FILES} more lesson files were not read`);
  return { lessons, errors };
}

function runParts(ix: OpIndex, id: string, rec: OperationRecord | undefined, flows: CardFlow[], vox: CardVox[]): CardRun[] {
  const runs: CardRun[] = [];
  // The jobs a flow, an action, an agent run or a native run names are shown with it (its steps), not again on their own.
  const claimed = new Set<string>();
  for (const f of ix.flows.get(id) ?? []) for (const c of flowClaims(f.record)) claimed.add(c);
  for (const v of ix.vox) if (v.operation === id) for (const t of v.card.tools) if (t.job) claimed.add(`job:${t.job}`);
  for (const run of ix.agents.get(id) ?? []) { const r = readJson(ix.root, `${AGENTS_DIR}/${run}/run.json`); const j = r.ok ? str(obj(r.value)?.job) : undefined; if (j) claimed.add(`job:${j}`); }
  for (const run of ix.natives.get(id) ?? []) { const r = readJson(ix.root, `.timmy/native/${run}/started.json`); const j = r.ok ? str(obj(r.value)?.job) : undefined; if (j) claimed.add(`job:${j}`); }
  const add = (r: CardRun): void => { if (!runs.some((x) => x.kind === r.kind && x.id === r.id)) runs.push(r); };
  for (const f of flows) add({ kind: 'flow', id: f.id, role: roleOf('flow'), state: f.outcome, tone: f.tone });
  for (const v of vox.filter((x) => x.about === 'this operation')) add({ kind: 'vox', id: v.id, role: roleOf('vox'), state: v.status, tone: v.tone });
  for (const run of ix.agents.get(id) ?? []) {
    const r = readJson(ix.root, `${AGENTS_DIR}/${run}/result.json`);
    const outcome = r.ok ? str(obj(r.value)?.outcome) : undefined;
    // R4 (H59): no result, and its record ended by recovery after its REPL ended first: interrupted (no result was written).
    const started = outcome ? undefined : readJson(ix.root, `${AGENTS_DIR}/${run}/run.json`);
    const interrupted = started?.ok && obj(started.value)?.state === 'interrupted';
    const state = outcome ?? (interrupted ? 'interrupted (no result was written)' : 'running or not finished');
    add({ kind: 'agent', id: run, role: roleOf('agent'), state, tone: toneOf(outcome ?? (interrupted ? 'interrupted' : 'running')) });
  }
  for (const run of ix.natives.get(id) ?? []) add({ kind: 'native', id: run.slice(0, 8), role: roleOf('native'), state: 'native run', tone: 'neutral' });
  for (const j of ix.jobs.get(id) ?? []) {
    if (claimed.has(`job:${j.id}`)) continue;
    const state = j.stale ? `${j.state}; its process is gone` : j.state === 'cancelled' ? 'stopped' : j.state;
    add({ kind: j.kind === 'workflow' ? 'workflow run' : 'job', id: j.id, role: j.kind === 'workflow' ? 'role not recorded (a workflow run: its blocks act)' : roleOf('job', j.label), state, tone: toneOf(state) });
  }
  for (const m of ix.mcps.get(id) ?? []) add({ kind: 'mcp', id: m, role: roleOf('mcp'), state: 'MCP call', tone: 'neutral' });
  for (const r of rec?.runs ?? []) if (!claimed.has(`${r.kind}:${r.id}`) && !runs.some((x) => x.id === r.id || x.id === r.id.slice(0, 8))) add({ kind: r.kind, id: r.id, role: roleOf(r.kind), state: 'named by its operation record', tone: 'neutral' });
  return runs;
}

/** One operation's card, from the index. */
export function operationCard(ix: OpIndex, id: string): OperationCard {
  const held = ix.records.get(id);
  let rec = held?.record;
  let recordError: string | undefined;
  if (!rec) {
    const r = readOperationRecord(ix.root, id);
    if (r.ok) rec = r.record; else recordError = r.error;
  }
  let state: string = rec?.state ?? 'not recorded here';
  let note: string | undefined;
  if (rec && rec.ended === null) {
    const w = writerState(rec.owner);
    if (w === 'gone') { state = 'interrupted'; note = 'its record says it runs, and the Timmy that wrote it has ended: it was left as it was'; }
  }
  const workflows = workflowParts(ix, id);
  const { flows, outputs } = flowParts(ix, id);
  outputs.push(...nativeOutputs(ix, id, outputs));
  const vox = voxParts(ix, id, outputs);
  const receipts = (ix.receipts.get(id) ?? []).map((r) => ({ id: shortReceipt(r), kind: r.kind, ...(r.status ? { status: r.status } : {}) }));
  const files = new Set<string>([
    operationRel(id), ...flows.map((f) => f.file), ...outputs.map((o) => o.path), ...vox.map((v) => v.file), ...workflows.map((w) => w.doc),
    ...(ix.agents.get(id) ?? []).map((a) => `${AGENTS_DIR}/${a}/result.json`),
  ]);
  const receiptIds = new Set<string>([...receipts.map((r) => r.id), ...(ix.receipts.get(id) ?? []).map((r) => String(r.hash))]);
  // The lessons this operation's flows were given (each flow record's `lessons`, Timmy Memory's retrieval): r19 saw a
  // reuse whose card said no lesson, while its flow record and receipt named the one it was given.
  const given = new Map<string, string[]>();
  const usedBy = (file: string, who: string): void => {
    const r = readJson(ix.root, file, 2 * 1024 * 1024);
    const used = r.ok ? obj(r.value)?.lessons : undefined;
    if (!Array.isArray(used)) return;
    for (const u of used.map(obj)) {
      const lid = u ? str(u.id) : undefined;
      if (lid && !(given.get(lid) ?? []).includes(who)) given.set(lid, [...(given.get(lid) ?? []), who]);
    }
  };
  for (const f of flows) usedBy(f.file, `flow ${f.id}`);
  for (const run of ix.agents.get(id) ?? []) usedBy(`${AGENTS_DIR}/${run}/run.json`, `agent run ${run}`); // a plain /agent's task
  const { lessons, errors } = readLessons(ix, id, { files, receipts: receiptIds, given });
  const runs = runParts(ix, id, rec, flows, vox);
  return {
    id, request: rec ? ix.scrub(rec.request) : '(no record of its request in this project)', ...(rec ? { via: rec.via, started: rec.started, ended: rec.ended, parent: rec.parent } : {}),
    state, tone: toneOf(state), ...(rec?.why ? { why: ix.scrub(rec.why) } : {}), ...(note ? { note } : {}),
    ...(rec ? { record: operationRel(id) } : { recordError: recordError ?? 'no record' }),
    workflows, flows, outputs, vox, lessons, lessonErrors: errors, runs, receipts: receipts.slice(-40),
    commands: [`/op ${id}`, '/ops', '/room'],
  };
}

/**
 * The Control Room's runs (src/room), each with the operation its own record or receipt names (a flow, agent run, native
 * run or MCP call by its record; any run by its job's record; a turn or an observation by its receipt) and its role in
 * words from its kind (roleOf). A run nothing names an operation for keeps none: it is not given one.
 */
export function annotateRoom(room: { all: Array<{ kind: string; id: string; job?: string; receipt?: string; step?: string; operation?: string; role?: string }> }, ix: OpIndex, jobs: readonly JobRecord[]): void {
  const jobOp = new Map(jobs.flatMap((j) => (j.operation ? [[j.id, j.operation] as const] : [])));
  const reverse = (m: Map<string, string[]>): Map<string, string> => { const out = new Map<string, string>(); for (const [op, ids] of m) for (const id of ids) out.set(id, op); return out; };
  const agentOp = reverse(ix.agents);
  const nativeOp = reverse(ix.natives);
  const mcpOp = reverse(ix.mcps);
  const flowOp = new Map<string, string>();
  for (const [op, list] of ix.flows) for (const f of list) flowOp.set(String(f.record.id), op);
  const receiptOp = new Map<string, string>();
  for (const [op, list] of ix.receipts) for (const r of list) receiptOp.set(shortReceipt(r), op);
  for (const r of room.all) {
    const own = r.kind === 'flow' ? flowOp.get(r.id) : r.kind === 'agent' ? agentOp.get(r.id) : r.kind === 'native' ? nativeOp.get(r.id) : r.kind === 'mcp' ? mcpOp.get(r.id) : undefined;
    const op = own ?? (r.job ? jobOp.get(r.job) : undefined) ?? (r.kind === 'job' ? jobOp.get(r.id) : undefined) ?? (r.receipt ? receiptOp.get(r.receipt) : undefined);
    if (op) r.operation = op;
    r.role = roleOf(r.kind, r.step ?? '');
  }
}

/** The operations to show: those running first, then the newest, at most `max`. */
export function recentOperations(ix: OpIndex, max = 6): string[] {
  const ids = knownOperations(ix);
  const startOf = (id: string): number => {
    const r = ix.records.get(id)?.record;
    if (r) return Date.parse(r.started) || 0;
    const j = ix.jobs.get(id)?.[0];
    if (j) return Date.parse(j.startedAt) || 0;
    const rc = ix.receipts.get(id)?.[0];
    return rc ? Date.parse(rc.ts) || 0 : 0;
  };
  const running = (id: string): boolean => {
    const r = ix.records.get(id)?.record;
    return !!r && r.ended === null && writerState(r.owner) !== 'gone';
  };
  return ids.sort((a, b) => Number(running(b)) - Number(running(a)) || startOf(b) - startOf(a)).slice(0, max);
}
