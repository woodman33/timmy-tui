/**
 * Round R4 (/iterate freecad, helper H33): the FreeCAD variant of the connected workflow, without the REPL. A local code
 * agent changes only one FreeCAD Python script; /freecad's own judged native job runs it (src/native/freecad.ts
 * freecadJob: freecadcmd imports a read-only copy, judged by the result file workers/freecad/timmy_freecad.py writes);
 * then the STEP it exports is read back exactly as /freecad readback reads it (src/repl/freecad.ts: the same worker,
 * workers/readback/step_readback.py run with TIMMY_CADQUERY_PYTHON, the same tolerance and the same labels), and the
 * flow's verdict is that readback's. This module holds what those steps decide: the agent's task, FreeCAD's report of an
 * earlier judged-ok run of the same script ("before") and of this run ("after"), and the flow record.
 *
 * Who measured what is said with every number: the before and after are FreeCAD's own report of its own document, in
 * the process that built it; the readback is OCP's STEP reader in its own process. Both are OpenCascade, so a match
 * shows the file holds the geometry FreeCAD reported, not an independent kernel's confirmation. DOCTRINE §15's sentence
 * goes with every dimension shown.
 */
import { FREECAD_REPORTED_BY, freecadReport, type FreecadReadbackCheck, type FreecadReport, type FreecadShape } from '../native/freecad.js';
import { listNativeRuns, readNativeRecord } from '../native/index.js';
import { changeText, DOCTRINE_15, type FlowAgentPart, type NativeFlowRecordBase, type ScriptChange, type SyntaxCheck } from './iterate-native.js';

export { DOCTRINE_15 };

/** Who measured the before and after numbers. */
export const FREECAD_FLOW_MEASURED_BY = FREECAD_REPORTED_BY;

const objOf = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStep = (p: string): boolean => /\.(step|stp)$/i.test(p);

// ── the agent's task ─────────────────────────────────────────────────────────────

/**
 * What the local code agent is asked: the operator's instruction first (so the agent's job label shows it), then fixed
 * rules: the one file it may change, what Timmy does with it after, to keep how it reports its run (timmy_freecad's
 * run_script at the top level, which freecadcmd's import needs) and to keep that report true. The script is given whole.
 */
export function freecadIterateTask(o: { instruction: string; scriptRel: string; scriptText: string }): string {
  return [
    o.instruction.trim(),
    '',
    `Do this by changing the file ${o.scriptRel} in this project, and nothing else. It is a Python script for FreeCAD's command-line program, freecadcmd: after you finish, Timmy runs it headless as a judged job (freecadcmd imports a read-only copy of it as a module), judges the run by the result file it writes through timmy_freecad, then reads the STEP file it exports back in a separate process and compares that with FreeCAD's own report of the shape.`,
    '',
    'Rules:',
    `- Edit only ${o.scriptRel}. Do not create, change or delete any other file, and run no commands.`,
    '- Keep it a script for FreeCAD\'s own Python, and keep how it reports its run as it is: timmy_freecad.run_script(main) called at the top level (never under if __name__ == "__main__", which an import does not run), and the run\'s new_document, save_document and export_step.',
    '- Keep what it reports true to the part it builds.',
    '- Change only what the instruction asks for; keep everything else as it is.',
    '- If the instruction cannot be done in this script, change nothing and say why.',
    '',
    `${o.scriptRel} now holds:`,
    o.scriptText.trimEnd(),
  ].join('\n');
}

// ── before and after: FreeCAD's report of the STEP export ───────────────────────

/** A STEP export's shape as FreeCAD reported it (its claim, in mm), as the flow keeps it. */
export interface FreecadMeasure {
  step: string;
  objects: string[];
  valid: boolean | null;
  solids?: number;
  size: number[];
  min: number[];
  max: number[];
  volume_mm3: number;
}

/**
 * The STEP export FreeCAD reported a whole shape for (validity, a bounding box and a volume): the one at `prefer` when
 * it is one of them, else the only one. Undefined when there is none, or several and none preferred.
 */
export function stepMeasure(report: Pick<FreecadReport, 'exports'>, prefer?: string): FreecadMeasure | undefined {
  const steps = report.exports.filter((e) => isStep(e.path) && e.shape?.bounds && finite(e.shape.volume_mm3));
  const pick = (prefer ? steps.find((e) => e.path === prefer) : undefined) ?? (steps.length === 1 ? steps[0] : undefined);
  const s = pick?.shape;
  if (!pick || !s?.bounds || !finite(s.volume_mm3)) return undefined;
  return {
    step: pick.path, objects: [...pick.objects], valid: s.valid, ...(s.solids !== undefined ? { solids: s.solids } : {}),
    size: [...s.bounds.size], min: [...s.bounds.min], max: [...s.bounds.max], volume_mm3: s.volume_mm3,
  };
}

/**
 * The newest FreeCAD run of this script judged ok, started before `before` (the flow's own start), whose result reports
 * a STEP export's shape: its run token, its job's id, when it started and FreeCAD's report of that STEP. Undefined, with
 * the reason, when none. `prefer`: the STEP this flow's run exported, when the earlier run exported several.
 */
export function previousFreecadRun(root: string, scriptRel: string, before: string, prefer?: string): { run: string; job?: string; started_at: string; measure: FreecadMeasure } | { none: string } {
  let runs: ReturnType<typeof listNativeRuns> = [];
  try { runs = listNativeRuns(root); } catch { runs = []; }
  let ofScript = 0;
  for (const r of runs) {
    if (r.app !== 'freecad' || r.started_at >= before) continue;
    let rec: ReturnType<typeof readNativeRecord>;
    try { rec = readNativeRecord(root, r.run); } catch { continue; }
    if (!rec || rec.job.input?.path !== scriptRel) continue;
    ofScript++;
    if (r.verdicts.at(-1)?.outcome !== 'ok' || rec.result.state !== 'read') continue;
    const report = freecadReport(objOf(rec.result.data), { root, resultFile: rec.job.result ?? '' });
    const measure = stepMeasure(report, prefer);
    if (!measure) continue;
    return { run: r.run, ...(rec.started?.job ? { job: rec.started.job } : {}), started_at: r.started_at, measure };
  }
  return { none: ofScript ? `no earlier FreeCAD run of ${scriptRel} was judged ok with a STEP export FreeCAD measured` : `no earlier FreeCAD run of ${scriptRel} in this project` };
}

// ── the flow record ──────────────────────────────────────────────────────────────

export type FreecadFlowStep = 'prepare' | 'agent' | 'checks' | 'freecad' | 'readback' | 'record';

/** A FreeCAD flow's record, results/flows/<flow-id>.json: the flow schema (timmy.flow/1) with target 'freecad'. */
export interface FreecadFlowRecord extends NativeFlowRecordBase {
  target: 'freecad';
  ended_in?: FreecadFlowStep;
  script: {
    path: string;
    /** as read before the agent ran; `kept`: a copy of those bytes in the flow's folder */
    before: { sha256: string; bytes: number; lines: number; kept?: string };
    after?: { sha256: string; bytes: number; lines: number };
    change?: ScriptChange;
    syntax?: SyntaxCheck;
  };
  agent?: FlowAgentPart;
  freecad?: {
    job?: string;
    /** the native run's token and its own folder (.timmy/native/<run>/: job.json, freecad.json, result.json, verdicts.jsonl, readbacks.jsonl) */
    run?: string;
    record?: string;
    state: string;
    /** the judgement of the run by its result file (src/native/freecad.ts judgeFreecadJob) */
    outcome?: 'ok' | 'failed' | 'unknown';
    why?: string;
    version?: string;
    module?: string;
    /** the read-only copy of the script freecadcmd ran, kept at submission */
    copy?: { path: string; sha256: string };
    result?: { path: string; sha256?: string };
    files?: Array<{ path: string; sha256?: string; change?: string; written: boolean }>;
    /** the editable document and the STEP export, as the run made them (Timmy's sha256 after the run) */
    fcstd?: Array<{ path: string; sha256: string }>;
    step?: { path: string; sha256: string };
    /** FreeCAD's report of the STEP's shape (its claim, in mm) */
    reported?: FreecadShape & { objects: string[] };
    checks?: Array<{ label: string; passed: boolean }>;
    error?: string;
    log?: string;
    failure_files?: string[];
    receipt?: string;
  };
  readback?: {
    job?: string;
    /** 'not run' when it could not start (the setup step is `setup`) */
    state: string;
    worker?: { name: string; version: string };
    step?: { path: string; sha256: string };
    /** FreeCAD's report and the readback's measurement, each as /freecad readback records them */
    reported?: Record<string, unknown>;
    measured?: Record<string, unknown>;
    tolerance?: { bounds_mm: number; volume_relative: number };
    checks?: FreecadReadbackCheck[];
    verdict?: 'matches' | 'differs' | 'failed';
    reason?: string;
    setup?: string;
    log?: string;
    /** the run's readbacks.jsonl, where /freecad readback keeps each line */
    record?: string;
    receipt?: string;
    scope: string;
  };
  /** an earlier judged-ok run of the same script (before the flow started) and this run, as FreeCAD reported each */
  before_after?: {
    measured_by: string;
    before: (FreecadMeasure & { run: string; job?: string; started_at: string }) | null;
    before_note?: string;
    after?: FreecadMeasure & { run: string; job?: string };
  };
  receipts: { agent?: string; freecad?: string; readback?: string };
}

/** Whether a record (as read from its file) is a FreeCAD flow's. */
export function isFreecadFlowRecord(r: unknown): r is FreecadFlowRecord {
  const o = objOf(r);
  return !!o && o.kind === 'iterate' && o.target === 'freecad' && !!objOf(o.script);
}

/**
 * A FreeCAD flow in a few words for /iterate's list ("freecad plate.py +1 −1 lines in 1 place"); '' for any other record.
 * R4 (H40, review R4-4): a change the record holds in a form Timmy does not write is said, never counted.
 */
export function freecadFlowSummary(r: unknown): string {
  if (!isFreecadFlowRecord(r)) return '';
  const p = typeof r.script.path === 'string' ? r.script.path : '?';
  const ch = objOf(r.script.change);
  const c = r.script.change === undefined || r.script.change === null ? ''
    : ch && finite(ch.added) && finite(ch.removed) && finite(ch.hunks_total) ? ` ${changeText(r.script.change)}` : ' (its change is not in the form Timmy writes)';
  const without = r.outcome === 'succeeded' && objOf(r.readback)?.state === 'not run' ? ' · without readback' : '';
  return `freecad ${p}${c}${without}`;
}
