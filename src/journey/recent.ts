/**
 * R10 (H164): the project's recent work, ONE list for the terminal Workbench's Home, the companion and Studio (journey steps 1
 * and 3: "Open Timmy and immediately understand the active project and the next action"; "Open a project artifact"), newest
 * first. Each item: its kind, its id, a few plain words, when, its state, its receipt (its id and whether it verifies here,
 * now) and where it opens (./open.ts openTarget).
 *
 *   kind          read from (each reader reads at most what the list can show)
 *   turn          the runs chain, newest first (src/repl/seal.ts chatTurnOf: every surface's turn of this project); its
 *                 words are its operation's request (the receipt holds hashes only), its route what its receipt sealed
 *   run           the project's operation records (.timmy/operations: the names listed once, each file's time read, the
 *                 newest records read); its own receipt as the Chat tab's pipeline row picks it (its workflow receipt, else
 *                 its newest that is not the prediction); the outputs its receipts sealed are its results (receiptOutputs,
 *                 the run inspection's rule)
 *   mesh,         the project's files in the folders where references and results live (refs/, assets/, inputs/, media/,
 *   recording,    uploads/, docs/, out/, outputs/, results/, renders/, exports/, models/, scenes/, and the top's own mesh,
 *   reference,    recording and image files), at most RECENT_CAPS.fileEntries entries and RECENT_CAPS.fileDepth folders deep;
 *   result        a VoxVision record's folder is the observation's, a run's result is the run's
 *   observation   the VoxVision records (src/vox/preview.ts listVoxRecords: the tab 5 list's own reading, its receipt state)
 *   draft         Studio's saved board of the project: each draft Timmy proposed that waits for Accept or Discard, once
 *   receipt       the chain's other receipts of the project (none that is a listed turn's, run's or observation's)
 *
 * Bounded (R9's item B was a synchronous walk of a large folder): no reader walks the whole project, every folder read and
 * every chain scan stops at a fixed cap (RECENT_CAPS), and what was left out is said in `notes`. The receipts of the items
 * listed are verified once per epoch (the newest one's chain link and body up to it, then each one's signature), never one
 * chain walk per receipt. Reads files only: nothing runs, seals, writes or asks the network.
 */
import { lstatSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { basename, join } from 'node:path';
import { chatTurnOf } from '../repl/seal.js';
import { readOperationRecord, type OperationRecord } from '../ops/operations.js';
import { privatePath, projectId } from '../project/index.js';
import { boardDir } from '../studio/boards.js';
import { canvasDir } from '../studio/document.js';
import { readChain, verifyReceiptIn, verifySignature, type Receipt } from '../utils/receipts.js';
import { listVoxRecords } from '../vox/preview.js';
import { VOX_DIR } from '../vox/record.js';
import { DRAFT_ID, OPERATION_ID, openTarget, type OpenKind, type OpenTarget } from './open.js';
import { FAKE_NAME, routeTaken, type RouteTaken } from './route.js';

type Env = Record<string, string | undefined>;

export type WorkKind = OpenKind;
/** An item's state in the shared words: a turn answered, stopped or failed; a run completed, running, waiting on you, failed,
 *  cancelled, no change …; a file saved; a draft; a receipt sealed. */
export type WorkState = 'answered' | 'stopped' | 'completed' | 'running' | 'waiting on you' | 'failed' | 'cancelled' | 'refused' | 'differs'
  | 'interrupted' | 'no change' | 'needs setup' | 'untrusted' | 'partial' | 'saved' | 'draft' | 'sealed' | 'unknown';

export interface WorkItem {
  kind: WorkKind;
  /** a turn's or receipt's short receipt id (8 hex), a run's operation id, a file's path in the project, a record's or draft's id */
  id: string;
  /** a few plain words: a turn's question, a run's request, a file's name, an observation's action and input */
  title: string;
  /** when (ISO): a turn's seal, a run's end (else its start), a file's last change, a record's making, a draft's proposing */
  when: string | null;
  state: WorkState;
  /** its receipt: the short id, and whether it verifies here now (its chain link, body and signature); `why` when it does not */
  receipt: { id: string; verified: boolean; why?: string } | null;
  /** where it opens (./open.ts) */
  open: OpenTarget;
  /** a FAKE stand-in or FAKE content (its record or its model says FAKE) */
  fake: boolean;
  /** the operation it belongs to (a turn's, a run's own id, a record's) */
  operation?: string | null;
  /** a turn: what it took, from its receipt (./route.ts routeTaken) */
  route?: RouteTaken;
  /** a run: the files its receipts name, in the project (at most RESULTS_MAX) */
  results?: string[];
}

export interface RecentWork {
  project: { name: string; id: string };
  items: WorkItem[];
  /** what was left out or could not be read, in words */
  notes: string[];
}

export interface WorkCtx {
  /** the project shown: its name and folder */
  project: { name: string; root: string };
  env?: Env;
  /** the runs chain as the surface read it (the Workbench's); else read from the project's store (TIMMY_STORE, else its own) */
  chain?: readonly Receipt[];
}

export interface RecentCaps {
  /** receipts read from the chain's end */
  chainScan: number;
  /** operation records whose times are read (the newest of them are read) */
  operations: number;
  /** folder entries the file reader looks at, in all */
  fileEntries: number;
  /** how deep the file reader goes in an artifact folder */
  fileDepth: number;
  /** the largest Studio board file read for its drafts */
  boardBytes: number;
}
export const RECENT_CAPS: Readonly<RecentCaps> = Object.freeze({ chainScan: 5000, operations: 2000, fileEntries: 800, fileDepth: 4, boardBytes: 32 * 1024 * 1024 });
/** How many of a run's results an item names. */
export const RESULTS_MAX = 8;
const TITLE_MAX = 80;

/** The folders references and results live in (src/project's REFERENCE_TOP and OUTPUT_TOP, without build's dist and build). */
const REFERENCE_TOP = new Set(['refs', 'ref', 'references', 'reference', 'assets', 'inputs', 'docs', 'uploads', 'media', 'models', 'scenes']);
const OUTPUT_TOP = new Set(['out', 'outputs', 'output', 'results', 'renders', 'exports']);
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.cache', 'coverage', '.turbo', '.next']);
const MESH_EXT = new Set(['stl', 'obj', 'ply']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const extOf = (path: string): string => (/\.([A-Za-z0-9]+)$/.exec(path)?.[1] ?? '').toLowerCase();

const cut = (s: string, max = TITLE_MAX): string => { const one = s.replace(/\s+/g, ' ').trim(); return one.length > max ? `${one.slice(0, max - 1)}…` : one; };
const shortOf = (r: Pick<Receipt, 'hash'>): string => String(r.hash).slice(7, 15);
const iso = (ms: number): string | null => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
const FAKE_WORD = /\bFAKE\b/;

/** The runs chain the project's seals go to (TIMMY_STORE, else the project's own store), as every reader of it reads it. */
function chainOf(root: string, env: Env): Receipt[] {
  try { return env.TIMMY_STORE ? readChain('runs') : readChain('runs', root); } catch { return []; }
}

/** A run's request in plain words: "/run REPORT.md report" is "Workflow run: report in REPORT.md"; "/iterate x" "Iterate: x". */
export function runTitle(request: string): string {
  const r = request.replace(/\s+/g, ' ').trim();
  const run = /^\/run (\S+) (\S+)/.exec(r);
  if (run) return cut(`Workflow run: ${run[2]} in ${run[1]}`);
  const cmd = /^\/([a-z][a-z-]*)(?: (.*))?$/.exec(r);
  if (cmd) return cut(`${cmd[1][0].toUpperCase()}${cmd[1].slice(1).replace(/-/g, ' ')}${cmd[2] ? `: ${cmd[2]}` : ''}`);
  return cut(r || 'a request with no words recorded');
}

/** An operation's state in the shared words (src/contracts/stop-words.ts: a stopped job is cancelled; a chat turn's is stopped). */
export function runState(r: Pick<OperationRecord, 'state' | 'runs'>): WorkState {
  switch (r.state) {
    case 'running': return 'running';
    case 'succeeded': return 'completed';
    case 'answered': return 'answered';
    case 'stopped': return r.runs.length > 0 ? 'cancelled' : 'stopped';
    case 'failed': case 'refused': case 'differs': case 'interrupted': case 'no change': return r.state;
    default: return 'unknown';
  }
}

const VOX_STATE: Readonly<Record<string, WorkState>> = { ok: 'completed', failed: 'failed', cancelled: 'cancelled', 'needs-setup': 'needs setup', untrusted: 'untrusted', partial: 'partial' };

/**
 * Whether each of `hashes` verifies on `chain` where it stands: per epoch, the newest one's chain link and body up to it
 * (verifyReceiptIn), which covers every earlier one of that epoch, then each one's own signature; when that newest one does
 * not verify, each one is verified on its own (a break after a receipt does not count against it).
 */
export function verifyMany(chain: readonly Receipt[], hashes: readonly string[]): Map<string, { ok: true } | { ok: false; reason: string }> {
  const out = new Map<string, { ok: true } | { ok: false; reason: string }>();
  const at = new Map<string, number>();
  const wanted = new Set(hashes);
  chain.forEach((r, i) => { if (wanted.has(r.hash)) at.set(r.hash, i); });
  const byEpoch = new Map<number, string[]>();
  for (const h of wanted) {
    const i = at.get(h);
    if (i === undefined) { out.set(h, { ok: false, reason: 'it is not on the chain' }); continue; }
    const e = chain[i].epoch ?? 1;
    byEpoch.set(e, [...(byEpoch.get(e) ?? []), h]);
  }
  for (const list of byEpoch.values()) {
    const newest = list.reduce((a, b) => (at.get(a)! >= at.get(b)! ? a : b));
    const v = verifyReceiptIn(chain, newest);
    if (v.ok) {
      for (const h of list) out.set(h, h === newest || verifySignature(chain[at.get(h)!]) ? { ok: true } : { ok: false, reason: 'its signature does not verify' });
    } else {
      for (const h of list) { const one = h === newest ? v : verifyReceiptIn(chain, h); out.set(h, one.ok ? { ok: true } : { ok: false, reason: one.reason }); }
    }
  }
  return out;
}

/** A path a record may name as a file of the project: relative, inside it, not Timmy's own records (.timmy). */
const projectFile = (p: unknown): p is string => typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !p.startsWith('~')
  && !p.split(/[\\/]/).includes('..') && !p.split(/[\\/]/).includes('.timmy');

/**
 * The files a run made, as its receipts name them: the outputs its workflow, task, recipe or preview receipts sealed (the run
 * inspection's own rule: src/ops/run-detail.ts outputsInspected), in the order sealed, each once.
 */
export function receiptOutputs(receipts: readonly Receipt[]): string[] {
  const out: string[] = [];
  for (const r of receipts) {
    if (r.kind !== 'workflow' && r.kind !== 'task' && r.kind !== 'recipe' && r.kind !== 'preview') continue;
    for (const o of r.outputs ?? []) { const p = typeof o?.path === 'string' ? o.path.replace(/^\.\//, '') : o?.path; if (projectFile(p) && !out.includes(p)) out.push(p); }
  }
  return out;
}

interface Cand { item: Omit<WorkItem, 'receipt'> & { receipt: WorkItem['receipt'] }; at: number; hash?: string }

/** The project's operation records, the newest first, at most `want` read (their names listed once, each one's time read). */
function newestOperations(root: string, want: number, caps: RecentCaps, notes: string[]): OperationRecord[] {
  const dir = join(root, '.timmy', 'operations');
  let names: string[];
  try { names = readdirSync(dir).filter((n) => /^o[0-9a-f]{8}\.json$/.test(n)); } catch { return []; }
  if (names.length > caps.operations) {
    notes.push(`The project has ${names.length} operation records: the times of ${caps.operations} of them were read, so an older run may be left out.`);
    names = names.slice(0, caps.operations);
  }
  const timed = names.map((n) => { let t = 0; try { t = statSync(join(dir, n)).mtimeMs; } catch { t = 0; } return { n, t }; }).sort((a, b) => b.t - a.t || (a.n < b.n ? 1 : -1));
  const out: OperationRecord[] = [];
  for (const { n } of timed.slice(0, want)) {
    const r = readOperationRecord(root, n.slice(0, -5));
    if (r.ok) out.push(r.record); else notes.push(`${r.rel} could not be read as an operation record: ${r.error}.`);
  }
  return out;
}

/** The project's artifact files (references, results, meshes, recordings), the newest first, within the caps. */
function artifactFiles(root: string, caps: RecentCaps, notes: string[]): Array<{ rel: string; mtimeMs: number; top: 'reference' | 'result' | 'top' }> {
  const found: Array<{ rel: string; mtimeMs: number; top: 'reference' | 'result' | 'top' }> = [];
  let seen = 0;
  let stopped = false;
  const look = (dirRel: string, depth: number, top: 'reference' | 'result'): void => {
    if (stopped || depth > caps.fileDepth) return;
    let entries: Dirent[];
    try { entries = readdirSync(join(root, dirRel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (seen >= caps.fileEntries) { stopped = true; return; }
      seen += 1;
      const rel = `${dirRel}/${e.name}`;
      if (e.name.startsWith('.') || e.isSymbolicLink() || privatePath(rel) || rel === VOX_DIR || rel.startsWith(`${VOX_DIR}/`)) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) look(rel, depth + 1, top); continue; }
      if (!e.isFile()) continue;
      try { found.push({ rel, mtimeMs: lstatSync(join(root, rel)).mtimeMs, top }); } catch { /* gone since */ }
    }
  };
  let tops: Dirent[];
  try { tops = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  for (const e of tops) {
    if (stopped) break;
    if (seen >= caps.fileEntries) { stopped = true; break; }
    seen += 1;
    if (e.name.startsWith('.') || e.isSymbolicLink() || privatePath(e.name)) continue;
    if (e.isDirectory()) {
      if (REFERENCE_TOP.has(e.name)) look(e.name, 1, 'reference');
      else if (OUTPUT_TOP.has(e.name)) look(e.name, 1, 'result');
      continue;
    }
    // the top's own meshes, recordings and images (a workflow document or a source file is not an artifact)
    const x = extOf(e.name);
    if (e.isFile() && (MESH_EXT.has(x) || x === 'rrd' || IMAGE_EXT.has(x))) { try { found.push({ rel: e.name, mtimeMs: lstatSync(join(root, e.name)).mtimeMs, top: 'top' }); } catch { /* gone */ } }
  }
  if (stopped) notes.push(`Not all files were looked at: the reader stops after ${caps.fileEntries} folder entries, so an older file may be left out.`);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs || a.rel.localeCompare(b.rel));
}

const boardSeen = new Map<string, { key: string; drafts: Array<{ id: string; job: string | null; at: string | null }> | null }>();

/** The drafts on Studio's saved board of the project, each once (its id, the job that made it, when), or null when unreadable. */
function boardDrafts(root: string, env: Env, caps: RecentCaps): Array<{ id: string; job: string | null; at: string | null }> | null {
  let file: string;
  try { file = join(boardDir(canvasDir(env), projectId(root)), 'canvas.json'); } catch { return null; }
  let key: string;
  try {
    const st = statSync(file);
    if (st.size > caps.boardBytes) return null;
    key = `${st.mtimeMs}:${st.size}`;
  } catch (e) { return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? [] : null; }
  const kept = boardSeen.get(file);
  if (kept && kept.key === key) return kept.drafts;
  let drafts: Array<{ id: string; job: string | null; at: string | null }> | null = null;
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { format?: unknown; snapshot?: { store?: unknown } };
    const store = saved?.snapshot?.store;
    if (saved.format === 'timmy-canvas' && store && typeof store === 'object') {
      const byId = new Map<string, { id: string; job: string | null; at: string | null }>();
      for (const r of Object.values(store as Record<string, unknown>)) {
        const rec = r as { typeName?: unknown; meta?: { timmyDraft?: { id?: unknown; job?: unknown; at?: unknown } } } | null;
        const d = rec && rec.typeName === 'shape' ? rec.meta?.timmyDraft : undefined;
        if (!d || typeof d.id !== 'string' || !DRAFT_ID.test(d.id) || byId.has(d.id)) continue;
        byId.set(d.id, { id: d.id, job: typeof d.job === 'string' ? d.job : null, at: typeof d.at === 'string' ? d.at : null });
      }
      drafts = [...byId.values()];
    }
  } catch { drafts = null; }
  boardSeen.set(file, { key, drafts });
  if (boardSeen.size > 64) boardSeen.delete(boardSeen.keys().next().value!);
  return drafts;
}

/**
 * The project's `limit` newest items of work, newest first (an item with no time last). `o.caps`: the readers' caps (a test's
 * smaller ones). Read once per reading of a surface, not once per frame.
 */
export function recentWork(ctx: WorkCtx, limit = 12, o: { caps?: RecentCaps } = {}): RecentWork {
  const caps = o.caps ?? RECENT_CAPS;
  const env = ctx.env ?? process.env;
  const root = ctx.project.root;
  const pid = projectId(root);
  const want = Math.max(0, Math.floor(limit));
  const notes: string[] = [];
  const project = { name: ctx.project.name, id: pid };
  if (want === 0) return { project, items: [], notes };
  const chain = ctx.chain ?? chainOf(root, env);
  const cands: Cand[] = [];

  // ── the chain, newest first: the project's turns, each operation's receipts, the other receipts ──
  const turns: Receipt[] = [];
  const byOp = new Map<string, Receipt[]>();
  const loose: Receipt[] = [];
  let i = chain.length - 1;
  for (let read = 0; i >= 0 && read < caps.chainScan; i -= 1, read += 1) {
    const r = chain[i];
    const foreign = typeof r.project_id === 'string' && r.project_id !== pid;
    if (foreign) continue;
    if (chatTurnOf(r)) { if (r.project_id === pid && turns.length < want) turns.push(r); continue; }
    const op = typeof r.operation_id === 'string' && OPERATION_ID.test(r.operation_id) ? r.operation_id : null;
    if (op) { byOp.set(op, [...(byOp.get(op) ?? []), r]); continue; }
    if (r.project_id === pid && r.kind !== 'vox' && loose.length < want) loose.push(r);
  }
  if (i >= 0) notes.push(`Only the newest ${caps.chainScan} receipts were read: older turns and receipts are not listed.`);

  // the turns: their words from their operation's request (a receipt holds hashes only)
  const turnOps = new Set<string>();
  for (const r of turns) {
    const op = typeof r.operation_id === 'string' && OPERATION_ID.test(r.operation_id) ? r.operation_id : null;
    if (op) turnOps.add(op);
    const rec = op ? readOperationRecord(root, op) : null;
    const route = routeTaken(r)!;
    const status = r.status ?? 'ok';
    const id = shortOf(r);
    cands.push({
      at: Date.parse(r.ts), hash: r.hash,
      item: {
        kind: 'turn', id, title: rec?.ok ? cut(rec.record.request) : `A chat turn in ${route.surface === 'repl' ? 'the REPL' : `the ${route.surface}`} (its words are not recorded)`,
        when: r.ts ?? null, state: status === 'ok' ? 'answered' : status === 'cancelled' ? 'stopped' : 'failed',
        receipt: null, open: openTarget({ kind: 'turn', id }), fake: route.fake || (rec?.ok ? FAKE_WORD.test(rec.record.request) : false), operation: op, route,
      },
    });
  }

  // ── the runs: the newest operation records; their own receipt and results from the chain ──
  const claimed = new Set<string>();
  for (const rec of newestOperations(root, want + turnOps.size, caps, notes)) {
    if (turnOps.has(rec.id)) continue;
    const mine = byOp.get(rec.id) ?? [];
    // its own receipt: its workflow's, else its newest that is not the prediction (the pipeline row's rule)
    const own = mine.find((r) => r.kind === 'workflow') ?? mine.find((r) => r.kind !== 'predict');
    // (mine is newest first: the outputs in the order they were sealed)
    const results = receiptOutputs([...mine].reverse()).slice(0, RESULTS_MAX);
    for (const f of results) claimed.add(f);
    const when = rec.ended ?? rec.started;
    cands.push({
      at: Date.parse(when), ...(own ? { hash: own.hash } : {}),
      item: {
        kind: 'run', id: rec.id, title: runTitle(rec.request), when, state: runState(rec), receipt: null,
        open: openTarget({ kind: 'run', id: rec.id }), fake: FAKE_WORD.test(rec.request), operation: rec.id, ...(results.length ? { results } : {}),
      },
    });
  }

  // ── the files: references, results, meshes and recordings, in the folders where they live ──
  let files = 0;
  for (const f of artifactFiles(root, caps, notes)) {
    if (files >= want) break;
    if (claimed.has(f.rel)) continue;
    const x = extOf(f.rel);
    const kind: OpenKind = MESH_EXT.has(x) ? 'mesh' : x === 'rrd' ? 'recording' : f.top === 'result' ? 'result' : 'reference';
    files += 1;
    cands.push({ at: f.mtimeMs, item: { kind, id: f.rel, title: cut(basename(f.rel)), when: iso(f.mtimeMs), state: 'saved', receipt: null, open: openTarget({ kind, id: f.rel }), fake: FAKE_WORD.test(basename(f.rel)), operation: null } });
  }

  // ── the VoxVision observations (tab 5's own list and receipt state) ──
  try {
    const vox = listVoxRecords({ root, chain, env: env as NodeJS.ProcessEnv }, want);
    for (const u of vox.unreadable) notes.push(`${u.file} is not listed: ${u.why}.`);
    for (const v of vox.records) {
      const input = v.inputs[0]?.path;
      const at = Date.parse(v.madeAt ?? '');
      cands.push({
        at,
        item: {
          kind: 'observation', id: v.id, title: cut(`${v.action}${input ? ` ${basename(input)}` : ''}`), when: Number.isFinite(at) ? v.madeAt! : null,
          state: VOX_STATE[v.status] ?? 'unknown',
          receipt: v.receipt.short ? { id: v.receipt.short, verified: v.receipt.verified, ...(v.receipt.verified ? {} : { why: v.receipt.words }) } : null,
          open: openTarget({ kind: 'observation', id: v.id }), fake: v.fake, operation: null,
        },
      });
    }
  } catch (e) { notes.push(`The VoxVision records could not be read: ${e instanceof Error ? e.message : String(e)}.`); }

  // ── Studio's drafts waiting for Accept or Discard ──
  const drafts = boardDrafts(root, env, caps);
  if (drafts === null) notes.push('Studio\'s saved board of this project could not be read, so its drafts are not listed.');
  for (const d of (drafts ?? []).slice(0, want)) {
    const at = Date.parse(d.at ?? '');
    cands.push({ at, item: { kind: 'draft', id: d.id, title: 'A draft Timmy proposed on the Studio board', when: Number.isFinite(at) ? d.at : null, state: 'draft', receipt: null, open: openTarget({ kind: 'draft', id: d.id }), fake: false, operation: null } });
  }

  // ── the other receipts ──
  for (const r of loose) {
    const kind = String(r.kind ?? 'receipt');
    const subject = String(r.subject ?? '').trim();
    cands.push({
      at: Date.parse(r.ts), hash: r.hash,
      item: {
        kind: 'receipt', id: shortOf(r), title: cut(subject.startsWith(`${kind} `) || !subject ? subject || kind : `${kind} · ${subject}`), when: r.ts ?? null,
        state: 'sealed', receipt: null, open: openTarget({ kind: 'receipt', id: shortOf(r) }), fake: FAKE_WORD.test(`${subject} ${JSON.stringify(r.sources ?? '')}`) || FAKE_NAME.test(String((r as { model_requested?: unknown }).model_requested ?? '')), operation: null,
      },
    });
  }

  // newest first (no time last), the newest `limit`; then their receipts verified, once per epoch
  const time = (c: Cand): number => (Number.isFinite(c.at) ? c.at : -Infinity);
  const top = cands.sort((a, b) => time(b) - time(a)).slice(0, want);
  const hashes = top.flatMap((c) => (c.hash ? [c.hash] : []));
  const checked = hashes.length ? verifyMany(chain, hashes) : new Map();
  const items = top.map((c): WorkItem => {
    if (!c.hash) return c.item;
    const v = checked.get(c.hash);
    const id = c.hash.slice(7, 15);
    return { ...c.item, receipt: v?.ok ? { id, verified: true } : { id, verified: false, why: v ? v.reason : 'it was not checked' } };
  });
  return { project, items, notes };
}
