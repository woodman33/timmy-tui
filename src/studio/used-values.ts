/**
 * R4 (H109; r25 D9 c): what an operation used of a parameter file, from that operation's own records, for the parameter card
 * Timmy Canvas places for the operation (companion/studio-canvas/src/cards.js, a card placed by "Place this operation"). r25
 * saw such a card show today's values (width 160, "newest build 160 x 80 x 30") instead of the 150 that operation used.
 *
 * The values come from the operation's records, found by its id and never by a file's time (src/ops/evidence.ts keeps the same
 * rule for a workflow block's evidence), in this order:
 *   1. its flow record that names the file (results/flows/<id>.json whose `operation` is it and whose `parameters.path` is the
 *      file): the values after its agent, or before when its record names none after (a flow that made no change, or one whose
 *      agent left the file unusable), with the sha256 its record names; verified when a flow receipt of this project on the
 *      runs chain names exactly the record's bytes and no other operation (evidence.ts sealOf);
 *   2. else the newest receipt of the operation on the runs chain that names the file's bytes (a board or canvas save, an
 *      agent's run): the values in those bytes, read from the file when it holds the same bytes now, or from a kept copy whose
 *      bytes hash the same (.timmy/params-history/, a flow's kept copy); when no copy holds them, unknown, and why;
 *   3. else unknown: no record of the operation names the file.
 * The card shows these beside the file as it is now ("now 160 in recipes/tray.params.json"), never in place of them. Nothing
 * here writes, runs or seals; every text goes through the caller's `t` (the project's folder as ".", the home folder as "~").
 */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { FLOWS_DIR, mmText } from '../flows/iterate.js';
import { parseScadParams, readScadParams, type ScadValue } from '../native/scad-params.js';
import { sealOf } from '../ops/evidence.js';
import { OPERATION_ID } from '../ops/context.js';
import { readProjectFile } from '../project/index.js';
import { PARAMETER_NAMES } from '../recipes/index.js';
import { parseParams, readParams } from '../recipes/params-file.js';
import type { Receipt } from '../utils/receipts.js';
import { shaNow, type ParamsDetail, type Text } from './card-detail.js';

export interface UsedValue { name: string; value: number | string | boolean; unit?: string }

/** What an operation used of a parameter file, as its records say (`recorded`), or why that is not known (`unknown`). */
export interface UsedValues {
  operation: string;
  /** the parameter file, project-relative */
  file: string;
  state: 'recorded' | 'unknown';
  /** the values, in the card's order; [] when unknown */
  values: UsedValue[];
  /** the sha256 of the file's bytes the operation used, when a record names it */
  sha256: string | null;
  /** where the values were read, or why they are not known, in words */
  from: string;
  /** a receipt on the runs chain names exactly the bytes the values were read from (the flow record's, or the file's) */
  verified: boolean;
  /** the build that used them, in words, when a record names one */
  build: string | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const SHA = /^[0-9a-f]{64}$/;
const isSha = (v: unknown): v is string => typeof v === 'string' && SHA.test(v);
const short = (r: Receipt): string => (typeof r.hash === 'string' && r.hash.length > 15 ? r.hash.slice(7, 15) : String(r.id ?? '?'));
const s12 = (s: string): string => s.slice(0, 12);
const FLOW_FILE = /^(f[0-9a-f]{8})\.json$/;
const RECORD_MAX = 1024 * 1024;

// ── the flow records, read in place (kept by size and time, as card-detail.ts keeps a file's hash) ──────────────

interface FlowRec { id: string; rel: string; sha256: string; value: Obj }
const flowCache = new Map<string, { size: number; mtime: number; rec: FlowRec | null }>();

/**
 * Every tray flow record of the project (results/flows/f<8 hex>.json), by its name, in place: no link on the folder or the
 * file, at most 1 MB, JSON of schema timmy.flow/1 whose id is its name. A file that is not one is left out (the project's cards
 * name it as unreadable).
 */
export function flowRecords(root: string): FlowRec[] {
  let at = root;
  for (const part of FLOWS_DIR.split('/')) {
    at = join(at, part);
    try { if (lstatSync(at).isSymbolicLink()) return []; } catch { return []; }
  }
  let names: string[];
  try { names = readdirSync(at).filter((n) => FLOW_FILE.test(n)).sort(); } catch { return []; }
  const out: FlowRec[] = [];
  for (const n of names) {
    const abs = join(at, n);
    let size = 0;
    let mtime = 0;
    try {
      const st = lstatSync(abs);
      if (st.isSymbolicLink() || !st.isFile() || st.size > RECORD_MAX) continue;
      size = st.size;
      mtime = st.mtimeMs;
    } catch { continue; }
    const kept = flowCache.get(abs);
    if (kept && kept.size === size && kept.mtime === mtime) { if (kept.rec) out.push(kept.rec); continue; }
    let rec: FlowRec | null = null;
    try {
      const buf = readFileSync(abs);
      const value = obj(JSON.parse(buf.toString('utf8')));
      const id = FLOW_FILE.exec(n)![1];
      if (value && value.schema === 'timmy.flow/1' && value.id === id) rec = { id, rel: `${FLOWS_DIR}/${n}`, sha256: createHash('sha256').update(buf).digest('hex'), value };
    } catch { rec = null; }
    flowCache.set(abs, { size, mtime, rec });
    if (flowCache.size > 2048) flowCache.delete(flowCache.keys().next().value!);
    if (rec) out.push(rec);
  }
  return out;
}

// ── values ───────────────────────────────────────────────────────────────────

/** A tray value set as a record holds it: numbers only, by name; null when it is not one. */
function trayNumbers(v: unknown): Record<string, number> | null {
  const o = obj(v);
  if (!o) return null;
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(o)) if (typeof x === 'number' && Number.isFinite(x)) out[k] = x;
  return Object.keys(out).length ? out : null;
}

/** Values in the card's order: the recipe's names first (each in millimetres), then any other name a record holds. */
function trayValues(values: Record<string, number>): UsedValue[] {
  const names = [...PARAMETER_NAMES.filter((n) => n in values), ...Object.keys(values).filter((k) => !(PARAMETER_NAMES as readonly string[]).includes(k)).sort()];
  return names.map((name) => ({ name, value: values[name], unit: 'mm' }));
}

function scadValues(values: Record<string, ScadValue>): UsedValue[] {
  return Object.entries(values).slice(0, 40).map(([name, value]) => ({ name, value }));
}

/** The values in a parameter file's bytes (`text`), by the file's own rules; null when they are not usable. */
function valuesIn(text: string, d: Pick<ParamsDetail, 'engine' | 'model'>): UsedValue[] | null {
  if (d.engine === 'tray') {
    const p = parseParams(text);
    return p.ok ? trayValues(p.parameters) : null;
  }
  const p = parseScadParams(text, basename(d.model ?? ''));
  return p.ok ? scadValues(p.parameters) : null;
}

/** The values the file holds now, by its own rules (the tray recipe's readParams; an OpenSCAD model's readScadParams). */
function valuesNow(root: string, d: Pick<ParamsDetail, 'engine' | 'model'>): UsedValue[] | null {
  if (d.engine === 'tray') {
    const r = readParams(root);
    return r.ok && r.exists ? trayValues(r.parameters) : null;
  }
  const r = readScadParams(root, d.model ?? '');
  return r.ok && r.exists ? scadValues(r.parameters) : null;
}

/** A flow's build in words: its rebuild (the recipe job and its state, the prediction) and its readback's verdict. */
function buildWords(v: Obj): string | null {
  const rb = obj(v.rebuild);
  const parts: string[] = [];
  if (rb) {
    const job = str(rb.job);
    parts.push(`${job ? `recipe job ${job.slice(0, 8)}` : 'its rebuild'} ${str(rb.state) ?? 'in a state its record does not name'}`);
    const predicted = obj(rb.predicted);
    const b = predicted?.bounds_mm;
    if (Array.isArray(b) && b.length === 3 && b.every((n) => typeof n === 'number' && Number.isFinite(n))) parts.push(`predicted ${mmText(b as number[])} mm`);
  }
  const verdict = str(obj(v.readback)?.verdict);
  if (verdict) parts.push(`its readback ${verdict}`);
  return parts.length ? parts.join(', ') : null;
}

// ── the reader ───────────────────────────────────────────────────────────────

export interface UsedReader {
  /** What operation `op` used of the parameter file `d` shows; null when no record of the operation names the file. */
  of(op: string, d: Pick<ParamsDetail, 'file' | 'engine' | 'model'>): UsedValues | null;
}

/**
 * A reader for one reading of the project: the flow records are read once (kept by size and time between readings), the runs
 * chain is the one the reading holds. `pid`: the project's id, as its receipts name it.
 */
export function usedReader(src: { root: string; pid: string; chain: readonly Receipt[]; t: Text }): UsedReader {
  const { root, pid, chain, t } = src;
  let flows: FlowRec[] | null = null;
  const allFlows = (): FlowRec[] => (flows ??= flowRecords(root));
  const unknown = (op: string, file: string, from: string): UsedValues => ({ operation: op, file, state: 'unknown', values: [], sha256: null, from: t(from, 400), verified: false, build: null });

  /** Bytes of `file` whose sha256 is `sha`, kept by Timmy: the parameter histories, and a flow's kept copy of the file before its agent. */
  function keptCopy(d: Pick<ParamsDetail, 'file' | 'engine'>, sha: string): { rel: string; text: string } | null {
    const dirs = d.engine === 'tray' ? ['.timmy/params-history/tray'] : [`.timmy/params-history/scad/${d.file}`];
    const candidates: string[] = [];
    for (const dir of dirs) {
      try {
        const head = new RegExp(`-${s12(sha)}(?:-\\d+)?\\.json$`);
        for (const n of readdirSync(join(root, dir)).sort()) if (head.test(n)) candidates.push(`${dir}/${n}`);
      } catch { /* none kept there */ }
    }
    for (const f of allFlows()) {
      const p = obj(f.value.parameters);
      const before = obj(p?.before);
      if (p?.path === d.file && before?.sha256 === sha && typeof before.kept === 'string') candidates.push(before.kept);
    }
    for (const rel of candidates) {
      const r = readProjectFile(root, rel, 64 * 1024);
      if (r.ok && r.sha256 === sha && typeof r.text === 'string' && !r.truncated) return { rel: r.rel, text: r.text };
    }
    return null;
  }

  function fromFlow(op: string, d: Pick<ParamsDetail, 'file' | 'engine' | 'model'>): UsedValues | null {
    if (d.engine !== 'tray') return null;
    const mine = allFlows().filter((f) => f.value.operation === op && obj(f.value.parameters)?.path === d.file);
    if (!mine.length) return null;
    const time = (f: FlowRec): number => { const x = Date.parse(String(f.value.started_at ?? '')); return Number.isFinite(x) ? x : 0; };
    const f = [...mine].sort((a, b) => time(a) - time(b) || a.id.localeCompare(b.id))[mine.length - 1];
    const p = obj(f.value.parameters)!;
    const after = obj(p.after);
    const before = obj(p.before);
    const invalid = obj(p.invalid);
    const usedAfter = trayNumbers(after?.values);
    const values = usedAfter ?? trayNumbers(before?.values);
    const outcome = str(f.value.outcome) ?? 'unknown';
    const seal = sealOf(chain, { kind: 'flow', rel: f.rel, sha256: f.sha256 }, pid, op);
    const sealWords = seal.ok ? `; receipt ${short(seal.receipt)} sealed its record` : `; its record is not verified: ${seal.why}`;
    const which = mine.length > 1 ? `the last of its ${mine.length} flows that changed ${d.file}, flow ${f.id}` : `its flow ${f.id}`;
    if (!values) return { ...unknown(op, d.file, `${which} (${outcome}) names no values of ${d.file}${sealWords}`), verified: seal.ok };
    const rebuilt = !!obj(f.value.rebuild) && (outcome === 'succeeded' || outcome === 'differs');
    const how = outcome === 'no change' ? `${which} made no change: these are the values its agent left as they were, and nothing was rebuilt`
      : rebuilt ? `${which} (${outcome}) rebuilt the tray from these values`
        : invalid && !usedAfter ? `${which} ended ${outcome}: its agent left ${d.file} not usable, so these are the values before it`
          : `${which} ended ${outcome} before a build used them: these are the values its record names ${usedAfter ? 'after its agent' : 'before its agent'}`;
    const sha = isSha(after?.sha256) && usedAfter ? after!.sha256 as string : isSha(before?.sha256) ? before!.sha256 as string : null;
    return {
      operation: op, file: d.file, state: 'recorded', values: trayValues(values), sha256: sha, from: t(`${how}${sealWords}`, 600), verified: seal.ok,
      build: rebuilt ? (() => { const w = buildWords(f.value); return w ? t(w, 300) : null; })() : null,
    };
  }

  function fromReceipt(op: string, d: Pick<ParamsDetail, 'file' | 'engine' | 'model'>): UsedValues | null {
    let found: { r: Receipt; sha: string } | null = null;
    for (let i = chain.length - 1; i >= 0 && !found; i--) {
      const r = chain[i];
      if (r.project_id !== pid || r.operation_id !== op) continue;
      const named = [...(r.files ?? []), ...(r.outputs ?? [])].find((x) => x && x.path === d.file && isSha(x.sha256));
      if (named) found = { r, sha: named.sha256 as string };
    }
    if (!found) return null;
    const { r, sha } = found;
    const said = `receipt ${short(r)} (${r.kind}) names ${d.file} as sha256 ${s12(sha)}`;
    const now = shaNow(root, d.file);
    if ('sha' in now && now.sha === sha) {
      const values = valuesNow(root, d);
      if (values) return { operation: op, file: d.file, state: 'recorded', values, sha256: sha, from: t(`${said}, and the file holds the same bytes now`, 600), verified: true, build: null };
    }
    const kept = keptCopy(d, sha);
    if (kept) {
      const values = valuesIn(kept.text, d);
      if (values) return { operation: op, file: d.file, state: 'recorded', values, sha256: sha, from: t(`${said}; a kept copy (${kept.rel}) holds those bytes`, 600), verified: true, build: null };
      return { ...unknown(op, d.file, `${said}; a kept copy (${kept.rel}) holds those bytes, and they are not a usable parameter file`), sha256: sha };
    }
    const nowWords = 'sha' in now ? `the file is sha256 ${s12(now.sha)} now` : now.why === 'gone' ? 'the file is not there now' : 'the file cannot be read now';
    return { ...unknown(op, d.file, `${said}, ${nowWords}, and no copy Timmy kept holds those bytes, so the values it used are not known`), sha256: sha };
  }

  return {
    of(op, d) {
      if (!OPERATION_ID.test(op)) return null;
      try {
        return fromFlow(op, d) ?? fromReceipt(op, d);
      } catch (e) {
        return unknown(op, d.file, `the records of operation ${op} could not be read (${e instanceof Error ? e.message : String(e)})`);
      }
    },
  };
}
