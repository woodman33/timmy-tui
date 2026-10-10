/**
 * /unreal in the REPL (round R4, helper H63). `/unreal <project.uproject> <script.py> [args]` starts an Unreal run as a judged
 * native job (src/native/unreal.ts; Workspace.unreal starts it as /freecad starts its runs). This module holds the rest:
 *
 *   /unreal                    usage, where UnrealEditor-Cmd is, whether Timmy's harness can be given to Unreal, the newest runs
 *   /unreal readback [<run>]   reads a judged-ok run's saved levels back in a second Unreal process and compares their actors
 *
 * and what happens when a run ends. firstPassEnded judges the first pass, says so, and when it was judged ok and saved a
 * level starts its readback at once: the first pass alone is never trusted. ended(job) records a readback when its job
 * ends: its line in the run's readbacks.jsonl (src/native/unreal-readback.ts), its output kept beside the run, a
 * `readback` receipt, and what it found, with the numbers.
 *
 * Both run synchronously at the job's end, inside the job manager's change listener and so inside the job's own operation:
 * the readback is started (and noted as a run of that operation) before anything else sees the first pass ended, and its
 * record and receipt are written before anything sees the readback ended. So `timmy act '/unreal …' --wait` waits for the
 * readback, and the operation's outcome is the readback's verdict (src/ops/outcome.ts).
 */
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { JobManager, JobRecord, JobSpec } from '../jobs/index.js';
import { locateNative, NATIVE_APPS } from '../native/index.js';
import { cm, judgeUnrealJob, UNREAL_FIRST_RUN, UNREAL_USAGE, unrealEndLines, unrealWorkers, type UnrealJobSpec } from '../native/unreal.js';
import {
  appendUnrealReadback, differenceWords, judgeUnrealReadback, listUnrealRuns, planUnrealReadback, UNREAL_READBACK_SCOPE, UNREAL_READBACK_TOLERANCE,
  unrealReadbackJob, type UnrealReadbackLine, type UnrealReadbackPlan,
} from '../native/unreal-readback.js';
import { projectId } from '../project/index.js';
import type { GlyphSet } from '../term/glyphs.js';
import type { Segment } from '../term/theme.js';
import type { ReceiptInput } from '../utils/receipts.js';

type Line = Segment[];

export interface UnrealDeps {
  glyphs: GlyphSet;
  /** The REPL's environment, read at each start. */
  env: () => NodeJS.ProcessEnv;
  /** Seals a receipt on the runs chain; its short id back, or undefined when sealing failed. */
  seal: (input: ReceiptInput) => string | undefined;
  jobs: JobManager;
  /** Starts a job as this REPL's own (so /stop and /stop all reach it); `selfSealed`: this module seals its receipt. */
  startJob: (spec: JobSpec, o?: { selfSealed?: boolean }) => JobRecord;
  /** Writes the project's folder as "." and the home folder as "~". */
  scrub: (text: string, root: string) => string;
}

/** A readback this REPL follows: what it reads, its token and the file it writes. */
interface Following { plan: UnrealReadbackPlan; token: string; result: string; project: string }

const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);
/** A readback's own output is kept beside the run up to this size; past it, it stays in the job's log. */
const KEEP_LOG_MAX = 16 * 1024 * 1024;
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const short = (h: string | undefined | null): string => (h ? `${h.slice(0, 12)}…` : 'none');
const tolWords = `${UNREAL_READBACK_TOLERANCE.location_cm} cm for locations and bounds, ${UNREAL_READBACK_TOLERANCE.scale} for scale, ${UNREAL_READBACK_TOLERANCE.rotation_matrix} per rotation-matrix element`;

export class UnrealRuns {
  /** The readbacks this REPL follows, by their job's id. */
  private readonly following = new Map<string, Following>();
  /** The REPL is ending: no readback starts after this. */
  private closing = false;

  constructor(private readonly d: UnrealDeps) {}

  private get sep(): string { return ` ${this.d.glyphs.sep} `; }
  private say(text: string, role: Segment['role'] = 'secondary'): Line[] { return [[{ text: `  ${text}`, role }]]; }

  /** The REPL is ending: a first pass that ends from now on starts no readback (it says how to start one). */
  close(): void { this.closing = true; }

  /** `/unreal` alone: the usage, where UnrealEditor-Cmd is, whether the harness can be given to Unreal, the newest runs. */
  usage(at: { root: string }): Line[] {
    const g = this.d.glyphs;
    const env = this.d.env();
    const lines: Line[] = [[{ text: '  Usage:', role: 'secondary' }], ...UNREAL_USAGE.map((u): Line => [{ text: `    ${u}`, role: 'secondary' }])];
    const { found, problem } = locateNative('unreal', env);
    const where = found ? (found.how === 'env' ? 'at TIMMY_UNREAL' : found.how === 'applications' ? `in ${found.base ?? '/Applications'}/${found.folder ?? ''}` : 'on PATH') : '';
    lines.push(found
      ? [{ text: '  Unreal     ', role: 'secondary' }, { text: 'UnrealEditor-Cmd found', role: 'strong' }, { text: `${this.sep}${where}${this.sep}found is not run: a judged run and its readback say whether it works`, role: 'secondary' }]
      : [{ text: '  Unreal     ', role: 'secondary' }, { text: problem ?? 'UnrealEditor-Cmd not found', role: 'estimate' }, { text: `${this.sep}${NATIVE_APPS.unreal.setup}`, role: 'secondary' }]);
    const w = unrealWorkers(env);
    lines.push(w.ok
      ? [{ text: '  Harness    ', role: 'secondary' }, { text: 'timmy_unreal.py and unreal_readback.py are there', role: 'strong' }, { text: `${this.sep}${UNREAL_FIRST_RUN}`, role: 'secondary' }]
      : [{ text: '  Harness    ', role: 'secondary' }, { text: w.why, role: 'estimate' }, { text: `${this.sep}${w.setup}`, role: 'secondary' }]);
    const runs = listUnrealRuns(at.root);
    lines.push([{ text: '  Runs       ', role: 'secondary' }, { text: runs.length ? 'newest first' : 'none yet in this project: /project new <name> --from unreal-starter, then /unreal TimmyStarter.uproject scene.py', role: 'secondary' }]);
    for (const r of runs.slice(0, 6)) {
      const v = r.verdict;
      const rb = r.readbacks.at(-1);
      const mark = v?.outcome === 'ok' && rb?.verdict === 'agrees' ? g.ok : v?.outcome === 'failed' || rb?.verdict === 'differs' || rb?.verdict === 'failed' ? g.fail : v ? '?' : ' ';
      lines.push([{ text: `    ${mark} `, role: mark === g.fail ? 'failure' : undefined }, { text: r.run.slice(0, 8), role: 'strong' },
        { text: `  ${v ? v.outcome : 'not judged yet'}${v?.outcome === 'ok' ? `${this.sep}readback ${rb ? rb.verdict ?? rb.state : 'none yet'}` : ''}${this.sep}${this.d.scrub(r.label, at.root)}${this.sep}${r.started_at}`, role: 'secondary' }]);
    }
    return lines;
  }

  /** `/unreal readback [<run>]`: starts the readback job, or says why nothing was started. */
  readback(words: string[], at: { root: string; project: string }): Line[] {
    if (words.length > 1) return this.say('Usage: /unreal readback [<run>]');
    const p = planUnrealReadback(at.root, words[0] ? { run: words[0] } : {});
    if (!p.ok) return this.say(`Not started: ${this.d.scrub(p.error, at.root)}`, 'estimate');
    const s = this.start(p.plan, at);
    if (!s.ok) return this.say(s.error, s.failed ? 'failure' : 'estimate');
    return [...this.startedLines(p.plan, s.job, '  '), ...s.ended];
  }

  /**
   * A first pass ended (completed or failed): its judgement and lines, then its readback started when it was judged ok and
   * saved a level, or why there is none. Synchronous (see the module's notes).
   */
  firstPassEnded(job: JobRecord, spec: UnrealJobSpec): Line[] {
    const j = judgeUnrealJob(job, spec);
    const scrub = (s: string): string => this.d.scrub(s, spec.root);
    const lines = unrealEndLines(j, spec, { id: job.id, label: job.label, glyphs: this.d.glyphs, sep: this.sep, scrub, ...(job.receipt ? { receipt: job.receipt } : {}) });
    const next = (text: string, role: Segment['role'] = 'secondary'): Line => [{ text: '      next     ', role: 'secondary' }, { text, role }];
    const run8 = spec.native.run.slice(0, 8);
    if (j.outcome !== 'ok') return [...lines, next('no readback: only a run judged ok is read back, and the first pass alone is never trusted')];
    if (!j.unreal.levels.length) return [...lines, next('it saved no level, so there is nothing to read back: nothing about a scene was checked', 'estimate')];
    if (this.closing) return [...lines, next(`the readback was not started: this REPL is ending; /unreal readback ${run8} starts it`, 'estimate')];
    const p = planUnrealReadback(spec.root, { run: spec.native.run });
    if (!p.ok) return [...lines, next(`the readback was not started: ${scrub(p.error)}`, 'estimate')];
    const s = this.start(p.plan, { root: spec.root, project: spec.project });
    if (!s.ok) return [...lines, next(s.error, s.failed ? 'failure' : 'estimate')];
    return [...lines, ...this.startedLines(p.plan, s.job, '      '), ...s.ended];
  }

  /** A job ended: when it is a readback this REPL follows, its record, receipt and lines (else undefined). Synchronous. */
  ended(job: JobRecord): Line[] | undefined {
    const f = this.following.get(job.id);
    if (!f || !TERMINAL.has(job.state)) return undefined;
    this.following.delete(job.id);
    return this.finish(job, f);
  }

  /** Starts the readback of a plan as this REPL's own job (selfSealed: its receipt is sealed here when it ends). */
  private start(plan: UnrealReadbackPlan, at: { root: string; project: string }): { ok: true; job: JobRecord; ended: Line[] } | { ok: false; failed?: true; error: string } {
    const env = this.d.env();
    const located = locateNative('unreal', env);
    if (!located.found) return { ok: false, error: `Not started: ${NATIVE_APPS.unreal.name} was not found on this machine${located.problem ? ` (${located.problem})` : ''}. Setup: ${NATIVE_APPS.unreal.setup}` };
    const w = unrealWorkers(env);
    if (!w.ok) return { ok: false, error: `Not started: ${w.why}. Setup: ${w.setup}` };
    const made = unrealReadbackJob(plan, { bin: located.found.path, worker: w.readback, lib: w.lib, project: at.project });
    let job: JobRecord;
    try { job = this.d.startJob(made.spec, { selfSealed: true }); } catch (e) {
      return { ok: false, failed: true, error: `Not started: the readback job did not start (${this.d.scrub(e instanceof Error ? e.message : String(e), at.root)})` };
    }
    const f: Following = { plan, token: made.token, result: made.result, project: at.project };
    // A job that ended before start returned (its folder gone at once) is recorded now, its lines with the start's.
    if (TERMINAL.has(job.state)) return { ok: true, job, ended: this.finish(job, f) };
    this.following.set(job.id, f);
    return { ok: true, job, ended: [] };
  }

  private startedLines(plan: UnrealReadbackPlan, job: JobRecord, indent: string): Line[] {
    const levels = plan.levels.map((l) => `${l.asset} (${l.file}, sha256 ${short(l.sha256)})`).join(', ');
    return [
      [{ text: `${indent}readback `, role: 'secondary' }, { text: job.id, role: 'strong' }, { text: `  a second Unreal process opens ${levels} and lists its actors, compared with the first pass's report: the first pass alone is never trusted${this.sep}/jobs ${job.id}${this.sep}/stop ${job.id}`, role: 'secondary' }],
      ...(plan.project.changed ? [[{ text: `${indent}         `, role: 'secondary' }, { text: `${plan.project.path} has changed since the first pass ran: the readback opens it as it is now`, role: 'estimate' }] as Line] : []),
    ];
  }

  /** The readback's end: its output kept, its record judged and appended, its receipt sealed, its lines. */
  private finish(done: JobRecord, f: Following): Line[] {
    const plan = f.plan;
    const logName = `readback-${done.id}.log`;
    const logRel = `.timmy/native/${plan.run}/${logName}`;
    let log: { sha256: string; bytes: number } | undefined;
    try {
      if (done.logPath && statSync(done.logPath).size <= KEEP_LOG_MAX) {
        copyFileSync(done.logPath, path.join(plan.dir, logName));
        const b = readFileSync(path.join(plan.dir, logName));
        log = { sha256: sha(b), bytes: b.length };
      }
    } catch { /* the job's own log stays in the jobs folder */ }
    const line = judgeUnrealReadback(plan, done, f.token, f.result);
    if (line.reason) line.reason = this.d.scrub(line.reason, plan.root);
    if (log) line.log = logRel;
    line.receipt = this.seal(done, plan, line, log, f.project);
    const recorded = appendUnrealReadback(plan.dir, line);
    return this.endLines(done, plan, line, recorded);
  }

  /** The readback's receipt (kind readback): what it read (in sources: it changed nothing), its job, the verdict and the differences. */
  private seal(job: JobRecord, plan: UnrealReadbackPlan, line: UnrealReadbackLine, log: { sha256: string; bytes: number } | undefined, project: string): string | undefined {
    const ms = job.endedAt ? Date.parse(job.endedAt) - Date.parse(job.startedAt) : undefined;
    const parent = plan.job ? this.d.jobs.get(plan.job)?.receipt : undefined;
    const failing = line.levels.flatMap((l) => l.checks.filter((c) => !c.passed).map((c) => `${l.asset}: ${differenceWords(c, c.differences[0])}`));
    const agrees = line.verdict === 'agrees';
    try {
      return this.d.seal({
        kind: 'readback', subject: `readback · ${plan.levels.map((l) => l.asset).join(', ')} · Unreal run ${plan.run.slice(0, 8)} · ${line.verdict ?? (job.state === 'cancelled' ? 'stopped' : job.state)}`, policy: 'human-gated',
        status: agrees ? 'ok' : job.state === 'cancelled' ? 'cancelled' : 'failed',
        project, project_id: projectId(plan.root),
        job: { id: job.id, kind: job.kind, label: this.d.scrub(job.label, plan.root), state: job.state, exit_code: job.exitCode ?? null, ...(ms !== undefined ? { ms } : {}), ...(job.error ? { error: this.d.scrub(job.error, plan.root) } : {}) },
        ...(line.log && log ? { outputs: [{ path: line.log, sha256: log.sha256, bytes: log.bytes }] } : {}),
        sources: [
          ...plan.levels.map((l) => ({ path: l.file, sha256: l.sha256, role: 'read' })),
          {
            unreal_run: plan.run, worker: line.worker ? `${line.worker.name} ${line.worker.version}` : null, unreal_version: line.unreal_version ?? null,
            tolerance: line.tolerance, verdict: line.verdict ?? null, ...(line.project_changed ? { project_changed: true } : {}),
            levels: line.levels.map((l) => ({ asset: l.asset, file: l.file, verdict: l.verdict, actors: l.actors, ...(l.reason ? { reason: this.d.scrub(l.reason, plan.root) } : {}) })),
            scope: UNREAL_READBACK_SCOPE, units: 'Unreal units (centimetres), degrees',
            // DOCTRINE §15: the bounds stay generated; only the second pass's agreement within the stated tolerance checks them.
            geometry: { provenance: 'generated', evidence: agrees ? 'checked' : 'constructed' },
          },
        ],
        ...(parent ? { child_receipts: [parent] } : {}),
        ...(failing.length ? { discrepancies: failing.slice(0, 50) } : line.reason && !agrees ? { discrepancies: [line.reason] } : {}),
      });
    } catch { return undefined; }
  }

  private endLines(job: JobRecord, plan: UnrealReadbackPlan, line: UnrealReadbackLine, recorded: boolean): Line[] {
    const g = this.d.glyphs;
    const agrees = line.verdict === 'agrees';
    const mark = agrees ? g.ok : line.verdict ? g.fail : ' ';
    const head = `${job.id} readback ${line.verdict ?? (job.state === 'cancelled' ? 'stopped' : job.state)}`;
    const where = recorded ? `record .timmy/native/${plan.run}/readbacks.jsonl` : 'its record could not be written';
    const counts = line.levels.map((l) => `${l.asset}: ${l.actors.agree} of ${l.actors.first_pass} actors agree`).join('; ');
    const lines: Line[] = [[
      { text: `  ${mark} `, role: agrees || !line.verdict ? undefined : 'failure' }, { text: head, role: agrees || !line.verdict ? 'strong' : 'failure' },
      { text: `  ${agrees ? counts : line.reason ?? ''}${this.sep}Unreal run ${plan.run.slice(0, 8)}${line.receipt ? `${this.sep}receipt ${line.receipt}` : ''}${this.sep}${where}${!agrees && line.log ? `${this.sep}its output: ${line.log}` : ''}`, role: 'secondary' },
    ]];
    for (const l of line.levels.filter((x) => x.verdict !== 'failed').slice(0, 4)) {
      lines.push([{ text: '      first pass ', role: 'secondary' }, { text: `${l.actors.first_pass} actors of ${l.asset}`, role: 'strong' }, { text: `${this.sep}as Unreal reported them when it saved the level (the first process)`, role: 'secondary' }]);
      lines.push([{ text: '      readback   ', role: 'secondary' }, { text: `${l.actors.readback} actors`, role: 'strong' }, { text: `${this.sep}as a second Unreal process loaded them from ${l.file} (sha256 ${short(l.sha256.read_before)}, the bytes the first pass recorded)`, role: 'secondary' }]);
      for (const c of l.checks.filter((x) => !x.passed).slice(0, 4)) {
        for (const d of c.differences.slice(0, 2)) lines.push([{ text: '      differs    ', role: 'secondary' }, { text: differenceWords(c, d), role: 'failure' }]);
      }
      const shown = l.checks.find((c) => c.passed && c.max);
      if (agrees && shown?.max) {
        lines.push([{ text: `      within ${tolWords}: agrees${this.sep}largest differences: location ${cm(Math.max(...l.checks.map((c) => c.max?.location_cm ?? 0)))} cm, bounds ${cm(Math.max(...l.checks.map((c) => c.max?.bounds_cm ?? 0)))} cm`, role: 'secondary' }]);
      }
    }
    if (line.verdict) lines.push([{ text: '      both are Unreal Engine: agreement shows the saved file holds what the first pass reported, not an independent engine\'s confirmation; Unreal units (centimetres) of a generated scene', role: 'secondary' }]);
    return lines;
  }
}
