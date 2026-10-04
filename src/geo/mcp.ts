// Geo lane MCP surface — the two Lab50 geometry tools as MCP tools (the CLI route is the lane scripts themselves):
//   timmy_geo_score  → lanes/geo/voxel_score.py   voxel F1/IoU + Chamfer + F-score@τ, metric unless fitted
//   timmy_geo_scale  → lanes/geo/scale_solver.py  per-view metric scales from self-consistency, untrusted at the grid edge
// Both run in a child python3, never import numpy into the server, and seal one receipt per call. Honesty clause: the
// lane's own exit codes are kept — 0 ok, 2 computed-but-not-trusted (fit applied / scale at the grid edge), 3
// not_configured (no numpy+scipy) — and a missing input file is refused before any process starts.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { appendReceipt } from '../utils/receipts.js';

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const text = { type: 'string' }, num = { type: 'number' }, bool = { type: 'boolean' };
const LANE = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'lanes', 'geo');
const HOME = process.env.HOME ?? '';
const scrub = (s: string) => (HOME ? s.split(HOME).join('~') : s);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export const GEO_TOOLS = [
  { name: 'timmy_geo_score', description: 'Voxel bench: score a predicted shape (PLY/JSON/mesh) against a truth shape in the SAME metric frame — voxel precision/recall/F1/IoU on a truth-anchored grid (voxel metres; tolerance as a voxel fraction, 1.0 = one-voxel rule), Chamfer distance and F-score@τ. Nothing is fitted unless fit=true, which marks metric:false (status untrusted). normalize=true uses the unit-cube protocol of 3D-generation papers. Every call sealed as a geo.voxel-score receipt; without numpy+scipy returns not_configured.', inputSchema: schema({ truth: text, pred: text, voxel: num, tau: num, tolerance: num, samples: num, normalize: bool, fit: bool, out: text }, ['truth', 'pred']) },
  { name: 'timmy_geo_bench', description: 'Public-set bench (Google Scanned Objects first): step=predict seals the expected median voxel F1 / F-score for a model BEFORE scoring (scores/prediction.json, hashed); step=score runs voxel_score.py over PRED/<id>.(ply|glb|obj|json) against the extracted truth (frame metric|unit) and writes scores/summary.json with medians, missing predictions, and the graded prediction (as_predicted / falsified). fit or normalize_each mark the run metric:false (generation outputs). Receipted; not_configured without numpy+scipy+trimesh. Downloads are a CLI step (bench_loader.py fetch), never taken here.', inputSchema: schema({ step: { type: 'string', enum: ['predict', 'score'] }, bench: text, model: text, expect_f1: num, expect_fscore: num, tolerance_f1: num, basis: text, pred_dir: text, frame: { type: 'string', enum: ['metric', 'unit'] }, voxel: num, tau: num, tolerance: num, samples: num, fit: bool, normalize_each: bool }, ['step', 'bench']) },
  { name: 'timmy_geo_scale', description: 'Metric scale from self-consistency: given per-view depth clouds with known camera poses in metres (views.json: {views:[{ply|points_cam, R, t}]}, OpenCV cameras), solve one depth scale per view from cross-view agreement alone. at_grid_edge=true means a scale sat on the search bound and the result is untrusted (status untrusted). Sealed as a geo.scale-solve receipt; not_configured without numpy+scipy.', inputSchema: schema({ views: text, rounds: num, sub: num, lo: num, hi: num, out: text }, ['views']) },
];

type Outcome = { ok: boolean; status: 'ok' | 'partial' | 'untrusted' | 'not_configured' | 'failed' | 'invalid_request'; exit_code: number | null; ms: number; result: unknown; stderr?: string; receipt?: string; note?: string };

// store_true flags on the lanes: a client's 'true' / 1 / 'yes' means the flag, anything else means its absence —
// never `--fit true`, which argparse rejects with exit 2 (and exit 2 is the lanes' "untrusted" code).
const BOOL_FLAGS = new Set(['fit', 'normalize', 'normalize-each']);
const truthy = (v: unknown) => v === true || v === 1 || v === '1' || (typeof v === 'string' && ['true', 'yes', 'on'].includes(v.toLowerCase()));
function flags(args: Record<string, unknown>, keys: string[]): string[] {
  const out: string[] = [];
  for (const k of keys) {
    const v = args[k];
    if (v === undefined || v === null || v === false) continue;
    if (BOOL_FLAGS.has(k)) { if (truthy(v)) out.push(`--${k}`); continue; }
    if (v === true) { out.push(`--${k}`); continue; }
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    out.push(`--${k}`, String(v));
  }
  return out;
}

function runLane(script: string, argv: string[], subject: string, dir?: string): Outcome {
  const t0 = Date.now();
  const r = spawnSync('python3', [join(LANE, script), ...argv], { encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  const ms = Date.now() - t0;
  const last = (r.stdout ?? '').trim().split('\n').pop() ?? '';
  let result: unknown = null; try { result = JSON.parse(last); } catch { /* not JSON: a traceback or nothing */ }
  const code = r.status;
  // exit 2 means "computed but not trusted" only when the lane wrote its JSON; argparse also exits 2 on a usage error and
  // writes nothing to stdout — that is a failure (error_class usage), never an untrusted-but-ok receipt
  const usage = code === 2 && result === null;
  const partial = script === 'bench_loader.py' && code === 2 && result !== null;   // bench score: some objects had no prediction — scored, reported, not a trust problem
  const status: Outcome['status'] = code === 0 ? 'ok' : usage ? 'failed' : partial ? 'partial' : code === 2 ? 'untrusted' : code === 3 ? 'not_configured' : 'failed';
  const stderr = scrub((r.stderr ?? '').slice(-2000)) || undefined;
  const rec = appendReceipt('runs', {
    kind: 'run', subject, policy: 'auto', status: status === 'ok' || status === 'untrusted' || status === 'partial' ? 'ok' : 'failed',
    error_class: status === 'ok' ? undefined : status === 'untrusted' ? 'untrusted_metric' : status === 'partial' ? 'partial' : status === 'not_configured' ? 'env' : usage ? 'usage' : 'exec',
    exit_code: code ?? -1, ms, response_hash: result ? sha256(JSON.stringify(result)) : undefined,
    spans: [{ name: `${script} ${scrub(argv.join(' '))}`.slice(0, 400), kind: 'execute_tool' }], artifacts: [],
  }, dir);
  return { ok: status === 'ok', status, exit_code: code, ms, result, stderr, receipt: rec.hash };
}

function refuse(note: string): Outcome { return { ok: false, status: 'invalid_request', exit_code: null, ms: 0, result: null, note }; }
const isFile = (p: unknown) => typeof p === 'string' && p.length > 0 && existsSync(p) && statSync(p).isFile();

export function callGeoTool(name: string, args: Record<string, unknown> = {}, dir?: string): Outcome {
  switch (name) {
    case 'timmy_geo_score': {
      if (!isFile(args.truth)) return refuse('truth must be an existing file (PLY, JSON {"points"} or mesh)');
      if (!isFile(args.pred)) return refuse('pred must be an existing file (PLY, JSON {"points"} or mesh)');
      const argv = ['--truth', String(args.truth), '--pred', String(args.pred), ...flags(args, ['voxel', 'tau', 'tolerance', 'samples', 'normalize', 'fit', 'out'])];
      return runLane('voxel_score.py', argv, `geo.voxel-score ${basename(String(args.truth))} vs ${basename(String(args.pred))}${args.fit ? ' (fitted)' : ''}`, dir);
    }
    case 'timmy_geo_bench': {
      const bench = String(args.bench ?? '');
      if (!isFile(join(bench, 'manifest.json'))) return refuse('bench must be an extracted bench directory (manifest.json missing); run bench_loader.py fetch + extract first');
      if (args.step === 'predict') {
        if (typeof args.model !== 'string' || !args.model) return refuse('predict needs model');
        if (typeof args.expect_f1 !== 'number' || !Number.isFinite(args.expect_f1)) return refuse('predict needs a numeric expect_f1');
        const argv = ['predict', '--bench', bench, '--model', String(args.model), '--expect-f1', String(args.expect_f1), ...flags({ 'expect-fscore': args.expect_fscore, 'tolerance-f1': args.tolerance_f1, frame: args.frame, basis: args.basis }, ['expect-fscore', 'tolerance-f1', 'frame', 'basis'])];
        return runLane('bench_loader.py', argv, `geo.bench-predict ${basename(bench)} ${String(args.model)}`, dir);
      }
      if (args.step === 'score') {
        if (typeof args.pred_dir !== 'string' || !existsSync(args.pred_dir) || !statSync(args.pred_dir).isDirectory()) return refuse('score needs pred_dir, an existing directory of PRED/<id>.(ply|glb|obj|json)');
        const argv = ['score', '--bench', bench, '--pred-dir', String(args.pred_dir), ...flags({ ...args, 'normalize-each': args.normalize_each }, ['frame', 'voxel', 'tau', 'tolerance', 'samples', 'fit', 'normalize-each'])];
        return runLane('bench_loader.py', argv, `geo.bench-score ${basename(bench)} ${basename(String(args.pred_dir))}${args.fit || args.normalize_each ? ' (shape score)' : ''}`, dir);
      }
      return refuse('step must be predict or score');
    }
    case 'timmy_geo_scale': {
      if (!isFile(args.views)) return refuse('views must be an existing views.json');
      const argv = ['--views', String(args.views), ...flags(args, ['rounds', 'sub', 'lo', 'hi', 'out'])];
      return runLane('scale_solver.py', argv, `geo.scale-solve ${basename(String(args.views))}`, dir);
    }
    default: return refuse('Unknown geo tool.');
  }
}
