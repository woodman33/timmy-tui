/**
 * Round R4 (H65): Results and review, what each operation changed in the project, read from the records Timmy's own writers
 * keep (src/ops/card.ts groups them by operation):
 *
 *   flows        results/flows/<id>.json: the file its agent may change (the tray's and OpenSCAD's parameter file, the
 *                Blender, FreeCAD and After Effects script) with its sha256 before and after and the copy of its bytes as
 *                read (.timmy/flows/<id>/params.before.json or script.before.<ext>); any other file its agent changed
 *                (agent.files_changed); the files its app or recipe wrote, with what the app's own run recorded of them;
 *   code agents  .timmy/agents/<run>/result.json: what a plain /agent run added, changed and deleted (sha256 before and
 *                after); an OpenHands run's write-back, with each file it overwrote or deleted kept first in before/;
 *   native runs  .timmy/native/<run>/: the files a /scad, /blender, /freecad, /ae or /c4d run wrote, as its judgement says;
 *   edits        edit receipts: the live board's parameter, OpenSCAD parameter and workflow saves (the previous version kept
 *                under .timmy/params-history/ or .timmy/workflow-history/), /edit in an editor (none kept), and /restore
 *                (the version it replaced kept under .timmy/restore-history/);
 *   jobs         a job's receipt names the output-folder files whose times fall in its run (a workflow /run, a recipe).
 *
 * Each file is checked now: its sha256 against what the run left (unchanged, changed since, gone); its kept previous version
 * against the sha256 its record gives (a copy that changed or went is said so, and never offered); a bounded line diff of a
 * text file between the kept version and the file as the run left it. Each item names its record and the receipt that
 * sealed it, verified or not. A restore is offered only where it can be done exactly (src/review/restore.ts does it).
 *
 * Nothing here writes. Files in Timmy's own folder (.timmy: its records and kept versions) and private files (keys, .env,
 * .git, .timmy/private) are counted, never listed. Paths and lines stay plain text here; the REPL and the board make them
 * visible (control characters as codes) and the board escapes them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyReceiptIn, type Receipt } from '../utils/receipts.js';
import { AGENTS_DIR } from '../code-agents/index.js';
import { flowRecordPath } from '../flows/iterate.js';
import { scriptChange, type ScriptChange } from '../flows/iterate-native.js';
import { readNativeRecord } from '../native/index.js';
import { privatePath } from '../project/index.js';
import { checkFlowRecord } from '../repl/board-flows.js';
import { flowOutputs, recentOperations, shaNow, type CardCheck, type CardTone, type OpIndex } from '../ops/card.js';
import { flowClaims } from '../ops/outcome.js';
import { readOperationRecord } from '../ops/operations.js';
import { writerState } from '../ops/process-proof.js';

/** Where /restore keeps the version it replaces (each file under its own path, as the board's saves keep theirs). */
export const RESTORE_HISTORY_DIR = '.timmy/restore-history';
/** A line diff is drawn only for text files up to this size, on each side. */
export const DIFF_MAX_BYTES = 128 * 1024;
/** How many changes one operation lists in /review and on the board (the rest are counted). */
export const MAX_CHANGES = 40;
/** How many changes `/review <operation>` lists for the one operation named. */
export const MAX_CHANGES_ONE = 400;
const RECORD_MAX = 2 * 1024 * 1024;

/** added: absent before; changed: replaced; deleted: removed; written: the run wrote it, and whether it was there before is not recorded. */
export type ChangeHow = 'added' | 'changed' | 'deleted' | 'written';
export type ChangeSource = 'flow' | 'agent' | 'native' | 'edit' | 'job';

/** The kept previous version: ok when its bytes are the previous version its record names (their sha256 now). */
export interface ReviewKept { path: string; state: 'ok' | 'differs' | 'missing' | 'unreadable'; words: string }
/** The file as it is now, against what the run left. */
export interface ReviewNow { state: 'unchanged' | 'changed since' | 'gone' | 'still deleted' | 'back' | 'not comparable'; sha256?: string; words: string }
/** A line diff between the kept previous version and the file as the run left it, or why there is none. */
export type ReviewDiff = { shown: true; from: string; to: string; change: ScriptChange } | { shown: false; why: string };
/** Whether a restore can be done exactly now, and the command that does it; or why not. */
export type ReviewRestore = { offered: true; from: string; command: string } | { offered: false; why: string };

export interface ReviewChange {
  /** project-relative, as its record names it */
  path: string;
  how: ChangeHow;
  /** who changed it, in words: "flow f… (its agent, qwen a…)", "agent qwen a…", "the live board's parameter save" */
  by: string;
  source: ChangeSource;
  /** the flow id, the agent run, the native run, the edit's receipt or the job */
  runId: string;
  /** the operation its record names */
  operation?: string;
  /** sha256 before (null: it was not there) and as the run left it (null: deleted); absent: not recorded */
  before?: string | null;
  after?: string | null;
  note?: string;
  /** a symbolic link (its sha256 is of its link text): listed, never diffed or restored */
  link?: true;
  kept?: ReviewKept;
  /** the previous version in words: kept where, not kept, or there was none */
  keptWords: string;
  diff?: ReviewDiff;
  now: ReviewNow;
  /** its record (a file in the project), or none when its receipt is its record (an edit, a job) */
  record?: string;
  /** the short id of the receipt that sealed its record */
  receipt?: string;
  check: CardCheck;
  restore: ReviewRestore;
}

export interface ReviewOperation {
  id: string;
  request: string;
  via?: string;
  started?: string;
  state: string;
  tone: CardTone;
  /** its operation record, when it has one here */
  record?: string;
  changes: ReviewChange[];
  /** changes left off the list, and the most this review lists for one operation */
  more: number;
  cap: number;
  /** what is said and not listed: a flow running, an interrupted agent, Timmy's own files counted */
  notes: string[];
}

export interface ReviewView {
  operations: ReviewOperation[];
  /** recent operations looked at that changed no file Timmy records */
  quiet: number;
  /** how many recent operations were looked at */
  looked: number;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj).filter((x): x is Obj => !!x) : []);
const HEX64 = /^[0-9a-f]{64}$/;
/** A sha256 as records write it (64 hex), else undefined. */
const shaOf = (v: unknown): string | undefined => { const s = str(v); return s && HEX64.test(s) ? s : undefined; };
export const short = (s: string | null | undefined): string => (s ? s.slice(0, 12) : '?');
const shortReceipt = (r: Receipt): string => (typeof r.hash === 'string' && r.hash.length > 15 ? r.hash.slice(7, 15) : String(r.id ?? '?'));
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * Control characters, invisible and direction-changing characters written as codes (\x1b, \u202e), so a file's name or a
 * line of it shows what it holds and moves nothing on a terminal or a page. Tabs stay.
 */
export const visible = (s: string): string => s.replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, (c) => {
  const n = c.codePointAt(0)!;
  return n < 0x100 ? `\\x${n.toString(16).padStart(2, '0')}` : `\\u${n.toString(16).padStart(4, '0')}`;
});

/** A path inside the project as a record should name it: relative, '/'-separated, no empty, '.' or '..' part. */
export function plainRel(p: unknown): string | undefined {
  if (typeof p !== 'string' || !p || p.length > 1024 || p.includes('\0')) return undefined;
  if (p.startsWith('/') || p.startsWith('~') || /^[a-z][a-z0-9+.-]*:/i.test(p)) return undefined;
  return p.split('/').some((x) => !x || x === '.' || x === '..') ? undefined : p;
}
/** A path in a folder named .timmy, at any depth: Timmy's own records and kept versions. */
const inTimmy = (p: string): boolean => p.split('/').includes('.timmy');

/** Where Timmy keeps previous versions: a flow's copy as read, an OpenHands run's before/, the board's saves, /restore's. */
const KEPT_PLACES: readonly RegExp[] = [
  /^\.timmy\/flows\/f[0-9a-f]{8}\/[^/]+$/,
  /^\.timmy\/agents\/a[0-9a-f]{8}\/before\/.+$/,
  /^\.timmy\/(?:params-history|workflow-history|restore-history)\/.+$/,
];
export const isKeptPlace = (p: string): boolean => !!plainRel(p) && KEPT_PLACES.some((re) => re.test(p));

// ── the commands ──────────────────────────────────────────────────────────────

/** One argument of /restore as typed: bare, or quoted with the quote it does not hold; null when no quoting can write it. */
export function restoreArg(s: string): string | null {
  if (!s || /[\u0000-\u001f\u007f-\u009f]/.test(s)) return null;
  if (!/\s/.test(s) && !/^["']/.test(s) && s !== '--from') return s;
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return null;
}
/** `/restore <file> --from <kept>`, written so /restore reads both back exactly; null when it cannot be. */
export function restoreCommand(file: string, from: string): string | null {
  const a = restoreArg(file);
  const b = restoreArg(from);
  return a && b ? `/restore ${a} --from ${b}` : null;
}
/** /restore's arguments: `<file> --from <kept previous version>`, each bare or quoted ("…" or '…'). */
export function parseRestoreArgs(args: string): { ok: true; file: string; from: string } | { ok: false; error: string } {
  const usage = 'Usage: /restore <file> --from <kept previous version>   (/review lists what can be restored, with the line to type)';
  const words: Array<{ text: string; quoted: boolean }> = [];
  const re = /\s*(?:"([^"]*)"|'([^']*)'|(\S+))/y;
  const s = args.trim();
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while (re.lastIndex < s.length && (m = re.exec(s))) {
    if (m[3] !== undefined && /["']/.test(m[3][0])) return { ok: false, error: `A quote is not closed. ${usage}` };
    words.push(m[3] !== undefined ? { text: m[3], quoted: false } : { text: m[1] ?? m[2] ?? '', quoted: true });
  }
  if (words.length !== 3 || words[1].quoted || words[1].text !== '--from' || (!words[0].quoted && words[0].text === '--from')) return { ok: false, error: usage };
  if (!words[0].text || !words[2].text) return { ok: false, error: usage };
  return { ok: true, file: words[0].text, from: words[2].text };
}

// ── what each record says ─────────────────────────────────────────────────────

interface RawChange { path: string; how: ChangeHow; before?: string | null; after?: string | null; kept?: string; note?: string; link?: true; by?: string }
interface SourceInfo { source: ChangeSource; runId: string; by: string; operation?: string; record?: string; receipt?: string; check: CardCheck }
interface Gathered { info: SourceInfo; items: RawChange[]; notes: string[] }

/** A small JSON file in the project and its sha256, never through a link. */
function readRecord(root: string, rel: string, max = RECORD_MAX): { ok: true; value: unknown; sha256: string } | { ok: false; error: string } {
  try {
    const abs = path.join(root, rel);
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) return { ok: false, error: `${rel} is a symbolic link` };
    if (!st.isFile()) return { ok: false, error: `${rel} is not a file` };
    if (st.size > max) return { ok: false, error: `${rel} is larger than such a record` };
    const buf = fs.readFileSync(abs);
    return { ok: true, value: JSON.parse(buf.toString('utf8')), sha256: sha(buf) };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, error: code === 'ENOENT' ? `${rel} is not there` : code ? `${code} reading ${rel}` : `${rel} is not JSON` };
  }
}

/** A receipt of the chain checked where it stands (its links from its epoch's start, its body and its signature). */
const verified = new Map<string, { ok: boolean; reason?: string }>();
function receiptCheck(chain: readonly Receipt[], r: Receipt, words: string): CardCheck {
  const key = `${r.hash}\0${chain.length}`;
  let v = verified.get(key);
  if (!v) {
    const got = verifyReceiptIn(chain, String(r.hash));
    v = got.ok ? { ok: true } : { ok: false, reason: got.reason };
    if (verified.size > 2000) verified.clear();
    verified.set(key, v);
  }
  return v.ok ? { status: 'verified', words: `receipt ${shortReceipt(r)} ${words}, and it verifies on the chain`, receipt: shortReceipt(r) }
    : { status: 'unverified', words: `receipt ${shortReceipt(r)} does not verify: ${v.reason ?? 'unknown'}`, receipt: shortReceipt(r) };
}

/** A flow record's check (src/repl/board-flows.ts checkFlowRecord) as an item's. */
function flowCheckWords(c: { status: string; receipt?: string; reasons: string[] }): CardCheck {
  return c.status === 'verified'
    ? { status: 'verified', words: `receipt ${c.receipt ?? '?'} sealed this record's bytes`, ...(c.receipt ? { receipt: c.receipt } : {}) }
    : { status: 'unverified', words: c.reasons.join('; ') || 'no flow receipt sealed this record' };
}

/** What a native run recorded of one file it wrote: added or changed (with the sha256 it inventoried before), or written. */
function nativeFacts(root: string, run: string, rel: string): { how: ChangeHow; before?: string | null } | undefined {
  let rec: ReturnType<typeof readNativeRecord>;
  try { rec = readNativeRecord(root, run); } catch { return undefined; }
  const f = rec?.verdicts.at(-1)?.files.find((x) => x.path === rel);
  if (!rec || !f) return undefined;
  const pre = obj(rec.job.pre?.[rel]);
  if (f.change === 'created') return { how: 'added', before: null };
  if (f.change === 'changed') return { how: 'changed', ...(pre?.state === 'present' && shaOf(pre.sha256) ? { before: shaOf(pre.sha256)! } : {}) };
  return { how: 'written' };
}

/** A flow record: the file its agent may change, the other files its agent changed, and what its app or recipe wrote. */
export function flowChanges(root: string, rel: string, record: unknown, check: CardCheck): Gathered {
  const r = obj(record) ?? {};
  const fid = str(r.id) ?? '?';
  const target = str(r.target) ?? 'tray';
  const agent = obj(r.agent);
  const agentWords = agent ? [str(agent.agent), str(agent.run)].filter(Boolean).join(' ') : '';
  const byAgent = `flow ${fid} (/iterate ${target}), its agent${agentWords ? ` ${agentWords}` : ''}`;
  const info: SourceInfo = { source: 'flow', runId: fid, by: `flow ${fid} (/iterate ${target})`, record: rel, ...(str(r.operation) ? { operation: str(r.operation) } : {}), check, ...(check.receipt ? { receipt: check.receipt } : {}) };
  const items: RawChange[] = [];
  const notes: string[] = [];
  for (const c of list(agent?.files_changed)) {
    const how = c.how === 'added' || c.how === 'changed' || c.how === 'deleted' ? c.how : undefined;
    if (!how || !str(c.path)) continue;
    items.push({
      path: String(c.path), how, by: byAgent,
      before: how === 'added' ? null : shaOf(c.sha256_before), after: how === 'deleted' ? null : shaOf(c.sha256_after),
    });
  }
  // The file its agent may change: its sha256 before and after (or the invalid file it left) and the copy kept as read.
  const part = obj(r.parameters) ?? obj(r.script);
  const srcPath = str(part?.path);
  if (part && srcPath) {
    const before = obj(part.before);
    const after = obj(part.after);
    const invalid = obj(part.invalid);
    const kept = str(before?.kept);
    const what = r.parameters ? 'its parameter file' : 'its script';
    let item = items.find((i) => i.path === srcPath);
    if (!item && (shaOf(after?.sha256) || shaOf(invalid?.sha256))) {
      item = { path: srcPath, how: 'changed', by: byAgent, before: shaOf(before?.sha256), after: shaOf(after?.sha256) ?? shaOf(invalid?.sha256) };
      items.unshift(item);
    }
    if (item) {
      if (item.before === undefined) item.before = shaOf(before?.sha256);
      if (kept) item.kept = kept;
      const notes_: string[] = [`${what}, the one file its agent may change`];
      if (r.parameters && obj(r.parameters)?.created === true) notes_.push('it was not there: /iterate wrote it from the recipe card\'s defaults before its agent ran');
      if (invalid) notes_.push(`its agent left it not valid (${str(invalid.error) ?? 'no reason recorded'}), and it was left as written`);
      item.note = notes_.join('; ');
    }
  }
  // What its app or recipe wrote (src/ops/card.ts flowOutputs), with what the app's own run recorded of each.
  const natives = flowClaims(r).filter((c) => c.startsWith('native:')).map((c) => c.slice(7));
  for (const o of flowOutputs(r)) {
    if (o.role.startsWith('the editable source') || items.some((i) => i.path === o.path)) continue;
    const facts = natives.map((run) => nativeFacts(root, run, o.path)).find(Boolean);
    items.push({ path: o.path, how: facts?.how ?? 'written', ...(facts && 'before' in facts ? { before: facts.before } : {}), after: shaOf(o.sha256), note: `its ${o.role}${facts ? ', as its app\'s own run recorded it' : ''}` });
  }
  if (r.outcome === 'running') notes.push(`flow ${fid} says it runs: what it changes is listed once its record is written`);
  return { info, items, notes };
}

/** A code agent's run (not a flow's step): its result's changes; an OpenHands run's write-back with its before/ copies. */
export function agentChanges(root: string, chain: readonly Receipt[], run: string): Gathered {
  const rel = `${AGENTS_DIR}/${run}/result.json`;
  const res = readRecord(root, rel);
  const runRec = res.ok ? undefined : readRecord(root, `${AGENTS_DIR}/${run}/run.json`);
  const v = res.ok ? obj(res.value) : runRec?.ok ? obj(runRec.value) : undefined;
  const name = str(v?.agent) ?? 'agent';
  const oh = obj(v?.openhands);
  const by = oh ? `OpenHands run ${run}, written back from its copy` : `agent ${name} ${run}`;
  const sealed = [...chain].reverse().find((x) => x.kind === 'agent' && obj((x as unknown as Obj).agent)?.run === run);
  let check: CardCheck;
  if (!res.ok) check = { status: 'unverified', words: `no result: ${res.error}` };
  else if (!sealed) check = { status: 'unverified', words: 'no agent receipt names this run' };
  else {
    const named = (sealed.outputs ?? []).find((o) => o.path === rel);
    check = !named ? { status: 'unverified', words: `receipt ${shortReceipt(sealed)} does not name its result file`, receipt: shortReceipt(sealed) }
      : named.sha256 === res.sha256 ? { status: 'verified', words: `receipt ${shortReceipt(sealed)} sealed this result's bytes`, receipt: shortReceipt(sealed) }
        : { status: 'unverified', words: `its result changed after receipt ${shortReceipt(sealed)} sealed it`, receipt: shortReceipt(sealed) };
  }
  const info: SourceInfo = { source: 'agent', runId: run, by, record: res.ok ? rel : `${AGENTS_DIR}/${run}/run.json`, ...(str(v?.operation) ? { operation: str(v?.operation) } : {}), check, ...(check.receipt ? { receipt: check.receipt } : {}) };
  const notes: string[] = [];
  if (!res.ok) {
    const state = str(v?.state);
    notes.push(state === 'interrupted' ? `agent run ${run} was interrupted: no result was written, so what it changed is not recorded`
      : `agent run ${run} has no result yet (${res.error}): what it changes is listed once it ends`);
    return { info, items: [], notes };
  }
  const items: RawChange[] = [];
  const wb = obj(oh?.writeback);
  for (const w of list(wb?.written)) {
    const how = w.how === 'added' || w.how === 'changed' || w.how === 'deleted' ? w.how : undefined;
    if (!how || !str(w.path)) continue;
    items.push({ path: String(w.path), how, before: how === 'added' ? null : shaOf(w.previous_sha256), after: how === 'deleted' ? null : shaOf(w.sha256), ...(how !== 'added' && str(w.kept) ? { kept: String(w.kept) } : {}) });
  }
  const files = obj(v?.files);
  const seen = new Set(items.map((i) => i.path));
  const take = (key: 'added' | 'changed' | 'deleted'): void => {
    for (const f of list(files?.[key])) {
      const p = str(f.path);
      if (!p || seen.has(p)) continue;
      seen.add(p);
      const link = f.link !== undefined || f.previous_link !== undefined;
      items.push({
        path: p, how: key, before: key === 'added' ? null : shaOf(f.previous_sha256), after: key === 'deleted' ? null : shaOf(f.sha256),
        ...(link ? { link: true as const, note: 'a symbolic link: its sha256 is of its link text' } : {}),
      });
    }
  };
  take('added'); take('changed'); take('deleted');
  if (files?.truncated === true) notes.push(`agent run ${run} compared more files than it lists: some of its changes may not be listed`);
  if (wb && (wb.state === 'refused' || wb.state === 'not attempted')) notes.push(`OpenHands run ${run}: nothing was written into the project (${str(wb.why) ?? str(wb.state) ?? ''})`);
  return { info, items, notes };
}

/** A native run (not a flow's step): the files it wrote, as its judgement recorded them, checked against its native receipt. */
export function nativeChanges(root: string, chain: readonly Receipt[], run: string): Gathered {
  let rec: ReturnType<typeof readNativeRecord>;
  try { rec = readNativeRecord(root, run); } catch { rec = undefined; }
  const app = rec?.job.app ?? 'native';
  const info: SourceInfo = { source: 'native', runId: run, by: `${app} run ${run.slice(0, 8)}`, record: `.timmy/native/${run}/job.json`, check: { status: 'unverified', words: 'no native receipt names this run' }, ...(rec?.job.operation ? { operation: rec.job.operation } : {}) };
  const last = rec?.verdicts.at(-1);
  if (!rec || !last) return { info, items: [], notes: rec ? [`${app} run ${run.slice(0, 8)} is not judged yet: what it wrote is listed once it is`] : [] };
  info.record = `.timmy/native/${run}/verdicts.jsonl`;
  const sealed = [...chain].reverse().find((x) => x.kind === 'native' && x.native?.run === run);
  const items: RawChange[] = [];
  for (const f of last.files ?? []) {
    if (!f.present || !f.written || f.outside) continue;
    const p = str(f.path);
    if (!p) continue;
    const pre = obj(rec.job.pre?.[p]);
    const how: ChangeHow = f.change === 'created' ? 'added' : f.change === 'changed' ? 'changed' : 'written';
    items.push({ path: p, how, before: how === 'added' ? null : pre?.state === 'present' ? shaOf(pre.sha256) : undefined, after: shaOf(f.sha256) });
  }
  if (sealed) {
    const all = items.every((i) => sealed.native?.files?.some((x) => x.path === i.path && x.sha256 === i.after));
    info.check = all ? { status: 'verified', words: `receipt ${shortReceipt(sealed)} names these files with these sha256`, receipt: shortReceipt(sealed) }
      : { status: 'unverified', words: `receipt ${shortReceipt(sealed)} names other bytes for some of them`, receipt: shortReceipt(sealed) };
    info.receipt = shortReceipt(sealed);
  }
  return { info, items, notes: [] };
}

/** Who made an edit, from its receipt's subject ("edit · <file> · <what>"; the typed /edit's is "edit · <file>"). */
function editBy(r: Receipt): string {
  const subject = String(r.subject ?? '');
  const file = r.files?.[0]?.path;
  const head = file ? `edit · ${file}` : undefined;
  if (head && subject === head) return '/edit, in your editor';
  if (head && subject.startsWith(`${head} · `)) return editActor(subject.slice(head.length + 3));
  const parts = subject.split(' · ');
  return parts.length >= 3 ? editActor(parts.slice(2).join(' · ')) : '/edit, in your editor';
}

/**
 * r21 (ledger row 163): the subject's tail names what was saved, not who saved it, and review reads "by <it>" and "as
 * <it> left it": "by restored from <file> (/restore)" and "by parameters from the live board" read wrong. The known
 * tails become the actor (src/review/restore.ts, src/repl/board-cards.ts, board-edits.ts, board-nodes.ts); any other
 * tail is shown as it was written.
 */
export function editActor(tail: string): string {
  const restored = /^restored from (.+) \(\/restore\)$/.exec(tail);
  if (restored) return `/restore (from ${restored[1]})`;
  const board = /^(.+) from the live board$/.exec(tail);
  if (board) return `the live board (${board[1]})`;
  return tail;
}

/** An edit receipt (the board's saves, /edit, /restore): each file with the previous version its sources name. */
export function editChanges(chain: readonly Receipt[], r: Receipt): Gathered {
  const check = receiptCheck(chain, r, 'is this edit\'s record');
  const info: SourceInfo = { source: 'edit', runId: shortReceipt(r), by: editBy(r), check, receipt: shortReceipt(r), ...(str(r.operation_id) ? { operation: str(r.operation_id) } : {}) };
  const sources = list(r.sources);
  const items: RawChange[] = [];
  for (const f of r.files ?? []) {
    const p = str(f.path);
    if (!p) continue;
    const added = f.created === true || (!f.previous_sha256 && f.created !== false);
    const before = added ? null : shaOf(f.previous_sha256);
    const kept = before ? sources.find((s) => s.role === 'previous version' && s.sha256 === before && str(s.path)) : undefined;
    items.push({ path: p, how: added ? 'added' : 'changed', before, after: shaOf(f.sha256), ...(kept ? { kept: String(kept.path) } : {}) });
  }
  return { info, items, notes: [] };
}

/** A job's receipt (a workflow /run, a recipe, a task): the output-folder files whose times fall in its run. */
function jobChanges(chain: readonly Receipt[], r: Receipt, label: string): Gathered {
  const check = receiptCheck(chain, r, 'names them');
  const id = r.job?.id ?? '?';
  const info: SourceInfo = { source: 'job', runId: id, by: `job ${id}${label ? ` (${label})` : ''}`, check, receipt: shortReceipt(r), ...(str(r.operation_id) ? { operation: str(r.operation_id) } : {}) };
  const items: RawChange[] = (r.outputs ?? []).flatMap((o) => (str(o.path) ? [{
    path: o.path, how: 'written' as const, after: shaOf(o.sha256), note: 'an output-folder file whose time falls in the job\'s run (by its times: another program may have written it)',
  }] : []));
  return { info, items, notes: [] };
}

// ── each change checked now ───────────────────────────────────────────────────

function nowOf(root: string, rel: string, how: ChangeHow, after: string | null | undefined): ReviewNow {
  const now = shaNow(root, rel);
  if (now === undefined) return { state: 'not comparable', words: 'it cannot be read now (outside the project, through a link, or not a file)' };
  if (now === 'large') return { state: 'not comparable', words: 'larger than 256 MB: not hashed here' };
  if (how === 'deleted' || after === null) {
    return now === null ? { state: 'still deleted', words: 'not there, as the run left it' } : { state: 'back', sha256: now, words: `there again since the run: sha256 ${short(now)}` };
  }
  if (now === null) return { state: 'gone', words: `gone since the run${after ? ` (it left sha256 ${short(after)})` : ''}` };
  if (!after) return { state: 'not comparable', sha256: now, words: `its record names no sha256 for what the run left (sha256 ${short(now)} now)` };
  return now === after ? { state: 'unchanged', sha256: now, words: `unchanged since the run: sha256 ${short(now)}` }
    : { state: 'changed since', sha256: now, words: `changed since the run: sha256 ${short(now)} now, ${short(after)} as the run left it` };
}

function keptOf(root: string, rel: string, before: string | null | undefined): ReviewKept {
  if (!isKeptPlace(rel)) return { path: rel, state: 'unreadable', words: `${rel} is not a place Timmy keeps previous versions (under .timmy)` };
  if (!before) return { path: rel, state: 'unreadable', words: `its record names no sha256 for the previous version, so the copy at ${rel} cannot be checked` };
  let lst: fs.Stats;
  try { lst = fs.lstatSync(path.join(root, rel)); } catch { return { path: rel, state: 'missing', words: `the kept copy at ${rel} is gone` }; }
  if (lst.isSymbolicLink() || !lst.isFile()) return { path: rel, state: 'unreadable', words: `the kept copy at ${rel} is not a regular file` };
  const now = shaNow(root, rel);
  if (typeof now !== 'string') return { path: rel, state: now === null ? 'missing' : 'unreadable', words: now === null ? `the kept copy at ${rel} is gone` : `the kept copy at ${rel} cannot be read` };
  return now === before ? { path: rel, state: 'ok', words: `kept at ${rel} (its sha256 is the previous version's, ${short(before)})` }
    : { path: rel, state: 'differs', words: `the copy at ${rel} is not the previous version any more: sha256 ${short(now)}, its record says ${short(before)}` };
}

/** A text file's contents, or why there is no line diff of it. */
function textOf(root: string, rel: string): { ok: true; text: string } | { ok: false; why: string } {
  try {
    const abs = path.join(root, rel);
    const st = fs.lstatSync(abs);
    if (!st.isFile()) return { ok: false, why: `${rel} is not a regular file` };
    if (st.size > DIFF_MAX_BYTES) return { ok: false, why: `larger than ${DIFF_MAX_BYTES / 1024} KB: no line diff` };
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8192).includes(0)) return { ok: false, why: 'not text (it holds NUL bytes): no line diff' };
    const text = buf.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(buf)) return { ok: false, why: 'not UTF-8 text: no line diff' };
    return { ok: true, text };
  } catch (e) { return { ok: false, why: `${rel} could not be read (${(e as NodeJS.ErrnoException).code ?? 'error'})` }; }
}

/** Diffs by the sha256 of both sides (a change is drawn on every redraw of the live board; its diff is made once). */
const diffs = new Map<string, ScriptChange | { why: string }>();
function diffOf(root: string, how: ChangeHow, file: string, kept: ReviewKept | undefined, now: ReviewNow): ReviewDiff | undefined {
  if (!kept || kept.state !== 'ok') return undefined;
  if (how === 'changed' && now.state !== 'unchanged') {
    return { shown: false, why: now.state === 'changed since' ? 'it changed since the run, so the run\'s own change cannot be drawn (the bytes it left are not kept)' : `no line diff: ${now.words}` };
  }
  if (how !== 'changed' && how !== 'deleted') return undefined;
  const keptSha = shaNow(root, kept.path);
  const key = `${typeof keptSha === 'string' ? keptSha : kept.path}\0${how === 'deleted' ? 'none' : now.sha256 ?? '?'}`;
  let got = diffs.get(key);
  if (!got) {
    const a = textOf(root, kept.path);
    const b = how === 'deleted' ? { ok: true as const, text: '' } : textOf(root, file);
    got = !a.ok ? { why: a.why } : !b.ok ? { why: b.why } : scriptChange(a.text, b.text);
    if (diffs.size > 300) diffs.clear();
    diffs.set(key, got);
  }
  if ('why' in got) return { shown: false, why: got.why };
  return { shown: true, from: kept.path, to: how === 'deleted' ? '(deleted by the run)' : file, change: got };
}

function offerOf(c: Omit<ReviewChange, 'restore'>): ReviewRestore {
  if (c.how === 'added') return { offered: false, why: 'nothing to restore: the run added it (there was no previous version)' };
  if (c.how === 'written') return { offered: false, why: c.before === null ? 'nothing to restore: it was not there before the run' : 'no previous version is kept' };
  if (c.link) return { offered: false, why: 'a symbolic link: Timmy does not restore links' };
  if (!c.kept) return { offered: false, why: 'no previous version is kept' };
  if (c.kept.state !== 'ok') return { offered: false, why: c.kept.words };
  if (c.check.status !== 'verified') return { offered: false, why: `its record is not sealed by a receipt that verifies (${c.check.words})` };
  if (c.how === 'changed' && c.now.state !== 'unchanged') {
    return { offered: false, why: c.now.state === 'changed since' ? `it changed since the run (sha256 ${short(c.now.sha256)} now; the run left ${short(c.after)}): restoring would replace a later version` : c.now.state === 'gone' ? 'it is gone since the run: a restore writes only over the file exactly as the run left it' : c.now.words };
  }
  if (c.how === 'deleted' && c.now.state !== 'still deleted') return { offered: false, why: `${c.now.words}: a restore writes only where the run left nothing` };
  const command = restoreCommand(c.path, c.kept.path);
  if (!command) return { offered: false, why: 'its name cannot be written as /restore\'s arguments (it holds both kinds of quote, or a control character)' };
  return { offered: true, from: c.kept.path, command };
}

function finish(root: string, s: SourceInfo, raw: RawChange): ReviewChange {
  const now = nowOf(root, raw.path, raw.how, raw.after);
  const kept = raw.kept && (raw.how === 'changed' || raw.how === 'deleted') ? keptOf(root, raw.kept, raw.before) : undefined;
  const keptWords = raw.how === 'added' ? 'there was no previous version: the run added it'
    : raw.how === 'written' ? (raw.before === null ? 'there was no previous version: it was not there before the run' : 'previous version not kept')
      : kept ? (kept.state === 'ok' ? `previous version ${kept.words}` : kept.words) : 'previous version not kept';
  const base: Omit<ReviewChange, 'restore'> = {
    path: raw.path, how: raw.how, by: raw.by ?? s.by, source: s.source, runId: s.runId, ...(s.operation ? { operation: s.operation } : {}),
    ...(raw.before !== undefined ? { before: raw.before } : {}), ...(raw.after !== undefined ? { after: raw.after } : {}),
    ...(raw.note ? { note: raw.note } : {}), ...(raw.link ? { link: true as const } : {}), ...(kept ? { kept } : {}), keptWords,
    now, ...(s.record ? { record: s.record } : {}), ...(s.receipt ? { receipt: s.receipt } : {}), check: s.check,
  };
  const diff = diffOf(root, raw.how, raw.path, kept, now);
  return { ...base, ...(diff ? { diff } : {}), restore: offerOf(base) };
}

/**
 * The changes from one source, with the paths that are not listed counted (Timmy's own, private, not plain), and those past
 * the operation's budget counted without being checked (a render sequence is not hashed frame by frame to be cut off).
 */
interface Tally { timmy: number; private: number; odd: number; left: number; more: number }
function finishAll(root: string, g: Gathered, seen: Set<string>, tally: Tally): ReviewChange[] {
  const out: ReviewChange[] = [];
  for (const raw of g.items) {
    const p = plainRel(raw.path);
    if (!p) { tally.odd++; continue; }
    if (inTimmy(p)) { tally.timmy++; continue; }
    if (privatePath(p)) { tally.private++; continue; }
    // One change seen through two records (a flow and its app's run, a flow and the workflow job it ran in) is listed once:
    // the same path, before and after; a file only said to be written, by the same path and resulting bytes.
    const key = `${p}\0${raw.before ?? '-'}\0${raw.after ?? '-'}`;
    const left = `${p}\0=\0${raw.after ?? '-'}`;
    if (seen.has(key) || (raw.how === 'written' && seen.has(left))) continue;
    seen.add(key);
    seen.add(left);
    if (tally.left <= 0) { tally.more++; continue; }
    tally.left--;
    out.push(finish(root, g.info, { ...raw, path: p }));
  }
  return out;
}

const toneOf = (state: string): CardTone => (/^(running|starting|queued)/.test(state) ? 'running'
  : /^(succeeded|completed|ok|answered)/.test(state) ? 'ok'
    : /^(stopped|cancelled|interrupted)/.test(state) ? 'stopped'
      : /^(refused|differs|partial|not recorded)/.test(state) ? 'attention'
        : /^(failed|unknown)/.test(state) ? 'failed' : 'neutral');

/** One operation: everything its runs and edits changed (the first `max`; the rest counted), each checked now. */
export function operationReview(ix: OpIndex, id: string, o: { max?: number } = {}): ReviewOperation {
  const cap = o.max ?? MAX_CHANGES;
  const root = ix.root;
  let rec = ix.records.get(id)?.record;
  if (!rec) { const r = readOperationRecord(root, id); if (r.ok) rec = r.record; }
  let state: string = rec?.state ?? 'not recorded here';
  if (rec && rec.ended === null && writerState(rec.owner) === 'gone') state = 'interrupted';
  const notes: string[] = [];
  const changes: ReviewChange[] = [];
  const seen = new Set<string>();
  const tally: Tally = { timmy: 0, private: 0, odd: 0, left: cap, more: 0 };
  const flows = ix.flows.get(id) ?? [];
  const claimed = new Set<string>();
  for (const f of flows) for (const c of flowClaims(f.record)) claimed.add(c);
  for (const f of flows) {
    const r = obj(f.record) ?? {};
    if (f.live && r.outcome === 'running') { notes.push(`flow ${str(r.id) ?? '?'} is running (its ${str(r.step) ?? '?'} step): what it changes is listed once it ends`); continue; }
    const g = flowChanges(root, f.file, f.record, flowCheckWords(f.check));
    changes.push(...finishAll(root, g, seen, tally));
    notes.push(...g.notes);
  }
  for (const run of ix.agents.get(id) ?? []) {
    if (claimed.has(`agent:${run}`)) continue;
    const g = agentChanges(root, ix.chain, run);
    changes.push(...finishAll(root, g, seen, tally));
    notes.push(...g.notes);
  }
  for (const run of ix.natives.get(id) ?? []) {
    if (claimed.has(`native:${run}`)) continue;
    const g = nativeChanges(root, ix.chain, run);
    changes.push(...finishAll(root, g, seen, tally));
    notes.push(...g.notes);
  }
  const receipts = ix.receipts.get(id) ?? [];
  for (const r of receipts) {
    if (r.kind !== 'edit') continue;
    changes.push(...finishAll(root, editChanges(ix.chain, r), seen, tally));
  }
  for (const j of ix.jobs.get(id) ?? []) {
    if (claimed.has(`job:${j.id}`)) continue;
    const r = receipts.find((x) => (x.kind === 'workflow' || x.kind === 'task') && x.job?.id === j.id);
    if (r?.outputs?.length) changes.push(...finishAll(root, jobChanges(ix.chain, r, ix.scrub(j.label).slice(0, 80)), seen, tally));
    if (j.kind === 'workflow') notes.push(`workflow run ${j.id}: a block's own command may change files Timmy does not record; listed are what its flows, agents and native runs changed and the output-folder files its receipt names`);
  }
  if (tally.timmy) notes.push(`${plural(tally.timmy, 'file')} in Timmy's own folders (.timmy: its records and kept versions) ${tally.timmy === 1 ? 'is' : 'are'} not listed`);
  if (tally.private) notes.push(`${plural(tally.private, 'private file')} (keys, .env files, .git, .timmy/private) ${tally.private === 1 ? 'is' : 'are'} not listed, and never restored`);
  if (tally.odd) notes.push(`${plural(tally.odd, 'path')} its records name ${tally.odd === 1 ? 'is' : 'are'} not a plain path in the project: not listed`);
  return {
    id, request: rec ? ix.scrub(rec.request) : '(no record of its request in this project)', ...(rec ? { via: rec.via, started: rec.started } : {}),
    state, tone: toneOf(state), ...(rec ? { record: `.timmy/operations/${id}.json` } : {}),
    changes, more: tally.more, cap, notes: [...new Set(notes)],
  };
}

/**
 * The newest operations that changed files (or have something to say), at most `max`, from the `look` most recent (running
 * first); `quiet` and `looked` count only the operations read before the `max`-th was found.
 */
export function reviewView(ix: OpIndex, o: { max?: number; look?: number } = {}): ReviewView {
  const ids = recentOperations(ix, o.look ?? 24);
  const max = o.max ?? 6;
  const operations: ReviewOperation[] = [];
  let quiet = 0;
  let looked = 0;
  for (const id of ids) {
    if (operations.length >= max) break;
    looked++;
    const op = operationReview(ix, id);
    if (!op.changes.length && !op.notes.length) { quiet++; continue; }
    operations.push(op);
  }
  return { operations, quiet, looked };
}

/** What is left off one operation's list, in words (empty when nothing is). */
export function moreWords(op: ReviewOperation): string {
  if (!op.more) return '';
  const n = `${op.more} more change${op.more === 1 ? '' : 's'}`;
  return op.cap < MAX_CHANGES_ONE ? `and ${n}: /review ${op.id} lists up to ${MAX_CHANGES_ONE}`
    : `and ${n} not listed (one review lists ${op.cap} at most): its records name them all`;
}

// ── a kept previous version, from where it is kept (for /restore) ─────────────

export interface KeptContext { root: string; projectId: string; chain: readonly Receipt[] }

/**
 * The change that a kept previous version belongs to, found from where it is kept (complete, unlike the recent lists): a
 * flow's copy (.timmy/flows/<id>/) by its flow record; an OpenHands before/ copy by its run's result; a copy the board's
 * saves or /restore kept by the edit receipt that names it. Each is checked now, as /review checks it.
 */
export function findKeptChange(c: KeptContext, file: string, from: string): { ok: true; change: ReviewChange } | { ok: false; why: string } {
  const flow = /^\.timmy\/flows\/(f[0-9a-f]{8})\/[^/]+$/.exec(from);
  const agent = /^\.timmy\/agents\/(a[0-9a-f]{8})\/before\/.+$/.exec(from);
  let found: Gathered[] = [];
  let names = '';
  if (flow) {
    const rel = flowRecordPath(flow[1]);
    const r = readRecord(c.root, rel);
    if (!r.ok) return { ok: false, why: `${from} is kept for flow ${flow[1]}, whose record cannot be read: ${r.error}` };
    found = [flowChanges(c.root, rel, r.value, flowCheckWords(checkFlowRecord(rel, r.sha256, c.chain, c.projectId)))];
    names = `flow ${flow[1]}'s record (${rel})`;
  } else if (agent) {
    found = [agentChanges(c.root, c.chain, agent[1])];
    names = `agent run ${agent[1]}'s result`;
  } else if (isKeptPlace(from)) {
    found = [...c.chain].reverse()
      .filter((r) => r.kind === 'edit' && r.project_id === c.projectId && list(r.sources).some((s) => s.path === from && s.role === 'previous version'))
      .map((r) => editChanges(c.chain, r));
    if (!found.length) return { ok: false, why: `no edit receipt of this project names ${from} as a previous version` };
    names = 'the edit receipt that names it';
  } else {
    return { ok: false, why: `${from} is not a previous version Timmy keeps (a flow's copy in .timmy/flows/, an OpenHands run's before/, the board's saves in .timmy/params-history/ and .timmy/workflow-history/, /restore's in ${RESTORE_HISTORY_DIR}/)` };
  }
  for (const g of found) {
    const raw = g.items.find((i) => i.path === file && i.kept === from);
    if (raw) return { ok: true, change: finish(c.root, g.info, raw) };
  }
  return { ok: false, why: `${names} does not name ${from} as the previous version of ${file}` };
}
