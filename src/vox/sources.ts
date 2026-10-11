/**
 * Timmy VoxVision (round R4, helper H61): "CAD checked". A value of generated CAD is compared with its source's own
 * report or prediction, found by the bytes measured (their sha256) in the project's receipts and records:
 *
 *   an STL OpenSCAD wrote    Timmy's STL reading (bounding box min, max and size) against OpenSCAD's own summary
 *                            (openscad-summary.json, written by --summary all) of the run whose native receipt names
 *                            these bytes and that summary's sha256; within float32's precision, as the OpenSCAD route
 *                            itself judges it (src/native/openscad.ts): |difference| ≤ 1e-6 × max(1, |value|)
 *   a STEP a flow delivered  OCP's readback (one valid solid, the bounding-box size, the volume) against the recipe's
 *                            prediction sealed before the build: the `predict` receipt the flow record names, read for
 *                            its own values (never the flow record's copy), within the flow's own tolerance
 *                            (src/flows/iterate.ts READBACK_TOLERANCE, compareReadback)
 *
 * Nothing runs and nothing is written here: receipts and records are read. A check that finds its source but cannot
 * compare (the summary gone or not the sealed bytes, a prediction receipt not on the chain) says why, and the values
 * stay "measured". The check is kept on the VoxVision record with each value compared.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { compareReadback, listFlows, READBACK_TOLERANCE, toleranceText, type ReadbackMeasured } from '../flows/iterate.js';
import type { StlReadback } from '../native/stl-readback.js';
import { resolveInside } from '../project/index.js';
import type { Receipt } from '../utils/receipts.js';

export interface VoxSourceCheck {
  /** the input it checks (its path), and its role in a /compare */
  input: string;
  role?: 'a' | 'b';
  /** what it was checked against, in words */
  against: string;
  /** the evidence: what kind, the file (and its sha256 now), the receipt that sealed it, the run or flow */
  source: { kind: 'openscad-summary' | 'flow-prediction'; path?: string; sha256?: string; receipt?: string; run?: string; flow?: string };
  tolerance: string;
  /** each value compared: the metric it is part of, the source's value, Timmy's, the difference, within tolerance or not */
  compared: Array<{ metric: string; what: string; reported: number | boolean; measured: number | boolean; difference: number | null; within: boolean }>;
  /** every compared value within tolerance (false when nothing could be compared) */
  agrees: boolean;
  /** the source was found but not compared: why */
  why?: string;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const triple = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every(finite);
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
/** A receipt's short id, as the REPL names receipts (the store writes `sha256_<hex>`; tests `sha256:<hex>`). */
export const receiptShort = (r: Pick<Receipt, 'hash'>): string => (typeof r.hash === 'string' ? r.hash.replace(/^sha256[:_]/, '').slice(0, 8) : '');
const ofProject = (r: Receipt, pid?: string): boolean => !pid || r.project_id === pid;

/** float32 coordinates in the STL against OpenSCAD's doubles (src/native/openscad.ts summaryOf). */
const f32 = (v: number): number => 1e-6 * Math.max(1, Math.abs(v));
const F32_WORDS = "float32's precision (1e-6 × the value, at least 1e-6: the STL stores float32 coordinates)";
const AXES = ['x', 'y', 'z'] as const;

/**
 * Timmy's STL reading against OpenSCAD's own summary of the run that wrote these bytes (the newest such run of this
 * project judged ok whose native receipt names them); null when no OpenSCAD run of this project wrote them.
 */
export function scadSummaryCheck(o: { root: string; chain: readonly Receipt[]; projectId?: string; input: { path: string; sha256: string; role?: 'a' | 'b' }; readback: StlReadback }): VoxSourceCheck | null {
  for (let i = o.chain.length - 1; i >= 0; i--) {
    const r = o.chain[i];
    const n = obj(r.native);
    if (r.kind !== 'native' || n?.app !== 'openscad' || n.outcome !== 'ok' || !ofProject(r, o.projectId)) continue;
    const files = Array.isArray(n.files) ? n.files.map(obj) : [];
    const stl = files.find((f) => f?.sha256 === o.input.sha256 && f.written !== false);
    if (!stl) continue;
    const run = str(n.run);
    const summary = obj(obj(n.scad)?.summary);
    const base = {
      input: o.input.path, ...(o.input.role ? { role: o.input.role } : {}),
      against: `OpenSCAD's own summary of the run${run ? ` ${run.slice(0, 8)}` : ''} that wrote these bytes (${str(stl.path) ?? 'its STL'})`,
      tolerance: F32_WORDS,
    };
    const src = { kind: 'openscad-summary' as const, receipt: receiptShort(r), ...(run ? { run } : {}) };
    const cannot = (why: string, extra: Partial<VoxSourceCheck['source']> = {}): VoxSourceCheck => ({ ...base, source: { ...src, ...extra }, compared: [], agrees: false, why });
    if (summary?.state !== 'written' || !str(summary.path) || !str(summary.sha256)) return cannot(`its native receipt names no written summary (state ${String(summary?.state ?? 'none')})`);
    const path = str(summary.path)!;
    const at = resolveInside(o.root, path);
    if ('error' in at) return cannot(`its summary ${path} is not inside the project`, { path });
    let body: Buffer;
    try { body = readFileSync(at.path); } catch { return cannot(`its summary ${path} is gone`, { path }); }
    const now = sha(body);
    if (now !== summary.sha256) return cannot(`its summary ${path} is not the file its receipt sealed (sha256 ${now.slice(0, 12)} now, ${String(summary.sha256).slice(0, 12)} sealed)`, { path, sha256: now });
    let box: Obj | undefined;
    try { box = obj(obj(obj(JSON.parse(body.toString('utf8')))?.geometry)?.bounding_box); } catch { box = undefined; }
    if (!box || !triple(box.min) || !triple(box.max)) return cannot(`its summary ${path} holds no bounding box`, { path, sha256: now });
    if (!o.readback.bbox) return cannot('Timmy\'s reading has no bounding box (the STL has no triangles)', { path, sha256: now });
    const min = box.min as [number, number, number];
    const max = box.max as [number, number, number];
    const rb = o.readback.bbox;
    const compared: VoxSourceCheck['compared'] = [];
    AXES.forEach((axis, k) => {
      for (const [metric, reported, measured, tol] of [
        ['bbox_min', min[k], rb.min[k], f32(min[k])],
        ['bbox_max', max[k], rb.max[k], f32(max[k])],
        ['bbox_size', max[k] - min[k], rb.size[k], f32(min[k]) + f32(max[k])],
      ] as Array<[string, number, number, number]>) {
        const d = measured - reported;
        compared.push({ metric, what: `${metric.replace('bbox_', 'bounding box ')} ${axis}`, reported, measured, difference: d, within: Math.abs(d) <= tol });
      }
    });
    return { ...base, source: { ...src, path, sha256: now }, compared, agrees: compared.every((c) => c.within) };
  }
  return null;
}

/**
 * OCP's readback of a STEP against the sealed prediction of the flow that delivered these bytes (the newest flow record
 * of the project naming them as its rebuild's output or its readback's STEP); null when no flow names them.
 */
export function flowPredictionCheck(o: { root: string; chain: readonly Receipt[]; projectId?: string; input: { path: string; sha256: string; role?: 'a' | 'b' }; measured: ReadbackMeasured }): VoxSourceCheck | null {
  let flows: ReturnType<typeof listFlows>;
  try { flows = listFlows(o.root); } catch { return null; }
  for (const f of flows) {
    const rb = f.record.rebuild;
    const named = (rb?.outputs ?? []).some((x) => x?.sha256 === o.input.sha256) || f.record.readback?.step?.sha256 === o.input.sha256;
    if (!named) continue;
    const id = str(rb?.prediction_receipt);
    const base = {
      input: o.input.path, ...(o.input.role ? { role: o.input.role } : {}),
      against: `the recipe's prediction sealed before flow ${f.record.id}'s build${id ? ` (receipt ${id})` : ''}`,
      tolerance: `the flow's own tolerance (${toleranceText(READBACK_TOLERANCE)})`,
    };
    const src = { kind: 'flow-prediction' as const, flow: f.record.id, path: f.rel, ...(id ? { receipt: id } : {}) };
    if (!id) return { ...base, source: src, compared: [], agrees: false, why: `flow ${f.record.id} names no sealed prediction` };
    const sealed = [...o.chain].reverse().find((r) => r.kind === 'predict' && ofProject(r, o.projectId) && (receiptShort(r) === id || r.hash === id || r.id === id));
    if (!sealed) return { ...base, source: src, compared: [], agrees: false, why: `its prediction receipt ${id} is not on this project's runs chain` };
    const p = (Array.isArray(sealed.sources) ? sealed.sources.map(obj) : []).find((s) => s && triple(s.bounds_mm) && finite(s.volume_mm3) && (s.units === undefined || s.units === 'mm'));
    if (!p) return { ...base, source: src, compared: [], agrees: false, why: `its prediction receipt ${id} holds no bounding box and volume in millimetres` };
    const cmp = compareReadback({ bounds: p.bounds_mm as number[], volume: p.volume_mm3 as number }, o.measured, READBACK_TOLERANCE);
    const metricOf = (name: string): string => (name === 'valid shape' ? 'valid' : name === 'solids' ? 'solids' : name.startsWith('bounds') ? 'bbox_size' : 'volume');
    const compared = cmp.checks.map((c) => ({ metric: metricOf(c.name), what: c.name, reported: c.predicted, measured: c.measured, difference: c.difference, within: c.passed }));
    return { ...base, source: src, compared, agrees: compared.every((c) => c.within) };
  }
  return null;
}

/** A check in one line: what it compared against, and how it came out. */
export function checkWords(c: VoxSourceCheck): string {
  if (c.why) return `not CAD checked against ${c.against}: ${c.why}`;
  const off = c.compared.filter((x) => !x.within);
  if (!off.length) return `CAD checked against ${c.against}: ${c.compared.length} value${c.compared.length === 1 ? '' : 's'} within ${c.tolerance}`;
  return `not CAD checked: ${off.length} of ${c.compared.length} values differ from ${c.against} beyond ${c.tolerance} (${off.slice(0, 3).map((x) => `${x.what}: ${String(x.measured)} measured, ${String(x.reported)} reported`).join('; ')})`;
}
