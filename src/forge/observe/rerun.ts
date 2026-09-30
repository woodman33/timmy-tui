// Rerun timeline recording for forge probe generations — per the house
// discipline in docs/RERUN-TIMMY-GUIDE.md:
//   * Pinned toolchain: Cargo-installed rerun CLI 0.37.1 + rerun Python SDK
//     0.37.1 (see docs/evidence/rerun-study-20260910/installation-inventory.json).
//     Recording goes through the SDK (RecordingStream + save), exactly the
//     pattern the local audit used (local-probe.py); the pinned `rerun` CLI
//     is the viewer/server for the resulting .rrd, not the recorder.
//   * Explicit timelines, never implicit log_time/log_tick: facet scores are
//     logged on an explicit "source_s" timeline.
//   * SOURCE times, not wall-clock: the x-axis of every series is the segment
//     start time from the probe media (points carry them), per the guide's
//     "record source times" rule. These are media positions, not ingestion
//     or logging times.
//   * Absent ≠ zero: a facet missing from a point's scores is omitted from
//     that facet's series (guide: latest-at forward-fill hazards).
// Unit-testable without rerun: planTimeline, buildRecordingInvocation and the
// default runner's error mapping. Only the live test touches the real SDK.
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FacetScorePoint {
  beat_id: string;
  start_s: number;
  end_s: number;
  scores: Record<string, number>; // judge facet scores for this segment (0-10)
}

export interface TimelineInput {
  mission_id: string;
  probe_sha256: string;      // identifies the generation entity
  points: FacetScorePoint[]; // segment-aligned judge scores
}

export interface FacetSeries {
  facet: string;
  times: number[];           // SOURCE times (segment start_s from the media)
  values: number[];
}

export interface TimelinePlan {
  entity: string;            // 'forge/<mission_id>/<probe_sha256[:12]>'
  facets: string[];          // union of score keys, first-appearance order
  series: FacetSeries[];
}

// Rerun application ID (workflow family) and the recording timeline name,
// per the guide's data contract (application/recording IDs are workflow
// family + unique run, not receipt IDs).
export const RERUN_APPLICATION_ID = 'timmy_forge';
export const SOURCE_TIMELINE = 'source_s';

// Guide-pinned rerun Python SDK version (docs/RERUN-TIMMY-GUIDE.md; the house
// study pinned SDK + CLI 0.37.1 — see docs/evidence/rerun-study-20260910/
// installation-inventory.json). Candidates are import-verified against this
// exact version; anything else is rejected per AGENTS.md §5 (no silent
// toolchain substitution).
export const RERUN_SDK_VERSION = '0.37.1';

// Pure recording plan: entity path, facet union (first-appearance order),
// and one scalar series per facet. Times are the segment start_s values —
// SOURCE times from the probe media, not wall-clock. A facet absent from a
// point contributes nothing to that facet's series at that time (no
// zero-fill: absence is not a zero score).
export function planTimeline(input: TimelineInput): TimelinePlan {
  if (typeof input.mission_id !== 'string' || !input.mission_id.trim() || !/^[0-9a-f]{64}$/i.test(input.probe_sha256)) throw new Error('invalid timeline identity');
  const points = [...input.points].sort((a, b) => a.start_s - b.start_s);
  const ids = new Set<string>();
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (typeof p.beat_id !== 'string' || !p.beat_id.trim() || ids.has(p.beat_id)) throw new Error('invalid or duplicate beat id');
    ids.add(p.beat_id);
    if (!Number.isFinite(p.start_s) || p.start_s < 0 || !Number.isFinite(p.end_s) || p.end_s <= p.start_s) throw new Error('invalid source time window');
    if (i && p.start_s < points[i - 1].end_s) throw new Error('overlapping source windows');
    if (!p.scores || typeof p.scores !== 'object' || Array.isArray(p.scores)) throw new Error('invalid scores');
    for (const [facet, score] of Object.entries(p.scores)) {
      if (!facet.trim() || !Number.isFinite(score) || score < 0 || score > 10) throw new Error('invalid facet score');
    }
  }
  const entity = `forge/${encodeURIComponent(input.mission_id).replace(/\./g, '%2E')}/${input.probe_sha256.slice(0, 12)}`;
  const facets: string[] = [];
  const seen = new Set<string>();
  for (const p of points) {
    for (const k of Object.keys(p.scores)) {
      if (!seen.has(k)) { seen.add(k); facets.push(k); }
    }
  }
  const series: FacetSeries[] = facets.map(facet => {
    const times: number[] = [];
    const values: number[] = [];
    for (const p of points) {
      const v = p.scores[facet];
      if (v === undefined) continue; // absent ≠ zero
      times.push(p.start_s);
      values.push(v);
    }
    return { facet, times, values };
  });
  return { entity, facets, series };
}

// Injected adapter: (cmd, args) => Promise<void>. Tests inject a fake that
// captures invocations; the default spawns the resolved pinned SDK python.
export type RerunRunner = (cmd: string, args: string[]) => Promise<void>;

// Recorder script run by the pinned rerun SDK python. The JSON plan travels
// as argv[1] so the RerunRunner signature stays (cmd, args) with no stdin.
// Mirrors the house study script (docs/evidence/rerun-study-20260910/
// local-probe.py): RecordingStream + save, analytics off, RERUN_SINK unset.
export const RECORDER_SCRIPT = [
  'import json, os, sys',
  'from urllib.parse import quote',
  "os.environ['RERUN_ANALYTICS_ENABLED'] = 'false'",
  "os.environ['RERUN_RECORDING_ENABLED'] = 'true'",
  "os.environ.pop('RERUN_SINK', None)",
  'import rerun as rr',
  `if rr.__version__ != '${RERUN_SDK_VERSION}': raise RuntimeError('rerun SDK version mismatch')`,
  'plan = json.loads(sys.argv[1])',
  "rec = rr.RecordingStream(plan['application_id'], recording_id=plan['recording_id'])",
  "rec.save(plan['rrd'])",
  'for s in plan[\'series\']:',
  '    for t, v in zip(s[\'times\'], s[\'values\']):',
  "        rec.set_time(plan['timeline'], timestamp=float(t))",
  "        facet = quote(s['facet'], safe='').replace('.', '%2E')",
  "        rec.log(f\"{plan['entity']}/scores/{facet}\", rr.Scalars([float(v)]))",
  'rec.flush()',
  'rec.disconnect()',
].join('\n');

// Pure: the recording invocation for a plan. Returns the argv for
// `<python> -c RECORDER_SCRIPT <json>`. The JSON plan travels as a single
// argv element (never a shell), so hostile mission/facet names round-trip
// verbatim. Guard: argv transport is size-limited (documented limitation
// pending a stdin handoff) — refuse oversized plans rather than silently
// truncate.
const MAX_PLAN_JSON_BYTES = 100_000;

export function buildRecordingInvocation(plan: TimelinePlan, outRrd: string, python: string): { cmd: string; args: string[] } {
  const payload = {
    application_id: RERUN_APPLICATION_ID,
    recording_id: plan.entity, // unique capture/run: mission + generation
    entity: plan.entity,
    timeline: SOURCE_TIMELINE,
    series: plan.series,
    rrd: outRrd,
  };
  const planJson = JSON.stringify(payload);
  if (Buffer.byteLength(planJson, 'utf8') > MAX_PLAN_JSON_BYTES) {
    throw new Error(`timeline plan too large for argv transport (${Buffer.byteLength(planJson, 'utf8')} bytes > ${MAX_PLAN_JSON_BYTES}; documented limitation pending stdin handoff)`);
  }
  return { cmd: python, args: ['-c', RECORDER_SCRIPT, planJson] };
}

// Resolve the pinned rerun SDK python. Order: $TIMMY_RERUN_PYTHON override,
// the repo-pinned study venv (docs/evidence/rerun-study-20260910/
// installation-inventory.json records studio/spatial-intelligence-20260909/.venv),
// then bare python3 on PATH. A candidate qualifies ONLY if it import-verifies
// the guide-pinned SDK version (RERUN_SDK_VERSION); any other version or a
// failed import is treated as absent and the ladder falls through — no
// silent substitution (AGENTS.md §5). NOTE (documented environment gap, not
// a silent one): the repo-pinned venv path is ABSENT in this checkout, so
// the env override is the operative route until the venv is restored.
// Memoized per process: the winning resolution (including null) is probed
// once, not per recordTimeline call.
let sdkPythonMemo: string | null | undefined;

export function resolveSdkPython(): string | null {
  if (sdkPythonMemo !== undefined) return sdkPythonMemo;
  const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
  const candidates = [
    process.env.TIMMY_RERUN_PYTHON,
    join(repoRoot, 'studio', 'spatial-intelligence-20260909', '.venv', 'bin', 'python'),
    'python3',
  ].filter((c): c is string => typeof c === 'string' && c.length > 0);
  for (const candidate of candidates) {
    const probe = spawnSync(
      candidate,
      ['-c', `import rerun,sys; sys.exit(0 if rerun.__version__ == '${RERUN_SDK_VERSION}' else 'rerun SDK version mismatch')`],
      { stdio: 'pipe', timeout: 15_000 },
    );
    if (probe.status === 0) { sdkPythonMemo = candidate; return candidate; }
  }
  sdkPythonMemo = null;
  return null;
}

// Default runner: spawn the resolved SDK python, reject on nonzero exit with
// stderr attached (per the task contract: failure → throw with stderr).
function defaultRunner(): RerunRunner {
  return (cmd, args) => new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', d => { stderr += String(d); });
    child.on('error', err => rejectPromise(err));
    child.on('close', code => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`rerun recording failed (exit ${code}): ${stderr.trim()}`));
    });
  });
}

// Execute the recording: plan → invocation → runner → .rrd at outRrd.
// Creates the output directory if needed. Returns the .rrd path, the
// entity, and the resolved SDK version (the pin — resolution enforces it).
// The recorder writes inside a unique temporary directory. A nonempty
// regular output is published exclusively after runner success; concurrent
// calls cannot overwrite an existing recording. Temporary files are removed.
// Any runner rejection propagates unchanged.
export async function recordTimeline(
  input: TimelineInput,
  outRrd: string,
  deps?: { runner?: RerunRunner },
): Promise<{ rrd: string; entity: string; sdk_version: string }> {
  const plan = planTimeline(input);
  try { lstatSync(outRrd); throw new Error('recording output already exists'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // With an injected runner the cmd is inert (the fake captures it); on the
  // real path the pinned SDK python must resolve or we fail before spawning.
  let python = 'python';
  if (!deps?.runner) {
    const resolved = resolveSdkPython();
    if (!resolved) {
      throw new Error(
        `pinned rerun Python SDK ${RERUN_SDK_VERSION} not resolvable: no candidate import-verified rerun==${RERUN_SDK_VERSION} ` +
        '(set TIMMY_RERUN_PYTHON to a python with the pinned SDK; the repo-pinned study venv is absent in this checkout — ' +
        'documented environment gap; see docs/RERUN-TIMMY-GUIDE.md)',
      );
    }
    python = resolved;
  }
  // Check the transport bound before creating any output directories.
  buildRecordingInvocation(plan, outRrd, python);
  mkdirSync(dirname(outRrd), { recursive: true });
  const temporary = mkdtempSync(join(dirname(outRrd), '.rerun-'));
  const tmpRrd = join(temporary, 'recording.rrd');
  const runner = deps?.runner ?? defaultRunner();
  try {
    const invocation = buildRecordingInvocation(plan, tmpRrd, python);
    await runner(invocation.cmd, invocation.args);
    const file = lstatSync(tmpRrd);
    if (!file.isFile() || file.size === 0) throw new Error('recorder output must be a nonempty regular file');
    linkSync(tmpRrd, outRrd); // Atomic exclusive publication: never overwrite.
  } finally { rmSync(temporary, { recursive: true, force: true }); }

  return { rrd: outRrd, entity: plan.entity, sdk_version: RERUN_SDK_VERSION };
}
