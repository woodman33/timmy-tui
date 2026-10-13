/**
 * Round R4 (H102): `timmy evidence <flow|step|vox>`, the one record or file of an operation that a workflow block needs,
 * found by the operation's id and never by a file's time. The operator's rule: never pick the newest file by timestamp
 * and treat it as this run's evidence. The tray template's blocks did (`ls -t … | head -n 1`) until this.
 *
 * Each block of a /run runs inside the run's operation (TIMMY_OPERATION, src/ops/context.ts), and every record a
 * `timmy act` of that block makes names it (`operation`): the flow its change block ran, the VoxVision record its inspect
 * block made. So a block asks for its own run's evidence by that id:
 *
 *   flow   the operation's flow record (results/flows/<id>.json); with --outcome, how that flow ended (its record's word:
 *          succeeded, no change, …) instead of its path, so a block can say only what ran (R4 H102, part 2);
 *   step   the STEP that flow delivered (its rebuild's export, the STEP its readback read, or FreeCAD's export); or, when
 *          the flow made no change and its own check found the last build current, that build's STEP (the export its
 *          check names with the sha256 it found);
 *   stl    the same for an STL (its rebuild's export, or OpenSCAD's export of a /iterate scad flow; when it made no change,
 *          the last build's STL its check found current) (R4 H102, part 2: the tests' `ls -t out/scad/…` lines);
 *   vox    the operation's VoxVision record (results/vox/<id>.json); with --of <file>, the one whose input is that file.
 *
 * It prints exactly one project-relative path on stdout, and on stderr how it was found; or it refuses, exit 1, saying
 * why: none (no record of the operation; records of other operations are never taken, and a file that cannot be read is
 * named, since whether it is this operation's is not known), more than one (each named), not in this operation (--id
 * names another operation's record), or not usable. A record is taken only while a receipt of this project on the runs
 * chain names its bytes and that receipt names no other operation; a file only while its sha256 is the one its record
 * names. Outside an operation (no TIMMY_OPERATION, no --operation) it refuses with exit 2. Nothing here runs, writes or
 * seals: it reads records, the chain and the files they name.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FLOWS_DIR, NO_CHANGE } from '../flows/iterate.js';
import { projectId, resolveInside } from '../project/index.js';
import { readChain, type Receipt } from '../utils/receipts.js';
import { VOX_DIR } from '../vox/record.js';
import { OPERATION_ENV, OPERATION_ID } from './context.js';

export const EVIDENCE_USAGE = 'timmy evidence <flow|step|stl|vox> [--of <file>] [--id <record>] [--operation <id>] [--project <dir>] [--outcome] [--json]';
export const EVIDENCE_SCHEMA = 'timmy.evidence/1';

export type EvidenceWhat = 'flow' | 'step' | 'stl' | 'vox';
export const EVIDENCE_WHAT: readonly EvidenceWhat[] = ['flow', 'step', 'stl', 'vox'];
/** The files a flow names that a block can ask for, each with its word and the names it takes (R4 H102, part 2: stl). */
export type FlowFileKind = 'step' | 'stl';
const FILE_KIND: Readonly<Record<FlowFileKind, { name: string; re: RegExp }>> = {
  step: { name: 'STEP', re: /\.(step|stp)$/i },
  stl: { name: 'STL', re: /\.stl$/i },
};
/** Why no single answer was given: refused with exit 1. */
export type EvidenceRefusal = 'none' | 'more than one' | 'not in this operation' | 'not usable';

/** A record as found: its kind, id, place, sha256 now and the receipt that sealed those bytes. */
export interface EvidenceRecord { kind: 'flow' | 'vox'; id: string; path: string; sha256: string; receipt: string }

export type EvidenceAnswer =
  | {
    ok: true; what: EvidenceWhat; operation: string;
    /** the project-relative path printed: the record, or the STEP */
    path: string; sha256: string; bytes: number;
    /** the record it was found by (for flow and vox, the file printed itself) */
    record: EvidenceRecord;
    /** how it was found and checked, in words */
    how: string;
    /** flow, step and stl: how the flow they were found by ended, as its record says (succeeded, no change, …) */
    outcome?: string;
  }
  | { ok: false; what: EvidenceWhat; operation: string; refusal: EvidenceRefusal; why: string; candidates?: Array<{ id: string; path: string; operation: string | null; state: string }> };

/** Records are a few kilobytes; anything past this is not one. */
const RECORD_MAX = 1024 * 1024;
const FLOW_FILE = /^(f[0-9a-f]{8})\.json$/;
const VOX_FILE = /^(v[0-9a-f]{8})\.json$/;
const FLOW_ID = /^f[0-9a-f]{8}$/;
const VOX_ID = /^v[0-9a-f]{8}$/;
const SHA = /^[0-9a-f]{64}$/;
const EXPORT_WORDS = 'its export ';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj).filter((x): x is Obj => !!x) : []);
const sha = (v: unknown): v is string => typeof v === 'string' && SHA.test(v);
const s12 = (s: string): string => s.slice(0, 12);
const receiptShort = (r: Receipt): string => (typeof r.hash === 'string' && r.hash.length > 15 ? r.hash.slice(7, 15) : String(r.id ?? '?'));
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
/** A path a record may name: relative, inside the project by its words (no "..", no drive, no NUL). */
const relOk = (p: unknown): p is string => typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.includes('\0') && !p.split(/[\\/]/).includes('..');

// ── files in place ────────────────────────────────────────────────────────────

/** A project file as it is now: a regular file reached through no link, its sha256 and size; or why not. */
export function fileNow(root: string, rel: string): { ok: true; sha256: string; bytes: number } | { ok: false; why: string } {
  if (!relOk(rel)) return { ok: false, why: `${rel} is not a path inside the project` };
  let at = root;
  for (const part of rel.split('/')) {
    at = path.join(at, part);
    let st: fs.Stats;
    try { st = fs.lstatSync(at); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return { ok: false, why: code === 'ENOENT' ? `${rel} is not there` : `${rel} cannot be read (${code ?? 'error'})` };
    }
    if (st.isSymbolicLink()) return { ok: false, why: `${rel} goes through a symbolic link (${path.relative(root, at).split(path.sep).join('/')}); evidence is read only in place` };
  }
  let fd: number | undefined;
  try {
    const st = fs.statSync(at);
    if (!st.isFile()) return { ok: false, why: `${rel} is not a file` };
    const h = createHash('sha256');
    const buf = Buffer.alloc(1024 * 1024);
    fd = fs.openSync(at, 'r');
    let bytes = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
      bytes += n;
    }
    return { ok: true, sha256: h.digest('hex'), bytes };
  } catch (e) {
    return { ok: false, why: `${rel} cannot be read (${(e as NodeJS.ErrnoException).code ?? 'error'})` };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// ── records ───────────────────────────────────────────────────────────────────

/** A flow or VoxVision record as read (by name, never by time): its id, place, parsed value, sha256 and the operation it names. */
export interface RecordRead { kind: 'flow' | 'vox'; id: string; rel: string; value: Obj; sha256: string; bytes: number; operation: string | null }

/** Every record of a kind in the project, by name (never by time), and the files that could not be read, each with why. */
export function readRecords(root: string, kind: 'flow' | 'vox'): { list: RecordRead[]; unreadable: Array<{ rel: string; why: string }>; dir: string } {
  const dir = kind === 'flow' ? FLOWS_DIR : VOX_DIR;
  const re = kind === 'flow' ? FLOW_FILE : VOX_FILE;
  const schema = kind === 'flow' ? 'timmy.flow/1' : 'timmy.vox/1';
  const out: RecordRead[] = [];
  const unreadable: Array<{ rel: string; why: string }> = [];
  // the folder itself, reached through no link
  let at = root;
  for (const part of dir.split('/')) {
    at = path.join(at, part);
    try { if (fs.lstatSync(at).isSymbolicLink()) return { list: [], unreadable: [{ rel: dir, why: `${dir} goes through a symbolic link; evidence is read only in place` }], dir }; } catch { return { list: [], unreadable: [], dir }; }
  }
  let names: string[];
  try { names = fs.readdirSync(at).filter((n) => re.test(n)).sort(); } catch (e) { return { list: [], unreadable: [{ rel: dir, why: `${dir} cannot be read (${(e as NodeJS.ErrnoException).code ?? 'error'})` }], dir }; }
  for (const n of names) {
    const rel = `${dir}/${n}`;
    const id = re.exec(n)![1];
    let buf: Buffer;
    try {
      const st = fs.lstatSync(path.join(at, n));
      if (st.isSymbolicLink()) { unreadable.push({ rel, why: 'a symbolic link' }); continue; }
      if (!st.isFile()) { unreadable.push({ rel, why: 'not a file' }); continue; }
      if (st.size > RECORD_MAX) { unreadable.push({ rel, why: 'larger than a record' }); continue; }
      buf = fs.readFileSync(path.join(at, n));
    } catch (e) { unreadable.push({ rel, why: `${(e as NodeJS.ErrnoException).code ?? 'error'} reading it` }); continue; }
    let value: Obj | undefined;
    try { value = obj(JSON.parse(buf.toString('utf8'))); } catch { value = undefined; }
    if (!value) { unreadable.push({ rel, why: 'not JSON' }); continue; }
    if (value.schema !== schema || value.id !== id) { unreadable.push({ rel, why: `not a ${schema} record of ${id}` }); continue; }
    const op = str(value.operation);
    out.push({ kind, id, rel, value, sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length, operation: op ?? null });
  }
  return { list: out, unreadable, dir };
}

/** The newest receipt of this project on the chain that names exactly these bytes of the record; or why there is none. */
export function sealOf(chain: readonly Receipt[], rec: { kind: 'flow' | 'vox'; rel: string; sha256: string }, pid: string, operation: string): { ok: true; receipt: Receipt } | { ok: false; why: string } {
  const named = chain.filter((r) => r.kind === rec.kind && r.project_id === pid && (r.outputs ?? []).some((o) => o.path === rec.rel));
  if (!named.length) return { ok: false, why: `no ${rec.kind} receipt of this project on the runs chain names ${rec.rel}, so it is not sealed evidence` };
  const exact = [...named].reverse().find((r) => (r.outputs ?? []).some((o) => o.path === rec.rel && o.sha256 === rec.sha256));
  if (!exact) return { ok: false, why: `${rec.rel} changed after it was sealed: its sha256 now (${s12(rec.sha256)}) is not one a ${rec.kind} receipt of this project names` };
  if (typeof exact.operation_id === 'string' && exact.operation_id !== operation) return { ok: false, why: `receipt ${receiptShort(exact)}, which sealed ${rec.rel}, names operation ${exact.operation_id}, not ${operation}` };
  return { ok: true, receipt: exact };
}

const recState = (r: RecordRead): string => (r.kind === 'flow' ? String(r.value.outcome ?? 'unknown') : `${String(r.value.action ?? '?')}, ${String(r.value.status ?? 'unknown')}`);
const recWords = (r: RecordRead): string => `${r.id}: ${recState(r)}`;
const kindWords = (k: 'flow' | 'vox'): string => (k === 'flow' ? 'flow record' : 'VoxVision record');

/** The one record of the operation (or the one --id names, which must be the operation's); or why there is not one. */
function pick(root: string, kind: 'flow' | 'vox', what: EvidenceWhat, operation: string, o: { id?: string; filter?: (r: RecordRead) => boolean; about?: string } = {}): { ok: true; rec: RecordRead } | Extract<EvidenceAnswer, { ok: false }> {
  const read = readRecords(root, kind);
  const refuse = (refusal: EvidenceRefusal, why: string, cands?: RecordRead[]): Extract<EvidenceAnswer, { ok: false }> => ({
    ok: false, what, operation, refusal, why,
    ...(cands?.length ? { candidates: cands.map((r) => ({ id: r.id, path: r.rel, operation: r.operation, state: recState(r) })) } : {}),
  });
  const unknown = read.unreadable.length
    ? `; ${plural(read.unreadable.length, 'file')} there could not be read (${read.unreadable.slice(0, 4).map((u) => `${u.rel}: ${u.why}`).join('; ')}${read.unreadable.length > 4 ? '; …' : ''}), so whether one is this operation's is not known`
    : '';
  if (o.id) {
    const r = read.list.find((x) => x.id === o.id);
    if (!r) return refuse('none', `no ${kindWords(kind)} ${o.id} in ${read.dir}/${unknown}`);
    if (r.operation !== operation) return refuse('not in this operation', `${kindWords(kind)} ${o.id} ${r.operation ? `is operation ${r.operation}'s` : 'names no operation'}, not ${operation}'s, so it is not this run's evidence`, [r]);
    if (o.filter && !o.filter(r)) return refuse('none', `${kindWords(kind)} ${o.id} is not ${o.about ?? 'the one asked for'}`, [r]);
    return { ok: true, rec: r };
  }
  const mine = read.list.filter((x) => x.operation === operation);
  const fit = o.filter ? mine.filter(o.filter) : mine;
  if (fit.length === 1) return { ok: true, rec: fit[0] };
  if (fit.length > 1) {
    return refuse('more than one', `operation ${operation} has ${plural(fit.length, kindWords(kind))}${o.about ? ` ${o.about}` : ''} (${fit.map(recWords).join('; ')}); this takes exactly one: name it with --id <${kind === 'flow' ? 'f…' : 'v…'}>`, fit);
  }
  const others = read.list.length - mine.length;
  const otherWords = others ? ` (${plural(others, 'record')} there ${others === 1 ? 'is' : 'are'} of other operations or of none, and ${others === 1 ? 'is' : 'are'} not this run's evidence)` : '';
  if (mine.length && o.filter) return refuse('none', `operation ${operation}'s ${plural(mine.length, kindWords(kind))} (${mine.map(recWords).join('; ')}) ${mine.length === 1 ? 'is' : 'are'} not ${o.about ?? 'the one asked for'}${unknown}`, mine);
  // A flow of the operation that runs still has no record: its state file says so (src/repl/board-flows.ts reads the same).
  const running = kind === 'flow' ? runningFlows(root, operation) : [];
  const still = running.length ? `; ${running.map((id) => `flow ${id}`).join(', ')} of it ${running.length === 1 ? 'has' : 'have'} no record yet (${running.length === 1 ? 'its state file says it runs' : 'their state files say they run'})` : '';
  return refuse('none', `no ${kindWords(kind)} of operation ${operation} in ${read.dir}/${otherWords}${still}${unknown}`);
}

/** The flows of the operation whose state file says they run and that have no record yet. */
function runningFlows(root: string, operation: string): string[] {
  return runningFlowStates(root, operation).map((f) => f.id);
}

/**
 * R4 (H102, part 2): the flows of the operation whose state file (.timmy/flows/<id>/state.json, which each flow's session
 * writes at each step) says they run and that have no record yet, by name (never by time): each with its state file and the
 * step it names. The state is what its session last wrote: a session that ended leaves it saying `running` until /recover
 * records the flow as interrupted.
 */
export function runningFlowStates(root: string, operation: string): Array<{ id: string; rel: string; step?: string; value: Obj }> {
  const dir = path.join(root, '.timmy', 'flows');
  let ids: string[];
  try { ids = fs.readdirSync(dir).filter((n) => FLOW_ID.test(n)).sort(); } catch { return []; }
  const out: Array<{ id: string; rel: string; step?: string; value: Obj }> = [];
  for (const id of ids) {
    try {
      if (fs.existsSync(path.join(root, FLOWS_DIR, `${id}.json`))) continue;
      const abs = path.join(dir, id, 'state.json');
      const st = fs.lstatSync(abs);
      if (!st.isFile() || st.size > RECORD_MAX) continue;
      const v = obj(JSON.parse(fs.readFileSync(abs, 'utf8')));
      if (v && v.id === id && v.outcome === 'running' && v.operation === operation) out.push({ id, rel: `.timmy/flows/${id}/state.json`, ...(str(v.step) ? { step: str(v.step) } : {}), value: v });
    } catch { /* not one */ }
  }
  return out;
}

// ── the STEP a flow names ─────────────────────────────────────────────────────

/**
 * The files of a kind a flow record names as delivered: a STEP (its rebuild's export, the STEP its readback read, FreeCAD's
 * export) or an STL (its rebuild's export, the STL OpenSCAD made in a /iterate scad flow), each with its sha256.
 */
export function deliveredFiles(v: Obj, kind: FlowFileKind): Array<{ path: string; sha256: string; by: string }> {
  const out: Array<{ path: string; sha256: string; by: string }> = [];
  const add = (p: unknown, s: unknown, by: string): void => { if (relOk(p) && FILE_KIND[kind].re.test(p) && sha(s)) out.push({ path: p, sha256: s, by }); };
  for (const x of list(obj(v.rebuild)?.outputs)) add(x.path, x.sha256, 'its rebuild delivered');
  if (kind === 'step') {
    const rb = obj(obj(v.readback)?.step);
    add(rb?.path, rb?.sha256, 'its readback read');
    const fc = obj(obj(v.freecad)?.step);
    add(fc?.path, fc?.sha256, 'FreeCAD exported');
  } else {
    const st = obj(obj(v.openscad)?.stl);
    if (st?.made === true) add(st.path, st.sha256, 'OpenSCAD made');
  }
  return out;
}
/** The STEP files a flow record names as delivered (deliveredFiles of 'step'). */
export const deliveredSteps = (v: Obj): Array<{ path: string; sha256: string; by: string }> => deliveredFiles(v, 'step');

/**
 * R4 (H99): a flow that made no change names the last build its check found (`last_build`): the files of a kind among the
 * files that check found as recorded (the tray's "its export <path>", a native run's written files by path), only when it
 * found that build current. Its words otherwise.
 */
export function lastBuildFiles(v: Obj, kind: FlowFileKind): { state: string; words?: string; build?: string; files: Array<{ path: string; sha256: string }> } {
  const lb = obj(v.last_build);
  const state = str(lb?.state) ?? 'not recorded';
  const words = str(lb?.words);
  const b = obj(lb?.build);
  const build = b ? `${b.kind === 'recipe' ? 'recipe job' : `${String(b.app ?? 'native')} run`} ${String(b.id ?? '?').slice(0, 8)}` : undefined;
  if (state !== 'current') return { state, ...(words ? { words } : {}), ...(build ? { build } : {}), files: [] };
  const folder = str(b?.outputs);
  const files: Array<{ path: string; sha256: string }> = [];
  for (const c of list(lb?.checks)) {
    const w = str(c.what);
    if (!w || c.same !== true || !sha(c.recorded) || c.now !== c.recorded) continue;
    const p = w.startsWith(EXPORT_WORDS) ? w.slice(EXPORT_WORDS.length) : w;
    if (!relOk(p) || !FILE_KIND[kind].re.test(p)) continue;
    if (w.startsWith(EXPORT_WORDS) && folder && !p.startsWith(folder)) continue;
    if (!files.some((s) => s.path === p)) files.push({ path: p, sha256: c.recorded });
  }
  return { state, ...(words ? { words } : {}), ...(build ? { build } : {}), files };
}
/** The last build's STEP files a no-change flow's check found current (lastBuildFiles of 'step', as `steps`). */
export function lastBuildSteps(v: Obj): { state: string; words?: string; build?: string; steps: Array<{ path: string; sha256: string }> } {
  const { files, ...rest } = lastBuildFiles(v, 'step');
  return { ...rest, steps: files };
}

// ── the answer ────────────────────────────────────────────────────────────────

export interface EvidenceQuery {
  root: string;
  what: EvidenceWhat;
  operation: string;
  chain: readonly Receipt[];
  /** a record of the operation by its id (f… for flow and step, v… for vox) */
  id?: string;
  /** vox: the file the record's input must be (project-relative, as a record names it) */
  of?: string;
  /** why the chain could not be read, when it could not */
  chainError?: string;
}

/** The one record or file of the operation asked for, checked; or why not. Reads only. */
export function findEvidence(q: EvidenceQuery): EvidenceAnswer {
  const { root, what, operation } = q;
  const pid = projectId(root);
  const notUsable = (why: string): EvidenceAnswer => ({ ok: false, what, operation, refusal: 'not usable', why });
  const sealedOr = (rec: RecordRead): { ok: true; receipt: Receipt } | { ok: false; why: string } => {
    const s = sealOf(q.chain, rec, pid, operation);
    if (s.ok || !q.chainError) return s;
    return { ok: false, why: `${s.why} (the runs chain could not be read: ${q.chainError})` };
  };
  const recordOf = (rec: RecordRead, receipt: Receipt): EvidenceRecord => ({ kind: rec.kind, id: rec.id, path: rec.rel, sha256: rec.sha256, receipt: receiptShort(receipt) });
  const sealWords = (receipt: Receipt, whose: string): string => `receipt ${receiptShort(receipt)} on the runs chain sealed ${whose}${typeof receipt.operation_id === 'string' ? '' : ' (that receipt names no operation)'}`;

  if (what === 'vox') {
    const ofRel = q.of;
    const p = pick(root, 'vox', what, operation, {
      ...(q.id ? { id: q.id } : {}),
      ...(ofRel ? { filter: (r: RecordRead) => list(r.value.inputs).some((i) => i.path === ofRel), about: `about ${ofRel}` } : {}),
    });
    if (!p.ok) return p;
    const rec = p.rec;
    const s = sealedOr(rec);
    if (!s.ok) return notUsable(`VoxVision record ${rec.id} of operation ${operation}: ${s.why}`);
    let about = '';
    if (ofRel) {
      const input = list(rec.value.inputs).find((i) => i.path === ofRel)!;
      const now = fileNow(root, ofRel);
      if (!now.ok) return notUsable(`VoxVision record ${rec.id} is about ${ofRel}, and ${now.why}`);
      if (!sha(input.sha256) || input.sha256 !== now.sha256) return notUsable(`VoxVision record ${rec.id} read ${ofRel} as sha256 ${sha(input.sha256) ? s12(input.sha256) : '(none recorded)'}, and the file is ${s12(now.sha256)} now: it is not about these bytes`);
      about = ` about ${ofRel} (sha256 ${s12(now.sha256)} now, as it read it)`;
    }
    return {
      ok: true, what, operation, path: rec.rel, sha256: rec.sha256, bytes: rec.bytes, record: recordOf(rec, s.receipt),
      how: `VoxVision record ${rec.id} of operation ${operation} (${recState(rec)})${about}; ${sealWords(s.receipt, 'this record')}`,
    };
  }

  // what is flow, step or stl: found by the operation's flow
  const kind: FlowFileKind | undefined = what === 'step' || what === 'stl' ? what : undefined;
  const K = kind ? FILE_KIND[kind].name : '';
  const p = pick(root, 'flow', what, operation, q.id ? { id: q.id } : {});
  if (!p.ok) {
    if (!kind) return p;
    return { ...p, why: `${p.refusal === 'none' ? `no ${K} of this run` : p.refusal === 'more than one' ? `which ${K} is this run's is not known` : `not this run's ${K}`}: ${p.why}` };
  }
  const rec = p.rec;
  const s = sealedOr(rec);
  if (!s.ok) return notUsable(`flow ${rec.id} of operation ${operation}: ${s.why}`);
  const outcome = String(rec.value.outcome ?? 'unknown');
  if (!kind) {
    return { ok: true, what, operation, path: rec.rel, sha256: rec.sha256, bytes: rec.bytes, record: recordOf(rec, s.receipt), how: `flow ${rec.id} of operation ${operation} (${outcome}); ${sealWords(s.receipt, 'this record')}`, outcome };
  }

  // a file the flow names: its STEP or its STL
  let file: { path: string; sha256: string } | undefined;
  /** what the flow names the file as, and how it was found, in words */
  let as = '';
  let source = '';
  if (outcome === NO_CHANGE) {
    const lb = lastBuildFiles(rec.value, kind);
    if (lb.state !== 'current') return notUsable(`flow ${rec.id} made no change, and its check found the last build ${lb.state}${lb.words ? ` (${lb.words})` : ''}: there is no ${K} of this run`);
    if (!lb.files.length) return notUsable(`flow ${rec.id} made no change; its check found the last build current${lb.build ? ` (${lb.build})` : ''} but names no ${K} among the files it checked`);
    if (lb.files.length > 1) return { ok: false, what, operation, refusal: 'more than one', why: `flow ${rec.id} made no change, and its check of the last build names ${plural(lb.files.length, K)} (${lb.files.map((x) => x.path).join(', ')}); this takes exactly one` };
    file = lb.files[0];
    as = `the last build's ${K}`;
    source = `the last build's ${K}${lb.build ? ` (${lb.build})` : ''}, which flow ${rec.id}'s check found current (the flow made no change), sha256 ${s12(file.sha256)} as that check recorded it`;
  } else {
    const named = deliveredFiles(rec.value, kind);
    const paths = [...new Set(named.map((x) => x.path))];
    if (!paths.length) {
      const why = str(rec.value.why);
      return notUsable(`flow ${rec.id} ended ${outcome}${why ? ` (${why})` : ''} and names no ${K} it delivered`);
    }
    if (paths.length > 1) return { ok: false, what, operation, refusal: 'more than one', why: `flow ${rec.id} names ${plural(paths.length, K)} (${paths.join(', ')}); this takes exactly one` };
    const shas = [...new Set(named.map((x) => x.sha256))];
    if (shas.length > 1) return notUsable(`flow ${rec.id} names ${paths[0]} with ${shas.length} different sha256s (${named.map((x) => `${x.by}: ${s12(x.sha256)}`).join('; ')}), so which bytes it delivered is not known`);
    file = { path: paths[0], sha256: shas[0] };
    const verdict = str(obj(rec.value.readback)?.verdict);
    as = `the ${K} it delivered`;
    source = `the ${K} flow ${rec.id} delivered (${outcome}${verdict ? `; its readback ${verdict}` : ''}), sha256 ${s12(file.sha256)} as the flow recorded it`;
  }
  const now = fileNow(root, file.path);
  if (!now.ok) return notUsable(`flow ${rec.id} names ${file.path} as ${as}, and ${now.why}`);
  if (now.sha256 !== file.sha256) return notUsable(`${file.path} changed since flow ${rec.id} named it as ${as}: sha256 ${s12(now.sha256)} now, ${s12(file.sha256)} as it recorded`);
  return {
    ok: true, what, operation, path: file.path, sha256: now.sha256, bytes: now.bytes, record: recordOf(rec, s.receipt),
    how: `${source}, and the same now; flow ${rec.id} is operation ${operation}'s, and ${sealWords(s.receipt, 'its record')}`, outcome,
  };
}

// ── the command ───────────────────────────────────────────────────────────────

export function evidenceHelp(): string {
  return [
    'timmy evidence: the one record or file of an operation a workflow block needs, found by the operation\'s id, never by a file\'s time.',
    '',
    'USAGE',
    `  ${EVIDENCE_USAGE}`,
    '',
    '  flow   the operation\'s flow record (results/flows/<id>.json)',
    '  step   the STEP that flow delivered; when it made no change and its check found the last build current, that build\'s STEP',
    '  stl    the STL that flow delivered (its rebuild\'s export, or OpenSCAD\'s in a /iterate scad flow); when it made no change',
    '         and its check found the last build current, that build\'s STL',
    '  vox    the operation\'s VoxVision record (results/vox/<id>.json)',
    '',
    'OPTIONS',
    '  --of <file>        vox: the record whose input is this file, with the bytes it has now',
    '  --id <record>      that record (f… for flow, step and stl, v… for vox), which must be the operation\'s',
    `  --operation <id>   the operation (default: ${OPERATION_ENV}, which each block of a /run has)`,
    '  --project <dir>    the project folder (default: the current folder)',
    '  --outcome          flow: how the flow ended, as its record says (succeeded, no change, …), instead of its path',
    '  --json             one JSON object on stdout instead of the path',
    '',
    'WHAT IT CHECKS',
    '  Only records that name the operation are taken; a record only while a receipt of this project on the runs chain',
    '  names its bytes; a file only while its sha256 is the one its record names. Nothing runs, is written or is sealed.',
    '',
    'EXIT',
    '  0 exactly one: its path on stdout (with --outcome, its flow\'s outcome), how it was found on stderr',
    '  1 none, more than one, not in this operation, or not usable: why on stderr',
    '  2 usage, or not in an operation',
    '',
    'EXAMPLES (in a block of a /run)',
    '  step=$(timmy evidence step) || exit 1',
    '  vox=$(timmy evidence vox --of "$step") || exit 1',
    '  stl=$(timmy evidence stl) || exit 1',
    '  outcome=$(timmy evidence flow --outcome) || exit 1',
    '',
  ].join('\n');
}

interface EvidenceArgs { what: EvidenceWhat; id?: string; of?: string; operation?: string; project?: string; json: boolean; outcome?: boolean; help?: boolean }

export function parseEvidenceArgs(argv: string[], o: { json?: boolean } = {}): EvidenceArgs | { error: string } {
  const a: Partial<EvidenceArgs> & { json: boolean } = { json: o.json === true };
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i];
    if (w === '-h' || w === '--help') { a.help = true; continue; }
    if (w === '--json') { a.json = true; continue; }
    if (w === '--outcome') { a.outcome = true; continue; }
    const eq = /^--(id|of|operation|project)=(.*)$/.exec(w);
    const name = eq ? eq[1] : /^--(id|of|operation|project)$/.exec(w)?.[1];
    if (name) {
      const v = eq ? eq[2] : argv[++i];
      if (v === undefined || v === '') return { error: `--${name} needs a value. Usage: ${EVIDENCE_USAGE}` };
      (a as Record<string, unknown>)[name] = v;
      continue;
    }
    if (/^-/.test(w)) return { error: `No option ${w}. Usage: ${EVIDENCE_USAGE}` };
    words.push(w);
  }
  if (a.help) return { what: 'flow', json: a.json, help: true };
  if (!words.length) return { error: `Name what to find: flow, step, stl or vox. Usage: ${EVIDENCE_USAGE}` };
  if (words.length > 1) return { error: `One thing at a time (it was given ${words.join(' ')}). Usage: ${EVIDENCE_USAGE}` };
  const what = words[0] as EvidenceWhat;
  if (!EVIDENCE_WHAT.includes(what)) return { error: `No evidence ${words[0]}: flow, step, stl or vox. Usage: ${EVIDENCE_USAGE}` };
  if (a.of !== undefined && what !== 'vox') return { error: `--of is for vox (the VoxVision record about a file). Usage: ${EVIDENCE_USAGE}` };
  if (a.outcome && what !== 'flow') return { error: `--outcome is for flow (how the operation's flow ended). Usage: ${EVIDENCE_USAGE}` };
  if (a.id !== undefined && !(what === 'vox' ? VOX_ID : FLOW_ID).test(a.id)) return { error: `--id ${a.id} is not a ${what === 'vox' ? 'VoxVision record id (v and 8 hex digits)' : 'flow id (f and 8 hex digits)'}. Usage: ${EVIDENCE_USAGE}` };
  return { what, json: a.json, ...(a.id ? { id: a.id } : {}), ...(a.of ? { of: a.of } : {}), ...(a.operation ? { operation: a.operation } : {}), ...(a.project ? { project: a.project } : {}), ...(a.outcome ? { outcome: true } : {}) };
}

/** `timmy evidence …`: its exit code (the CLI exits with it). */
export async function evidenceMain(argv: string[], o: { json?: boolean } = {}): Promise<number> {
  const parsed = parseEvidenceArgs(argv, o);
  const json = o.json === true || argv.includes('--json');
  const usage = (error: string, operation: string | null = null, refusal: 'usage' | 'not in an operation' = 'usage'): number => {
    process.stderr.write(`${error}\n`);
    if (json) process.stdout.write(`${JSON.stringify({ schema: EVIDENCE_SCHEMA, what: 'error' in parsed ? null : parsed.what, operation, found: false, refusal, why: error, exit_code: 2 })}\n`);
    return 2;
  };
  if ('error' in parsed) return usage(parsed.error);
  if (parsed.help) { process.stdout.write(evidenceHelp()); return 0; }
  const a = parsed;

  let root = process.cwd();
  if (a.project) {
    root = path.resolve(a.project);
    let dir = false;
    try { dir = fs.statSync(root).isDirectory(); } catch { dir = false; }
    if (!dir) return usage(`--project ${a.project} is not a folder. Usage: ${EVIDENCE_USAGE}`);
  }
  try { root = fs.realpathSync(root); } catch { /* as given */ }
  // The runs chain is read from the project's folder, as `timmy act` reads and seals it there (src/utils/receipts.ts).
  try { process.chdir(root); } catch (e) { return usage(`The project folder cannot be entered: ${e instanceof Error ? e.message : String(e)}`); }

  const fromEnv = process.env[OPERATION_ENV]?.trim();
  const operation = a.operation ?? fromEnv;
  const from = a.operation ? '--operation' : OPERATION_ENV;
  if (!operation) return usage(`timmy evidence ${a.what}: not in an operation: ${OPERATION_ENV} is not set (each block of a /run has it) and no --operation was given; /ops lists the operations`, null, 'not in an operation');
  if (!OPERATION_ID.test(operation)) return usage(`timmy evidence ${a.what}: ${from} ${JSON.stringify(operation)} is not an operation id (o and 8 hex digits)`, null, 'not in an operation');

  let of: string | undefined;
  if (a.of !== undefined) {
    const at = resolveInside(root, a.of);
    if ('error' in at) return usage(`--of ${a.of}: ${at.error}. Usage: ${EVIDENCE_USAGE}`, operation);
    of = at.rel;
  }
  let chain: Receipt[] = [];
  let chainError: string | undefined;
  try { chain = readChain('runs'); } catch (e) { chainError = e instanceof Error ? e.message : String(e); }

  const r = findEvidence({ root, what: a.what, operation, chain, ...(a.id ? { id: a.id } : {}), ...(of ? { of } : {}), ...(chainError ? { chainError } : {}) });
  if (r.ok) {
    if (json) {
      process.stdout.write(`${JSON.stringify({ schema: EVIDENCE_SCHEMA, what: r.what, operation, operation_from: from, found: true, path: r.path, sha256: r.sha256, bytes: r.bytes, record: r.record, how: r.how, ...(r.outcome ? { outcome: r.outcome } : {}), exit_code: 0 })}\n`);
    } else {
      // R4 (H102, part 2): --outcome prints how the flow ended (its record's word), so a block says only what ran
      process.stdout.write(`${a.outcome ? r.outcome ?? 'unknown' : r.path}\n`);
      process.stderr.write(`  ${r.what} ${r.path}: ${r.how}\n`);
    }
    return 0;
  }
  process.stderr.write(`  timmy evidence ${r.what}: ${r.refusal}: ${r.why}\n`);
  if (json) process.stdout.write(`${JSON.stringify({ schema: EVIDENCE_SCHEMA, what: r.what, operation, operation_from: from, found: false, refusal: r.refusal, why: r.why, ...(r.candidates ? { candidates: r.candidates } : {}), exit_code: 1 })}\n`);
  return 1;
}
