/**
 * /iterate scad in the REPL (round R4, helper H33): the OpenSCAD variant of the connected workflow, one flow with its own
 * id (f + 8 hex), run beside the other flows (src/repl/iterate.ts parses the line and hands it here):
 *
 *   1. before anything starts: the model is a .scad in the project, reached through no link; its parameter file
 *      (<model>.params.json, timmy.scad-params/1) is beside it, checks, and names at least one parameter (Timmy cannot
 *      read a model's defaults out of its .scad reliably, so a missing file is refused with how to make one); OpenSCAD
 *      and its runner are there; the agent's route is local and free. The file's bytes are read and kept in the flow's
 *      folder (params.before.json);
 *   2. a local code agent runs through /agent's own start, told the file's content and its parameter names, and that it
 *      may change values only: no new names, no other file, no commands;
 *   3. after it: any other file changed (the model included), the file deleted or changed after the agent ended, a file
 *      that no longer checks, a name added or removed, or no change stops the flow before OpenSCAD runs. Nothing is
 *      reverted;
 *   4. `/scad <model> --png` as the judged native job, through /scad's own start (src/native/openscad.ts scadJob, the
 *      job started and adopted as /scad's: its end notice and its native receipt are /scad's); the flow waits for it;
 *   5. the verdict, from that run's own judgement and readback: Timmy's reading of the STL closed and consistently
 *      oriented, and OpenSCAD's own summary bounding box agreeing with it (src/flows/iterate-scad.ts compareScadRun);
 *   6. the flow record (results/flows/<flow-id>.json) and a `flow` receipt binding its sha256 and the child receipts (the
 *      agent's and the OpenSCAD run's). Every raw failure stays where it was written, and the record names it.
 *
 * Before and after: the parameter diff, and, when an earlier /scad run of the same model was judged ok before the flow
 * started, its measured bounding box and volume beside this run's, each labelled with its run (Timmy's reading of each
 * STL). DOCTRINE §15's sentence goes with every dimension shown.
 */
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { locateNative, NATIVE_APPS, NativeNotFound } from '../native/index.js';
import { judgeScadJob, SCAD_RUNNER, scadJob, scadRunnerPath, type ScadJobSpec, type ScadJudgement } from '../native/openscad.js';
import { paramsFileFor, parseScadParams, readScadParams } from '../native/scad-params.js';
import { STL_READBACK } from '../native/stl-readback.js';
import { resolveInside } from '../project/index.js';
import { FLOW_SCHEMA, flowRecordPath, flowWorkDir, newFlowId } from '../flows/iterate.js';
import { DOCTRINE_15, judgeFileChanges, numText, sizeText, unseenFolder } from '../flows/iterate-native.js';
import {
  compareScadRun, measureOf, previousScadRun, SCAD_COMPARE_SCOPE, SCAD_MEASURED_BY, SCAD_MODEL_TEXT_MAX, scadDiffText, scadIterateTask, scadNameChanges, scadParamDiff,
  scadVolumeText, type ScadFlowRecord, type ScadMeasure,
} from '../flows/iterate-scad.js';
import { keepBytes, NativeFlows, relTo, sha, short, type Line, type NativeIterateRequest, type NativeRun, type Started } from './iterate-native.js';
import { lessonsStartLine, pickLessons } from '../memory/retrieve.js'; // R4 (H50): Timmy Memory's lessons for the agent's task
// R4 (H51): each flow record names the operation (one request) that started it.
import { operationField } from '../ops/context.js';

export const SCAD_ITERATE_USAGE = '/iterate scad <model.scad> "<instruction>" [--agent qwen|codex] [--model <local model>]';

interface ScadRun extends NativeRun<ScadFlowRecord> {
  spec?: ScadJobSpec;
  judged?: ScadJudgement;
}

/** The kept-file names a failed OpenSCAD run leaves, that exist. */
const kept = (root: string, names: string[]): string[] => [...new Set(names)].filter((n) => { try { lstatSync(path.join(root, n)); return true; } catch { return false; } });

export class ScadFlows extends NativeFlows<ScadFlowRecord> {
  readonly target = 'scad' as const;
  readonly app = 'OpenSCAD';
  readonly appStep = 'openscad';
  readonly usage = SCAD_ITERATE_USAGE;

  protected what(r: ScadFlowRecord): string { return `scad ${r.model.path}`; }

  /** /iterate's usage lines for the OpenSCAD flow, with whether OpenSCAD is found (found is not run). */
  usageLines(): Line[] {
    const { found, problem } = locateNative('openscad', this.d.env());
    return [
      [{ text: '  OpenSCAD   ', role: 'secondary' }, { text: SCAD_ITERATE_USAGE, role: 'strong' }],
      ...this.say('           the agent may change only <model>.params.json (values only); /scad --png runs as a judged job; Timmy\'s STL reading is compared with OpenSCAD\'s own summary'),
      found
        ? [{ text: '             ', role: 'secondary' }, { text: `OpenSCAD found (${found.how === 'env' ? 'set by TIMMY_OPENSCAD' : 'on PATH'})`, role: 'strong' }, { text: `${this.sep}it runs when a flow does, not now`, role: 'secondary' }]
        : [{ text: '             ', role: 'secondary' }, { text: `OpenSCAD not found${problem ? ` (${problem})` : ''}`, role: 'estimate' }, { text: `${this.sep}${NATIVE_APPS.openscad.setup}`, role: 'secondary' }],
    ];
  }

  async start(req: NativeIterateRequest, at: { root: string; project: string }): Promise<Started<ScadFlowRecord>> {
    const { root, project } = at;
    const scrub = (t: string): string => this.d.scrub(t, root);
    const env: NodeJS.ProcessEnv = { ...this.d.env(), ...(req.model ? { TIMMY_AGENT_MODEL: req.model } : {}) };
    // The model first: a .scad in the project, reached through no link.
    const found = resolveInside(root, req.file);
    if ('error' in found) return this.refuse(`${scrub(found.error)}. Nothing was started.`);
    const modelRel = found.rel;
    if (!/\.scad$/i.test(modelRel)) return this.refuse(`${modelRel} is not an OpenSCAD model (.scad): /iterate scad changes a model's parameter file. Nothing was started.`);
    const paramsRel = paramsFileFor(modelRel);
    const hidden = unseenFolder(paramsRel);
    if (hidden) return this.refuse(`${paramsRel} is inside ${hidden}/, which the agent's before/after comparison does not look into, so a change to it could not be seen: keep the model elsewhere in the project. Nothing was started.`);
    let realRoot: string;
    try { realRoot = realpathSync(root); } catch { return this.refuse('The project folder is gone. Nothing was started.'); }
    let st;
    try { st = lstatSync(found.path); } catch { return this.refuse(`No model at ${modelRel}: /project new <name> --from scad-starter makes a project with one (box.scad and box.params.json). Nothing was started.`); }
    if (found.path !== path.join(realRoot, ...modelRel.split('/')) || st.isSymbolicLink()) return this.refuse(`${modelRel} is reached through a symbolic link: name the file itself. Nothing was started.`);
    if (!st.isFile()) return this.refuse(`${modelRel} is not a regular file. Nothing was started.`);
    // Its parameter file: there, checked, with at least one name. Timmy cannot read a model's defaults out of its .scad
    // reliably, so a missing file is refused with how to make one; nothing is written for it.
    const file = readScadParams(root, modelRel);
    if (!file.ok) return this.refuse(`${file.path} is not a usable parameter file: ${scrub(file.error)}; fix it, or move it aside. Nothing was started.`);
    if (!file.exists) {
      const example = `{ "schema": "timmy.scad-params/1", "model": "${path.posix.basename(modelRel)}", "parameters": { "width": 60 } }`;
      return this.refuse(`No ${paramsRel} beside ${modelRel}: /iterate scad lets the agent change only that file, and Timmy cannot read a model's defaults out of its .scad reliably. Make it first with the names the model assigns at its top and their values (${example}); /scad ${modelRel} then runs with it. Nothing was started.`, 'estimate');
    }
    const names = Object.keys(file.parameters);
    if (!names.length) return this.refuse(`${paramsRel} names no parameter: the agent may change values only, so it could change nothing. Add the names the model assigns at its top. Nothing was started.`, 'estimate');
    // The route: local and free, or refused with the reason.
    const route = this.route(req, env, root);
    if (!route.ok) return this.refuse(route.error, route.role);
    // One flow at a time in a project: an agent's before/after comparison covers the whole project.
    const busy = this.busy(root);
    if (busy) return this.refuse(`Flow ${busy.id} is still running in this project (its ${busy.step} step), and one flow at a time runs in a project (an agent's before/after comparison covers all of it): wait for it, or /stop ${busy.id}. Nothing was started.`, 'estimate');
    // OpenSCAD before the agent works: it runs after the agent, so it comes first.
    const located = locateNative('openscad', env);
    if (!located.found) {
      return this.refuse(`Not started: ${NATIVE_APPS.openscad.name} was not found on this machine${located.problem ? ` (${located.problem})` : ''}. /iterate scad runs OpenSCAD after the agent, so OpenSCAD comes first.`, 'estimate', this.say(`Setup: ${NATIVE_APPS.openscad.setup}, then /iterate again.`));
    }
    if (!scadRunnerPath()) return this.refuse(`Not started: the OpenSCAD runner (${SCAD_RUNNER}) is missing from this Timmy.`);
    if (!this.d.startNative) return this.refuse('Not started: this REPL cannot start a native job.');
    const id = newFlowId();
    // Awaited only for Codex's local route, so a Qwen Code start reaches its agent's start (which holds the project)
    // without yielding: no second flow can pass the check above meanwhile.
    const pre = route.plan.oss ? await this.preflight(route.plan, root, id) : undefined;
    if (pre) return this.refuse(pre, 'estimate');
    // The bytes now: the task quotes them, and their sha256 is the "before" every later check compares with.
    let paramsBytes: Buffer;
    let modelBytes: Buffer;
    try { paramsBytes = readFileSync(path.join(realRoot, ...paramsRel.split('/'))); modelBytes = readFileSync(found.path); } catch (e) {
      return this.refuse(`${modelRel} or ${paramsRel} could not be read: ${scrub(e instanceof Error ? e.message : String(e))}. Nothing was started.`);
    }
    if (sha(paramsBytes) !== file.sha256) return this.refuse(`${paramsRel} changed while it was read. Nothing was started.`);
    const recheck = parseScadParams(paramsBytes.toString('utf8'), path.posix.basename(modelRel));
    if (!recheck.ok) return this.refuse(`${paramsRel} is not a usable parameter file: ${recheck.error}. Nothing was started.`);
    const startedAt = new Date().toISOString();
    // R4 (H50): the checked lessons that apply (each checked again now), given to the agent as one section.
    const lessons = pickLessons(this.d, { root, project, kind: 'scad', instruction: req.instruction, files: [modelRel, paramsRel] });
    const task = scadIterateTask({
      instruction: req.instruction, paramsRel, modelRel, names, paramsText: paramsBytes.toString('utf8'),
      ...(modelBytes.length <= SCAD_MODEL_TEXT_MAX ? { modelText: modelBytes.toString('utf8') } : { modelBytes: modelBytes.length }),
      ...(lessons?.section ? { lessons: lessons.section } : {}),
    });
    const s = await this.startAgent(id, req, task, { root, project, env, local: route.local });
    if (!s.ok) return this.refuse(`The agent did not start: ${scrub(s.error)}`, s.refused === 'paid' || s.refused === 'missing' ? 'estimate' : 'failure');
    const keptAt = keepBytes(root, `${flowWorkDir(id)}/params.before.json`, paramsBytes);
    // Before: an earlier /scad run of this model judged ok, before this flow started (its own measurement, as kept).
    const prev = previousScadRun(root, modelRel, startedAt);
    const record: ScadFlowRecord = {
      flow: 1, schema: FLOW_SCHEMA, id, kind: 'iterate', target: 'scad', instruction: req.instruction, project, started_at: startedAt, outcome: 'running',
      ...operationField('flow', id), // R4 (H51): the request that started it
      model: { path: modelRel, sha256: sha(modelBytes), bytes: modelBytes.length },
      parameters: { path: paramsRel, before: { sha256: sha(paramsBytes), bytes: paramsBytes.length, values: recheck.parameters, ...(keptAt ? { kept: keptAt } : {}) } },
      agent: this.agentPart(s),
      before_after: 'none' in prev
        ? { measured_by: SCAD_MEASURED_BY, before: null, before_note: prev.none }
        : { measured_by: SCAD_MEASURED_BY, before: { ...prev.measure, run: prev.run, ...(prev.job ? { job: prev.job } : {}), started_at: prev.started_at } },
      receipts: {}, child_receipts: [], doctrine: DOCTRINE_15, ...(lessons ? { lessons: lessons.record } : {}),
    };
    const flow: ScadRun = { id, root, project, record, abort: new AbortController(), step: 'agent', agentJob: s.job.id, agentRecord: s.record };
    this.launch(flow, (f) => this.steps(f as ScadRun));
    const g = this.d.glyphs;
    const values = names.map((n) => `${n} ${typeof file.parameters[n] === 'string' ? JSON.stringify(file.parameters[n]) : String(file.parameters[n])}`).join(', ');
    const before = record.before_after!.before;
    return {
      ok: true, flow, lines: [
        [{ text: '  Flow       ', role: 'secondary' }, { text: id, role: 'strong' }, { text: `  iterate scad ${modelRel}: ${scrub(req.instruction)}`, role: 'secondary' }],
        [{ text: '  Parameters ', role: 'secondary' }, { text: paramsRel, role: 'strong' }, { text: `  ${values}${this.sep}sha256 ${short(record.parameters.before.sha256)}${keptAt ? `${this.sep}kept as read: ${keptAt}` : ''}`, role: 'secondary' }],
        [{ text: '  Agent      ', role: 'secondary' }, { text: s.job.id, role: 'strong' }, { text: `  agent ${s.plan.agent} ${s.run}${this.sep}${s.info.title}${s.version ? ` ${s.version}` : ''}${s.plan.model ? `${this.sep}model ${s.plan.model} at ${s.plan.where}` : ''}${this.sep}${s.plan.charge}`, role: 'secondary' }],
        ...(lessons ? [lessonsStartLine(lessons)] : []), // R4 (H50)
        [{ text: '  Next       ', role: 'secondary' }, { text: `it may change only the values in ${paramsRel}; then OpenSCAD (found, ${located.found.how === 'env' ? 'set by TIMMY_OPENSCAD' : 'on PATH'}) runs /scad ${modelRel} --png as a judged job, and Timmy's reading of its STL is compared with OpenSCAD's own summary`, role: 'secondary' }],
        [{ text: '  Before     ', role: 'secondary' }, { text: before ? `run ${before.run.slice(0, 8)} (judged ok): ${sizeText(before.size)}, volume ${numText(before.volume)}, as Timmy measured its STL` : `${record.before_after!.before_note}: the flow's run is measured alone`, role: 'secondary' }],
        [{ text: '  Follow     ', role: 'secondary' }, { text: `/jobs ${s.job.id}${this.sep}/stop ${id} stops the flow${this.sep}/iterate lists flows${this.sep}the record: ${flowRecordPath(id)} ${g.arrow} /board`, role: 'secondary' }],
      ],
    };
  }

  // ── the steps ────────────────────────────────────────────────────────────────

  private async steps(f: ScadRun): Promise<void> {
    await this.agentStep(f);
    if (f.record.outcome === 'running') this.checksStep(f);
    if (f.record.outcome === 'running') await this.openscadStep(f);
    if (f.record.outcome === 'running') this.compareStep(f);
  }

  private checksStep(f: ScadRun): void {
    f.step = 'checks';
    const rel = f.record.parameters.path;
    const before = f.record.parameters.before;
    const a = f.record.agent!;
    const keptOut = a.transcript ? `; the agent's output is kept: ${a.transcript}` : '';
    const judged = judgeFileChanges(f.agentRecord?.files, rel);
    if (!judged.ok) {
      if (judged.others.length) a.others = judged.others;
      return this.end(f, 'stopped', 'checks', `${judged.why}; OpenSCAD did not run, and nothing was reverted${keptOut}`);
    }
    // The agent's snapshot before it ran must have seen the bytes Timmy read (and gave it in its task).
    const seenBefore = judged.change?.previous_sha256;
    if (judged.params === 'changed' && seenBefore && seenBefore !== before.sha256) {
      return this.end(f, 'stopped', 'checks', `${rel} changed between Timmy's read and the agent's start (sha256 ${short(before.sha256)} read, ${short(seenBefore)} when the agent started); OpenSCAD did not run`);
    }
    // The file as it is now, read here (not the agent's word): it must be what the agent's own snapshot saw.
    let bytes: Buffer;
    try { bytes = readFileSync(path.join(f.root, rel)); } catch { return this.end(f, 'stopped', 'checks', `${rel} cannot be read after the agent's run; OpenSCAD did not run`); }
    const now = sha(bytes);
    const seen = judged.params === 'changed' ? judged.change?.sha256 ?? null : before.sha256;
    if (seen !== now) return this.end(f, 'stopped', 'checks', `${rel} changed after the agent's run ended (sha256 ${short(now)} now; the agent left ${seen ? short(seen) : 'an unhashed file'}); OpenSCAD did not run`);
    if (judged.params === 'unchanged') return this.end(f, 'stopped', 'checks', 'the agent changed nothing; OpenSCAD did not run');
    const parsed = parseScadParams(bytes.toString('utf8'), path.posix.basename(f.record.model.path));
    if (!parsed.ok) {
      f.record.parameters.invalid = { sha256: now, error: parsed.error };
      return this.end(f, 'stopped', 'checks', `${rel} as the agent left it does not check: ${parsed.error}; it is left as the agent wrote it; OpenSCAD did not run${keptOut}`);
    }
    const diff = scadParamDiff(before.values, parsed.parameters);
    f.record.parameters.after = { sha256: now, bytes: bytes.length, values: parsed.parameters };
    f.record.parameters.diff = diff;
    const names = scadNameChanges(before.values, parsed.parameters);
    if (names.added.length || names.removed.length) {
      f.record.parameters.names = names;
      const what = [...(names.added.length ? [`added ${names.added.join(', ')}`] : []), ...(names.removed.length ? [`removed ${names.removed.join(', ')}`] : [])].join(' and ');
      return this.end(f, 'stopped', 'checks', `the agent ${what} in ${rel}, and may change values only; it is left as the agent wrote it; OpenSCAD did not run${keptOut}`);
    }
    if (!diff.some((x) => x.changed)) return this.end(f, 'stopped', 'checks', `the agent rewrote ${rel} but changed no value; OpenSCAD did not run`);
    this.note(f, `agent ${a.agent} ${a.run} completed: changed ${rel}${this.sep}${scadDiffText(diff, this.d.glyphs.arrow)}`);
    this.saveState(f);
  }

  private async openscadStep(f: ScadRun): Promise<void> {
    f.step = 'openscad';
    if (this.stopped(f)) return this.end(f, 'cancelled', 'openscad', 'stopped with /stop before OpenSCAD ran');
    const modelRel = f.record.model.path;
    const paramsRel = f.record.parameters.path;
    const after = f.record.parameters.after!;
    let spec: ScadJobSpec;
    try {
      // /scad's own job: the parameter file read at submission, the read-only copy of the model, the runner, --png.
      spec = scadJob({ model: modelRel, png: true, root: f.root, project: f.project, findEnv: this.d.env(), label: `OpenSCAD · ${modelRel} · flow ${f.id}` });
    } catch (e) {
      const why = this.d.scrub(e instanceof NativeNotFound ? `${e.message}; ${e.setup}` : e instanceof Error ? e.message : String(e), f.root);
      f.record.openscad = { state: 'not started', error: why };
      return this.end(f, 'failed', 'openscad', `OpenSCAD did not start: ${why}`);
    }
    f.spec = spec;
    const s = spec.scad;
    const n = spec.native;
    const o: NonNullable<ScadFlowRecord['openscad']> = {
      run: n.run, ...(n.record ? { record: relTo(n.root, n.record) } : {}), state: 'submitted', copy: { path: s.copy.rel, sha256: s.copy.sha256 }, defines: [...s.defines],
      ...(s.paramsFile ? { params_file: { ...s.paramsFile } } : {}), ...(n.record ? { readback_file: `${relTo(n.root, n.record)}/readback.json` } : {}), summary_file: s.summary.rel,
    };
    f.record.openscad = o;
    if (n.input?.sha256 !== f.record.model.sha256) {
      o.state = 'not started';
      return this.end(f, 'stopped', 'openscad', `${modelRel} changed after the flow started (sha256 ${short(n.input?.sha256)} when submitted, ${short(f.record.model.sha256)} at the start); OpenSCAD did not run`);
    }
    if (s.paramsFile?.sha256 !== after.sha256) {
      o.state = 'not started';
      return this.end(f, 'stopped', 'openscad', `${paramsRel} changed after it was checked (sha256 ${short(s.paramsFile?.sha256)} when submitted, ${short(after.sha256)} checked); OpenSCAD did not run`);
    }
    let job;
    try { job = this.d.startNative!(spec); } catch (e) {
      o.state = 'not started';
      o.error = this.d.scrub(e instanceof Error ? e.message : String(e), f.root);
      return this.end(f, 'failed', 'openscad', `OpenSCAD did not start: ${o.error}`);
    }
    f.nativeJob = job.id;
    o.job = job.id;
    o.state = 'running';
    this.note(f, `OpenSCAD: ${job.id} exports ${modelRel} with ${s.defines.length ? s.defines.map((d) => `-D ${d}`).join(' ') : 'no -D'} from its copy ${s.copy.rel}${this.sep}judged by its exit, the STL it writes and Timmy's own reading${this.sep}/jobs ${job.id}`);
    this.saveState(f);
    // A stop that came while the job was being started.
    if (this.stopped(f)) await this.d.jobs.stop(job.id);
    const done = await this.d.jobs.done(job.id);
    o.state = done.state;
    if (done.receipt) { o.receipt = done.receipt; f.record.receipts.openscad = done.receipt; }
    const log = this.keepLog(f, done, 'openscad.log');
    if (log) o.log = log.rel;
    if (this.stopped(f) || done.state === 'cancelled') {
      const when = done.state === 'cancelled' ? `during the OpenSCAD run (job ${job.id})` : `as the OpenSCAD run ended (job ${job.id} ${done.state}; its own receipt judges it)`;
      return this.end(f, 'cancelled', 'openscad', `stopped with /stop ${when}; whatever it wrote is kept, and nothing was compared${o.log ? `; its output: ${o.log}` : ''}`);
    }
    // The run judged as /scad judges it: its exit, the STL created by this run, OpenSCAD's ERROR lines, Timmy's reading.
    const j = judgeScadJob(done, spec);
    f.judged = j;
    const r = j.scad;
    o.outcome = j.outcome;
    o.why = this.d.scrub(j.why, f.root);
    if (r.version) o.version = r.version;
    o.stl = { path: r.stl.path, made: r.stl.made, change: r.stl.change, ...(r.stl.sha256 ? { sha256: r.stl.sha256 } : {}), ...(r.stl.bytes !== undefined ? { bytes: r.stl.bytes } : {}) };
    if (r.png) o.png = { path: r.png.path, made: r.png.made, change: r.png.change, ...(r.png.sha256 ? { sha256: r.png.sha256 } : {}), ...(r.png.why ? { why: this.d.scrub(r.png.why, f.root) } : {}) };
    o.messages = { errors: r.messages.errors, warnings: r.messages.warnings, lines: r.messages.lines.slice(0, 12).map((l) => this.d.scrub(l.text, f.root)) };
    if (j.outcome !== 'ok') {
      // Its raw failure stays where it was written: the runner's record and each step's output, the verdicts, the job's output.
      const exp = [...r.steps].reverse().find((x) => x.name === 'export');
      o.failure_files = kept(f.root, [
        s.runner.record.rel, ...(exp?.stderr ? [exp.stderr.file] : []), ...(n.record ? [`${relTo(n.root, n.record)}/verdicts.jsonl`] : []),
        ...(o.log ? [o.log] : []), ...(r.stl.present ? [r.stl.path] : []),
      ]);
      return this.end(f, 'failed', 'openscad', `OpenSCAD's run is judged ${j.outcome}, not ok: ${o.why}; nothing was compared${o.failure_files.length ? `; kept: ${o.failure_files.join(', ')}` : ''}`);
    }
    this.saveState(f);
  }

  /** The verdict from the run's own judgement and readback (no other job runs: Timmy's reading was made when it was judged). */
  private compareStep(f: ScadRun): void {
    f.step = 'readback';
    const j = f.judged!;
    const spec = f.spec!;
    const r = j.scad;
    const cmp = compareScadRun(r);
    const m = r.readback ? measureOf(r.readback) : undefined;
    const sm = r.summary;
    f.record.readback = {
      verdict: cmp.verdict, checks: cmp.checks, scope: SCAD_COMPARE_SCOPE,
      ...(m ? { measured: { ...m, measured_by: `${STL_READBACK} (Timmy's own reading of the STL, independent of OpenSCAD's engine)` } } : {}),
      summary: {
        state: sm.state, ...(sm.path ? { path: sm.path } : {}), ...(sm.sha256 ? { sha256: sm.sha256 } : {}), ...(sm.bbox ? { min: [...sm.bbox.min], max: [...sm.bbox.max] } : {}),
        ...(sm.agrees !== undefined ? { agrees: sm.agrees } : {}), ...(sm.differs_by !== undefined ? { differs_by: sm.differs_by } : {}), ...(sm.line ? { line: this.d.scrub(sm.line, f.root) } : {}),
      },
      ...(cmp.reason ? { reason: this.d.scrub(cmp.reason, f.root) } : {}),
    };
    if (m && f.record.before_after) f.record.before_after.after = { ...m, run: spec.native.run, ...(f.nativeJob ? { job: f.nativeJob } : {}) };
    this.saveState(f);
    const stl = r.stl.path;
    const shape = m ? `${sizeText(m.size)}, volume ${numText(m.volume)}` : '';
    if (cmp.verdict === 'matches') return this.end(f, 'succeeded', 'readback', `Timmy's reading of ${stl} (${shape}, closed and consistently oriented) matches OpenSCAD's own summary of the same export`);
    if (cmp.verdict === 'no summary') return this.end(f, 'succeeded', 'readback', `succeeded, no OpenSCAD summary to compare: ${f.record.readback.reason}; only Timmy's reading of ${stl} is there (${shape}, closed and consistently oriented)`);
    if (cmp.verdict === 'differs') return this.end(f, 'differs', 'readback', `the readback of ${stl} differs: ${f.record.readback.reason}`);
    return this.end(f, 'failed', 'readback', `OpenSCAD's run is judged ok, but the comparison failed: ${f.record.readback.reason}; the run's record: ${f.record.openscad?.record ?? 'its folder'}`);
  }

  // ── the record ─────────────────────────────────────────────────────────────────

  protected flowSources(r: ScadFlowRecord): unknown[] {
    return [
      { path: r.parameters.path, sha256: r.parameters.before.sha256, ...(r.parameters.after ? { sha256_after: r.parameters.after.sha256 } : {}), role: 'the parameter file the agent was asked to change' },
      { path: r.model.path, sha256: r.model.sha256, role: 'the model, unchanged by the flow' },
    ];
  }

  protected childReceipts(r: ScadFlowRecord): string[] {
    return [r.receipts.agent, r.receipts.openscad].filter((x): x is string => typeof x === 'string');
  }

  protected measuredLines(r: ScadFlowRecord): Line[] {
    const k = r.readback;
    const m = k?.measured;
    if (!k || !m) return [];
    const g = this.d.glyphs;
    const lines: Line[] = [[{ text: `      measured by Timmy from ${m.stl}: `, role: 'secondary' }, { text: `${sizeText(m.size)}, volume ${scadVolumeText(m)}`, role: 'strong' },
      { text: `${this.sep}${STL_READBACK}${this.sep}OpenSCAD's own summary: ${k.summary?.state === 'written' ? (k.summary.agrees === true ? 'agrees' : k.summary.agrees === false ? 'differs' : 'no bounding box') : k.summary?.state ?? 'unknown'}${this.sep}${k.verdict ?? 'no verdict'}`, role: 'secondary' }]];
    const ba = r.before_after;
    if (ba?.after) {
      const b = ba.before;
      lines.push([{ text: `      before ${g.arrow} after: `, role: 'secondary' }, {
        text: b ? `${sizeText(b.size)}, ${numText(b.volume)} (run ${b.run.slice(0, 8)}) ${g.arrow} ${sizeText(ba.after.size)}, ${numText(ba.after.volume)} (run ${ba.after.run.slice(0, 8)})` : `${ba.before_note ?? 'no earlier run'} ${g.arrow} ${sizeText(ba.after.size)}, ${numText(ba.after.volume)} (run ${ba.after.run.slice(0, 8)})`,
        role: 'strong',
      }, { text: `${this.sep}${ba.measured_by}`, role: 'secondary' }]);
    }
    lines.push([{ text: `      ${DOCTRINE_15}`, role: 'strong' }]);
    return lines;
  }
}

/** A run's measurement in a few words (for the notices). */
export const scadMeasureText = (m: ScadMeasure): string => `${sizeText(m.size)}, volume ${scadVolumeText(m)}`;
