/**
 * /freecad in the REPL (round R4, helper H28). `/freecad <script.py> [args]` starts a FreeCAD run as a judged native job
 * (src/native/freecad.ts; Workspace.freecad starts it like /blender). This module holds the rest:
 *
 *   /freecad                                  usage, where freecadcmd is, whether a readback can run, the newest runs
 *   /freecad readback [<run>] [<file.step>]  reads a judged-ok run's exported STEP back in its own process and compares
 *                                             it with FreeCAD's own report of the same shapes
 *
 * The readback is /iterate's runner, reused: workers/readback/step_readback.py run with TIMMY_CADQUERY_PYTHON as its own
 * Timmy job (nativeRuntime, READBACK_SCRIPT), its one JSON line read by parseReadbackOutput, the tolerance /iterate holds
 * a STEP to (READBACK_TOLERANCE). It starts only when the file's bytes are still the ones the run recorded; it checks
 * that the worker read those bytes; it keeps the worker's raw output beside the run (.timmy/native/<run>/readback-<job>.log),
 * appends what it found to the run's readbacks.jsonl and seals a `readback` receipt. Who measured what is said on every
 * line: FreeCAD reported its own document, in the process that built it; the worker measured the STEP file. Both are
 * OpenCascade, so a match shows the file holds what FreeCAD reported, not an independent kernel's confirmation.
 * DOCTRINE §15 goes with every dimension shown.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { JobManager, JobRecord, JobSpec } from '../jobs/index.js';
import { locateNative } from '../native/index.js';
import {
  appendReadback, compareFreecadReadback, DOCTRINE_15, FREECAD_READBACK_SCOPE, FREECAD_REPORTED_BY, FREECAD_USAGE, listFreecadRuns, planFreecadReadback, shapeWords,
  type FreecadReadbackCheck, type FreecadReadbackLine, type FreecadReadbackPlan, type FreecadShape,
} from '../native/freecad.js';
import { parseReadbackOutput, READBACK_MAX_OUTPUT, READBACK_SCRIPT, READBACK_TIMEOUT_MS, READBACK_TOLERANCE, toleranceText, type ReadbackFailure, type ReadbackMeasured } from '../flows/iterate.js';
import { nativeRuntime } from '../recipes/index.js';
import { projectId } from '../project/index.js';
import type { GlyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';
import type { ReceiptInput } from '../utils/receipts.js';

type Line = Segment[];

/** What a readback needs set up: the Python /iterate's readback runs with. */
export const READBACK_SETUP = 'set TIMMY_CADQUERY_PYTHON to the absolute path of a Python with CadQuery (its OCP reads the STEP)';

/** Test seams only (labelled where used). */
export interface FreecadTestSeams {
  /** A FAKE readback worker: the command run instead of TIMMY_CADQUERY_PYTHON workers/readback/step_readback.py. */
  readback?: (step: { abs: string; rel: string }) => { command: string; args: string[] };
}

export interface FreecadDeps {
  glyphs: GlyphSet;
  /** The REPL's environment, read at each start. */
  env: () => NodeJS.ProcessEnv;
  notify: (line: Line) => void;
  /** Seals a receipt on the runs chain; its short id back, or undefined when sealing failed. */
  seal: (input: ReceiptInput) => string | undefined;
  jobs: JobManager;
  /** Starts a job as this REPL's own (so /stop and /stop all reach it); `selfSealed`: this module seals its receipt. */
  startJob: (spec: JobSpec, o?: { selfSealed?: boolean }) => JobRecord;
  /** Writes the project's folder as "." and the home folder as "~". */
  scrub: (text: string, root: string) => string;
  test?: FreecadTestSeams;
}

/** Whether a readback could start now, and if not, why (said beside the offer, never checked by running anything). */
export function readbackReady(env: NodeJS.ProcessEnv, test?: FreecadTestSeams): { ready: boolean; why?: string } {
  if (test?.readback) return { ready: true };
  const rt = nativeRuntime(env);
  if (!rt.ok) return { ready: false, why: `${rt.why}: ${READBACK_SETUP}` };
  if (!existsSync(READBACK_SCRIPT)) return { ready: false, why: 'the readback worker (workers/readback/step_readback.py) is missing from this Timmy' };
  return { ready: true };
}

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const short = (h: string | undefined): string => (h ? `${h.slice(0, 12)}…` : 'none');

/** The readback's numbers as a shape (the same words as FreeCAD's report, so the two lines read side by side). */
const measuredShape = (m: ReadbackMeasured): FreecadShape => ({ valid: m.valid, solids: m.solids, volume_mm3: m.volume_mm3, bounds: { min: [...m.bounds.min], max: [...m.bounds.max], size: m.bounds.max.map((v, i) => v - m.bounds.min[i]) } });

/** A check's numbers in a few words: "volume (mm3): FreeCAD reported 33215.8, the readback measured 33216.8 (difference 1.00)". */
const checkWords = (c: FreecadReadbackCheck): string => `${c.name}: FreeCAD reported ${String(c.reported)}, the readback measured ${String(c.measured)}${c.difference !== null ? ` (difference ${c.difference.toPrecision(3)})` : ''}`;

export class FreecadReadbacks {
  /** The readbacks this REPL follows, by their job's id: each settles once its record and receipt are made. */
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly d: FreecadDeps) {}

  private get sep(): string { return ` ${this.d.glyphs.sep} `; }
  private say(text: string, role: Segment['role'] = 'secondary'): Line[] { return [[{ text: `  ${text}`, role }]]; }

  /** `/freecad` alone: the usage, where freecadcmd is, whether a readback can run, the project's newest FreeCAD runs. */
  usage(at: { root: string }): Line[] {
    const g = this.d.glyphs;
    const lines: Line[] = [[{ text: '  Usage:', role: 'secondary' }], ...FREECAD_USAGE.map((u): Line => [{ text: `    ${u}`, role: 'secondary' }])];
    const { found, problem } = locateNative('freecad', this.d.env());
    lines.push(found
      ? [{ text: '  FreeCAD    ', role: 'secondary' }, { text: 'freecadcmd found', role: 'strong' }, { text: `${this.sep}${found.how === 'env' ? 'at TIMMY_FREECADCMD' : found.how === 'applications' ? `in /Applications/${found.folder ?? ''}` : 'on PATH'}${this.sep}found is not run: a judged run says whether it works`, role: 'secondary' }]
      : [{ text: '  FreeCAD    ', role: 'secondary' }, { text: problem ?? 'freecadcmd not found', role: 'estimate' }, { text: `${this.sep}install FreeCAD, or set TIMMY_FREECADCMD to its freecadcmd (or FreeCAD.app)`, role: 'secondary' }]);
    const ready = readbackReady(this.d.env(), this.d.test);
    lines.push(ready.ready
      ? [{ text: '  Readback   ', role: 'secondary' }, { text: this.d.test?.readback ? 'a FAKE readback worker (test seam)' : 'TIMMY_CADQUERY_PYTHON is set', role: 'strong' }, { text: `${this.sep}checked when a readback runs, not now`, role: 'secondary' }]
      : [{ text: '  Readback   ', role: 'secondary' }, { text: ready.why ?? 'not ready', role: 'estimate' }]);
    const runs = listFreecadRuns(at.root);
    lines.push([{ text: '  Runs       ', role: 'secondary' }, { text: runs.length ? 'newest first' : 'none yet in this project: /freecad plate.py (templates/freecad-starter)', role: 'secondary' }]);
    for (const r of runs.slice(0, 6)) {
      const v = r.verdict;
      const rb = r.readbacks.at(-1);
      const mark = v?.outcome === 'ok' ? g.ok : v?.outcome === 'failed' ? g.fail : v ? '?' : ' ';
      lines.push([{ text: `    ${mark} `, role: v?.outcome === 'failed' ? 'failure' : undefined }, { text: r.run.slice(0, 8), role: 'strong' },
        { text: `  ${v ? v.outcome : 'not judged yet'}${this.sep}${this.d.scrub(r.label, at.root)}${rb ? `${this.sep}readback ${rb.verdict ?? rb.state}` : ''}${this.sep}${r.started_at}`, role: 'secondary' }]);
    }
    return lines;
  }

  /** `/freecad readback [<run>] [<file.step>]`: starts the readback job, or says why nothing was started. */
  start(words: string[], at: { root: string; project: string }): Line[] {
    const named = words.filter((w) => !/\.(step|stp)$/i.test(w));
    const files = words.filter((w) => /\.(step|stp)$/i.test(w));
    if (named.length > 1 || files.length > 1) return this.say('Usage: /freecad readback [<run>] [<file.step>]');
    const p = planFreecadReadback(at.root, { ...(named[0] ? { run: named[0] } : {}), ...(files[0] ? { step: files[0] } : {}) });
    if (!p.ok) return this.say(`Not started: ${this.d.scrub(p.error, at.root)}`, 'estimate');
    const plan = p.plan;
    let cmd: { command: string; args: string[] };
    if (this.d.test?.readback) cmd = this.d.test.readback({ abs: plan.step.abs, rel: plan.step.path });
    else {
      const ready = readbackReady(this.d.env());
      const rt = nativeRuntime(this.d.env());
      if (!ready.ready || !rt.ok) return this.say(`Not started: ${ready.why ?? READBACK_SETUP}`, 'estimate');
      cmd = { command: rt.python, args: [READBACK_SCRIPT, plan.step.abs, '--as', plan.step.path] };
    }
    let job: JobRecord;
    try {
      job = this.d.startJob({ kind: 'task', label: `readback ${plan.step.path} · FreeCAD run ${plan.run.slice(0, 8)}`, project: at.project, root: at.root, command: cmd.command, args: cmd.args, timeoutMs: READBACK_TIMEOUT_MS }, { selfSealed: true });
    } catch (e) {
      return this.say(`Not started: the readback job did not start (${this.d.scrub(e instanceof Error ? e.message : String(e), at.root)})`, 'failure');
    }
    const done = this.follow(job, plan, at).catch((e) => {
      this.d.notify(this.say(`${job.id}: the readback could not be recorded (${this.d.scrub(e instanceof Error ? e.message : String(e), at.root)})`, 'failure')[0]);
    }).finally(() => { this.running.delete(job.id); });
    this.running.set(job.id, done);
    const r = plan.reported;
    return [
      [{ text: '  Readback   ', role: 'secondary' }, { text: job.id, role: 'strong' }, { text: `  reads ${plan.step.path} (sha256 ${short(plan.step.sha256)}, as FreeCAD run ${plan.run.slice(0, 8)} recorded it) in its own process: OCP's STEP reader${this.sep}/jobs ${job.id}${this.sep}/stop ${job.id}`, role: 'secondary' }],
      [{ text: '  Compares   ', role: 'secondary' }, { text: `with FreeCAD's report of ${plan.objects.join(', ') || 'the exported shapes'}: ` }, { text: shapeWords(r), role: 'strong' }, { text: `${this.sep}within ${toleranceText(READBACK_TOLERANCE)}`, role: 'secondary' }],
      ...(plan.others.length ? this.say(`           the run's other STEP exports (${plan.others.join(', ')}): /freecad readback ${plan.run.slice(0, 8)} <file.step>`) : []),
      [{ text: `  ${DOCTRINE_15}`, role: 'strong' }],
    ];
  }

  /** Waits (at most `ms`) for every readback this REPL follows to write its record. */
  async settle(ms = 30_000): Promise<void> {
    const all = Promise.allSettled([...this.running.values()]);
    await Promise.race([all, new Promise((r) => { setTimeout(r, ms).unref?.(); })]);
  }

  /** When the readback job ends: parse, check the bytes it read, compare, keep its output, record, seal, say. */
  private async follow(started: JobRecord, plan: FreecadReadbackPlan, at: { root: string; project: string }): Promise<void> {
    const done = await this.d.jobs.done(started.id);
    const logName = `readback-${done.id}.log`;
    const logRel = `.timmy/native/${plan.run}/${logName}`;
    let log: { sha256: string; bytes: number } | undefined;
    try {
      copyFileSync(done.logPath, path.join(plan.dir, logName));
      const b = readFileSync(path.join(plan.dir, logName));
      log = { sha256: sha(b), bytes: b.length };
    } catch { /* the job's own log stays in the jobs folder */ }
    const line: FreecadReadbackLine = {
      readback: 1, at: new Date().toISOString(), job: done.id, run: plan.run, state: done.state, step: { path: plan.step.path, sha256: plan.step.sha256 },
      reported: { ...plan.reported, objects: [...plan.objects], ...(plan.version ? { freecad_version: plan.version } : {}), measured_by: FREECAD_REPORTED_BY, units: 'mm', geometry: { provenance: 'generated', evidence: 'constructed' } },
      tolerance: { ...READBACK_TOLERANCE }, ...(log ? { log: logRel } : {}), scope: FREECAD_READBACK_SCOPE, doctrine: DOCTRINE_15,
    };
    const kept = log ? `; its output is kept: ${logRel}` : '';
    let parsed: ReadbackMeasured | ReadbackFailure | undefined;
    if (done.state === 'cancelled') {
      line.reason = 'stopped with /stop before it finished: no verdict';
    } else {
      let size = 0;
      try { size = statSync(done.logPath).size; } catch { size = 0; }
      parsed = size > READBACK_MAX_OUTPUT
        ? { ok: false, code: 'too-much-output', error: `the worker printed more than ${READBACK_MAX_OUTPUT} bytes` }
        : parseReadbackOutput(this.d.jobs.tail(done.id, 400).join('\n'));
      if (parsed.worker) line.worker = parsed.worker;
      if (!parsed.ok) {
        line.verdict = 'failed';
        line.reason = this.d.scrub(`${parsed.code}: ${parsed.error}${done.state !== 'completed' ? ` (${done.error ?? `exit ${done.exitCode ?? done.signal ?? '?'}`})` : ''}`, at.root);
      } else if (done.state !== 'completed') {
        line.verdict = 'failed';
        line.reason = `the worker reported values but ${done.error ?? `exited ${done.exitCode ?? done.signal ?? '?'}`}`;
      } else {
        if (parsed.engine) line.engine = parsed.engine;
        const tag = { provenance: 'generated', evidence: 'constructed' };
        line.measured = { ...measuredShape(parsed), sha256: parsed.source.sha256, ...(parsed.unit_in_effect !== undefined ? { unit_in_effect: parsed.unit_in_effect } : {}), measured_by: `${parsed.worker.name} ${parsed.worker.version}, from the file's bytes in its own process`, units: 'mm', geometry: tag };
        if (parsed.source.sha256 !== plan.step.sha256) {
          line.verdict = 'failed';
          line.reason = `the worker read bytes other than ${plan.step.path} as the run recorded it (sha256 ${short(parsed.source.sha256)}, recorded ${short(plan.step.sha256)})`;
        } else {
          const cmp = compareFreecadReadback(plan.reported, parsed);
          line.checks = cmp.checks;
          line.verdict = cmp.verdict;
          // DOCTRINE §15: the file's dimensions are checked only by agreement within the stated tolerance; a model's opinion never moves it.
          if (cmp.verdict === 'matches') tag.evidence = 'checked';
          if (cmp.verdict === 'differs') line.reason = cmp.checks.filter((c) => !c.passed).map(checkWords).join('; ');
        }
      }
    }
    line.receipt = this.seal(done, plan, line, log, at);
    const recorded = appendReadback(plan.dir, line);
    for (const l of this.endLines(done, plan, line, parsed && parsed.ok ? parsed : undefined, kept, recorded)) this.d.notify(l);
  }

  /** The readback's receipt (kind readback): what it read (in sources: it changed nothing), its job, both sets of numbers and the verdict. */
  private seal(job: JobRecord, plan: FreecadReadbackPlan, line: FreecadReadbackLine, log: { sha256: string; bytes: number } | undefined, at: { root: string; project: string }): string | undefined {
    const ms = job.endedAt ? Date.parse(job.endedAt) - Date.parse(job.startedAt) : undefined;
    const parent = plan.job ? this.d.jobs.get(plan.job)?.receipt : undefined;
    const failing = (line.checks ?? []).filter((c) => !c.passed).map(checkWords);
    try {
      return this.d.seal({
        kind: 'readback', subject: `readback · ${plan.step.path} · FreeCAD run ${plan.run.slice(0, 8)} · ${line.verdict ?? line.state}`, policy: 'human-gated',
        status: line.verdict === 'matches' ? 'ok' : job.state === 'cancelled' ? 'cancelled' : 'failed',
        project: at.project, project_id: projectId(at.root),
        job: { id: job.id, kind: job.kind, label: this.d.scrub(job.label, at.root), state: job.state, exit_code: job.exitCode ?? null, ...(ms !== undefined ? { ms } : {}), ...(job.error ? { error: this.d.scrub(job.error, at.root) } : {}) },
        ...(line.log && log ? { outputs: [{ path: line.log, sha256: log.sha256, bytes: log.bytes }] } : {}),
        sources: [
          { path: plan.step.path, sha256: plan.step.sha256, role: 'read' },
          {
            freecad_run: plan.run, worker: line.worker ? `${line.worker.name} ${line.worker.version}` : null, reported: line.reported, measured: line.measured ?? null,
            tolerance: line.tolerance, verdict: line.verdict ?? null, scope: FREECAD_READBACK_SCOPE, units: 'mm', doctrine: DOCTRINE_15,
          },
        ],
        ...(parent ? { child_receipts: [parent] } : {}),
        ...(failing.length ? { discrepancies: failing } : line.reason ? { discrepancies: [line.reason] } : {}),
      });
    } catch { return undefined; }
  }

  private endLines(job: JobRecord, plan: FreecadReadbackPlan, line: FreecadReadbackLine, m: ReadbackMeasured | undefined, kept: string, recorded: boolean): Line[] {
    const g = this.d.glyphs;
    const ok = line.verdict === 'matches';
    const mark = ok ? g.ok : line.verdict ? g.fail : ' ';
    const head = `${job.id} readback ${line.verdict ?? (job.state === 'cancelled' ? 'stopped' : job.state)}`;
    const where = recorded ? `record .timmy/native/${plan.run}/readbacks.jsonl` : 'its record could not be written';
    const tail = `${this.sep}FreeCAD run ${plan.run.slice(0, 8)}${line.receipt ? `${this.sep}receipt ${line.receipt}` : ''}${this.sep}${where}`;
    const lines: Line[] = [[{ text: `  ${mark} `, role: ok || !line.verdict ? undefined : 'failure' }, { text: head, role: ok || !line.verdict ? 'strong' : 'failure' },
      { text: `  ${plan.step.path}${line.reason ? `: ${line.reason}` : ''}${tail}${ok ? '' : kept}`, role: 'secondary' }]];
    if (m) {
      lines.push([{ text: '      FreeCAD reported   ', role: 'secondary' }, { text: shapeWords(plan.reported), role: 'strong' }, { text: `${this.sep}FreeCAD ${plan.version ?? '(version not reported)'}: ${FREECAD_REPORTED_BY}`, role: 'secondary' }]);
      lines.push([{ text: '      readback measured  ', role: 'secondary' }, { text: shapeWords(measuredShape(m)), role: 'strong' }, { text: `${this.sep}${m.worker.name} ${m.worker.version}, from the file's bytes (sha256 ${short(m.source.sha256)}) in its own process`, role: 'secondary' }]);
      if (line.verdict === 'matches' || line.verdict === 'differs') {
        lines.push([{ text: `      within ${toleranceText(line.tolerance)}: ${line.verdict}${this.sep}both are OpenCascade: a match shows the file holds the geometry FreeCAD reported, not an independent kernel's confirmation`, role: 'secondary' }]);
      }
      lines.push([{ text: `      ${DOCTRINE_15}`, role: 'strong' }]);
    }
    return lines;
  }
}
