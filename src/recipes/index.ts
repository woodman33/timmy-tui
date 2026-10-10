/**
 * The CadQuery enclosure-tray recipe as a connected workflow (round R3, helper H11): /recipe, the agent's
 * run_recipe and the /tools row share this module. The durable job itself is lanes/recipes/jobs.ts:
 * enqueue binds the request and every source in a signed job file whose UUID is the operation ID; start
 * hands it to a detached supervisor that owns the native process; status re-verifies the signed result
 * and every artifact hash; cancel and recover are the recipe's own paths. A small watcher (./watch.ts)
 * runs as a Timmy job: it prints each phase, cancels through the recipe's own cancel path when it is
 * stopped, and on success copies the verified exports into the project (out/recipes/<uuid8>/), every
 * sha256 checked against the verified result first. Nothing here reads a PID from disk or kills one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { cardPath, prediction, sha, validate, type Parameters } from '../../lanes/recipes/tray.js';
import { enqueue, jobDirectory, start, status, type Job, type JobState } from '../../lanes/recipes/jobs.js';
import type { JobSpec } from '../jobs/index.js';

export const RECIPE_ID = 'enclosure.tray/1';
/** DOCTRINE §15, verbatim: shown wherever /recipe offers or presents measured dimensions (AGENTS.md §4). */
export const DOCTRINE_15 = 'Timmy can compute and verify dimensions of generated CAD. Converting that CAD cannot establish the dimensions or density of a physical object.';
export const EXPORTS = ['outer.stl', 'cavity.stl', 'bosses.stl', 'bores.stl', 'console-tray.step'] as const;
export const PYTHON_SETUP = 'set TIMMY_CADQUERY_PYTHON to the absolute path of a Python with CadQuery and Open3D';
/** The /tools row's step, short enough to print whole at 80 columns. */
const ROW_SETUP = 'export TIMMY_CADQUERY_PYTHON=<Python with CadQuery and Open3D>';
export const PARAMETER_NAMES = ['width', 'wall', 'supportOffset', 'bore'] as const;
/** Each parameter's meaning and the range tray.ts validate() admits (millimetres). */
export const PARAMETER_HELP: Record<(typeof PARAMETER_NAMES)[number], string> = {
  width: 'overall width (X), 40 to 1000',
  wall: 'walls and base, above 0, up to 10',
  supportOffset: 'edge to each support and bore axis, above wall + 6, below min(width, 80)/2 - 6',
  bore: 'bore diameter, above 0, below 12',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isRecipeJobId = (s: string): boolean => UUID.test(s);
/** The real worker (lanes/recipes/job-worker.ts, or .js once built); any other executor is a fixture seam. */
const REAL_WORKER = /(^|[\\/])lanes[\\/]recipes[\\/]job-worker\.(ts|js)$/;

export interface RecipeCard { id: string; engine: string; units: string; parameters: Record<string, number>; fixed: Record<string, number>; scope: string }
export function readCard(): RecipeCard { return JSON.parse(fs.readFileSync(cardPath, 'utf8')) as RecipeCard; }

/** Whether the native runtime is configured: TIMMY_CADQUERY_PYTHON is an absolute path that exists. Nothing is imported or run. */
export function nativeRuntime(env: NodeJS.ProcessEnv): { ok: true; python: string } | { ok: false; why: string } {
  const p = env.TIMMY_CADQUERY_PYTHON;
  if (!p) return { ok: false, why: 'TIMMY_CADQUERY_PYTHON is not set' };
  if (!path.isAbsolute(p)) return { ok: false, why: 'TIMMY_CADQUERY_PYTHON is not an absolute path' };
  if (!fs.existsSync(p)) return { ok: false, why: 'TIMMY_CADQUERY_PYTHON names no file on this machine' };
  return { ok: true, python: p };
}

/** A request from `name=value` words over the card's defaults; an unknown name or a non-number is refused. */
export function requestFrom(given: Record<string, unknown>): { ok: true; request: { schema: string; recipe: string; parameters: Record<string, number> } } | { ok: false; error: string } {
  const card = readCard();
  const parameters: Record<string, number> = { ...card.parameters };
  for (const [k, v] of Object.entries(given)) {
    if (!(PARAMETER_NAMES as readonly string[]).includes(k)) return { ok: false, error: `no parameter ${k}: ${PARAMETER_NAMES.join(', ')}` };
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
    if (!Number.isFinite(n)) return { ok: false, error: `${k} must be a number of millimetres` };
    parameters[k] = n;
  }
  return { ok: true, request: { schema: 'timmy.recipe-request/1', recipe: RECIPE_ID, parameters } };
}

export function parseWords(words: string[]): Record<string, string> | { error: string } {
  const out: Record<string, string> = {};
  for (const w of words) {
    const m = w.match(/^([A-Za-z]+)=(.*)$/);
    if (!m) return { error: `${w} is not name=value (for example width=180)` };
    out[m[1]] = m[2];
  }
  return out;
}

export interface Prepared { id: string; job: Job; parameters: Parameters; predicted: ReturnType<typeof prediction> }

/**
 * Validates, checks the runtime and writes the signed job (no native start). A refusal says why; without
 * the runtime nothing is written. `executor` is the jobs.ts fixture seam, for tests only.
 */
export function prepareRecipe(given: Record<string, unknown>, o: { root: string; env: NodeJS.ProcessEnv; executor?: string }):
  { ok: true; prepared: Prepared } | { ok: false; stage: 'refused' | 'setup' | 'enqueue'; error: string } {
  const r = requestFrom(given);
  if (!r.ok) return { ok: false, stage: 'refused', error: r.error };
  let parameters: Parameters;
  try { parameters = validate(r.request); } catch (e) { return { ok: false, stage: 'refused', error: e instanceof Error ? e.message : String(e) }; }
  const runtime = nativeRuntime(o.env);
  if (!runtime.ok) return { ok: false, stage: 'setup', error: runtime.why };
  try {
    const s = enqueue(r.request, { root: o.root, python: runtime.python, ...(o.executor ? { executor: o.executor } : {}) });
    return { ok: true, prepared: { id: s.job.id, job: s.job, parameters, predicted: prediction(parameters) } };
  } catch (e) {
    return { ok: false, stage: 'enqueue', error: e instanceof Error ? e.message : String(e) };
  }
}

/** Hands the job to its detached supervisor (lanes/recipes/jobs.ts start). `onSupervisor` is a test seam. */
export async function launchRecipe(root: string, id: string, onSupervisor?: (child: ChildProcess) => void) {
  return start(root, id, onSupervisor ? { onSupervisor } : {});
}

/** The watcher as a Timmy job: from source through tsx, from the compiled layout with Node alone. */
export function watcherSpec(o: { root: string; id: string; label: string; project: string; pollMs?: number }): JobSpec {
  const compiled = import.meta.url.endsWith('.js');
  const entry = fileURLToPath(new URL(compiled ? './watch.js' : './watch.ts', import.meta.url));
  const loader = compiled ? [] : ['--import', createRequire(import.meta.url).resolve('tsx')];
  return {
    kind: 'task', label: o.label, project: o.project, root: o.root, command: process.execPath, args: [...loader, entry, o.root, o.id],
    ...(o.pollMs ? { env: { TIMMY_RECIPE_POLL_MS: String(o.pollMs) } } : {}),
  };
}

export const short = (h: string, n = 12): string => h.slice(0, n);
export const outDir = (id: string): string => `out/recipes/${id.slice(0, 8)}`;
const jsonl = (file: string): Array<Record<string, any>> => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const rel = (root: string, abs: string): string => {
  const r = path.relative(fs.realpathSync(root), abs);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : path.basename(abs);
};

interface Verified {
  id: string; run: string; resultReceipt: string; resultHash: string; buildTs?: string; executor: string;
  files: Array<{ name: string; from: string; bytes: Buffer; sha256: string }>;
  result: Record<string, any> | null; prediction: Record<string, any> | null;
}

/**
 * Freshly verified bytes of a succeeded job: status() re-verifies the signed result, its receipts and every
 * artifact hash; then each file to copy is read once and its sha256 compared with the verified record
 * (exports and native/result.json: the signed recipe.build receipt; request.json and prediction.json: the
 * signed recipe.prediction receipt and the job's request hash; report.json: the signed result's report hash,
 * which is over its JSON value). Any mismatch refuses the whole set.
 */
export function verifiedResult(root: string, id: string): { ok: true; v: Verified } | { ok: false; error: string } {
  if (!isRecipeJobId(id)) return { ok: false, error: `${id} is not a recipe job UUID` };
  let s: ReturnType<typeof status>;
  try { s = status(root, id); } catch (e) { return { ok: false, error: `the job could not be read: ${e instanceof Error ? e.message : String(e)}` }; }
  if (s.state !== 'succeeded' || !s.resultReceipt || !s.resultHash) {
    return { ok: false, error: `the job is ${s.state} (${s.progress})${s.reason ? `: ${s.reason}` : ''}` };
  }
  try {
    const dir = jobDirectory(root, id);
    const envelope = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
    const run = String(envelope?.result?.run ?? '');
    if (!isRecipeJobId(run)) return { ok: false, error: 'the verified result names no native run' };
    const base = path.join(dir, 'workspace', '.timmy', 'recipe-runs', run);
    const receipts = jsonl(path.join(dir, 'workspace', '.timmy', 'receipts', 'runs.jsonl'));
    const build = receipts.find((r) => r.id === s.resultReceipt && r.hash === s.resultHash && r.kind === 'recipe.build' && r.status === 'ok');
    if (!build) return { ok: false, error: 'the verified build receipt is not in the job store' };
    const predicted = receipts.find((r) => Array.isArray(build.child_receipts) && build.child_receipts.includes(r.id) && r.kind === 'recipe.prediction');
    if (!predicted) return { ok: false, error: 'the sealed prediction receipt is not in the job store' };
    const expect = new Map<string, string>();
    for (const src of [...(build.sources ?? []), ...(predicted.sources ?? [])]) if (typeof src?.path === 'string' && typeof src?.sha256 === 'string') expect.set(src.path, src.sha256);
    const files: Verified['files'] = [];
    const take = (name: string, from: string, check: (b: Buffer) => string | undefined): string | undefined => {
      const bytes = fs.readFileSync(from);
      const bad = check(bytes);
      if (bad) return `${name}: ${bad}`;
      files.push({ name, from, bytes, sha256: sha(bytes) });
      return undefined;
    };
    const exports: Array<{ file: string; sha256: string }> = Array.isArray(envelope.result.exports) ? envelope.result.exports : [];
    if (exports.map((e) => path.basename(e.file)).sort().join() !== [...EXPORTS].sort().join()) return { ok: false, error: 'the verified result does not name the five exports' };
    const problems: string[] = [];
    for (const e of exports) {
      const from = path.join(base, 'native', e.file);
      const p = take(path.basename(e.file), from, (b) => (sha(b) !== e.sha256 || expect.get(from) !== e.sha256 ? 'its sha256 differs from the verified result' : undefined));
      if (p) problems.push(p);
    }
    const reportFrom = path.join(base, 'report.json');
    const p1 = take('report.json', reportFrom, (b) => { try { return sha(JSON.stringify(JSON.parse(b.toString('utf8')))) === envelope.reportHash ? undefined : 'it differs from the signed report hash'; } catch { return 'it is not JSON'; } });
    const p2 = take('request.json', path.join(base, 'request.json'), (b) => (sha(b) !== s.job.requestHash || expect.get(path.join(base, 'request.json')) !== s.job.requestHash ? 'its sha256 differs from the job request hash' : undefined));
    const p3 = take('prediction.json', path.join(base, 'prediction.json'), (b) => { const want = expect.get(path.join(base, 'prediction.json')); return !want || sha(b) !== want ? 'its sha256 differs from the sealed prediction' : undefined; });
    problems.push(...[p1, p2, p3].filter((x): x is string => Boolean(x)));
    if (problems.length) return { ok: false, error: problems.join('; ') };
    // native/result.json is read for the outcome only, under the same verified hash; it is not copied.
    let result: Record<string, any> | null = null;
    const resultFrom = path.join(base, 'native', 'result.json');
    try { const b = fs.readFileSync(resultFrom); if (expect.get(resultFrom) === sha(b)) result = JSON.parse(b.toString('utf8')); } catch { result = null; }
    let pred: Record<string, any> | null = null;
    try { pred = JSON.parse(files.find((f) => f.name === 'prediction.json')!.bytes.toString('utf8')); } catch { pred = null; }
    return { ok: true, v: { id, run, resultReceipt: s.resultReceipt, resultHash: s.resultHash, ...(typeof build.ts === 'string' ? { buildTs: build.ts } : {}), executor: s.job.executor, files, result, prediction: pred } };
  } catch (e) {
    return { ok: false, error: `the verified result could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export interface Outcome {
  checks: { passed: number; total: number } | null;
  step: { passed: number; total: number } | null;
  mesh: { passed: number; total: number } | null;
  measured: { bounds: number[]; volume: number } | null;
  predicted: { bounds: number[]; volume: number } | null;
  engines: string[];
}

/** What the verified native result says, read from it; a field it does not carry stays null (never assumed). */
export function outcomeOf(v: Verified): Outcome {
  const variant = v.result?.variant;
  const checks: Array<{ label?: unknown; passed?: unknown }> = Array.isArray(variant?.checks) ? variant.checks : [];
  const count = (pick: (label: string) => boolean) => {
    const c = checks.filter((x) => typeof x.label === 'string' && pick(x.label));
    return c.length ? { passed: c.filter((x) => x.passed === true).length, total: c.length } : null;
  };
  const nums = (a: unknown): a is number[] => Array.isArray(a) && a.length === 3 && a.every((n) => typeof n === 'number' && Number.isFinite(n));
  const m = variant?.measured;
  const p = v.prediction;
  return {
    checks: checks.length ? { passed: checks.filter((x) => x.passed === true).length, total: checks.length } : null,
    step: count((l) => l.startsWith('STEP reimport')),
    mesh: count((l) => l.startsWith('STL ')),
    measured: m && nums(m.bounds) && typeof m.volume === 'number' ? { bounds: m.bounds, volume: m.volume } : null,
    predicted: p && nums(p.bounds) && typeof p.volumeMm3 === 'number' ? { bounds: p.bounds, volume: p.volumeMm3 } : null,
    engines: [v.result?.engine, variant?.mesh?.engine].filter((x): x is string => typeof x === 'string'),
  };
}

const mm = (b: number[]): string => b.map((n) => String(Math.round(n * 1e6) / 1e6)).join(' x ');
const mm3 = (n: number): string => (Math.round(n * 1000) / 1000).toLocaleString('en-US');

/** The outcome in plain lines; the first says what happened, the last is DOCTRINE §15. */
export function outcomeLines(v: Verified, copied: string): string[] {
  const o = outcomeOf(v);
  const lines = [`Recipe ${v.id} succeeded${o.engines.length ? ` (${o.engines.join(', ')})` : ''}; result receipt ${v.resultReceipt}`];
  lines.push(o.checks ? `${o.checks.passed} of ${o.checks.total} geometry checks passed (the recipe's gate requires all 30)` : 'The native result lists no checks; the gate passed by the recorded report only');
  if (o.measured && o.predicted) {
    const dv = o.predicted.volume ? Math.abs(o.measured.volume - o.predicted.volume) / o.predicted.volume * 100 : Number.NaN;
    lines.push(`Bounds ${mm(o.measured.bounds)} mm measured; ${mm(o.predicted.bounds)} mm in the sealed prediction`);
    lines.push(`Volume ${mm3(o.measured.volume)} mm3 measured; ${mm3(o.predicted.volume)} mm3 predicted (difference ${dv.toPrecision(2)} %)`);
  } else {
    lines.push(`Measured bounds and volume: ${o.measured ? 'recorded' : 'not in the native result'}; sealed prediction values: ${o.predicted ? 'recorded' : 'not in the prediction file'}`);
  }
  lines.push(`STEP reimport: ${o.step ? `${o.step.passed} of ${o.step.total} checks passed` : 'no checks recorded'}; independent mesh checks: ${o.mesh ? `${o.mesh.passed} of ${o.mesh.total} passed` : 'none recorded'}`);
  lines.push(`5 exports with matching sha256 in ${copied}/, with report.json, request.json and prediction.json`);
  lines.push(DOCTRINE_15);
  return lines;
}

/** Copies a verified result into the project (out/recipes/<uuid8>/); a file already there must match, or nothing is written. */
export function deliver(root: string, id: string): { ok: true; dir: string; files: Array<{ path: string; sha256: string; bytes: number }>; v: Verified } | { ok: false; error: string } {
  const got = verifiedResult(root, id);
  if (!got.ok) return { ok: false, error: `nothing copied: ${got.error}` };
  const dirRel = outDir(id);
  const dest = path.join(root, dirRel);
  try {
    // Containment first, before any folder is made (the review of ee70b9e): the nearest folder that exists on the
    // way to dest must resolve inside the project, so a linked out/ or out/recipes creates nothing elsewhere.
    const realRoot = fs.realpathSync(root);
    let existing = dest;
    while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
    const realExisting = fs.realpathSync(existing);
    if (realExisting !== realRoot && !realExisting.startsWith(realRoot + path.sep)) return { ok: false, error: `nothing copied: ${dirRel} leads outside the project` };
    fs.mkdirSync(dest, { recursive: true });
    const realDest = fs.realpathSync(dest);
    if (!realDest.startsWith(realRoot + path.sep)) return { ok: false, error: `nothing copied: ${dirRel} leads outside the project` };
    for (const f of got.v.files) {
      const to = path.join(dest, f.name);
      if (fs.existsSync(to) && sha(fs.readFileSync(to)) !== f.sha256) return { ok: false, error: `nothing copied: ${dirRel}/${f.name} already holds different bytes; it was left as it is` };
    }
    const files: Array<{ path: string; sha256: string; bytes: number }> = [];
    // A copy that fails partway removes the files this call wrote (the review of ee70b9e, M2): the project holds
    // the whole verified set or none of what this call added; files that were already there and matched stay.
    const written: string[] = [];
    try {
      for (const f of got.v.files) {
        const to = path.join(dest, f.name);
        if (!fs.existsSync(to)) { fs.writeFileSync(to, f.bytes, { flag: 'wx' }); written.push(to); }
        const back = sha(fs.readFileSync(to));
        if (back !== f.sha256) throw new Error(`${dirRel}/${f.name} reads back with a different sha256 after copying`);
        files.push({ path: `${dirRel}/${f.name}`, sha256: back, bytes: f.bytes.length });
      }
    } catch (e) {
      for (const w of written) { try { fs.unlinkSync(w); } catch { /* already gone */ } }
      return { ok: false, error: `nothing kept from this copy (${written.length} written, removed again): ${e instanceof Error ? e.message : String(e)}` };
    }
    return { ok: true, dir: dirRel, files, v: got.v };
  } catch (e) {
    return { ok: false, error: `the copy failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Whether the project's copy of a succeeded job is complete and matches the verified result, file by file. */
export function checkCopy(root: string, id: string): { ok: true; v: Verified; dir: string } | { ok: false; error: string } {
  const got = verifiedResult(root, id);
  if (!got.ok) return got;
  const dirRel = outDir(id);
  for (const f of got.v.files) {
    const at = path.join(root, dirRel, f.name);
    if (!fs.existsSync(at)) return { ok: false, error: `${dirRel}/${f.name} is missing` };
    if (sha(fs.readFileSync(at)) !== f.sha256) return { ok: false, error: `${dirRel}/${f.name} differs from the verified result` };
  }
  return { ok: true, v: got.v, dir: dirRel };
}

/** Where a job's raw failure is kept, project-relative: its worker log, and the native log and report when the run wrote them. */
export function failureFiles(root: string, id: string): string[] {
  try {
    const dir = jobDirectory(root, id);
    const out = [path.join(dir, 'worker.log')];
    try {
      const envelope = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
      const run = String(envelope?.result?.run ?? '');
      if (isRecipeJobId(run)) for (const n of ['native.log', 'report.json']) out.push(path.join(dir, 'workspace', '.timmy', 'recipe-runs', run, n));
    } catch { /* no recorded result */ }
    const runs = path.join(dir, 'workspace', '.timmy', 'recipe-runs');
    if (out.length === 1 && fs.existsSync(runs)) for (const run of fs.readdirSync(runs)) for (const n of ['native.log', 'report.json']) out.push(path.join(runs, run, n));
    return out.filter((f) => fs.existsSync(f)).map((f) => rel(root, f));
  } catch { return []; }
}

export interface Listed { id: string; created?: number; state?: JobState; progress?: string; reason?: string; requestHash?: string; sourceHash?: string; resultReceipt?: string; resultHash?: string; error?: string }

/** The project's recipe jobs, newest first, each read through status() (which verifies what it reports). */
export function listRecipeJobs(root: string): Listed[] {
  const jobs = path.join(root, '.timmy', 'recipe-jobs');
  let names: string[] = [];
  try { names = fs.readdirSync(jobs).filter(isRecipeJobId); } catch { return []; }
  const out: Listed[] = names.map((id) => {
    try {
      const s = status(root, id);
      return { id, created: s.job.created, state: s.state, progress: s.progress, ...(s.reason ? { reason: s.reason } : {}), requestHash: s.job.requestHash, sourceHash: s.job.sourceHash, ...(s.resultReceipt ? { resultReceipt: s.resultReceipt } : {}), ...(s.resultHash ? { resultHash: s.resultHash } : {}) };
    } catch (e) {
      return { id, error: e instanceof Error ? e.message : String(e) };
    }
  });
  return out.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
}

/**
 * When the recipe was last exercised in this project: a succeeded job of the real worker whose signed result
 * verifies now (status() again). Submission, failure, cancellation and fixture executors never count.
 */
export function recipeExercisedAt(root: string): string | undefined {
  let last: string | undefined;
  for (const j of listRecipeJobs(root)) {
    if (j.state !== 'succeeded' || !j.resultReceipt) continue;
    const got = verifiedResult(root, j.id);
    if (!got.ok || !REAL_WORKER.test(got.v.executor)) continue;
    const at = got.v.buildTs ?? (j.created ? new Date(j.created).toISOString() : undefined);
    if (at && (!last || at > last)) last = at;
  }
  return last;
}

/** The /tools row: installed or needs setup from TIMMY_CADQUERY_PYTHON alone; exercised is decided by recipeExercisedAt. */
export function recipeCapabilityRow(env: NodeJS.ProcessEnv) {
  const r = nativeRuntime(env);
  // R4 (/iterate): iterate_recipe rebuilds through this recipe too; exercised is still decided by the recipe's own record.
  const base = { id: 'recipe-tray', kind: 'adapter' as const, name: 'CadQuery recipe (/recipe)', tools: ['run_recipe', 'iterate_recipe'], exercisedBy: `recipe:${RECIPE_ID}` };
  return r.ok
    ? { ...base, rung: 'installed' as const, detail: `${RECIPE_ID} as a durable job; Python set, not run by this check` }
    : { ...base, rung: 'needs setup' as const, detail: r.why, setup: ROW_SETUP };
}
