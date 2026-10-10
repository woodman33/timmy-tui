/**
 * /iterate freecad in the REPL (round R4, helper H33): the FreeCAD variant of the connected workflow, one flow with its
 * own id (f + 8 hex), run beside the other flows (src/repl/iterate.ts parses the line and hands it here):
 *
 *   1. before anything starts: the script is a .py in the project, reached through no link, outside .git, node_modules,
 *      .timmy and dist (the agent's before/after comparison does not look there), at most 256 KB; freecadcmd is found;
 *      the agent's route is local and free. Its bytes are read and kept in the flow's folder (script.before.py);
 *   2. a local code agent runs through /agent's own start, told to change only that script;
 *   3. after it: any other file changed, the script deleted, or changed after the agent ended, no change, or a script that
 *      no longer parses as Python (an AST parse by this machine's python3 when there is one; otherwise not checked, and
 *      said so) stops the flow before FreeCAD runs. Nothing is reverted;
 *   4. `/freecad <script>` as the judged native job (src/native/freecad.ts freecadJob, started and adopted as /freecad's:
 *      its end notice and its native receipt are /freecad's), judged by its result file; the flow waits for it;
 *   5. the readback of its STEP exactly as `/freecad readback` does it (src/repl/freecad.ts FreecadReadbacks.run: the same
 *      worker, workers/readback/step_readback.py run with TIMMY_CADQUERY_PYTHON, the same tolerance, the same record in
 *      the run's readbacks.jsonl and the same receipt). Its verdict is the flow's: matches, differs or failed. Without
 *      TIMMY_CADQUERY_PYTHON the flow ends after FreeCAD as "succeeded without readback", with the setup step, never
 *      "matches";
 *   6. the flow record (results/flows/<flow-id>.json) and a `flow` receipt binding its sha256 and the child receipts (the
 *      agent's, the FreeCAD run's, the readback's). Every raw failure stays where it was written, and the record names it.
 *
 * Before and after: the script's line diff, and FreeCAD's reported bounds and volume of the STEP from an earlier run of
 * the same script judged ok before the flow started (if any) and from this run, each labelled with its run. Both are
 * FreeCAD's own report; the readback is OCP's STEP reader. Both are OpenCascade: a match shows the file holds the
 * geometry FreeCAD reported, not an independent kernel's confirmation. DOCTRINE §15's sentence goes with every dimension.
 */
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { locateNative, NATIVE_APPS, NativeNotFound, sha256File } from '../native/index.js';
import {
  FREECAD_READBACK_SCOPE, FREECAD_REPORTED_BY, freecadJob, judgeFreecadJob, planFreecadReadback, readReadbacks, shapeWords, type FreecadJobSpec, type FreecadReadbackPlan,
} from '../native/freecad.js';
import { resolveInside } from '../project/index.js';
import { FLOW_SCHEMA, flowRecordPath, flowWorkDir, mm3Text, mmText, newFlowId, READBACK_TOLERANCE, toleranceText } from '../flows/iterate.js';
import { changeText, DOCTRINE_15, judgeFileChanges, lineCount, NATIVE_FILE_MAX_BYTES, scriptChange, syntaxWords, unseenFolder } from '../flows/iterate-native.js';
import { FREECAD_FLOW_MEASURED_BY, freecadIterateTask, previousFreecadRun, stepMeasure, type FreecadFlowRecord, type FreecadMeasure } from '../flows/iterate-freecad.js';
import { keepBytes, NativeFlows, relTo, sha, short, type Line, type NativeIterateRequest, type NativeRun, type Started } from './iterate-native.js';

export const FREECAD_ITERATE_USAGE = '/iterate freecad <script.py> "<instruction>" [--agent qwen|codex] [--model <local model>]';

interface FreecadRun extends NativeRun<FreecadFlowRecord> {
  /** the script's text as read before the agent ran (the change is summarised against it) */
  beforeText: string;
  spec?: FreecadJobSpec;
}

/** The kept-file names a failed FreeCAD run leaves, that exist. */
const kept = (root: string, names: string[]): string[] => [...new Set(names)].filter((n) => { try { lstatSync(path.join(root, n)); return true; } catch { return false; } });
const measureWords = (m: FreecadMeasure): string => `${mmText(m.size)} mm, ${mm3Text(m.volume_mm3)} mm3`;

export class FreecadFlows extends NativeFlows<FreecadFlowRecord> {
  readonly target = 'freecad' as const;
  readonly app = 'FreeCAD';
  readonly appStep = 'freecad';
  readonly usage = FREECAD_ITERATE_USAGE;

  protected what(r: FreecadFlowRecord): string { return `freecad ${r.script.path}`; }

  /** Whether the STEP readback could run after FreeCAD (said, never checked by running anything). */
  private readbackReady(): { ready: boolean; why?: string } {
    return this.d.freecadReadback ? this.d.freecadReadback.ready() : { ready: false, why: 'this REPL cannot run a STEP readback' };
  }

  /** /iterate's usage lines for the FreeCAD flow: whether freecadcmd is found (found is not run) and whether the readback can run. */
  usageLines(): Line[] {
    const { found, problem } = locateNative('freecad', this.d.env());
    const ready = this.readbackReady();
    return [
      [{ text: '  FreeCAD    ', role: 'secondary' }, { text: FREECAD_ITERATE_USAGE, role: 'strong' }],
      ...this.say('           the agent may change only that script; /freecad runs it as a judged job; its STEP is read back as /freecad readback reads it'),
      found
        ? [{ text: '             ', role: 'secondary' }, { text: `freecadcmd found (${found.how === 'env' ? 'set by TIMMY_FREECADCMD' : found.how === 'applications' ? 'in /Applications' : 'on PATH'})`, role: 'strong' }, { text: `${this.sep}it runs when a flow does, not now`, role: 'secondary' }]
        : [{ text: '             ', role: 'secondary' }, { text: `freecadcmd not found${problem ? ` (${problem})` : ''}`, role: 'estimate' }, { text: `${this.sep}${NATIVE_APPS.freecad.setup}`, role: 'secondary' }],
      ready.ready
        ? [{ text: '             ', role: 'secondary' }, { text: 'the readback can run', role: 'strong' }, { text: `${this.sep}checked when a flow reaches it, not now`, role: 'secondary' }]
        : [{ text: '             ', role: 'secondary' }, { text: `no readback: ${ready.why ?? 'not ready'}`, role: 'estimate' }, { text: `${this.sep}a flow then ends after FreeCAD, succeeded without readback`, role: 'secondary' }],
    ];
  }

  async start(req: NativeIterateRequest, at: { root: string; project: string }): Promise<Started<FreecadFlowRecord>> {
    const { root, project } = at;
    const scrub = (t: string): string => this.d.scrub(t, root);
    const env: NodeJS.ProcessEnv = { ...this.d.env(), ...(req.model ? { TIMMY_AGENT_MODEL: req.model } : {}) };
    // The script first: a regular .py in the project, reached through no link, where the agent's comparison can see it.
    const found = resolveInside(root, req.file);
    if ('error' in found) return this.refuse(`${scrub(found.error)}. Nothing was started.`);
    const rel = found.rel;
    if (!/\.py$/i.test(rel)) return this.refuse(`${rel} is not a Python file (.py): /iterate freecad changes a FreeCAD Python script. Nothing was started.`);
    const hidden = unseenFolder(rel);
    if (hidden) return this.refuse(`${rel} is inside ${hidden}/, which the agent's before/after comparison does not look into, so a change to it could not be seen: keep the script elsewhere in the project. Nothing was started.`);
    let realRoot: string;
    try { realRoot = realpathSync(root); } catch { return this.refuse('The project folder is gone. Nothing was started.'); }
    let st;
    try { st = lstatSync(found.path); } catch { return this.refuse(`No script at ${rel}: /project new <name> --from freecad-starter makes a project with one (plate.py). Nothing was started.`); }
    if (found.path !== path.join(realRoot, ...rel.split('/')) || st.isSymbolicLink()) return this.refuse(`${rel} is reached through a symbolic link, and the agent's before/after comparison sees the link, not the file: name the file itself. Nothing was started.`);
    if (!st.isFile()) return this.refuse(`${rel} is not a regular file. Nothing was started.`);
    if (st.size > NATIVE_FILE_MAX_BYTES) return this.refuse(`${rel} is ${st.size} bytes: /iterate freecad gives the agent the whole script, and takes scripts up to ${NATIVE_FILE_MAX_BYTES / 1024} KB. Nothing was started.`);
    // The route: local and free, or refused with the reason.
    const route = this.route(req, env, root);
    if (!route.ok) return this.refuse(route.error, route.role);
    const busy = this.busy(root);
    if (busy) return this.refuse(`Flow ${busy.id} is still running in this project (its ${busy.step} step), and one flow at a time runs in a project (an agent's before/after comparison covers all of it): wait for it, or /stop ${busy.id}. Nothing was started.`, 'estimate');
    // freecadcmd before the agent works: it runs after the agent, so it comes first.
    const located = locateNative('freecad', env);
    if (!located.found) {
      return this.refuse(`Not started: ${NATIVE_APPS.freecad.name} was not found on this machine${located.problem ? ` (${located.problem})` : ''}. /iterate freecad runs FreeCAD after the agent, so FreeCAD comes first.`, 'estimate', this.say(`Setup: ${NATIVE_APPS.freecad.setup}, then /iterate again.`));
    }
    if (!this.d.startNative) return this.refuse('Not started: this REPL cannot start a native job.');
    const id = newFlowId();
    // Awaited only for Codex's local route, so a Qwen Code start reaches its agent's start (which holds the project)
    // without yielding: no second flow can pass the check above meanwhile.
    const pre = route.plan.oss ? await this.preflight(route.plan, root, id) : undefined;
    if (pre) return this.refuse(pre, 'estimate');
    let bytes: Buffer;
    try { bytes = readFileSync(found.path); } catch (e) { return this.refuse(`${rel} could not be read: ${scrub(e instanceof Error ? e.message : String(e))}. Nothing was started.`); }
    const beforeText = bytes.toString('utf8');
    const startedAt = new Date().toISOString();
    const task = freecadIterateTask({ instruction: req.instruction, scriptRel: rel, scriptText: beforeText });
    const s = await this.startAgent(id, req, task, { root, project, env, local: route.local });
    if (!s.ok) return this.refuse(`The agent did not start: ${scrub(s.error)}`, s.refused === 'paid' || s.refused === 'missing' ? 'estimate' : 'failure');
    const keptAt = keepBytes(root, `${flowWorkDir(id)}/script.before.py`, bytes);
    // Before: an earlier FreeCAD run of this script judged ok, before this flow started (FreeCAD's report of its STEP).
    const prev = previousFreecadRun(root, rel, startedAt);
    const record: FreecadFlowRecord = {
      flow: 1, schema: FLOW_SCHEMA, id, kind: 'iterate', target: 'freecad', instruction: req.instruction, project, started_at: startedAt, outcome: 'running',
      script: { path: rel, before: { sha256: sha(bytes), bytes: bytes.length, lines: lineCount(beforeText), ...(keptAt ? { kept: keptAt } : {}) } },
      agent: this.agentPart(s),
      before_after: 'none' in prev
        ? { measured_by: FREECAD_FLOW_MEASURED_BY, before: null, before_note: prev.none }
        : { measured_by: FREECAD_FLOW_MEASURED_BY, before: { ...prev.measure, run: prev.run, ...(prev.job ? { job: prev.job } : {}), started_at: prev.started_at } },
      receipts: {}, child_receipts: [], doctrine: DOCTRINE_15,
    };
    const flow: FreecadRun = { id, root, project, record, abort: new AbortController(), step: 'agent', beforeText, agentJob: s.job.id, agentRecord: s.record };
    this.launch(flow, (f) => this.steps(f as FreecadRun));
    const g = this.d.glyphs;
    const how = located.found.how === 'env' ? 'set by TIMMY_FREECADCMD' : located.found.how === 'applications' ? 'in /Applications' : 'on PATH';
    const ready = this.readbackReady();
    const before = record.before_after!.before;
    return {
      ok: true, flow, lines: [
        [{ text: '  Flow       ', role: 'secondary' }, { text: id, role: 'strong' }, { text: `  iterate freecad ${rel}: ${scrub(req.instruction)}`, role: 'secondary' }],
        [{ text: '  Script     ', role: 'secondary' }, { text: rel, role: 'strong' }, { text: `  ${record.script.before.lines} lines${this.sep}sha256 ${short(record.script.before.sha256)}${keptAt ? `${this.sep}kept as read: ${keptAt}` : ''}`, role: 'secondary' }],
        [{ text: '  Agent      ', role: 'secondary' }, { text: s.job.id, role: 'strong' }, { text: `  agent ${s.plan.agent} ${s.run}${this.sep}${s.info.title}${s.version ? ` ${s.version}` : ''}${s.plan.model ? `${this.sep}model ${s.plan.model} at ${s.plan.where}` : ''}${this.sep}${s.plan.charge}`, role: 'secondary' }],
        [{ text: '  Next       ', role: 'secondary' }, { text: `it may change only ${rel}; then FreeCAD (found, ${how}) runs it as a judged job, ${ready.ready ? 'and its STEP is read back in a separate process as /freecad readback reads it' : `and the flow ends there: no readback (${ready.why})`}`, role: ready.ready ? 'secondary' : 'estimate' }],
        [{ text: '  Before     ', role: 'secondary' }, { text: before ? `run ${before.run.slice(0, 8)} (judged ok): ${measureWords(before)} in ${before.step}, as FreeCAD reported it` : `${record.before_after!.before_note}: the flow's run is reported alone`, role: 'secondary' }],
        [{ text: '  Follow     ', role: 'secondary' }, { text: `/jobs ${s.job.id}${this.sep}/stop ${id} stops the flow${this.sep}/iterate lists flows${this.sep}the record: ${flowRecordPath(id)} ${g.arrow} /board`, role: 'secondary' }],
      ],
    };
  }

  // ── the steps ────────────────────────────────────────────────────────────────

  private async steps(f: FreecadRun): Promise<void> {
    await this.agentStep(f);
    if (f.record.outcome === 'running') await this.checksStep(f);
    if (f.record.outcome === 'running') await this.freecadStep(f);
    if (f.record.outcome === 'running') await this.readbackStep(f);
  }

  private async checksStep(f: FreecadRun): Promise<void> {
    f.step = 'checks';
    const rel = f.record.script.path;
    const before = f.record.script.before;
    const a = f.record.agent!;
    const keptOut = a.transcript ? `; the agent's output is kept: ${a.transcript}` : '';
    const judged = judgeFileChanges(f.agentRecord?.files, rel);
    if (!judged.ok) {
      if (judged.others.length) a.others = judged.others;
      return this.end(f, 'stopped', 'checks', `${judged.why}; FreeCAD did not run, and nothing was reverted${keptOut}`);
    }
    // The agent's snapshot before it ran must have seen the bytes Timmy read (and gave it in its task).
    const seenBefore = judged.change?.previous_sha256;
    if (judged.params === 'changed' && seenBefore && seenBefore !== before.sha256) {
      return this.end(f, 'stopped', 'checks', `${rel} changed between Timmy's read and the agent's start (sha256 ${short(before.sha256)} read, ${short(seenBefore)} when the agent started); FreeCAD did not run`);
    }
    // The file as it is now, read here (not the agent's word): it must be what the agent's own snapshot saw.
    let bytes: Buffer;
    try { bytes = readFileSync(path.join(f.root, rel)); } catch { return this.end(f, 'stopped', 'checks', `${rel} cannot be read after the agent's run; FreeCAD did not run`); }
    const now = sha(bytes);
    const seen = judged.params === 'changed' ? judged.change?.sha256 ?? null : before.sha256;
    if (seen !== now) return this.end(f, 'stopped', 'checks', `${rel} changed after the agent's run ended (sha256 ${short(now)} now; the agent left ${seen ? short(seen) : 'an unhashed file'}); FreeCAD did not run`);
    if (judged.params === 'unchanged') return this.end(f, 'stopped', 'checks', 'the agent changed nothing; FreeCAD did not run');
    const afterText = bytes.toString('utf8');
    const change = scriptChange(f.beforeText, afterText);
    f.record.script.after = { sha256: now, bytes: bytes.length, lines: lineCount(afterText) };
    f.record.script.change = change;
    this.saveState(f);
    const syntax = await this.syntax(f, bytes, rel);
    f.record.script.syntax = syntax;
    if (this.stopped(f)) return this.end(f, 'cancelled', 'checks', 'stopped with /stop during the checks; FreeCAD did not run');
    if (syntax.checked && !syntax.ok) return this.end(f, 'stopped', 'checks', `${rel} as the agent left it ${syntaxWords(syntax, 'FreeCAD')}; it is left as the agent wrote it; FreeCAD did not run${keptOut}`);
    this.note(f, `agent ${a.agent} ${a.run} completed: changed ${rel} (${changeText(change)})${this.sep}${syntaxWords(syntax, 'FreeCAD')}`, syntax.checked ? 'secondary' : 'estimate');
    this.saveState(f);
  }

  private async freecadStep(f: FreecadRun): Promise<void> {
    f.step = 'freecad';
    if (this.stopped(f)) return this.end(f, 'cancelled', 'freecad', 'stopped with /stop before FreeCAD ran');
    const rel = f.record.script.path;
    const after = f.record.script.after!;
    let spec: FreecadJobSpec;
    try {
      // /freecad's own job: the read-only copy kept at submission runs; the run is judged by its own result file.
      spec = freecadJob({ script: rel, root: f.root, project: f.project, findEnv: this.d.env(), label: `FreeCAD · ${rel} · flow ${f.id}` });
    } catch (e) {
      const why = this.d.scrub(e instanceof NativeNotFound ? `${e.message}; ${e.setup}` : e instanceof Error ? e.message : String(e), f.root);
      f.record.freecad = { state: 'not started', error: why };
      return this.end(f, 'failed', 'freecad', `FreeCAD did not start: ${why}`);
    }
    f.spec = spec;
    const n = spec.native;
    const c: NonNullable<FreecadFlowRecord['freecad']> = {
      run: n.run, ...(n.record ? { record: relTo(n.root, n.record) } : {}), state: 'submitted', module: spec.freecad.module, ...(n.copy ? { copy: { ...n.copy } } : {}),
    };
    f.record.freecad = c;
    if (n.input?.sha256 !== after.sha256) {
      c.state = 'not started';
      return this.end(f, 'stopped', 'freecad', `${rel} changed after it was checked (sha256 ${short(n.input?.sha256)} when submitted, ${short(after.sha256)} checked); FreeCAD did not run`);
    }
    let job;
    try { job = this.d.startNative!(spec); } catch (e) {
      c.state = 'not started';
      c.error = this.d.scrub(e instanceof Error ? e.message : String(e), f.root);
      return this.end(f, 'failed', 'freecad', `FreeCAD did not start: ${c.error}`);
    }
    f.nativeJob = job.id;
    c.job = job.id;
    c.state = 'running';
    this.note(f, `FreeCAD: ${job.id} runs ${rel} as submitted (its copy: ${n.copy?.path ?? 'none'}, as module ${spec.freecad.module})${this.sep}judged by its result file${this.sep}/jobs ${job.id}`);
    this.saveState(f);
    if (this.stopped(f)) await this.d.jobs.stop(job.id);
    const done = await this.d.jobs.done(job.id);
    c.state = done.state;
    if (done.receipt) { c.receipt = done.receipt; f.record.receipts.freecad = done.receipt; }
    const log = this.keepLog(f, done, 'freecad.log');
    if (log) c.log = log.rel;
    if (this.stopped(f) || done.state === 'cancelled') {
      const when = done.state === 'cancelled' ? `during the FreeCAD run (job ${job.id})` : `as the FreeCAD run ended (job ${job.id} ${done.state}; its own receipt judges it)`;
      return this.end(f, 'cancelled', 'freecad', `stopped with /stop ${when}; whatever it wrote is kept, and nothing was read back${c.log ? `; its output: ${c.log}` : ''}`);
    }
    // The run judged as /freecad judges it: by its own result file, never by freecadcmd's exit alone.
    const j = judgeFreecadJob(done, spec);
    const report = j.freecad;
    c.outcome = j.outcome;
    c.why = this.d.scrub(j.why, f.root);
    if (report.version) c.version = report.version;
    if (n.result) { const resultSha = sha256File(n.result); c.result = { path: relTo(n.root, n.result), ...(resultSha ? { sha256: resultSha } : {}) }; }
    const files = j.files.filter((x) => !x.outside).map((x) => ({ path: x.path, written: x.written === true, ...(x.sha256 ? { sha256: x.sha256 } : {}), ...(x.change ? { change: x.change } : {}) }));
    c.files = files;
    c.fcstd = files.filter((x) => /\.fcstd$/i.test(x.path) && x.written && x.sha256).map((x) => ({ path: x.path, sha256: x.sha256! }));
    if (report.checks) c.checks = report.checks.map((x) => ({ ...x }));
    if (report.error) c.error = this.d.scrub(report.error, f.root);
    const measure = stepMeasure(report);
    if (measure) {
      const file = files.find((x) => x.path === measure.step);
      if (file?.sha256) c.step = { path: measure.step, sha256: file.sha256 };
      c.reported = { valid: measure.valid, ...(measure.solids !== undefined ? { solids: measure.solids } : {}), volume_mm3: measure.volume_mm3, bounds: { min: [...measure.min], max: [...measure.max], size: [...measure.size] }, objects: [...measure.objects] };
    }
    if (j.outcome !== 'ok') {
      // Its raw failure stays where it was written: the result file (its error), the verdicts, its output, what it wrote.
      c.failure_files = kept(f.root, [
        ...(c.result ? [c.result.path] : []), ...(n.record ? [`${relTo(n.root, n.record)}/verdicts.jsonl`] : []), ...(c.log ? [c.log] : []),
        ...files.filter((x) => x.sha256).map((x) => x.path),
      ]);
      return this.end(f, 'failed', 'freecad', `FreeCAD's run is judged ${j.outcome}, not ok: ${c.why}; nothing was read back${c.failure_files.length ? `; kept: ${c.failure_files.join(', ')}` : ''}`);
    }
    if (measure && f.record.before_after) f.record.before_after.after = { ...measure, run: n.run, job: job.id };
    if (f.record.before_after?.before && measure && f.record.before_after.before.step !== measure.step) {
      // An earlier run that exported several STEP files is compared by the STEP this run exported.
      const again = previousFreecadRun(f.root, rel, f.record.started_at, measure.step);
      if (!('none' in again)) f.record.before_after.before = { ...again.measure, run: again.run, ...(again.job ? { job: again.job } : {}), started_at: again.started_at };
    }
    this.saveState(f);
  }

  private async readbackStep(f: FreecadRun): Promise<void> {
    f.step = 'readback';
    const spec = f.spec!;
    const run8 = spec.native.run.slice(0, 8);
    const rb: NonNullable<FreecadFlowRecord['readback']> = { state: 'not started', scope: FREECAD_READBACK_SCOPE };
    f.record.readback = rb;
    const ready = this.readbackReady();
    if (!ready.ready || !this.d.freecadReadback) {
      rb.state = 'not run';
      rb.setup = ready.why ?? 'the readback cannot run here';
      return this.end(f, 'succeeded', 'readback', `succeeded without readback: FreeCAD's run is judged ok, but no readback could run (${rb.setup}); its STEP is not compared with FreeCAD's report: /freecad readback ${run8} does it once the setup is done`);
    }
    if (this.stopped(f)) { rb.state = 'cancelled'; return this.end(f, 'cancelled', 'readback', 'stopped with /stop before the readback started; FreeCAD\'s run had finished'); }
    // Which file, and its bytes now: as /freecad readback plans it (a run judged ok, a STEP its result names, unchanged since).
    const p = planFreecadReadback(f.root, { run: spec.native.run });
    if (!p.ok) {
      rb.verdict = 'failed';
      rb.reason = this.d.scrub(p.error, f.root);
      return this.end(f, 'failed', 'readback', `the readback did not start: ${rb.reason}`);
    }
    const plan: FreecadReadbackPlan = p.plan;
    rb.step = { path: plan.step.path, sha256: plan.step.sha256 };
    const started = this.d.freecadReadback.run(plan, { root: f.root, project: f.project }, { label: `readback ${plan.step.path} · FreeCAD run ${run8} · flow ${f.id}` });
    if (!started.ok) {
      rb.verdict = 'failed';
      rb.reason = this.d.scrub(started.error.replace(/^Not started: /, ''), f.root);
      return this.end(f, 'failed', 'readback', `the readback did not start: ${rb.reason}`);
    }
    f.readbackJob = started.job.id;
    rb.job = started.job.id;
    rb.state = 'running';
    this.note(f, `readback: ${started.job.id} reads ${plan.step.path} back in its own process (OCP's STEP reader), as /freecad readback does${this.sep}/jobs ${started.job.id}`);
    this.saveState(f);
    if (this.stopped(f)) await this.d.jobs.stop(started.job.id);
    const line = await started.done;
    if (!line) {
      rb.state = 'unknown';
      rb.verdict = 'failed';
      rb.reason = 'the readback ran, but its record could not be made';
      return this.end(f, 'failed', 'readback', `the readback failed: ${rb.reason}`);
    }
    rb.state = line.state;
    if (line.worker) rb.worker = line.worker;
    rb.reported = line.reported;
    if (line.measured) rb.measured = line.measured;
    rb.tolerance = { ...line.tolerance };
    if (line.checks) rb.checks = line.checks;
    if (line.verdict) rb.verdict = line.verdict;
    if (line.reason) rb.reason = line.reason;
    if (line.log) rb.log = line.log;
    if (line.receipt) { rb.receipt = line.receipt; f.record.receipts.readback = line.receipt; }
    if (readReadbacks(plan.dir).some((x) => x.job === line.job)) rb.record = `${relTo(f.root, plan.dir)}/readbacks.jsonl`;
    const keptOut = rb.log ? `; its output is kept: ${rb.log}` : '';
    if (this.stopped(f) || line.state === 'cancelled') {
      return this.end(f, 'cancelled', 'readback', `stopped with /stop during the readback; FreeCAD's run had finished; no verdict${rb.log ? `; its output so far: ${rb.log}` : ''}`);
    }
    if (line.verdict === 'matches') return this.end(f, 'succeeded', 'readback', `the readback of ${plan.step.path} matches FreeCAD's report within ${toleranceText(READBACK_TOLERANCE)} (both are OpenCascade: not an independent kernel's confirmation)`);
    if (line.verdict === 'differs') return this.end(f, 'differs', 'readback', `the readback of ${plan.step.path} differs from FreeCAD's report: ${rb.reason ?? 'see its checks'}`);
    return this.end(f, 'failed', 'readback', `the readback failed: ${rb.reason ?? `its job ${line.state}`}${keptOut}`);
  }

  // ── the record ─────────────────────────────────────────────────────────────────

  protected flowSources(r: FreecadFlowRecord): unknown[] {
    return [{ path: r.script.path, sha256: r.script.before.sha256, ...(r.script.after ? { sha256_after: r.script.after.sha256 } : {}), role: 'the script the agent was asked to change' }];
  }

  protected childReceipts(r: FreecadFlowRecord): string[] {
    return [r.receipts.agent, r.receipts.freecad, r.receipts.readback].filter((x): x is string => typeof x === 'string');
  }

  protected measuredLines(r: FreecadFlowRecord): Line[] {
    const g = this.d.glyphs;
    const c = r.freecad;
    const k = r.readback;
    const lines: Line[] = [];
    if (c?.reported && c.step) lines.push([{ text: '      FreeCAD reported   ', role: 'secondary' }, { text: `${c.step.path}: ${shapeWords(c.reported)}`, role: 'strong' }, { text: `${this.sep}${FREECAD_REPORTED_BY}`, role: 'secondary' }]);
    const m = k?.measured as { valid?: boolean; solids?: number; volume_mm3?: number; bounds?: { min: number[]; max: number[]; size: number[] }; measured_by?: string } | undefined;
    if (m) lines.push([{ text: '      readback measured  ', role: 'secondary' }, { text: shapeWords({ valid: m.valid ?? null, ...(m.solids !== undefined ? { solids: m.solids } : {}), ...(m.volume_mm3 !== undefined ? { volume_mm3: m.volume_mm3 } : {}), ...(m.bounds ? { bounds: m.bounds } : {}) }), role: 'strong' }, { text: `${this.sep}${m.measured_by ?? 'the readback worker'}`, role: 'secondary' }]);
    if (k?.verdict === 'matches' || k?.verdict === 'differs') lines.push([{ text: `      within ${toleranceText(k.tolerance ?? READBACK_TOLERANCE)}: ${k.verdict}${this.sep}both are OpenCascade: a match shows the file holds the geometry FreeCAD reported, not an independent kernel's confirmation`, role: 'secondary' }]);
    const ba = r.before_after;
    if (ba?.after) {
      const b = ba.before;
      lines.push([{ text: `      before ${g.arrow} after: `, role: 'secondary' }, {
        text: `${b ? `${measureWords(b)} (run ${b.run.slice(0, 8)})` : ba.before_note ?? 'no earlier run'} ${g.arrow} ${measureWords(ba.after)} (run ${ba.after.run.slice(0, 8)})`, role: 'strong',
      }, { text: `${this.sep}${ba.measured_by}`, role: 'secondary' }]);
    }
    if (lines.length) lines.push([{ text: `      ${DOCTRINE_15}`, role: 'strong' }]);
    return lines;
  }
}
